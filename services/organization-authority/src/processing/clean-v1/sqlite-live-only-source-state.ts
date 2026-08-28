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
import {
  assertGranolaPersonContentPolicySnapshotV1,
} from "./granola-person-content-policy.js";
import {
  cleanReviewInputSha256V1,
  cleanReviewLineageIdV1,
  cleanReviewSemanticSha256V1,
  type CleanReviewPolicySnapshotV1,
} from "./review-lineage-semantics.js";
import type {
  CleanGranolaSourceAdmissionV1,
  CleanActionableLiveCandidateV1,
  CleanFrozenCandidateSnapshotV1,
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

interface CandidateRow {
  readonly candidate_id: string;
  readonly candidate_semantic_sha256: string;
  readonly review_lineage_id: string;
  readonly review_input_sha256: string;
  readonly review_semantic_sha256: string;
  readonly review_policy_id: CleanReviewPolicySnapshotV1["policy_id"];
  readonly review_policy_contract_sha256: CleanReviewPolicySnapshotV1["policy_contract_sha256"];
  readonly review_policy_consequence_text: string;
  readonly review_policy_consequence_sha256: CleanReviewPolicySnapshotV1["policy_consequence_sha256"];
  readonly disposition: "actionable" | "coalesced" | "no_signals";
  readonly approval_id: string | null;
  readonly stage_command_id: string | null;
  readonly state: "queued" | "posting" | "posted" | "staged" | "superseded" | "coalesced" | "no_signals";
}

interface LineageHeadRow {
  readonly review_lineage_id: string;
  readonly candidate_id: string;
  readonly review_semantic_sha256: string;
}

function candidateSemanticDigest(input: {
  readonly admission_semantic_input_sha256: string;
  readonly external_id: string;
  readonly canonical_revision: string;
}): string {
  return canonicalSha256({
    schema_version: 1,
    kind: "echo-clean-live-candidate-v1",
    admission_semantic_input_sha256: input.admission_semantic_input_sha256,
    meeting: {
      external_id: input.external_id,
      canonical_revision: input.canonical_revision,
    },
  });
}

export interface CleanPostedApprovalCardV1 {
  readonly candidate_id: string;
  readonly provider_message_ts: string;
  readonly frozen_card_sha256: string;
  readonly approved_snapshot: Readonly<Record<string, unknown>>;
}

export interface CleanPreparedApprovalPostV1 {
  readonly outbox: CleanLiveApprovalOutboxV1;
  /** True only for the transaction that froze the durable post intent. */
  readonly created: boolean;
}

export type CleanLiveApprovalOutboxV1 = CleanActionableLiveCandidateV1 & {
  readonly provider_message_ts: string | null;
  readonly frozen_card_sha256: string | null;
  readonly approved_snapshot_json: string | null;
  readonly approved_snapshot_sha256: string | null;
  readonly post_started_at: string | null;
  readonly control_approval_sha256: string | null;
  readonly superseded_by_candidate_id: string | null;
  readonly superseded_at: string | null;
  readonly tombstoned_at: string | null;
};

export interface CleanSupersededApprovalCardV1 {
  readonly approval_id: string;
  readonly review_lineage_id: string;
  readonly superseded_by_candidate_id: string;
  readonly provider_message_ts: string | null;
  readonly post_started_at: string;
}

export type CleanFrozenCandidateForApprovalV1 = CleanLiveApprovalOutboxV1 & {
  readonly admission: CleanGranolaSourceAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
  readonly approved_snapshot: Readonly<Record<string, unknown>> | null;
};

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
      // A source page can be retried after its cursor has advanced, and the
      // processor can produce a different observation of the same revision.
      // Neither event may create another approval. The admission's persisted
      // semantic identity fixes the admitted source/processor configuration;
      // the meeting's provider identity fixes the admitted source revision.
      // The first writer below remains the immutable audit snapshot.
      const candidateSemanticSha256 = candidateSemanticDigest({
        admission_semantic_input_sha256: admission.semantic_input_sha256,
        external_id: input.meeting.provenance.external_id,
        canonical_revision: input.meeting.provenance.canonical_revision,
      });
      const candidateId = `cnd_${candidateSemanticSha256.slice("sha256:".length)}`;
      const existing = this.candidate(candidateSemanticSha256);
      if (existing !== undefined) return existing as CleanLiveCandidateV1;

      assertGranolaPersonContentPolicySnapshotV1(
        input.meeting.extensions,
        input.review_policy,
      );

      const reviewLineageId = cleanReviewLineageIdV1({
        adapter_id: input.meeting.provenance.source.adapter_id,
        instance_id: input.meeting.provenance.source.instance_id,
        external_id: input.meeting.provenance.external_id,
      });
      const reviewProcessor = {
        adapter_id: current.processor.adapter_id,
        instance_id: current.processor.instance_id,
        version: current.processor.version,
        configuration_sha256: current.processor.configuration_sha256,
      };
      const reviewInputSha256 = cleanReviewInputSha256V1({
        meeting: input.meeting,
        processor: reviewProcessor,
      });
      const reviewSemanticSha256 = cleanReviewSemanticSha256V1({
        meeting: input.meeting,
        decisions: input.decisions,
        review_policy: input.review_policy,
        processor: reviewProcessor,
      });
      const previous = this.lineageHead(reviewLineageId);
      const semanticChanged =
        previous === undefined ||
        previous.review_semantic_sha256 !== reviewSemanticSha256;
      const disposition =
        !semanticChanged
          ? "coalesced"
          : input.decisions.signals.length === 0
            ? "no_signals"
            : "actionable";
      const approvalId =
        disposition === "actionable"
          ? `apr_${candidateSemanticSha256.slice("sha256:".length)}`
          : null;
      const stageCommandId =
        disposition === "actionable"
          ? `pas_${candidateSemanticSha256.slice("sha256:".length)}`
          : null;

      const now = this.now();
      assertCanonicalUtcMillis(now);
      this.database
        .prepare(
          `INSERT INTO authority_clean_live_candidates_v1 (
             candidate_id, candidate_semantic_sha256,
             admission_semantic_input_sha256, review_lineage_id,
             review_input_sha256, review_semantic_sha256,
             review_policy_id, review_policy_contract_sha256,
             review_policy_consequence_text,
             review_policy_consequence_sha256, disposition, source_cursor,
             meeting_sha256, meeting_json, decisions_sha256, decisions_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidateId,
          candidateSemanticSha256,
          admission.semantic_input_sha256,
          reviewLineageId,
          reviewInputSha256,
          reviewSemanticSha256,
          input.review_policy.policy_id,
          input.review_policy.policy_contract_sha256,
          input.review_policy.policy_consequence_text,
          input.review_policy.policy_consequence_sha256,
          disposition,
          current.source.cursor,
          canonicalSha256(input.meeting),
          meetingJson,
          canonicalSha256(input.decisions),
          decisionsJson,
          now,
        );
      if (semanticChanged && previous !== undefined) {
        this.supersedeUnresolvedLineageApprovals(
          reviewLineageId,
          candidateId,
          now,
        );
      }
      if (disposition === "actionable") {
        this.database
          .prepare(
            `INSERT INTO authority_clean_live_approval_outbox_v1 (
               candidate_id, approval_id, stage_command_id, state, updated_at
             ) VALUES (?, ?, ?, 'queued', ?)`,
          )
          .run(candidateId, approvalId, stageCommandId, now);
      }
      if (semanticChanged) {
        this.database
          .prepare(
          `INSERT INTO authority_clean_live_review_lineage_heads_v1 (
             review_lineage_id, candidate_id, updated_at
           ) VALUES (?, ?, ?)
             ON CONFLICT (review_lineage_id) DO UPDATE SET
             candidate_id = excluded.candidate_id,
             updated_at = excluded.updated_at`,
          )
          .run(
            reviewLineageId,
            candidateId,
            now,
          );
      }
      return this.candidate(candidateSemanticSha256) as CleanLiveCandidateV1;
    })();
  }

  async readFrozenCandidateForSourceRevision(input: {
    readonly external_id: string;
    readonly canonical_revision: string;
  }): Promise<CleanFrozenCandidateSnapshotV1 | undefined> {
    return this.database.transaction(() => {
      const admission = this.admission();
      if (admission.membership_status !== "active") {
        throw new CleanLiveOnlySourceRevokedError();
      }
      const candidate = this.candidate(
        candidateSemanticDigest({
          admission_semantic_input_sha256: admission.semantic_input_sha256,
          external_id: input.external_id,
          canonical_revision: input.canonical_revision,
        }),
      );
      return candidate === undefined
        ? undefined
        : this.readFrozenCandidateById(candidate.candidate_id);
    })();
  }

  async readFrozenCandidateForReviewInput(input: {
    readonly review_lineage_id: string;
    readonly review_input_sha256: string;
  }): Promise<CleanFrozenCandidateSnapshotV1 | undefined> {
    return this.database.transaction(() => {
      const admission = this.admission();
      if (admission.membership_status !== "active") {
        throw new CleanLiveOnlySourceRevokedError();
      }
      const row = this.database
        .prepare(
          `SELECT candidate.candidate_id
             FROM authority_clean_live_candidates_v1 AS candidate
            WHERE candidate.review_lineage_id = ?
              AND candidate.review_input_sha256 = ?
            ORDER BY candidate.created_at ASC
            `,
        )
        .get(input.review_lineage_id, input.review_input_sha256) as
        | { candidate_id: string }
        | undefined;
      if (row === undefined) return undefined;
      return this.readFrozenCandidateById(row.candidate_id);
    })();
  }

  approvalIsCurrent(approvalId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT 1
           FROM authority_clean_live_approval_outbox_v1 AS outbox
           JOIN authority_clean_live_candidates_v1 AS candidate
             ON candidate.candidate_id = outbox.candidate_id
           JOIN authority_clean_live_review_lineage_heads_v1 AS head
             ON head.review_lineage_id = candidate.review_lineage_id
          WHERE outbox.approval_id = ?
            AND outbox.state != 'superseded'
            AND head.candidate_id = candidate.candidate_id`,
      )
      .get(approvalId) as { readonly 1: number } | undefined;
    return row !== undefined;
  }

  /**
   * Reproves every current, actionable approval that still needs Slack/D2
   * delivery. The query deliberately selects the lineage head first; the
   * frozen reader then verifies the immutable meeting, decisions, and any
   * frozen card snapshot before exposing it to a delivery worker.
   */
  listPendingApprovalDeliveries(): readonly CleanFrozenCandidateForApprovalV1[] {
    const approvals = this.database
      .prepare(
        `SELECT outbox.approval_id
           FROM authority_clean_live_approval_outbox_v1 AS outbox
           JOIN authority_clean_live_candidates_v1 AS candidate
             ON candidate.candidate_id = outbox.candidate_id
           JOIN authority_clean_live_review_lineage_heads_v1 AS head
             ON head.review_lineage_id = candidate.review_lineage_id
          WHERE candidate.disposition = 'actionable'
            AND head.candidate_id = candidate.candidate_id
            AND outbox.state IN ('queued', 'posting', 'posted')
          ORDER BY candidate.created_at ASC, candidate.candidate_id ASC`,
      )
      .all() as readonly { readonly approval_id: string }[];
    return approvals.map(({ approval_id }) => {
      const candidate = this.readFrozenCandidateForApproval(approval_id);
      if (candidate === undefined) {
        throw new Error("clean pending approval delivery is absent");
      }
      return candidate;
    });
  }

  listPendingSupersededApprovalCards(): readonly CleanSupersededApprovalCardV1[] {
    return this.database
      .prepare(
        `SELECT outbox.approval_id, candidate.review_lineage_id,
                outbox.superseded_by_candidate_id,
                outbox.provider_message_ts, outbox.post_started_at
           FROM authority_clean_live_approval_outbox_v1 AS outbox
           JOIN authority_clean_live_candidates_v1 AS candidate
             ON candidate.candidate_id = outbox.candidate_id
          WHERE outbox.state = 'superseded'
            AND outbox.post_started_at IS NOT NULL
            AND outbox.tombstoned_at IS NULL
          ORDER BY outbox.approval_id`,
      )
      .all() as CleanSupersededApprovalCardV1[];
  }

  recordSupersededApprovalCardTombstoned(input: {
    readonly approval_id: string;
    readonly provider_message_ts: string;
  }): void {
    this.database.transaction(() => {
      const current = this.database
        .prepare(
          `SELECT state, provider_message_ts, tombstoned_at
             FROM authority_clean_live_approval_outbox_v1
            WHERE approval_id = ?`,
        )
        .get(input.approval_id) as
        | {
            readonly state: string;
            readonly provider_message_ts: string | null;
            readonly tombstoned_at: string | null;
          }
        | undefined;
      if (
        current === undefined ||
        current.state !== "superseded" ||
        current.provider_message_ts !== input.provider_message_ts
      ) {
        throw new Error(
          "clean superseded Slack tombstone lacks its durable card identity",
        );
      }
      if (current.tombstoned_at !== null) return;
      const now = this.now();
      assertCanonicalUtcMillis(now);
      const update = this.database
        .prepare(
          `UPDATE authority_clean_live_approval_outbox_v1
              SET tombstoned_at = ?, updated_at = ?
            WHERE approval_id = ? AND state = 'superseded'
              AND provider_message_ts = ? AND tombstoned_at IS NULL`,
        )
        .run(now, now, input.approval_id, input.provider_message_ts);
      if (update.changes !== 1) {
        throw new Error("clean superseded Slack tombstone state drifted");
      }
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
                candidate.review_lineage_id, candidate.review_input_sha256,
                candidate.review_semantic_sha256,
                candidate.review_policy_id,
                candidate.review_policy_contract_sha256,
                candidate.review_policy_consequence_text,
                candidate.review_policy_consequence_sha256,
                candidate.disposition,
                outbox.approval_id, outbox.stage_command_id, outbox.state,
                outbox.provider_message_ts, outbox.frozen_card_sha256,
                outbox.approved_snapshot_json, outbox.approved_snapshot_sha256,
                outbox.post_started_at,
                outbox.control_approval_sha256,
                outbox.superseded_by_candidate_id, outbox.superseded_at,
                outbox.tombstoned_at
           FROM authority_clean_live_candidates_v1 AS candidate
           JOIN authority_clean_live_approval_outbox_v1 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE outbox.approval_id = ?`,
      )
      .get(approvalId) as CleanLiveApprovalOutboxV1 | undefined;
  }

  private readFrozenCandidateById(
    candidateId: string,
  ): CleanFrozenCandidateSnapshotV1 | undefined {
    const row = this.database
      .prepare(
        `SELECT candidate.candidate_semantic_sha256,
                candidate.source_cursor, candidate.meeting_sha256,
                candidate.meeting_json, candidate.decisions_sha256,
                candidate.decisions_json,
                admission.source_instance_id, admission.source_adapter_version,
                admission.cutoff_at, admission.processor_instance_id,
                admission.processor_adapter_version,
                admission.processor_configuration_sha256
           FROM authority_clean_live_candidates_v1 AS candidate
           JOIN authority_clean_granola_source_admission_v1 AS admission
             ON admission.semantic_input_sha256 = candidate.admission_semantic_input_sha256
          WHERE candidate.candidate_id = ?`,
      )
      .get(candidateId) as
      | {
          readonly candidate_semantic_sha256: string;
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
        }
      | undefined;
    if (row === undefined) return undefined;
    const candidate = this.candidate(row.candidate_semantic_sha256);
    if (candidate === undefined) {
      throw new Error("clean frozen candidate is absent");
    }
    const meeting = JSON.parse(row.meeting_json) as MeetingDocument;
    const decisions = JSON.parse(row.decisions_json) as DecisionSet;
    if (
      canonicalJson(meeting) !== row.meeting_json ||
      canonicalSha256(meeting) !== row.meeting_sha256 ||
      canonicalJson(decisions) !== row.decisions_json ||
      canonicalSha256(decisions) !== row.decisions_sha256
    ) {
      throw new Error("clean frozen candidate snapshot digest is invalid");
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
    return { ...candidate, admission, meeting, decisions } as CleanFrozenCandidateSnapshotV1;
  }

  /** Reproves the exact Authority snapshot which a D2 approval resolved. */
  readFrozenCandidateForApproval(
    approvalId: string,
  ): CleanFrozenCandidateForApprovalV1 | undefined {
    return this.database.transaction(() => {
      const outbox = this.readCandidateByApprovalId(approvalId);
      if (outbox === undefined) return undefined;
      const frozen = this.readFrozenCandidateById(outbox.candidate_id);
      if (frozen === undefined || frozen.disposition !== "actionable") {
        throw new Error("clean D2 approval has no frozen actionable candidate");
      }
      const approvedSnapshot =
        outbox.approved_snapshot_json === null
          ? null
          : (JSON.parse(outbox.approved_snapshot_json) as Readonly<
              Record<string, unknown>
            >);
      if (
        (approvedSnapshot === null) !==
          (outbox.approved_snapshot_sha256 === null) ||
        (approvedSnapshot !== null &&
          (canonicalJson(approvedSnapshot) !== outbox.approved_snapshot_json ||
            canonicalSha256(approvedSnapshot) !==
              outbox.approved_snapshot_sha256))
      ) {
        throw new Error("clean frozen approved snapshot digest is invalid");
      }
      return {
        ...frozen,
        ...outbox,
        approved_snapshot: approvedSnapshot,
      };
    })();
  }

  listStagedApprovalIds(): readonly string[] {
    return (
      this.database
        .prepare(
          `SELECT approval_id
             FROM authority_clean_live_approval_outbox_v1
             JOIN authority_clean_live_candidates_v1 AS candidate
               ON candidate.candidate_id = authority_clean_live_approval_outbox_v1.candidate_id
             JOIN authority_clean_live_review_lineage_heads_v1 AS head
               ON head.review_lineage_id = candidate.review_lineage_id
            WHERE state = 'staged'
              AND head.candidate_id = candidate.candidate_id
              AND NOT EXISTS (
                SELECT 1 FROM authority_clean_live_v4_receipts_v1 AS receipt
                 WHERE receipt.approval_id = authority_clean_live_approval_outbox_v1.approval_id
              )
            ORDER BY approval_id`,
        )
        .all() as Array<{ approval_id: string }>
    ).map(({ approval_id }) => approval_id);
  }

  /**
   * Includes superseded frozen rows because their D2 human action may already
   * have committed before Authority recorded the supersession. They are never
   * observed again, but a durable action must still complete its V4 append.
   */
  listV4RecoveryApprovalIds(): readonly string[] {
    return (
      this.database
        .prepare(
          `SELECT approval_id
             FROM authority_clean_live_approval_outbox_v1
            WHERE (state = 'staged' OR
                   (state = 'superseded' AND control_approval_sha256 IS NOT NULL))
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
        (outbox.state !== "staged" && outbox.state !== "superseded") ||
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

  /**
   * Persist the exact card payload before any Slack side effect. Recovery must
   * prove the same frozen payload; it can never silently construct a new one.
   */
  prepareApprovalPost(input: {
    readonly candidate_id: string;
    readonly frozen_card_sha256: string;
    readonly approved_snapshot: Readonly<Record<string, unknown>>;
  }): CleanPreparedApprovalPostV1 {
    return this.database.transaction(() => {
      const current = this.outbox(input.candidate_id);
      const snapshotJson = canonicalJson(input.approved_snapshot);
      const snapshotSha256 = canonicalSha256(input.approved_snapshot);
      if (current.state === "queued") {
        const now = this.now();
        assertCanonicalUtcMillis(now);
        const updated = this.database
          .prepare(
            `UPDATE authority_clean_live_approval_outbox_v1
                SET state = 'posting', frozen_card_sha256 = ?,
                    approved_snapshot_json = ?, approved_snapshot_sha256 = ?,
                    post_started_at = ?, updated_at = ?
              WHERE candidate_id = ? AND state = 'queued'`,
          )
          .run(
            input.frozen_card_sha256,
            snapshotJson,
            snapshotSha256,
            now,
            now,
            input.candidate_id,
          );
        if (updated.changes !== 1) {
          throw new Error("clean live approval post intent state drifted");
        }
        return { outbox: this.outbox(input.candidate_id), created: true };
      }
      if (
        current.frozen_card_sha256 !== input.frozen_card_sha256 ||
        current.approved_snapshot_json !== snapshotJson ||
        current.approved_snapshot_sha256 !== snapshotSha256
      ) {
        throw new Error("clean live approval post intent conflicts with its durable outbox");
      }
      return { outbox: current, created: false };
    })();
  }

  /** Record a provider rejection which proves that no Slack message was made. */
  recordDefinitiveApprovalPostFailure(
    candidateId: string,
  ): CleanLiveApprovalOutboxV1 {
    return this.database.transaction(() => {
      const current = this.outbox(candidateId);
      if (current.state === "queued") return current;
      if (
        current.state === "superseded" &&
        current.provider_message_ts === null &&
        current.post_started_at === null
      ) {
        return current;
      }
      if (
        current.state === "superseded" &&
        current.provider_message_ts === null &&
        current.post_started_at !== null &&
        current.control_approval_sha256 === null
      ) {
        const now = this.now();
        assertCanonicalUtcMillis(now);
        const updated = this.database
          .prepare(
            `UPDATE authority_clean_live_approval_outbox_v1
                SET frozen_card_sha256 = NULL,
                    approved_snapshot_json = NULL,
                    approved_snapshot_sha256 = NULL,
                    post_started_at = NULL, updated_at = ?
              WHERE candidate_id = ? AND state = 'superseded'
                AND provider_message_ts IS NULL
                AND post_started_at IS NOT NULL
                AND control_approval_sha256 IS NULL`,
          )
          .run(now, candidateId);
        if (updated.changes !== 1) {
          throw new Error("clean superseded post failure state drifted");
        }
        return this.outbox(candidateId);
      }
      if (current.state !== "posting") {
        throw new Error(
          "clean live approval post failure lacks an active post attempt",
        );
      }
      const now = this.now();
      assertCanonicalUtcMillis(now);
      const updated = this.database
        .prepare(
          `UPDATE authority_clean_live_approval_outbox_v1
              SET state = 'queued', frozen_card_sha256 = NULL,
                  approved_snapshot_json = NULL,
                  approved_snapshot_sha256 = NULL,
                  post_started_at = NULL, updated_at = ?
            WHERE candidate_id = ? AND state = 'posting'`,
        )
        .run(now, candidateId);
      if (updated.changes !== 1) {
        throw new Error("clean live approval post failure state drifted");
      }
      return this.outbox(candidateId);
    })();
  }

  recordPostedApprovalCard(
    input: CleanPostedApprovalCardV1,
  ): CleanLiveApprovalOutboxV1 {
    return this.database.transaction(() => {
      const current = this.outbox(input.candidate_id);
      const snapshotJson = canonicalJson(input.approved_snapshot);
      const snapshotSha256 = canonicalSha256(input.approved_snapshot);
      if (current.state !== "posting") {
        if (
          current.provider_message_ts === input.provider_message_ts &&
          current.frozen_card_sha256 === input.frozen_card_sha256 &&
          current.approved_snapshot_json === snapshotJson &&
          current.approved_snapshot_sha256 === snapshotSha256
        ) {
          return current;
        }
        if (
          current.state === "superseded" &&
          current.provider_message_ts === null &&
          current.frozen_card_sha256 === input.frozen_card_sha256 &&
          current.approved_snapshot_json === snapshotJson &&
          current.approved_snapshot_sha256 === snapshotSha256 &&
          current.post_started_at !== null
        ) {
          const now = this.now();
          assertCanonicalUtcMillis(now);
          this.database
            .prepare(
              `UPDATE authority_clean_live_approval_outbox_v1
                  SET provider_message_ts = ?,
                      updated_at = ?
                WHERE candidate_id = ? AND state = 'superseded'
                  AND provider_message_ts IS NULL`,
            )
            .run(
              input.provider_message_ts,
              now,
              input.candidate_id,
            );
          return this.outbox(input.candidate_id);
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
                  updated_at = ?
            WHERE candidate_id = ? AND state = 'posting'`,
        )
        .run(
          input.provider_message_ts,
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
      if (
        (current.state === "staged" || current.state === "superseded") &&
        current.control_approval_sha256 !== null
      ) {
        if (current.control_approval_sha256 === input.control_approval_sha256) {
          return current;
        }
        throw new Error(
          "clean live control approval conflicts with its durable outbox",
        );
      }
      if (current.state === "superseded") {
        if (
          current.provider_message_ts === null ||
          current.frozen_card_sha256 === null ||
          current.approved_snapshot_sha256 === null
        ) {
          throw new Error(
            "clean superseded D2 approval has no frozen posted card",
          );
        }
        const now = this.now();
        assertCanonicalUtcMillis(now);
        this.database
          .prepare(
            `UPDATE authority_clean_live_approval_outbox_v1
                SET control_approval_sha256 = ?, updated_at = ?
              WHERE candidate_id = ? AND state = 'superseded'
                AND control_approval_sha256 IS NULL`,
          )
          .run(input.control_approval_sha256, now, input.candidate_id);
        return this.outbox(input.candidate_id);
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
                candidate.review_lineage_id, candidate.review_input_sha256,
                candidate.review_semantic_sha256,
                candidate.review_policy_id,
                candidate.review_policy_contract_sha256,
                candidate.review_policy_consequence_text,
                candidate.review_policy_consequence_sha256,
                candidate.disposition, outbox.approval_id,
                outbox.stage_command_id,
                COALESCE(outbox.state, candidate.disposition) AS state
           FROM authority_clean_live_candidates_v1 AS candidate
           LEFT JOIN authority_clean_live_approval_outbox_v1 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE candidate.candidate_semantic_sha256 = ?`,
      )
      .get(semanticSha256) as CandidateRow | undefined;
  }

  private lineageHead(reviewLineageId: string): LineageHeadRow | undefined {
    return this.database
      .prepare(
        `SELECT head.review_lineage_id, head.candidate_id,
                candidate.review_semantic_sha256
           FROM authority_clean_live_review_lineage_heads_v1 AS head
           JOIN authority_clean_live_candidates_v1 AS candidate
             ON candidate.candidate_id = head.candidate_id
          WHERE head.review_lineage_id = ?`,
      )
      .get(reviewLineageId) as LineageHeadRow | undefined;
  }

  private supersedeUnresolvedLineageApprovals(
    reviewLineageId: string,
    successorCandidateId: string,
    supersededAt: string,
  ): void {
    this.database
      .prepare(
        `UPDATE authority_clean_live_approval_outbox_v1
            SET state = 'superseded', superseded_by_candidate_id = ?,
                superseded_at = ?, updated_at = ?
          WHERE candidate_id IN (
            SELECT candidate_id
              FROM authority_clean_live_candidates_v1
             WHERE review_lineage_id = ?
          )
            AND state != 'superseded'
            AND NOT EXISTS (
              SELECT 1 FROM authority_clean_live_v4_receipts_v1 AS receipt
               WHERE receipt.approval_id = authority_clean_live_approval_outbox_v1.approval_id
            )`,
      )
      .run(successorCandidateId, supersededAt, supersededAt, reviewLineageId);
  }

  private outbox(candidateId: string): CleanLiveApprovalOutboxV1 {
    const outbox = this.database
      .prepare(
          `SELECT candidate.candidate_id, candidate.candidate_semantic_sha256,
                candidate.review_lineage_id, candidate.review_input_sha256,
                candidate.review_semantic_sha256,
                candidate.review_policy_id,
                candidate.review_policy_contract_sha256,
                candidate.review_policy_consequence_text,
                candidate.review_policy_consequence_sha256,
                candidate.disposition,
                outbox.approval_id, outbox.stage_command_id, outbox.state,
                outbox.provider_message_ts, outbox.frozen_card_sha256,
                outbox.approved_snapshot_json, outbox.approved_snapshot_sha256,
                outbox.post_started_at,
                outbox.control_approval_sha256,
                outbox.superseded_by_candidate_id, outbox.superseded_at,
                outbox.tombstoned_at
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
