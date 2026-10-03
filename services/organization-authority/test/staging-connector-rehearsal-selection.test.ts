import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStagingConnectorRehearsalSelection } from '../src/composition/staging-connector-rehearsal-selection.js';
import { STAGING_CONNECTOR_REHEARSAL_POLICY_V2 } from '../src/composition/staging-connector-rehearsal-protocol.js';

const profile = {
  schema_version: 2,
  kind: 'echo-staging-connector-rehearsal-profile-v2',
  capture_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V2,
  jira: { cloud_id: '11111111-1111-4111-8111-111111111111', integration_key: 'jira-test', project: 'TEST' },
  slack: { channel_id: 'C01234567' },
};
const release_id = 'clean-v1-connector-test';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function prepared() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'echo-staging-profile-'));
  roots.push(root);
  mkdirSync(join(root, 'private'), { mode: 0o700 });
  const path = join(root, 'private', 'staging-connector-rehearsal.json');
  writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
  return { path, input: { state_directory: join(root, 'state'), authority_url: 'https://authority-staging.echobrain.org',
    environment: { ECHO_STAGING_CONNECTOR_REHEARSAL_PROFILE_FILE: path, ECHO_CLEAN_AUTHORITY_HOST: 'authority-staging.echobrain.org', ECHO_CLEAN_RELEASE_ID: release_id } } };
}

describe('staging rehearsal opt-in selection', () => {
  it('leaves ordinary profiles disabled without reading any file', () => {
    expect(readStagingConnectorRehearsalSelection({ state_directory: '/missing', authority_url: 'https://authority.echobrain.org', environment: {} })).toBeUndefined();
  });
  it('reads the private profile only for the fixed staging identity', () => {
    const { input } = prepared();
    expect(readStagingConnectorRehearsalSelection(input)).toEqual({ profile, release_id, authority_host: 'authority-staging.echobrain.org' });
    expect(() => readStagingConnectorRehearsalSelection({ ...input, authority_url: 'https://authority.echobrain.org' })).toThrow();
    expect(() => readStagingConnectorRehearsalSelection({ ...input, environment: { ...input.environment, ECHO_CLEAN_AUTHORITY_HOST: 'authority.echobrain.org' } })).toThrow();
    expect(() => readStagingConnectorRehearsalSelection({ ...input, environment: { ...input.environment, ECHO_CLEAN_RELEASE_ID: '' } })).toThrow();
  });
  it('rejects loose permissions, alternate paths, symlinks and oversized profiles', () => {
    const { path, input } = prepared();
    chmodSync(path, 0o644);
    expect(() => readStagingConnectorRehearsalSelection(input)).toThrow();
    chmodSync(path, 0o600);
    const alias = join(input.state_directory, '..', 'profile-alias.json');
    symlinkSync(path, alias);
    expect(() => readStagingConnectorRehearsalSelection({ ...input, environment: { ...input.environment, ECHO_STAGING_CONNECTOR_REHEARSAL_PROFILE_FILE: alias } })).toThrow();
    rmSync(alias);
    rmSync(path);
    const target = join(input.state_directory, '..', 'target.json');
    writeFileSync(target, JSON.stringify(profile), { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => readStagingConnectorRehearsalSelection(input)).toThrow();
    rmSync(path);
    writeFileSync(path, ' '.repeat(8193), { mode: 0o600 });
    expect(() => readStagingConnectorRehearsalSelection(input)).toThrow();
  });
});
