export const TRUSTED_PROXY_AUTHORIZATION_HEADER = 'x-echo-proxy-authorization';
export const TRUSTED_PROXY_CLIENT_ID_HEADER = 'x-echo-authenticated-client-id';

export const ORGANIZATION_API_ADMIN_AUTH_SCHEME = 'Bearer';
export const ORGANIZATION_API_ENROLLMENT_AUTH_SCHEME = 'Echo-Enrollment';
export const ORGANIZATION_API_PROXY_AUTH_SCHEME = 'Echo-Proxy';

export const ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH =
  '/v1/authority-descriptor';
export const ORGANIZATION_API_ENROLLMENTS_PATH = '/v1/enrollments';
export const ORGANIZATION_API_ACCESS_LEASES_PATH = '/v1/access-leases';
export const ORGANIZATION_API_PERMISSION_CHECKS_PATH = '/v1/permission-checks';
/**
 * The organization decision record ingest path. It is the only route bounded by
 * MAX_ORGANIZATION_RECORD_API_BODY_BYTES — the canonical-envelope contract plus
 * the exact request-wrapper bytes; every other route keeps the shared
 * MAX_ORGANIZATION_API_BODY_BYTES limit.
 */
export const ORGANIZATION_API_RECORD_ENVELOPES_PATH = '/v1/record-envelopes';
export const ORGANIZATION_API_SLACK_LINK_CHALLENGES_PATH =
  '/v1/integration-links/slack/challenges';
export const ORGANIZATION_API_SLACK_LINK_COMPLETIONS_PATH =
  '/v1/integration-links/slack/completions';
export const ORGANIZATION_API_ADMIN_OVERVIEW_PATH = '/v1/admin/overview';
export const ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH = '/v1/admin/memberships';
export const ORGANIZATION_API_ADMIN_INSTALLATIONS_PATH =
  '/v1/admin/installations';
export const ORGANIZATION_API_ADMIN_ENROLLMENT_GRANTS_PATH =
  '/v1/admin/enrollment-grants';
export const ORGANIZATION_API_ADMIN_AUDIT_PATH = '/v1/admin/audit';
export const ORGANIZATION_API_ADMIN_INTERNAL_LIVE_RELEASES_PATH =
  '/v1/admin/internal-live/releases';
export const ORGANIZATION_API_ADMIN_INTERNAL_LIVE_ROLLOUT_PATH =
  '/v1/admin/internal-live/rollout';
export const ORGANIZATION_API_INTERNAL_LIVE_DIRECTIVES_PATH =
  '/v1/internal-live/directives';
export const ORGANIZATION_API_INTERNAL_LIVE_RECEIPTS_PATH =
  '/v1/internal-live/receipts';

export function organizationApiMembershipEnrollmentGrantsPath(
  membershipId: string,
): string {
  return `${ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH}/${membershipId}/enrollment-grants`;
}

export function organizationApiMembershipRevocationsPath(
  membershipId: string,
): string {
  return `${ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH}/${membershipId}/revocations`;
}

export function organizationApiInstallationRevocationsPath(
  installationId: string,
): string {
  return `${ORGANIZATION_API_ADMIN_INSTALLATIONS_PATH}/${installationId}/revocations`;
}
