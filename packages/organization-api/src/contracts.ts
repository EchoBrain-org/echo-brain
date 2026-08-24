import type {
  JsonValue,
  Sha256Digest,
  SignedIntegrity,
} from '@echo-brain/federation-protocol';
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationMembershipTypeV1,
} from '@echo-brain/organization-protocol';

export type OrganizationApiSha256Digest = Sha256Digest;
export type OrganizationApiSignedIntegrityV1 = SignedIntegrity;
export type OrganizationApiPageCursorV1 = string;

export type OrganizationPermissionActionV1 = 'approve' | 'reject';

export interface OrganizationPermissionCheckRequestPayloadV1 {
  schema_version: 1;
  kind: 'echo-organization-permission-check-request';
  request_id: string;
  authority_id: string;
  authority_key_id: OrganizationApiSha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_key_id: OrganizationApiSha256Digest;
  provider: 'slack';
  provider_issuer: 'https://slack.com';
  provider_tenant_kind: 'workspace';
  provider_tenant_id: string;
  provider_enterprise_id: string | null;
  provider_connection_subject_id: string;
  provider_connection_bot_id: string;
  provider_connection_app_id: string | null;
  provider_subject_kind: 'human_user';
  provider_subject_id: string;
  adapter_kind: 'approval-surface';
  adapter_id: string;
  adapter_instance_id: string;
  adapter_version: string;
  action: OrganizationPermissionActionV1;
  approval_id: string;
  channel_id: string;
  message_ts: string;
  reaction_name: string;
  provider_event_sha256: OrganizationApiSha256Digest;
  requested_at: string;
}

/**
 * A fresh permission query authenticated by the exact enrolled installation.
 * It is an API command, not a reusable authorization receipt.
 */
export interface OrganizationPermissionCheckRequestV1 extends OrganizationPermissionCheckRequestPayloadV1 {
  integrity: OrganizationApiSignedIntegrityV1;
}

/**
 * The Authority's answer to one permission check. The decision itself is not
 * signed. The request is installation-signed, and `request_sha256` plus
 * `provider_event_sha256` bind the response to that exact request -- they do
 * not authenticate it. Authenticity comes from the transport: the response
 * arrives over the configured HTTPS origin associated with the pinned Authority
 * descriptor. Callers must still compare both digests against the request they
 * sent; anything else is a mismatch and fails closed. It is a decision for that
 * one request, never a reusable or transferable authorization receipt.
 */
export interface OrganizationPermissionCheckDecisionV1 {
  schema_version: 1;
  kind: 'echo-organization-permission-check-decision';
  request_sha256: OrganizationApiSha256Digest;
  provider_event_sha256: OrganizationApiSha256Digest;
  allowed: boolean;
  reason_code: string;
  principal_id: string | null;
  membership_id: string | null;
  adapter_binding_id: string | null;
  permission_grant_id: string | null;
  evaluated_at: string;
}

/**
 * The closed reviewer approval request. It carries content commitments, never
 * content: no draft, title, item text, raw signal id, meeting id, or
 * processing key crosses this wire.
 */
export interface OrganizationReviewerPermissionCheckRequestPayloadV2 {
  schema_version: 2;
  kind: 'echo-organization-permission-check-request';
  request_id: string;
  authority_id: string;
  authority_key_id: OrganizationApiSha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_key_id: OrganizationApiSha256Digest;
  provider: 'slack';
  provider_issuer: 'https://slack.com';
  provider_tenant_kind: 'workspace';
  provider_tenant_id: string;
  provider_enterprise_id: string | null;
  provider_connection_subject_id: string;
  provider_connection_bot_id: string;
  provider_connection_app_id: string | null;
  provider_subject_kind: 'human_user';
  provider_subject_id: string;
  adapter_kind: 'approval-surface';
  adapter_id: string;
  adapter_instance_id: string;
  adapter_version: string;
  action: 'approve';
  approval_id: string;
  channel_id: string;
  message_ts: string;
  reaction_name: string;
  approve_reaction: string;
  reject_reaction: string;
  policy_id: 'restricted-reviewer-v1';
  reviewer_release_draft_sha256: OrganizationApiSha256Digest;
  approval_presentation_sha256: OrganizationApiSha256Digest;
  provider_event_sha256: OrganizationApiSha256Digest;
  requested_at: string;
  http_method: 'POST';
  http_path: '/v1/permission-checks';
}

