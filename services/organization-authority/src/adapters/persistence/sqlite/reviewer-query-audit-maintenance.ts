import type Database from 'better-sqlite3';
import { canonicalSha256, parseCanonicalJson } from '@echo-brain/federation-protocol';
import type { JsonObject } from '@echo-brain/federation-protocol';
import { timestampMillis } from '../../../domain/rules.js';
import {
  REVIEWER_QUERY_AUDIT_EXPIRED_ACTION,
  REVIEWER_QUERY_AUDIT_EXPORT_ACTION,
} from '../../../application/ports/authority-repository.js';
import type {
  ReviewerQueryAuditCommandBinding,
  ReviewerQueryAuditControlEventInput,
  StoredAuthorityMembership,
  StoredAuthorityMetadata,
  StoredReviewerQueryAuditControlEvent,
  StoredReviewerQueryAuditEntry,
} from '../../../application/ports/authority-repository.js';
import {
  REVIEWER_QUERY_AUDIT_EXPORT_COMMAND_KIND,
  REVIEWER_QUERY_AUDIT_EXPIRY_COMMAND_KIND,
  assertReviewerQueryAuditCommandFresh,
  reviewerQueryAuditCommandBinding,
  reviewerQueryAuditControlCommandBinding,
  reviewerQueryAuditControlDetailJson,
  reviewerQueryAuditExportBytes,
  reviewerQueryAuditExportDocument,
  reviewerQueryAuditMaintenanceCommandSha256,
  reviewerQueryAuditOrderedRowsSha256,
  validateReviewerQueryAuditMaintenanceCommand,
  validateStoredReviewerQueryAuditControlEvent,
  validateStoredReviewerQueryAuditRow,
} from '../../../application/reviewer-query-audit.js';
import type {
  ReviewerQueryAuditExportCommandV1,
  ReviewerQueryAuditExpiryCommandV1,
  ReviewerQueryAuditMaintenanceCommandV1,
} from '../../../application/reviewer-query-audit.js';
import {
  AUTHORITY_AUDIT_ROW_COLUMNS,
  REVIEWER_QUERY_AUDIT_ROW_COLUMNS,
  assertReviewerQueryAuditRange,
} from './reviewer-query-audit-rows.js';
import type {
  AuthorityAuditRow,
  RawReviewerQueryAuditRow,
} from './reviewer-query-audit-rows.js';
import { openAuthorityDatabase } from './open-database.js';
import {
  createAuthorityStateReader,
  type AuthorityStateReader,
  type AuthorityTrustConfiguration,
} from './sqlite-authority-repository.js';

/**
 * Stopped-state reviewer query-audit maintenance.
 *
 * This whole capability -- scanning, expiry, control lookup, and control
 * append -- lives in its own module behind its own repository, and the served
 * runtime never constructs it. The online repository does not implement this
 * interface and does not export a way to reach it, so "an online request cannot
 * disclose or delete audit history" is a fact about the object graph rather
 * than a rule about how the online repository is called.
 */

const REVIEWER_QUERY_AUDIT_DELETE_DENIED_TRIGGER =
  'authority_query_decision_audit_delete_denied';

const REVIEWER_QUERY_AUDIT_RETENTION_GUARD_TRIGGER =
  'authority_query_decision_audit_retention_guard';

const REVIEWER_QUERY_AUDIT_EXPIRY_SAVEPOINT =
  'authority_query_decision_audit_expiry';

const REVIEWER_QUERY_AUDIT_CONTROL_RECEIPT_SAVEPOINT =
  'authority_query_decision_audit_control_receipt';

/**
 * The exact trigger `0006_reviewer_query_audit.sql` installs, byte for byte as
 * SQLite stores it.
 *
 * Expiry compares the live schema with this text before it is allowed to drop
 * the guard, and restores exactly this text afterwards. A database whose deny
 * trigger has been edited, weakened, or replaced therefore cannot be expired at
 * all.
 */
const REVIEWER_QUERY_AUDIT_DELETE_DENIED_TRIGGER_SQL = [
  `CREATE TRIGGER ${REVIEWER_QUERY_AUDIT_DELETE_DENIED_TRIGGER}`,
  'BEFORE DELETE ON authority_query_decision_audit',
  'BEGIN',
  "  SELECT RAISE(ABORT, 'authority query decision audit entry deletion is denied');",
  'END',
].join('\n');

