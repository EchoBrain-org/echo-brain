import { canonicalJson } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import type {
  OrganizationRecordLogRow,
  Sha256Digest,
} from '../application/contracts.js';
import { OrganizationRecordIdempotencyConflictError } from '../application/errors.js';
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

interface MetadataRow {
  organization_id: string;
  authority_id: string;
}

export interface OpenOrganizationRecordLogOptions {
  readonly organization_id: string;
  readonly authority_id: string;
  readonly clock?: OrganizationRecordClock;
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

  private constructor(
    database: Database.Database,
    options: OpenOrganizationRecordLogOptions,
  ) {
    this.database = database;
    this.organization_id = options.organization_id;
    this.authority_id = options.authority_id;
    this.clock = options.clock ?? systemOrganizationRecordClock;
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
    const { envelope, canonical_envelope, envelope_sha256, recorded_at } = input;
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
        this.database.exec('COMMIT');
        return { outcome: 'duplicate', row: toLogRow(existing) };
      }

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
