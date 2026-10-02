import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { requireStagingConnectorV1PredecessorV2 } from '../src/composition/staging-connector-rehearsal-runtime.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'staging-predecessor-')); roots.push(root);
  const state_directory = join(root, 'state');
  const sidecar = join(root, 'staging-connector-rehearsal-v1');
  for (const path of [state_directory, sidecar, join(root, 'private')]) mkdirSync(path, { mode: 0o700 });
  const predecessor = { schema_version: 1, kind: 'echo-staging-connector-rehearsal-profile-v1',
    capture_policy: 'initial-owner-granola-retained-jira-request-only-v1',
    jira: { cloud_id: '00000000-0000-4000-8000-000000000001', integration_key: 'jira', project: 'ORIGINAL' } };
  const profile = { schema_version: 2 as const, kind: 'echo-staging-connector-rehearsal-profile-v2' as const,
    capture_policy: 'initial-owner-granola-retained-jira-pointer-slack-pointer-v2' as const,
    predecessor_profile_sha256: canonicalSha256(predecessor), jira: { ...predecessor.jira, project: 'TEST' },
    slack: { channel_id: 'CTEST123' } };
  const input = { state_directory, profile, authority_id: 'authority-fixture', state_lineage_id: 'lineage-fixture',
    organization_id: 'organization-fixture', principal_id: 'principal-fixture', membership_id: 'membership-fixture' };
  const marker = { schema_version: 1, kind: 'echo-staging-connector-rehearsal-sidecar-binding-v1',
    authority_id: input.authority_id, state_lineage_id: input.state_lineage_id, organization_id: input.organization_id,
    principal_id: input.principal_id, membership_id: input.membership_id, profile_sha256: profile.predecessor_profile_sha256 };
  const files = [join(root, 'private', 'staging-connector-rehearsal.json'), join(sidecar, 'binding.json'), join(sidecar, 'jira-person-connections.sqlite')];
  for (const [index, contents] of [canonicalJson(predecessor), canonicalJson(marker), 'unchanged-sidecar-database-sentinel'].entries()) {
    writeFileSync(files[index]!, `${contents}\n`, { mode: 0o600 });
  }
  return { input, files, marker, snapshots: files.map(path => readFileSync(path)), sidecar };
}

it('anchors a changed project to the untouched V1 owner, tenant and connection files', () => {
  const { input, files, snapshots } = fixture();
  expect(() => requireStagingConnectorV1PredecessorV2(input)).not.toThrow();
  expect(files.map(path => readFileSync(path))).toEqual(snapshots);
});

it('refuses a different predecessor, Jira tenant/integration, lineage or initial owner before sidecar mutation', () => {
  const { input, files, snapshots } = fixture();
  for (const changed of [
    { ...input, profile: { ...input.profile, predecessor_profile_sha256: canonicalSha256('wrong') } },
    ...['cloud_id', 'integration_key'].map(key => ({ ...input, profile: { ...input.profile, jira: { ...input.profile.jira, [key]: key === 'cloud_id' ? '00000000-0000-4000-8000-000000000002' : 'different-jira' } } })),
    ...['authority_id', 'state_lineage_id', 'organization_id', 'principal_id', 'membership_id'].map(key => ({ ...input, [key]: 'different' })),
  ]) {
    expect(() => requireStagingConnectorV1PredecessorV2(changed)).toThrow();
    expect(files.map(path => readFileSync(path))).toEqual(snapshots);
  }
});

it('refuses absent or unsafe predecessor files and never creates a replacement sidecar', () => {
  for (const missing of [0, 1, 2]) {
    const { input, files } = fixture();
    rmSync(files[missing]!);
    expect(() => requireStagingConnectorV1PredecessorV2(input)).toThrow();
    expect(() => readFileSync(files[missing]!)).toThrow();
  }
  const { input, files, sidecar } = fixture();
  chmodSync(files[0]!, 0o644);
  expect(() => requireStagingConnectorV1PredecessorV2(input)).toThrow();
  chmodSync(files[0]!, 0o600);
  const aliasTarget = `${sidecar}-alias-target`;
  mkdirSync(aliasTarget);
  rmSync(sidecar, { recursive: true });
  symlinkSync(aliasTarget, sidecar);
  expect(() => requireStagingConnectorV1PredecessorV2(input)).toThrow();
});
