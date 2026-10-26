import { asRecord, assertExactKeys, assertId, assertPatternString, assertToolId, fail } from './validation.js';

export const ORGANIZATION_API_PERSON_TOOLS_PATH_V4 = '/v4/person/tools';

/** Owner-only organization-wide setup lifecycle for a tool's shared app. Null when the tool has none. */
export type OrganizationToolSetupStatusV4 = 'not_set_up' | 'app_created' | 'connected' | 'needs_reinstall';
const ORGANIZATION_TOOL_SETUP_STATUSES_V4: readonly OrganizationToolSetupStatusV4[] = ['not_set_up', 'app_created', 'connected', 'needs_reinstall'];

export interface OrganizationPersonToolV4 {
  readonly tool_id: string;
  readonly display_name: string;
  readonly availability: 'enabled' | 'unavailable';
  readonly personal_status: 'unlinked' | 'linked' | 'revoked' | 'unavailable';
  readonly external_scope_id: string | null;
  readonly external_subject_id: string | null;
  readonly organization_setup: OrganizationToolSetupStatusV4 | null;
}
export interface OrganizationPersonToolsV4 {
  readonly schema_version: 4;
  readonly kind: 'echo-organization-person-tools';
  readonly organization_id: string;
  readonly membership_id: string;
  readonly tools: readonly OrganizationPersonToolV4[];
}

/**
 * Generic bounded tool status, with each tool's organization-wide setup
 * lifecycle (non-null only for owners). Provider protocols validate their own
 * external identities.
 */
export function validateOrganizationPersonToolsV4(value: unknown): OrganizationPersonToolsV4 {
  const r = asRecord(value, 'Person tools');
  assertExactKeys(r, ['schema_version', 'kind', 'organization_id', 'membership_id', 'tools'], 'Person tools');
  if (r.schema_version !== 4 || r.kind !== 'echo-organization-person-tools') fail('Person tools version is unsupported');
  assertId(r.organization_id, 'org', 'organization_id');
  assertId(r.membership_id, 'mem', 'membership_id');
  if (!Array.isArray(r.tools) || r.tools.length > 32) fail('Person tools list is invalid');
  const seen = new Set<string>();
  for (const value of r.tools as unknown[]) {
    const tool = asRecord(value, 'Person tool');
    assertExactKeys(tool, ['tool_id', 'display_name', 'availability', 'personal_status', 'external_scope_id', 'external_subject_id', 'organization_setup'], 'Person tool');
    assertToolId(tool.tool_id);
    assertPatternString(tool.display_name, 'display_name', 128, /^[^\u0000-\u001f\u007f]+$/);
    if (seen.has(String(tool.tool_id))) fail('Person tool identity is duplicated');
    seen.add(String(tool.tool_id));
    if (!['enabled', 'unavailable'].includes(String(tool.availability)) ||
        !['unlinked', 'linked', 'revoked', 'unavailable'].includes(String(tool.personal_status))) fail('Person tool state is invalid');
    for (const field of ['external_scope_id', 'external_subject_id'] as const) {
      if (tool[field] !== null) assertPatternString(tool[field], field, 256, /^[^\u0000-\u001f\u007f]+$/);
    }
    if (tool.organization_setup !== null && !ORGANIZATION_TOOL_SETUP_STATUSES_V4.includes(tool.organization_setup as OrganizationToolSetupStatusV4)) {
      fail('Person tool organization setup is invalid');
    }
    if (tool.availability === 'unavailable') {
      if (tool.personal_status !== 'unavailable' || tool.external_scope_id !== null || tool.external_subject_id !== null) fail('Unavailable tool exposes stale state');
    } else if (tool.personal_status === 'unavailable' ||
        (tool.personal_status === 'linked' ? tool.external_subject_id === null : tool.external_subject_id !== null)) fail('Person tool identity state is invalid');
  }
  return r as unknown as OrganizationPersonToolsV4;
}
