import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  STAGING_CONNECTOR_REHEARSAL_POLICY_V2,
  validateStagingConnectorRehearsalProfileV2,
  validateStagingConnectorRehearsalRequestV2,
  validateStagingConnectorRehearsalResponseV2,
} from '../src/composition/staging-connector-rehearsal-protocol.js';

const digest = canonicalSha256('fixture');
const profile = Object.freeze({
  schema_version: 2 as const,
  kind: 'echo-staging-connector-rehearsal-profile-v2' as const,
  capture_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V2,
  jira: { cloud_id: '11111111-1111-4111-8111-111111111111', integration_key: 'jira', project: 'KAN' },
  slack: { channel_id: 'C01234567' },
});
const binding = Object.freeze({ schema_version: 2 as const, release_id: 'clean-v1-connector-test', profile_sha256: canonicalSha256(profile) });
const capture = Object.freeze({ source_type: 'note', admission: 'admitted', source_id_sha256: digest, revision_id_sha256: digest, content_sha256: digest.slice(7) });
const receipt = Object.freeze({ schema_version: 1 as const, kind: 'echo-context-capture-rehearsal-receipt-v1' as const, source_identity_sha256: digest,
  captures: [capture], counts: { captured: 1, admitted: 1, duplicate: 0, request_only: 0 as const } });

describe('closed staging connector protocol', () => {
  it.each(['jira', 'slack'])('rejects %s capture requests and receipts', tool => {
    expect(() => validateStagingConnectorRehearsalRequestV2({ ...binding, action: 'capture', tool, limit: 1 })).toThrow('value is invalid');
    expect(() => validateStagingConnectorRehearsalResponseV2({ ...binding, kind: 'echo-staging-connector-rehearsal-receipt-v2',
      action: 'capture', qualified: false, tool, receipt })).toThrow('value is invalid');
  });

  it('accepts only fixed-scope Slack and Jira read verification without caller-selected content or budgets', () => {
    for (const tool of ['slack', 'jira'] as const) {
      const request = { ...binding, action: 'verify-read', tool };
      expect(validateStagingConnectorRehearsalRequestV2(request)).toEqual(request);
      for (const extra of [{ limit: 2 }, { channel_id: 'COTHER' }, { project: 'PRIVATE' }, { query: 'private text' }]) {
        expect(() => validateStagingConnectorRehearsalRequestV2({ ...request, ...extra })).toThrow('value is invalid');
      }
    }
    expect(() => validateStagingConnectorRehearsalRequestV2({ ...binding, action: 'verify-read', tool: 'granola' })).toThrow('value is invalid');
  });

  it('returns only finite read diagnostics or digests of positive bounded text, never provider content', () => {
    const response = { ...binding, kind: 'echo-staging-connector-rehearsal-receipt-v2', action: 'verify-read', qualified: false, tool: 'slack',
      result: { status: 'verified', source_coordinate_sha256: digest, text_sha256: digest, text_bytes: 42 } };
    expect(validateStagingConnectorRehearsalResponseV2(response)).toEqual(response);
    const refused = { ...response, result: { status: 'refused', phase: 'connection', reason: 'connection_absent' } };
    expect(validateStagingConnectorRehearsalResponseV2(refused)).toEqual(refused);
    for (const invalid of [
      { ...response, qualified: true },
      { ...response, result: { ...response.result, text_bytes: 0 } },
      { ...response, result: { ...response.result, text_bytes: 3073 } },
      { ...response, result: { ...response.result, text: 'provider body must remain private' } },
      { ...refused, result: { ...refused.result, reason: 'raw provider exception' } },
    ]) expect(() => validateStagingConnectorRehearsalResponseV2(invalid)).toThrow('value is invalid');
  });

  it('accepts only the unchanged persisted profile, KAN-like Jira selection and one public Slack channel', () => {
    expect(validateStagingConnectorRehearsalProfileV2(profile)).toEqual(profile);
    for (const invalid of [
      { ...profile, capture_policy: 'retain-everything' },
      { ...profile, predecessor_profile_sha256: digest },
      { ...profile, jira: { ...profile.jira, project: 'KAN OR project=PRIVATE' } },
      { ...profile, slack: { channel_id: 'G01234567' } },
      { ...profile, slack: { channel_id: 'C01234567', token: 'must-not-enter-profile' } },
    ]) expect(() => validateStagingConnectorRehearsalProfileV2(invalid)).toThrow('value is invalid');
  });

  it('binds only status or bounded Granola capture requests', () => {
    const request = { ...binding, action: 'capture' as const, tool: 'granola' as const, limit: 1 };
    expect(validateStagingConnectorRehearsalRequestV2(request)).toEqual(request);
    for (const invalid of [
      { ...request, schema_version: 1 }, { ...request, tool: 'other' }, { ...request, channel_id: 'C01234567' },
      { ...request, cursor: 'provider-cursor' }, { ...request, limit: 6 },
    ]) expect(() => validateStagingConnectorRehearsalRequestV2(invalid)).toThrow('value is invalid');
  });

  it('accepts retained meeting receipt hashes only as an unqualified observation', () => {
    const response = { ...binding, kind: 'echo-staging-connector-rehearsal-receipt-v2' as const, action: 'capture' as const, qualified: false as const, tool: 'granola' as const, receipt };
    expect(validateStagingConnectorRehearsalResponseV2(response)).toEqual(response);
    for (const invalid of [
      { ...response, kind: 'echo-staging-connector-rehearsal-receipt-v1' },
      { ...response, qualified: true },
      { ...response, receipt: { ...receipt, captures: [{ ...capture, admission: 'request_only' }] } },
      { ...response, receipt: { ...receipt, captures: [{ ...capture, source_type: 'ticket' }] } },
      { ...response, receipt: { ...receipt, captures: [{ ...capture, content: 'message text' }] } },
    ]) expect(() => validateStagingConnectorRehearsalResponseV2(invalid)).toThrow('value is invalid');
  });
});
