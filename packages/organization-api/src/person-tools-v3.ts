import { validatePersonToolsVersion } from './person-tools-v4.js';

export const ORGANIZATION_API_PERSON_TOOLS_PATH_V3 = '/v3/person/tools';
export interface OrganizationPersonToolV3 {
  readonly tool_id: string;
  readonly display_name: string;
  readonly availability: 'enabled' | 'unavailable';
  readonly personal_status: 'unlinked' | 'linked' | 'revoked' | 'unavailable';
  readonly external_scope_id: string | null;
  readonly external_subject_id: string | null;
}
export interface OrganizationPersonToolsV3 {
  readonly schema_version: 3;
  readonly kind: 'echo-organization-person-tools';
  readonly organization_id: string;
  readonly membership_id: string;
  readonly tools: readonly OrganizationPersonToolV3[];
}

/** Generic bounded tool status. Provider protocols validate their own external identities. */
export function validateOrganizationPersonToolsV3(value: unknown): OrganizationPersonToolsV3 {
  return validatePersonToolsVersion(value, 3) as OrganizationPersonToolsV3;
}
