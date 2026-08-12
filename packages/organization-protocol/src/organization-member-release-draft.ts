import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { asRecord, assertDigest, assertExactKeys, assertLiteral, canonicalSnapshot } from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";
import { ORGANIZATION_MEMBER_READABLE_RELEASE_DRAFT_KIND, MAX_ORGANIZATION_MEMBER_READABLE_CARD_TITLE_SCALARS, MAX_ORGANIZATION_MEMBER_READABLE_ITEM_TEXT_SCALARS, MAX_ORGANIZATION_MEMBER_READABLE_RELEASE_ITEMS, assertOrganizationMemberReadableApprovalId, assertOrganizationMemberReadableItemKind, assertOrganizationMemberReadablePresentableText, assertOrganizationMemberReadableSignalId, type OrganizationMemberReadableItemKindV1 } from "./organization-member-readable-policy.js";

export interface OrganizationMemberReadableReleaseDraftItemV1 { signal_id_sha256: Sha256Digest; kind: OrganizationMemberReadableItemKindV1; text: string }
export interface OrganizationMemberReadableReleaseDraftV1 { schema_version: 1; kind: typeof ORGANIZATION_MEMBER_READABLE_RELEASE_DRAFT_KIND; approval_id: string; card_title: string; items: readonly OrganizationMemberReadableReleaseDraftItemV1[] }
export function organizationMemberReadableReleaseDraftSha256(draft: OrganizationMemberReadableReleaseDraftV1): Sha256Digest { return canonicalSha256(draft); }
export function organizationMemberReadableSignalIdSha256(id: string): Sha256Digest { assertOrganizationMemberReadableSignalId(id, "organization-member release draft signal id"); return sha256Digest(id); }
export function validateOrganizationMemberReadableReleaseDraft(value: unknown): OrganizationMemberReadableReleaseDraftV1 {
  const label = "organization-member release draft";
  const draft = asRecord(canonicalSnapshot(value, label), label);
  assertExactKeys(draft, ["schema_version", "kind", "approval_id", "card_title", "items"], label);
  assertLiteral(draft.schema_version, 1, `${label} schema_version`); assertLiteral(draft.kind, ORGANIZATION_MEMBER_READABLE_RELEASE_DRAFT_KIND, `${label} kind`);
  assertOrganizationMemberReadableApprovalId(draft.approval_id, `${label} approval_id`); assertOrganizationMemberReadablePresentableText(draft.card_title, `${label} card_title`, MAX_ORGANIZATION_MEMBER_READABLE_CARD_TITLE_SCALARS);
  if (!Array.isArray(draft.items) || draft.items.length < 1 || draft.items.length > MAX_ORGANIZATION_MEMBER_READABLE_RELEASE_ITEMS) organizationProtocolValidationFailure(`${label} items must contain 1 to ${MAX_ORGANIZATION_MEMBER_READABLE_RELEASE_ITEMS} items`);
  const seen = new Set<string>();
  draft.items.forEach((entry, index) => { const item = asRecord(entry, `${label} items[${index}]`); assertExactKeys(item, ["signal_id_sha256", "kind", "text"], `${label} items[${index}]`); assertDigest(item.signal_id_sha256, `${label} items[${index}] signal_id_sha256`); if (seen.has(item.signal_id_sha256 as string)) organizationProtocolValidationFailure(`${label} signal digests must be unique`); seen.add(item.signal_id_sha256 as string); assertOrganizationMemberReadableItemKind(item.kind, `${label} items[${index}] kind`); assertOrganizationMemberReadablePresentableText(item.text, `${label} items[${index}] text`, MAX_ORGANIZATION_MEMBER_READABLE_ITEM_TEXT_SCALARS); });
  return draft as unknown as OrganizationMemberReadableReleaseDraftV1;
}
export function projectOrganizationMemberReadableReleaseDraft(input: { readonly approval_id: string; readonly brief: unknown }): OrganizationMemberReadableReleaseDraftV1 {
  const label = "organization-member release draft"; assertOrganizationMemberReadableApprovalId(input.approval_id, `${label} approval_id`);
  const brief = asRecord(input.brief, `${label} source brief`); const meeting = asRecord(brief.meeting, `${label} source meeting`); const title = meeting.title ?? meeting.id; assertOrganizationMemberReadablePresentableText(title, `${label} card_title`, MAX_ORGANIZATION_MEMBER_READABLE_CARD_TITLE_SCALARS);
  const sources: Record<string, unknown>[] = []; for (const collection of ["decisions", "actions", "rationales"] as const) { if (!Array.isArray(brief[collection])) organizationProtocolValidationFailure(`${label} source ${collection} must be an array`); for (const entry of brief[collection] as unknown[]) sources.push(asRecord(entry, `${label} source ${collection}`)); }
  if (sources.length < 1 || sources.length > MAX_ORGANIZATION_MEMBER_READABLE_RELEASE_ITEMS) organizationProtocolValidationFailure(`${label} must release 1 to ${MAX_ORGANIZATION_MEMBER_READABLE_RELEASE_ITEMS} signals`);
  const raw = new Set<string>(); const items = sources.map((signal, index) => { assertOrganizationMemberReadableSignalId(signal.id, `${label} source ${index} id`); if (raw.has(signal.id as string)) organizationProtocolValidationFailure(`${label} source signal ids must be unique`); raw.add(signal.id as string); assertOrganizationMemberReadableItemKind(signal.kind, `${label} source ${index} kind`); assertOrganizationMemberReadablePresentableText(signal.text, `${label} source ${index} text`, MAX_ORGANIZATION_MEMBER_READABLE_ITEM_TEXT_SCALARS); return { signal_id_sha256: sha256Digest(signal.id as string), kind: signal.kind as OrganizationMemberReadableItemKindV1, text: signal.text as string }; });
  return validateOrganizationMemberReadableReleaseDraft({ schema_version: 1, kind: ORGANIZATION_MEMBER_READABLE_RELEASE_DRAFT_KIND, approval_id: input.approval_id, card_title: title as string, items });
}
