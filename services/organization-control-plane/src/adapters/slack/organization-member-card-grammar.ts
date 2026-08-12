import {
  ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT,
  ORGANIZATION_MEMBER_READABLE_POLICY_ID,
} from "../../application/organization-member-readable-policy.js";
import { canonicalSha256 } from "../../canonical/canonical-json.js";

/**
 * Strict reconstruction of the organization-member-readable Slack card.
 * Human text exists only in this bounded call and is never returned or stored.
 */

const APPROVAL_ID = /^[0-9a-f]{64}$/;
const REACTION_NAME = /^[a-z0-9_+-]{1,64}$/;
const SIGNAL_DIGEST_HEX = /^[0-9a-f]{64}$/;
const RELEASE_ITEM_KINDS = ["decision", "action", "rationale"] as const;
const MAX_CARD_TITLE_SCALARS = 150;
const MAX_ITEM_TEXT_SCALARS = 240;
const MAX_RELEASE_ITEMS = 10;

type ReleaseItemKind = (typeof RELEASE_ITEM_KINDS)[number];

export interface OrganizationMemberCardReconstruction {
  readonly approve_reaction: string;
  readonly reject_reaction: string;
  readonly release_draft_sha256: `sha256:${string}`;
  readonly approval_presentation_sha256: `sha256:${string}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function presentableText(value: unknown, maximumScalars: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (
      (code >= 0xd800 && code <= 0xdfff) ||
      code <= 0x001f ||
      (code >= 0x007f && code <= 0x009f) ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      return null;
    }
  }
  if (value.trim() !== value || value.normalize("NFC") !== value) return null;
  if ([...value].length > maximumScalars) return null;
  return value;
}

function plainTextBlock(
  block: Record<string, unknown>,
  type: "header" | "section",
  blockId: string,
  maximumScalars: number,
): string | null {
  if (
    Object.keys(block).sort().join(",") !== "block_id,text,type" ||
    block["type"] !== type ||
    block["block_id"] !== blockId ||
    !isPlainObject(block["text"])
  ) {
    return null;
  }
  const text = block["text"];
  if (
    Object.keys(text).sort().join(",") !== "emoji,text,type" ||
    text["type"] !== "plain_text" ||
    text["emoji"] !== false
  ) {
    return null;
  }
  return presentableText(text["text"], maximumScalars);
}

function contextReactions(
  block: Record<string, unknown>,
  approvalId: string,
): { approve_reaction: string; reject_reaction: string } | null {
  if (
    Object.keys(block).sort().join(",") !== "block_id,elements,type" ||
    block["type"] !== "context" ||
    block["block_id"] !== `echo-approval-${approvalId}-reaction-v1` ||
    !Array.isArray(block["elements"]) ||
    block["elements"].length !== 1
  ) {
    return null;
  }
  const element = block["elements"][0];
  if (
    !isPlainObject(element) ||
    Object.keys(element).sort().join(",") !== "text,type,verbatim" ||
    element["type"] !== "mrkdwn" ||
    element["verbatim"] !== false ||
    typeof element["text"] !== "string"
  ) {
    return null;
  }
  const match =
    /^React :([a-z0-9_+-]{1,64}): to approve or :([a-z0-9_+-]{1,64}): to reject\. To record a reason, reply in this thread \*before\* reacting\.$/.exec(
      element["text"],
    );
  if (match === null) return null;
  const approve = match[1] as string;
  const reject = match[2] as string;
  if (
    !REACTION_NAME.test(approve) ||
    !REACTION_NAME.test(reject) ||
    approve === reject
  ) {
    return null;
  }
  return { approve_reaction: approve, reject_reaction: reject };
}

export function reconstructOrganizationMemberCard(input: {
  readonly approval_id: string;
  readonly blocks: readonly unknown[];
  readonly fallback_text: unknown;
}): OrganizationMemberCardReconstruction | null {
  const approvalId = input.approval_id;
  if (!APPROVAL_ID.test(approvalId)) return null;
  const blocks = input.blocks;
  if (blocks.length < 4 || blocks.length > MAX_RELEASE_ITEMS + 3) return null;

  const header = blocks[0];
  if (!isPlainObject(header)) return null;
  const cardTitle = plainTextBlock(
    header,
    "header",
    `echo-approval-${approvalId}-title-v1`,
    MAX_CARD_TITLE_SCALARS,
  );
  if (cardTitle === null) return null;

  const itemCount = blocks.length - 3;
  const items: {
    signal_id_sha256: `sha256:${string}`;
    kind: ReleaseItemKind;
    text: string;
  }[] = [];
  const seenDigests = new Set<string>();
  for (let index = 0; index < itemCount; index += 1) {
    const block = blocks[index + 1];
    if (!isPlainObject(block)) return null;
    const blockId = block["block_id"];
    if (typeof blockId !== "string") return null;
    const prefix = `echo-approval-${approvalId}-item-${index}-`;
    if (!blockId.startsWith(prefix) || !blockId.endsWith("-v1")) return null;
    const digestHex = blockId.slice(prefix.length, -"-v1".length);
    if (!SIGNAL_DIGEST_HEX.test(digestHex) || seenDigests.has(digestHex)) {
      return null;
    }
    seenDigests.add(digestHex);
    const rendered = plainTextBlock(
      block,
      "section",
      blockId,
      MAX_ITEM_TEXT_SCALARS + "rationale: ".length,
    );
    if (rendered === null) return null;
    const separator = rendered.indexOf(": ");
    if (separator < 0) return null;
    const kind = rendered.slice(0, separator);
    if (!RELEASE_ITEM_KINDS.includes(kind as ReleaseItemKind)) return null;
    const text = presentableText(
      rendered.slice(separator + 2),
      MAX_ITEM_TEXT_SCALARS,
    );
    if (text === null) return null;
    items.push({
      signal_id_sha256: `sha256:${digestHex}`,
      kind: kind as ReleaseItemKind,
      text,
    });
  }

  const policyBlock = blocks[itemCount + 1];
  if (!isPlainObject(policyBlock)) return null;
  const consequence = plainTextBlock(
    policyBlock,
    "section",
    `echo-approval-${approvalId}-organization-member-policy-v1`,
    [...ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT].length,
  );
  if (consequence !== ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT) {
    return null;
  }

  const reactionBlock = blocks[itemCount + 2];
  if (!isPlainObject(reactionBlock)) return null;
  const reactions = contextReactions(reactionBlock, approvalId);
  if (reactions === null) return null;

  const expectedFallback = [
    "Decision brief awaiting approval.",
    `Title: ${cardTitle}`,
    ...items.map((item) => `${item.kind}: ${item.text}`),
    ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT,
    `React :${reactions.approve_reaction}: to approve or :${reactions.reject_reaction}: to reject. To record a reason, reply in this thread before reacting.`,
  ].join("\n");
  if (input.fallback_text !== expectedFallback) return null;

  const draft = {
    schema_version: 1,
    kind: "organization-member-readable-release-draft-v1",
    approval_id: approvalId,
    card_title: cardTitle,
    items,
  };
  const presentation = {
    schema_version: 1,
    kind: "organization-member-readable-approval-presentation-v1",
    approval_id: approvalId,
    approve_reaction: reactions.approve_reaction,
    reject_reaction: reactions.reject_reaction,
    text: expectedFallback,
    blocks,
    transport: { mrkdwn: false, unfurl_links: false, unfurl_media: false },
  };
  return Object.freeze({
    approve_reaction: reactions.approve_reaction,
    reject_reaction: reactions.reject_reaction,
    release_draft_sha256: canonicalSha256(draft),
    approval_presentation_sha256: canonicalSha256(presentation),
  });
}

export function isOrganizationMemberCardBlockId(
  blockId: string,
  approvalId: string,
): boolean {
  const prefix = `echo-approval-${approvalId}-`;
  if (!blockId.startsWith(prefix)) return false;
  const suffix = blockId.slice(prefix.length);
  return (
    suffix === "title-v1" ||
    suffix === "organization-member-policy-v1" ||
    suffix === "reaction-v1" ||
    /^item-\d+-[0-9a-f]{64}-v1$/.test(suffix)
  );
}

export const ORGANIZATION_MEMBER_CARD_POLICY_ID =
  ORGANIZATION_MEMBER_READABLE_POLICY_ID;
