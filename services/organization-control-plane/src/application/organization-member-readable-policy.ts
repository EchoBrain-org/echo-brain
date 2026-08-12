/**
 * Control-plane-local constants and canonical preimage builders for the
 * organization-member-readable admission family.
 *
 * This workspace intentionally has no organization-protocol dependency. A
 * cross-workspace agreement test pins these literals and object shapes to the
 * protocol implementation. Hashing remains with the persistence/adapter layer
 * that owns the canonical JSON helper.
 */

export const ORGANIZATION_MEMBER_READABLE_POLICY_ID =
  "organization-member-readable-v1";

export const ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT =
  "Approving records this package under organization-member-readable-v1. Any person using an enrolled installation with a current unexpired access lease and current active owner or employee membership in this organization, including someone who joins later, may search and read its decisions, actions, and rationales while that access and membership remain active.";

export const ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_VERSION = 1;

export const ORGANIZATION_MEMBER_READABLE_ALLOW_REASON_CODE =
  "active_organization_member_readable_notice_v1";

export const ORGANIZATION_MEMBER_READABLE_AUDIT_DETAIL_KIND =
  "organization-member-readable-approval-audit-detail-v1";

export const ORGANIZATION_MEMBER_READABLE_SEMANTIC_INTENT_KIND =
  "organization-member-readable-semantic-intent-v1";

export const ORGANIZATION_MEMBER_MESSAGE_PRESENTATION_KIND =
  "organization-member-readable-message-presentation-v1";

export const ORGANIZATION_MEMBER_READABLE_ELIGIBLE_MEMBERSHIP_TYPES =
  Object.freeze(["employee", "owner"] as const);

export interface OrganizationMemberReadableSemanticPreimageInput {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly policy_contract_sha256: string;
  readonly approval_id: string;
  readonly approving_principal_id: string;
  readonly approving_membership_id: string;
  readonly release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
  readonly evaluated_at: string;
}

export function organizationMemberReadableSemanticPreimage(
  input: OrganizationMemberReadableSemanticPreimageInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: 1,
    kind: ORGANIZATION_MEMBER_READABLE_SEMANTIC_INTENT_KIND,
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    visibility: "organization-member-readable",
    policy_id: ORGANIZATION_MEMBER_READABLE_POLICY_ID,
    policy_contract_sha256: input.policy_contract_sha256,
    approval_id: input.approval_id,
    action: "approve",
    approving_principal_id: input.approving_principal_id,
    approving_membership_id: input.approving_membership_id,
    consequence_version: ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_VERSION,
    consequence_text: ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT,
    eligible_membership_types: [
      ...ORGANIZATION_MEMBER_READABLE_ELIGIBLE_MEMBERSHIP_TYPES,
    ],
    release_draft_sha256: input.release_draft_sha256,
    approval_presentation_sha256: input.approval_presentation_sha256,
    evaluated_at: input.evaluated_at,
  });
}

export interface OrganizationMemberMessagePresentationPreimageInput {
  readonly provider_event_sha256: string;
  readonly approval_presentation_sha256: string;
  readonly team_id: string;
  readonly enterprise_id: string | null;
  readonly bot_user_id: string;
  readonly bot_id: string;
  readonly app_id: string;
  readonly actor_user_id: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly reaction_name: string;
}

export function organizationMemberMessagePresentationPreimage(
  input: OrganizationMemberMessagePresentationPreimageInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: 1,
    kind: ORGANIZATION_MEMBER_MESSAGE_PRESENTATION_KIND,
    provider_event_sha256: input.provider_event_sha256,
    approval_presentation_sha256: input.approval_presentation_sha256,
    team_id: input.team_id,
    enterprise_id: input.enterprise_id,
    bot_user_id: input.bot_user_id,
    bot_id: input.bot_id,
    app_id: input.app_id,
    actor_user_id: input.actor_user_id,
    channel_id: input.channel_id,
    message_ts: input.message_ts,
    reaction_name: input.reaction_name,
    message_unedited: true,
  });
}

export interface OrganizationMemberReadableAuditDetailInput {
  readonly authority_id: string;
  readonly request_sha256: string;
  readonly provider_event_sha256: string;
  readonly principal_id: string;
  readonly policy_contract_sha256: string;
  readonly team_id: string;
  readonly enterprise_id: string | null;
  readonly bot_user_id: string;
  readonly bot_id: string;
  readonly app_id: string;
  readonly actor_user_id: string;
  readonly adapter_id: string;
  readonly adapter_instance_id: string;
  readonly adapter_version: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly reaction_name: string;
  readonly approve_reaction: string;
  readonly reject_reaction: string;
  readonly release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
  readonly semantic_intent_sha256: string;
  readonly message_presentation_sha256: string;
}

/** Digests and identifiers only. No title, item text, or resolved reader list. */
export function organizationMemberReadableAuditDetail(
  input: OrganizationMemberReadableAuditDetailInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: 3,
    kind: ORGANIZATION_MEMBER_READABLE_AUDIT_DETAIL_KIND,
    authority_id: input.authority_id,
    request_sha256: input.request_sha256,
    provider_event_sha256: input.provider_event_sha256,
    principal_id: input.principal_id,
    policy_id: ORGANIZATION_MEMBER_READABLE_POLICY_ID,
    policy_contract_sha256: input.policy_contract_sha256,
    provider: "slack",
    provider_issuer: "https://slack.com",
    team_id: input.team_id,
    enterprise_id: input.enterprise_id,
    bot_user_id: input.bot_user_id,
    bot_id: input.bot_id,
    app_id: input.app_id,
    actor_user_id: input.actor_user_id,
    adapter_id: input.adapter_id,
    adapter_instance_id: input.adapter_instance_id,
    adapter_version: input.adapter_version,
    channel_id: input.channel_id,
    message_ts: input.message_ts,
    reaction_name: input.reaction_name,
    approve_reaction: input.approve_reaction,
    reject_reaction: input.reject_reaction,
    release_draft_sha256: input.release_draft_sha256,
    approval_presentation_sha256: input.approval_presentation_sha256,
    semantic_intent_sha256: input.semantic_intent_sha256,
    message_presentation_sha256: input.message_presentation_sha256,
    message_unedited: true,
    consequence_version: ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_VERSION,
    eligible_membership_types: [
      ...ORGANIZATION_MEMBER_READABLE_ELIGIBLE_MEMBERSHIP_TYPES,
    ],
  });
}
