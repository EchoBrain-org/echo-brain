import type Database from 'better-sqlite3';
import { canonicalSha256, parseCanonicalJson } from '@echo-brain/federation-protocol';
import type { JsonObject } from '@echo-brain/federation-protocol';
import { timestampMillis } from '../../../domain/rules.js';
import {
  READABLE_SEARCH_QUERY_AUDIT_EXPIRED_ACTION,
  READABLE_SEARCH_QUERY_AUDIT_EXPORT_ACTION,
} from '../../../application/ports/authority-repository.js';
import type {
  ReadableSearchQueryAuditCommandBinding,
  StoredAuthorityMembership,
  StoredAuthorityMetadata,
  StoredReadableSearchQueryAuditControlEvent,
  StoredReadableSearchQueryAuditEntry,
} from '../../../application/ports/authority-repository.js';
import {
  READABLE_SEARCH_QUERY_AUDIT_EXPIRY_COMMAND_KIND,
  READABLE_SEARCH_QUERY_AUDIT_EXPORT_COMMAND_KIND,
  assertReadableSearchQueryAuditCommandFresh,
  readableSearchQueryAuditCommandBinding,
  readableSearchQueryAuditControlCommandBinding,
  readableSearchQueryAuditControlDetailJson,
  readableSearchQueryAuditExportBytes,
  readableSearchQueryAuditExportDocument,
  readableSearchQueryAuditMaintenanceCommandSha256,
  readableSearchQueryAuditOrderedRowsSha256,
  validateReadableSearchQueryAuditMaintenanceCommand,
  validateStoredReadableSearchQueryAuditControlEvent,
} from '../../../application/readable-search-query-audit-maintenance.js';
import type {
  ReadableSearchQueryAuditExpiryCommandV1,
  ReadableSearchQueryAuditExportCommandV1,
  ReadableSearchQueryAuditMaintenanceCommandV1,
} from '../../../application/readable-search-query-audit-maintenance.js';
import { validateStoredReadableSearchQueryAuditEntry } from '../../../application/readable-search-persistence.js';
import { openAuthorityDatabase } from './open-database.js';
import {
  createAuthorityStateReader,
  type AuthorityStateReader,
  type AuthorityTrustConfiguration,
} from './sqlite-authority-repository.js';

const AUDIT_COLUMNS = 'audit_sequence, occurred_at, actor_kind, action, subject_id, detail_json';
const QUERY_COLUMNS = 'audit_sequence, occurred_at, retain_until, operation, decision, reason_code, detail_json';
const DELETE_DENIED = 'authority_readable_search_query_audit_delete_denied';
const RETENTION_GUARD = 'authority_readable_search_query_audit_retention_guard';
const EXPIRY_SAVEPOINT = 'authority_readable_search_query_audit_expiry';
const RECEIPT_SAVEPOINT = 'authority_readable_search_query_audit_receipt';
const DELETE_DENIED_SQL = [
  `CREATE TRIGGER ${DELETE_DENIED}`,
  'BEFORE DELETE ON authority_readable_search_query_audit',
  'BEGIN',
  "  SELECT RAISE(ABORT, 'readable search query audit entry deletion is denied');",
  'END',
].join('\n');

interface AuditRow { audit_sequence: unknown; occurred_at: unknown; actor_kind: unknown; action: unknown; subject_id: unknown; detail_json: unknown; }
interface QueryRow { audit_sequence: unknown; occurred_at: unknown; retain_until: unknown; operation: unknown; decision: unknown; reason_code: unknown; detail_json: unknown; }

export type ReadableSearchQueryAuditControlLookup =
  | { status: 'absent' }
  | { status: 'found'; event: StoredReadableSearchQueryAuditControlEvent }
  | { status: 'conflict'; reason: string }
  | { status: 'unavailable'; reason: string };

function lookup(database: Database.Database, binding: ReadableSearchQueryAuditCommandBinding): ReadableSearchQueryAuditControlLookup {
  const rows = database.prepare(
    `SELECT ${AUDIT_COLUMNS} FROM authority_audit_log
      WHERE action IN (?, ?) AND json_extract(detail_json, '$.command_id') = ?
      ORDER BY audit_sequence ASC`,
  ).all(READABLE_SEARCH_QUERY_AUDIT_EXPORT_ACTION, READABLE_SEARCH_QUERY_AUDIT_EXPIRED_ACTION, binding.command_id) as AuditRow[];
  if (rows.length === 0) return { status: 'absent' };
  if (rows.length !== 1) return { status: 'unavailable', reason: 'more than one readable search query audit control event claims this command id' };
  try {
    const event = validateStoredReadableSearchQueryAuditControlEvent(rows[0]!);
    const receipt = readableSearchQueryAuditControlCommandBinding(event);
    if (receipt.command_id !== binding.command_id) {
      return { status: 'unavailable', reason: 'stored readable search query audit control event names a different command id' };
    }
    if (receipt.action !== binding.action) return { status: 'conflict', reason: 'this readable search query audit command id already accounts for the other governed operation' };
    if (receipt.command_sha256 !== binding.command_sha256) return { status: 'conflict', reason: 'this readable search query audit command id already accounts for different command bytes' };
    return { status: 'found', event };
  } catch (error) {
    return { status: 'unavailable', reason: (error as Error).message };
  }
}

