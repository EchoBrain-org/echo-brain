import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "@echo-brain/organization-control-plane/slack-approval-integration-v1";
import { describe, expect, it } from "vitest";
import { buildPrivateSlackApprovalBlockKitCardV1 } from "../../../../../src/composition/providers/slack/private-approval/private-slack-approval-block-kit-card-v1.js";

const INPUT = Object.freeze({
  schema_version: 1 as const,
  approval_id: "apr_00000000-0000-4000-8000-000000000001",
  meeting_title: "Weekly product review",
  decision_groups: [
    {
      id: "dec_launch",
      decision: {
        text: "Ship the private beta.",
        evidence_reference: "block-03",
        status: "decided" as const,
      },
      rationales: [
        {
          text: "The pilot met the reliability target.",
          evidence_reference: "block-04",
        },
      ],
    },
  ],
  ungrouped_actions: [
    {
      text: "Prepare the launch checklist.",
      evidence_reference: "block-05",
    },
  ],
  ungrouped_rationales: [
    { text: "Budget remains within plan.", evidence_reference: "block-06" },
  ],
});

function blockById(
  card: ReturnType<typeof buildPrivateSlackApprovalBlockKitCardV1>,
  suffix: string,
) {
  return card.blocks.find((block) =>
    (block as { readonly block_id?: string }).block_id?.endsWith(
      `-${suffix}-v1`,
    ),
  );
}

