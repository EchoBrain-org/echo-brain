import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import {
  EXTRACTION_ATTEMPT_FAILURE_CODES_V1,
  type ExtractionAttemptBindingV1,
  type ExtractionAttemptCompletionV1,
  type ExtractionAttemptInspectionV1,
  type ExtractionAttemptKeyV1,
  type ExtractionAttemptLatestV1,
  type ExtractionAttemptOutcomeV1,
  type ExtractionAttemptReservationV1,
  type ExtractionAttemptSnapshotV1,
  type ExtractionAttemptStoreV1,
} from '../../admitted-meeting-processing/extraction-attempt-store-v1.js';

export const EXTRACTION_ATTEMPT_STORE_APPLICATION_ID_V1 = 0x45454154; // EEAT
export const EXTRACTION_ATTEMPT_STORE_SCHEMA_VERSION_V1 = 1;

const KEY_WHERE = 'admission_sha256 = ? AND review_lineage_id = ? AND review_input_sha256 = ?';
const MAX_ATTEMPT = 2_147_483_647;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LINEAGE = /^rli_[0-9a-f]{64}$/;
const CLAIM = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FAILURE_CODES = new Set<string>(EXTRACTION_ATTEMPT_FAILURE_CODES_V1);
/** Frozen V1 schema: changes require an explicit new sidecar schema version. */
const SCHEMA = `
  CREATE TABLE extraction_binding_v1 (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    authority_id TEXT NOT NULL, organization_id TEXT NOT NULL, state_lineage_id TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER extraction_binding_immutable_v1 BEFORE UPDATE ON extraction_binding_v1
    BEGIN SELECT RAISE(ABORT, 'extraction binding is immutable'); END;
  CREATE TRIGGER extraction_binding_delete_denied_v1 BEFORE DELETE ON extraction_binding_v1
    BEGIN SELECT RAISE(ABORT, 'extraction binding deletion is denied'); END;
  CREATE TABLE extraction_attempts_v1 (
    admission_sha256 TEXT NOT NULL, review_lineage_id TEXT NOT NULL, review_input_sha256 TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1 AND attempt <= ${MAX_ATTEMPT}),
    claim_id TEXT NOT NULL UNIQUE,
    outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'succeeded', 'failed')),
    failure_code TEXT CHECK (failure_code IN (${EXTRACTION_ATTEMPT_FAILURE_CODES_V1.map(code => `'${code}'`).join(',')})),
    reserved_at TEXT NOT NULL, completed_at TEXT,
    PRIMARY KEY (admission_sha256, review_lineage_id, review_input_sha256, attempt),
    CHECK ((outcome = 'pending' AND failure_code IS NULL AND completed_at IS NULL)
      OR (outcome = 'succeeded' AND failure_code IS NULL AND completed_at IS NOT NULL)
      OR (outcome = 'failed' AND failure_code IS NOT NULL AND completed_at IS NOT NULL))
  ) STRICT;
  CREATE TRIGGER extraction_attempt_delete_denied_v1 BEFORE DELETE ON extraction_attempts_v1
    BEGIN SELECT RAISE(ABORT, 'extraction attempt deletion is denied'); END;
  CREATE TRIGGER extraction_attempt_update_fence_v1 BEFORE UPDATE ON extraction_attempts_v1
    WHEN OLD.outcome <> 'pending' OR NEW.outcome = 'pending'
      OR OLD.admission_sha256 <> NEW.admission_sha256 OR OLD.review_lineage_id <> NEW.review_lineage_id
      OR OLD.review_input_sha256 <> NEW.review_input_sha256 OR OLD.attempt <> NEW.attempt
      OR OLD.claim_id <> NEW.claim_id OR OLD.reserved_at <> NEW.reserved_at
    BEGIN SELECT RAISE(ABORT, 'extraction attempt update is invalid'); END;
  CREATE TABLE extraction_retry_permissions_v1 (
    admission_sha256 TEXT NOT NULL, review_lineage_id TEXT NOT NULL, review_input_sha256 TEXT NOT NULL,
    after_attempt INTEGER NOT NULL, expected_outcome TEXT NOT NULL CHECK (expected_outcome IN ('pending', 'succeeded', 'failed')),
    recover_pending INTEGER NOT NULL CHECK (recover_pending IN (0, 1)), authorized_at TEXT NOT NULL,
    PRIMARY KEY (admission_sha256, review_lineage_id, review_input_sha256, after_attempt),
    FOREIGN KEY (admission_sha256, review_lineage_id, review_input_sha256, after_attempt)
      REFERENCES extraction_attempts_v1(admission_sha256, review_lineage_id, review_input_sha256, attempt),
    CHECK (expected_outcome <> 'pending' OR recover_pending = 1)
  ) STRICT;
  CREATE TRIGGER extraction_retry_permission_update_denied_v1 BEFORE UPDATE ON extraction_retry_permissions_v1
    BEGIN SELECT RAISE(ABORT, 'extraction retry permission is immutable'); END;
  CREATE TRIGGER extraction_retry_permission_delete_denied_v1 BEFORE DELETE ON extraction_retry_permissions_v1
    BEGIN SELECT RAISE(ABORT, 'extraction retry permission deletion is denied'); END;
`;
function invalid(): never { throw new Error('Extraction attempt state is invalid'); }
function assertBinding(binding: ExtractionAttemptBindingV1): void {
  for (const value of [binding.authority_id, binding.organization_id, binding.state_lineage_id]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  }
}
function keyValues(key: ExtractionAttemptKeyV1): [string, string, string] {
  if (!DIGEST.test(key.admission_sha256) || !LINEAGE.test(key.review_lineage_id) || !DIGEST.test(key.review_input_sha256)) invalid();
  return [key.admission_sha256, key.review_lineage_id, key.review_input_sha256];
}
function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPT) invalid();
}
function isOutcome(value: unknown): value is ExtractionAttemptOutcomeV1 {
  return value === 'pending' || value === 'succeeded' || value === 'failed';
}
function snapshot(row: ExtractionAttemptSnapshotV1): ExtractionAttemptSnapshotV1 {
  assertAttempt(row.attempt);
  if (!isOutcome(row.outcome) || (row.outcome === 'failed'
    ? row.failure_code === null || !FAILURE_CODES.has(row.failure_code)
    : row.failure_code !== null)) invalid();
  for (const value of [row.reserved_at, ...(row.completed_at === null ? [] : [row.completed_at])]) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  }
  if ((row.outcome === 'pending') !== (row.completed_at === null)) invalid();
  return Object.freeze({ attempt: row.attempt, outcome: row.outcome, failure_code: row.failure_code,
    reserved_at: row.reserved_at, completed_at: row.completed_at });
}