export type ReviewerQueryAuditControlLookup =
  | { status: 'absent' }
  | { status: 'found'; event: StoredReviewerQueryAuditControlEvent }
  | { status: 'conflict'; reason: string }
  | { status: 'unavailable'; reason: string };

/**
 * The stored control receipt for one `qac_*` id, across both governed actions.
 *
 * A stored row that does not validate in full is reported as unavailable. It is
 * never cast into a receipt, because a maintenance command would then treat
 * corruption as a completed disclosure or a completed deletion. A row that
 * validates but does not match all three parts of the command binding is a
 * conflict, which is terminal: the same id under the other operation, or over
 * different command bytes, is not this command.
 */
function reviewerQueryAuditControlEventByCommand(
  database: Database.Database,
  binding: ReviewerQueryAuditCommandBinding,
): ReviewerQueryAuditControlLookup {
  const rows = database
    .prepare(
      `SELECT ${AUTHORITY_AUDIT_ROW_COLUMNS}
         FROM authority_audit_log
        WHERE action IN (?, ?)
          AND json_extract(detail_json, '$.command_id') = ?
        ORDER BY audit_sequence ASC`,
    )
    .all(
      REVIEWER_QUERY_AUDIT_EXPORT_ACTION,
      REVIEWER_QUERY_AUDIT_EXPIRED_ACTION,
      binding.command_id,
    ) as AuthorityAuditRow[];
  if (rows.length === 0) return { status: 'absent' };
  if (rows.length > 1) {
    return {
      status: 'unavailable',
      reason:
        'more than one reviewer query audit control event claims this command id',
    };
  }
  let event: StoredReviewerQueryAuditControlEvent;
  let stored: ReturnType<typeof reviewerQueryAuditControlCommandBinding>;
  try {
    event = validateStoredReviewerQueryAuditControlEvent(rows[0]!);
    stored = reviewerQueryAuditControlCommandBinding(event);
  } catch (error) {
    return { status: 'unavailable', reason: (error as Error).message };
  }
  if (stored.command_id !== binding.command_id) {
    return {
      status: 'unavailable',
      reason:
        'the stored reviewer query audit control event names a different command id',
    };
  }
  if (stored.action !== binding.action) {
    return {
      status: 'conflict',
      reason:
        'this reviewer query audit command id already accounts for the other governed operation',
    };
  }
  if (stored.command_sha256 !== binding.command_sha256) {
    return {
      status: 'conflict',
      reason:
        'this reviewer query audit command id already accounts for different command bytes',
    };
  }
  return { status: 'found', event };
}

/** An engine-quoted SQL string literal; the value is never concatenated raw. */
function quotedSqlLiteral(database: Database.Database, value: string): string {
  const quoted = database.prepare('SELECT quote(?) AS literal').get(value) as
    | { literal: unknown }
    | undefined;
  const literal = quoted?.literal;
  if (
    typeof literal !== 'string' ||
    !literal.startsWith("'") ||
    !literal.endsWith("'") ||
    literal.length < 2
  ) {
    throw new Error('the authority engine did not quote a SQL text literal');
  }
  return literal;
}

/**
 * The stopped-state maintenance view of the reviewer query audit.
 *
 * One instance exists per governed command, holds the one sampled time and the
 * one command binding that command owns, and stops answering the moment its
 * entrypoint returns. Every method proves that ownership before it touches the
 * database, so a captured reference cannot be replayed against a later
 * transaction's rows.
 */
class SqliteReviewerQueryAuditMaintenanceTransaction
{
  private active = true;
  private expiryAttempted = false;
  private readonly appended: StoredReviewerQueryAuditControlEvent[] = [];

  constructor(
    private readonly database: Database.Database,
    private readonly state: AuthorityStateReader,
    private readonly binding: ReviewerQueryAuditCommandBinding,
    private readonly observedAt: string,
  ) {}

  invalidate(): void {
    this.active = false;
  }

  appendedControlEvents(): readonly StoredReviewerQueryAuditControlEvent[] {
    return this.appended;
  }

  private transactionTime(): string {
    if (!this.active) {
      throw new Error(
        'the reviewer query audit maintenance transaction is no longer open',
      );
    }
    return this.observedAt;
  }

