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
const capture = Object.freeze({ source_type: 'message', admission: 'admitted', source_id_sha256: digest, revision_id_sha256: digest, content_sha256: digest.slice(7) });
const receipt = Object.freeze({ schema_version: 1 as const, kind: 'echo-context-capture-rehearsal-receipt-v1' as const, source_identity_sha256: digest,
  captures: [capture], counts: { captured: 1, admitted: 1, duplicate: 0, request_only: 0 as const } });

describe('closed staging connector protocol', () => {
  it('accepts only the fixed durable-pointer policy, KAN-like Jira selection and one public Slack channel', () => {
    expect(validateStagingConnectorRehearsalProfileV2(profile)).toEqual(profile);
    for (const invalid of [
      { ...profile, capture_policy: 'retain-everything' },
      { ...profile, predecessor_profile_sha256: digest },
      { ...profile, jira: { ...profile.jira, project: 'KAN OR project=PRIVATE' } },
      { ...profile, slack: { channel_id: 'G01234567' } },
      { ...profile, slack: { channel_id: 'C01234567', token: 'must-not-enter-profile' } },
    ]) expect(() => validateStagingConnectorRehearsalProfileV2(invalid)).toThrow('value is invalid');
  });

  it('binds only status or bounded selected-tool capture requests', () => {
    const request = { ...binding, action: 'capture' as const, tool: 'slack' as const, limit: 1 };
    expect(validateStagingConnectorRehearsalRequestV2(request)).toEqual(request);
    for (const invalid of [
      { ...request, schema_version: 1 }, { ...request, tool: 'other' }, { ...request, channel_id: 'C01234567' },
      { ...request, cursor: 'provider-cursor' }, { ...request, limit: 6 },
    ]) expect(() => validateStagingConnectorRehearsalRequestV2(invalid)).toThrow('value is invalid');
  });

  it('accepts retained pointer receipt hashes only as an unqualified observation', () => {
    const response = { ...binding, kind: 'echo-staging-connector-rehearsal-receipt-v2' as const, action: 'capture' as const, qualified: false as const, tool: 'slack' as const, receipt };
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
