import type Database from "better-sqlite3";
import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import {
  assertCanonicalDecisionSet,
  assertCanonicalMeetingDocument,
  type DecisionSet,
  type MeetingDocument,
} from "../core/index.js";
import type { AdmittedMeetingSourceCursorPolicyV1 } from "./admitted-meeting-source-cursor-policy-v1.js";
import {
  assertLegacyReviewPolicySnapshotV1,
  reviewInputSha256V1,
  reviewLineageIdV1,
  reviewSemanticSha256V1,
  type ReviewPolicySnapshotV1,
} from "./review-lineage-semantics.js";
import type {
  AdmittedMeetingProcessingAdmissionV1,
  ActionableMeetingProcessingCandidateV1,
  ApprovalDeliveryQuarantineReasonV1,
  FrozenMeetingProcessingCandidateSnapshotV1,
  MeetingProcessingCandidateSnapshotInputV1,
  MeetingProcessingCandidateV1,
  AuthorityMeetingProcessingStateV1,
} from "./meeting-processing-cycle-v1.js";
import {
  assertStagingSyntheticMeetingCanaryV1,
  isStagingSyntheticMeetingCanaryV1,
  stagingSyntheticMeetingCanaryCursorV1,
  type StagingSyntheticMeetingCanaryInputV1,
} from "./staging-synthetic-meeting-canary-v1.js";

interface AdmissionRow {
  readonly source_adapter_id: string;
  readonly source_instance_id: string;
  readonly source_adapter_version: string;
  readonly cursor: string;
  readonly cutoff_at: string;
  readonly processor_adapter_id: string;
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
  readonly review_policy_id: ReviewPolicySnapshotV1["policy_id"];
  readonly review_policy_contract_sha256: ReviewPolicySnapshotV1["policy_contract_sha256"];
  readonly review_policy_consequence_text: string;
  readonly review_policy_consequence_sha256: ReviewPolicySnapshotV1["policy_consequence_sha256"];
  readonly disposition: "actionable" | "coalesced" | "no_signals";
  readonly approval_id: string | null;
  readonly stage_command_id: string | null;
  readonly state: "queued" | "posting" | "posted" | "staged" | "superseded" | "coalesced" | "no_signals";
  readonly durable_staged_at: string | null;
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

export interface PostedPrivateApprovalCardV1 {
  readonly candidate_id: string;
  readonly post_started_at: string;
  /** Opaque identifier assigned by the approval presentation provider. */
  readonly presentation_external_id: string;
  readonly frozen_card_sha256: string;
  readonly approved_snapshot: Readonly<Record<string, unknown>>;
}

export interface PreparedPrivateApprovalPostV1 {
  readonly outbox: ApprovalWorkflowOutboxV1;
  /** True only for the transaction that froze the durable post intent. */
  readonly created: boolean;
}

export type ApprovalWorkflowOutboxV1 = ActionableMeetingProcessingCandidateV1 & {
  readonly presentation_external_id: string | null;
  readonly frozen_card_sha256: string | null;
  readonly approved_snapshot_json: string | null;
  readonly approved_snapshot_sha256: string | null;
  readonly post_started_at: string | null;
  readonly control_approval_sha256: string | null;
  readonly superseded_by_candidate_id: string | null;
  readonly superseded_at: string | null;
  readonly tombstoned_at: string | null;
};

export interface ApprovalDeliveryQuarantineV1 {
  readonly candidate_id: string;
  readonly reason_code: ApprovalDeliveryQuarantineReasonV1;
  readonly quarantined_at: string;
}

export interface SupersededPrivateApprovalCardV1 {
  readonly approval_id: string;
  readonly review_lineage_id: string;
  readonly superseded_by_candidate_id: string;
  readonly presentation_external_id: string | null;
  readonly post_started_at: string;
}

export type FrozenMeetingProcessingCandidateForApprovalV1 = ApprovalWorkflowOutboxV1 & {
  readonly admission: AdmittedMeetingProcessingAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
  readonly approved_snapshot: Readonly<Record<string, unknown>> | null;
};

export class AuthorityMeetingProcessingRevokedError extends Error {
  constructor() {
    super("admitted meeting-processing owner membership is revoked");
    this.name = "AuthorityMeetingProcessingRevokedError";
  }
}

function assertCanonicalUtcMillis(value: string): void {
  if (new Date(value).toISOString() !== value) {
    throw new Error(
      "admitted meeting-processing timestamp must be UTC milliseconds",
    );
  }
}

function admissionFrom(
  row: AdmissionRow,
  progress: ProgressRow,
  sourceCursorPolicy: AdmittedMeetingSourceCursorPolicyV1,
  expectedProcessorAdapterId: string,
): AdmittedMeetingProcessingAdmissionV1 {
  assertAdmissionAdapterIdentity(
    row,
    sourceCursorPolicy,
    expectedProcessorAdapterId,
  );
  assertCanonicalUtcMillis(row.cutoff_at);
  sourceCursorPolicy.assert_live_cursor(progress.cursor);
  return Object.freeze({
    source: {
      adapter_id: row.source_adapter_id,
      instance_id: row.source_instance_id,
      version: row.source_adapter_version,
      cursor: progress.cursor,
      cutoff_at: row.cutoff_at,
    },
    processor: {
      adapter_id: row.processor_adapter_id,
      instance_id: row.processor_instance_id,
      version: row.processor_adapter_version,
      configuration_sha256: row.processor_configuration_sha256,
    },
  });
}

/**
 * The concrete Authority cursor store for the the admitted meeting source. Its first read
 * materializes a one-row progress checkpoint from the already immutable
 * admission. Subsequent advances compare the expected persisted cursor inside
 * one SQLite transaction, so no runner can overwrite a newer checkpoint.
 */
export class SqliteAuthorityMeetingProcessingStateV1 implements AuthorityMeetingProcessingStateV1 {
  private readonly expectedProcessorAdapterId: string;
  private readonly now: () => string;