function initialize(database: Database.Database, binding: ExtractionAttemptBindingV1): void {
  if (database.inTransaction) invalid();
  database.transaction(() => {
    const version = database.pragma('user_version', { simple: true });
    const application = database.pragma('application_id', { simple: true });
    if (version === 0 && application === 0) {
      const { count } = database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { count: number };
      if (count !== 0) invalid();
      database.exec(SCHEMA);
      database.prepare('INSERT INTO extraction_binding_v1 VALUES (1, ?, ?, ?)').run(binding.authority_id, binding.organization_id, binding.state_lineage_id);
      database.pragma(`application_id = ${EXTRACTION_ATTEMPT_STORE_APPLICATION_ID_V1}`);
      database.pragma(`user_version = ${EXTRACTION_ATTEMPT_STORE_SCHEMA_VERSION_V1}`);
    } else if (version !== EXTRACTION_ATTEMPT_STORE_SCHEMA_VERSION_V1 || application !== EXTRACTION_ATTEMPT_STORE_APPLICATION_ID_V1) invalid();
    const rows = database.prepare('SELECT authority_id, organization_id, state_lineage_id FROM extraction_binding_v1').all() as ExtractionAttemptBindingV1[];
    if (rows.length !== 1 || rows[0]?.authority_id !== binding.authority_id || rows[0]?.organization_id !== binding.organization_id || rows[0]?.state_lineage_id !== binding.state_lineage_id) invalid();
    database.prepare('SELECT 1 FROM extraction_attempts_v1, extraction_retry_permissions_v1 LIMIT 0').all();
    if (database.pragma('integrity_check', { simple: true }) !== 'ok' || (database.pragma('foreign_key_check') as readonly unknown[]).length !== 0) invalid();
  }).immediate();
}