describe("private approval Block Kit card v1", () => {
  it("uses the meeting title as the primary card heading", () => {
    const card = buildPrivateSlackApprovalBlockKitCardV1(INPUT);
    const title = blockById(card, "title") as {
      readonly text: { readonly text: string };
    };
    const context = blockById(card, "context") as {
      readonly elements: readonly { readonly text: string }[];
    };

    expect(title.text.text).toBe(INPUT.meeting_title);
    expect(context.elements[0].text).toBe(
      "1 decision  •  Private until approved",
    );
    expect(context.elements[0].text).not.toContain(INPUT.meeting_title);
  });

  it("renders numbered collapsible decisions from exact decision text", () => {
    const card = buildPrivateSlackApprovalBlockKitCardV1(INPUT);
    const decision = card.blocks.find(
      (block) => (block as { readonly type: string }).type === "container",
    ) as {
      readonly title: { readonly text: string };
      readonly subtitle: { readonly text: string };
      readonly child_blocks: readonly {
        readonly text: { readonly text: string };
      }[];
    };

    expect(decision.title.text).toBe("1 · Ship the private beta.");
    expect(decision.subtitle.text).toBe("1 why");
    expect(decision.child_blocks).toHaveLength(2);
    expect(decision.child_blocks[0].text.text).toContain("*Decision*");
    expect(decision.child_blocks[0].text.text).toContain(
      "Ship the private beta.",
    );
    expect(decision.child_blocks[0].text.text).not.toContain("Status:");
    expect(decision.child_blocks[0].text.text).not.toContain("Evidence:");
    expect(decision.child_blocks[1].text.text).toContain("*Why*");
    expect(decision.child_blocks[1].text.text).toContain(
      "pilot met the reliability target",
    );
    expect(decision.child_blocks[1].text.text).not.toContain("Evidence:");
  });

  it("labels owner-neutral next steps and unlinked context truthfully", () => {
    const card = buildPrivateSlackApprovalBlockKitCardV1(INPUT);
    const other = blockById(card, "other-meeting-items") as {
      readonly title: { readonly text: string };
      readonly child_blocks: readonly {
        readonly text: { readonly text: string };
      }[];
    };
    const rendered = other.child_blocks
      .map((block) => block.text.text)
      .join("\n");

    expect(other.title.text).toBe("Next steps and context");
    expect(rendered).toContain("*Next steps*");
    expect(rendered).not.toContain("Due:");
    expect(rendered).toContain("*Additional context*");
    expect(rendered).toContain("Budget remains within plan.");
    expect(rendered).not.toMatch(/owner|assignee|evidence/i);
    expect(card.text).toContain("Decision 1: Ship the private beta.");
    expect(card.text).toContain("Next steps from this meeting:");
    expect(card.text).toContain("Next step: Prepare the launch checklist.");
    expect(card.text).toContain("Additional meeting context:");
    expect(card.text).toContain("Context: Budget remains within plan.");
    expect(card.text).toContain("Evidence: block-05");
    expect(card.text).toContain("Evidence: block-06");
  });

  it("uses focused titles without rendering structured due-date rows", () => {
    const nextSteps = buildPrivateSlackApprovalBlockKitCardV1({
      ...INPUT,
      ungrouped_rationales: undefined,
    });
    const nextStepsBlock = blockById(nextSteps, "other-meeting-items") as {
      readonly title: { readonly text: string };
      readonly child_blocks: readonly {
        readonly text: { readonly text: string };
      }[];
    };
    expect(nextStepsBlock.title.text).toBe("Next steps from this meeting");
    expect(JSON.stringify(nextStepsBlock)).not.toContain("Due:");
    expect(nextSteps.text).not.toContain("Due:");

    const context = buildPrivateSlackApprovalBlockKitCardV1({
      ...INPUT,
      ungrouped_actions: undefined,
    });
    const contextBlock = blockById(context, "other-meeting-items") as {
      readonly title: { readonly text: string };
      readonly child_blocks: readonly {
        readonly text: { readonly text: string };
      }[];
    };
    expect(contextBlock.title.text).toBe("Additional meeting context");
    expect(contextBlock.child_blocks[0].text.text).toContain(
      "*Additional context*",
    );
  });

  it("renders the divider, final controls, and footer in the review contract", () => {
    const card = buildPrivateSlackApprovalBlockKitCardV1(INPUT);
    const dividerIndex = card.blocks.findIndex((block) =>
      (block as { readonly block_id?: string }).block_id?.endsWith(
        "-divider-v1",
      ),
    );
    const policyIndex = card.blocks.findIndex((block) =>
      (block as { readonly block_id?: string }).block_id?.endsWith(
        "-policy-v1",
      ),
    );
    const footer = blockById(card, "footer") as {
      readonly elements: readonly { readonly text: string }[];
    };

    expect(dividerIndex).toBeLessThan(policyIndex);
    expect(footer.elements[0].text).toBe(
      "One visibility policy applies to the entire meeting record.",
    );
    expect(card.text).toContain(
      "Raw transcript and rejected suggestions are not released.",
    );
  });

  it("uses described static selection and real deterministic action controls", () => {
    const card = buildPrivateSlackApprovalBlockKitCardV1(INPUT);
    const policy = blockById(card, "policy") as {
      readonly element: {
        readonly type: string;
        readonly action_id: string;
        readonly placeholder: { readonly text: string };
        readonly options: readonly {
          readonly value: string;
          readonly description: { readonly text: string };
        }[];
        readonly initial_option: { readonly value: string };
      };
    };
    const comment = blockById(card, "comment") as {
      readonly element: {
        readonly action_id: string;
        readonly max_length: number;
        readonly multiline: boolean;
        readonly placeholder: { readonly text: string };
      };
    };
    const actions = blockById(card, "actions") as {
      readonly elements: readonly {
        readonly action_id: string;
        readonly value: string;
      }[];
    };

    expect(policy.element).toMatchObject({
      type: "static_select",
      action_id: expect.stringMatching(
        /^echo-private-approval-v1-[0-9a-f]{32}-policy-v1$/,
      ),
      options: [
        {
          value: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
          description: { text: "Only you can read this record" },
        },
        {
          value: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          description: { text: "Current organization members can read it" },
        },
      ],
      initial_option: { value: RESTRICTED_REVIEWER_PERSON_POLICY_ID },
      placeholder: { text: "Choose who can read this record" },
    });
    expect(comment.element).toMatchObject({
      action_id: expect.stringMatching(
        /^echo-private-approval-v1-[0-9a-f]{32}-comment-v1$/,
      ),
      max_length: PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
      multiline: false,
      placeholder: { text: "Add context for this approval" },
    });
    expect(actions.elements).toEqual([
      expect.objectContaining({
        action_id: expect.stringMatching(
          /^echo-private-approval-v1-[0-9a-f]{32}-approve-v1$/,
        ),
        value: JSON.stringify({
          schema_version: 1,
          approval_id: INPUT.approval_id,
        }),
        text: expect.objectContaining({ text: "Approve meeting" }),
      }),
      expect.objectContaining({
        action_id: expect.stringMatching(
          /^echo-private-approval-v1-[0-9a-f]{32}-reject-v1$/,
        ),
        value: JSON.stringify({
          schema_version: 1,
          approval_id: INPUT.approval_id,
        }),
      }),
    ]);
  });

  it("escapes model text in mrkdwn and keeps deterministic IDs", () => {
    const raw = {
      ...INPUT,
      decision_groups: [
        {
          ...INPUT.decision_groups[0],
          decision: {
            text: "Ship <beta> & review > now",
            evidence_reference: "block<03>&",
            status: "decided" as const,
          },
        },
      ],
    };
    const first = buildPrivateSlackApprovalBlockKitCardV1(raw);
    const replay = buildPrivateSlackApprovalBlockKitCardV1({ ...raw });
    const section = (
      first.blocks.find(
        (block) => (block as { readonly type: string }).type === "container",
      ) as {
        readonly child_blocks: readonly {
          readonly text: { readonly text: string };
        }[];
      }
    ).child_blocks[0].text.text;

    expect(section).toContain("Ship &lt;beta&gt; &amp; review &gt; now");
    expect(first.text).toContain("block<03>&");
    expect(
      first.blocks.map(
        (block) => (block as { readonly block_id: string }).block_id,
      ),
    ).toEqual(
      replay.blocks.map(
        (block) => (block as { readonly block_id: string }).block_id,
      ),
    );
  });

  it("truncates only the displayed decision title, never the frozen decision", () => {
    const decisionText = "A".repeat(200);
    const card = buildPrivateSlackApprovalBlockKitCardV1({
      ...INPUT,
      decision_groups: [
        {
          ...INPUT.decision_groups[0],
          decision: {
            ...INPUT.decision_groups[0].decision,
            text: decisionText,
          },
        },
      ],
    });
    const decision = card.blocks.find(
      (block) => (block as { readonly type: string }).type === "container",
    ) as {
      readonly title: { readonly text: string };
      readonly child_blocks: readonly { readonly text: { readonly text: string } }[];
    };

    expect(decision.title.text).toBe(`1 · ${"A".repeat(145)}…`);
    expect(decision.child_blocks[0].text.text).toContain(decisionText);
    expect(card.text).toContain(decisionText);
  });

  it("fails closed on malformed shape, oversized sections, and more than 50 blocks", () => {
    expect(() =>
      buildPrivateSlackApprovalBlockKitCardV1({
        ...INPUT,
        actor_id: "prn_attacker",
      } as never),
    ).toThrow(/unexpected shape/);
    expect(() =>
      buildPrivateSlackApprovalBlockKitCardV1({
        ...INPUT,
        ungrouped_actions: [
          { ...INPUT.ungrouped_actions[0], text: "x".repeat(3_001) },
        ],
      }),
    ).toThrow(/ungrouped_actions\[0\]\.text/);
    expect(() =>
      buildPrivateSlackApprovalBlockKitCardV1({
        ...INPUT,
        decision_groups: Array.from({ length: 45 }, (_, index) => ({
          ...INPUT.decision_groups[0],
          id: `dec_${index}`,
        })),
      }),
    ).toThrow(/50-block/);
    expect(() =>
      buildPrivateSlackApprovalBlockKitCardV1({
        ...INPUT,
        decision_groups: [
          {
            ...INPUT.decision_groups[0],
            rationales: Array.from({ length: 10 }, () => ({
              text: "x".repeat(500),
              evidence_reference: "block-04",
            })),
          },
        ],
        ungrouped_actions: undefined,
        ungrouped_rationales: undefined,
      }),
    ).toThrow(/Why section/);
  });
});
