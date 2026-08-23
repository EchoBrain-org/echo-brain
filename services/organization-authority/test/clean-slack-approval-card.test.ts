import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
} from "@echo-brain/organization-protocol";
import type { DecisionBrief } from "../src/processing/core/contracts/delivery.js";
import { renderCleanSlackApprovalCardTextV1 } from "../src/composition/open-clean-live-runtime.js";

function brief(): DecisionBrief {
  return {
    schema_version: 1,
    id: "brf_test",
    meeting: { id: "meeting_test", title: "Founder review", participants: [] },
    decisions: [
      {
        id: "decision-1",
        kind: "decision",
        text: "Ship the clean V1 runtime.",
        subject: null,
        confidence: null,
        status: "decided",
        evidence: [],
      },
    ],
    actions: [
      {
        id: "action-1",
        kind: "action",
        text: "Re-onboard the founder after deployment.",
        subject: null,
        confidence: null,
        owner: null,
        due_at: null,
        evidence: [],
      },
    ],
    rationales: [
      {
        id: "rationale-1",
        kind: "rationale",
        text: "A fresh lineage has no customer migration risk.",
        subject: null,
        confidence: null,
        supports_signal_ids: [],
        evidence: [],
      },
    ],
    provenance: {
      meeting_revision: "sha256:meeting",
      processor: {
        kind: "decision-processor",
        adapter_id: "llm",
        instance_id: "founder-llm-v1",
        version: "test",
      },
      generated_at: "2026-08-22T12:00:00.000Z",
    },
  };
}

describe("clean Slack approval card", () => {
  it("renders the decision, action, and rationale text that the founder approves", () => {
    const card = renderCleanSlackApprovalCardTextV1(
      brief(),
      ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
    );

    expect(card).toContain("Ship the clean V1 runtime.");
    expect(card).toContain("Re-onboard the founder after deployment.");
    expect(card).toContain("A fresh lineage has no customer migration risk.");
    expect(card).toContain(ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT);
    expect(card.indexOf(ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT)).toBeLessThan(
      card.indexOf("React with :white_check_mark:"),
    );
  });

  it("uses one deterministic Slack-safe text cap", () => {
    const original = brief();
    const value: DecisionBrief = {
      ...original,
      decisions: [{ ...original.decisions[0]!, text: "x".repeat(4_000) }],
    };

    const card = renderCleanSlackApprovalCardTextV1(
      value,
      RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
    );
    expect(card.length).toBeLessThanOrEqual(3_500);
    expect(card).toContain("Card truncated for Slack");
    expect(card).toContain(RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT);
    expect(card.indexOf(RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT)).toBeLessThan(
      card.indexOf("React with :white_check_mark:"),
    );
  });
});
