import type {
  CompletedOrganizationEnrollmentV1,
  OrganizationAccessLeaseRequestV1,
  OrganizationAccessLeaseResponseV1,
  OrganizationAuthorityDescriptorResponseV1,
  OrganizationPermissionCheckDecisionV1,
  OrganizationPermissionCheckRequestV1,
} from '@echo-brain/organization-api';
import type { OrganizationEnrollmentRequestV1 } from '@echo-brain/organization-protocol';

/**
 * Transport boundary for one organization authority.
 *
 * Response envelopes are syntax-validated at the transport boundary. The
 * enrollment/state layer still authenticates the signed protocol documents;
 * transport success is never permission.
 */
export interface OrganizationAuthorityClient {
  readAuthorityDescriptor(): Promise<OrganizationAuthorityDescriptorResponseV1>;

  completeEnrollment(input: {
    enrollmentGrant: Uint8Array;
    enrollmentRequest: OrganizationEnrollmentRequestV1;
  }): Promise<CompletedOrganizationEnrollmentV1>;

  issueAccessLease(
    request: OrganizationAccessLeaseRequestV1,
  ): Promise<OrganizationAccessLeaseResponseV1>;

  checkPermission(
    request: OrganizationPermissionCheckRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationPermissionCheckDecisionV1>;
}

export interface OrganizationAuthorityConflict {
  readonly status: 409;
  readonly response: OrganizationAccessLeaseResponseV1 | null;
}

export class OrganizationAuthorityConflictError extends Error {
  readonly conflict: OrganizationAuthorityConflict;

  constructor(response: OrganizationAccessLeaseResponseV1 | null) {
    super('organization authority state advanced concurrently');
    this.name = 'OrganizationAuthorityConflictError';
    this.conflict = Object.freeze({ status: 409 as const, response });
  }
}