function rows(database: Database.Database, statement: string, values: readonly unknown[]): StoredReadableSearchQueryAuditEntry[] {
  return (database.prepare(statement).all(...values) as QueryRow[]).map(validateStoredReadableSearchQueryAuditEntry);
}

class MaintenanceTransaction {
  private active = true;
  private expiryRan = false;
  private receipt: StoredReadableSearchQueryAuditControlEvent | undefined;

  constructor(private readonly database: Database.Database, private readonly state: AuthorityStateReader, private readonly binding: ReadableSearchQueryAuditCommandBinding, private readonly observedAt: string) {}
  invalidate(): void { this.active = false; }
  private time(): string { if (!this.active) throw new Error('readable search query audit maintenance transaction is no longer open'); return this.observedAt; }
  metadata(): StoredAuthorityMetadata { this.time(); return this.state.metadata(); }
  membership(id: string): StoredAuthorityMembership | undefined { this.time(); return this.state.membership(id); }
  appended(): StoredReadableSearchQueryAuditControlEvent | undefined { return this.receipt; }
  auditBetween(from: string, until: string): StoredReadableSearchQueryAuditEntry[] {
    this.time();
    if (!(from < until)) throw new Error('readable search query audit range must be positive');
    return rows(this.database, `SELECT ${QUERY_COLUMNS} FROM authority_readable_search_query_audit WHERE occurred_at >= ? AND occurred_at < ? ORDER BY audit_sequence ASC`, [from, until]);
  }
  due(): StoredReadableSearchQueryAuditEntry[] {
    return rows(this.database, `SELECT ${QUERY_COLUMNS} FROM authority_readable_search_query_audit WHERE retain_until <= ? ORDER BY audit_sequence ASC`, [this.time()]);
  }
  expire(): number {
    if (this.expiryRan) throw new Error('readable search query audit expiry may run at most once per maintenance transaction');
    this.expiryRan = true;
    const due = this.due();
    this.database.exec(`SAVEPOINT ${EXPIRY_SAVEPOINT}`);
    try {
      this.assertDeleteGuard();
      this.database.exec(`DROP TRIGGER ${DELETE_DENIED}`);
      this.database.exec(this.guardSql(this.time()));
      const deleted = this.database.prepare('DELETE FROM authority_readable_search_query_audit WHERE retain_until <= ?').run(this.time()).changes;
      if (deleted !== due.length) throw new Error('readable search query audit expiry removed a different number of entries than its selection');
      this.database.exec(`DROP TRIGGER ${RETENTION_GUARD}`);
      this.database.exec(`${DELETE_DENIED_SQL};`);
      this.assertDeleteGuard();
      if (this.database.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?`).get(RETENTION_GUARD) !== undefined) throw new Error('readable search query audit retention guard outlived expiry');
      this.database.exec(`RELEASE ${EXPIRY_SAVEPOINT}`);
      return deleted;
    } catch (error) {
      try { this.database.exec(`ROLLBACK TO ${EXPIRY_SAVEPOINT}`); this.database.exec(`RELEASE ${EXPIRY_SAVEPOINT}`); } catch {}
      throw error;
    }
  }
  append(detail: Record<string, unknown>): StoredReadableSearchQueryAuditControlEvent {
    const occurredAt = this.time();
    const detailJson = readableSearchQueryAuditControlDetailJson({ action: this.binding.action, subject_id: String(detail.owner_membership_id), occurred_at: occurredAt }, detail as unknown as import('@echo-brain/federation-protocol').JsonValue);
    this.database.exec(`SAVEPOINT ${RECEIPT_SAVEPOINT}`);
    try {
      const inserted = this.database.prepare(`INSERT INTO authority_audit_log (occurred_at, actor_kind, action, subject_id, detail_json) VALUES (?, 'admin', ?, ?, ?)`).run(occurredAt, this.binding.action, detail.owner_membership_id, detailJson);
      const sequence = Number(inserted.lastInsertRowid);
      const row = this.database.prepare(`SELECT ${AUDIT_COLUMNS} FROM authority_audit_log WHERE audit_sequence = ?`).get(sequence) as AuditRow | undefined;
      if (row === undefined) throw new Error('readable search query audit control event was not stored');
      const event = validateStoredReadableSearchQueryAuditControlEvent(row);
      const receipt = readableSearchQueryAuditControlCommandBinding(event);
      if (event.audit_sequence !== sequence || event.occurred_at !== occurredAt || event.action !== this.binding.action || event.detail_json !== detailJson || receipt.command_id !== this.binding.command_id || receipt.command_sha256 !== this.binding.command_sha256) throw new Error('stored readable search query audit receipt differs from its append');
      this.database.exec(`RELEASE ${RECEIPT_SAVEPOINT}`);
      this.receipt = event;
      return event;
    } catch (error) {
      try { this.database.exec(`ROLLBACK TO ${RECEIPT_SAVEPOINT}`); this.database.exec(`RELEASE ${RECEIPT_SAVEPOINT}`); } catch {}
      throw error;
    }
  }
  private assertDeleteGuard(): void {
    const row = this.database.prepare(`SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?`).get(DELETE_DENIED) as { sql: unknown } | undefined;
    if (row?.sql !== DELETE_DENIED_SQL) throw new Error('the readable search query audit delete guard is not the exact schema trigger');
  }
  private guardSql(cutoff: string): string {
    const quoted = this.database.prepare('SELECT quote(?) AS literal').get(cutoff) as { literal: unknown } | undefined;
    if (typeof quoted?.literal !== 'string') throw new Error('authority engine could not quote retention cutoff');
    return [`CREATE TRIGGER ${RETENTION_GUARD}`, 'BEFORE DELETE ON authority_readable_search_query_audit', `WHEN OLD.retain_until > ${quoted.literal}`, 'BEGIN', "  SELECT RAISE(ABORT, 'readable search query audit entry is still retained');", 'END;'].join('\n');
  }
}

export interface OpenReadableSearchQueryAuditMaintenanceInput { database_path: string; trust: AuthorityTrustConfiguration; }
export interface AuthorizedReadableSearchQueryAuditExport { readonly control_event: StoredReadableSearchQueryAuditControlEvent; readonly export_bytes: Uint8Array | null; }

/** Stopped-only query-audit maintenance. It is deliberately not an online repository. */
export class SqliteReadableSearchQueryAuditMaintenanceRepository {
  private closed = false;
  private constructor(private readonly database: Database.Database, private readonly state: AuthorityStateReader) {}
  static open(input: OpenReadableSearchQueryAuditMaintenanceInput): SqliteReadableSearchQueryAuditMaintenanceRepository {
    const database = openAuthorityDatabase(input.database_path, { fileMustExist: true });
    try { return new SqliteReadableSearchQueryAuditMaintenanceRepository(database, createAuthorityStateReader(database, input.trust)); } catch (error) { database.close(); throw error; }
  }
  authorizeExport(input: ReadableSearchQueryAuditExportCommandV1, observe: () => string): AuthorizedReadableSearchQueryAuditExport {
    const command = validateReadableSearchQueryAuditMaintenanceCommand(input);
    if (command.kind !== READABLE_SEARCH_QUERY_AUDIT_EXPORT_COMMAND_KIND) throw new Error('readable search query audit export requires an export command');
    const result = this.run(command, observe);
    if (!('export_bytes' in result)) throw new Error('readable search query audit export returned an expiry receipt');
    return result;
  }
  expire(input: ReadableSearchQueryAuditExpiryCommandV1, observe: () => string): StoredReadableSearchQueryAuditControlEvent {
    const command = validateReadableSearchQueryAuditMaintenanceCommand(input);
    if (command.kind !== READABLE_SEARCH_QUERY_AUDIT_EXPIRY_COMMAND_KIND) throw new Error('readable search query audit expiry requires an expiry command');
    return this.run(command, observe) as StoredReadableSearchQueryAuditControlEvent;
  }
  private run(command: ReadableSearchQueryAuditMaintenanceCommandV1, observe: () => string): AuthorizedReadableSearchQueryAuditExport | StoredReadableSearchQueryAuditControlEvent {
    if (this.closed) throw new Error('readable search query audit maintenance repository is closed');
    const binding = readableSearchQueryAuditCommandBinding(command);
    this.database.exec('BEGIN IMMEDIATE');
    let transaction: MaintenanceTransaction | undefined;
    try {
      const prior = lookup(this.database, binding);
      let result: AuthorizedReadableSearchQueryAuditExport | StoredReadableSearchQueryAuditControlEvent;
      if (prior.status === 'found') result = command.kind === READABLE_SEARCH_QUERY_AUDIT_EXPORT_COMMAND_KIND ? this.reproduce(prior.event, command) : prior.event;
      else {
        if (prior.status !== 'absent') throw new Error(prior.reason);
        const observedAt = observe(); timestampMillis(observedAt, 'readable search query audit maintenance time');
        if (observedAt < this.state.metadata().last_observed_at) throw new Error('authority clock regressed since the last committed write');
        this.database.prepare('UPDATE authority_metadata SET last_observed_at = ? WHERE singleton = 1').run(observedAt);
        transaction = new MaintenanceTransaction(this.database, this.state, binding, observedAt);
        this.assertOwner(transaction, command); assertReadableSearchQueryAuditCommandFresh(command, observedAt);
        if (command.kind === READABLE_SEARCH_QUERY_AUDIT_EXPORT_COMMAND_KIND) {
          if (command.until_exclusive > observedAt) throw new Error('readable search query audit export range may not extend into the future');
          const selected = transaction.auditBetween(command.from_inclusive, command.until_exclusive);
          const document = readableSearchQueryAuditExportDocument(command, selected);
          const bytes = readableSearchQueryAuditExportBytes(document);
          const event = transaction.append({ schema_version: 1, kind: 'readable-search-query-audit-export-authorized-detail-v1', command_id: command.command_id, command_sha256: readableSearchQueryAuditMaintenanceCommandSha256(command), authority_id: command.authority_id, organization_id: command.organization_id, owner_principal_id: command.owner_principal_id, owner_membership_id: command.owner_membership_id, reason: command.reason, from_inclusive: command.from_inclusive, until_exclusive: command.until_exclusive, output_path_sha256: command.output_path_sha256, row_count: selected.length, ordered_rows_sha256: readableSearchQueryAuditOrderedRowsSha256(selected), export_sha256: canonicalSha256(document as unknown as JsonObject) });
          result = { control_event: event, export_bytes: bytes };
        } else {
          const due = transaction.due(); const digest = readableSearchQueryAuditOrderedRowsSha256(due); const deleted = transaction.expire();
          if (deleted !== due.length) throw new Error('readable search query audit expiry did not delete its exact selected rows');
          result = transaction.append({ schema_version: 1, kind: 'readable-search-query-audit-expired-detail-v1', command_id: command.command_id, command_sha256: readableSearchQueryAuditMaintenanceCommandSha256(command), authority_id: command.authority_id, organization_id: command.organization_id, owner_principal_id: command.owner_principal_id, owner_membership_id: command.owner_membership_id, reason: command.reason, retention_days: 180, cutoff: observedAt, row_count: due.length, ordered_rows_sha256: digest });
        }
      }
      if (transaction?.appended() !== undefined && lookup(this.database, binding).status !== 'found') throw new Error('readable search query audit command lacks its stored receipt');
      this.database.exec('COMMIT'); return result;
    } catch (error) { try { this.database.exec('ROLLBACK'); } catch {} throw error; } finally { transaction?.invalidate(); }
  }
  private assertOwner(transaction: MaintenanceTransaction, command: ReadableSearchQueryAuditMaintenanceCommandV1): void {
    const metadata = transaction.metadata(); const owner = transaction.membership(command.owner_membership_id);
    if (metadata.authority_id !== command.authority_id || metadata.organization_id !== command.organization_id || owner === undefined || owner.organization_id !== command.organization_id || owner.principal_id !== command.owner_principal_id || owner.membership_id !== command.owner_membership_id || owner.membership_type !== 'owner' || owner.status !== 'active' || owner.revoked_at !== null) throw new Error('readable search query audit maintenance requires the exact current active owner');
  }
  private reproduce(event: StoredReadableSearchQueryAuditControlEvent, command: ReadableSearchQueryAuditExportCommandV1): AuthorizedReadableSearchQueryAuditExport {
    try {
      const selected = rows(this.database, `SELECT ${QUERY_COLUMNS} FROM authority_readable_search_query_audit WHERE occurred_at >= ? AND occurred_at < ? ORDER BY audit_sequence ASC`, [command.from_inclusive, command.until_exclusive]);
      const document = readableSearchQueryAuditExportDocument(command, selected); const bytes = readableSearchQueryAuditExportBytes(document); const detail = parseCanonicalJson(event.detail_json) as JsonObject;
      const equal = detail['row_count'] === selected.length && detail['ordered_rows_sha256'] === readableSearchQueryAuditOrderedRowsSha256(selected) && detail['export_sha256'] === canonicalSha256(document as unknown as JsonObject);
      return { control_event: event, export_bytes: equal ? bytes : null };
    } catch { return { control_event: event, export_bytes: null }; }
  }
  close(): void { if (!this.closed) { this.database.close(); this.closed = true; } }
}
