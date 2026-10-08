import { pendingApprovalDeliveryLimitV1, type ApprovalWorkflowOutboxV1, type FreezeApprovalProposalInputV1, type FrozenMeetingProcessingCandidateForApprovalV1, type ApprovalWorkflowStateV1, type ListPendingApprovalDeliveriesOptionsV1 } from "./approval-workflow-state-v1.js";
import type Database from "better-sqlite3";
import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import {
  assertCanonicalDecisionSet,
  assertCanonicalMeetingDocument,
  type AdapterIdentity,
  type DecisionSet,
  type MeetingDocument,
  meetingSourceEnvelopeV1, sourceContentSha256V1,
} from "../core/index.js";

/** Exact retained revision commitment shared by every approval surface's transcript choice. */
export function retainedMeetingSourceCoordinateV1(database: Database.Database, organizationId: string, meeting: MeetingDocument) {
  const source = meetingSourceEnvelopeV1(meeting);
  const row = database.prepare('SELECT revision_sha256 FROM authority_source_revisions_v1 WHERE organization_id=? AND source_id=? AND revision_id=?')
    .get(organizationId, source.item.source_id, source.revision.revision_id) as { revision_sha256: string } | undefined;
  const { captured_at: _capturedAt, ...immutable } = source.revision;
  if (!row || !/^[a-f0-9]{64}$/.test(row.revision_sha256) || row.revision_sha256 !== sourceContentSha256V1(immutable)) return undefined;
  return Object.freeze({ source_id: source.item.source_id, revision_id: source.revision.revision_id, source_sha256: `sha256:${row.revision_sha256}` as const });
}
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
  FrozenMeetingProcessingCandidateSnapshotV1,
  MeetingProcessingCandidateSnapshotInputV1,
  MeetingProcessingCandidateV1,
  AuthorityMeetingProcessingStateV1,
} from "./meeting-processing-cycle-v1.js";

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
  readonly state: "queued" | "staged" | "superseded" | "coalesced" | "no_signals";
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
export class SqliteAuthorityMeetingProcessingStateV1 implements AuthorityMeetingProcessingStateV1, ApprovalWorkflowStateV1 {
  constructor(
    private readonly database: Database.Database,
    private readonly sourceCursorPolicy: AdmittedMeetingSourceCursorPolicyV1,
    /**
     * The caller must name the processor adapter selected by its runtime
     * bundle. An admitted source cannot be reopened through a different
     * decision processor implementation by accident.
     */
    private readonly expectedProcessorAdapterId: string,
    private readonly now: () => string = () => new Date().toISOString(),
    /** The personal source this state reads and writes; every source names its own key. */
    private readonly sourceKey: string,
    private readonly requireSourceCurrent: () => void = () => {},
    /**
     * Runs inside the cursor-advance transaction, after the compare-and-set succeeds, so a source can
     * settle what the advance consumed atomically with it. A throw rolls the advance back.
     */
    private readonly afterCursorAdvance: (transition: { readonly expected_cursor: string; readonly next_cursor: string }) => void = () => {},
  ) {
    if (expectedProcessorAdapterId.trim().length === 0) {
      throw new Error(
        "admitted meeting-processing expected processor adapter identity is invalid",
      );
    }
  }

