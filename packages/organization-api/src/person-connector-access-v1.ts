import { asEnumerableRecord, assertExactKeys, assertId, assertPatternString, fail } from './validation.js';

export type PersonConnectorIdentityStatusV1 = 'unlinked' | 'linked' | 'revoked' | 'unavailable';
export type PersonConnectorReadStatusV1 = 'not_connected' | 'connected' | 'reauthorization_required' | 'revoked' | 'unavailable';
export type PersonConnectorReadCapabilityV1 = 'live_evidence' | 'source_export';

/** Identity linking and permission to read are separate, even when one OAuth flow establishes both. */
export interface PersonConnectorAccessV1 {
  readonly tool_id: string;
  readonly identity_status: PersonConnectorIdentityStatusV1;
  readonly external_scope_id: string | null;
  readonly external_subject_id: string | null;
  readonly read_status: PersonConnectorReadStatusV1;
  /** ECHO capabilities established by the provider, not a list of OAuth scopes. */
  readonly read_capabilities: readonly PersonConnectorReadCapabilityV1[];
}

/** Additive contract; no HTTP endpoint is introduced and Person tools V3/V4 remain independent. */
export interface OrganizationPersonConnectorAccessV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-organization-person-connector-access';
  readonly organization_id: string;
  readonly membership_id: string;
  readonly connectors: readonly PersonConnectorAccessV1[];
}

export function validatePersonConnectorAccessV1(value: unknown): PersonConnectorAccessV1 {
  const r = asEnumerableRecord(value, 'Person connector access');
  assertExactKeys(r, ['tool_id', 'identity_status', 'external_scope_id', 'external_subject_id', 'read_status', 'read_capabilities'], 'Person connector access');
  assertPatternString(r.tool_id, 'tool_id', 64, /^[a-z][a-z0-9-]*$/);
  if (typeof r.identity_status !== 'string' || !['unlinked', 'linked', 'revoked', 'unavailable'].includes(r.identity_status)) fail('Connector identity status is invalid');
  if (typeof r.read_status !== 'string' || !['not_connected', 'connected', 'reauthorization_required', 'revoked', 'unavailable'].includes(r.read_status)) fail('Connector read status is invalid');
  for (const field of ['external_scope_id', 'external_subject_id'] as const) {
    if (r[field] !== null) assertPatternString(r[field], field, 256, /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);
    if (typeof r[field] === 'string' && r[field] !== r[field].normalize('NFC')) fail(`Connector ${field} is not normalized`);
  }
  if ((r.identity_status === 'linked') !== (r.external_subject_id !== null)) fail('Connector identity binding is inconsistent');
  if (r.identity_status !== 'linked' && r.external_scope_id !== null) fail('Unlinked connector exposes an external scope');
  if (r.identity_status === 'unavailable' && r.read_status !== 'unavailable') fail('Unavailable identity exposes read state');
  if ((r.read_status === 'connected' || r.read_status === 'reauthorization_required') && r.identity_status !== 'linked') fail('Read access requires a linked identity');
  if (!Array.isArray(r.read_capabilities) || r.read_capabilities.length > 2 ||
      r.read_capabilities.some(value => value !== 'live_evidence' && value !== 'source_export') ||
      new Set(r.read_capabilities).size !== r.read_capabilities.length ||
      (r.read_status === 'connected' ? r.read_capabilities.length === 0 : r.read_capabilities.length !== 0)) fail('Connector read capabilities are inconsistent');
  return Object.freeze({
    tool_id: r.tool_id,
    identity_status: r.identity_status as PersonConnectorIdentityStatusV1,
    external_scope_id: r.external_scope_id as string | null,
    external_subject_id: r.external_subject_id as string | null,
    read_status: r.read_status as PersonConnectorReadStatusV1,
    read_capabilities: Object.freeze([...r.read_capabilities]) as readonly PersonConnectorReadCapabilityV1[],
  });
}

export function validateOrganizationPersonConnectorAccessV1(value: unknown): OrganizationPersonConnectorAccessV1 {
  const r = asEnumerableRecord(value, 'Person connector access response');
  assertExactKeys(r, ['schema_version', 'kind', 'organization_id', 'membership_id', 'connectors'], 'Person connector access response');
  if (r.schema_version !== 1 || r.kind !== 'echo-organization-person-connector-access') fail('Connector access version is unsupported');
  assertId(r.organization_id, 'org', 'organization_id');
  assertId(r.membership_id, 'mem', 'membership_id');
  if (!Array.isArray(r.connectors) || r.connectors.length > 32) fail('Connector access list is invalid');
  const connectors = r.connectors.map(validatePersonConnectorAccessV1);
  if (new Set(connectors.map(value => value.tool_id)).size !== connectors.length) fail('Connector identity is duplicated');
  return Object.freeze({ schema_version: 1, kind: 'echo-organization-person-connector-access', organization_id: r.organization_id as string, membership_id: r.membership_id as string, connectors: Object.freeze(connectors) });
}
