import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT,
  ORGANIZATION_MEMBER_READABLE_POLICY_ID,
  organizationMemberMessagePresentationPreimage,
  organizationMemberReadableAuditDetail,
  organizationMemberReadableSemanticPreimage,
} from "../src/application/organization-member-readable-policy.js";
import {
  isOrganizationMemberCardBlockId,
  reconstructOrganizationMemberCard,
} from "../src/adapters/slack/organization-member-card-grammar.js";
import { canonicalSha256 } from "../src/canonical/canonical-json.js";

const APPROVAL_ID = "f".repeat(64);
const SIGNAL_DIGEST_HEX = "a".repeat(64);
const DIGEST = `sha256:${"b".repeat(64)}`;
const NOW = "2026-08-12T08:00:00.000Z";

const TITLE = "Make the launch decision visible to members";
const ITEM_TEXT = "Ship the local permission-aware lexical search.";

function memberBlocks(): unknown[] {
  return [
    {
      type: "header",
      block_id: `echo-approval-${APPROVAL_ID}-title-v1`,
      text: { type: "plain_text", text: TITLE, emoji: false },
    },
    {
      type: "section",
      block_id: `echo-approval-${APPROVAL_ID}-item-0-${SIGNAL_DIGEST_HEX}-v1`,
      text: {
        type: "plain_text",
        text: `decision: ${ITEM_TEXT}`,
        emoji: false,
      },
    },
    {
      type: "section",
      block_id: `echo-approval-${APPROVAL_ID}-organization-member-policy-v1`,
      text: {
        type: "plain_text",
        text: ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT,
        emoji: false,
      },
    },
    {
      type: "context",
      block_id: `echo-approval-${APPROVAL_ID}-reaction-v1`,
      elements: [
        {
          type: "mrkdwn",
          text: "React :white_check_mark: to approve or :x: to reject. To record a reason, reply in this thread *before* reacting.",
          verbatim: false,
        },
      ],
    },
  ];
}

const FALLBACK = [
  "Decision brief awaiting approval.",
  `Title: ${TITLE}`,
  `decision: ${ITEM_TEXT}`,
  ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT,
  "React :white_check_mark: to approve or :x: to reject. To record a reason, reply in this thread before reacting.",
].join("\n");

describe("organization-member-readable card grammar", () => {
  it("reconstructs the exact domain-separated release and presentation digests", () => {
    const reconstructed = reconstructOrganizationMemberCard({
      approval_id: APPROVAL_ID,
      blocks: memberBlocks(),
      fallback_text: FALLBACK,
    });

    expect(reconstructed).toEqual({
      approve_reaction: "white_check_mark",
      reject_reaction: "x",
      release_draft_sha256: canonicalSha256({
        schema_version: 1,
        kind: "organization-member-readable-release-draft-v1",
        approval_id: APPROVAL_ID,
        card_title: TITLE,
        items: [
          {
            signal_id_sha256: `sha256:${SIGNAL_DIGEST_HEX}`,
            kind: "decision",
            text: ITEM_TEXT,
          },
        ],
      }),
      approval_presentation_sha256: canonicalSha256({
        schema_version: 1,
        kind: "organization-member-readable-approval-presentation-v1",
        approval_id: APPROVAL_ID,
        approve_reaction: "white_check_mark",
        reject_reaction: "x",
        text: FALLBACK,
        blocks: memberBlocks(),
        transport: {
          mrkdwn: false,
          unfurl_links: false,
          unfurl_media: false,
        },
      }),
    });
  });

  it("rejects edits, the reviewer namespace, hidden fields, and malformed reactions", () => {
    const cases: unknown[][] = [
      memberBlocks().filter((_block, index) => index !== 2),
      memberBlocks().map((block, index) =>
        index === 2
          ? {
              ...(block as Record<string, unknown>),
              block_id: `echo-approval-${APPROVAL_ID}-reviewer-policy-v1`,
            }
          : block,
      ),
      memberBlocks().map((block, index) =>
        index === 1 ? { ...(block as Record<string, unknown>), accessory: {} } : block,
      ),
      memberBlocks().map((block, index) =>
        index === 3
          ? {
              ...(block as Record<string, unknown>),
              elements: [
                {
                  type: "mrkdwn",
                  text: "React :x: to approve or :x: to reject. To record a reason, reply in this thread *before* reacting.",
                  verbatim: false,
                },
              ],
            }
          : block,
      ),
    ];

    for (const blocks of cases) {
      expect(
        reconstructOrganizationMemberCard({
          approval_id: APPROVAL_ID,
          blocks,
          fallback_text: FALLBACK,
        }),
      ).toBeNull();
    }
    expect(
      reconstructOrganizationMemberCard({
        approval_id: APPROVAL_ID,
        blocks: memberBlocks(),
        fallback_text: `${FALLBACK} edited`,
      }),
    ).toBeNull();
  });

  it("recognizes only the closed organization-member card block namespace", () => {
    expect(
      isOrganizationMemberCardBlockId(
        `echo-approval-${APPROVAL_ID}-organization-member-policy-v1`,
        APPROVAL_ID,
      ),
    ).toBe(true);
    expect(
      isOrganizationMemberCardBlockId(
        `echo-approval-${APPROVAL_ID}-reviewer-policy-v1`,
        APPROVAL_ID,
      ),
    ).toBe(false);
  });
});