  constructor(
    private readonly database: Database.Database,
    private readonly sourceCursorPolicy: AdmittedMeetingSourceCursorPolicyV1,
    /**
     * The caller must name the processor adapter selected by its runtime
     * bundle. An admitted source cannot be reopened through a different
     * decision processor implementation by accident.
     */
    expectedProcessorAdapterId: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    if (expectedProcessorAdapterId.trim().length === 0) {
      throw new Error(
        "admitted meeting-processing expected processor adapter identity is invalid",
      );
    }
    this.expectedProcessorAdapterId = expectedProcessorAdapterId;
    this.now = now;
  }

  async readAdmission(): Promise<AdmittedMeetingProcessingAdmissionV1> {
    return this.database.transaction(() => {
      const admission = this.admission();
      if (admission.membership_status !== "active") {
        throw new AuthorityMeetingProcessingRevokedError();
      }
      this.database
        .prepare(
          `INSERT INTO authority_live_source_progress_v2 (
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
             FROM authority_live_source_progress_v2
            WHERE singleton = 1
              AND admission_semantic_input_sha256 = ?`,
        )
        .get(admission.semantic_input_sha256) as ProgressRow | undefined;
      if (progress === undefined) {
        throw new Error(
          "admitted meeting-processing progress conflicts with its admission",
        );
      }
      return admissionFrom(
        admission,
        progress,
        this.sourceCursorPolicy,
        this.expectedProcessorAdapterId,
      );
    })();
  }

  async stageCandidate(
    input: MeetingProcessingCandidateSnapshotInputV1,
  ): Promise<MeetingProcessingCandidateV1> {
    return this.stageCandidateInternal(input);
  }

  /**
   * The only non-provider intake path. It is intentionally a separate,
   * conspicuously named operation so ordinary source processing cannot ever
   * submit arbitrary meetings under the staging exception.
   */
  async stageSyntheticCanaryCandidate(
    input: MeetingProcessingCandidateSnapshotInputV1,
    canary: StagingSyntheticMeetingCanaryInputV1,
  ): Promise<MeetingProcessingCandidateV1> {
    assertStagingSyntheticMeetingCanaryV1(input.meeting, canary);
    const canaryId = input.meeting.provenance.metadata?.["canary_id"];
    if (typeof canaryId !== "string") {
      throw new Error("staging synthetic canary has no canary id");
    }
    return this.stageCandidateInternal(
      input,
      stagingSyntheticMeetingCanaryCursorV1(canaryId),
    );
  }

