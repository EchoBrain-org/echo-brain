import type Database from "better-sqlite3";
import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import { granolaCursorPhase } from "../adapters/meeting-sources/granola/index.js";
import {
  assertCanonicalDecisionSet,
  assertCanonicalMeetingDocument,
  type DecisionSet,
  type MeetingDocument,
} from "../core/index.js";
import type {
  CleanGranolaSourceAdmissionV1,
  CleanLiveCandidateSnapshotInputV1,
  CleanLiveCandidateV1,
  CleanLiveOnlySourceStateV1,
} from "./live-only-source-cycle.js";

interface AdmissionRow {
  readonly source_instance_id: string;
  readonly source_adapter_version: string;
  readonly cursor: string;
  readonly cutoff_at: string;
  readonly processor_instance_id: string;
  readonly processor_adapter_version: string;
  readonly processor_configuration_sha256: string;
  readonly semantic_input_sha256: string;
  readonly membership_status: "active" | "revoked";
  readonly admitted_at: string;
}

interface ProgressRow {
  readonly cursor: string;
}

type CandidateRow = CleanLiveCandidateV1;

export interface CleanPostedApprovalCardV1 {
  readonly candidate_id: string;
  readonly provider_message_ts: string;
  readonly frozen_card_sha256: string;
  readonly approved_snapshot: Readonly<Record<string, unknown>>;
}

export interface CleanLiveApprovalOutboxV1 extends CleanLiveCandidateV1 {
  readonly provider_message_ts: string | null;
  readonly frozen_card_sha256: string | null;
  readonly approved_snapshot_json: string | null;
  readonly approved_snapshot_sha256: string | null;
  readonly control_approval_sha256: string | null;
}

export interface CleanFrozenCandidateForApprovalV1 extends CleanLiveApprovalOutboxV1 {
  readonly admission: CleanGranolaSourceAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
  readonly approved_snapshot: Readonly<Record<string, unknown>> | null;
}

export interface CleanV4ReceiptV1 {
  readonly approval_id: string;
  readonly control_approval_sha256: string;
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly receipt_sha256: string;
}

export class CleanLiveOnlySourceRevokedError extends Error {
  constructor() {
    super("clean live-only Granola source owner membership is revoked");
    this.name = "CleanLiveOnlySourceRevokedError";
  }
}

function assertCanonicalUtcMillis(value: string): void {
  if (new Date(value).toISOString() !== value) {
    throw new Error(
      "clean live-only source timestamp must be UTC milliseconds",
    );
  }
}

function assertLiveGranolaCursor(cursor: string): void {
  if (
    !cursor.startsWith("granola:v1:") ||
    granolaCursorPhase(cursor) !== "live"
  ) {
    throw new Error(
      "clean live-only source cursor must be a Granola v1 live cursor",
    );
  }
}

function admissionFrom(
  row: AdmissionRow,
  progress: ProgressRow,
): CleanGranolaSourceAdmissionV1 {
  assertCanonicalUtcMillis(row.cutoff_at);
  assertLiveGranolaCursor(progress.cursor);
  return Object.freeze({
    source: {
      adapter_id: "granola" as const,
      instance_id: row.source_instance_id,
      version: row.source_adapter_version,
      cursor: progress.cursor,
      cutoff_at: row.cutoff_at,
    },
    processor: {
      adapter_id: "llm" as const,
      instance_id: row.processor_instance_id,
      version: row.processor_adapter_version,
      configuration_sha256: row.processor_configuration_sha256,
    },
  });
}

/**
 * The concrete Authority cursor store for the clean source. Its first read
 * materializes a one-row progress checkpoint from the already immutable
 * admission. Subsequent advances compare the expected persisted cursor inside
 * one SQLite transaction, so no runner can overwrite a newer checkpoint.
 */