export interface OrganizationReviewerPermissionCheckRequestV2
  extends OrganizationReviewerPermissionCheckRequestPayloadV2 {
  integrity: OrganizationApiSignedIntegrityV1;
}

/**
 * The closed reviewer decision. An allow carries all six proof fields and the
 * four actor/binding/grant identifiers; a denial nulls every one of them and
 * names one closed reason.
 */
export interface OrganizationReviewerPermissionCheckDecisionV2 {
  schema_version: 2;
  kind: 'echo-organization-permission-check-decision';
  request_sha256: OrganizationApiSha256Digest;
  provider_event_sha256: OrganizationApiSha256Digest;
  allowed: boolean;
  reason_code: string;
  principal_id: string | null;
  membership_id: string | null;
  adapter_binding_id: string | null;
  permission_grant_id: string | null;
  evaluated_at: string;
  authorization_audit_event_id: string | null;
  authorization_audit_entry_sha256: OrganizationApiSha256Digest | null;
  reviewer_release_draft_sha256: OrganizationApiSha256Digest | null;
  approval_presentation_sha256: OrganizationApiSha256Digest | null;
  semantic_intent_sha256: OrganizationApiSha256Digest | null;
  message_presentation_sha256: OrganizationApiSha256Digest | null;
}

export interface OrganizationMemberReadablePermissionCheckRequestPayloadV3 {
  schema_version: 3;
  kind: 'echo-organization-permission-check-request';
  request_id: string; authority_id: string; authority_key_id: OrganizationApiSha256Digest;
  organization_id: string; enrollment_id: string; installation_id: string; installation_key_id: OrganizationApiSha256Digest;
  provider: 'slack'; provider_issuer: 'https://slack.com'; provider_tenant_kind: 'workspace'; provider_tenant_id: string; provider_enterprise_id: string | null;
  provider_connection_subject_id: string; provider_connection_bot_id: string; provider_connection_app_id: string | null; provider_subject_kind: 'human_user'; provider_subject_id: string;
  adapter_kind: 'approval-surface'; adapter_id: string; adapter_instance_id: string; adapter_version: string;
  action: 'approve'; approval_id: string; channel_id: string; message_ts: string; reaction_name: string; approve_reaction: string; reject_reaction: string;
  policy_id: 'organization-member-readable-v1'; policy_contract_sha256: OrganizationApiSha256Digest; release_draft_sha256: OrganizationApiSha256Digest; approval_presentation_sha256: OrganizationApiSha256Digest;
  provider_event_sha256: OrganizationApiSha256Digest; requested_at: string; http_method: 'POST'; http_path: '/v1/permission-checks';
}
export interface OrganizationMemberReadablePermissionCheckRequestV3 extends OrganizationMemberReadablePermissionCheckRequestPayloadV3 { integrity: OrganizationApiSignedIntegrityV1 }
export interface OrganizationMemberReadablePermissionCheckDecisionV3 {
  schema_version: 3; kind: 'echo-organization-permission-check-decision'; request_sha256: OrganizationApiSha256Digest; provider_event_sha256: OrganizationApiSha256Digest; allowed: boolean; reason_code: string;
  policy_id: 'organization-member-readable-v1'; policy_contract_sha256: OrganizationApiSha256Digest;
  principal_id: string | null; membership_id: string | null; adapter_binding_id: string | null; permission_grant_id: string | null; evaluated_at: string;
  authorization_audit_event_id: string | null; authorization_audit_entry_sha256: OrganizationApiSha256Digest | null; release_draft_sha256: OrganizationApiSha256Digest | null; approval_presentation_sha256: OrganizationApiSha256Digest | null; semantic_intent_sha256: OrganizationApiSha256Digest | null; message_presentation_sha256: OrganizationApiSha256Digest | null;
}

/** Exact, whole-source member valve selector. */
export interface OrganizationPersonMemberExclusionSourceSelectorV2 {
  scope: 'source';
  source_adapter_id: string;
  source_instance_id: string;
}

/** Exact, one-meeting member valve selector. */
export interface OrganizationPersonMemberExclusionMeetingSelectorV2 {
  scope: 'meeting';
  source_adapter_id: string;
  source_instance_id: string;
  external_id: string;
}

export type OrganizationPersonMemberExclusionSelectorV2 =
  | OrganizationPersonMemberExclusionSourceSelectorV2
  | OrganizationPersonMemberExclusionMeetingSelectorV2;

