import type {
  CompletedOrganizationEnrollmentV1,
  OrganizationAccessLeaseRequestV1,
  OrganizationAccessLeaseResponseV1,
  OrganizationAuthorityDescriptorResponseV1,
  OrganizationPermissionCheckDecisionV1,
  OrganizationPermissionCheckRequestV1,
  OrganizationRecentDecisionsRequestV1,
  OrganizationRecentDecisionsResponseV1,
  OrganizationReviewerPermissionCheckDecisionV2,
  OrganizationReviewerPermissionCheckRequestV2,
  OrganizationReviewerRecentDecisionsRequestV1,
  OrganizationReviewerRecentDecisionsResponseV1,
  OrganizationInternalLiveDirectiveRequestV1,
  OrganizationInternalLiveUpdateDirectiveV1,
  OrganizationInternalLiveUpdateReceiptV1,
  OrganizationSlackLinkBeginRequestV1,
  OrganizationSlackLinkBeginResponseV1,
  OrganizationSlackLinkCompleteRequestV1,
  OrganizationSlackLinkResultV1,
} from '@echo-brain/organization-api';
import type { OrganizationEnrollmentRequestV1 } from '@echo-brain/organization-protocol';

/**
 * Transport boundary for one organization authority.
 *
 * Response envelopes are syntax-validated at the transport boundary. The
 * enrollment/state layer still authenticates the signed protocol documents;
 * transport success is never permission.
 *
 * `checkPermission` is the exception to "signed document": the request is
 * installation-signed, and the decision carries digests that bind it to that
 * exact request without authenticating it. Authenticity comes from the
 * transport -- the configured HTTPS origin associated with the pinned Authority
 * descriptor -- so the caller must verify the request binding rather than
 * trusting the response body on its own.
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

  checkReviewerPermission(
    request: OrganizationReviewerPermissionCheckRequestV2,
    signal?: AbortSignal,
  ): Promise<OrganizationReviewerPermissionCheckDecisionV2>;

  readRecentDecisions(
    request: OrganizationRecentDecisionsRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationRecentDecisionsResponseV1>;

  readReviewerRecentDecisions(
    request: OrganizationReviewerRecentDecisionsRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationReviewerRecentDecisionsResponseV1>;

  beginSlackLink(
    request: OrganizationSlackLinkBeginRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationSlackLinkBeginResponseV1>;

  completeSlackLink(
    request: OrganizationSlackLinkCompleteRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationSlackLinkResultV1>;

  fetchInternalLiveDirective(
    request: OrganizationInternalLiveDirectiveRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationInternalLiveUpdateDirectiveV1>;

  recordInternalLiveUpdateReceipt(
    receipt: OrganizationInternalLiveUpdateReceiptV1,
    signal?: AbortSignal,
  ): Promise<void>;
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
