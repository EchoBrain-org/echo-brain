import { assertCanonicalDecisionSet } from "../processing/core/contracts/validation.js";
import type { DecisionProcessorAdapter } from "../processing/core/ports/adapters.js";
import {
  type CleanActionableLiveCandidateV1,
  type CleanApprovalStagerV1,
} from "../processing/clean-v1/live-only-source-cycle.js";
import {
  createStagingSyntheticMeetingCanaryV1,
  type StagingSyntheticMeetingCanaryInputV1,
} from "../processing/clean-v1/staging-synthetic-meeting-canary-v1.js";
import { legacyRestrictedReviewerReviewPolicySnapshotV1 } from "../processing/clean-v1/review-lineage-semantics.js";
import { SqliteCleanLiveOnlySourceStateV1 } from "../processing/clean-v1/sqlite-live-only-source-state.js";

export interface StageStagingSyntheticPrivateDmCanaryV1Input {
  /** Must be the public staging Authority origin, never a production URL. */
  readonly authority_url: string;
  readonly canary: StagingSyntheticMeetingCanaryInputV1;
  readonly state: SqliteCleanLiveOnlySourceStateV1;
  readonly processor: DecisionProcessorAdapter;
  readonly stager: CleanApprovalStagerV1;
  readonly signal?: AbortSignal;
}

export type StageStagingSyntheticPrivateDmCanaryV1Result =
  | {
      readonly kind: "staged";
      readonly approval_id: string;
      readonly stage_id: string;
      readonly reused_frozen_extraction: boolean;
    }
  | {
      readonly kind: "delivery_pending";
      readonly approval_id: string;
      readonly reused_frozen_extraction: boolean;
    }
  | {
      readonly kind: "not_actionable";
      readonly disposition: "coalesced" | "no_signals";
      readonly reused_frozen_extraction: boolean;
    }
  | {
      readonly kind: "not_staged";
      readonly approval_id: string;
      readonly reason: "revoked" | "state_drift";
      readonly reused_frozen_extraction: boolean;
    };

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
  value: Awaited<ReturnType<SqliteCleanLiveOnlySourceStateV1["readFrozenCandidateForSourceRevision"]>>,
): value is Exclude<typeof value, undefined> & {
  readonly disposition: "actionable";
  readonly approval_id: string;
} {
  return value !== undefined && value.disposition === "actionable";
}

/**
 * Runs one intentionally synthetic meeting through the admitted LLM and the
 * existing private-owner Slack approval stager. It never polls or advances the
 * real meeting provider cursor. A stable canary id is an idempotency key.
 */
export async function stageStagingSyntheticPrivateDmCanaryV1(
  input: StageStagingSyntheticPrivateDmCanaryV1Input,
): Promise<StageStagingSyntheticPrivateDmCanaryV1Result> {
  assertStagingAuthorityUrl(input.authority_url);
  const meeting = createStagingSyntheticMeetingCanaryV1(input.canary);
  const existing = await input.state.readFrozenCandidateForSourceRevision({
    external_id: meeting.provenance.external_id,
    canonical_revision: meeting.provenance.canonical_revision,
  });
  const reusedFrozenExtraction = existing !== undefined;
  let frozen = existing;
  if (frozen === undefined) {
    const admission = await input.state.readAdmission();
    if (
      input.processor.identity.adapter_id !== admission.processor.adapter_id ||
      input.processor.identity.instance_id !== admission.processor.instance_id ||
      input.processor.identity.version !== admission.processor.version
    ) {
      throw new Error("staging synthetic canary processor differs from admission");
    }
    const decisions = await input.processor.extract(
      meeting,
      {
        processor_version: input.processor.identity.version,
        input_fingerprint:
          `staging-synthetic-canary:v1:${meeting.provenance.external_id}:` +
          meeting.provenance.canonical_revision,
      },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    assertCanonicalDecisionSet(decisions, meeting, input.processor.identity);
    await input.state.stageStagingSyntheticCanaryCandidate(
      {
        admission,
        meeting,
        decisions,
        review_policy: legacyRestrictedReviewerReviewPolicySnapshotV1,
      },
      input.canary,
    );
    frozen = await input.state.readFrozenCandidateForSourceRevision({
      external_id: meeting.provenance.external_id,
      canonical_revision: meeting.provenance.canonical_revision,
    });
  }
  if (frozen === undefined) {
    throw new Error("staging synthetic canary was not durably frozen");
  }
  if (!actionable(frozen)) {
    return {
      kind: "not_actionable",
      disposition: frozen.disposition,
      reused_frozen_extraction: reusedFrozenExtraction,
    };
  }
  const outbox = input.state.readCandidateByApprovalId(frozen.approval_id);
  if (
    outbox !== undefined &&
    outbox.candidate_id === frozen.candidate_id &&
    outbox.state === "staged"
  ) {
    return {
      kind: "staged",
      approval_id: frozen.approval_id,
      stage_id: frozen.approval_id,
      reused_frozen_extraction: true,
    };
  }
  const staged = await input.stager.stage(
    {
      admission: frozen.admission,
      candidate: frozen as CleanActionableLiveCandidateV1,
      meeting: frozen.meeting,
      decisions: frozen.decisions,
    },
    input.signal === undefined ? undefined : { signal: input.signal },
  );
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
  return {
    kind: "not_staged",
    approval_id: frozen.approval_id,
    reason: staged.kind,
    reused_frozen_extraction: reusedFrozenExtraction,
  };
}