  async readAdmission(): Promise<AdmittedMeetingProcessingAdmissionV1> {
    return this.database.transaction(() => {
      const admission = this.activeAdmission();
      this.database
        .prepare(
          `INSERT INTO authority_live_source_progress_v2 (
             source_key, admission_semantic_input_sha256, cursor,
             cursor_version, updated_at
           ) VALUES (?, ?, ?, 0, ?)
           ON CONFLICT (source_key) DO NOTHING`,
        )
        .run(
          this.sourceKey,
          admission.semantic_input_sha256,
          admission.cursor,
          admission.admitted_at,
        );
      const progress = this.database
        .prepare(
          `SELECT cursor
             FROM authority_live_source_progress_v2
            WHERE source_key = ?
              AND admission_semantic_input_sha256 = ?`,
        )
        .get(this.sourceKey, admission.semantic_input_sha256) as ProgressRow | undefined;
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

  /**
   * Recheck custody after an awaited provider pull, inside the transaction that
   * will retain the source. This closes revocation between readAdmission and
   * source admission without coupling the generic store to meeting policy.
   */
  assertCurrentSourceAdmission(expectedSource: AdapterIdentity): void {
    if (!this.database.inTransaction) throw new Error("source admission guard requires the custody transaction");
    this.requireSourceCurrent();
    const admission = this.activeAdmission();
    const current = admissionFrom(
      admission,
      this.progress(admission.semantic_input_sha256),
      this.sourceCursorPolicy,
      this.expectedProcessorAdapterId,
    );
    if (
      expectedSource.kind !== "meeting-source" ||
      expectedSource.adapter_id !== current.source.adapter_id ||
      expectedSource.instance_id !== current.source.instance_id ||
      expectedSource.version !== current.source.version
    ) throw new Error("source custody differs from the current admitted source identity");
  }

  async stageCandidate(
    input: MeetingProcessingCandidateSnapshotInputV1,
  ): Promise<MeetingProcessingCandidateV1> {
    return this.database.transaction(() => {
      this.requireSourceCurrent();
      const admission = this.activeAdmission();
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
      assertCanonicalMeetingDocument(input.meeting, {
        kind: "meeting-source",
        adapter_id: current.source.adapter_id,
        instance_id: current.source.instance_id,
        version: current.source.version,
      });
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

      const now = this.canonicalNow();
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
    }).immediate();
  }

  async readFrozenCandidateForSourceRevision(input: {
    readonly external_id: string;
    readonly canonical_revision: string;
  }): Promise<FrozenMeetingProcessingCandidateSnapshotV1 | undefined> {
    return this.database.transaction(() => {
      const admission = this.activeAdmission();
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
      const admission = this.activeAdmission();
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
              AND candidate.review_input_sha256 = ? AND candidate.admission_semantic_input_sha256 = (SELECT semantic_input_sha256 FROM authority_live_source_admission_v2 WHERE source_key = ?)
            ORDER BY candidate.created_at ASC
            `,
        )
        .get(input.review_lineage_id, input.review_input_sha256, this.sourceKey) as
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
            AND candidate.admission_semantic_input_sha256 = (SELECT semantic_input_sha256 FROM authority_live_source_admission_v2 WHERE source_key = ?)
            AND outbox.state != 'superseded'
            AND head.candidate_id = candidate.candidate_id`,
      )
      .get(approvalId, this.sourceKey) as { readonly 1: number } | undefined;
    return row !== undefined;
  }

  listPendingApprovalDeliveries(
    options: ListPendingApprovalDeliveriesOptionsV1 = {},
  ): readonly FrozenMeetingProcessingCandidateForApprovalV1[] {
    if (options.source_key !== undefined && options.source_key !== this.sourceKey) return [];
    return pendingApprovalIdsV1(this.database, { source_key: this.sourceKey, limit: options.limit })
      .map((approvalId) => {
        const candidate = this.readFrozenCandidateForApproval(approvalId);
        if (candidate === undefined) {
          throw new Error("pending approval delivery is absent");
        }
        return candidate;
      });
  }

  /**
   * Freezes one proposal: queued -> staged in one guarded UPDATE that writes the
   * snapshot, its digest and the suggested projects together. A staged proposal
   * returns as is when the snapshot bytes match (its suggestions stay as first
   * frozen) and throws otherwise; a superseded proposal returns as is.
   */
  freezeProposal(input: FreezeApprovalProposalInputV1): ApprovalWorkflowOutboxV1 {
    return this.database.transaction(() => {
      const current = this.outbox(input.candidate_id);
      const projects = input.suggested_project_ids as unknown;
      if (
        input.approved_snapshot === null || typeof input.approved_snapshot !== "object" ||
        input.approved_snapshot.approval_id !== current.approval_id ||
        !Array.isArray(projects) || projects.length > 20 ||
        !projects.every((project, index) => typeof project === "string" &&
          (index === 0 || (projects[index - 1] as string) < project))
      ) {
        throw new Error("approval proposal freeze input is invalid");
      }
      const snapshotJson = canonicalJson(input.approved_snapshot);
      const snapshotSha256 = canonicalSha256(input.approved_snapshot);
      if (current.state === "queued") {
        const now = this.canonicalNow();
        const update = this.database
          .prepare(
            `UPDATE authority_live_approval_outbox_v2
                SET state = 'staged', approved_snapshot_json = ?, approved_snapshot_sha256 = ?,
                    suggested_projects_json = ?, updated_at = ?
              WHERE candidate_id = ? AND state = 'queued'`,
          )
          .run(snapshotJson, snapshotSha256, canonicalJson(projects as string[]), now, input.candidate_id);
        if (update.changes !== 1) throw new Error("approval proposal freeze state drifted");
        return this.outbox(input.candidate_id);
      }
      if (current.state === "staged") {
        if (current.approved_snapshot_json !== snapshotJson || current.approved_snapshot_sha256 !== snapshotSha256) {
          throw new Error("approval proposal conflicts with its frozen snapshot");
        }
        return current;
      }
      return current;
    }).immediate();
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
    const updatedAt = this.canonicalNow();
    return this.database.transaction(() => {
      this.requireSourceCurrent();
      const update = this.database
        .prepare(
          `UPDATE authority_live_source_progress_v2
              SET cursor = ?, cursor_version = cursor_version + 1, updated_at = ?
            WHERE source_key = ?
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
        .run(input.next_cursor, updatedAt, this.sourceKey, input.expected_cursor);
      if (update.changes === 1) {
        this.afterCursorAdvance({ expected_cursor: input.expected_cursor, next_cursor: input.next_cursor });
        return "advanced" as const;
      }

      const admission = this.admission();
      return admission.membership_status === "active"
        ? "state_drift"
        : "revoked";
    })();
  }

  readCandidateByApprovalId(
    approvalId: string,
  ): ApprovalWorkflowOutboxV1 | undefined {
    return this.findOutbox("approval_id", approvalId);
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
          WHERE candidate.candidate_id = ? AND admission.source_key = ?`,
      )
      .get(candidateId, this.sourceKey) as
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
    const admission: AdmittedMeetingProcessingAdmissionV1 = {
      source: {
        adapter_id: row.source_adapter_id,
        instance_id: row.source_instance_id,
        version: row.source_adapter_version,
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
          WHERE admission.source_key = ?`,
      )
      .get(this.sourceKey) as AdmissionRow | undefined;
    if (admission === undefined) {
      throw new Error("admitted meeting-processing has not been admitted");
    }
    return admission;
  }

  private activeAdmission(): AdmissionRow {
    const admission = this.admission();
    if (admission.membership_status !== "active") {
      throw new AuthorityMeetingProcessingRevokedError();
    }
    return admission;
  }

  /** The store clock, rejected unless it is a canonical UTC-millisecond timestamp. */
  private canonicalNow(): string {
    const now = this.now();
    assertCanonicalUtcMillis(now);
    return now;
  }

  private progress(admissionSemanticSha256: string): ProgressRow {
    const progress = this.database
      .prepare(
        `SELECT cursor
           FROM authority_live_source_progress_v2
          WHERE source_key = ? AND admission_semantic_input_sha256 = ?`,
      )
      .get(this.sourceKey, admissionSemanticSha256) as ProgressRow | undefined;
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
                COALESCE(outbox.state, candidate.disposition) AS state
           FROM authority_live_source_candidates_v2 AS candidate
           LEFT JOIN authority_live_approval_outbox_v2 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE candidate.candidate_semantic_sha256 = ? AND candidate.admission_semantic_input_sha256 = (SELECT semantic_input_sha256 FROM authority_live_source_admission_v2 WHERE source_key = ?)`,
      )
      .get(semanticSha256, this.sourceKey) as CandidateRow | undefined;
  }

  private lineageHead(reviewLineageId: string): LineageHeadRow | undefined {
    return this.database
      .prepare(
        `SELECT head.review_lineage_id, head.candidate_id,
                candidate.review_semantic_sha256
           FROM authority_live_source_review_lineage_heads_v2 AS head
           JOIN authority_live_source_candidates_v2 AS candidate
             ON candidate.candidate_id = head.candidate_id
          WHERE head.review_lineage_id = ? AND candidate.admission_semantic_input_sha256 = (SELECT semantic_input_sha256 FROM authority_live_source_admission_v2 WHERE source_key = ?)`,
      )
      .get(reviewLineageId, this.sourceKey) as LineageHeadRow | undefined;
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
              SELECT 1 FROM authority_approval_decisions_v1 AS decision
               WHERE decision.approval_id = authority_live_approval_outbox_v2.approval_id
            )`,
      )
      .run(successorCandidateId, supersededAt, supersededAt, reviewLineageId);
  }

  private outbox(candidateId: string): ApprovalWorkflowOutboxV1 {
    const outbox = this.findOutbox("candidate_id", candidateId);
    if (outbox === undefined)
      throw new Error("approval workflow outbox is absent");
    return outbox;
  }

  private findOutbox(
    key: "approval_id" | "candidate_id",
    value: string,
  ): ApprovalWorkflowOutboxV1 | undefined {
    const column = key === "approval_id" ? "outbox.approval_id" : "candidate.candidate_id";
    const row = this.database
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
                outbox.approved_snapshot_json, outbox.approved_snapshot_sha256,
                outbox.suggested_projects_json,
                outbox.superseded_by_candidate_id, outbox.superseded_at
           FROM authority_live_source_candidates_v2 AS candidate
           JOIN authority_live_approval_outbox_v2 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE ${column} = ? AND candidate.admission_semantic_input_sha256 = (SELECT semantic_input_sha256 FROM authority_live_source_admission_v2 WHERE source_key = ?)`,
      )
      .get(value, this.sourceKey) as (Omit<ApprovalWorkflowOutboxV1, "suggested_project_ids"> & { readonly suggested_projects_json: string | null }) | undefined;
    if (row === undefined) return undefined;
    const { suggested_projects_json: suggested, ...outbox } = row;
    return { ...outbox, suggested_project_ids: suggestedProjectIdsFrom(suggested) };
  }
}

function suggestedProjectIdsFrom(json: string | null): readonly string[] | null {
  if (json === null) return null;
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value) || !value.every((project) => typeof project === "string")) {
    throw new Error("approval proposal suggested projects are invalid");
  }
  return Object.freeze(value as string[]);
}

/**
 * Queued, actionable lineage heads whose reviewer membership is active, oldest
 * first. `source_key` scopes to one source; `source_adapter_ids` (when given)
 * keeps only sources of the configured adapters.
 */
// Queued, never-frozen proposals that are their lineage's head and whose reviewer is still an active member.
const PENDING_APPROVALS_FROM_V1 = `FROM authority_live_approval_outbox_v2 AS outbox
         JOIN authority_live_source_candidates_v2 AS candidate ON candidate.candidate_id = outbox.candidate_id
         JOIN authority_live_source_review_lineage_heads_v2 AS head ON head.candidate_id = candidate.candidate_id
         JOIN authority_live_source_admission_v2 AS admission ON admission.semantic_input_sha256 = candidate.admission_semantic_input_sha256
         JOIN authority_memberships AS membership ON membership.membership_id = admission.membership_id
          AND membership.organization_id = admission.organization_id AND membership.principal_id = admission.principal_id
          AND membership.membership_type = admission.membership_type AND membership.status = 'active'
        WHERE outbox.state = 'queued' AND candidate.disposition = 'actionable'
          AND (? IS NULL OR admission.source_adapter_id IN (SELECT value FROM json_each(?)))`;

function pendingApprovalIdsV1(database: Database.Database, options: {
  readonly source_key?: string | undefined;
  readonly source_adapter_ids?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}): readonly string[] {
  const adapters = options.source_adapter_ids === undefined ? null : JSON.stringify(options.source_adapter_ids);
  const sourceKey = options.source_key ?? null;
  return database
    .prepare(
      `SELECT outbox.approval_id
         ${PENDING_APPROVALS_FROM_V1}
          AND (? IS NULL OR admission.source_key = ?)
        ORDER BY candidate.created_at ASC, candidate.candidate_id ASC
        LIMIT ?`,
    )
    .pluck()
    .all(adapters, adapters, sourceKey, sourceKey, pendingApprovalDeliveryLimitV1(options.limit)) as string[];
}

/**
 * Runtime-wide approval reads and freeze. Each call resolves the approval's (or
 * candidate's) admission source_key and source adapter, picks the configured
 * cursor policy for that adapter, and delegates to a per-source
 * SqliteAuthorityMeetingProcessingStateV1, so every frozen-row check stays in
 * force. Delegates never advance a cursor, so they carry no source-current or
 * after-advance hook. A source whose adapter has no configured policy is
 * invisible: reads return undefined, lists skip it, and a freeze throws.
 */
export class SqliteApprovalWorkflowStateV1 implements ApprovalWorkflowStateV1 {
  private readonly policies: ReadonlyMap<string, AdmittedMeetingSourceCursorPolicyV1>;
  private readonly processorAdapterId: string;
  private readonly now: (() => string) | undefined;

  constructor(
    private readonly database: Database.Database,
    options: {
      readonly source_cursor_policies: readonly AdmittedMeetingSourceCursorPolicyV1[];
      readonly processor_adapter_id: string;
      readonly now?: () => string;
    },
  ) {
    const policies = new Map(options.source_cursor_policies.map((policy) => [policy.source_adapter_id, policy] as const));
    if (policies.size !== options.source_cursor_policies.length) {
      throw new Error("approval workflow state needs distinct source adapters");
    }
    if (options.processor_adapter_id.trim().length === 0) {
      throw new Error("admitted meeting-processing expected processor adapter identity is invalid");
    }
    this.policies = policies;
    this.processorAdapterId = options.processor_adapter_id;
    this.now = options.now;
  }

  listPendingApprovalDeliveries(
    options: ListPendingApprovalDeliveriesOptionsV1 = {},
  ): readonly FrozenMeetingProcessingCandidateForApprovalV1[] {
    return pendingApprovalIdsV1(this.database, {
      source_key: options.source_key,
      source_adapter_ids: [...this.policies.keys()],
      limit: options.limit,
    }).map((approvalId) => {
      const candidate = this.route("approval_id", approvalId)?.readFrozenCandidateForApproval(approvalId);
      if (candidate === undefined) throw new Error("pending approval delivery is absent");
      return candidate;
    });
  }

  /**
   * Sources of configured adapters that hold a pending proposal (the same rows
   * listPendingApprovalDeliveries returns), sorted. One cheap read, so a runtime
   * can retry a failed freeze for a source that has no other work.
   */
  listPendingApprovalSourceKeys(): readonly string[] {
    const adapters = JSON.stringify([...this.policies.keys()]);
    return this.database
      .prepare(`SELECT DISTINCT admission.source_key ${PENDING_APPROVALS_FROM_V1} ORDER BY admission.source_key`)
      .pluck()
      .all(adapters, adapters) as string[];
  }

  readCandidateByApprovalId(approvalId: string): ApprovalWorkflowOutboxV1 | undefined {
    return this.route("approval_id", approvalId)?.readCandidateByApprovalId(approvalId);
  }

  readFrozenCandidateForApproval(approvalId: string): FrozenMeetingProcessingCandidateForApprovalV1 | undefined {
    return this.route("approval_id", approvalId)?.readFrozenCandidateForApproval(approvalId);
  }

  freezeProposal(input: FreezeApprovalProposalInputV1): ApprovalWorkflowOutboxV1 {
    const state = this.route("candidate_id", input.candidate_id);
    if (state === undefined) throw new Error("approval proposal source is not configured in this runtime");
    return state.freezeProposal(input);
  }

  private route(column: "approval_id" | "candidate_id", value: string): SqliteAuthorityMeetingProcessingStateV1 | undefined {
    const row = this.database
      .prepare(
        `SELECT admission.source_key, admission.source_adapter_id
           FROM authority_live_approval_outbox_v2 AS outbox
           JOIN authority_live_source_candidates_v2 AS candidate ON candidate.candidate_id = outbox.candidate_id
           JOIN authority_live_source_admission_v2 AS admission ON admission.semantic_input_sha256 = candidate.admission_semantic_input_sha256
          WHERE outbox.${column} = ?`,
      )
      .get(value) as { readonly source_key: string; readonly source_adapter_id: string } | undefined;
    const policy = row === undefined ? undefined : this.policies.get(row.source_adapter_id);
    if (row === undefined || policy === undefined) return undefined;
    return new SqliteAuthorityMeetingProcessingStateV1(this.database, policy, this.processorAdapterId, this.now, row.source_key);
  }
}

function assertAdmissionSnapshot(
  admission: AdmittedMeetingProcessingAdmissionV1,
  sourceCursorPolicy: AdmittedMeetingSourceCursorPolicyV1,
  expectedProcessorAdapterId: string,
): void {
  assertAdmissionAdapterIdentity(
    {
      source_adapter_id: admission.source.adapter_id,
      processor_adapter_id: admission.processor.adapter_id,
    },
    sourceCursorPolicy,
    expectedProcessorAdapterId,
  );
  assertCanonicalUtcMillis(admission.source.cutoff_at);
  sourceCursorPolicy.assert_live_cursor(admission.source.cursor);
}

function assertAdmissionAdapterIdentity(
  row: Pick<AdmissionRow, "source_adapter_id" | "processor_adapter_id">,
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
