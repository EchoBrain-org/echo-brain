import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import type {
  OrganizationRecordLogRow,
  Sha256Digest,
} from '../application/contracts.js';
import {
  OrganizationRecordError,
  OrganizationRecordIdempotencyConflictError,
} from '../application/errors.js';
import {
  toOrganizationRecordLogRow as toLogRow,
  type RawOrganizationRecordLogRow as RawLogRow,
} from '../application/log-row.js';
import {
  organizationRecordFrame,
  organizationRecordHash,
  organizationRecordReceiptPayload,
} from '../application/record-frame.js';
import {
  systemOrganizationRecordClock,
  type OrganizationRecordClock,
  type OrganizationRecordLogAppendInput,
  type OrganizationRecordLogAppendOutcome,
  type OrganizationRecordLogPort,
} from '../application/ports.js';
import { ORGANIZATION_RECORD_LOG_DATABASE } from '../persistence/database-definition.js';
import { openOrganizationRecordDatabase } from '../persistence/open-database.js';
import { appendOrganizationPermissionPilotEligibility } from './permission-pilot.js';
import {
  assertCommittedReviewerPolicyFactsMatch,
  insertReviewerPolicyFacts,
  reviewerPolicyFactsForAppend,
} from './reviewer-policy-fact.js';
import {
  isReviewerRestrictedEnvelopeDocument,
  reviewerFactInvalid,
  reviewerFactUnavailable,
  type ReviewerRestrictedEnvelopeValidator,
} from '../application/reviewer-policy-fact.js';
import {
  isOrganizationMemberReadableEnvelopeDocument,
  organizationMemberFactInvalid,
  organizationMemberFactUnavailable,
  type OrganizationMemberReadableEnvelopeValidator,
} from '../application/organization-member-policy-fact.js';
import {
  assertCommittedOrganizationMemberPolicyFactsMatch,
  insertOrganizationMemberPolicyFacts,
  organizationMemberPolicyFactsForAppend,
} from './organization-member-policy-fact.js';

interface MetadataRow {
  organization_id: string;
  authority_id: string;
}

export interface OpenOrganizationRecordLogOptions {
  readonly organization_id: string;
  readonly authority_id: string;
  /**
   * The transaction's own record clock. It is the sole source of
   * `recorded_at`: no caller supplies one, and the value it returns is inside
   * the hashed record frame.
   */
  readonly clock?: OrganizationRecordClock;
  /**
   * The injected closed reviewer-v2 validator. Absent in a composition that
   * does not admit the reviewer slice; a reviewer-v2 document then fails
   * closed as unavailable and legacy append stays live.
   */
  readonly reviewer_validator?: ReviewerRestrictedEnvelopeValidator;
  /** The injected closed schema-v3 validator.  No validator means v3 is closed. */
  readonly organization_member_validator?: OrganizationMemberReadableEnvelopeValidator;
  /**
   * Test-only seam for proving append atomicity. It runs inside the open
   * transaction, immediately before `COMMIT`, so an injected failure must roll
   * the record and its facts back together.
   */
  readonly beforeAppendCommit?: () => void;
}

/**
 * The append-only log over `record-log.sqlite`.
 *
 * There is no update and no delete statement in this file. The log tail is the
 * single serialization point: one `BEGIN IMMEDIATE` append at a time, which
 * monotonic positions and the hash chain require anyway.
 */
export class OrganizationRecordLogStore implements OrganizationRecordLogPort {
  readonly organization_id: string;
  readonly authority_id: string;
  readonly database: Database.Database;
  private readonly clock: OrganizationRecordClock;
  private readonly reviewerValidator:
    | ReviewerRestrictedEnvelopeValidator
    | undefined;
  private readonly organizationMemberValidator:
    | OrganizationMemberReadableEnvelopeValidator
    | undefined;
  private readonly beforeAppendCommit: (() => void) | undefined;

  private constructor(
    database: Database.Database,
    options: OpenOrganizationRecordLogOptions,
  ) {
    this.database = database;
    this.organization_id = options.organization_id;
    this.authority_id = options.authority_id;
    this.clock = options.clock ?? systemOrganizationRecordClock;
    this.reviewerValidator = options.reviewer_validator;
    this.organizationMemberValidator = options.organization_member_validator;
    this.beforeAppendCommit = options.beforeAppendCommit;
  }