  metadata(): StoredAuthorityMetadata {
    this.transactionTime();
    return this.state.metadata();
  }

  membership(membershipId: string): StoredAuthorityMembership | undefined {
    this.transactionTime();
    return this.state.membership(membershipId);
  }

  auditBetween(
    fromInclusive: string,
    untilExclusive: string,
  ): StoredReviewerQueryAuditEntry[] {
    this.transactionTime();
    assertReviewerQueryAuditRange(fromInclusive, untilExclusive);
    return (
      this.database
        .prepare(
          `SELECT ${REVIEWER_QUERY_AUDIT_ROW_COLUMNS}
             FROM authority_query_decision_audit
            WHERE occurred_at >= ? AND occurred_at < ?
            ORDER BY audit_sequence ASC`,
        )
        .all(fromInclusive, untilExclusive) as RawReviewerQueryAuditRow[]
    ).map(validateStoredReviewerQueryAuditRow);
  }

  dueForExpiry(): StoredReviewerQueryAuditEntry[] {
    return this.selectDueEntries(this.transactionTime());
  }

  private selectDueEntries(cutoff: string): StoredReviewerQueryAuditEntry[] {
    return (
      this.database
        .prepare(
          `SELECT ${REVIEWER_QUERY_AUDIT_ROW_COLUMNS}
             FROM authority_query_decision_audit
            WHERE retain_until <= ?
            ORDER BY audit_sequence ASC`,
        )
        .all(cutoff) as RawReviewerQueryAuditRow[]
    ).map(validateStoredReviewerQueryAuditRow);
  }

  expireDueEntries(): number {
    const cutoff = this.transactionTime();
    if (this.expiryAttempted) {
      throw new Error(
        'reviewer query audit expiry may run at most once per maintenance transaction',
      );
    }
    this.expiryAttempted = true;
    // The preselection is validated, so an overdue row this Authority cannot
    // account for stops the whole expiry instead of being quietly destroyed.
    const due = this.selectDueEntries(cutoff);
    // Everything below happens inside the already-held BEGIN IMMEDIATE, so no
    // other connection can observe or interleave with the window in which the
    // unconditional deny trigger is replaced by the retention guard.
    this.database.exec(`SAVEPOINT ${REVIEWER_QUERY_AUDIT_EXPIRY_SAVEPOINT}`);
    try {
      this.assertDeleteDeniedTriggerInstalled();
      this.database.exec(
        `DROP TRIGGER ${REVIEWER_QUERY_AUDIT_DELETE_DENIED_TRIGGER}`,
      );
      this.database.exec(this.retentionGuardTriggerSql(cutoff));
      const deleted = this.database
        .prepare(
          `DELETE FROM authority_query_decision_audit WHERE retain_until <= ?`,
        )
        .run(cutoff).changes;
      if (deleted !== due.length) {
        throw new Error(
          'reviewer query audit expiry removed a different number of entries than its own retention selection',
        );
      }
      this.database.exec(
        `DROP TRIGGER ${REVIEWER_QUERY_AUDIT_RETENTION_GUARD_TRIGGER}`,
      );
      this.database.exec(`${REVIEWER_QUERY_AUDIT_DELETE_DENIED_TRIGGER_SQL};`);
      this.assertDeleteDeniedTriggerInstalled();
      this.assertRetentionGuardRemoved();
      this.database.exec(`RELEASE ${REVIEWER_QUERY_AUDIT_EXPIRY_SAVEPOINT}`);
      return deleted;
    } catch (error) {
      // Restores the rows and the original unconditional deny trigger together,
      // so the guard is back even if the caller catches this and continues.
      try {
        this.database.exec(
          `ROLLBACK TO ${REVIEWER_QUERY_AUDIT_EXPIRY_SAVEPOINT}`,
        );
        this.database.exec(`RELEASE ${REVIEWER_QUERY_AUDIT_EXPIRY_SAVEPOINT}`);
      } catch {}
      throw error;
    }
  }

