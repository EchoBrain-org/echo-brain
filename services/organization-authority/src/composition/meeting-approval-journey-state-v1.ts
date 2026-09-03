import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-authority-database.js";
import {
  createJourneyIdV1,
  parseJourneyIdV1,
  type JourneyIdV1,
  type JourneyStageV1,
} from "../shared/journey-telemetry-v1.js";

/** A disposable, separate file role. It is never an Authority state baseline. */
export const MEETING_APPROVAL_JOURNEY_STATE_SCHEMA_VERSION_V1 = 1 as const;
export const MEETING_APPROVAL_JOURNEY_STATE_APPLICATION_ID_V1 = 0x454a5354; // "EJST"
export const MEETING_APPROVAL_JOURNEY_STATE_MAX_ATTEMPTS_V1 = 100 as const;
export const MEETING_APPROVAL_JOURNEY_STAGE_RESULTS_V1 = ["succeeded", "failed"] as const;
export type MeetingApprovalJourneyStageResultV1 =
  (typeof MEETING_APPROVAL_JOURNEY_STAGE_RESULTS_V1)[number];

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MEETING_STAGES = new Set<JourneyStageV1>([
  "meeting_source_intake",
  "meeting_extraction",
  "meeting_candidate_persist",
  "meeting_approval_staging",
  "meeting_approval_action_verify",
  "meeting_approval_action_queue",
  "meeting_terminal_persist",
  "meeting_record_append",
  "meeting_search_publication",
]);

type StoredStageStatus = "open" | "closed" | "skipped";

interface JourneyRow {
  readonly journey_id: string;
  readonly last_sequence: number;
  readonly card_staged_at: string | null;
}

interface StageRow {
  readonly attempt: number;
  readonly status: StoredStageStatus;
  readonly result: MeetingApprovalJourneyStageResultV1 | null;
  readonly started_at: string | null;
  readonly closed_at: string | null;
}

interface AwaitingSearchRow {
  readonly journey_id: string;
  readonly marked_at: string;
}

export interface MeetingApprovalJourneyStateDependenciesV1 {
  /** Injected only for deterministic tests. Production uses random UUID v4s. */
  readonly create_uuid?: () => string;
}

/** Raw ingress values are accepted only to derive an internal, domain-separated SHA-256. */
export interface MeetingApprovalJourneySourceV1 {
  readonly source_identity: string;
  readonly source_revision: string;
}

export interface MeetingApprovalJourneyStartV1 {
  readonly journey_id: JourneyIdV1;
  readonly last_sequence: number;
  readonly created: boolean;
}

export interface MeetingApprovalJourneyReservationV1 {
  readonly sequence: number;
  readonly attempt: number;
}

export interface MeetingApprovalJourneyStageStatusV1 {
  readonly attempt: number;
  readonly status: StoredStageStatus;
  /** Failed attempts are closed but deliberately remain retryable. */
  readonly result: MeetingApprovalJourneyStageResultV1 | null;
  readonly started_at: string | null;
  readonly closed_at: string | null;
}

/**
 * An interrupted machine-stage attempt. These are reconciled by the
 * telemetry recorder at its next startup so a process restart cannot leave a
 * stage permanently open.
 */
export interface MeetingApprovalJourneyOpenStageV1 {
  readonly journey_id: JourneyIdV1;
  readonly stage: JourneyStageV1;
  readonly attempt: number;
  readonly started_at: string;
}

export interface MeetingApprovalJourneyForApprovalV1 {
  readonly journey_id: JourneyIdV1;
  readonly last_sequence: number;
  readonly card_staged_at: string | null;
  readonly approved_record_awaiting_search_at: string | null;
}

export interface MeetingApprovalJourneyAwaitingSearchV1 {
  readonly journey_id: JourneyIdV1;
  readonly marked_at: string;
}

function invalid(message: string): never {
  throw new TypeError(`invalid meeting approval journey state: ${message}`);
}

function canonicalTimestamp(value: unknown, name = "observed_at"): string {
  if (typeof value !== "string") invalid(`${name} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    invalid(`${name} is not canonical ISO UTC`);
  }
  return value;
}

function opaqueValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${name} is invalid`);
  return value;
}

function digest(namespace: string, values: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("echo-authority-meeting-approval-journey-state-v1\u0000");
  hash.update(namespace);
  for (const value of values) {
    hash.update("\u0000");
    hash.update(value);
  }
  return hash.digest("hex");
}