  static open(
    databasePath: string,
    options: OpenOrganizationRecordLogOptions,
  ): OrganizationRecordLogStore {
    const database = openOrganizationRecordDatabase(
      databasePath,
      ORGANIZATION_RECORD_LOG_DATABASE,
    );
    try {
      const store = new OrganizationRecordLogStore(database, options);
      store.bindOrganization();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** Binds this database file to one organization and authority, once. */
  private bindOrganization(): void {
    const existing = this.database
      .prepare(
        `SELECT organization_id, authority_id
         FROM organization_record_log_metadata
         WHERE singleton = 1`,
      )
      .get() as MetadataRow | undefined;
    if (existing === undefined) {
      this.database
        .prepare(
          `INSERT INTO organization_record_log_metadata (
             singleton, organization_id, authority_id, created_at
           ) VALUES (1, ?, ?, ?)`,
        )
        .run(this.organization_id, this.authority_id, this.clock());
      return;
    }
    if (
      existing.organization_id !== this.organization_id ||
      existing.authority_id !== this.authority_id
    ) {
      throw new Error(
        'organization record log belongs to a different organization or authority',
      );
    }
  }

  append(input: OrganizationRecordLogAppendInput): OrganizationRecordLogAppendOutcome {
    const { envelope, canonical_envelope, envelope_sha256 } = input;
    // The stored bytes and their digest are re-derived here rather than
    // trusted. The record hash commits `envelope_sha256`, and every later
    // reprojection re-parses `canonical_envelope`, so a caller whose three
    // values disagree would freeze a row whose hash does not describe the
    // bytes beneath it.
    if (
      canonical_envelope !== canonicalJson(envelope.envelope) ||
      envelope_sha256 !== sha256Digest(canonical_envelope)
    ) {
      throw new OrganizationRecordError(
        'log_invariant_violated',
        'organization record canonical envelope bytes do not bind their digest',
      );
    }
    // The reviewer path is selected by the exact `(kind, schema_version)` pair,
    // never by whether a caller happened to supply eligibility. A v2 document
    // without a live capability appends neither record nor facts, and its
    // duplicate cannot short-circuit to a receipt; a non-v2 document carrying
    // eligibility is invalid input rather than a reviewer append.
    const reviewerDocument = isReviewerRestrictedEnvelopeDocument(
      envelope.envelope,
    );
    const organizationMemberDocument = isOrganizationMemberReadableEnvelopeDocument(
      envelope.envelope,
    );
    if (reviewerDocument && input.reviewer_eligibility === undefined) {
      reviewerFactUnavailable(
        'reviewer-v2 append requires a live Authority-minted eligibility capability',
      );
    }
    if (!reviewerDocument && input.reviewer_eligibility !== undefined) {
      reviewerFactInvalid(
        'reviewer eligibility was presented for a non-reviewer envelope',
      );
    }
    if (organizationMemberDocument && input.organization_member_eligibility === undefined) {
      organizationMemberFactUnavailable(
        'schema-v3 append requires a live Authority-minted organization-member eligibility capability',
      );
    }
    if (!organizationMemberDocument && input.organization_member_eligibility !== undefined) {
      organizationMemberFactInvalid(
        'organization-member eligibility was presented for a non-schema-v3 envelope',
      );
    }
    if (
      (reviewerDocument && input.organization_member_eligibility !== undefined) ||
      (organizationMemberDocument && input.reviewer_eligibility !== undefined)
    ) {
      throw new OrganizationRecordError(
        'log_invariant_violated',
        'record append presented an eligibility capability for another policy family',
      );
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database
        .prepare(
          `SELECT * FROM organization_record_log
           WHERE installation_id = ? AND idempotency_key = ?`,
        )
        .get(envelope.installation_id, envelope.idempotency_key) as
        | RawLogRow
        | undefined;
      if (existing !== undefined) {
        // A matching duplicate returns the stored original unchanged; a known
        // key with a different envelope is permanent, never a retry.
        if (existing.envelope_sha256 !== envelope_sha256) {
          throw new OrganizationRecordIdempotencyConflictError({
            installation_id: envelope.installation_id,
            idempotency_key: envelope.idempotency_key,
            stored_envelope_sha256: existing.envelope_sha256,
            presented_envelope_sha256: envelope_sha256,
          });
        }
        // A schema-v2 duplicate may not take the landed receipt-recovery
        // shortcut: it reproves the freshly minted capability and compares the
        // complete committed fact set before returning the existing row.
        if (input.reviewer_eligibility !== undefined) {
          assertCommittedReviewerPolicyFactsMatch(
            this.database,
            {
              organization_id: this.organization_id,
              position: existing.position,
              record_hash: existing.record_hash as Sha256Digest,
              envelope: envelope.envelope,
              envelope_sha256,
              envelope_id: envelope.envelope_id,
              idempotency_key: envelope.idempotency_key,
              installation_id: envelope.installation_id,
              validate: this.reviewerValidator,
            },
            input.reviewer_eligibility,
          );
        }
        if (input.organization_member_eligibility !== undefined) {
          assertCommittedOrganizationMemberPolicyFactsMatch(
            this.database,
            {
              organization_id: this.organization_id,
              position: existing.position,
              record_hash: existing.record_hash as Sha256Digest,
              envelope: envelope.envelope,
              envelope_sha256,
              envelope_id: envelope.envelope_id,
              idempotency_key: envelope.idempotency_key,
              installation_id: envelope.installation_id,
              validate: this.organizationMemberValidator,
            },
            input.organization_member_eligibility,
          );
        }
        // A duplicate stamps no new record time: the committed row keeps the
        // one its own transaction sampled, and this path samples none.
        this.database.exec('COMMIT');
        return { outcome: 'duplicate', row: toLogRow(existing) };
      }

      // The one sample. It happens inside `BEGIN IMMEDIATE`, after the exact
      // duplicate check has already returned for every path that appends
      // nothing, so the value that enters the hashed frame belongs to the
      // transaction that allocates the position beside it.
      const recorded_at = this.clock();

      const head = this.database
        .prepare(
          `SELECT position, record_hash FROM organization_record_log
           ORDER BY position DESC LIMIT 1`,
        )
        .get() as { position: number; record_hash: string } | undefined;
      const position = (head?.position ?? 0) + 1;
      const previousRecordHash = (head?.record_hash ?? null) as Sha256Digest | null;
      const recordHash = organizationRecordHash(
        organizationRecordFrame({
          organization_id: this.organization_id,
          position,
          previous_record_hash: previousRecordHash,
          recorded_at,
          envelope_sha256,
        }),
      );
      const receiptPayload = canonicalJson(
        organizationRecordReceiptPayload({
          authority_id: this.authority_id,
          organization_id: this.organization_id,
          envelope_id: envelope.envelope_id,
          envelope_sha256,
          installation_id: envelope.installation_id,
          idempotency_key: envelope.idempotency_key,
          position,
          record_hash: recordHash,
          recorded_at,
        }),
      );
      this.database
        .prepare(
          `INSERT INTO organization_record_log (
             position, envelope_id, event_type, installation_id, idempotency_key,
             canonical_envelope, envelope_sha256, receipt_payload,
             previous_record_hash, record_hash, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          position,
          envelope.envelope_id,
          envelope.event_type,
          envelope.installation_id,
          envelope.idempotency_key,
          canonical_envelope,
          envelope_sha256,
          receiptPayload,
          previousRecordHash,
          recordHash,
          recorded_at,
        );
      appendOrganizationPermissionPilotEligibility(
        this.database,
        { position, record_hash: recordHash },
        envelope.permission_pilot_eligibility,
      );
      // The canonical record and every one of its reviewer facts commit in
      // this one transaction. The transaction alone allocated the position,
      // predecessor, and record hash, so no coordinator had to predict or
      // reserve one, and no external audit I/O happens under the write lock.
      // Any fact insert or invariant failure below rolls the record back with
      // the facts.
      if (input.reviewer_eligibility !== undefined) {
        insertReviewerPolicyFacts(
          this.database,
          reviewerPolicyFactsForAppend(
            {
              organization_id: this.organization_id,
              position,
              record_hash: recordHash,
              envelope: envelope.envelope,
              envelope_sha256,
              envelope_id: envelope.envelope_id,
              idempotency_key: envelope.idempotency_key,
              installation_id: envelope.installation_id,
              validate: this.reviewerValidator,
            },
            input.reviewer_eligibility,
          ),
        );
      }
      if (input.organization_member_eligibility !== undefined) {
        insertOrganizationMemberPolicyFacts(
          this.database,
          organizationMemberPolicyFactsForAppend(
            {
              organization_id: this.organization_id,
              position,
              record_hash: recordHash,
              envelope: envelope.envelope,
              envelope_sha256,
              envelope_id: envelope.envelope_id,
              idempotency_key: envelope.idempotency_key,
              installation_id: envelope.installation_id,
              validate: this.organizationMemberValidator,
            },
            input.organization_member_eligibility,
          ),
        );
      }
      this.beforeAppendCommit?.();
      this.database.exec('COMMIT');
      return {
        outcome: 'appended',
        row: {
          position,
          envelope_id: envelope.envelope_id,
          event_type: envelope.event_type,
          installation_id: envelope.installation_id,
          idempotency_key: envelope.idempotency_key,
          canonical_envelope,
          envelope_sha256,
          receipt_payload: receiptPayload,
          previous_record_hash: previousRecordHash,
          record_hash: recordHash,
          recorded_at,
        },
      };
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }

  findAcceptedRecord(
    installationId: string,
    idempotencyKey: string,
  ): OrganizationRecordLogRow | null {
    const row = this.database
      .prepare(
        `SELECT * FROM organization_record_log
         WHERE installation_id = ? AND idempotency_key = ?`,
      )
      .get(installationId, idempotencyKey) as RawLogRow | undefined;
    return row === undefined ? null : toLogRow(row);
  }

  readSignedReceipt(position: number): string | null {
    const row = this.database
      .prepare(
        `SELECT signed_receipt FROM organization_record_signed_receipt WHERE position = ?`,
      )
      .get(position) as { signed_receipt: string } | undefined;
    return row?.signed_receipt ?? null;
  }

  putSignedReceipt(
    position: number,
    signedReceipt: string,
    materializedAt: string,
  ): string {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO organization_record_signed_receipt (
           position, signed_receipt, materialized_at
         ) VALUES (?, ?, ?)`,
      )
      .run(position, signedReceipt, materializedAt);
    const stored = this.readSignedReceipt(position);
    if (stored === null) {
      throw new Error(
        `organization record signed receipt at position ${position} was not stored`,
      );
    }
    return stored;
  }

  rows(): readonly OrganizationRecordLogRow[] {
    return (
      this.database
        .prepare(`SELECT * FROM organization_record_log ORDER BY position`)
        .all() as RawLogRow[]
    ).map(toLogRow);
  }

  close(): void {
    this.database.close();
  }
}
