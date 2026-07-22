import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationEnrollmentRequestV1,
  OrganizationInstallationAccessStateV1,
  OrganizationMembershipTypeV1,
} from '@echo-brain/organization-protocol';

export type OrganizationApiSha256Digest = `sha256:${string}`;

export interface OrganizationApiSignedIntegrityV1 {
  canonicalization: 'RFC8785';
  payload_sha256: OrganizationApiSha256Digest;
  signature_algorithm: 'ecdsa-p256-sha256-der-low-s';
  key_id: OrganizationApiSha256Digest;
  signature_base64: string;
}

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
  lifetime_seconds: number;
}

/** The bearer grant is returned once and must never be retained by the server. */
export interface IssuedOrganizationEnrollmentGrantV1 {
  authority_id: string;
  authority_pin_sha256: OrganizationApiSha256Digest;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  enrollment_grant_base64url: string;
  issued_at: string;
  expires_at: string;
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