  appendControlEvent(
    entry: ReviewerQueryAuditControlEventInput,
  ): StoredReviewerQueryAuditControlEvent {
    const occurredAt = this.transactionTime();
    // The action is the command's, never the caller's, so an export command
    // cannot append an expiry receipt or the reverse.
    const detailJson = reviewerQueryAuditControlDetailJson(
      {
        action: this.binding.action,
        subject_id: entry.subject_id,
        occurred_at: occurredAt,
      },
      entry.detail,
    );
    // Insert and verify inside a savepoint. Every check below runs after the
    // row exists, so without this a caller that catches a rejected append would
    // leave an unaccounted control row behind in the committed transaction.
    this.database.exec(
      `SAVEPOINT ${REVIEWER_QUERY_AUDIT_CONTROL_RECEIPT_SAVEPOINT}`,
    );
    try {
      const inserted = this.database
        .prepare(
          `INSERT INTO authority_audit_log (
             occurred_at, actor_kind, action, subject_id, detail_json
           ) VALUES (?, 'admin', ?, ?, ?)`,
        )
        .run(occurredAt, this.binding.action, entry.subject_id, detailJson);
      const auditSequence = Number(inserted.lastInsertRowid);
      // Read back by the inserted sequence, not by a detail lookup: the receipt
      // must be this exact row, not whichever row happens to match a JSON
      // field.
      const row = this.database
        .prepare(
          `SELECT ${AUTHORITY_AUDIT_ROW_COLUMNS}
             FROM authority_audit_log
            WHERE audit_sequence = ?`,
        )
        .get(auditSequence) as AuthorityAuditRow | undefined;
      if (row === undefined) {
        throw new Error('reviewer query audit control event was not stored');
      }
      const stored = validateStoredReviewerQueryAuditControlEvent(row);
      if (
        stored.audit_sequence !== auditSequence ||
        stored.occurred_at !== occurredAt ||
        stored.action !== this.binding.action ||
        stored.subject_id !== entry.subject_id ||
        stored.detail_json !== detailJson
      ) {
        throw new Error(
          'the stored reviewer query audit control event is not what was appended',
        );
      }
      const receipt = reviewerQueryAuditControlCommandBinding(stored);
      if (
        receipt.command_id !== this.binding.command_id ||
        receipt.command_sha256 !== this.binding.command_sha256
      ) {
        throw new Error(
          'the reviewer query audit control receipt does not account for this command',
        );
      }
      this.database.exec(
        `RELEASE ${REVIEWER_QUERY_AUDIT_CONTROL_RECEIPT_SAVEPOINT}`,
      );
      this.appended.push(stored);
      return stored;
    } catch (error) {
      try {
        this.database.exec(
          `ROLLBACK TO ${REVIEWER_QUERY_AUDIT_CONTROL_RECEIPT_SAVEPOINT}`,
        );
        this.database.exec(
          `RELEASE ${REVIEWER_QUERY_AUDIT_CONTROL_RECEIPT_SAVEPOINT}`,
        );
      } catch {}
      throw error;
    }
  }

  private assertDeleteDeniedTriggerInstalled(): void {
    const row = this.database
      .prepare(
        `SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?`,
      )
      .get(REVIEWER_QUERY_AUDIT_DELETE_DENIED_TRIGGER) as
      | { sql: unknown }
      | undefined;
    if (row?.sql !== REVIEWER_QUERY_AUDIT_DELETE_DENIED_TRIGGER_SQL) {
      throw new Error(
        'the reviewer query audit delete guard is not the exact trigger this schema installs',
      );
    }
  }