/** Durable spend controls. This file must be retained with Authority state, never treated as disposable telemetry. */
export class SqliteExtractionAttemptStoreV1 implements ExtractionAttemptStoreV1 {
  private closed = false;
  constructor(private readonly database: Database.Database, binding: ExtractionAttemptBindingV1) {
    assertBinding(binding);
    initialize(database, binding);
  }

  private latest(key: ExtractionAttemptKeyV1): ExtractionAttemptSnapshotV1 | undefined {
    const row = this.database.prepare(`SELECT attempt, outcome, failure_code, reserved_at, completed_at
      FROM extraction_attempts_v1 WHERE ${KEY_WHERE} ORDER BY attempt DESC LIMIT 1`).get(...keyValues(key)) as ExtractionAttemptSnapshotV1 | undefined;
    return row === undefined ? undefined : snapshot(row);
  }

  private permitted(key: ExtractionAttemptKeyV1, attempt: number): boolean {
    return this.database.prepare(`SELECT 1 FROM extraction_retry_permissions_v1 WHERE ${KEY_WHERE} AND after_attempt = ?`).get(...keyValues(key), attempt) !== undefined;
  }

  inspect(key: ExtractionAttemptKeyV1): ExtractionAttemptInspectionV1 | undefined {
    return this.database.transaction(() => {
      const latest = this.latest(key);
      if (latest === undefined) return undefined;
      const { completed_at: _completedAt, ...inspection } = latest;
      return Object.freeze({ ...inspection, retry_authorized: this.permitted(key, latest.attempt) });
    })();
  }

  reserve(key: ExtractionAttemptKeyV1): ExtractionAttemptReservationV1 {
    const values = keyValues(key);
    if (this.database.inTransaction) invalid();
    return this.database.transaction((): ExtractionAttemptReservationV1 => {
      const previous = this.latest(key);
      if (previous !== undefined) {
        if (!this.permitted(key, previous.attempt) || previous.attempt === MAX_ATTEMPT) return { status: 'blocked', attempt: previous.attempt, outcome: previous.outcome, failure_code: previous.failure_code, reserved_at: previous.reserved_at };
      }
      const attempt = (previous?.attempt ?? 0) + 1;
      const claim_id = randomUUID();
      this.database.prepare(`INSERT INTO extraction_attempts_v1
        (admission_sha256, review_lineage_id, review_input_sha256, attempt, claim_id, outcome, failure_code, reserved_at, completed_at)
        VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`).run(...values, attempt, claim_id, new Date().toISOString());
      return { status: 'reserved', attempt, claim_id };
    }).immediate();
  }

  complete(input: ExtractionAttemptCompletionV1): void {
    const values = keyValues(input.key);
    assertAttempt(input.attempt);
    if (!CLAIM.test(input.claim_id) || (input.outcome !== 'succeeded' && input.outcome !== 'failed') ||
      (input.outcome === 'failed' && !FAILURE_CODES.has(input.failure_code))) invalid();
    if (this.database.inTransaction) invalid();
    this.database.transaction(() => {
      const latest = this.latest(input.key);
      if (latest?.attempt !== input.attempt || latest.outcome !== 'pending') invalid();
      if (this.permitted(input.key, input.attempt)) invalid();
      const result = this.database.prepare(`UPDATE extraction_attempts_v1 SET outcome = ?, failure_code = ?, completed_at = ?
        WHERE ${KEY_WHERE} AND attempt = ? AND claim_id = ? AND outcome = 'pending'`).run(
        input.outcome, input.outcome === 'failed' ? input.failure_code : null, new Date().toISOString(), ...values, input.attempt, input.claim_id,
      );
      if (result.changes !== 1) invalid();
    }).immediate();
  }

