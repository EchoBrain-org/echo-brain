import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import { describe, expect, it } from "vitest";
import {
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1,
  buildPrivateApprovalBlockKitCardV1,
  privateApprovalBlockKitActionIdV1,
} from "../../src/composition/private-approval-block-kit-card-v1.js";

const INPUT = Object.freeze({
  schema_version: 1 as const,
  approval_id: "apr_00000000-0000-4000-8000-000000000001",
  assignment_version: 3,
  meeting_title: "Weekly product review",
  approval_context: "Approve the captured decision and action items from this meeting.",
});

function everyNestedObjectIsFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return (
    Object.isFrozen(value) &&
    Object.values(value).every((nested) => everyNestedObjectIsFrozen(nested))
  );
}

describe("private approval Block Kit card v1", () => {
  it("renders the complete private-owner card with only the two current policies", () => {
    const card = buildPrivateApprovalBlockKitCardV1(INPUT);
    const [title, context, divider, policy, comment, actions] = card.blocks;

    expect(card).toMatchObject({
      schema_version: 1,
      kind: "echo-private-approval-block-kit-card-v1",
      approval_id: INPUT.approval_id,
      assignment_version: INPUT.assignment_version,
      transport: { mrkdwn: false, unfurl_links: false, unfurl_media: false },
    });
    expect(card.text).toContain("Private meeting-owner approval requested.");
    expect(card.text).toContain(INPUT.meeting_title);
    expect(card.text).toContain(INPUT.approval_context);
    expect(title).toEqual({
      type: "header",
      block_id: expect.stringMatching(/^echo-private-approval-v1-[0-9a-f]{32}-title-v1$/),
      text: { type: "plain_text", text: INPUT.meeting_title, emoji: false },
    });
    expect(context).toEqual({
      type: "section",
      block_id: expect.stringMatching(/^echo-private-approval-v1-[0-9a-f]{32}-context-v1$/),
      text: { type: "plain_text", text: INPUT.approval_context, emoji: false },
    });
    expect(divider).toEqual({
      type: "divider",
      block_id: expect.stringMatching(/^echo-private-approval-v1-[0-9a-f]{32}-divider-v1$/),
    });
    expect(policy).toEqual({
      type: "input",
      block_id: expect.stringMatching(/^echo-private-approval-v1-[0-9a-f]{32}-policy-v1$/),
      optional: false,
      label: {
        type: "plain_text",
        text: "Who should be able to read this record?",
        emoji: false,
      },
      element: {
        type: "radio_buttons",
        action_id: expect.stringMatching(/^echo-private-approval-v1-[0-9a-f]{32}-policy-v1$/),
        options: [
          {
            text: { type: "plain_text", text: "Only me", emoji: false },
            value: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
          },
          {
            text: { type: "plain_text", text: "Team", emoji: false },
            value: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          },
        ],
        initial_option: {
          text: { type: "plain_text", text: "Only me", emoji: false },
          value: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        },
      },
    });
    expect(comment).toEqual({
      type: "input",
      block_id: expect.stringMatching(/^echo-private-approval-v1-[0-9a-f]{32}-comment-v1$/),
      optional: true,
      label: { type: "plain_text", text: "Comment (optional)", emoji: false },
      element: {
        type: "plain_text_input",
        action_id: expect.stringMatching(/^echo-private-approval-v1-[0-9a-f]{32}-comment-v1$/),
        multiline: true,
        max_length: PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
      },
    });
    expect(actions).toEqual({
      type: "actions",
      block_id: expect.stringMatching(/^echo-private-approval-v1-[0-9a-f]{32}-actions-v1$/),
      elements: [
        {
          type: "button",
          action_id: expect.stringMatching(/^echo-private-approval-v1-[0-9a-f]{32}-approve-v1$/),
          style: "primary",
          text: { type: "plain_text", text: "Approve", emoji: false },
          value: JSON.stringify({
            schema_version: 1,
            approval_id: INPUT.approval_id,
            assignment_version: INPUT.assignment_version,
          }),
        },
        {
          type: "button",
          action_id: expect.stringMatching(/^echo-private-approval-v1-[0-9a-f]{32}-reject-v1$/),
          style: "danger",
          text: { type: "plain_text", text: "Reject", emoji: false },
          value: JSON.stringify({
            schema_version: 1,
            approval_id: INPUT.approval_id,
            assignment_version: INPUT.assignment_version,
          }),
        },
      ],
    });
    expect(everyNestedObjectIsFrozen(card)).toBe(true);
  });

  it("derives stable, version-scoped Slack IDs and reserves, but does not render, delegation", () => {
    const first = buildPrivateApprovalBlockKitCardV1(INPUT);
    const replay = buildPrivateApprovalBlockKitCardV1({ ...INPUT });
    const reassigned = buildPrivateApprovalBlockKitCardV1({
      ...INPUT,
      assignment_version: INPUT.assignment_version + 1,
    });

    expect(first.blocks.map((block) => block.block_id)).toEqual(
      replay.blocks.map((block) => block.block_id),
    );
    expect(first.blocks.map((block) => block.block_id)).not.toEqual(
      reassigned.blocks.map((block) => block.block_id),
    );
    expect(
      privateApprovalBlockKitActionIdV1(
        INPUT,
        PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.delegate,
      ),
    ).toMatch(/^echo-private-approval-v1-[0-9a-f]{32}-delegate-v1$/);
    expect(JSON.stringify(first.blocks)).not.toContain("delegate");
    expect(first.blocks.every((block) => block.block_id.length <= 255)).toBe(
      true,
    );
  });

  it("keeps actor and policy claims out of button values", () => {
    const actions = buildPrivateApprovalBlockKitCardV1(INPUT).blocks[5];
    const values = actions.elements.map((element) => JSON.parse(element.value));

    expect(values).toEqual([
      {
        schema_version: 1,
        approval_id: INPUT.approval_id,
        assignment_version: INPUT.assignment_version,
      },
      {
        schema_version: 1,
        approval_id: INPUT.approval_id,
        assignment_version: INPUT.assignment_version,
      },
    ]);
    expect(JSON.stringify(values)).not.toMatch(/principal|membership|actor|policy/i);
  });

  it("fails closed on unbounded, malformed, or shape-expanded input", () => {
    expect(() =>
      buildPrivateApprovalBlockKitCardV1({
        ...INPUT,
        approval_id: "not valid because spaces",
      }),
    ).toThrow(/approval_id/);
    expect(() =>
      buildPrivateApprovalBlockKitCardV1({
        ...INPUT,
        meeting_title: "x".repeat(151),
      }),
    ).toThrow(/meeting_title/);
    expect(() =>
      buildPrivateApprovalBlockKitCardV1({
        ...INPUT,
        approval_context: "x".repeat(3_001),
      }),
    ).toThrow(/approval_context/);
    expect(() =>
      buildPrivateApprovalBlockKitCardV1({
        ...INPUT,
        assignment_version: 0,
      }),
    ).toThrow(/assignment_version/);
    expect(() =>
      buildPrivateApprovalBlockKitCardV1({ ...INPUT, actor_id: "prn_attacker" } as never),
    ).toThrow(/unexpected shape/);
  });

  it("requires canonical display text while allowing only LF and TAB inside approval context", () => {
    expect(() =>
      buildPrivateApprovalBlockKitCardV1({
        ...INPUT,
        meeting_title: " Weekly product review",
      }),
    ).toThrow(/canonically trimmed/);
    expect(() =>
      buildPrivateApprovalBlockKitCardV1({
        ...INPUT,
        meeting_title: "Weekly product review\n",
      }),
    ).toThrow(/canonically trimmed/);
    expect(() =>
      buildPrivateApprovalBlockKitCardV1({
        ...INPUT,
        approval_context: "Approve\rthis record.",
      }),
    ).toThrow(/disallowed controls/);
    expect(() =>
      buildPrivateApprovalBlockKitCardV1({
        ...INPUT,
        approval_context: "Approve\u0000this record.",
      }),
    ).toThrow(/disallowed controls/);
    expect(() =>
      buildPrivateApprovalBlockKitCardV1({
        ...INPUT,
        approval_context: "Approve\u007Fthis record.",
      }),
    ).toThrow(/disallowed controls/);

    expect(
      buildPrivateApprovalBlockKitCardV1({
        ...INPUT,
        approval_context: "Approve this record.\n\tThen notify the team.",
      }).blocks[1].text.text,
    ).toBe("Approve this record.\n\tThen notify the team.");
  });
});
