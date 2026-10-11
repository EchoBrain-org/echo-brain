import { describe, expect, it } from "vitest";
import { buildPrivateSlackApprovalReviewV1 } from "../../src/private-approval/private-slack-approval-block-kit-card-v1.js";

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

type Card = ReturnType<typeof buildPrivateSlackApprovalReviewV1>;
type TextBlocks = readonly { readonly text: { readonly text: string } }[];

function blockIndex(card: Card, suffix: string) {
  return card.blocks.findIndex((block) =>
    (block as { readonly block_id?: string }).block_id?.endsWith(
      `-${suffix}-v1`,
    ),
  );
}

function blockById(card: Card, suffix: string) {
  return card.blocks[blockIndex(card, suffix)];
}

function decisionBlock(card: Card) {
  return card.blocks.find(
    (block) => (block as { readonly type: string }).type === "container",
  ) as {
    readonly title: { readonly text: string };
    readonly subtitle: { readonly text: string };
    readonly child_blocks: TextBlocks;
  };
}

function otherItems(card: Card) {
  return blockById(card, "other-meeting-items") as {
    readonly title: { readonly text: string };
    readonly child_blocks: TextBlocks;
  };
}

describe("private approval review v1", () => {
  it("uses the meeting title as the primary card heading", () => {
    const card = buildPrivateSlackApprovalReviewV1(INPUT);
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
    const card = buildPrivateSlackApprovalReviewV1(INPUT);
    const decision = decisionBlock(card);

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
    const card = buildPrivateSlackApprovalReviewV1(INPUT);
    const other = otherItems(card);
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
    const nextSteps = buildPrivateSlackApprovalReviewV1({
      ...INPUT,
      ungrouped_rationales: undefined,
    });
    const nextStepsBlock = otherItems(nextSteps);
    expect(nextStepsBlock.title.text).toBe("Next steps from this meeting");
    expect(JSON.stringify(nextStepsBlock)).not.toContain("Due:");
    expect(nextSteps.text).not.toContain("Due:");

    const context = buildPrivateSlackApprovalReviewV1({
      ...INPUT,
      ungrouped_actions: undefined,
    });
    const contextBlock = otherItems(context);
    expect(contextBlock.title.text).toBe("Additional meeting context");
    expect(contextBlock.child_blocks[0].text.text).toContain(
      "*Additional context*",
    );
  });

  it("ends the review text with the non-release notice and no controls", () => {
    const card = buildPrivateSlackApprovalReviewV1(INPUT);

    expect(card.text.split("\n").at(-1)).toBe(
      "Raw transcript and rejected suggestions are not released.",
    );
    expect(card.blocks.map((block) => block.type)).toEqual([
      "header",
      "context",
      "container",
      "container",
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
    const first = buildPrivateSlackApprovalReviewV1(raw);
    const replay = buildPrivateSlackApprovalReviewV1({ ...raw });
    const section = decisionBlock(first).child_blocks[0].text.text;

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
    const card = buildPrivateSlackApprovalReviewV1({
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
    const decision = decisionBlock(card);

    expect(decision.title.text).toBe(`1 · ${"A".repeat(145)}…`);
    expect(decision.child_blocks[0].text.text).toContain(decisionText);
    expect(card.text).toContain(decisionText);
  });

  it("fails closed on malformed shape, oversized sections, and more than 50 blocks", () => {
    expect(() =>
      buildPrivateSlackApprovalReviewV1({
        ...INPUT,
        actor_id: "prn_attacker",
      } as never),
    ).toThrow(/unexpected shape/);
    expect(() =>
      buildPrivateSlackApprovalReviewV1({
        ...INPUT,
        ungrouped_actions: [
          { ...INPUT.ungrouped_actions[0], text: "x".repeat(3_001) },
        ],
      }),
    ).toThrow(/ungrouped_actions\[0\]\.text/);
    expect(() =>
      buildPrivateSlackApprovalReviewV1({
        ...INPUT,
        decision_groups: Array.from({ length: 45 }, (_, index) => ({
          ...INPUT.decision_groups[0],
          id: `dec_${index}`,
        })),
      }),
    ).toThrow(/50-block/);
    expect(() =>
      buildPrivateSlackApprovalReviewV1({
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
