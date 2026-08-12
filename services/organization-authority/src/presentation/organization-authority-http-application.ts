import type {
  ApproveOrganizationInternalLiveReleaseRequestV1,
  CompletedOrganizationEnrollmentV1,
  IssueOrganizationEnrollmentGrantRequestV1,
  OrganizationAccessLeaseRequestV1,
  OrganizationAdminOverviewV1,
  OrganizationAuditPageV1,
  OrganizationEnrollmentGrantPageV1,
  OrganizationInstallationPageV1,
  OrganizationInternalLiveDirectiveRequestV1,
  OrganizationInternalLiveRolloutStatusV1,
  OrganizationInternalLiveUpdateDirectiveV1,
  OrganizationInternalLiveUpdateReceiptV1,
  OrganizationMembershipPageV1,
  OrganizationPermissionCheckRequestV1,
  OrganizationReviewerPermissionCheckRequestV2,
  OrganizationApiSha256Digest,
  ProvisionedOrganizationMembershipV1,
  ProvisionOrganizationMembershipRequestV1,
  RecoverOrganizationInstallationAccessRequestV1,
  RecoveredOrganizationInstallationAccessV1,
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
  enrollment_grant_sha256: OrganizationApiSha256Digest;
  issued_at: string;
  expires_at: string;
}

/** The use cases exposed to the JSON/HTTP presentation adapter. */
export interface OrganizationAuthorityHttpApplication {
  descriptor(): OrganizationAuthorityDescriptorV1;
  adminOverview(): OrganizationAdminOverviewV1;
  listMemberships(input?: {
    cursor?: string;
    limit?: number;
  }): OrganizationMembershipPageV1;
  listInstallations(input?: {
    cursor?: string;
    limit?: number;
  }): OrganizationInstallationPageV1;
  listEnrollmentGrants(input?: {
    cursor?: string;
    limit?: number;
  }): OrganizationEnrollmentGrantPageV1;
  listAudit(input?: {
    cursor?: string;
    limit?: number;
  }): OrganizationAuditPageV1;
  internalLiveRolloutStatus(): OrganizationInternalLiveRolloutStatusV1;
  approveInternalLiveRelease(
    input: ApproveOrganizationInternalLiveReleaseRequestV1,
  ): OrganizationInternalLiveUpdateDirectiveV1;
  fetchInternalLiveDirective(
    input: OrganizationInternalLiveDirectiveRequestV1,
  ): OrganizationInternalLiveUpdateDirectiveV1;
  recordInternalLiveUpdateReceipt(
    input: OrganizationInternalLiveUpdateReceiptV1,
  ): void;
  provisionMembership(
    input: ProvisionOrganizationMembershipRequestV1,
  ): ProvisionedOrganizationMembershipV1;
  issueEnrollmentGrant(
    membershipId: string,
    input: IssueOrganizationEnrollmentGrantRequestV1,
  ): HttpIssuedOrganizationEnrollmentGrant;
  completeEnrollment(input: {
    enrollment_grant: Uint8Array;
    enrollment_request: OrganizationEnrollmentRequestV1;
  }): Promise<CompletedOrganizationEnrollmentV1>;
  issueAccessLease(
    request: OrganizationAccessLeaseRequestV1,
  ): Promise<OrganizationInstallationAccessStateV1>;
  checkPermissionSubject(
    request: OrganizationPermissionCheckRequestV1,
    target: null,
  ): {
    installation_id: string;
  };
  checkReviewerPermissionSubject(
    request: OrganizationReviewerPermissionCheckRequestV2,
    target: null,
  ): {
    installation_id: string;
  };
  revokeMembership(
    membershipId: string,
    reason: string,
  ): Promise<RevokedOrganizationMembershipV1>;
  revokeInstallation(
    installationId: string,
    reason: string,
  ): Promise<OrganizationInstallationAccessStateV1>;
  recoverInstallationAccess(
    installationId: string,
    input: RecoverOrganizationInstallationAccessRequestV1,
  ): Promise<RecoveredOrganizationInstallationAccessV1>;
}
