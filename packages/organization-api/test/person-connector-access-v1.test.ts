import { describe, expect, it } from 'vitest';
import { validateOrganizationPersonConnectorAccessV1, validatePersonConnectorAccessV1 } from '../src/person-connector-access-v1.js';

const connected = {
  tool_id: 'slack', identity_status: 'linked', external_scope_id: 'T123', external_subject_id: 'U123',
  read_status: 'connected', read_capabilities: ['live_evidence'],
};
const envelope = (connectors: unknown[]) => ({ schema_version: 1, kind: 'echo-organization-person-connector-access', organization_id: 'org_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001', connectors });

describe('Person connector read access V1', () => {
  it('separates a linked identity from authorization and permits export-only meeting access', () => {
    const statuses = validateOrganizationPersonConnectorAccessV1(envelope([
      { ...connected, read_status: 'not_connected', read_capabilities: [] },
      { ...connected, tool_id: 'meeting', external_scope_id: null, read_capabilities: ['source_export'] },
      { ...connected, tool_id: 'tickets', read_capabilities: ['live_evidence', 'source_export'] },
    ]));
    expect(statuses.connectors[0]).toMatchObject({ identity_status: 'linked', read_status: 'not_connected' });
    expect(statuses.connectors[1]!.read_capabilities).toEqual(['source_export']);
    expect(validateOrganizationPersonConnectorAccessV1(envelope([])).connectors).toEqual([]);
  });

  it.each(['reauthorization_required', 'revoked', 'unavailable', 'not_connected'])('clears capabilities when read status is %s', read_status => {
    expect(validatePersonConnectorAccessV1({ ...connected, read_status, read_capabilities: [] }).read_status).toBe(read_status);
    expect(() => validatePersonConnectorAccessV1({ ...connected, read_status })).toThrow();
  });

  it('rejects stale bindings, capability inventions and provider/credential extensions', () => {
    for (const access of [
      { ...connected, identity_status: 'unlinked' },
      { ...connected, external_subject_id: null },
      { ...connected, identity_status: 'revoked', external_subject_id: null, external_scope_id: null },
      { ...connected, identity_status: 'unavailable', external_subject_id: null, external_scope_id: null, read_status: 'not_connected', read_capabilities: [] },
      { ...connected, read_capabilities: [] },
      { ...connected, read_capabilities: ['live_evidence', 'live_evidence'] },
      { ...connected, read_capabilities: ['chat:write'] },
      { ...connected, external_subject_id: '\n' },
      { ...connected, identity_status: { toString: () => 'linked' } },
      { ...connected, read_status: { toString: () => 'connected' } },
      { ...connected, nango_connection_id: 'private-connection' },
      { ...connected, token: 'private-token' },
    ]) expect(() => validatePersonConnectorAccessV1(access)).toThrow();
    expect(validatePersonConnectorAccessV1({ ...connected, identity_status: 'revoked', external_scope_id: null, external_subject_id: null, read_status: 'revoked', read_capabilities: [] }).identity_status).toBe('revoked');
  });

  it('owns an immutable copy and rejects hidden, sparse, duplicate and oversized state', () => {
    const input = { ...connected, read_capabilities: [...connected.read_capabilities] };
    const result = validatePersonConnectorAccessV1(input);
    input.read_capabilities[0] = 'source_export';
    expect(result.read_capabilities).toEqual(['live_evidence']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.read_capabilities)).toBe(true);
    for (const value of [
      Object.defineProperty({ ...connected }, 'token', { value: 'secret', enumerable: false }),
      { ...connected, read_capabilities: Array(1) },
      { ...connected, read_capabilities: Object.assign(['live_evidence'], { token: 'secret' }) },
    ]) expect(() => validatePersonConnectorAccessV1(value)).toThrow();
    for (const value of [envelope([connected, connected]), envelope(Array.from({ length: 33 }, (_, i) => ({ ...connected, tool_id: `tool-${i}` }))), { ...envelope([]), organization_id: 'org_other' }]) {
      expect(() => validateOrganizationPersonConnectorAccessV1(value)).toThrow();
    }
  });
});
