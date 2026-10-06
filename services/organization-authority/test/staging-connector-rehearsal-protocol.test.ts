import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  STAGING_CONNECTOR_REHEARSAL_POLICY_V3,
  validateStagingConnectorRehearsalProfileV3,
  validateStagingConnectorRehearsalRequestV3,
  validateStagingConnectorRehearsalResponseV3,
} from '../src/composition/staging-connector-rehearsal-protocol.js';

const digest = canonicalSha256('fixture');
const profile = Object.freeze({
  schema_version: 3 as const,
  kind: 'echo-staging-connector-rehearsal-profile-v3' as const,
  read_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V3,
  jira: { cloud_id: '11111111-1111-4111-8111-111111111111', integration_key: 'jira', project: 'KAN' },
});
const binding = Object.freeze({ schema_version: 3 as const, release_id: 'clean-v1-connector-test', profile_sha256: canonicalSha256(profile) });
const capture = Object.freeze({ source_type: 'note', admission: 'admitted', source_id_sha256: digest, revision_id_sha256: digest, content_sha256: digest.slice(7) });
const receipt = Object.freeze({ schema_version: 1 as const, kind: 'echo-context-capture-rehearsal-receipt-v1' as const, source_identity_sha256: digest,
  captures: [capture], counts: { captured: 1, admitted: 1, duplicate: 0, request_only: 0 as const } });

describe('closed staging connector protocol', () => {
  it.each(['granola', 'jira', 'slack'])('rejects %s capture requests and receipts', tool => {
    expect(() => validateStagingConnectorRehearsalRequestV3({ ...binding, action: 'capture', tool, limit: 1 })).toThrow('value is invalid');
    expect(() => validateStagingConnectorRehearsalResponseV3({ ...binding, kind: 'echo-staging-connector-rehearsal-receipt-v3',
      action: 'capture', qualified: false, tool, receipt })).toThrow('value is invalid');
  });

  it('accepts only fixed-scope Jira read verification without caller-selected content or budgets', () => {
    for (const tool of ['jira'] as const) {
      const request = { ...binding, action: 'verify-read', tool };
      expect(validateStagingConnectorRehearsalRequestV3(request)).toEqual(request);
      for (const extra of [{ limit: 2 }, { channel_id: 'COTHER' }, { project: 'PRIVATE' }, { query: 'private text' }]) {
        expect(() => validateStagingConnectorRehearsalRequestV3({ ...request, ...extra })).toThrow('value is invalid');
      }
    }
    for (const tool of ['granola', 'slack']) expect(() => validateStagingConnectorRehearsalRequestV3({ ...binding, action: 'verify-read', tool })).toThrow('value is invalid');
  });

  it('returns only finite read diagnostics or digests of positive bounded text, never provider content', () => {
    const response = { ...binding, kind: 'echo-staging-connector-rehearsal-receipt-v3', action: 'verify-read', qualified: false, tool: 'jira',
      result: { status: 'verified', source_coordinate_sha256: digest, text_sha256: digest, text_bytes: 42 } };
    expect(validateStagingConnectorRehearsalResponseV3(response)).toEqual(response);
    const refused = { ...response, result: { status: 'refused', phase: 'connection', reason: 'connection_absent' } };
    expect(validateStagingConnectorRehearsalResponseV3(refused)).toEqual(refused);
    for (const invalid of [
      { ...response, qualified: true },
      { ...response, result: { ...response.result, text_bytes: 0 } },
      { ...response, result: { ...response.result, text_bytes: 3073 } },
      { ...response, result: { ...response.result, text: 'provider body must remain private' } },
      { ...refused, result: { ...refused.result, reason: 'raw provider exception' } },
    ]) expect(() => validateStagingConnectorRehearsalResponseV3(invalid)).toThrow('value is invalid');
  });

  it('accepts the V3 Jira profile and rejects retired versions and fields', () => {
    expect(validateStagingConnectorRehearsalProfileV3(profile)).toEqual(profile);
    for (const invalid of [
      { ...profile, schema_version: 2 },
      { ...profile, capture_policy: 'retain-everything' },
      { ...profile, predecessor_profile_sha256: digest },
      { ...profile, jira: { ...profile.jira, project: 'KAN OR project=PRIVATE' } },
      { ...profile, slack: { channel_id: 'G01234567' } },
      { ...profile, slack: { channel_id: 'C01234567', token: 'must-not-enter-profile' } },
    ]) expect(() => validateStagingConnectorRehearsalProfileV3(invalid)).toThrow('value is invalid');
  });

  it('binds status requests and responses to an exact release and profile', () => {
    const request = { ...binding, action: 'status' as const };
    expect(validateStagingConnectorRehearsalRequestV3(request)).toEqual(request);
    for (const invalid of [
      { ...request, schema_version: 2 }, { ...request, tool: 'granola' },
      { ...request, cursor: 'provider-cursor' }, { ...request, release_id: 'unbound' },
      { ...request, profile_sha256: 'invalid' },
    ]) expect(() => validateStagingConnectorRehearsalRequestV3(invalid)).toThrow('value is invalid');
    const response = { ...request, kind: 'echo-staging-connector-rehearsal-receipt-v3', qualified: false, processing: 'active' };
    expect(validateStagingConnectorRehearsalResponseV3(response)).toEqual(response);
    for (const invalid of [
      { ...response, kind: 'echo-staging-connector-rehearsal-receipt-v2' },
      { ...response, granola_available: true }, { ...response, processing: 'unknown' },
      { ...response, qualified: true },
    ]) expect(() => validateStagingConnectorRehearsalResponseV3(invalid)).toThrow('value is invalid');
  });
});
