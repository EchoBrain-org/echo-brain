import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { ORGANIZATION_MEMBER_READABLE_APPROVAL_PRESENTATION_KIND, ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT, assertOrganizationMemberReadableReactionPair } from "./organization-member-readable-policy.js";
import { validateOrganizationMemberReadableReleaseDraft, type OrganizationMemberReadableReleaseDraftV1 } from "./organization-member-release-draft.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export interface OrganizationMemberReadableApprovalPresentationV1 {
  schema_version: 1; kind: typeof ORGANIZATION_MEMBER_READABLE_APPROVAL_PRESENTATION_KIND; approval_id: string; approve_reaction: string; reject_reaction: string; text: string; blocks: readonly Record<string, unknown>[]; transport: { mrkdwn: false; unfurl_links: false; unfurl_media: false };
}
const transport = Object.freeze({ mrkdwn: false as const, unfurl_links: false as const, unfurl_media: false as const });
function organizationMemberReadableApprovalFallbackText(input: { draft: OrganizationMemberReadableReleaseDraftV1; approve_reaction: string; reject_reaction: string }): string {
  return ["Decision brief awaiting approval.", `Title: ${input.draft.card_title}`, ...input.draft.items.map((item) => `${item.kind}: ${item.text}`), ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT, `React :${input.approve_reaction}: to approve or :${input.reject_reaction}: to reject. To record a reason, reply in this thread before reacting.`].join("\n");
}
export function organizationMemberReadableApprovalPresentation(input: { draft: OrganizationMemberReadableReleaseDraftV1; approve_reaction: string; reject_reaction: string }): OrganizationMemberReadableApprovalPresentationV1 {
  const draft = validateOrganizationMemberReadableReleaseDraft(input.draft); assertOrganizationMemberReadableReactionPair(input.approve_reaction, input.reject_reaction, "organization-member approval presentation");
  const id = draft.approval_id;
  const blocks: Record<string, unknown>[] = [
    { type: "header", block_id: `echo-approval-${id}-title-v1`, text: { type: "plain_text", text: draft.card_title, emoji: false } },
    ...draft.items.map((item, index) => ({ type: "section", block_id: `echo-approval-${id}-item-${index}-${item.signal_id_sha256.slice(7)}-v1`, text: { type: "plain_text", text: `${item.kind}: ${item.text}`, emoji: false } })),
    { type: "section", block_id: `echo-approval-${id}-organization-member-policy-v1`, text: { type: "plain_text", text: ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT, emoji: false } },
    { type: "context", block_id: `echo-approval-${id}-reaction-v1`, elements: [{ type: "mrkdwn", text: `React :${input.approve_reaction}: to approve or :${input.reject_reaction}: to reject. To record a reason, reply in this thread *before* reacting.`, verbatim: false }] },
  ];
  const text = organizationMemberReadableApprovalFallbackText({ draft, approve_reaction: input.approve_reaction, reject_reaction: input.reject_reaction });
  if (blocks.length > 50 || text.length > 40000 || blocks.some((block) => String(block.block_id).length > 255)) organizationProtocolValidationFailure("organization-member approval presentation does not fit the complete closed card");
  return { schema_version: 1, kind: ORGANIZATION_MEMBER_READABLE_APPROVAL_PRESENTATION_KIND, approval_id: id, approve_reaction: input.approve_reaction, reject_reaction: input.reject_reaction, text, blocks, transport: { ...transport } };
}
export function organizationMemberReadableApprovalPresentationSha256(presentation: OrganizationMemberReadableApprovalPresentationV1): Sha256Digest { return canonicalSha256(presentation); }
