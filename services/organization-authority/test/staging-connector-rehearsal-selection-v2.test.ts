import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { readStagingConnectorRehearsalSelection } from '../src/composition/staging-connector-rehearsal-selection.js';
import { STAGING_CONNECTOR_REHEARSAL_POLICY_V2 } from '../src/composition/staging-connector-rehearsal-protocol-v2.js';

const predecessor = canonicalSha256({ schema_version: 1, kind: 'echo-staging-connector-rehearsal-profile-v1' });
const profile = Object.freeze({ schema_version: 2 as const, kind: 'echo-staging-connector-rehearsal-profile-v2' as const,
  capture_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V2, predecessor_profile_sha256: predecessor,
  jira: { cloud_id: '11111111-1111-4111-8111-111111111111', integration_key: 'jira', project: 'KAN' }, slack: { channel_id: 'C01234567' } });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('staging connector V2 selection', () => {
  it('accepts only the fixed V2 profile filename at the staging origin', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'echo-staging-profile-v2-')); roots.push(root);
    const state = join(root, 'state'); const privateDirectory = join(root, 'private'); mkdirSync(state); mkdirSync(privateDirectory, { mode: 0o700 });
    const path = join(privateDirectory, 'staging-connector-rehearsal-v2.json'); writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
    const input = { state_directory: state, authority_url: 'https://authority-staging.echobrain.org', environment: {
      ECHO_STAGING_CONNECTOR_REHEARSAL_PROFILE_FILE: path, ECHO_CLEAN_RELEASE_ID: 'clean-v1-connector-test', ECHO_CLEAN_AUTHORITY_HOST: 'authority-staging.echobrain.org',
    } };
    expect(readStagingConnectorRehearsalSelection(input)).toEqual({ profile, release_id: 'clean-v1-connector-test', authority_host: 'authority-staging.echobrain.org' });
    chmodSync(path, 0o644);
    expect(() => readStagingConnectorRehearsalSelection(input)).toThrow();
  });
});