  private async stageCandidateInternal(
    input: MeetingProcessingCandidateSnapshotInputV1,
    syntheticCanaryCursor?: string,
  ): Promise<MeetingProcessingCandidateV1> {
    return this.database.transaction(() => {
      const admission = this.admission();
      if (admission.membership_status !== "active") {
        throw new AuthorityMeetingProcessingRevokedError();
      }
      const progress = this.progress(admission.semantic_input_sha256);
      const current = admissionFrom(
        admission,
        progress,
        this.sourceCursorPolicy,
        this.expectedProcessorAdapterId,
      );
      if (
        input.admission.source.adapter_id !== current.source.adapter_id ||
        input.admission.source.cursor !== current.source.cursor ||
        input.admission.source.instance_id !== current.source.instance_id ||
        input.admission.source.version !== current.source.version ||
        input.admission.processor.adapter_id !==
          current.processor.adapter_id ||
        input.admission.processor.instance_id !==
          current.processor.instance_id ||
        input.admission.processor.version !== current.processor.version ||
        input.admission.processor.configuration_sha256 !==
          current.processor.configuration_sha256
      ) {
        throw new Error(
          "meeting-processing candidate differs from the current admitted source state",
        );
      }
      if (syntheticCanaryCursor === undefined) {
        assertCanonicalMeetingDocument(input.meeting, {
          kind: "meeting-source",
          adapter_id: current.source.adapter_id,
          instance_id: current.source.instance_id,
          version: current.source.version,
        });
      } else {
        assertStagingSyntheticMeetingCanaryV1(input.meeting);
      }
      assertCanonicalDecisionSet(input.decisions, input.meeting, {
        kind: "decision-processor",
        adapter_id: current.processor.adapter_id,
        instance_id: current.processor.instance_id,
        version: current.processor.version,
      });
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
      if (existing !== undefined) return existing as MeetingProcessingCandidateV1;

      assertLegacyReviewPolicySnapshotV1(input.review_policy);

      const reviewLineageId = reviewLineageIdV1({
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
      const reviewInputSha256 = reviewInputSha256V1({
        meeting: input.meeting,
        processor: reviewProcessor,
      });
      const reviewSemanticSha256 = reviewSemanticSha256V1({
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
          `INSERT INTO authority_live_source_candidates_v2 (
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
          syntheticCanaryCursor ?? current.source.cursor,
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
            `INSERT INTO authority_live_approval_outbox_v2 (
               candidate_id, approval_id, stage_command_id, state, updated_at
             ) VALUES (?, ?, ?, 'queued', ?)`,
          )
          .run(candidateId, approvalId, stageCommandId, now);
      }
      if (semanticChanged) {
        this.database
          .prepare(
          `INSERT INTO authority_live_source_review_lineage_heads_v2 (
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
      return this.candidate(candidateSemanticSha256) as MeetingProcessingCandidateV1;
    })();
  }

  async readFrozenCandidateForSourceRevision(input: {
    readonly external_id: string;
    readonly canonical_revision: string;
  }): Promise<FrozenMeetingProcessingCandidateSnapshotV1 | undefined> {
    return this.database.transaction(() => {
      const admission = this.admission();
      if (admission.membership_status !== "active") {
        throw new AuthorityMeetingProcessingRevokedError();
      }
      assertAdmissionAdapterIdentity(
        admission,
        this.sourceCursorPolicy,
        this.expectedProcessorAdapterId,
      );
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
  }): Promise<FrozenMeetingProcessingCandidateSnapshotV1 | undefined> {
    return this.database.transaction(() => {
      const admission = this.admission();
      if (admission.membership_status !== "active") {
        throw new AuthorityMeetingProcessingRevokedError();
      }
      assertAdmissionAdapterIdentity(
        admission,
        this.sourceCursorPolicy,
        this.expectedProcessorAdapterId,
      );
      const row = this.database
        .prepare(
          `SELECT candidate.candidate_id
             FROM authority_live_source_candidates_v2 AS candidate
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
           FROM authority_live_approval_outbox_v2 AS outbox
           JOIN authority_live_source_candidates_v2 AS candidate
             ON candidate.candidate_id = outbox.candidate_id
           JOIN authority_live_source_review_lineage_heads_v2 AS head
             ON head.review_lineage_id = candidate.review_lineage_id
          WHERE outbox.approval_id = ?
            AND outbox.state != 'superseded'
            AND NOT EXISTS (
              SELECT 1
                FROM authority_live_approval_delivery_quarantines_v1 AS quarantine
               WHERE quarantine.candidate_id = candidate.candidate_id
            )
            AND head.candidate_id = candidate.candidate_id`,
      )
      .get(approvalId) as { readonly 1: number } | undefined;
    return row !== undefined;
  }

  /**
   * Revalidates every current, actionable approval that still needs presentation
   * delivery. The query deliberately selects the lineage head first; the
   * frozen reader then verifies the immutable meeting, decisions, and any
   * frozen card snapshot before exposing it to a delivery worker.
   */
  listPendingApprovalDeliveries(): readonly FrozenMeetingProcessingCandidateForApprovalV1[] {
    const approvals = this.database
      .prepare(
        `SELECT outbox.approval_id
           FROM authority_live_approval_outbox_v2 AS outbox
           JOIN authority_live_source_candidates_v2 AS candidate
             ON candidate.candidate_id = outbox.candidate_id
           JOIN authority_live_source_review_lineage_heads_v2 AS head
             ON head.review_lineage_id = candidate.review_lineage_id
          WHERE candidate.disposition = 'actionable'
            AND head.candidate_id = candidate.candidate_id
            AND outbox.state IN ('queued', 'posting', 'posted')
            AND NOT EXISTS (
              SELECT 1
                FROM authority_live_approval_delivery_quarantines_v1 AS quarantine
               WHERE quarantine.candidate_id = candidate.candidate_id
            )
          ORDER BY candidate.created_at ASC, candidate.candidate_id ASC`,
      )
      .all() as readonly { readonly approval_id: string }[];
    return approvals.map(({ approval_id }) => {
      const candidate = this.readFrozenCandidateForApproval(approval_id);
      if (candidate === undefined) {
        throw new Error("pending approval delivery is absent");
      }
      return candidate;
    });
  }

  listPendingSupersededApprovalCards(): readonly SupersededPrivateApprovalCardV1[] {
    return this.database
      .prepare(
        `SELECT outbox.approval_id, candidate.review_lineage_id,
                outbox.superseded_by_candidate_id,
                outbox.provider_message_ts AS presentation_external_id,
                outbox.post_started_at
           FROM authority_live_approval_outbox_v2 AS outbox
           JOIN authority_live_source_candidates_v2 AS candidate
             ON candidate.candidate_id = outbox.candidate_id
          WHERE outbox.state = 'superseded'
            AND outbox.post_started_at IS NOT NULL
            AND outbox.tombstoned_at IS NULL
          ORDER BY outbox.approval_id`,
      )
      .all() as SupersededPrivateApprovalCardV1[];
  }

  recordSupersededApprovalCardTombstoned(input: {
    readonly approval_id: string;
    readonly presentation_external_id: string;
  }): void {
    this.database.transaction(() => {
      const current = this.database
        .prepare(
          `SELECT state,
                  provider_message_ts AS presentation_external_id,
                  tombstoned_at
             FROM authority_live_approval_outbox_v2
            WHERE approval_id = ?`,
        )
        .get(input.approval_id) as
        | {
            readonly state: string;
            readonly presentation_external_id: string | null;
            readonly tombstoned_at: string | null;
          }
        | undefined;
      if (
        current === undefined ||
        current.state !== "superseded" ||
        current.presentation_external_id !== input.presentation_external_id
      ) {
        throw new Error(
          "superseded presentation retirement lacks its durable identity",
        );
      }
      if (current.tombstoned_at !== null) return;
      const now = this.now();
      assertCanonicalUtcMillis(now);
      const update = this.database
        .prepare(
          `UPDATE authority_live_approval_outbox_v2
              SET tombstoned_at = ?, updated_at = ?
            WHERE approval_id = ? AND state = 'superseded'
              AND provider_message_ts = ? AND tombstoned_at IS NULL`,
        )
        .run(now, now, input.approval_id, input.presentation_external_id);
      if (update.changes !== 1) {
        throw new Error("superseded presentation retirement state drifted");
      }
    })();
  }

  async advanceCursor(input: {
    readonly expected_cursor: string;
    readonly next_cursor: string;
  }): Promise<"advanced" | "state_drift" | "revoked"> {
    // `advanceCursor` is public and can be called by a resumed worker before
    // it has re-read the admission. Revalidate the persisted adapter identities
    // before it mutates the checkpoint.
    const admission = this.admission();
    assertAdmissionAdapterIdentity(
      admission,
      this.sourceCursorPolicy,
      this.expectedProcessorAdapterId,
    );
    this.sourceCursorPolicy.assert_live_cursor(input.expected_cursor);
    this.sourceCursorPolicy.assert_live_cursor(input.next_cursor);
    if (input.next_cursor === input.expected_cursor) {
      throw new Error(
        "admitted meeting-processing cursor advance must change the cursor",
      );
    }
    const updatedAt = this.now();
    assertCanonicalUtcMillis(updatedAt);
    return this.database.transaction(() => {
      const update = this.database
        .prepare(
          `UPDATE authority_live_source_progress_v2
              SET cursor = ?, cursor_version = cursor_version + 1, updated_at = ?
            WHERE singleton = 1
              AND cursor = ?
              AND EXISTS (
                SELECT 1
                  FROM authority_live_source_admission_v2 AS admission
                  JOIN authority_memberships AS membership
                    ON membership.membership_id = admission.membership_id
                   AND membership.organization_id = admission.organization_id
                   AND membership.principal_id = admission.principal_id
                   AND membership.membership_type = admission.membership_type
                 WHERE admission.semantic_input_sha256 =
                       authority_live_source_progress_v2.admission_semantic_input_sha256
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
  ): ApprovalWorkflowOutboxV1 | undefined {
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
                outbox.provider_message_ts AS presentation_external_id,
                outbox.frozen_card_sha256,
                outbox.approved_snapshot_json, outbox.approved_snapshot_sha256,
                outbox.post_started_at,
                CASE WHEN outbox.state = 'staged' THEN outbox.updated_at
                     ELSE NULL END AS durable_staged_at,
                outbox.control_approval_sha256,
                outbox.superseded_by_candidate_id, outbox.superseded_at,
                outbox.tombstoned_at
           FROM authority_live_source_candidates_v2 AS candidate
           JOIN authority_live_approval_outbox_v2 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE outbox.approval_id = ?`,
      )
      .get(approvalId) as ApprovalWorkflowOutboxV1 | undefined;
  }

  /**
   * Returns only the durable Authority acknowledgement time used to restore
   * an optional staging-side human-wait observation. This deliberately avoids
   * loading the frozen approval snapshot or any presentation content.
   */
  readDurableCardStagedAt(approvalId: string): string | null {
    const row = this.database
      .prepare(
        `SELECT updated_at
           FROM authority_live_approval_outbox_v2
          WHERE approval_id = ?
            AND state = 'staged'`,
      )
      .get(approvalId) as { readonly updated_at: string } | undefined;
    if (row === undefined) return null;
    assertCanonicalUtcMillis(row.updated_at);
    return row.updated_at;
  }

  readApprovalDeliveryQuarantine(
    candidateId: string,
  ): ApprovalDeliveryQuarantineV1 | undefined {
    return this.database
      .prepare(
        `SELECT candidate_id, reason_code, quarantined_at
           FROM authority_live_approval_delivery_quarantines_v1
          WHERE candidate_id = ?`,
      )
      .get(candidateId) as ApprovalDeliveryQuarantineV1 | undefined;
  }

  quarantineApprovalDelivery(input: {
    readonly candidate_id: string;
    readonly reason_code: ApprovalDeliveryQuarantineReasonV1;
  }): ApprovalDeliveryQuarantineV1 {
    return this.database.transaction(() => {
      const existing = this.readApprovalDeliveryQuarantine(input.candidate_id);
      if (existing !== undefined) {
        if (existing.reason_code !== input.reason_code) {
          throw new Error(
            "approval delivery quarantine conflicts with its durable reason",
          );
        }
        return existing;
      }
      const outbox = this.outbox(input.candidate_id);
      if (outbox.state !== "queued") {
        throw new Error(
          "approval delivery can only be quarantined before presentation starts",
        );
      }
      const quarantinedAt = this.now();
      assertCanonicalUtcMillis(quarantinedAt);
      this.database
        .prepare(
          `INSERT INTO authority_live_approval_delivery_quarantines_v1 (
             candidate_id, reason_code, quarantined_at
           ) VALUES (?, ?, ?)`,
        )
        .run(input.candidate_id, input.reason_code, quarantinedAt);
      const quarantined = this.readApprovalDeliveryQuarantine(
        input.candidate_id,
      );
      if (quarantined === undefined) {
        throw new Error("approval delivery quarantine was not persisted");
      }
      return quarantined;
    })();
  }

  private readFrozenCandidateById(
    candidateId: string,
  ): FrozenMeetingProcessingCandidateSnapshotV1 | undefined {
    const row = this.database
      .prepare(
        `SELECT candidate.candidate_semantic_sha256,
                candidate.source_cursor, candidate.meeting_sha256,
                candidate.meeting_json, candidate.decisions_sha256,
                candidate.decisions_json,
                admission.source_adapter_id,
                admission.source_adapter_instance_id AS source_instance_id,
                admission.source_adapter_version,
                admission.cutoff_at, admission.processor_adapter_id,
                admission.processor_instance_id,
                admission.processor_adapter_version,
                admission.processor_configuration_sha256
           FROM authority_live_source_candidates_v2 AS candidate
           JOIN authority_live_source_admission_v2 AS admission
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
          readonly source_adapter_id: string;
          readonly source_adapter_version: string;
          readonly cutoff_at: string;
          readonly processor_adapter_id: string;
          readonly processor_instance_id: string;
          readonly processor_adapter_version: string;
          readonly processor_configuration_sha256: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    const candidate = this.candidate(row.candidate_semantic_sha256);
    if (candidate === undefined) {
      throw new Error("frozen candidate is absent");
    }
    const meeting = JSON.parse(row.meeting_json) as MeetingDocument;
    const decisions = JSON.parse(row.decisions_json) as DecisionSet;
    if (
      canonicalJson(meeting) !== row.meeting_json ||
      canonicalSha256(meeting) !== row.meeting_sha256 ||
      canonicalJson(decisions) !== row.decisions_json ||
      canonicalSha256(decisions) !== row.decisions_sha256
    ) {
      throw new Error("frozen candidate snapshot digest is invalid");
    }
    const syntheticCanary = isStagingSyntheticMeetingCanaryV1(
      meeting,
      row.source_cursor,
    );
    const admission: AdmittedMeetingProcessingAdmissionV1 = {
      source: {
        adapter_id: syntheticCanary
          ? meeting.provenance.source.adapter_id
          : row.source_adapter_id,
        instance_id: syntheticCanary
          ? meeting.provenance.source.instance_id
          : row.source_instance_id,
        version: syntheticCanary
          ? meeting.provenance.source.version
          : row.source_adapter_version,
        cursor: row.source_cursor,
        cutoff_at: row.cutoff_at,
      },
      processor: {
        adapter_id: row.processor_adapter_id,
        instance_id: row.processor_instance_id,
        version: row.processor_adapter_version,
        configuration_sha256: row.processor_configuration_sha256,
      },
    };
    if (syntheticCanary) {
      assertStagingSyntheticMeetingCanaryV1(meeting);
      if (admission.processor.adapter_id !== this.expectedProcessorAdapterId) {
        throw new Error("admission processor differs from its configured processor");
      }
    } else {
      assertAdmissionSnapshot(
        admission,
        this.sourceCursorPolicy,
        this.expectedProcessorAdapterId,
      );
      assertCanonicalMeetingDocument(meeting, {
        kind: "meeting-source",
        adapter_id: admission.source.adapter_id,
        instance_id: admission.source.instance_id,
        version: admission.source.version,
      });
    }
    assertCanonicalDecisionSet(decisions, meeting, {
      kind: "decision-processor",
      adapter_id: admission.processor.adapter_id,
      instance_id: admission.processor.instance_id,
      version: admission.processor.version,
    });
    return { ...candidate, admission, meeting, decisions } as FrozenMeetingProcessingCandidateSnapshotV1;
  }

  /** Revalidates the exact Authority snapshot which a D2 approval resolved. */
  readFrozenCandidateForApproval(
    approvalId: string,
  ): FrozenMeetingProcessingCandidateForApprovalV1 | undefined {
    return this.database.transaction(() => {
      const outbox = this.readCandidateByApprovalId(approvalId);
      if (outbox === undefined) return undefined;
      if (
        this.readApprovalDeliveryQuarantine(outbox.candidate_id) !== undefined
      ) {
        return undefined;
      }
      const frozen = this.readFrozenCandidateById(outbox.candidate_id);
      if (frozen === undefined || frozen.disposition !== "actionable") {
        throw new Error("D2 approval has no frozen actionable candidate");
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
        throw new Error("frozen approved snapshot digest is invalid");
      }
      return {
        ...frozen,
        ...outbox,
        approved_snapshot: approvedSnapshot,
      };
    })();
  }

  /**
   * Persist the exact presentation payload before any external side effect. Recovery must
   * prove the same frozen payload; it can never silently construct a new one.
   */
  prepareApprovalPost(input: {
    readonly candidate_id: string;
    readonly frozen_card_sha256: string;
    readonly approved_snapshot: Readonly<Record<string, unknown>>;
  }): PreparedPrivateApprovalPostV1 {
    return this.database.transaction(() => {
      if (
        this.readApprovalDeliveryQuarantine(input.candidate_id) !== undefined
      ) {
        throw new Error("approval delivery is quarantined");
      }
      const current = this.outbox(input.candidate_id);
      const snapshotJson = canonicalJson(input.approved_snapshot);
      const snapshotSha256 = canonicalSha256(input.approved_snapshot);
      if (current.state === "queued") {
        const now = this.now();
        assertCanonicalUtcMillis(now);
        const updated = this.database
          .prepare(
            `UPDATE authority_live_approval_outbox_v2
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
          throw new Error("approval workflow post intent state drifted");
        }
        return { outbox: this.outbox(input.candidate_id), created: true };
      }
      if (
        current.frozen_card_sha256 !== input.frozen_card_sha256 ||
        current.approved_snapshot_json !== snapshotJson ||
        current.approved_snapshot_sha256 !== snapshotSha256
      ) {
        throw new Error("approval workflow post intent conflicts with its durable outbox");
      }
      return { outbox: current, created: false };
    })();
  }

  /**
   * Release a durable delivery attempt only after its adapter explicitly
   * permits a retry. The frozen attempt timestamp is the compare-and-swap
   * token, so an old runner cannot release a newer attempt for the same
   * candidate.
   */
  releaseApprovalPostAttempt(input: {
    readonly candidate_id: string;
    readonly post_started_at: string;
  }): ApprovalWorkflowOutboxV1 {
    return this.database.transaction(() => {
      assertCanonicalUtcMillis(input.post_started_at);
      const current = this.outbox(input.candidate_id);
      if (current.state === "queued") return current;
      if (
        current.state === "superseded" &&
        current.presentation_external_id === null &&
        current.post_started_at === null
      ) {
        return current;
      }
      if (current.presentation_external_id !== null) {
        throw new Error(
          "approval workflow post attempt is externally visible",
        );
      }
      if (current.post_started_at !== input.post_started_at) {
        throw new Error("approval workflow post attempt is stale");
      }
      if (
        current.state === "superseded" &&
        current.control_approval_sha256 === null
      ) {
        const now = this.now();
        assertCanonicalUtcMillis(now);
        const updated = this.database
          .prepare(
            `UPDATE authority_live_approval_outbox_v2
                SET frozen_card_sha256 = NULL,
                    approved_snapshot_json = NULL,
                    approved_snapshot_sha256 = NULL,
                    post_started_at = NULL, updated_at = ?
              WHERE candidate_id = ? AND state = 'superseded'
                AND provider_message_ts IS NULL
                AND post_started_at = ?
                AND control_approval_sha256 IS NULL`,
          )
          .run(now, input.candidate_id, input.post_started_at);
        if (updated.changes !== 1) {
          throw new Error(
            "superseded approval post attempt state drifted",
          );
        }
        return this.outbox(input.candidate_id);
      }
      if (current.state !== "posting") {
        throw new Error(
          "approval workflow post attempt lacks a releasable unresolved delivery",
        );
      }
      const now = this.now();
      assertCanonicalUtcMillis(now);
      const updated = this.database
        .prepare(
          `UPDATE authority_live_approval_outbox_v2
              SET state = 'queued', frozen_card_sha256 = NULL,
                  approved_snapshot_json = NULL,
                  approved_snapshot_sha256 = NULL,
                  post_started_at = NULL, updated_at = ?
            WHERE candidate_id = ? AND state = 'posting'
              AND provider_message_ts IS NULL
              AND post_started_at = ?`,
        )
        .run(now, input.candidate_id, input.post_started_at);
      if (updated.changes !== 1) {
        throw new Error("approval workflow post attempt state drifted");
      }
      return this.outbox(input.candidate_id);
    })();
  }

  recordPostedApprovalCard(
    input: PostedPrivateApprovalCardV1,
  ): ApprovalWorkflowOutboxV1 {
    return this.database.transaction(() => {
      assertCanonicalUtcMillis(input.post_started_at);
      const current = this.outbox(input.candidate_id);
      const snapshotJson = canonicalJson(input.approved_snapshot);
      const snapshotSha256 = canonicalSha256(input.approved_snapshot);
      if (current.state !== "posting") {
        if (
          current.presentation_external_id === input.presentation_external_id &&
          current.post_started_at === input.post_started_at &&
          current.frozen_card_sha256 === input.frozen_card_sha256 &&
          current.approved_snapshot_json === snapshotJson &&
          current.approved_snapshot_sha256 === snapshotSha256
        ) {
          return current;
        }
        if (
          current.state === "superseded" &&
          current.presentation_external_id === null &&
          current.frozen_card_sha256 === input.frozen_card_sha256 &&
          current.approved_snapshot_json === snapshotJson &&
          current.approved_snapshot_sha256 === snapshotSha256 &&
          current.post_started_at === input.post_started_at
        ) {
          const now = this.now();
          assertCanonicalUtcMillis(now);
          this.database
            .prepare(
              `UPDATE authority_live_approval_outbox_v2
                  SET provider_message_ts = ?,
                      updated_at = ?
                WHERE candidate_id = ? AND state = 'superseded'
                  AND provider_message_ts IS NULL
                  AND post_started_at = ?`,
            )
            .run(
              input.presentation_external_id,
              now,
              input.candidate_id,
              input.post_started_at,
            );
          return this.outbox(input.candidate_id);
        }
        throw new Error(
          "approval workflow card conflicts with its durable outbox",
        );
      }
      const now = this.now();
      assertCanonicalUtcMillis(now);
      const updated = this.database
        .prepare(
          `UPDATE authority_live_approval_outbox_v2
              SET state = 'posted', provider_message_ts = ?,
                  updated_at = ?
            WHERE candidate_id = ? AND state = 'posting'
              AND post_started_at = ?`,
        )
        .run(
          input.presentation_external_id,
          now,
          input.candidate_id,
          input.post_started_at,
        );
      if (updated.changes !== 1) {
        throw new Error("approval workflow post result is stale");
      }
      return this.outbox(input.candidate_id);
    })();
  }

  markControlPlaneStaged(input: {
    readonly candidate_id: string;
    readonly control_approval_sha256: string;
  }): ApprovalWorkflowOutboxV1 {
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
          "approval-workflow control approval conflicts with its durable outbox",
        );
      }
      if (current.state === "superseded") {
        if (
          current.presentation_external_id === null ||
          current.frozen_card_sha256 === null ||
          current.approved_snapshot_sha256 === null
        ) {
          throw new Error(
            "superseded D2 approval has no frozen posted card",
          );
        }
        const now = this.now();
        assertCanonicalUtcMillis(now);
        this.database
          .prepare(
            `UPDATE authority_live_approval_outbox_v2
                SET control_approval_sha256 = ?, updated_at = ?
              WHERE candidate_id = ? AND state = 'superseded'
                AND control_approval_sha256 IS NULL`,
          )
          .run(input.control_approval_sha256, now, input.candidate_id);
        return this.outbox(input.candidate_id);
      }
      if (current.state !== "posted") {
        throw new Error(
          "approval workflow card must be posted before control staging",
        );
      }
      const now = this.now();
      assertCanonicalUtcMillis(now);
      this.database
        .prepare(
          `UPDATE authority_live_approval_outbox_v2
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
        `SELECT source_adapter_id,
                source_adapter_instance_id AS source_instance_id,
                source_adapter_version, initial_cursor AS cursor, cutoff_at,
                processor_adapter_id, processor_instance_id,
                processor_adapter_version,
                processor_configuration_sha256,
                semantic_input_sha256, admitted_at,
                membership.status AS membership_status
           FROM authority_live_source_admission_v2 AS admission
           JOIN authority_memberships AS membership
             ON membership.membership_id = admission.membership_id
            AND membership.organization_id = admission.organization_id
            AND membership.principal_id = admission.principal_id
            AND membership.membership_type = admission.membership_type
          WHERE admission.singleton = 1`,
      )
      .get() as AdmissionRow | undefined;
    if (admission === undefined) {
      throw new Error("admitted meeting-processing has not been admitted");
    }
    return admission;
  }

  private progress(admissionSemanticSha256: string): ProgressRow {
    const progress = this.database
      .prepare(
        `SELECT cursor
           FROM authority_live_source_progress_v2
          WHERE singleton = 1 AND admission_semantic_input_sha256 = ?`,
      )
      .get(admissionSemanticSha256) as ProgressRow | undefined;
    if (progress === undefined) {
      throw new Error(
        "admitted meeting-processing progress has not been initialized",
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
                COALESCE(outbox.state, candidate.disposition) AS state,
                CASE WHEN outbox.state = 'staged' THEN outbox.updated_at
                     ELSE NULL END AS durable_staged_at
           FROM authority_live_source_candidates_v2 AS candidate
           LEFT JOIN authority_live_approval_outbox_v2 AS outbox
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
           FROM authority_live_source_review_lineage_heads_v2 AS head
           JOIN authority_live_source_candidates_v2 AS candidate
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
        `UPDATE authority_live_approval_outbox_v2
            SET state = 'superseded', superseded_by_candidate_id = ?,
                superseded_at = ?, updated_at = ?
          WHERE candidate_id IN (
            SELECT candidate_id
              FROM authority_live_source_candidates_v2
             WHERE review_lineage_id = ?
          )
            AND state != 'superseded'
            AND NOT EXISTS (
              SELECT 1
                FROM authority_private_approval_terminal_receipts_v3 AS terminal
               WHERE terminal.approval_id = authority_live_approval_outbox_v2.approval_id
            )`,
      )
      .run(successorCandidateId, supersededAt, supersededAt, reviewLineageId);
  }

  private outbox(candidateId: string): ApprovalWorkflowOutboxV1 {
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
                outbox.provider_message_ts AS presentation_external_id,
                outbox.frozen_card_sha256,
                outbox.approved_snapshot_json, outbox.approved_snapshot_sha256,
                outbox.post_started_at,
                CASE WHEN outbox.state = 'staged' THEN outbox.updated_at
                     ELSE NULL END AS durable_staged_at,
                outbox.control_approval_sha256,
                outbox.superseded_by_candidate_id, outbox.superseded_at,
                outbox.tombstoned_at
           FROM authority_live_source_candidates_v2 AS candidate
           JOIN authority_live_approval_outbox_v2 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE candidate.candidate_id = ?`,
      )
      .get(candidateId) as ApprovalWorkflowOutboxV1 | undefined;
    if (outbox === undefined)
      throw new Error("approval workflow outbox is absent");
    return outbox;
  }
}

function assertAdmissionSnapshot(
  admission: AdmittedMeetingProcessingAdmissionV1,
  sourceCursorPolicy: AdmittedMeetingSourceCursorPolicyV1,
  expectedProcessorAdapterId: string,
): void {
  if (admission.source.adapter_id !== sourceCursorPolicy.source_adapter_id) {
    throw new Error(
      "admitted meeting-processing admission adapter differs from its configured boundary",
    );
  }
  if (admission.processor.adapter_id !== expectedProcessorAdapterId) {
    throw new Error(
      "admitted meeting-processing admission processor differs from its configured processor",
    );
  }
  assertCanonicalUtcMillis(admission.source.cutoff_at);
  sourceCursorPolicy.assert_live_cursor(admission.source.cursor);
}

function assertAdmissionAdapterIdentity(
  row: AdmissionRow,
  sourceCursorPolicy: AdmittedMeetingSourceCursorPolicyV1,
  expectedProcessorAdapterId: string,
): void {
  if (row.source_adapter_id !== sourceCursorPolicy.source_adapter_id) {
    throw new Error(
      "admitted meeting-processing admission adapter differs from its configured boundary",
    );
  }
  if (row.processor_adapter_id !== expectedProcessorAdapterId) {
    throw new Error(
      "admitted meeting-processing admission processor differs from its configured processor",
    );
  }
}
