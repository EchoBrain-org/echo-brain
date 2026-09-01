import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import type {
  ApprovalContractSha256,
  PersonApprovalPolicyId,
} from "@echo-brain/organization-control-plane/record-visibility-policy-contracts-v1";
import {
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "@echo-brain/organization-control-plane/record-visibility-policy-contracts-v1";
import type {
  DecisionSet,
  ExtractedSignal,
  MeetingDocument,
} from "../core/index.js";

/** The policy commitment that changes the human-review boundary. */
export interface ReviewPolicyCommitmentV1 {
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly policy_consequence_sha256: ApprovalContractSha256;
}

/** The exact human-facing policy material frozen with one review candidate. */
export interface ReviewPolicySnapshotV1
  extends ReviewPolicyCommitmentV1 {
  readonly policy_consequence_text: string;
}

/**
 * Compatibility material retained by the V1 candidate schema until its
 * generic successor lands. It is deliberately independent of a meeting
 * provider: the actual visibility policy is selected and bound by the person
 * who approves the private card. Until then the safe default is Only me.
 */
export const legacyRestrictedReviewerReviewPolicySnapshotV1:
  ReviewPolicySnapshotV1 = Object.freeze({
  policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  policy_contract_sha256: RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  policy_consequence_text: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  policy_consequence_sha256: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
});

/** V1 candidates may only carry their provider-neutral compatibility tuple. */
export function assertLegacyReviewPolicySnapshotV1(
  actual: ReviewPolicySnapshotV1,
): void {
  const expected = legacyRestrictedReviewerReviewPolicySnapshotV1;
  if (
    actual.policy_id !== expected.policy_id ||
    actual.policy_contract_sha256 !== expected.policy_contract_sha256 ||
    actual.policy_consequence_text !== expected.policy_consequence_text ||
    actual.policy_consequence_sha256 !== expected.policy_consequence_sha256
  ) {
    throw new Error(
      "admitted V1 review policy must equal the fixed restricted default",
    );
  }
}

export interface ReviewProcessorCommitmentV1 {
  readonly adapter_id: string;
  readonly instance_id: string;
  readonly version: string;
  readonly configuration_sha256: string;
}

/** Stable across revisions of one meeting, but never across source instances. */
export function reviewLineageIdV1(input: {
  readonly adapter_id: string;
  readonly instance_id: string;
  readonly external_id: string;
}): string {
  return `rli_${canonicalSha256({
    schema_version: 1,
    kind: "echo-clean-live-review-lineage-v1",
    source: input,
  }).slice("sha256:".length)}`;
}

/** Mirrors the bounded material actually supplied to extraction. */
export function reviewInputSha256V1(input: {
  readonly meeting: MeetingDocument;
  readonly processor: ReviewProcessorCommitmentV1;
}): string {
  return canonicalSha256({
    schema_version: 1,
    kind: "echo-clean-live-review-input-v1",
    processor: input.processor,
    title: semanticTitle(input.meeting.title),
    participants: semanticParticipantNames(input.meeting),
    content: input.meeting.content
      .filter((block) => block.text.trim().length > 0)
      .map((block) => ({
        kind: block.kind,
        text: block.text,
        speaker_participant_id: block.speaker_participant_id ?? null,
      })),
  });
}

/**
 * The material a human must reconsider. Provider revisions, timestamps, and
 * extraction/evidence identifiers cannot create work on their own.
 */
export function reviewSemanticSha256V1(input: {
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
  readonly review_policy: ReviewPolicySnapshotV1;
  readonly processor: ReviewProcessorCommitmentV1;
}): string {
  const signalsById = new Map(
    input.decisions.signals.map((signal) => [signal.id, signal]),
  );
  return canonicalSha256({
    schema_version: 1,
    kind: "echo-clean-live-review-semantic-v1",
    processor: input.processor,
    review_policy: input.review_policy,
    meeting: {
      title: semanticTitle(input.meeting.title),
      participants: semanticParticipantNames(input.meeting),
    },
    signals: input.decisions.signals
      .map((signal) => {
        const value = semanticSignal(signal, signalsById);
        return {
          value,
          // This key is intentionally canonical and stable across source order.
          key: canonicalJson(value as never),
        };
      })
      .sort((left, right) => lexicalCompare(left.key, right.key))
      .map(({ value }) => value),
  });
}

function semanticSignal(
  signal: ExtractedSignal,
  signalsById: ReadonlyMap<string, ExtractedSignal>,
): Readonly<Record<string, unknown>> {
  const base = semanticSignalBase(signal);
  if (signal.kind !== "rationale") return base;
  return {
    ...base,
    supports: signal.supports_signal_ids
      .map((supportedId) => {
        const supported = signalsById.get(supportedId);
        if (supported === undefined) {
          throw new Error(`rationale references unknown signal ${supportedId}`);
        }
        return semanticSignalBase(supported);
      })
      .map((value) => ({ value, key: canonicalJson(value as never) }))
      .sort((left, right) => lexicalCompare(left.key, right.key))
      .map(({ value }) => value),
  };
}

function semanticSignalBase(
  signal: ExtractedSignal,
): Readonly<Record<string, unknown>> {
  const base = {
    kind: signal.kind,
    text: signal.text,
    subject: signal.subject,
    confidence: signal.confidence,
  };
  switch (signal.kind) {
    case "decision":
      return { ...base, status: signal.status };
    case "action":
      return { ...base, owner: signal.owner, due_at: signal.due_at };
    case "rationale":
      return base;
  }
}

function semanticParticipantNames(meeting: MeetingDocument): readonly string[] {
  return meeting.participants
    .map((participant) => participant.display_name ?? participant.id)
    .filter((name) => name.trim().length > 0)
    .sort(lexicalCompare);
}

function semanticTitle(title: string | undefined): string | null {
  return title !== undefined && title.trim().length > 0 ? title : null;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