/**
 * Idempotent desired-state change for the authenticated Person's own
 * pre-record exclusion. `excluded: true` adds the exact row and `false`
 * removes it; neither operation implies erasure of an already-admitted row.
 */
export interface OrganizationPersonMemberExclusionChangeRequestV2 {
  schema_version: 2;
  kind: 'echo-organization-person-member-exclusion-change-request';
  request_id: string;
  authority_id: string;
  organization_id: string;
  subject_principal_id: string;
  http_method: 'POST';
  http_path: '/v2/member-exclusions';
  excluded: boolean;
  selector: OrganizationPersonMemberExclusionSelectorV2;
}

/** Exact-source list for the authenticated Person who owns that source. */
export interface OrganizationPersonMemberExclusionListRequestV2 {
  schema_version: 2;
  kind: 'echo-organization-person-member-exclusion-list-request';
  request_id: string;
  authority_id: string;
  organization_id: string;
  subject_principal_id: string;
  http_method: 'POST';
  http_path: '/v2/member-exclusions/list';
  source_adapter_id: string;
  source_instance_id: string;
}

/** One explicit, exact-target administrator break-glass read. */
export interface OrganizationAdminMemberExclusionBreakGlassReadRequestV2 {
  schema_version: 2;
  kind: 'echo-organization-admin-member-exclusion-break-glass-read-request';
  request_id: string;
  authority_id: string;
  organization_id: string;
  target_principal_id: string;
  target_membership_id: string;
  http_method: 'POST';
  http_path: '/v2/admin/member-exclusions/break-glass';
  source_adapter_id: string;
  source_instance_id: string;
}

/** The shared exact response; no generic administrator surface returns it. */
export interface OrganizationMemberExclusionListResponseV2 {
  schema_version: 2;
  kind: 'echo-organization-member-exclusion-list-response';
  authority_id: string;
  organization_id: string;
  subject_principal_id: string;
  membership_id: string;
  source_adapter_id: string;
  source_instance_id: string;
  exclusions: readonly OrganizationPersonMemberExclusionSelectorV2[];
}

export type OrganizationPersonOidcBeginRequestV2 =
  | {
      kind: 'identity_bootstrap';
      login_grant: string;
      /**
       * Optional one-shot local receiver. The Authority holds this exact
       * binding process-locally by OIDC state and posts the resulting session
       * there only after a verified callback.
       */
      loopback_handoff?: {
        url: string;
        token: string;
      };
    }
  | {
      kind: 'existing_identity_login';
      loopback_handoff?: {
        url: string;
        token: string;
      };
    };

export interface OrganizationPersonOidcBeginResponseV2 {
  authorization_url: string;
  expires_at: string;
}

/** The exact Authority-issued credential pair returned by callback/refresh. */
export interface OrganizationPersonSessionV2 {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: 'owner' | 'employee';
  identity_binding_id: string;
  session_family_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
  hard_reauthentication_at: string;
}

export interface OrganizationPersonSessionRefreshRequestV2 {
  refresh_token: string;
}

/**
 * A Person-authenticated request to post one Slack identity challenge.
 * Identity and route context come from the bearer credential and matched route.
 */
export interface OrganizationPersonSlackLinkBeginRequestV2 {
  request_id: string;
  challenge_code_sha256: OrganizationApiSha256Digest;
}

/**
 * A Person-authenticated request to prove the exact reply to that challenge.
 * The request ID and message timestamp remain transitional replay inputs until
 * new-lineage challenge state owns the provider coordinate.
 */
export interface OrganizationPersonSlackLinkCompleteRequestV2 {
  request_id: string;
  challenge_attempt_id: string;
  challenge_message_ts: string;
  challenge_code: string;
}

export interface OrganizationPersonSlackLinkBeginResponseV2 {
  schema_version: 2;
  kind: 'echo-organization-person-slack-link-begin-response';
  challenge_attempt_id: string;
  provider: 'slack';
  provider_tenant_id: string;
  channel_id: string;
  challenge_message_ts: string;
  expires_at: string;
}

/** Person linking proves identity only; adapter bindings and grants are absent. */
export interface OrganizationPersonSlackLinkResultV2 {
  schema_version: 2;
  kind: 'echo-organization-person-slack-link-result';
  identity_link_id: string;
  connection_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  provider: 'slack';
  provider_tenant_id: string;
  provider_subject_id: string;
  channel_id: string;
  linked_at: string;
  identity_link_created: boolean;
}