export class SqliteCleanLiveOnlySourceStateV1 implements CleanLiveOnlySourceStateV1 {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async readAdmission(): Promise<CleanGranolaSourceAdmissionV1> {
    return this.database.transaction(() => {
      const admission = this.admission();
      if (admission.membership_status !== "active") {
        throw new CleanLiveOnlySourceRevokedError();
      }
      this.database
        .prepare(
          `INSERT INTO authority_clean_granola_source_progress_v1 (
             singleton, admission_semantic_input_sha256, cursor,
             cursor_version, updated_at
           ) VALUES (1, ?, ?, 0, ?)
           ON CONFLICT (singleton) DO NOTHING`,
        )
        .run(
          admission.semantic_input_sha256,
          admission.cursor,
          admission.admitted_at,
        );
      const progress = this.database
        .prepare(
          `SELECT cursor
             FROM authority_clean_granola_source_progress_v1
            WHERE singleton = 1
              AND admission_semantic_input_sha256 = ?`,
        )
        .get(admission.semantic_input_sha256) as ProgressRow | undefined;
      if (progress === undefined) {
        throw new Error(
          "clean live-only source progress conflicts with its admission",
        );
      }
      return admissionFrom(admission, progress);
    })();
  }

  async stageCandidate(
    input: CleanLiveCandidateSnapshotInputV1,
  ): Promise<CleanLiveCandidateV1> {
    return this.database.transaction(() => {
      const admission = this.admission();
      if (admission.membership_status !== "active") {
        throw new CleanLiveOnlySourceRevokedError();
      }
      const progress = this.progress(admission.semantic_input_sha256);
      const current = admissionFrom(admission, progress);
      if (
        input.admission.source.cursor !== current.source.cursor ||
        input.admission.source.instance_id !== current.source.instance_id ||
        input.admission.processor.instance_id !==
          current.processor.instance_id ||
        input.admission.processor.configuration_sha256 !==
          current.processor.configuration_sha256
      ) {
        throw new Error(
          "clean live candidate differs from the current admitted source state",
        );
      }
      const meetingJson = canonicalJson(input.meeting);
      const decisionsJson = canonicalJson(input.decisions);
      const candidateSemanticSha256 = canonicalSha256({
        schema_version: 1,
        kind: "echo-clean-live-candidate-v1",
        admission: input.admission,
        meeting: input.meeting,
        decisions: input.decisions,
      });
      const candidateId = `cnd_${candidateSemanticSha256.slice("sha256:".length)}`;
      const approvalId = `apr_${candidateSemanticSha256.slice("sha256:".length)}`;
      const stageCommandId = `pas_${candidateSemanticSha256.slice("sha256:".length)}`;
      const existing = this.candidate(candidateSemanticSha256);
      if (existing !== undefined) return existing;

      const now = this.now();
      assertCanonicalUtcMillis(now);
      this.database
        .prepare(
          `INSERT INTO authority_clean_live_candidates_v1 (
             candidate_id, candidate_semantic_sha256,
             admission_semantic_input_sha256, source_cursor,
             meeting_sha256, meeting_json, decisions_sha256, decisions_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidateId,
          candidateSemanticSha256,
          admission.semantic_input_sha256,
          current.source.cursor,
          canonicalSha256(input.meeting),
          meetingJson,
          canonicalSha256(input.decisions),
          decisionsJson,
          now,
        );
      this.database
        .prepare(
          `INSERT INTO authority_clean_live_approval_outbox_v1 (
             candidate_id, approval_id, stage_command_id, state, updated_at
           ) VALUES (?, ?, ?, 'queued', ?)`,
        )
        .run(candidateId, approvalId, stageCommandId, now);
      return {
        candidate_id: candidateId,
        candidate_semantic_sha256: candidateSemanticSha256,
        approval_id: approvalId,
        stage_command_id: stageCommandId,
        state: "queued" as const,
      };
    })();
  }

  async advanceCursor(input: {
    readonly expected_cursor: string;
    readonly next_cursor: string;
  }): Promise<"advanced" | "state_drift" | "revoked"> {
    assertLiveGranolaCursor(input.expected_cursor);
    assertLiveGranolaCursor(input.next_cursor);
    if (input.next_cursor === input.expected_cursor) {
      throw new Error(
        "clean live-only source cursor advance must change the cursor",
      );
    }
    const updatedAt = this.now();
    assertCanonicalUtcMillis(updatedAt);
    return this.database.transaction(() => {
      const update = this.database
        .prepare(
          `UPDATE authority_clean_granola_source_progress_v1
              SET cursor = ?, cursor_version = cursor_version + 1, updated_at = ?
            WHERE singleton = 1
              AND cursor = ?
              AND EXISTS (
                SELECT 1
                  FROM authority_clean_granola_source_admission_v1 AS admission
                  JOIN authority_memberships AS membership
                    ON membership.membership_id = admission.membership_id
                   AND membership.organization_id = admission.organization_id
                   AND membership.principal_id = admission.principal_id
                   AND membership.membership_type = admission.membership_type
                 WHERE admission.semantic_input_sha256 =
                       authority_clean_granola_source_progress_v1.admission_semantic_input_sha256
                   AND membership.status = 'active'
              )`,
        )
        .run(input.next_cursor, updatedAt, input.expected_cursor);
      if (update.changes === 1) return "advanced" as const;

      const admission = this.admission();
      return admission.membership_status === "active"
        ? "state_drift"
        : "revoked";
    })();
  }

  readCandidateByApprovalId(
    approvalId: string,
  ): CleanLiveApprovalOutboxV1 | undefined {
    return this.database
      .prepare(
        `SELECT candidate.candidate_id, candidate.candidate_semantic_sha256,
                outbox.approval_id, outbox.stage_command_id, outbox.state,
                outbox.provider_message_ts, outbox.frozen_card_sha256,
                outbox.approved_snapshot_json, outbox.approved_snapshot_sha256,
                outbox.control_approval_sha256
           FROM authority_clean_live_candidates_v1 AS candidate
           JOIN authority_clean_live_approval_outbox_v1 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE outbox.approval_id = ?`,
      )
      .get(approvalId) as CleanLiveApprovalOutboxV1 | undefined;
  }

  /** Reproves the exact Authority snapshot which a D2 approval resolved. */
  readFrozenCandidateForApproval(
    approvalId: string,
  ): CleanFrozenCandidateForApprovalV1 | undefined {
    const row = this.database
      .prepare(
        `SELECT candidate.candidate_id, candidate.candidate_semantic_sha256,
                candidate.source_cursor, candidate.meeting_sha256,
                candidate.meeting_json, candidate.decisions_sha256,
                candidate.decisions_json,
                admission.source_instance_id, admission.source_adapter_version,
                admission.cutoff_at, admission.processor_instance_id,
                admission.processor_adapter_version,
                admission.processor_configuration_sha256,
                outbox.approval_id, outbox.stage_command_id, outbox.state,
                outbox.provider_message_ts, outbox.frozen_card_sha256,
                outbox.approved_snapshot_json, outbox.approved_snapshot_sha256,
                outbox.control_approval_sha256
           FROM authority_clean_live_candidates_v1 AS candidate
           JOIN authority_clean_granola_source_admission_v1 AS admission
             ON admission.semantic_input_sha256 = candidate.admission_semantic_input_sha256
           JOIN authority_clean_live_approval_outbox_v1 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE outbox.approval_id = ?`,
      )
      .get(approvalId) as
      | (CleanLiveApprovalOutboxV1 & {
          readonly source_cursor: string;
          readonly meeting_sha256: string;
          readonly meeting_json: string;
          readonly decisions_sha256: string;
          readonly decisions_json: string;
          readonly source_instance_id: string;
          readonly source_adapter_version: string;
          readonly cutoff_at: string;
          readonly processor_instance_id: string;
          readonly processor_adapter_version: string;
          readonly processor_configuration_sha256: string;
        })
      | undefined;
    if (row === undefined) return undefined;
    const meeting = JSON.parse(row.meeting_json) as MeetingDocument;
    const decisions = JSON.parse(row.decisions_json) as DecisionSet;
    const approvedSnapshot =
      row.approved_snapshot_json === null
        ? null
        : (JSON.parse(row.approved_snapshot_json) as Readonly<
            Record<string, unknown>
          >);
    if (
      canonicalJson(meeting) !== row.meeting_json ||
      canonicalSha256(meeting) !== row.meeting_sha256 ||
      canonicalJson(decisions) !== row.decisions_json ||
      canonicalSha256(decisions) !== row.decisions_sha256
    ) {
      throw new Error("clean frozen candidate snapshot digest is invalid");
    }
    if (
      (approvedSnapshot === null) !== (row.approved_snapshot_sha256 === null) ||
      (approvedSnapshot !== null &&
        canonicalSha256(approvedSnapshot) !== row.approved_snapshot_sha256)
    ) {
      throw new Error("clean frozen approved snapshot digest is invalid");
    }
    const admission: CleanGranolaSourceAdmissionV1 = {
      source: {
        adapter_id: "granola" as const,
        instance_id: row.source_instance_id,
        version: row.source_adapter_version,
        cursor: row.source_cursor,
        cutoff_at: row.cutoff_at,
      },
      processor: {
        adapter_id: "llm" as const,
        instance_id: row.processor_instance_id,
        version: row.processor_adapter_version,
        configuration_sha256: row.processor_configuration_sha256,
      },
    };
    assertAdmissionSnapshot(admission);
    assertCanonicalMeetingDocument(meeting, {
      kind: "meeting-source",
      adapter_id: admission.source.adapter_id,
      instance_id: admission.source.instance_id,
      version: admission.source.version,
    });
    assertCanonicalDecisionSet(decisions, meeting, {
      kind: "decision-processor",
      adapter_id: admission.processor.adapter_id,
      instance_id: admission.processor.instance_id,
      version: admission.processor.version,
    });
    return {
      ...row,
      admission,
      meeting,
      decisions,
      approved_snapshot: approvedSnapshot,
    };
  }

  listStagedApprovalIds(): readonly string[] {
    return (
      this.database
        .prepare(
          `SELECT approval_id
             FROM authority_clean_live_approval_outbox_v1
            WHERE state = 'staged'
              AND NOT EXISTS (
                SELECT 1 FROM authority_clean_live_v4_receipts_v1 AS receipt
                 WHERE receipt.approval_id = authority_clean_live_approval_outbox_v1.approval_id
              )
            ORDER BY approval_id`,
        )
        .all() as Array<{ approval_id: string }>
    ).map(({ approval_id }) => approval_id);
  }

  recordV4Receipt(input: {
    readonly approval_id: string;
    readonly control_approval_sha256: string;
    readonly receipt: Readonly<Record<string, unknown>>;
  }): CleanV4ReceiptV1 {
    const receiptJson = canonicalJson(input.receipt);
    const receiptSha256 = canonicalSha256(input.receipt);
    return this.database.transaction(() => {
      const outbox = this.readCandidateByApprovalId(input.approval_id);
      if (
        outbox === undefined ||
        outbox.state !== "staged" ||
        outbox.control_approval_sha256 !== input.control_approval_sha256
      ) {
        throw new Error(
          "clean live V4 receipt lacks its staged control approval witness",
        );
      }
      const existing = this.database
        .prepare(
          `SELECT control_approval_sha256, receipt_json, receipt_sha256
             FROM authority_clean_live_v4_receipts_v1 WHERE approval_id = ?`,
        )
        .get(input.approval_id) as
        | {
            control_approval_sha256: string;
            receipt_json: string;
            receipt_sha256: string;
          }
        | undefined;
      if (existing !== undefined) {
        if (
          existing.control_approval_sha256 !== input.control_approval_sha256 ||
          existing.receipt_json !== receiptJson ||
          existing.receipt_sha256 !== receiptSha256
        ) {
          throw new Error("clean live V4 receipt conflicts with its approval");
        }
        return {
          approval_id: input.approval_id,
          control_approval_sha256: existing.control_approval_sha256,
          receipt: input.receipt,
          receipt_sha256: existing.receipt_sha256,
        };
      }
      const now = this.now();
      assertCanonicalUtcMillis(now);
      this.database
        .prepare(
          `INSERT INTO authority_clean_live_v4_receipts_v1 (
             approval_id, control_approval_sha256, receipt_sha256, receipt_json,
             recorded_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.approval_id,
          input.control_approval_sha256,
          receiptSha256,
          receiptJson,
          now,
        );
      return {
        approval_id: input.approval_id,
        control_approval_sha256: input.control_approval_sha256,
        receipt: input.receipt,
        receipt_sha256: receiptSha256,
      };
    })();
  }

  recordPostedApprovalCard(
    input: CleanPostedApprovalCardV1,
  ): CleanLiveApprovalOutboxV1 {
    return this.database.transaction(() => {
      const current = this.outbox(input.candidate_id);
      const snapshotJson = canonicalJson(input.approved_snapshot);
      const snapshotSha256 = canonicalSha256(input.approved_snapshot);
      if (current.state !== "queued") {
        if (
          current.provider_message_ts === input.provider_message_ts &&
          current.frozen_card_sha256 === input.frozen_card_sha256 &&
          current.approved_snapshot_json === snapshotJson &&
          current.approved_snapshot_sha256 === snapshotSha256
        ) {
          return current;
        }
        throw new Error(
          "clean live approval card conflicts with its durable outbox",
        );
      }
      const now = this.now();
      assertCanonicalUtcMillis(now);
      this.database
        .prepare(
          `UPDATE authority_clean_live_approval_outbox_v1
              SET state = 'posted', provider_message_ts = ?,
                  frozen_card_sha256 = ?, approved_snapshot_json = ?,
                  approved_snapshot_sha256 = ?,
                  updated_at = ?
            WHERE candidate_id = ? AND state = 'queued'`,
        )
        .run(
          input.provider_message_ts,
          input.frozen_card_sha256,
          snapshotJson,
          snapshotSha256,
          now,
          input.candidate_id,
        );
      return this.outbox(input.candidate_id);
    })();
  }

  markControlPlaneStaged(input: {
    readonly candidate_id: string;
    readonly control_approval_sha256: string;
  }): CleanLiveApprovalOutboxV1 {
    return this.database.transaction(() => {
      const current = this.outbox(input.candidate_id);
      if (current.state === "staged") {
        if (current.control_approval_sha256 === input.control_approval_sha256) {
          return current;
        }
        throw new Error(
          "clean live control approval conflicts with its durable outbox",
        );
      }
      if (current.state !== "posted") {
        throw new Error(
          "clean live approval card must be posted before control staging",
        );
      }
      const now = this.now();
      assertCanonicalUtcMillis(now);
      this.database
        .prepare(
          `UPDATE authority_clean_live_approval_outbox_v1
              SET state = 'staged', control_approval_sha256 = ?, updated_at = ?
            WHERE candidate_id = ? AND state = 'posted'`,
        )
        .run(input.control_approval_sha256, now, input.candidate_id);
      return this.outbox(input.candidate_id);
    })();
  }

  private admission(): AdmissionRow {
    const admission = this.database
      .prepare(
        `SELECT source_instance_id, source_adapter_version, cursor, cutoff_at,
                processor_instance_id, processor_adapter_version,
                processor_configuration_sha256,
                semantic_input_sha256, admitted_at,
                membership.status AS membership_status
           FROM authority_clean_granola_source_admission_v1 AS admission
           JOIN authority_memberships AS membership
             ON membership.membership_id = admission.membership_id
            AND membership.organization_id = admission.organization_id
            AND membership.principal_id = admission.principal_id
            AND membership.membership_type = admission.membership_type
          WHERE admission.singleton = 1`,
      )
      .get() as AdmissionRow | undefined;
    if (admission === undefined) {
      throw new Error("clean live-only source has not been admitted");
    }
    return admission;
  }

  private progress(admissionSemanticSha256: string): ProgressRow {
    const progress = this.database
      .prepare(
        `SELECT cursor
           FROM authority_clean_granola_source_progress_v1
          WHERE singleton = 1 AND admission_semantic_input_sha256 = ?`,
      )
      .get(admissionSemanticSha256) as ProgressRow | undefined;
    if (progress === undefined) {
      throw new Error(
        "clean live-only source progress has not been initialized",
      );
    }
    return progress;
  }

  private candidate(semanticSha256: string): CandidateRow | undefined {
    return this.database
      .prepare(
        `SELECT candidate.candidate_id, candidate.candidate_semantic_sha256,
                outbox.approval_id, outbox.stage_command_id, outbox.state
           FROM authority_clean_live_candidates_v1 AS candidate
           JOIN authority_clean_live_approval_outbox_v1 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE candidate.candidate_semantic_sha256 = ?`,
      )
      .get(semanticSha256) as CandidateRow | undefined;
  }

  private outbox(candidateId: string): CleanLiveApprovalOutboxV1 {
    const outbox = this.database
      .prepare(
        `SELECT candidate.candidate_id, candidate.candidate_semantic_sha256,
                outbox.approval_id, outbox.stage_command_id, outbox.state,
                outbox.provider_message_ts, outbox.frozen_card_sha256,
                outbox.approved_snapshot_json, outbox.approved_snapshot_sha256,
                outbox.control_approval_sha256
           FROM authority_clean_live_candidates_v1 AS candidate
           JOIN authority_clean_live_approval_outbox_v1 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE candidate.candidate_id = ?`,
      )
      .get(candidateId) as CleanLiveApprovalOutboxV1 | undefined;
    if (outbox === undefined)
      throw new Error("clean live approval outbox is absent");
    return outbox;
  }
}

function assertAdmissionSnapshot(
  admission: CleanGranolaSourceAdmissionV1,
): void {
  assertCanonicalUtcMillis(admission.source.cutoff_at);
  assertLiveGranolaCursor(admission.source.cursor);
}