function sourceDigest(input: MeetingApprovalJourneySourceV1): string {
  return digest("source", [
    opaqueValue(input.source_identity, "source_identity"),
    opaqueValue(input.source_revision, "source_revision"),
  ]);
}

function candidateDigest(candidateId: string): string {
  return digest("candidate", [opaqueValue(candidateId, "candidate_id")]);
}

function approvalDigest(approvalId: string): string {
  return digest("approval", [opaqueValue(approvalId, "approval_id")]);
}

function journeyId(value: string): JourneyIdV1 {
  const parsed = parseJourneyIdV1(value);
  if (parsed === null) invalid("journey_id is not a UUID v4");
  return parsed;
}

function meetingStage(value: JourneyStageV1): JourneyStageV1 {
  if (!MEETING_STAGES.has(value)) invalid("stage is not a meeting approval stage");
  return value;
}

function stageResult(value: MeetingApprovalJourneyStageResultV1): MeetingApprovalJourneyStageResultV1 {
  if (value !== "succeeded" && value !== "failed") invalid("stage result is invalid");
  return value;
}

function assertSafeSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new Error("meeting approval journey state has an invalid last sequence");
  }
  return value;
}

function assertSafeAttempt(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== "number" ||
    value < 1 ||
    value > MEETING_APPROVAL_JOURNEY_STATE_MAX_ATTEMPTS_V1
  ) {
    throw new Error("meeting approval journey state has an invalid attempt");
  }
  return value;
}

function initializeSchema(database: Database.Database): void {
  const userVersion = database.pragma("user_version", { simple: true }) as number;
  const applicationId = database.pragma("application_id", { simple: true }) as number;
  if (userVersion === MEETING_APPROVAL_JOURNEY_STATE_SCHEMA_VERSION_V1) {
    if (applicationId !== MEETING_APPROVAL_JOURNEY_STATE_APPLICATION_ID_V1) {
      throw new Error("meeting approval journey state has an unexpected application ID");
    }
    return;
  }
  if (userVersion !== 0 || applicationId !== 0) {
    throw new Error("meeting approval journey state has an unsupported schema version");
  }
  const schemaObjectCount = database
    .prepare(
      `SELECT COUNT(*) AS count
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
          AND type IN ('table', 'index', 'trigger', 'view')`,
    )
    .get() as { readonly count: number };
  if (schemaObjectCount.count !== 0) {
    throw new Error("meeting approval journey state must be an empty SQLite file");
  }
  database.transaction(() => {
    database.exec(`
      CREATE TABLE meeting_approval_journeys_v1 (
        journey_id TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL,
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        card_staged_at TEXT NULL
      ) STRICT;

      CREATE TABLE meeting_approval_source_mappings_v1 (
        source_sha256 TEXT PRIMARY KEY NOT NULL CHECK (length(source_sha256) = 64),
        journey_id TEXT NOT NULL REFERENCES meeting_approval_journeys_v1(journey_id)
      ) STRICT;

      CREATE TABLE meeting_approval_candidate_mappings_v1 (
        candidate_sha256 TEXT PRIMARY KEY NOT NULL CHECK (length(candidate_sha256) = 64),
        journey_id TEXT NOT NULL REFERENCES meeting_approval_journeys_v1(journey_id),
        approval_sha256 TEXT NULL UNIQUE CHECK (approval_sha256 IS NULL OR length(approval_sha256) = 64)
      ) STRICT;

      CREATE TABLE meeting_approval_stage_attempts_v1 (
        journey_id TEXT NOT NULL REFERENCES meeting_approval_journeys_v1(journey_id),
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt >= 1 AND attempt <= 100),
        status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'skipped')),
        result TEXT NULL CHECK (result IS NULL OR result IN ('succeeded', 'failed')),
        started_at TEXT NULL,
        closed_at TEXT NULL,
        start_sequence INTEGER NULL CHECK (start_sequence IS NULL OR start_sequence >= 1),
        close_sequence INTEGER NULL CHECK (close_sequence IS NULL OR close_sequence >= 1),
        PRIMARY KEY (journey_id, stage, attempt),
        CHECK (
          (status = 'open' AND result IS NULL AND started_at IS NOT NULL AND closed_at IS NULL
             AND start_sequence IS NOT NULL AND close_sequence IS NULL)
          OR
          (status = 'closed' AND result IN ('succeeded', 'failed')
             AND started_at IS NOT NULL AND closed_at IS NOT NULL
             AND start_sequence IS NOT NULL AND close_sequence IS NOT NULL)
          OR
          (status = 'skipped' AND result IS NULL AND started_at IS NOT NULL AND closed_at IS NOT NULL
             AND start_sequence IS NULL AND close_sequence IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX meeting_approval_stage_attempts_latest_v1
        ON meeting_approval_stage_attempts_v1 (journey_id, stage, attempt DESC);

      CREATE TABLE meeting_approval_awaiting_search_v1 (
        journey_id TEXT PRIMARY KEY NOT NULL REFERENCES meeting_approval_journeys_v1(journey_id),
        marked_at TEXT NOT NULL,
        completed_at TEXT NULL
      ) STRICT;

      CREATE INDEX meeting_approval_awaiting_search_pending_v1
        ON meeting_approval_awaiting_search_v1 (marked_at)
        WHERE completed_at IS NULL;
    `);
    database.pragma(`application_id = ${MEETING_APPROVAL_JOURNEY_STATE_APPLICATION_ID_V1}`);
    database.pragma(`user_version = ${MEETING_APPROVAL_JOURNEY_STATE_SCHEMA_VERSION_V1}`);
  })();
}

