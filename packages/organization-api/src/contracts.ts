import type {
  JsonValue,
  Sha256Digest,
  SignedIntegrity,
} from '@echo-brain/federation-protocol';
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationEnrollmentRequestV1,
  OrganizationInstallationAccessStateV1,
  OrganizationMembershipTypeV1,
} from '@echo-brain/organization-protocol';

export type OrganizationApiSha256Digest = Sha256Digest;
export type OrganizationApiSignedIntegrityV1 = SignedIntegrity;
export type OrganizationApiPageCursorV1 = string;

export interface OrganizationAccessLeaseRequestPayloadV1 {
  schema_version: 1;
  kind: 'echo-organization-access-lease-request';
  request_id: string;
  authority_id: string;
  authority_key_id: OrganizationApiSha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_key_id: OrganizationApiSha256Digest;
  previous_access_state_sha256: OrganizationApiSha256Digest;
  requested_at: string;
}

/**
 * An ordinary authenticated API command, not a durable organization trust
 * fact. The enrolled installation signs it with the key named by its receipt.
 */
export interface OrganizationAccessLeaseRequestV1 extends OrganizationAccessLeaseRequestPayloadV1 {
  integrity: OrganizationApiSignedIntegrityV1;
}

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

export interface IssueOrganizationEnrollmentGrantRequestV1 {
  command_id: string;
  enrollment_grant_sha256: OrganizationApiSha256Digest;
  lifetime_seconds: number;
}

/** The caller retains the bearer bytes; the authority accepts and returns only their digest. */
export interface IssuedOrganizationEnrollmentGrantV1 {
  authority_id: string;
  authority_pin_sha256: OrganizationApiSha256Digest;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  enrollment_grant_sha256: OrganizationApiSha256Digest;
  issued_at: string;
  expires_at: string;
}

/**
 * Secret-bearing handoff from an organization administrator to one employee.
 * The embedded authority PIN is descriptive only; enrollment still requires
 * the same PIN from an independent trusted channel.
 */
export interface OrganizationEnrollmentInvitationV1 {
  schema_version: 1;
  kind: 'echo-organization-enrollment-invitation';
  status: 'pending_registration' | 'issued';
  authority_base_url: string;
  authority_id: string;
  authority_pin_sha256: OrganizationApiSha256Digest;
  authority_pin_verification: 'independent_pin_required';
  organization_id: string;
  membership_id: string;
  command_id: string;
  enrollment_grant_sha256: OrganizationApiSha256Digest;
  enrollment_grant_base64url: string;
  lifetime_seconds: number;
  issued: IssuedOrganizationEnrollmentGrantV1 | null;
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

export interface OrganizationInstallationSummaryV1 {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_key_id: OrganizationApiSha256Digest;
  status: 'active' | 'revoked';
  enrolled_at: string;
  revoked_at: string | null;
  revocation_kind: 'membership_revoked' | 'installation_revoked' | null;
  revocation_reason: string | null;
  current_access_sequence: number;
  current_access_status: 'active' | 'revoked';
  current_access_valid_until: string | null;
}

export interface OrganizationInstallationPageV1 {
  items: OrganizationInstallationSummaryV1[];
  next_cursor: OrganizationApiPageCursorV1 | null;
}

export interface OrganizationEnrollmentGrantSummaryV1 {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  enrollment_grant_sha256: OrganizationApiSha256Digest;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  status: 'pending' | 'consumed' | 'expired';
}

export interface OrganizationEnrollmentGrantPageV1 {
  items: OrganizationEnrollmentGrantSummaryV1[];
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

/** The enrollment grant is supplied only through the Authorization header. */
export interface CompleteOrganizationEnrollmentRequestV1 {
  enrollment_request: OrganizationEnrollmentRequestV1;
}

export interface CompletedOrganizationEnrollmentV1 {
  enrollment_receipt: OrganizationEnrollmentReceiptV1;
  access_state: OrganizationInstallationAccessStateV1;
}

export interface OrganizationAccessLeaseResponseV1 {
  access_state: OrganizationInstallationAccessStateV1;
}

export interface RevokeOrganizationSubjectRequestV1 {
  reason: string;
}

export interface RevokedOrganizationInstallationV1 {
  installation_id: string;
  access_state: OrganizationInstallationAccessStateV1;
}

export interface RevokedOrganizationMembershipV1 {
  membership: ProvisionedOrganizationMembershipV1;
  installations: RevokedOrganizationInstallationV1[];
}

export interface OrganizationApiErrorV1 {
  error: {
    code: string;
    message: string;
  };
}
