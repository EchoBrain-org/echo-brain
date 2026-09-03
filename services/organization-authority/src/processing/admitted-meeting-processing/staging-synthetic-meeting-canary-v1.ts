import {
  assertCanonicalMeetingDocument,
  type MeetingDocument,
} from "../core/index.js";
import type { ApprovalDeliveryQuarantineReasonV1 } from "./meeting-processing-cycle-v1.js";
import {
  createStagingSyntheticMeetingCanaryEnvelopeV1,
  isStagingSyntheticMeetingCanaryEnvelopeV1,
  stagingSyntheticMeetingCanaryInputFromEnvelopeV1,
  stagingSyntheticMeetingCanarySourceIdentityV1 as envelopeSourceIdentity,
  type StagingSyntheticMeetingCanaryInputV1,
} from "../../shared/staging-synthetic-meeting-canary-envelope-v1.js";

export {
  stagingSyntheticMeetingCanaryCursorV1,
  type StagingSyntheticMeetingCanaryInputV1,
} from "../../shared/staging-synthetic-meeting-canary-envelope-v1.js";

/**
 * A deliberately invented source identity. It must never be confused with a
 * connected meeting provider in a card, record, or audit trail.
 */
export const stagingSyntheticMeetingCanarySourceIdentityV1 = envelopeSourceIdentity;

/** Provider-neutral outcome of running a synthetic meeting through approval delivery. */
export type StagingSyntheticMeetingCanaryResultV1 =
  | { readonly kind: "staged"; readonly approval_id: string; readonly stage_id: string; readonly reused_frozen_extraction: boolean }
  | { readonly kind: "delivery_pending"; readonly approval_id: string; readonly reused_frozen_extraction: boolean }
  | { readonly kind: "quarantined"; readonly approval_id: string; readonly reason_code: ApprovalDeliveryQuarantineReasonV1; readonly reused_frozen_extraction: boolean }
  | { readonly kind: "not_actionable"; readonly disposition: "coalesced" | "no_signals"; readonly reused_frozen_extraction: boolean }
  | { readonly kind: "not_staged"; readonly approval_id: string; readonly reason: "revoked" | "state_drift"; readonly reused_frozen_extraction: boolean };

/**
 * Builds the one compact meeting used to prove the admitted private-DM approval
 * path. The wording and provenance are intentionally conspicuous so an
 * approval can never be mistaken for a real meeting.
 */
export function createStagingSyntheticMeetingCanaryV1(
  input: StagingSyntheticMeetingCanaryInputV1,
): MeetingDocument {
  const meeting = createStagingSyntheticMeetingCanaryEnvelopeV1(input) as unknown as MeetingDocument;
  assertCanonicalMeetingDocument(
    meeting,
    stagingSyntheticMeetingCanarySourceIdentityV1,
  );
  return Object.freeze(meeting);
}

/**
 * Rebuilds the one permitted document rather than accepting a lookalike.
 * A staging intake supplies its fixed inputs; reads infer them from the
 * immutable snapshot they are revalidating.
 */
export function assertStagingSyntheticMeetingCanaryV1(
  meeting: MeetingDocument,
  expectedInput?: StagingSyntheticMeetingCanaryInputV1,
): void {
  try {
    assertCanonicalMeetingDocument(
      meeting,
      stagingSyntheticMeetingCanarySourceIdentityV1,
    );
    if (!isStagingSyntheticMeetingCanaryEnvelopeV1(meeting, expectedInput)) {
      throw new Error("staging synthetic canary differs from its fixed envelope");
    }
  } catch {
    throw new Error("meeting is not the fixed staging synthetic canary");
  }
}

export function isStagingSyntheticMeetingCanaryV1(
  meeting: MeetingDocument,
  cursor: string,
): boolean {
  try {
    assertStagingSyntheticMeetingCanaryV1(meeting);
    const input = stagingSyntheticMeetingCanaryInputFromEnvelopeV1(meeting);
    return input !== undefined && cursor === `synthetic-staging-canary:v1:${input.canary_id}`;
  } catch {
    return false;
  }
}