describe("organization-member-readable proof preimages", () => {
  it("pins the future-member consequence without materializing a recipient list", () => {
    const semantic = organizationMemberReadableSemanticPreimage({
      authority_id: "oau_11111111-1111-4111-8111-111111111111",
      organization_id: "org_22222222-2222-4222-8222-222222222222",
      policy_contract_sha256: DIGEST,
      approval_id: APPROVAL_ID,
      approving_principal_id: "prn_33333333-3333-4333-8333-333333333333",
      approving_membership_id: "mem_44444444-4444-4444-8444-444444444444",
      release_draft_sha256: DIGEST,
      approval_presentation_sha256: DIGEST,
      evaluated_at: NOW,
    });

    expect(semantic).toMatchObject({
      policy_id: ORGANIZATION_MEMBER_READABLE_POLICY_ID,
      visibility: "organization-member-readable",
      consequence_text: ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT,
      eligible_membership_types: ["employee", "owner"],
    });
    expect(Object.keys(semantic)).not.toContain("reader_ids");
    expect(Object.keys(semantic)).not.toContain("recipient_membership_ids");
  });

  it("keeps message and audit evidence content-free and policy-bound", () => {
    const message = organizationMemberMessagePresentationPreimage({
      provider_event_sha256: DIGEST,
      approval_presentation_sha256: DIGEST,
      team_id: "T012ABCDEF",
      enterprise_id: null,
      bot_user_id: "U012BOTUSER",
      bot_id: "B012BOTID",
      app_id: "A012APPID",
      actor_user_id: "U012APPROVER",
      channel_id: "C012CHANNEL",
      message_ts: "1754900000.000100",
      reaction_name: "white_check_mark",
    });
    const detail = organizationMemberReadableAuditDetail({
      authority_id: "oau_11111111-1111-4111-8111-111111111111",
      request_sha256: DIGEST,
      provider_event_sha256: DIGEST,
      principal_id: "prn_33333333-3333-4333-8333-333333333333",
      policy_contract_sha256: DIGEST,
      team_id: "T012ABCDEF",
      enterprise_id: null,
      bot_user_id: "U012BOTUSER",
      bot_id: "B012BOTID",
      app_id: "A012APPID",
      actor_user_id: "U012APPROVER",
      adapter_id: "slack-reactions",
      adapter_instance_id: "organization-member",
      adapter_version: "1.0.0",
      channel_id: "C012CHANNEL",
      message_ts: "1754900000.000100",
      reaction_name: "white_check_mark",
      approve_reaction: "white_check_mark",
      reject_reaction: "x",
      release_draft_sha256: DIGEST,
      approval_presentation_sha256: DIGEST,
      semantic_intent_sha256: DIGEST,
      message_presentation_sha256: canonicalSha256(message),
    });

    expect(detail).toMatchObject({
      schema_version: 3,
      policy_id: ORGANIZATION_MEMBER_READABLE_POLICY_ID,
      eligible_membership_types: ["employee", "owner"],
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(TITLE);
    expect(serialized).not.toContain(ITEM_TEXT);
  });
});
