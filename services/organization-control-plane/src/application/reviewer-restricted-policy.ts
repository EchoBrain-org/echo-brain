/**
 * The control plane's own copy of the reviewer policy constants and canonical
 * preimages.
 *
 * This workspace deliberately imports no protocol package, so the values are
 * restated here and pinned to the protocol package by test. Everything below
 * is a pure object builder: hashing belongs to the persistence and adapter
 * layers that own the canonical-JSON implementation.
 */

export const RESTRICTED_REVIEWER_POLICY_ID = "restricted-reviewer-v1";

export const RESTRICTED_REVIEWER_CONSEQUENCE_TEXT =
  "Approving records this package under restricted-reviewer-v1. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact reviewer membership remains active.";

export const RESTRICTED_REVIEWER_CONSEQUENCE_VERSION = 1;

export const RESTRICTED_REVIEWER_ALLOW_REASON_CODE =
  "active_reviewer_restricted_notice_v1";

export const REVIEWER_RESTRICTED_AUDIT_DETAIL_KIND =
  "reviewer-restricted-approval-audit-detail-v1";

export const REVIEWER_RESTRICTED_SEMANTIC_INTENT_KIND =
  "reviewer-restricted-semantic-intent-v1";

export const REVIEWER_MESSAGE_PRESENTATION_KIND =
  "reviewer-message-presentation-v1";

export interface ReviewerRestrictedSemanticPreimageInput {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly approval_id: string;
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
  readonly reviewer_release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
  readonly evaluated_at: string;
}

/**
 * The Authority-computed semantic bytes. The consequence text is a constant,
 * never a client field: it is what makes the approval bind the exact sentence
 * the reviewer saw.
 */
export function reviewerRestrictedSemanticPreimage(
  input: ReviewerRestrictedSemanticPreimageInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: 1,
    kind: REVIEWER_RESTRICTED_SEMANTIC_INTENT_KIND,
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    visibility: "restricted",
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
    approval_id: input.approval_id,
    action: "approve",
    reviewer_principal_id: input.reviewer_principal_id,
    reviewer_membership_id: input.reviewer_membership_id,
    consequence_version: RESTRICTED_REVIEWER_CONSEQUENCE_VERSION,
    consequence_text: RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
    reviewer_release_draft_sha256: input.reviewer_release_draft_sha256,
    approval_presentation_sha256: input.approval_presentation_sha256,
    evaluated_at: input.evaluated_at,
  });
}

export interface ReviewerMessagePresentationPreimageInput {
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

/**
 * The live provider evidence. `message_unedited` is a fixed `true` because a
 * card with edit evidence can never produce reviewer proof.
 */
export function reviewerMessagePresentationPreimage(
  input: ReviewerMessagePresentationPreimageInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: 1,
    kind: REVIEWER_MESSAGE_PRESENTATION_KIND,
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

export interface ReviewerRestrictedAuditDetailInput {
  readonly authority_id: string;
  readonly request_sha256: string;
  readonly provider_event_sha256: string;
  readonly principal_id: string;
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
  readonly reviewer_release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
  readonly semantic_intent_sha256: string;
  readonly message_presentation_sha256: string;
}

/** Digests and identifiers only. No title, item text, or reconstructed draft. */
export function reviewerRestrictedAuditDetail(
  input: ReviewerRestrictedAuditDetailInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: 2,
    kind: REVIEWER_RESTRICTED_AUDIT_DETAIL_KIND,
    authority_id: input.authority_id,
    request_sha256: input.request_sha256,
    provider_event_sha256: input.provider_event_sha256,
    principal_id: input.principal_id,
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
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
    reviewer_release_draft_sha256: input.reviewer_release_draft_sha256,
    approval_presentation_sha256: input.approval_presentation_sha256,
    semantic_intent_sha256: input.semantic_intent_sha256,
    message_presentation_sha256: input.message_presentation_sha256,
    message_unedited: true,
    consequence_version: RESTRICTED_REVIEWER_CONSEQUENCE_VERSION,
  });
}

export interface OrganizationIntegrationAuditEntryPreimageInput {
  readonly audit_sequence: number;
  readonly audit_event_id: string;
  readonly previous_entry_sha256: string | null;
  readonly occurred_at: string;
  readonly actor_kind: string;
  readonly actor_principal_id: string | null;
  readonly actor_membership_id: string | null;
  readonly actor_identity_link_id: string | null;
  readonly actor_installation_id: string | null;
  readonly command_id: string;
  readonly provider_event_sha256: string | null;
  readonly action: string;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly membership_id: string | null;
  readonly identity_link_id: string | null;
  readonly connection_id: string | null;
  readonly adapter_binding_id: string | null;
  readonly permission_grant_id: string | null;
  readonly outcome: string;
  readonly reason_code: string;
  readonly idempotency_key: string;
  readonly authority_checked_at: string | null;
  readonly authority_evidence_sha256: string | null;
  readonly correlation_id: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly detail_json: string;
  readonly detail_sha256: string;
}

/**
 * The one exact chained-entry preimage, shared by append and verification so
 * historical entry bytes never change.
 *
 * `organization_id` and the output `entry_sha256` are stored columns but are
 * deliberately not members: the landed hash contract was written that way, and
 * adding either would invalidate every entry ever issued. Both the parsed
 * `detail` object and its canonical `detail_json` string are members, exactly
 * as the landed append wrote them.
 */
export function organizationIntegrationAuditEntryPreimage(
  input: OrganizationIntegrationAuditEntryPreimageInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    audit_sequence: input.audit_sequence,
    audit_event_id: input.audit_event_id,
    previous_entry_sha256: input.previous_entry_sha256,
    occurred_at: input.occurred_at,
    actor_kind: input.actor_kind,
    actor_principal_id: input.actor_principal_id,
    actor_membership_id: input.actor_membership_id,
    actor_identity_link_id: input.actor_identity_link_id,
    actor_installation_id: input.actor_installation_id,
    command_id: input.command_id,
    provider_event_sha256: input.provider_event_sha256,
    action: input.action,
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    membership_id: input.membership_id,
    identity_link_id: input.identity_link_id,
    connection_id: input.connection_id,
    adapter_binding_id: input.adapter_binding_id,
    permission_grant_id: input.permission_grant_id,
    outcome: input.outcome,
    reason_code: input.reason_code,
    idempotency_key: input.idempotency_key,
    authority_checked_at: input.authority_checked_at,
    authority_evidence_sha256: input.authority_evidence_sha256,
    correlation_id: input.correlation_id,
    detail: input.detail,
    detail_json: input.detail_json,
    detail_sha256: input.detail_sha256,
  });
}
