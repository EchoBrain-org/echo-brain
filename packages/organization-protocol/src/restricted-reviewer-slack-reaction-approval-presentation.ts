import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
  assertRestrictedReviewerSlackReactionPair,
} from "./restricted-reviewer-slack-reaction-approval-policy.js";
import {
  validateRestrictedReviewerReleaseDraft,
  type RestrictedReviewerReleaseDraftV1,
} from "./restricted-reviewer-release-draft.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export const RESTRICTED_REVIEWER_SLACK_REACTION_APPROVAL_PRESENTATION_KIND =
  "reviewer-approval-presentation-v1";

/**
 * Slack's structural ceilings. A package that cannot render as the
 * complete closed card is not eligible for reviewer V1: there is no ellipsis,
 * truncation, hidden count, or unrendered releasable item to fall back on.
 */
const MAX_SLACK_HEADER_TEXT_CHARACTERS = 150;
const MAX_SLACK_SECTION_TEXT_CHARACTERS = 3000;
const MAX_SLACK_CONTEXT_TEXT_CHARACTERS = 3000;
const MAX_SLACK_BLOCK_ID_CHARACTERS = 255;
const MAX_SLACK_BLOCKS = 50;
const MAX_SLACK_MESSAGE_TEXT_CHARACTERS = 40_000;

export interface RestrictedReviewerSlackReactionPlainTextV1 {
  type: "plain_text";
  text: string;
  emoji: false;
}

export interface RestrictedReviewerSlackReactionHeaderBlockV1 {
  type: "header";
  block_id: string;
  text: RestrictedReviewerSlackReactionPlainTextV1;
}

export interface RestrictedReviewerSlackReactionSectionBlockV1 {
  type: "section";
  block_id: string;
  text: RestrictedReviewerSlackReactionPlainTextV1;
}

export interface RestrictedReviewerSlackReactionContextBlockV1 {
  type: "context";
  block_id: string;
  elements: readonly [
    { type: "mrkdwn"; text: string; verbatim: false },
  ];
}

export type RestrictedReviewerSlackReactionApprovalBlockV1 =
  | RestrictedReviewerSlackReactionHeaderBlockV1
  | RestrictedReviewerSlackReactionSectionBlockV1
  | RestrictedReviewerSlackReactionContextBlockV1;

export interface RestrictedReviewerSlackReactionApprovalTransportV1 {
  mrkdwn: false;
  unfurl_links: false;
  unfurl_media: false;
}

export interface RestrictedReviewerSlackReactionApprovalPresentationV1 {
  schema_version: 1;
  kind: typeof RESTRICTED_REVIEWER_SLACK_REACTION_APPROVAL_PRESENTATION_KIND;
  approval_id: string;
  approve_reaction: string;
  reject_reaction: string;
  text: string;
  blocks: readonly RestrictedReviewerSlackReactionApprovalBlockV1[];
  transport: RestrictedReviewerSlackReactionApprovalTransportV1;
}

export const RESTRICTED_REVIEWER_SLACK_REACTION_APPROVAL_TRANSPORT:
  RestrictedReviewerSlackReactionApprovalTransportV1 = Object.freeze({
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
  });

function restrictedReviewerSlackReactionApprovalFallbackReactionLine(
  approveReaction: string,
  rejectReaction: string,
): string {
  return `React :${approveReaction}: to approve or :${rejectReaction}: to reject. To record a reason, reply in this thread before reacting.`;
}

function restrictedReviewerSlackReactionApprovalContextReactionLine(
  approveReaction: string,
  rejectReaction: string,
): string {
  return `React :${approveReaction}: to approve or :${rejectReaction}: to reject. To record a reason, reply in this thread *before* reacting.`;
}

/**
 * The complete deterministic alternative presentation. Screen-reader users see
 * the same package, in the same frozen item order, as the block rendering.
 */
function restrictedReviewerSlackReactionApprovalFallbackText(input: {
  readonly draft: RestrictedReviewerReleaseDraftV1;
  readonly approve_reaction: string;
  readonly reject_reaction: string;
}): string {
  return [
    "Decision brief awaiting approval.",
    `Title: ${input.draft.card_title}`,
    ...input.draft.items.map((item) => `${item.kind}: ${item.text}`),
    RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
    restrictedReviewerSlackReactionApprovalFallbackReactionLine(
      input.approve_reaction,
      input.reject_reaction,
    ),
  ].join("\n");
}

function restrictedReviewerSlackReactionApprovalTitleBlockId(
  approvalId: string,
): string {
  return `echo-approval-${approvalId}-title-v1`;
}

function restrictedReviewerSlackReactionApprovalItemBlockId(
  approvalId: string,
  index: number,
  signalIdSha256: string,
): string {
  return `echo-approval-${approvalId}-item-${index}-${signalIdSha256.slice(
    "sha256:".length,
  )}-v1`;
}

function restrictedReviewerSlackReactionApprovalPolicyBlockId(
  approvalId: string,
): string {
  return `echo-approval-${approvalId}-reviewer-policy-v1`;
}

