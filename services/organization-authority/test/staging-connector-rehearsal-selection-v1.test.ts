import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { readStagingConnectorRehearsalSelectionV1 } from '../src/composition/staging-connector-rehearsal-selection-v1.js';
import {
  validateStagingConnectorRehearsalProfileV1,
  validateStagingConnectorRehearsalRequestV1,
  validateStagingConnectorRehearsalResponseV1,
} from '../src/composition/staging-connector-rehearsal-protocol-v1.js';

const profile = {
  schema_version: 1,
  kind: 'echo-staging-connector-rehearsal-profile-v1',
  capture_policy: 'initial-owner-granola-retained-jira-request-only-v1',
  jira: { cloud_id: '11111111-1111-4111-8111-111111111111', integration_key: 'jira-test', project: 'TEST' },
};
const binding = { schema_version: 1, release_id: 'clean-v1-connector-test', profile_sha256: canonicalSha256(profile) };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function prepared() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'echo-staging-profile-'));
  roots.push(root);
  mkdirSync(join(root, 'private'), { mode: 0o700 });
  const path = join(root, 'private', 'staging-connector-rehearsal.json');
  writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
  return { path, input: { state_directory: join(root, 'state'), authority_url: 'https://authority-staging.echobrain.org',
    environment: { ECHO_STAGING_CONNECTOR_REHEARSAL_PROFILE_FILE: path, ECHO_CLEAN_AUTHORITY_HOST: 'authority-staging.echobrain.org', ECHO_CLEAN_RELEASE_ID: binding.release_id } } };
}

describe('staging rehearsal opt-in selection', () => {
  it('leaves ordinary profiles disabled without reading any file', () => {
    expect(readStagingConnectorRehearsalSelectionV1({ state_directory: '/missing', authority_url: 'https://authority.echobrain.org', environment: {} })).toBeUndefined();
  });
  it('reads the private profile only for the fixed staging identity', () => {
    const { input } = prepared();
    expect(readStagingConnectorRehearsalSelectionV1(input)).toEqual({ profile, release_id: binding.release_id, authority_host: 'authority-staging.echobrain.org' });
    expect(() => readStagingConnectorRehearsalSelectionV1({ ...input, authority_url: 'https://authority.echobrain.org' })).toThrow();
    expect(() => readStagingConnectorRehearsalSelectionV1({ ...input, environment: { ...input.environment, ECHO_CLEAN_AUTHORITY_HOST: 'authority.echobrain.org' } })).toThrow();
    expect(() => readStagingConnectorRehearsalSelectionV1({ ...input, environment: { ...input.environment, ECHO_CLEAN_RELEASE_ID: '' } })).toThrow();
  });
  it('rejects loose permissions, alternate paths, symlinks and oversized profiles', () => {
    const { path, input } = prepared();
    chmodSync(path, 0o644);
    expect(() => readStagingConnectorRehearsalSelectionV1(input)).toThrow();
    chmodSync(path, 0o600);
    const alias = join(input.state_directory, '..', 'profile-alias.json');
    symlinkSync(path, alias);
    expect(() => readStagingConnectorRehearsalSelectionV1({ ...input, environment: { ...input.environment, ECHO_STAGING_CONNECTOR_REHEARSAL_PROFILE_FILE: alias } })).toThrow();
    rmSync(alias);
    rmSync(path);
    const target = join(input.state_directory, '..', 'target.json');
    writeFileSync(target, JSON.stringify(profile), { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => readStagingConnectorRehearsalSelectionV1(input)).toThrow();
    rmSync(path);
    writeFileSync(path, ' '.repeat(8193), { mode: 0o600 });
    expect(() => readStagingConnectorRehearsalSelectionV1(input)).toThrow();
  });
});

describe('closed staging connector protocol', () => {
  it('accepts only the fixed policy and nonsecret Jira selection', () => {
    expect(validateStagingConnectorRehearsalProfileV1(profile)).toEqual(profile);
    expect(() => validateStagingConnectorRehearsalProfileV1({ ...profile, access_token: 'must-not-reflect' })).toThrow('value is invalid');
    expect(() => validateStagingConnectorRehearsalProfileV1({ ...profile, capture_policy: 'retain-everything' })).toThrow();
    expect(() => validateStagingConnectorRehearsalProfileV1({ ...profile, jira: { ...profile.jira, project: 'TEST OR project=PRIVATE' } })).toThrow();
  });
  it('rejects client-selected cursors, accounts and unbounded capture counts', () => {
    const request = { ...binding, action: 'capture', tool: 'jira', limit: 1 };
    expect(validateStagingConnectorRehearsalRequestV1(request)).toEqual(request);
    for (const extra of [{ cursor: 'provider-cursor' }, { account: 'someone-else' }, { limit: 6 }, { limit: 0 }, { limit: 1.1 }]) {
      expect(() => validateStagingConnectorRehearsalRequestV1({ ...request, ...extra })).toThrow();
    }
  });
  const digest = canonicalSha256('test-only');
  const capture = { source_type: 'ticket', admission: 'request_only', source_id_sha256: digest, revision_id_sha256: digest, content_sha256: digest.slice(7) };
  const receipt = { schema_version: 1, kind: 'echo-context-capture-rehearsal-receipt-v1', source_identity_sha256: digest,
    captures: [capture], counts: { captured: 1, admitted: 0, duplicate: 0, request_only: 1 } };
  const response = { ...binding, kind: 'echo-staging-connector-rehearsal-receipt-v1', action: 'capture', qualified: false, tool: 'jira', receipt };
  it('never prints content, provider identifiers or contradictory capture outcomes', () => {
    expect(validateStagingConnectorRehearsalResponseV1(response)).toEqual(response);
    for (const item of [
      { ...capture, content: 'ticket body' }, { ...capture, source_id: 'TICKET-1' },
      { ...capture, revision_id_sha256: 'provider-revision' }, { ...capture, source_type: 'meeting' },
      { ...capture, admission: 'admitted' },
    ]) expect(() => validateStagingConnectorRehearsalResponseV1({ ...response, receipt: { ...receipt, captures: [item] } })).toThrow();
    expect(() => validateStagingConnectorRehearsalResponseV1({ ...response, receipt: { ...receipt, counts: { ...receipt.counts, captured: 0 } } })).toThrow();
    expect(() => validateStagingConnectorRehearsalResponseV1({ ...response, qualified: true })).toThrow();
    expect(() => validateStagingConnectorRehearsalResponseV1({ ...response, tool: 'granola' })).toThrow();
  });
  it('reports an empty observation without claiming provider qualification', () => {
    expect(validateStagingConnectorRehearsalResponseV1({ ...response, receipt: { ...receipt, captures: [], counts: { captured: 0, admitted: 0, duplicate: 0, request_only: 0 } } }).qualified).toBe(false);
  });
});
