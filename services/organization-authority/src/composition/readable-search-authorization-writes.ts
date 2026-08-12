import type {
  CompletedOrganizationEnrollmentV1,
  IssueOrganizationEnrollmentGrantRequestV1,
  OrganizationAccessLeaseRequestV1,
  ProvisionOrganizationMembershipRequestV1,
  ProvisionedOrganizationMembershipV1,
  RecoverOrganizationInstallationAccessRequestV1,
  RecoveredOrganizationInstallationAccessV1,
  RevokedOrganizationMembershipV1,
} from '@echo-brain/organization-api';
import type {
  OrganizationEnrollmentRequestV1,
  OrganizationInstallationAccessStateV1,
} from '@echo-brain/organization-protocol';
import type {
  IssuedEnrollmentGrant,
  OrganizationAuthorityApplication,
} from '../application/organization-authority.js';
import { ReadableSearchAuthorizationFence } from '../application/readable-search-authorization-fence.js';
import type { OrganizationAuthorityHttpApplication } from '../presentation/organization-authority-http-application.js';

/**
 * The complete production Authority mutation set that can change the current
 * Person authorization root. Record-head and integration-store mutations are
 * fenced at their own composition boundaries because they do not enter the
 * Authority HTTP application.
 */
export const AUTHORIZATION_RELEVANT_AUTHORITY_MUTATIONS = Object.freeze([
  'provisionMembership',
  'issueEnrollmentGrant',
  'completeEnrollment',
  'issueAccessLease',
  'revokeMembership',
  'revokeInstallation',
  'recoverInstallationAccess',
] as const);

/**
 * The live HTTP/admin facade. It deliberately leaves the core application
 * synchronous APIs intact: only process composition owns async lock
 * admission. Each lease begins before the core method's final transaction
 * recheck and remains held until that transaction has committed or failed.
 */
export function fenceAuthorizationRelevantAuthorityMutations(
  application: OrganizationAuthorityApplication,
  fence: ReadableSearchAuthorizationFence,
): OrganizationAuthorityHttpApplication {
  const facade = Object.create(application) as OrganizationAuthorityHttpApplication;
  facade.provisionMembership = async (
    input: ProvisionOrganizationMembershipRequestV1,
  ): Promise<ProvisionedOrganizationMembershipV1> =>
    await fence.withWrite(() => application.provisionMembership(input));
  facade.issueEnrollmentGrant = async (
    membershipId: string,
    input: IssueOrganizationEnrollmentGrantRequestV1,
  ): Promise<IssuedEnrollmentGrant> =>
    await fence.withWrite(() =>
      application.issueEnrollmentGrant(membershipId, input),
    );
  facade.completeEnrollment = async (input: {
    enrollment_grant: Uint8Array;
    enrollment_request: OrganizationEnrollmentRequestV1;
  }): Promise<CompletedOrganizationEnrollmentV1> =>
    await fence.withWrite(() => application.completeEnrollment(input));
  facade.issueAccessLease = async (
    request: OrganizationAccessLeaseRequestV1,
  ): Promise<OrganizationInstallationAccessStateV1> =>
    await fence.withWrite(() => application.issueAccessLease(request));
  facade.revokeMembership = async (
    membershipId: string,
    reason: string,
  ): Promise<RevokedOrganizationMembershipV1> =>
    await fence.withWrite(() => application.revokeMembership(membershipId, reason));
  facade.revokeInstallation = async (
    installationId: string,
    reason: string,
  ): Promise<OrganizationInstallationAccessStateV1> =>
    await fence.withWrite(() => application.revokeInstallation(installationId, reason));
  facade.recoverInstallationAccess = async (
    installationId: string,
    input: RecoverOrganizationInstallationAccessRequestV1,
  ): Promise<RecoveredOrganizationInstallationAccessV1> =>
    await fence.withWrite(() =>
      application.recoverInstallationAccess(installationId, input),
    );
  return Object.freeze(facade);
}