/**
 * A deliberately disposable correlation sidecar. It stores no Authority IDs,
 * source IDs, candidate IDs, approval IDs, content, prompts, or metadata.
 */
export class MeetingApprovalJourneyStateV1 {
  private readonly createUuid: () => string;

  constructor(
    private readonly database: Database.Database,
    dependencies: MeetingApprovalJourneyStateDependenciesV1 = {},
  ) {
    initializeSchema(database);
    this.createUuid = dependencies.create_uuid ?? randomUUID;
  }

  beginOrResumeSource(input: MeetingApprovalJourneySourceV1): MeetingApprovalJourneyStartV1 {
    const sourceSha256 = sourceDigest(input);
    return this.database.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT journey_id, last_sequence, card_staged_at
             FROM meeting_approval_source_mappings_v1 AS mapping
             JOIN meeting_approval_journeys_v1 AS journey USING (journey_id)
            WHERE source_sha256 = ?`,
        )
        .get(sourceSha256) as JourneyRow | undefined;
      if (existing !== undefined) {
        const id = journeyId(existing.journey_id);
        return Object.freeze({
          journey_id: id,
          last_sequence: assertSafeSequence(existing.last_sequence),
          created: false,
        });
      }
      const id = createJourneyIdV1(this.createUuid);
      this.database
        .prepare(
          `INSERT INTO meeting_approval_journeys_v1 (journey_id, created_at, last_sequence)
           VALUES (?, ?, 0)`,
        )
        .run(id, new Date().toISOString());
      this.database
        .prepare(
          `INSERT INTO meeting_approval_source_mappings_v1 (source_sha256, journey_id)
           VALUES (?, ?)`,
        )
        .run(sourceSha256, id);
      return Object.freeze({ journey_id: id, last_sequence: 0, created: true });
    })();
  }

  bindCandidate(journeyIdValue: string, candidateId: string, approvalId: string | null): void {
    const id = journeyId(journeyIdValue);
    const candidateSha256 = candidateDigest(candidateId);
    const approvalSha256 = approvalId === null ? null : approvalDigest(approvalId);
    this.database.transaction(() => {
      this.requireJourney(id);
      const existing = this.database
        .prepare(
          `SELECT journey_id, approval_sha256
             FROM meeting_approval_candidate_mappings_v1
            WHERE candidate_sha256 = ?`,
        )
        .get(candidateSha256) as
        | { readonly journey_id: string; readonly approval_sha256: string | null }
        | undefined;
      if (existing === undefined) {
        if (approvalSha256 !== null) this.assertApprovalUnbound(approvalSha256, id);
        this.database
          .prepare(
            `INSERT INTO meeting_approval_candidate_mappings_v1
               (candidate_sha256, journey_id, approval_sha256)
             VALUES (?, ?, ?)`,
          )
          .run(candidateSha256, id, approvalSha256);
        return;
      }
      if (existing.journey_id !== id) {
        throw new Error("candidate is already bound to a different journey");
      }
      if (existing.approval_sha256 === approvalSha256) return;
      if (existing.approval_sha256 !== null || approvalSha256 === null) {
        throw new Error("candidate has a conflicting approval binding");
      }
      this.assertApprovalUnbound(approvalSha256, id);
      this.database
        .prepare(
          `UPDATE meeting_approval_candidate_mappings_v1
              SET approval_sha256 = ?
            WHERE candidate_sha256 = ?`,
        )
        .run(approvalSha256, candidateSha256);
    })();
  }

  readForApproval(approvalId: string): MeetingApprovalJourneyForApprovalV1 | null {
    const approvalSha256 = approvalDigest(approvalId);
    const row = this.database
      .prepare(
        `SELECT journey.journey_id, journey.last_sequence, journey.card_staged_at,
                awaiting.marked_at AS approved_record_awaiting_search_at
           FROM meeting_approval_candidate_mappings_v1 AS mapping
           JOIN meeting_approval_journeys_v1 AS journey USING (journey_id)
           LEFT JOIN meeting_approval_awaiting_search_v1 AS awaiting
             ON awaiting.journey_id = journey.journey_id
            AND awaiting.completed_at IS NULL
          WHERE mapping.approval_sha256 = ?`,
      )
      .get(approvalSha256) as
      | (JourneyRow & { readonly approved_record_awaiting_search_at: string | null })
      | undefined;
    if (row === undefined) return null;
    return Object.freeze({
      journey_id: journeyId(row.journey_id),
      last_sequence: assertSafeSequence(row.last_sequence),
      card_staged_at: row.card_staged_at === null ? null : canonicalTimestamp(row.card_staged_at, "card_staged_at"),
      approved_record_awaiting_search_at:
        row.approved_record_awaiting_search_at === null
          ? null
          : canonicalTimestamp(row.approved_record_awaiting_search_at, "approved_record_awaiting_search_at"),
    });
  }

  reserveStageStart(
    journeyIdValue: string,
    stageValue: JourneyStageV1,
    observedAtValue: string,
  ): MeetingApprovalJourneyReservationV1 {
    const id = journeyId(journeyIdValue);
    const stage = meetingStage(stageValue);
    const observedAt = canonicalTimestamp(observedAtValue);
    return this.database.transaction(() => {
      this.requireJourney(id);
      const previous = this.latestStage(id, stage);
      if (previous?.status === "open") throw new Error("stage already has an open attempt");
      const attempt = this.nextAttempt(previous?.attempt);
      const sequence = this.nextSequence(id);
      this.database
        .prepare(
          `INSERT INTO meeting_approval_stage_attempts_v1
             (journey_id, stage, attempt, status, started_at, start_sequence)
           VALUES (?, ?, ?, 'open', ?, ?)`,
        )
        .run(id, stage, attempt, observedAt, sequence);
      return Object.freeze({ sequence, attempt });
    })();
  }

  reserveStageClose(
    journeyIdValue: string,
    stageValue: JourneyStageV1,
    attemptValue: number,
    resultValue: MeetingApprovalJourneyStageResultV1,
    observedAtValue: string,
  ): { readonly sequence: number } {
    const id = journeyId(journeyIdValue);
    const stage = meetingStage(stageValue);
    const attempt = assertSafeAttempt(attemptValue);
    const result = stageResult(resultValue);
    const observedAt = canonicalTimestamp(observedAtValue);
    return this.database.transaction(() => {
      this.requireJourney(id);
      const current = this.database
        .prepare(
          `SELECT attempt, status, result, started_at, closed_at
             FROM meeting_approval_stage_attempts_v1
            WHERE journey_id = ? AND stage = ? AND attempt = ?`,
        )
        .get(id, stage, attempt) as StageRow | undefined;
      if (current?.status !== "open" || current.started_at === null) {
        throw new Error("stage attempt is not open");
      }
      if (observedAt < canonicalTimestamp(current.started_at, "started_at")) {
        throw new Error("stage close precedes its start");
      }
      const sequence = this.nextSequence(id);
      this.database
        .prepare(
          `UPDATE meeting_approval_stage_attempts_v1
              SET status = 'closed', result = ?, closed_at = ?, close_sequence = ?
            WHERE journey_id = ? AND stage = ? AND attempt = ? AND status = 'open'`,
        )
        .run(result, observedAt, sequence, id, stage, attempt);
      return Object.freeze({ sequence });
    })();
  }

  reserveStageSkip(
    journeyIdValue: string,
    stageValue: JourneyStageV1,
    observedAtValue: string,
  ): MeetingApprovalJourneyReservationV1 {
    const id = journeyId(journeyIdValue);
    const stage = meetingStage(stageValue);
    const observedAt = canonicalTimestamp(observedAtValue);
    return this.database.transaction(() => {
      this.requireJourney(id);
      const previous = this.latestStage(id, stage);
      if (previous?.status === "open") throw new Error("stage already has an open attempt");
      const attempt = this.nextAttempt(previous?.attempt);
      const sequence = this.nextSequence(id);
      this.database
        .prepare(
          `INSERT INTO meeting_approval_stage_attempts_v1
             (journey_id, stage, attempt, status, started_at, closed_at, close_sequence)
           VALUES (?, ?, ?, 'skipped', ?, ?, ?)`,
        )
        .run(id, stage, attempt, observedAt, observedAt, sequence);
      return Object.freeze({ sequence, attempt });
    })();
  }

  readLatestStage(
    journeyIdValue: string,
    stageValue: JourneyStageV1,
  ): MeetingApprovalJourneyStageStatusV1 | null {
    const id = journeyId(journeyIdValue);
    const row = this.latestStage(id, meetingStage(stageValue));
    if (row === undefined) return null;
    return Object.freeze({
      attempt: assertSafeAttempt(row.attempt),
      status: row.status,
      result: row.result,
      started_at: row.started_at === null ? null : canonicalTimestamp(row.started_at, "started_at"),
      closed_at: row.closed_at === null ? null : canonicalTimestamp(row.closed_at, "closed_at"),
    });
  }

  listOpenStages(): readonly MeetingApprovalJourneyOpenStageV1[] {
    const rows = this.database
      .prepare(
        `SELECT journey_id, stage, attempt, started_at
           FROM meeting_approval_stage_attempts_v1
          WHERE status = 'open'
          ORDER BY started_at ASC, journey_id ASC, stage ASC, attempt ASC`,
      )
      .all() as ReadonlyArray<{
      readonly journey_id: string;
      readonly stage: JourneyStageV1;
      readonly attempt: number;
      readonly started_at: string;
    }>;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          journey_id: journeyId(row.journey_id),
          stage: meetingStage(row.stage),
          attempt: assertSafeAttempt(row.attempt),
          started_at: canonicalTimestamp(row.started_at, "started_at"),
        }),
      ),
    );
  }

  stageClosed(journeyIdValue: string, stageValue: JourneyStageV1): boolean {
    const latest = this.readLatestStage(journeyIdValue, stageValue);
    return latest?.status === "skipped" || latest?.result === "succeeded";
  }

  markCardStaged(journeyIdValue: string, observedAtValue: string): string {
    const id = journeyId(journeyIdValue);
    const observedAt = canonicalTimestamp(observedAtValue);
    return this.database.transaction(() => {
      const current = this.requireJourney(id);
      if (current.card_staged_at !== null) {
        return canonicalTimestamp(current.card_staged_at, "card_staged_at");
      }
      this.database
        .prepare(
          `UPDATE meeting_approval_journeys_v1
              SET card_staged_at = ?
            WHERE journey_id = ? AND card_staged_at IS NULL`,
        )
        .run(observedAt, id);
      return observedAt;
    })();
  }

  readCardStagedAt(journeyIdValue: string): string | null {
    const current = this.requireJourney(journeyId(journeyIdValue));
    return current.card_staged_at === null
      ? null
      : canonicalTimestamp(current.card_staged_at, "card_staged_at");
  }

  markApprovedRecordAwaitingSearch(journeyIdValue: string, observedAtValue: string): string {
    const id = journeyId(journeyIdValue);
    const observedAt = canonicalTimestamp(observedAtValue);
    return this.database.transaction(() => {
      this.requireJourney(id);
      const existing = this.database
        .prepare(
          `SELECT marked_at, completed_at
             FROM meeting_approval_awaiting_search_v1
            WHERE journey_id = ?`,
        )
        .get(id) as { readonly marked_at: string; readonly completed_at: string | null } | undefined;
      if (existing?.completed_at === null) return canonicalTimestamp(existing.marked_at, "marked_at");
      if (existing !== undefined) throw new Error("approved record search publication is already complete");
      this.database
        .prepare(
          `INSERT INTO meeting_approval_awaiting_search_v1 (journey_id, marked_at)
           VALUES (?, ?)`,
        )
        .run(id, observedAt);
      return observedAt;
    })();
  }

  listApprovedRecordsAwaitingSearch(): readonly MeetingApprovalJourneyAwaitingSearchV1[] {
    const rows = this.database
      .prepare(
        `SELECT journey_id, marked_at
           FROM meeting_approval_awaiting_search_v1
          WHERE completed_at IS NULL
          ORDER BY marked_at ASC, journey_id ASC`,
      )
      .all() as readonly AwaitingSearchRow[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          journey_id: journeyId(row.journey_id),
          marked_at: canonicalTimestamp(row.marked_at, "marked_at"),
        }),
      ),
    );
  }

  completeApprovedRecordSearch(journeyIdValue: string, observedAtValue: string): boolean {
    const id = journeyId(journeyIdValue);
    const observedAt = canonicalTimestamp(observedAtValue);
    return this.database.transaction(() => {
      this.requireJourney(id);
      const result = this.database
        .prepare(
          `UPDATE meeting_approval_awaiting_search_v1
              SET completed_at = ?
            WHERE journey_id = ? AND completed_at IS NULL`,
        )
        .run(observedAt, id);
      return result.changes === 1;
    })();
  }

  close(): void {
    this.database.close();
  }

  private requireJourney(id: JourneyIdV1): JourneyRow {
    const row = this.database
      .prepare(
        `SELECT journey_id, last_sequence, card_staged_at
           FROM meeting_approval_journeys_v1
          WHERE journey_id = ?`,
      )
      .get(id) as JourneyRow | undefined;
    if (row === undefined) throw new Error("journey is not known");
    assertSafeSequence(row.last_sequence);
    if (row.card_staged_at !== null) canonicalTimestamp(row.card_staged_at, "card_staged_at");
    return row;
  }

  private latestStage(id: JourneyIdV1, stage: JourneyStageV1): StageRow | undefined {
    const row = this.database
      .prepare(
        `SELECT attempt, status, result, started_at, closed_at
           FROM meeting_approval_stage_attempts_v1
          WHERE journey_id = ? AND stage = ?
          ORDER BY attempt DESC
          LIMIT 1`,
      )
      .get(id, stage) as StageRow | undefined;
    if (row !== undefined) {
      assertSafeAttempt(row.attempt);
      if (row.status !== "open" && row.status !== "closed" && row.status !== "skipped") {
        throw new Error("meeting approval journey state has an invalid stage status");
      }
      if (row.result !== null && row.result !== "succeeded" && row.result !== "failed") {
        throw new Error("meeting approval journey state has an invalid stage result");
      }
    }
    return row;
  }

  private nextSequence(id: JourneyIdV1): number {
    const current = assertSafeSequence(this.requireJourney(id).last_sequence);
    if (current >= MAX_SEQUENCE) throw new Error("journey sequence limit reached");
    const sequence = current + 1;
    this.database
      .prepare(
        `UPDATE meeting_approval_journeys_v1
            SET last_sequence = ?
          WHERE journey_id = ? AND last_sequence = ?`,
      )
      .run(sequence, id, current);
    return sequence;
  }

  private nextAttempt(previous: number | undefined): number {
    if (previous === undefined) return 1;
    const current = assertSafeAttempt(previous);
    if (current >= MEETING_APPROVAL_JOURNEY_STATE_MAX_ATTEMPTS_V1) {
      throw new Error("stage attempt limit reached");
    }
    return current + 1;
  }

  private assertApprovalUnbound(approvalSha256: string, id: JourneyIdV1): void {
    const existing = this.database
      .prepare(
        `SELECT journey_id
           FROM meeting_approval_candidate_mappings_v1
          WHERE approval_sha256 = ?`,
      )
      .get(approvalSha256) as { readonly journey_id: string } | undefined;
    if (existing !== undefined && existing.journey_id !== id) {
      throw new Error("approval is already bound to a different journey");
    }
  }
}

/** Opens or creates only a separate sidecar file. Existing Authority files are rejected. */
export function openMeetingApprovalJourneyStateV1(
  databasePath: string,
  dependencies: MeetingApprovalJourneyStateDependenciesV1 = {},
): MeetingApprovalJourneyStateV1 {
  const database = openAuthorityDatabase(databasePath);
  try {
    return new MeetingApprovalJourneyStateV1(database, dependencies);
  } catch (error) {
    database.close();
    throw error;
  }
}
