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

/** Excludes one whole meeting source from ingestion for the Person. */
export interface OrganizationPersonMeetingIngestionExclusionSourceSelectorV2 {
  scope: 'source';
  source_adapter_id: string;
  source_instance_id: string;
}

/** Excludes one provider-owned meeting from ingestion for the Person. */
export interface OrganizationPersonMeetingIngestionExclusionMeetingSelectorV2 {
  scope: 'meeting';
  source_adapter_id: string;
  source_instance_id: string;
  external_id: string;
}

export type OrganizationPersonMeetingIngestionExclusionSelectorV2 =
  | OrganizationPersonMeetingIngestionExclusionSourceSelectorV2
  | OrganizationPersonMeetingIngestionExclusionMeetingSelectorV2;

/**
 * Idempotent desired-state change for the authenticated Person's own
 * meeting-ingestion exclusion. `excluded: true` adds the exact row and
 * `false` removes it; neither operation erases an already-admitted meeting.
 */
export interface OrganizationPersonMeetingIngestionExclusionChangeRequestV2 {
  schema_version: 2;
  kind: 'echo-organization-person-member-exclusion-change-request';
  request_id: string;
  authority_id: string;
  organization_id: string;
  subject_principal_id: string;
  http_method: 'POST';
  http_path: '/v2/member-exclusions';
  excluded: boolean;
  selector: OrganizationPersonMeetingIngestionExclusionSelectorV2;
}

/** Exact-source exclusion list for the authenticated Person who owns it. */
export interface OrganizationPersonMeetingIngestionExclusionListRequestV2 {
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
export interface OrganizationAdminMeetingIngestionExclusionBreakGlassReadRequestV2 {
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
export interface OrganizationMeetingIngestionExclusionListResponseV2 {
  schema_version: 2;
  kind: 'echo-organization-member-exclusion-list-response';
  authority_id: string;
  organization_id: string;
  subject_principal_id: string;
  membership_id: string;
  source_adapter_id: string;
  source_instance_id: string;
  exclusions: readonly OrganizationPersonMeetingIngestionExclusionSelectorV2[];
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
      /**
       * Optional address the client read from its own invitation artifact. The
       * Authority never trusts it: it forwards the value as an OIDC
       * `login_hint` only when the digest matches the grant's stored
       * `expected_email_sha256`, and otherwise ignores it entirely. It can
       * therefore only pre-select the account the invitation already names.
       */
      login_hint?: string;
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
  /** Server-owned name from the authenticated membership row. */
  display_name: string;
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
export interface OrganizationPersonSlackIdentityLinkBeginRequestV2 {
  request_id: string;
  challenge_code_sha256: OrganizationApiSha256Digest;
}

/**
 * A Person-authenticated request to prove the exact reply to that challenge.
 * The request ID and message timestamp remain replay inputs until persisted
 * challenge state owns the provider coordinate.
 */
export interface OrganizationPersonSlackIdentityLinkCompleteRequestV2 {
  request_id: string;
  challenge_attempt_id: string;
  challenge_message_ts: string;
  challenge_code: string;
}

export interface OrganizationPersonSlackIdentityLinkBeginResponseV2 {
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
export interface OrganizationPersonSlackIdentityLinkResultV2 {
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

export interface OrganizationInstallationSlackIdentityLinkBeginRequestPayloadV1 {
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
export interface OrganizationInstallationSlackIdentityLinkBeginRequestV1
  extends OrganizationInstallationSlackIdentityLinkBeginRequestPayloadV1 {
  integrity: OrganizationApiSignedIntegrityV1;
}

export interface OrganizationInstallationSlackIdentityLinkCompleteRequestPayloadV1 {
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
export interface OrganizationInstallationSlackIdentityLinkCompleteRequestV1
  extends OrganizationInstallationSlackIdentityLinkCompleteRequestPayloadV1 {
  integrity: OrganizationApiSignedIntegrityV1;
}

export interface OrganizationInstallationSlackIdentityLinkBeginResponseV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-link-begin-response';
  challenge_attempt_id: string;
  provider: 'slack';
  provider_tenant_id: string;
  channel_id: string;
  challenge_message_ts: string;
  expires_at: string;
}

export interface OrganizationInstallationSlackIdentityLinkResultV1 {
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

export interface RevokeOrganizationMembershipRequestV1 {
  reason: string;
}

export interface OrganizationApiErrorV1 {
  error: {
    code: string;
    message: string;
  };
}
