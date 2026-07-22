import type {
  OrganizationAccessLeaseRequestV1,
  OrganizationAccessLeaseResponseV1,
} from '@echo-brain/organization-api';
import type { OrganizationEnrollmentRequestV1 } from '@echo-brain/organization-protocol';

/**
 * Transport boundary for one organization authority.
 *
 * Every response remains unknown until the enrollment/state layer verifies
 * its exact signed protocol document. Transport success is never permission.
 */
export interface OrganizationAuthorityClient {
  readAuthorityDescriptor(): Promise<unknown>;

  completeEnrollment(input: {
    enrollmentGrant: Uint8Array;
    enrollmentRequest: OrganizationEnrollmentRequestV1;
  }): Promise<unknown>;

  issueAccessLease(request: OrganizationAccessLeaseRequestV1): Promise<unknown>;
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
