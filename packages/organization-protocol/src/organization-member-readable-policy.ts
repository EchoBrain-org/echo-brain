import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { Buffer } from "node:buffer";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export const ORGANIZATION_MEMBER_READABLE_POLICY_ID = "organization-member-readable-v1";
export const ORGANIZATION_MEMBER_READABLE_PRESENTATION_MODE = "organization-member-readable-v1";
export const ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_VERSION = 1;
export const ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT =
  "Approving records this package under organization-member-readable-v1. Any person using an enrolled installation with a current unexpired access lease and current active owner or employee membership in this organization, including someone who joins later, may search and read its decisions, actions, and rationales while that access and membership remain active.";
export const ORGANIZATION_MEMBER_READABLE_ALLOW_REASON_CODE =
  "active_organization_member_readable_notice_v1";
export const ORGANIZATION_MEMBER_READABLE_RECORD_SURFACE =
  "slack-organization-member-readable-v1";
export const ORGANIZATION_MEMBER_READABLE_RELEASE_DRAFT_KIND =
  "organization-member-readable-release-draft-v1";
export const ORGANIZATION_MEMBER_READABLE_APPROVAL_PRESENTATION_KIND =
  "organization-member-readable-approval-presentation-v1";
export const ORGANIZATION_MEMBER_READABLE_POLICY_CONTRACT_KIND =
  "organization-member-readable-policy-contract-v1";
export const ORGANIZATION_MEMBER_READABLE_ELIGIBLE_MEMBERSHIP_TYPES = Object.freeze([
  "employee",
  "owner",
] as const);
export const ORGANIZATION_MEMBER_READABLE_ITEM_KINDS = Object.freeze([
  "decision",
  "action",
  "rationale",
] as const);
export type OrganizationMemberReadableItemKindV1 =
  (typeof ORGANIZATION_MEMBER_READABLE_ITEM_KINDS)[number];
export const MAX_ORGANIZATION_MEMBER_READABLE_CARD_TITLE_SCALARS = 150;
export const MAX_ORGANIZATION_MEMBER_READABLE_ITEM_TEXT_SCALARS = 240;
export const MAX_ORGANIZATION_MEMBER_READABLE_SIGNAL_ID_BYTES = 512;
export const MAX_ORGANIZATION_MEMBER_READABLE_RELEASE_ITEMS = 10;
export const ORGANIZATION_MEMBER_READABLE_REACTION_PATTERN = /^[a-z0-9_+-]{1,64}$/;
export const ORGANIZATION_MEMBER_READABLE_APPROVAL_ID_PATTERN = /^[0-9a-f]{64}$/;

export function organizationMemberReadablePolicyContract(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: 1,
    kind: ORGANIZATION_MEMBER_READABLE_POLICY_CONTRACT_KIND,
    policy_id: ORGANIZATION_MEMBER_READABLE_POLICY_ID,
    consequence_version: ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_VERSION,
    eligible_membership_types: [...ORGANIZATION_MEMBER_READABLE_ELIGIBLE_MEMBERSHIP_TYPES],
    consequence: ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT,
    approval_action: "approve",
    permission_check_http_path: "/v1/permission-checks",
    permission_check_request_kind: "echo-organization-permission-check-request",
    permission_check_schema_version: 3,
    permission_check_decision_kind: "echo-organization-permission-check-decision",
    reason_code: ORGANIZATION_MEMBER_READABLE_ALLOW_REASON_CODE,
    authorization_evidence_kind: "echo-organization-authorization-evidence",
    authorization_evidence_schema_version: 3,
    semantic_intent_kind: "organization-member-readable-semantic-intent-v1",
    message_presentation_kind: "organization-member-readable-message-presentation-v1",
    record_envelope_kind: "echo-organization-record-envelope",
    record_envelope_schema_version: 3,
    payload_surface: ORGANIZATION_MEMBER_READABLE_RECORD_SURFACE,
    release_draft_kind: ORGANIZATION_MEMBER_READABLE_RELEASE_DRAFT_KIND,
    presentation_kind: ORGANIZATION_MEMBER_READABLE_APPROVAL_PRESENTATION_KIND,
  });
}

export function organizationMemberReadablePolicyContractSha256(): Sha256Digest {
  return canonicalSha256(organizationMemberReadablePolicyContract());
}

function assertPresentable(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.normalize("NFC") !== value || [...value].length > maximum) {
    organizationProtocolValidationFailure(`${label} must be NFC, trimmed, non-empty, and within its scalar bound`);
  }
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if ((code >= 0xd800 && code <= 0xdfff) || code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      organizationProtocolValidationFailure(`${label} contains a control or line-separator character`);
    }
  }
}

export function assertOrganizationMemberReadablePresentableText(value: unknown, label: string, maximum: number): asserts value is string {
  assertPresentable(value, label, maximum);
}
export function assertOrganizationMemberReadableSignalId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.normalize("NFC") !== value) organizationProtocolValidationFailure(`${label} must be NFC, trimmed, and non-empty`);
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if ((code >= 0xd800 && code <= 0xdfff) || code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) organizationProtocolValidationFailure(`${label} contains a control or line-separator character`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_ORGANIZATION_MEMBER_READABLE_SIGNAL_ID_BYTES) organizationProtocolValidationFailure(`${label} exceeds its UTF-8 byte bound`);
}
export function assertOrganizationMemberReadableApprovalId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ORGANIZATION_MEMBER_READABLE_APPROVAL_ID_PATTERN.test(value)) organizationProtocolValidationFailure(`${label} must be a lowercase sha256 approval id`);
}
export function assertOrganizationMemberReadableItemKind(value: unknown, label: string): asserts value is OrganizationMemberReadableItemKindV1 {
  if (typeof value !== "string" || !ORGANIZATION_MEMBER_READABLE_ITEM_KINDS.includes(value as OrganizationMemberReadableItemKindV1)) organizationProtocolValidationFailure(`${label} must be decision, action, or rationale`);
}
export function assertOrganizationMemberReadableReactionPair(approve: unknown, reject: unknown, label: string): void {
  if (typeof approve !== "string" || !ORGANIZATION_MEMBER_READABLE_REACTION_PATTERN.test(approve) || typeof reject !== "string" || !ORGANIZATION_MEMBER_READABLE_REACTION_PATTERN.test(reject) || approve === reject) organizationProtocolValidationFailure(`${label} reaction pair is invalid`);
}
