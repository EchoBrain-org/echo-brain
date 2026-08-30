import { describe, expect, it } from "vitest";
import type {
  DecisionSet,
  MeetingDocument,
} from "../../../src/processing/core/index.js";
import {
  reviewInputSha256V1,
  reviewSemanticSha256V1,
  type ReviewPolicySnapshotV1,
  type ReviewProcessorCommitmentV1,
} from "../../../src/processing/admitted-meeting-processing/review-lineage-semantics.js";

const PROCESSOR: ReviewProcessorCommitmentV1 = {
  adapter_id: "llm",
  instance_id: "test-llm",
  version: "1.0.0",
  configuration_sha256: `sha256:${"a".repeat(64)}`,
};
const REVIEW_POLICY = {
  policy_id: "organization-member-readable-person-v2",
  policy_contract_sha256: `sha256:${"b".repeat(64)}`,
  policy_consequence_text: "Approving makes this review member-readable.",
  policy_consequence_sha256: `sha256:${"c".repeat(64)}`,
} as ReviewPolicySnapshotV1;

function meeting(overrides: Partial<MeetingDocument> = {}): MeetingDocument {
  return {
    schema_version: 1,
    id: "meeting-1",
    provenance: {
      source: {
        kind: "meeting-source",
        adapter_id: "granola",
        instance_id: "test-granola",
        version: "1.0.0",
      },
      external_id: "note-1",
      canonical_revision: "sha256:note-1",
      observed_at: "2026-08-27T00:00:00.000Z",
      normalizer_version: "1.0.0",
    },
    capture: { state: "complete", components: [] },
    title: "Planning",
    participants: [
      { id: "person-1", display_name: "Ada" },
      { id: "person-2", display_name: "Grace" },
    ],
    content: [{ id: "block-1", kind: "note", text: "Ship the beta." }],
    artifacts: [],
    ...overrides,
  };
}

function decisions(
  value: MeetingDocument,
  signals: DecisionSet["signals"],
): DecisionSet {
  return {
    schema_version: 1,
    meeting_id: value.id,
    meeting_revision: value.provenance.canonical_revision,
    processor: { kind: "decision-processor", ...PROCESSOR },
    generated_at: "2026-08-27T00:00:00.000Z",
    signals,
  };
}

const SHIP_DECISION = {
  id: "signal-ship",
  kind: "decision" as const,
  status: "decided" as const,
  text: "Ship the beta.",
  subject: "beta",
  confidence: 1,
  evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }],
};
const INVITE_ACTION = {
  id: "signal-invite",
  kind: "action" as const,
  text: "Invite the first cohort.",
  subject: "cohort",
  owner: "Ada",
  due_at: "2026-08-28T00:00:00.000Z",
  confidence: 0.8,
  evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }],
};

function rationale(
  id: string,
  supportsSignalIds: readonly string[],
) {
  return {
    id,
    kind: "rationale" as const,
    text: "The beta is ready.",
    subject: "beta",
    confidence: 0.9,
    supports_signal_ids: supportsSignalIds,
    evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }],
  };
}

describe("clean review lineage semantics", () => {
  it("reuses the input hash when only source block IDs churn", () => {
    const first = meeting();
    const blockIdOnlyRevision = meeting({
      content: [{ ...first.content[0]!, id: "provider-reassigned-id" }],
    });

    expect(reviewInputSha256V1({
      meeting: blockIdOnlyRevision,
      processor: PROCESSOR,
    })).toBe(reviewInputSha256V1({
      meeting: first,
      processor: PROCESSOR,
    }));
  });

  it("treats reordered participants as the same review input", () => {
    const first = meeting();
    const reordered = meeting({ participants: [...first.participants].reverse() });

    expect(reviewInputSha256V1({
      meeting: reordered,
      processor: PROCESSOR,
    })).toBe(reviewInputSha256V1({
      meeting: first,
      processor: PROCESSOR,
    }));
  });

  it("normalizes blank title and participant names exactly like the prompt", () => {
    const blank = meeting({
      title: "   ",
      participants: [{ id: "person-1", display_name: "" }],
    });
    const absent = meeting({
      title: undefined,
      participants: [],
    });

    expect(reviewInputSha256V1({
      meeting: blank,
      processor: PROCESSOR,
    })).toBe(reviewInputSha256V1({
      meeting: absent,
      processor: PROCESSOR,
    }));
  });

  it("treats reordered signals as the same semantic review", () => {
    const value = meeting();

    expect(reviewSemanticSha256V1({
      meeting: value,
      decisions: decisions(value, [INVITE_ACTION, SHIP_DECISION]),
      processor: PROCESSOR,
      review_policy: REVIEW_POLICY,
    })).toBe(reviewSemanticSha256V1({
      meeting: value,
      decisions: decisions(value, [SHIP_DECISION, INVITE_ACTION]),
      processor: PROCESSOR,
      review_policy: REVIEW_POLICY,
    }));
  });

  it("changes the semantic review hash for a meaningful signal change", () => {
    const value = meeting();
    const changed = { ...SHIP_DECISION, status: "unresolved" as const };

    expect(reviewSemanticSha256V1({
      meeting: value,
      decisions: decisions(value, [changed]),
      processor: PROCESSOR,
      review_policy: REVIEW_POLICY,
    })).not.toBe(reviewSemanticSha256V1({
      meeting: value,
      decisions: decisions(value, [SHIP_DECISION]),
      processor: PROCESSOR,
      review_policy: REVIEW_POLICY,
    }));
  });

  it("coalesces absent and whitespace-only titles", () => {
    const absent = meeting({ title: undefined });
    const blank = meeting({ title: "   " });

    expect(reviewSemanticSha256V1({
      meeting: absent,
      decisions: decisions(absent, [SHIP_DECISION]),
      processor: PROCESSOR,
      review_policy: REVIEW_POLICY,
    })).toBe(reviewSemanticSha256V1({
      meeting: blank,
      decisions: decisions(blank, [SHIP_DECISION]),
      processor: PROCESSOR,
      review_policy: REVIEW_POLICY,
    }));
  });

  it("changes the semantic review hash when a rationale supports a different signal", () => {
    const value = meeting();
    const rationaleSignal = rationale("signal-rationale", [SHIP_DECISION.id]);

    expect(reviewSemanticSha256V1({
      meeting: value,
      decisions: decisions(value, [SHIP_DECISION, INVITE_ACTION, rationaleSignal]),
      processor: PROCESSOR,
      review_policy: REVIEW_POLICY,
    })).not.toBe(reviewSemanticSha256V1({
      meeting: value,
      decisions: decisions(value, [
        SHIP_DECISION,
        INVITE_ACTION,
        { ...rationaleSignal, supports_signal_ids: [INVITE_ACTION.id] },
      ]),
      processor: PROCESSOR,
      review_policy: REVIEW_POLICY,
    }));
  });

  it("ignores identifier churn in rationale support links", () => {
    const value = meeting();
    const renamedDecision = { ...SHIP_DECISION, id: "renamed-decision" };

    expect(reviewSemanticSha256V1({
      meeting: value,
      decisions: decisions(value, [
        SHIP_DECISION,
        rationale("signal-rationale", [SHIP_DECISION.id]),
      ]),
      processor: PROCESSOR,
      review_policy: REVIEW_POLICY,
    })).toBe(reviewSemanticSha256V1({
      meeting: value,
      decisions: decisions(value, [
        renamedDecision,
        rationale("renamed-rationale", [renamedDecision.id]),
      ]),
      processor: PROCESSOR,
      review_policy: REVIEW_POLICY,
    }));
  });
});
