import { assertCanonicalDecisionSet } from "../../../processing/core/contracts/validation.js";
import type { DecisionProcessorAdapter } from "../../../processing/core/ports/adapters.js";
import {
  type ActionableMeetingProcessingCandidateV1,
  type ApprovalWorkflowStagerV1,
} from "../../../processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import {
  createStagingSyntheticMeetingCanaryV1,
  type StagingSyntheticMeetingCanaryInputV1,
  type StagingSyntheticMeetingCanaryResultV1,
} from "../../../processing/admitted-meeting-processing/staging-synthetic-meeting-canary-v1.js";
import type {
  MeetingApprovalJourneyRefV1,
  MeetingApprovalJourneyTelemetryPortV1,
} from "../../../processing/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1.js";
import type {
  DecisionExtractionGenerationObservation,
  DecisionSet,
} from "../../../processing/core/contracts/decision.js";
import { legacyRestrictedReviewerReviewPolicySnapshotV1 } from "../../../processing/admitted-meeting-processing/review-lineage-semantics.js";
import { SqliteAuthorityMeetingProcessingStateV1 } from "../../../processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";

export interface RunStagingSyntheticPrivateDmCanaryV1Input {
  /** Must be the public staging Authority origin, never a production URL. */
  readonly authority_url: string;
  readonly canary: StagingSyntheticMeetingCanaryInputV1;
  readonly state: SqliteAuthorityMeetingProcessingStateV1;
  readonly processor: DecisionProcessorAdapter;
  readonly stager: ApprovalWorkflowStagerV1;
  /** Optional staging-only observer. It never changes canary behavior. */
  readonly journey_telemetry?: MeetingApprovalJourneyTelemetryPortV1;
  readonly signal?: AbortSignal;
}

function assertStagingAuthorityUrl(authorityUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(authorityUrl);
  } catch {
    throw new Error("synthetic private-DM canary requires the staging Authority URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "authority-staging.echobrain.org" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("synthetic private-DM canary is staging-only");
  }
}

function actionable(
  value: Awaited<ReturnType<SqliteAuthorityMeetingProcessingStateV1["readFrozenCandidateForSourceRevision"]>>,
): value is Exclude<typeof value, undefined> & {
  readonly disposition: "actionable";
  readonly approval_id: string;
} {
  return value !== undefined && value.disposition === "actionable";
}

function observe<T>(operation: () => T, fallback: T): T {
  try {
    return operation();
  } catch {
    return fallback;
  }
}

