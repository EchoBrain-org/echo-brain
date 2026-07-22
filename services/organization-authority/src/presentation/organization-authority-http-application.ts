import type {
  CompletedOrganizationEnrollmentV1,
  OrganizationAccessLeaseRequestV1,
  OrganizationApiSha256Digest,
  ProvisionedOrganizationMembershipV1,
  ProvisionOrganizationMembershipRequestV1,
  RevokedOrganizationMembershipV1,
} from '@echo-brain/organization-api';
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentRequestV1,
  OrganizationInstallationAccessStateV1,
} from '@echo-brain/organization-protocol';

export interface HttpIssuedOrganizationEnrollmentGrant {
  authority_id: string;
  authority_pin_sha256: OrganizationApiSha256Digest;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  enrollment_grant: Uint8Array;
  issued_at: string;
  expires_at: string;
}

/** The use cases exposed to the JSON/HTTP presentation adapter. */
export interface OrganizationAuthorityHttpApplication {
  descriptor(): OrganizationAuthorityDescriptorV1;
  provisionMembership(
    input: ProvisionOrganizationMembershipRequestV1,
  ): ProvisionedOrganizationMembershipV1;
  issueEnrollmentGrant(
    membershipId: string,
    lifetimeSeconds: number,
  ): HttpIssuedOrganizationEnrollmentGrant;
  completeEnrollment(input: {
    enrollment_grant: Uint8Array;
    enrollment_request: OrganizationEnrollmentRequestV1;
  }): Promise<CompletedOrganizationEnrollmentV1>;
  issueAccessLease(
    request: OrganizationAccessLeaseRequestV1,
  ): Promise<OrganizationInstallationAccessStateV1>;
  revokeMembership(
    membershipId: string,
    reason: string,
  ): Promise<RevokedOrganizationMembershipV1>;
  revokeInstallation(
    installationId: string,
    reason: string,
  ): Promise<OrganizationInstallationAccessStateV1>;
}
