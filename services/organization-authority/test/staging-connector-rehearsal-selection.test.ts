import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStagingConnectorRehearsalSelection } from '../src/composition/staging-connector-rehearsal-selection.js';

const profile = {
  schema_version: 3,
  kind: 'echo-staging-connector-rehearsal-profile-v3',
  read_policy: 'initial-owner-jira-pointer-v3',
  jira: { cloud_id: '11111111-1111-4111-8111-111111111111', integration_key: 'jira-test', project: 'TEST' },
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

describe('staging connector profile selection', () => {
  it('leaves ordinary profiles disabled without reading any file', () => {
    expect(readStagingConnectorRehearsalSelection({ state_directory: '/missing', authority_url: 'https://authority.echobrain.org', environment: {} })).toBeUndefined();
  });
  it('reads the private profile only for the fixed staging identity', () => {
    const { input } = prepared();
    expect(readStagingConnectorRehearsalSelection(input)).toEqual(profile);
    expect(() => readStagingConnectorRehearsalSelection({ ...input, authority_url: 'https://authority.echobrain.org' })).toThrow();
    expect(() => readStagingConnectorRehearsalSelection({ ...input, environment: { ...input.environment, ECHO_CLEAN_AUTHORITY_HOST: 'authority.echobrain.org' } })).toThrow();
    expect(() => readStagingConnectorRehearsalSelection({ ...input, environment: { ...input.environment, ECHO_CLEAN_RELEASE_ID: '' } })).toThrow();
  });
  it('rejects retired profile versions and fields', () => {
    const { path, input } = prepared();
    for (const invalid of [
      { ...profile, schema_version: 2 },
      { ...profile, read_policy: 'retain-everything' },
      { ...profile, capture_policy: 'retain-everything' },
      { ...profile, predecessor_profile_sha256: `sha256:${'0'.repeat(64)}` },
      { ...profile, jira: { ...profile.jira, cloud_id: 'not-a-cloud-id' } },
      { ...profile, jira: { ...profile.jira, project: 'KAN OR project=PRIVATE' } },
      { ...profile, slack: { channel_id: 'G01234567' } },
      { ...profile, slack: { channel_id: 'C01234567', token: 'must-not-enter-profile' } },
    ]) {
      writeFileSync(path, JSON.stringify(invalid), { mode: 0o600 });
      expect(() => readStagingConnectorRehearsalSelection(input)).toThrow('Staging connector rehearsal value is invalid');
    }
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
