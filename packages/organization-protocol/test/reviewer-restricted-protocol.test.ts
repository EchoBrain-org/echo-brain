import { describe, expect, it } from "vitest";
import {
  MAX_REVIEWER_CARD_TITLE_SCALARS,
  OrganizationProtocolValidationError,
  RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
  projectReviewerReleaseDraft,
  reviewerApprovalPresentation,
  validateReviewerReleaseDraft,
} from "../src/index.js";

const approvalId = "a".repeat(64);
const brief = {
  meeting: { id: "meeting-1", title: "Pricing review" },
  decisions: [{ id: "decision-1", kind: "decision", text: "Ship the pilot." }],
  actions: [{ id: "action-1", kind: "action", text: "Publish the runbook." }],
  rationales: [{ id: "rationale-1", kind: "rationale", text: "The policy is explicit." }],
};

describe("reviewer policy release and presentation", () => {
  it("projects the complete ordered approval card", () => {
    const draft = projectReviewerReleaseDraft({ approval_id: approvalId, brief });
    expect(draft.items.map((item) => item.kind)).toEqual([
      "decision",
      "action",
      "rationale",
    ]);

    const presentation = reviewerApprovalPresentation({
      draft,
      approve_reaction: "white_check_mark",
      reject_reaction: "x",
    });
    expect(presentation.text).toContain(RESTRICTED_REVIEWER_CONSEQUENCE_TEXT);
    expect(presentation.blocks).toHaveLength(draft.items.length + 3);
  });

  it("rejects malformed release data before it reaches a presentation", () => {
    expect(() =>
      projectReviewerReleaseDraft({
        approval_id: approvalId,
        brief: {
          ...brief,
          meeting: { id: "meeting-1", title: "x".repeat(MAX_REVIEWER_CARD_TITLE_SCALARS + 1) },
        },
      }),
    ).toThrow(OrganizationProtocolValidationError);

    const draft = projectReviewerReleaseDraft({ approval_id: approvalId, brief });
    expect(() =>
      validateReviewerReleaseDraft({ ...draft, extra: true }),
    ).toThrow(OrganizationProtocolValidationError);
  });
});
