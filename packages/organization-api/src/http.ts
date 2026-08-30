export const TRUSTED_PROXY_AUTHORIZATION_HEADER = 'x-echo-proxy-authorization';
export const TRUSTED_PROXY_CLIENT_ID_HEADER = 'x-echo-authenticated-client-id';

export const ORGANIZATION_API_ADMIN_AUTH_SCHEME = 'Bearer';
export const ORGANIZATION_API_ENROLLMENT_AUTH_SCHEME = 'Echo-Enrollment';
export const ORGANIZATION_API_PROXY_AUTH_SCHEME = 'Echo-Proxy';

export const ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH =
  '/v1/authority-descriptor';
export const ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSIONS_PATH =
  '/v2/member-exclusions';
export const ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSION_LIST_PATH =
  '/v2/member-exclusions/list';
export const ORGANIZATION_API_ADMIN_MEETING_INGESTION_EXCLUSION_BREAK_GLASS_PATH =
  '/v2/admin/member-exclusions/break-glass';
export const ORGANIZATION_API_PERSON_OIDC_BEGIN_PATH =
  '/v2/session/oidc/begin';
export const ORGANIZATION_API_PERSON_OIDC_CALLBACK_PATH =
  '/v2/session/oidc/callback';
export const ORGANIZATION_API_PERSON_SESSION_REFRESH_PATH =
  '/v2/session/refresh';
export const ORGANIZATION_API_PERSON_SESSION_REVOCATIONS_PATH =
  '/v2/session/revocations';
export const ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH =
  '/v2/integration-links/slack/challenges';
export const ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH =
  '/v2/integration-links/slack/completions';
export const ORGANIZATION_API_ADMIN_OVERVIEW_PATH = '/v1/admin/overview';
export const ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH = '/v1/admin/memberships';
export const ORGANIZATION_API_ADMIN_AUDIT_PATH = '/v1/admin/audit';

export function organizationApiMembershipRevocationsPath(
  membershipId: string,
): string {
  return `${ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH}/${membershipId}/revocations`;
}