export interface OrganizationSlackLinkBeginRequestPayloadV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-link-begin-request';
  request_id: string;
  authority_id: string;
  authority_key_id: OrganizationApiSha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_key_id: OrganizationApiSha256Digest;
  challenge_code_sha256: OrganizationApiSha256Digest;
  requested_at: string;
}

/**
 * A fresh command from one enrolled installation to begin proving control of
 * its employee's Slack identity. It does not grant any adapter permission.
 */
export interface OrganizationSlackLinkBeginRequestV1 extends OrganizationSlackLinkBeginRequestPayloadV1 {
  integrity: OrganizationApiSignedIntegrityV1;
}

export interface OrganizationSlackLinkCompleteRequestPayloadV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-link-complete-request';
  request_id: string;
  authority_id: string;
  authority_key_id: OrganizationApiSha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_key_id: OrganizationApiSha256Digest;
  challenge_attempt_id: string;
  challenge_message_ts: string;
  challenge_code: string;
  expected_provider_subject_id: string;
  adapter_id: 'slack-reactions';
  adapter_instance_id: string;
  adapter_version: string;
  requested_at: string;
}

/**
 * A fresh command that submits the exact Slack challenge observation for the
 * enrolled installation. The Authority derives the Slack human from Slack.
 */
export interface OrganizationSlackLinkCompleteRequestV1 extends OrganizationSlackLinkCompleteRequestPayloadV1 {
  integrity: OrganizationApiSignedIntegrityV1;
}

export interface OrganizationSlackLinkBeginResponseV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-link-begin-response';
  challenge_attempt_id: string;
  provider: 'slack';
  provider_tenant_id: string;
  channel_id: string;
  challenge_message_ts: string;
  expires_at: string;
}

export interface OrganizationSlackLinkResultV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-link-result';
  identity_link_id: string;
  connection_id: string;
  adapter_binding_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  installation_id: string;
  provider: 'slack';
  provider_tenant_id: string;
  provider_subject_id: string;
  channel_id: string;
  linked_at: string;
  identity_link_created: boolean;
  adapter_binding_created: boolean;
  permission_grants_created: 0;
}

export interface OrganizationAuthorityDescriptorResponseV1 {
  authority_descriptor: OrganizationAuthorityDescriptorV1;
}

export interface ProvisionOrganizationMembershipRequestV1 {
  command_id: string;
  display_name: string;
  membership_type: OrganizationMembershipTypeV1;
}

export interface ProvisionedOrganizationMembershipV1 {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  display_name: string;
  membership_type: OrganizationMembershipTypeV1;
  status: 'active' | 'revoked';
  provisioned_at: string;
  revoked_at: string | null;
}

export interface OrganizationAdminOverviewCountsV1 {
  memberships: number;
  active_memberships: number;
  revoked_memberships: number;
  installations: number;
  active_installations: number;
  revoked_installations: number;
  enrollment_grants: number;
  pending_enrollment_grants: number;
  consumed_enrollment_grants: number;
  expired_enrollment_grants: number;
  audit_entries: number;
}

export interface OrganizationAdminOverviewV1 {
  organization_id: string;
  organization_display_name: string;
  authority_id: string;
  authority_pin_sha256: OrganizationApiSha256Digest;
  created_at: string;
  last_observed_at: string;
  counts: OrganizationAdminOverviewCountsV1;
}

export interface OrganizationMembershipSummaryV1 {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  display_name: string;
  membership_type: OrganizationMembershipTypeV1;
  status: 'active' | 'revoked';
  provisioned_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

export interface OrganizationMembershipPageV1 {
  items: OrganizationMembershipSummaryV1[];
  next_cursor: OrganizationApiPageCursorV1 | null;
}

export interface OrganizationAuditEntrySummaryV1 {
  audit_sequence: number;
  occurred_at: string;
  actor_kind: 'admin' | 'enrollment_grant' | 'installation';
  action: string;
  subject_id: string;
  detail: JsonValue;
}

export interface OrganizationAuditPageV1 {
  items: OrganizationAuditEntrySummaryV1[];
  next_cursor: OrganizationApiPageCursorV1 | null;
}

export interface RevokeOrganizationSubjectRequestV1 {
  reason: string;
}

export interface OrganizationApiErrorV1 {
  error: {
    code: string;
    message: string;
  };
}
