export const TRUSTED_PROXY_AUTHORIZATION_HEADER = 'x-echo-proxy-authorization';
export const TRUSTED_PROXY_CLIENT_ID_HEADER = 'x-echo-authenticated-client-id';

export const ORGANIZATION_API_ADMIN_AUTH_SCHEME = 'Bearer';
export const ORGANIZATION_API_ENROLLMENT_AUTH_SCHEME = 'Echo-Enrollment';
export const ORGANIZATION_API_PROXY_AUTH_SCHEME = 'Echo-Proxy';

export const ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH =
  '/v1/authority-descriptor';
export const ORGANIZATION_API_ENROLLMENTS_PATH = '/v1/enrollments';
export const ORGANIZATION_API_ACCESS_LEASES_PATH = '/v1/access-leases';
export const ORGANIZATION_API_ADMIN_OVERVIEW_PATH = '/v1/admin/overview';
export const ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH = '/v1/admin/memberships';
export const ORGANIZATION_API_ADMIN_INSTALLATIONS_PATH =
  '/v1/admin/installations';
export const ORGANIZATION_API_ADMIN_ENROLLMENT_GRANTS_PATH =
  '/v1/admin/enrollment-grants';
export const ORGANIZATION_API_ADMIN_AUDIT_PATH = '/v1/admin/audit';

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