function canonicalDurableTimestamp(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new Date(value).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function bindCandidate(
  telemetry: MeetingApprovalJourneyTelemetryPortV1 | undefined,
  journey: MeetingApprovalJourneyRefV1 | null,
  candidate: { readonly candidate_id: string; readonly approval_id: string | null },
): void {
  if (journey === null) return;
  observe(() => telemetry?.bindCandidate(journey, candidate), undefined);
}

/**
 * A previously staged canary may outlive the disposable sidecar. Reconstruct
 * the observational terminal from the Authority outbox without retrying any
 * Slack or Control Plane operation.
 */
function reconcileDurableCardStaged(
  telemetry: MeetingApprovalJourneyTelemetryPortV1 | undefined,
  approvalId: string,
  durableStagedAt: string | null | undefined,
): void {
  if (telemetry === undefined) return;
  observe(() => {
    const stagedAt = canonicalDurableTimestamp(durableStagedAt);
    if (!telemetry.hasTerminalStage(approvalId, "meeting_approval_staging")) {
      const attempt = telemetry.beginStageForApproval(
        approvalId,
        "meeting_approval_staging",
      );
      if (stagedAt !== undefined) {
        telemetry.markCardStaged(approvalId, stagedAt);
      }
      telemetry.succeedStage(attempt, { outcome: "staged" });
      return;
    }
    // Keep the human-wait anchor repairable independently of the stage event.
    if (stagedAt !== undefined) {
      telemetry.markCardStaged(approvalId, stagedAt);
    }
  }, undefined);
}

/**
 * Runs one intentionally synthetic meeting through the admitted LLM and the
 * existing private-owner Slack approval stager. It never polls or advances the
 * real meeting provider cursor. A stable canary id is an idempotency key.
 */
export async function runStagingSyntheticPrivateDmCanaryV1(
  input: RunStagingSyntheticPrivateDmCanaryV1Input,
): Promise<StagingSyntheticMeetingCanaryResultV1> {
  input.signal?.throwIfAborted();
  assertStagingAuthorityUrl(input.authority_url);
  const meeting = createStagingSyntheticMeetingCanaryV1(input.canary);
  const telemetry = input.journey_telemetry;
  const sourceAttempt = observe(
    () =>
      telemetry?.beginOrResumeSource({
        source_adapter_id: meeting.provenance.source.adapter_id,
        source_instance_id: meeting.provenance.source.instance_id,
        external_id: meeting.provenance.external_id,
        canonical_revision: meeting.provenance.canonical_revision,
      }) ?? null,
    null,
  );
  let existing: Awaited<ReturnType<SqliteAuthorityMeetingProcessingStateV1["readFrozenCandidateForSourceRevision"]>>;
  try {
    existing = await input.state.readFrozenCandidateForSourceRevision({
      external_id: meeting.provenance.external_id,
      canonical_revision: meeting.provenance.canonical_revision,
    });
    observe(() => telemetry?.succeedStage(sourceAttempt), undefined);
  } catch (error) {
    observe(() => telemetry?.failStage(sourceAttempt, error), undefined);
    throw error;
  }
  input.signal?.throwIfAborted();
  const reusedFrozenExtraction = existing !== undefined;
  let frozen = existing;
  if (frozen === undefined) {
    const admission = await input.state.readAdmission();
    input.signal?.throwIfAborted();
    if (
      input.processor.identity.adapter_id !== admission.processor.adapter_id ||
      input.processor.identity.instance_id !== admission.processor.instance_id ||
      input.processor.identity.version !== admission.processor.version
    ) {
      throw new Error("staging synthetic canary processor differs from admission");
    }
    const extractionAttempt = observe(
      () =>
        sourceAttempt === null
          ? null
          : telemetry?.beginStage(sourceAttempt, "meeting_extraction") ?? null,
      null,
    );
    const extractionStartedAt = Date.now();
    let observation: DecisionExtractionGenerationObservation | null = null;
    let decisions: DecisionSet;
    try {
      decisions = await input.processor.extract(
        meeting,
        {
          processor_version: input.processor.identity.version,
          input_fingerprint:
            `staging-synthetic-canary:v1:${meeting.provenance.external_id}:` +
            meeting.provenance.canonical_revision,
          on_generation: (event) => {
            observation = event;
          },
        },
        input.signal === undefined ? undefined : { signal: input.signal },
      );
      input.signal?.throwIfAborted();
      assertCanonicalDecisionSet(decisions, meeting, input.processor.identity);
      observe(
        () => telemetry?.succeedExtractionStage(
          extractionAttempt,
          observation,
          Math.max(0, Date.now() - extractionStartedAt),
        ),
        undefined,
      );
    } catch (error) {
      observe(
        () => telemetry?.failExtractionStage(
          extractionAttempt,
          error,
          observation,
          Math.max(0, Date.now() - extractionStartedAt),
        ),
        undefined,
      );
      throw error;
    }
    const candidateAttempt = observe(
      () =>
        sourceAttempt === null
          ? null
          : telemetry?.beginStage(sourceAttempt, "meeting_candidate_persist") ?? null,
      null,
    );
    try {
      const candidate = await input.state.stageSyntheticCanaryCandidate(
        {
          admission,
          meeting,
          decisions,
          review_policy: legacyRestrictedReviewerReviewPolicySnapshotV1,
        },
        input.canary,
      );
      observe(
        () => telemetry?.succeedStage(candidateAttempt, { outcome: candidate.disposition }),
        undefined,
      );
      bindCandidate(telemetry, sourceAttempt, candidate);
    } catch (error) {
      observe(() => telemetry?.failStage(candidateAttempt, error), undefined);
      throw error;
    }
    input.signal?.throwIfAborted();
    frozen = await input.state.readFrozenCandidateForSourceRevision({
      external_id: meeting.provenance.external_id,
      canonical_revision: meeting.provenance.canonical_revision,
    });
    input.signal?.throwIfAborted();
  }
  if (frozen === undefined) {
    throw new Error("staging synthetic canary was not durably frozen");
  }
  bindCandidate(telemetry, sourceAttempt, frozen);
  if (reusedFrozenExtraction && sourceAttempt !== null) {
    observe(() => telemetry?.skipStage(sourceAttempt, "meeting_extraction"), undefined);
    observe(() => telemetry?.skipStage(sourceAttempt, "meeting_candidate_persist"), undefined);
  }
  if (!actionable(frozen)) {
    return {
      kind: "not_actionable",
      disposition: frozen.disposition,
      reused_frozen_extraction: reusedFrozenExtraction,
    };
  }
  if (frozen.state === "staged") {
    reconcileDurableCardStaged(
      telemetry,
      frozen.approval_id,
      frozen.durable_staged_at,
    );
    return {
      kind: "staged",
      approval_id: frozen.approval_id,
      stage_id: frozen.approval_id,
      reused_frozen_extraction: reusedFrozenExtraction,
    };
  }
  input.signal?.throwIfAborted();
  const staged = await input.stager.stage(
    {
      admission: frozen.admission,
      candidate: frozen as ActionableMeetingProcessingCandidateV1,
      meeting: frozen.meeting,
      decisions: frozen.decisions,
    },
    input.signal === undefined ? undefined : { signal: input.signal },
  );
  input.signal?.throwIfAborted();
  if (staged.kind === "staged") {
    return {
      kind: "staged",
      approval_id: frozen.approval_id,
      stage_id: staged.stage_id,
      reused_frozen_extraction: reusedFrozenExtraction,
    };
  }
  if (staged.kind === "delivery_pending") {
    return {
      kind: "delivery_pending",
      approval_id: frozen.approval_id,
      reused_frozen_extraction: reusedFrozenExtraction,
    };
  }
  if (staged.kind === "quarantined") {
    return {
      kind: "quarantined",
      approval_id: frozen.approval_id,
      reason_code: staged.reason_code,
      reused_frozen_extraction: reusedFrozenExtraction,
    };
  }
  return {
    kind: "not_staged",
    approval_id: frozen.approval_id,
    reason: staged.kind,
    reused_frozen_extraction: reusedFrozenExtraction,
  };
}
