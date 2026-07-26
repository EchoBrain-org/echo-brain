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