  private assertRetentionGuardRemoved(): void {
    const row = this.database
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = ?`,
      )
      .get(REVIEWER_QUERY_AUDIT_RETENTION_GUARD_TRIGGER) as
      | { name: string }
      | undefined;
    if (row !== undefined) {
      throw new Error(
        'the reviewer query audit retention guard outlived its own expiry',
      );
    }
  }

  /**
   * The guard that holds while the unconditional deny trigger is down. Its
   * cutoff is an engine-quoted literal of the one time this transaction owns,
   * so the schema itself refuses to delete a still-retained entry no matter
   * what statement issues the delete.
   */
  private retentionGuardTriggerSql(cutoff: string): string {
    return [
      `CREATE TRIGGER ${REVIEWER_QUERY_AUDIT_RETENTION_GUARD_TRIGGER}`,
      'BEFORE DELETE ON authority_query_decision_audit',
      `WHEN OLD.retain_until > ${quotedSqlLiteral(this.database, cutoff)}`,
      'BEGIN',
      "  SELECT RAISE(ABORT, 'authority query decision audit entry is still retained');",
      'END;',
    ].join('\n');
  }
}

export interface OpenReviewerQueryAuditMaintenanceInput {
  database_path: string;
  /** The same configured trust root the served Authority is pinned to. */
  trust: AuthorityTrustConfiguration;
}

export interface AuthorizedReviewerQueryAuditExport {
  readonly control_event: StoredReviewerQueryAuditControlEvent;
  /** Null means an exact retry could no longer reproduce the authorized bytes. */
  readonly export_bytes: Uint8Array | null;
}

/**
 * The stopped-only repository one governed maintenance command runs against.
 *
 * It owns its own connection and is never wired into the served runtime, so the
 * only way to reach expiry or a control append is to open this repository
 * deliberately from stopped-state operator composition.
 */
export class SqliteReviewerQueryAuditMaintenanceRepository
{
  private readonly database: Database.Database;
  private readonly state: AuthorityStateReader;
  private closed = false;

  private constructor(
    database: Database.Database,
    state: AuthorityStateReader,
  ) {
    this.database = database;
    this.state = state;
  }

  static open(
    input: OpenReviewerQueryAuditMaintenanceInput,
  ): SqliteReviewerQueryAuditMaintenanceRepository {
    // The authority must already exist: maintenance never creates or
    // initializes state, it only accounts for state a served authority wrote.
    const database = openAuthorityDatabase(input.database_path, {
      fileMustExist: true,
    });
    try {
      return new SqliteReviewerQueryAuditMaintenanceRepository(
        database,
        createAuthorityStateReader(database, input.trust),
      );
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /**
   * Authorizes exactly one bounded export; no callback receives database
   * powers. Every call, including a receipted exact retry, proves live
   * disclosure authority before it can reconstruct plaintext.
   */
  authorizeExport(
    input: ReviewerQueryAuditExportCommandV1,
    observe: () => string,
  ): AuthorizedReviewerQueryAuditExport {
    const command = validateReviewerQueryAuditMaintenanceCommand(input);
    if (command.kind !== REVIEWER_QUERY_AUDIT_EXPORT_COMMAND_KIND) {
      throw new Error('reviewer query audit export requires an export command');
    }
    return this.runCommand(
      command,
      observe,
      (transaction, observedAt) => {
        this.assertCommandAuthorityAndCurrentOwner(command);
        assertReviewerQueryAuditCommandFresh(command, observedAt);
        if (command.until_exclusive > observedAt) {
          throw new Error(
            'reviewer query audit export range may not extend into the future',
          );
        }
        return this.authorizeFreshExport(transaction, command);
      },
      (event) => {
        // A durable receipt is not a continuing disclosure grant. Exact
        // retries deliberately do not sample time or apply freshness again,
        // but they must still prove the configured Authority and exact owner
        // remain current before reconstructing plaintext.
        this.assertCommandAuthorityAndCurrentOwner(command);
        return this.reproduceAuthorizedExport(event, command);
      },
    );
  }

  /** Expires all-and-only rows due at the transaction-owned time. */
  expire(
    input: ReviewerQueryAuditExpiryCommandV1,
    observe: () => string,
  ): StoredReviewerQueryAuditControlEvent {
    const command = validateReviewerQueryAuditMaintenanceCommand(input);
    if (command.kind !== REVIEWER_QUERY_AUDIT_EXPIRY_COMMAND_KIND) {
      throw new Error('reviewer query audit expiry requires an expiry command');
    }
    return this.runCommand(
      command,
      observe,
      (transaction, observedAt) => {
        this.assertCommandAuthorityAndCurrentOwner(command);
        assertReviewerQueryAuditCommandFresh(command, observedAt);
        const due = transaction.dueForExpiry();
        const orderedRowsSha256 = reviewerQueryAuditOrderedRowsSha256(due);
        const deleted = transaction.expireDueEntries();
        if (deleted !== due.length) {
          throw new Error(
            'reviewer query audit expiry did not delete its exact selected row set',
          );
        }
        return transaction.appendControlEvent({
          subject_id: command.owner_membership_id,
          detail: {
            schema_version: 1,
            kind: 'reviewer-query-audit-expired-detail-v1',
            command_id: command.command_id,
            command_sha256:
              reviewerQueryAuditMaintenanceCommandSha256(command),
            authority_id: command.authority_id,
            organization_id: command.organization_id,
            owner_principal_id: command.owner_principal_id,
            owner_membership_id: command.owner_membership_id,
            reason: command.reason,
            retention_days: 180,
            cutoff: observedAt,
            row_count: due.length,
            ordered_rows_sha256: orderedRowsSha256,
          },
        });
      },
      (event) => event,
    );
  }

  /**
   * The one internal transaction skeleton shared by the two closed operations.
   * The caller cannot supply an operation: only `authorizeExport` and `expire`
   * above can reach it.
   */
  private runCommand<T>(
    command: ReviewerQueryAuditMaintenanceCommandV1,
    observe: () => string,
    firstExecution: (
      transaction: SqliteReviewerQueryAuditMaintenanceTransaction,
      observedAt: string,
    ) => T,
    exactRetry: (event: StoredReviewerQueryAuditControlEvent) => T,
  ): T {
    this.assertOpen();
    const binding = reviewerQueryAuditCommandBinding(command);
    this.database.exec('BEGIN IMMEDIATE');
    let maintenance:
      | SqliteReviewerQueryAuditMaintenanceTransaction
      | undefined;
    try {
      const existing = reviewerQueryAuditControlEventByCommand(
        this.database,
        binding,
      );
      let result: T;
      if (existing.status === 'found') {
        result = exactRetry(existing.event);
      } else if (existing.status === 'conflict') {
        throw new Error(existing.reason);
      } else if (existing.status === 'unavailable') {
        throw new Error(existing.reason);
      } else {
        const observedAt = observe();
        timestampMillis(
          observedAt,
          'authority reviewer query audit maintenance time',
        );
        const metadata = this.state.metadata();
        if (observedAt < metadata.last_observed_at) {
          throw new Error(
            'authority clock regressed since the last committed write',
          );
        }
        this.database
          .prepare(
            'UPDATE authority_metadata SET last_observed_at = ? WHERE singleton = 1',
          )
          .run(observedAt);
        maintenance = new SqliteReviewerQueryAuditMaintenanceTransaction(
          this.database,
          this.state,
          binding,
          observedAt,
        );
        result = firstExecution(maintenance, observedAt);
      }
      if (maintenance !== undefined) {
        this.assertExactlyOneReceipt(maintenance, binding);
      }
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    } finally {
      maintenance?.invalidate();
    }
  }

  /**
   * Proves live disclosure authority inside the stopped maintenance
   * transaction. A durable receipt proves idempotency only; export retries
   * cannot expose plaintext until this check succeeds.
   */
  private assertCommandAuthorityAndCurrentOwner(
    command: ReviewerQueryAuditMaintenanceCommandV1,
  ): void {
    const metadata = this.state.metadata();
    if (
      metadata.authority_id !== command.authority_id ||
      metadata.organization_id !== command.organization_id
    ) {
      throw new Error(
        'reviewer query audit command does not name this authority and organization',
      );
    }
    const owner = this.state.membership(command.owner_membership_id);
    if (
      owner === undefined ||
      owner.organization_id !== command.organization_id ||
      owner.principal_id !== command.owner_principal_id ||
      owner.membership_id !== command.owner_membership_id ||
      owner.membership_type !== 'owner' ||
      owner.status !== 'active' ||
      owner.revoked_at !== null
    ) {
      throw new Error(
        'reviewer query audit maintenance requires the exact current active owner',
      );
    }
  }

  private authorizeFreshExport(
    transaction: SqliteReviewerQueryAuditMaintenanceTransaction,
    command: ReviewerQueryAuditExportCommandV1,
  ): AuthorizedReviewerQueryAuditExport {
    const rows = transaction.auditBetween(
      command.from_inclusive,
      command.until_exclusive,
    );
    const document = reviewerQueryAuditExportDocument(command, rows);
    const bytes = reviewerQueryAuditExportBytes(document);
    const orderedRowsSha256 = reviewerQueryAuditOrderedRowsSha256(rows);
    const exportSha256 = canonicalSha256(document as unknown as JsonObject);
    const event = transaction.appendControlEvent({
      subject_id: command.owner_membership_id,
      detail: {
        schema_version: 1,
        kind: 'reviewer-query-audit-export-authorized-detail-v1',
        command_id: command.command_id,
        command_sha256: reviewerQueryAuditMaintenanceCommandSha256(command),
        authority_id: command.authority_id,
        organization_id: command.organization_id,
        owner_principal_id: command.owner_principal_id,
        owner_membership_id: command.owner_membership_id,
        reason: command.reason,
        from_inclusive: command.from_inclusive,
        until_exclusive: command.until_exclusive,
        output_path_sha256: command.output_path_sha256,
        row_count: rows.length,
        ordered_rows_sha256: orderedRowsSha256,
        export_sha256: exportSha256,
      },
    });
    return { control_event: event, export_bytes: bytes };
  }

  private reproduceAuthorizedExport(
    event: StoredReviewerQueryAuditControlEvent,
    command: ReviewerQueryAuditExportCommandV1,
  ): AuthorizedReviewerQueryAuditExport {
    try {
      const rows = this.auditBetween(
        command.from_inclusive,
        command.until_exclusive,
      );
      const document = reviewerQueryAuditExportDocument(command, rows);
      const bytes = reviewerQueryAuditExportBytes(document);
      const detail = parseCanonicalJson(event.detail_json) as JsonObject;
      const matches =
        detail['authority_id'] === command.authority_id &&
        detail['organization_id'] === command.organization_id &&
        detail['owner_principal_id'] === command.owner_principal_id &&
        detail['owner_membership_id'] === command.owner_membership_id &&
        detail['reason'] === command.reason &&
        detail['from_inclusive'] === command.from_inclusive &&
        detail['until_exclusive'] === command.until_exclusive &&
        detail['output_path_sha256'] === command.output_path_sha256 &&
        detail['row_count'] === rows.length &&
        detail['ordered_rows_sha256'] ===
          reviewerQueryAuditOrderedRowsSha256(rows) &&
        detail['export_sha256'] ===
          canonicalSha256(document as unknown as JsonObject);
      return { control_event: event, export_bytes: matches ? bytes : null };
    } catch {
      return { control_event: event, export_bytes: null };
    }
  }

  private auditBetween(
    fromInclusive: string,
    untilExclusive: string,
  ): StoredReviewerQueryAuditEntry[] {
    assertReviewerQueryAuditRange(fromInclusive, untilExclusive);
    return (
      this.database
        .prepare(
          `SELECT ${REVIEWER_QUERY_AUDIT_ROW_COLUMNS}
             FROM authority_query_decision_audit
            WHERE occurred_at >= ? AND occurred_at < ?
            ORDER BY audit_sequence ASC`,
        )
        .all(fromInclusive, untilExclusive) as RawReviewerQueryAuditRow[]
    ).map(validateStoredReviewerQueryAuditRow);
  }

  /**
   * A first execution that commits must leave exactly one receipt for its own
   * command.
   *
   * A command that scanned or deleted and then wrote nothing would leave an
   * unaccounted disclosure or deletion, and a retry of it would look like a
   * first execution forever. Rolling back is the only outcome that keeps
   * "executed" and "receipted" the same fact.
   */
  private assertExactlyOneReceipt(
    maintenance: SqliteReviewerQueryAuditMaintenanceTransaction,
    command: ReviewerQueryAuditCommandBinding,
  ): void {
    const appended = maintenance.appendedControlEvents();
    if (appended.length !== 1) {
      throw new Error(
        'a governed reviewer query audit command must append exactly one control receipt',
      );
    }
    const receipt = appended[0]!;
    const stored = reviewerQueryAuditControlEventByCommand(
      this.database,
      command,
    );
    if (
      stored.status !== 'found' ||
      stored.event.audit_sequence !== receipt.audit_sequence ||
      stored.event.occurred_at !== receipt.occurred_at ||
      stored.event.actor_kind !== receipt.actor_kind ||
      stored.event.action !== receipt.action ||
      stored.event.subject_id !== receipt.subject_id ||
      stored.event.detail_json !== receipt.detail_json
    ) {
      throw new Error(
        'the appended reviewer query audit control receipt is not the stored receipt for this command',
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(
        'reviewer query audit maintenance repository is closed',
      );
    }
  }

  private rollback(): void {
    try {
      this.database.exec('ROLLBACK');
    } catch {}
  }
}
