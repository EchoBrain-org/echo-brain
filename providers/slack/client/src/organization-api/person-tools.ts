import { asRecord, assertExactKeys, assertId, assertPatternString, fail } from "@echo-brain/organization-api/validation";

export const ORGANIZATION_API_PERSON_TOOLS_PATH = '/v2/person/tools';
export const ORGANIZATION_API_PERSON_SLACK_DISCONNECT_PATH = '/v2/person/external-identities/slack/disconnect';

/** Disconnect always targets the authenticated person, never a supplied identity. */
export function validateOrganizationPersonSlackDisconnectRequest(value: unknown): Readonly<Record<string, never>> {
  const request = asRecord(value, 'Person Slack disconnect request');
  assertExactKeys(request, [], 'Person Slack disconnect request');
  return Object.freeze({});
}

export interface OrganizationPersonToolV2 {
  readonly provider: 'slack';
  readonly availability: 'enabled' | 'unavailable';
  readonly personal_status: 'unlinked' | 'linked' | 'revoked' | 'unavailable';
  readonly workspace_id: string | null;
  readonly account_id: string | null;
}
export interface OrganizationPersonToolsV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-organization-person-tools';
  readonly organization_id: string;
  readonly membership_id: string;
  readonly tools: readonly OrganizationPersonToolV2[];
}
export function validateOrganizationPersonTools(value: unknown): OrganizationPersonToolsV2 {
  const r = asRecord(value, 'Person tools');
  assertExactKeys(r, ['schema_version', 'kind', 'organization_id', 'membership_id', 'tools'], 'Person tools');
  if (r.schema_version !== 2 || r.kind !== 'echo-organization-person-tools') fail('Person tools version is unsupported');
  assertId(r.organization_id, 'org', 'organization_id');
  assertId(r.membership_id, 'mem', 'membership_id');
  if (!Array.isArray(r.tools) || r.tools.length > 1) fail('Person tools list is invalid');
  for (const value of r.tools as unknown[]) {
    const tool = asRecord(value, 'Person tool');
    assertExactKeys(tool, ['provider', 'availability', 'personal_status', 'workspace_id', 'account_id'], 'Person tool');
    if (tool.provider !== 'slack' || !['enabled', 'unavailable'].includes(String(tool.availability)) ||
        !['unlinked', 'linked', 'revoked', 'unavailable'].includes(String(tool.personal_status))) fail('Person tool state is invalid');
    if (tool.availability === 'unavailable') {
      if (tool.personal_status !== 'unavailable' || tool.workspace_id !== null || tool.account_id !== null) fail('Unavailable tool exposes stale state');
    } else {
      assertPatternString(tool.workspace_id, 'workspace_id', 128, /^T[A-Z0-9]{2,}$/);
      if (tool.personal_status === 'unavailable') fail('Enabled tool status is invalid');
      if (tool.personal_status === 'linked') assertPatternString(tool.account_id, 'account_id', 128, /^[UW][A-Z0-9]{2,}$/);
      else if (tool.account_id !== null) fail('Unlinked tool exposes stale identity');
    }
  }
  return r as unknown as OrganizationPersonToolsV2;
}