  history(key: ExtractionAttemptKeyV1): readonly ExtractionAttemptSnapshotV1[] {
    const rows = this.database.prepare(`SELECT attempt, outcome, failure_code, reserved_at, completed_at
      FROM extraction_attempts_v1 WHERE ${KEY_WHERE} ORDER BY attempt`).all(...keyValues(key)) as ExtractionAttemptSnapshotV1[];
    return rows.map(snapshot);
  }

  /** Content-free bounded recovery status. Callers may request the full history of one exact key separately. */
  listLatest(limit = 100): readonly ExtractionAttemptLatestV1[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid();
    const rows = this.database.prepare(`SELECT a.*, EXISTS (SELECT 1 FROM extraction_retry_permissions_v1 p
        WHERE p.admission_sha256 = a.admission_sha256 AND p.review_lineage_id = a.review_lineage_id
          AND p.review_input_sha256 = a.review_input_sha256 AND p.after_attempt = a.attempt) AS retry_authorized
      FROM extraction_attempts_v1 a
      WHERE a.attempt = (SELECT MAX(b.attempt) FROM extraction_attempts_v1 b
        WHERE b.admission_sha256 = a.admission_sha256 AND b.review_lineage_id = a.review_lineage_id AND b.review_input_sha256 = a.review_input_sha256)
      ORDER BY a.reserved_at DESC, a.admission_sha256, a.review_lineage_id, a.review_input_sha256 LIMIT ?`).all(limit) as (ExtractionAttemptKeyV1 & ExtractionAttemptSnapshotV1 & { retry_authorized: number })[];
    return rows.map(row => {
      keyValues(row);
      return { admission_sha256: row.admission_sha256, review_lineage_id: row.review_lineage_id, review_input_sha256: row.review_input_sha256, ...snapshot(row), retry_authorized: row.retry_authorized === 1 };
    });
  }

  /**
   * An operator grant must hold the stopped/exclusive worker lane and verify no frozen candidate already exists.
   * The cycle grants only its own just-failed, unbilled first attempt, after both frozen-result checks.
   * `recover_pending` acknowledges interrupted provider work whose billing outcome is unknown; it never proves the old worker stopped.
   * A permission authorizes exactly one subsequent reservation and is retained as immutable recovery history.
   */
  authorizeRetry(input: {
    readonly key: ExtractionAttemptKeyV1;
    readonly expected_attempt: number;
    readonly expected_outcome: ExtractionAttemptOutcomeV1;
    readonly recover_pending?: boolean;
  }): 'authorized' | 'conflict' {
    const values = keyValues(input.key);
    assertAttempt(input.expected_attempt);
    if (!isOutcome(input.expected_outcome) || (input.recover_pending !== undefined && typeof input.recover_pending !== 'boolean')) invalid();
    if (this.database.inTransaction) invalid();
    return this.database.transaction(() => {
      const latest = this.latest(input.key);
      if (latest?.attempt !== input.expected_attempt || latest.outcome !== input.expected_outcome || latest.attempt === MAX_ATTEMPT ||
        (latest.outcome === 'pending' && input.recover_pending !== true)) return 'conflict';
      const result = this.database.prepare(`INSERT INTO extraction_retry_permissions_v1
        (admission_sha256, review_lineage_id, review_input_sha256, after_attempt, expected_outcome, recover_pending, authorized_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(...values, input.expected_attempt, input.expected_outcome, input.recover_pending === true ? 1 : 0, new Date().toISOString());
      return result.changes === 1 ? 'authorized' : 'conflict';
    }).immediate();
  }

  close(): void {
    if (!this.closed) { this.closed = true; this.database.close(); }
  }
}

/** Opens a separate durable file without changing the Authority V10 baseline or its six lineage roles. */
export function openExtractionAttemptStoreV1(path: string, binding: ExtractionAttemptBindingV1): SqliteExtractionAttemptStoreV1 {
  assertBinding(binding);
  if (!isAbsolute(path) || (existsSync(path) && lstatSync(path).nlink !== 1)) invalid();
  const database = openAuthorityDatabase(path);
  try { return new SqliteExtractionAttemptStoreV1(database, binding); }
  catch (error) { database.close(); throw error; }
}
