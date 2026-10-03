import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterOperationContext,
  DecisionProcessorAdapter,
  MeetingBatch,
  MeetingDocument,
  MeetingPullRequest,
  MeetingSourceContentV1,
  MeetingSourceAdapter,
} from "@echo-brain/organization-processing/core";
import type { SourceAdmissionBindingV1 } from "@echo-brain/organization-processing/core/ports/source";
import {
  AdmittedMeetingProcessingCycleV1,
  type AdmittedMeetingProcessingAdmissionV1,
  type AdmittedMeetingProcessingCycleResultV1,
  type AuthorityMeetingProcessingStateV1,
  type ApprovalWorkflowStagerV1,
  type FrozenMeetingProcessingCandidateSnapshotV1,
  type MeetingProcessingCandidateSnapshotInputV1,
} from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1";
import type { AdmittedMeetingSourceCursorPolicyV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1";
import type { ExtractionAttemptStoreV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/extraction-attempt-store-v1";
import {
  createStagingSyntheticMeetingCanaryV1,
  createStagingSyntheticMeetingCanaryV2,
  assertStagingSyntheticMeetingCanary,
  isStagingSyntheticMeetingCanaryV1,
  stagingSyntheticMeetingCanaryCursorV1,
  stagingSyntheticMeetingCanaryCursorV2,
  stagingSyntheticMeetingCanarySourceIdentityV1,
  type StagingSyntheticMeetingCanaryInputV1,
  type StagingSyntheticMeetingCanaryResultV1,
} from "@echo-brain/organization-processing/admitted-meeting-processing/staging-synthetic-meeting-canary-v1";
import type { MeetingApprovalJourneyTelemetryPortV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1";
import { SqliteAuthorityMeetingProcessingStateV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1";

export interface RunStagingSyntheticPrivateDmCanaryV1Input {
  /** Must be the public staging Authority origin, never a production URL. */
  readonly authority_url: string;
  readonly canary: StagingSyntheticMeetingCanaryInputV1;
  readonly state: SqliteAuthorityMeetingProcessingStateV1;
  /** The same custody store used by the live Granola cycle, with a staging canary fence. */
  readonly source_ingestion: SourceAdmissionBindingV1<MeetingSourceContentV1>;
  readonly processor: DecisionProcessorAdapter;
  readonly stager: ApprovalWorkflowStagerV1;
  /** The same durable automatic-spend guard used by normal meeting intake. */
  readonly extraction_attempts?: ExtractionAttemptStoreV1;
  /** Optional staging-only observer. It never changes canary behavior. */
  readonly journey_telemetry?: MeetingApprovalJourneyTelemetryPortV1;
  readonly signal?: AbortSignal;
}

function assertStagingAuthorityUrl(authorityUrl: string): void {
  if (authorityUrl !== "https://authority-staging.echobrain.org") {
    throw new Error("synthetic private-DM canary is staging-only");
  }
}

/** A fixed one-item page with no next cursor: it cannot advance Granola. */
class StagingSyntheticCanarySourceV1 implements MeetingSourceAdapter {
  readonly identity = stagingSyntheticMeetingCanarySourceIdentityV1;
  constructor(private readonly meeting: MeetingDocument, private readonly cursor: string) {}
  validateConfig(_config: AdapterConfig): AdapterConfigValidation { return { ok: true, errors: [] }; }
  async healthCheck(_context?: AdapterOperationContext): Promise<AdapterHealth> {
    return { status: "healthy", checked_at: this.meeting.provenance.observed_at, message: "fixed staging synthetic canary" };
  }
  async pull(request: MeetingPullRequest): Promise<MeetingBatch> {
    if (request.cursor !== this.cursor || request.limit !== 1) {
      throw new Error("staging synthetic canary pull differs from its fixed source page");
    }
    return { meetings: [this.meeting] };
  }
}

function canaryCursorPolicy(cursor: string): AdmittedMeetingSourceCursorPolicyV1 {
  return Object.freeze({
    source_adapter_id: stagingSyntheticMeetingCanarySourceIdentityV1.adapter_id,
    assert_live_cursor(value: string): void {
      if (value !== cursor) throw new Error("staging synthetic canary cursor differs from its fixed source page");
    },
  });
}

/** The shared cycle sees a synthetic source; durable candidate writes retain the real admission fence. */
class StagingSyntheticCanaryStateV1 implements AuthorityMeetingProcessingStateV1 {
  private readonly syntheticAdmission: AdmittedMeetingProcessingAdmissionV1;
  constructor(
    private readonly delegate: SqliteAuthorityMeetingProcessingStateV1,
    private readonly baseAdmission: AdmittedMeetingProcessingAdmissionV1,
    private readonly cursor: string,
    private readonly canary: StagingSyntheticMeetingCanaryInputV1,
  ) {
    this.syntheticAdmission = Object.freeze({
      source: Object.freeze({
        adapter_id: stagingSyntheticMeetingCanarySourceIdentityV1.adapter_id,
        instance_id: stagingSyntheticMeetingCanarySourceIdentityV1.instance_id,
        version: stagingSyntheticMeetingCanarySourceIdentityV1.version,
        cursor,
        cutoff_at: baseAdmission.source.cutoff_at,
      }),
      processor: baseAdmission.processor,
    });
  }
  async readAdmission(): Promise<AdmittedMeetingProcessingAdmissionV1> { return this.syntheticAdmission; }
  readFrozenCandidateForSourceRevision(input: { readonly external_id: string; readonly canonical_revision: string; }): Promise<FrozenMeetingProcessingCandidateSnapshotV1 | undefined> {
    return this.delegate.readFrozenCandidateForSourceRevision(input);
  }
  readFrozenCandidateForReviewInput(input: { readonly review_lineage_id: string; readonly review_input_sha256: string; }): Promise<FrozenMeetingProcessingCandidateSnapshotV1 | undefined> {
    return this.delegate.readFrozenCandidateForReviewInput(input);
  }
  async stageCandidate(input: MeetingProcessingCandidateSnapshotInputV1) {
    if (
      input.admission.source.adapter_id !== this.syntheticAdmission.source.adapter_id ||
      input.admission.source.instance_id !== this.syntheticAdmission.source.instance_id ||
      input.admission.source.version !== this.syntheticAdmission.source.version ||
      input.admission.source.cursor !== this.cursor
    ) throw new Error("staging synthetic canary candidate did not use its fixed source admission");
    return this.delegate.stageSyntheticCanaryCandidate({ ...input, admission: this.baseAdmission }, this.canary);
  }
  async advanceCursor(): Promise<"advanced" | "state_drift" | "revoked"> {
    throw new Error("staging synthetic canary must not advance the live source cursor");
  }
}

function actionable(value: FrozenMeetingProcessingCandidateSnapshotV1 | undefined): value is Extract<FrozenMeetingProcessingCandidateSnapshotV1, { readonly disposition: "actionable" }> {
  return value?.disposition === "actionable";
}

function canaryResult(
  result: AdmittedMeetingProcessingCycleResultV1,
  frozen: FrozenMeetingProcessingCandidateSnapshotV1 | undefined,
  reusedFrozenExtraction: boolean,
): StagingSyntheticMeetingCanaryResultV1 {
  if (frozen === undefined) throw new Error("staging synthetic canary was not durably frozen");
  if (!actionable(frozen)) return { kind: "not_actionable", disposition: frozen.disposition, reused_frozen_extraction: reusedFrozenExtraction };
  if (result.kind === "quarantined" || result.kind === "quarantined_cursor_not_advanced") {
    return { kind: "quarantined", approval_id: frozen.approval_id, reason_code: result.reason_code, reused_frozen_extraction: reusedFrozenExtraction };
  }
  if (result.kind === "delivery_pending" || result.kind === "delivery_pending_cursor_not_advanced") {
    return { kind: "delivery_pending", approval_id: frozen.approval_id, reused_frozen_extraction: reusedFrozenExtraction };
  }
  if (result.kind === "not_staged" || result.kind === "staged_cursor_not_advanced") {
    return { kind: "not_staged", approval_id: frozen.approval_id, reason: result.reason, reused_frozen_extraction: reusedFrozenExtraction };
  }
  if (result.kind === "staged") {
    return { kind: "staged", approval_id: frozen.approval_id, stage_id: result.stage_id, reused_frozen_extraction: reusedFrozenExtraction };
  }
  if (result.kind === "already_processed" && frozen.state === "staged") {
    return { kind: "staged", approval_id: frozen.approval_id, stage_id: frozen.approval_id, reused_frozen_extraction: reusedFrozenExtraction };
  }
  // An impossible empty/no-signal terminal, or a superseded candidate, must
  // never be reported as a successful rehearsal.
  return { kind: "not_staged", approval_id: frozen.approval_id, reason: "state_drift", reused_frozen_extraction: reusedFrozenExtraction };
}

/**
 * Runs one source-admitted synthetic meeting through the same cycle as
 * Granola. Existing V1 snapshots remain recoverable; new canaries use the
 * transcript-bearing V2 envelope and ordinary source custody.
 */
export async function runStagingSyntheticPrivateDmCanaryV1(
  input: RunStagingSyntheticPrivateDmCanaryV1Input,
): Promise<StagingSyntheticMeetingCanaryResultV1> {
  input.signal?.throwIfAborted();
  assertStagingAuthorityUrl(input.authority_url);
  const legacyMeeting = createStagingSyntheticMeetingCanaryV1(input.canary);
  const legacyFrozen = await input.state.readFrozenCandidateForSourceRevision({
    external_id: legacyMeeting.provenance.external_id,
    canonical_revision: legacyMeeting.provenance.canonical_revision,
  });
  const requestedV2 = createStagingSyntheticMeetingCanaryV2(input.canary);
  const v2Frozen = legacyFrozen === undefined
    ? await input.state.readFrozenCandidateForSourceRevision({
        external_id: requestedV2.provenance.external_id,
        canonical_revision: requestedV2.provenance.canonical_revision,
      })
    : undefined;
  const selectedFrozen = legacyFrozen ?? v2Frozen;
  const meeting = selectedFrozen?.meeting ?? requestedV2;
  const cursor = legacyFrozen === undefined
    ? stagingSyntheticMeetingCanaryCursorV2(input.canary.canary_id)
    : stagingSyntheticMeetingCanaryCursorV1(input.canary.canary_id);
  if (selectedFrozen !== undefined) {
    const expected = {
      ...input.canary,
      observed_at: selectedFrozen.meeting.provenance.observed_at,
    };
    assertStagingSyntheticMeetingCanary(selectedFrozen.meeting, expected);
    if (legacyFrozen !== undefined && !isStagingSyntheticMeetingCanaryV1(selectedFrozen.meeting, cursor)) {
      throw new Error("staging synthetic canary legacy snapshot differs from its fixed envelope");
    }
  }
  const state = new StagingSyntheticCanaryStateV1(
    input.state,
    await input.state.readAdmission(),
    cursor,
    input.canary,
  );
  const cycle = new AdmittedMeetingProcessingCycleV1({
    source: new StagingSyntheticCanarySourceV1(meeting, cursor),
    source_ingestion: input.source_ingestion,
    processor: input.processor,
    state,
    stager: input.stager,
    source_cursor_policy: canaryCursorPolicy(cursor),
    ...(input.extraction_attempts === undefined ? {} : { extraction_attempts: input.extraction_attempts }),
    ...(input.journey_telemetry === undefined ? {} : { journey_telemetry: input.journey_telemetry }),
  });
  const result = await cycle.runOnce(input.signal);
  const frozen = await input.state.readFrozenCandidateForSourceRevision({
    external_id: meeting.provenance.external_id,
    canonical_revision: meeting.provenance.canonical_revision,
  });
  return canaryResult(result, frozen, selectedFrozen !== undefined);
}