function restrictedReviewerSlackReactionApprovalReactionBlockId(
  approvalId: string,
): string {
  return `echo-approval-${approvalId}-reaction-v1`;
}

function assertFits(
  value: string,
  maximum: number,
  label: string,
): void {
  if (value.length > maximum) {
    organizationProtocolValidationFailure(
      `${label} does not fit the complete closed reviewer card`,
    );
  }
}

export interface RestrictedReviewerSlackReactionApprovalPresentationInput {
  readonly draft: RestrictedReviewerReleaseDraftV1;
  readonly approve_reaction: string;
  readonly reject_reaction: string;
}

/**
 * Builds the one exact reviewer card. Every block is closed, every item is
 * rendered verbatim with its lowercase wire kind, and the accessibility
 * fallback is a complete alternative presentation of the same package.
 */
export function restrictedReviewerSlackReactionApprovalPresentation(
  input: RestrictedReviewerSlackReactionApprovalPresentationInput,
): RestrictedReviewerSlackReactionApprovalPresentationV1 {
  const draft = validateRestrictedReviewerReleaseDraft(input.draft);
  assertRestrictedReviewerSlackReactionPair(
    input.approve_reaction,
    input.reject_reaction,
    "reviewer approval presentation",
  );
  const approvalId = draft.approval_id;

  const titleBlock: RestrictedReviewerSlackReactionHeaderBlockV1 = {
    type: "header",
    block_id: restrictedReviewerSlackReactionApprovalTitleBlockId(approvalId),
    text: { type: "plain_text", text: draft.card_title, emoji: false },
  };
  assertFits(
    titleBlock.text.text,
    MAX_SLACK_HEADER_TEXT_CHARACTERS,
    "reviewer approval presentation title",
  );

  const itemBlocks: RestrictedReviewerSlackReactionSectionBlockV1[] =
    draft.items.map(
      (item, index) => {
        const block: RestrictedReviewerSlackReactionSectionBlockV1 = {
          type: "section",
          block_id: restrictedReviewerSlackReactionApprovalItemBlockId(
            approvalId,
            index,
            item.signal_id_sha256,
          ),
          text: {
            type: "plain_text",
            text: `${item.kind}: ${item.text}`,
            emoji: false,
          },
        };
        assertFits(
          block.text.text,
          MAX_SLACK_SECTION_TEXT_CHARACTERS,
          `reviewer approval presentation item ${index}`,
        );
        return block;
      },
    );

  const policyBlock: RestrictedReviewerSlackReactionSectionBlockV1 = {
    type: "section",
    block_id:
      restrictedReviewerSlackReactionApprovalPolicyBlockId(approvalId),
    text: {
      type: "plain_text",
      text: RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
      emoji: false,
    },
  };
  assertFits(
    policyBlock.text.text,
    MAX_SLACK_SECTION_TEXT_CHARACTERS,
    "reviewer approval presentation consequence",
  );

  const reactionBlock: RestrictedReviewerSlackReactionContextBlockV1 = {
    type: "context",
    block_id:
      restrictedReviewerSlackReactionApprovalReactionBlockId(approvalId),
    elements: [
      {
        type: "mrkdwn",
        text: restrictedReviewerSlackReactionApprovalContextReactionLine(
          input.approve_reaction,
          input.reject_reaction,
        ),
        verbatim: false,
      },
    ],
  };
  assertFits(
    reactionBlock.elements[0].text,
    MAX_SLACK_CONTEXT_TEXT_CHARACTERS,
    "reviewer approval presentation reaction instructions",
  );

  const blocks: RestrictedReviewerSlackReactionApprovalBlockV1[] = [
    titleBlock,
    ...itemBlocks,
    policyBlock,
    reactionBlock,
  ];
  if (blocks.length > MAX_SLACK_BLOCKS) {
    organizationProtocolValidationFailure(
      "reviewer approval presentation does not fit the complete closed reviewer card",
    );
  }
  for (const block of blocks) {
    assertFits(
      block.block_id,
      MAX_SLACK_BLOCK_ID_CHARACTERS,
      "reviewer approval presentation block id",
    );
  }

  const text = restrictedReviewerSlackReactionApprovalFallbackText({
    draft,
    approve_reaction: input.approve_reaction,
    reject_reaction: input.reject_reaction,
  });
  assertFits(
    text,
    MAX_SLACK_MESSAGE_TEXT_CHARACTERS,
    "reviewer approval presentation fallback",
  );

  return {
    schema_version: 1,
    kind: RESTRICTED_REVIEWER_SLACK_REACTION_APPROVAL_PRESENTATION_KIND,
    approval_id: approvalId,
    approve_reaction: input.approve_reaction,
    reject_reaction: input.reject_reaction,
    text,
    blocks,
    transport: {
      ...RESTRICTED_REVIEWER_SLACK_REACTION_APPROVAL_TRANSPORT,
    },
  };
}

export function restrictedReviewerSlackReactionApprovalPresentationSha256(
  presentation: RestrictedReviewerSlackReactionApprovalPresentationV1,
): Sha256Digest {
  return canonicalSha256(presentation);
}
