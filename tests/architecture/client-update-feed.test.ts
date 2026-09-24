import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { updateDigest } from '../../src/product/person-client/client-update-contract.js';

const REPO = resolve(import.meta.dirname, '../..');
const roots: string[] = [];
function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'echo-feed-test-'));
  roots.push(root);
  const kit = join(root, 'echo-person-onboarding-kit');
  mkdirSync(kit, { mode: 0o700 });
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  for (const [file, source] of [['Start-ECHO.sh', 'deploy/release/start-person-onboarding-kit-linux.sh'], ['clean-v1-release.mjs', 'tools/clean-v1-release.mjs'], ['verify-person-onboarding-kit.mjs', 'deploy/release/verify-person-onboarding-kit.mjs']]) {
    writeFileSync(join(kit, file), execFileSync('git', ['show', `${sourceSha}:${source}`], { cwd: REPO }), { mode: 0o600 });
  }
  const identity = { schema_version: 1, kind: 'echo-packaged-build-identity', product_version: '0.1.1', source_sha: sourceSha, source_kind: 'materialized-commit' };
  mkdirSync(join(root, 'package/dist'), { recursive: true });
  writeFileSync(join(root, 'package/dist/build-identity.v1.json'), JSON.stringify(identity));
  writeFileSync(join(root, 'package/dist/client-update-cli.js'), '/* synthetic capability */');
  execFileSync('tar', ['-czf', join(kit, 'person-client.tgz'), 'package'], { cwd: root });
  const clientHash = updateDigest(readFileSync(join(kit, 'person-client.tgz')));
  const release = { schema_version: 1, kind: 'echo-clean-v1-release', release_id: 'clean-v1-update-fixture', source_sha: sourceSha, released_at: '2026-09-24T00:00:00Z', baseline_compatibility_class: 'clean-v1', authority_image: { reference: `registry.example.test/authority@sha256:${'a'.repeat(64)}` }, person_client: { artifact_sha256: clientHash, artifact_url: 'https://fixture.invalid/client.tgz', package: '@echo-brain/person-client', version: '0.1.1' }, runtime_profile: { artifact_sha256: 'b'.repeat(64), artifact_url: 'https://fixture.invalid/profile.json', profile_version: 'clean-v1-profile-1' } };
  writeFileSync(join(kit, 'release.json'), canonical(release) + '\n');
  writeFileSync(join(kit, 'build-identity.v1.json'), JSON.stringify({ ...identity, platform: 'linux', architecture: 'x64', release_id: release.release_id }));
  writeFileSync(join(kit, 'node'), 'synthetic runtime bytes');
  const digest = (name: string) => updateDigest(readFileSync(join(kit, name)));
  writeFileSync(join(kit, 'kit-manifest.v1.json'), JSON.stringify({ schema_version: 2, kind: 'echo-person-onboarding-kit-v2', release_id: release.release_id, source_sha: sourceSha, release_record_sha256: digest('release.json'), person_client_artifact_sha256: clientHash, build_identity_sha256: digest('build-identity.v1.json'), runtime: { platform: 'linux', architecture: 'x64', version: 'v22.22.1', node_sha256: digest('node') } }));
  const zip = join(root, 'kit.zip');
  const zipKit = () => { rmSync(zip, { force: true }); execFileSync('zip', ['-qr', zip, 'echo-person-onboarding-kit'], { cwd: root }); };
  zipKit();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config = { schema_version: 1, kind: 'echo-client-update-config-v1', channel: 'fixture', feed_url: 'https://fixture.invalid/feed.json', public_key_spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), minimum_sequence: 1, automatic: true, installation: 'cli-kit' };
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const output = join(root, 'prepared');
  const run = (args: string[]) => spawnSync(process.execPath, [join(REPO, 'tools/client-update-feed.mjs'), ...args], { cwd: REPO, encoding: 'utf8' });
  const prepare = () => run(['prepare', '--config', configPath, '--release', join(kit, 'release.json'), '--linux-kit', zip, '--sequence', '1', '--expires', new Date(Date.now() + 86400000).toISOString(), '--out', output]);
  const signaturePath = join(root, 'manifest.sig');
  const approvalPath = join(root, 'approval.json');
  const authorize = (authorized = true) => {
    writeFileSync(signaturePath, sign(null, readFileSync(join(output, 'manifest.json')), privateKey));
    writeFileSync(approvalPath, JSON.stringify({ kind: 'echo-staging-release-founder-authorization-v1', release_sha256: digest('release.json'), person_client_sha256: clientHash, slack_approved: true, person_records_passed: true, person_ask_passed: true, release_authorized: authorized }));
  };
  const seal = () => run(['seal', '--prepared', output, '--signature', signaturePath, '--authorization', approvalPath]);
  return { root, kit, output, prepare, authorize, seal, zipKit, signaturePath };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('approved update feed publisher', () => {
  it('prepares unsigned bytes, then seals only with the matching signature and exact release authorization', () => {
    const f = fixture();
    const prepared = f.prepare();
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(existsSync(join(f.output, 'feed.json'))).toBe(false);
    f.authorize();
    const sealed = f.seal();
    expect(sealed.status, sealed.stderr).toBe(0);
    const envelope = JSON.parse(readFileSync(join(f.output, 'feed.json'), 'utf8'));
    expect(Buffer.from(envelope.payload, 'base64')).toEqual(readFileSync(join(f.output, 'manifest.json')));
    expect(f.seal().status).toBe(1);
  });

  it.each(['authorization', 'signature', 'manifest', 'artifact'])('refuses %s changes before publishing a feed', (change) => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    f.authorize(change !== 'authorization');
    if (change === 'signature') writeFileSync(f.signaturePath, Buffer.alloc(64));
    if (change === 'manifest') {
      const file = join(f.output, 'manifest.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.sequence = 2;
      writeFileSync(file, canonical(manifest) + '\n');
    }
    if (change === 'artifact') {
      const manifest = JSON.parse(readFileSync(join(f.output, 'manifest.json'), 'utf8'));
      writeFileSync(join(f.output, 'artifacts', manifest.artifacts[0].sha256 + '.zip'), 'altered');
    }
    expect(f.seal().status).toBe(1);
    expect(existsSync(join(f.output, 'feed.json'))).toBe(false);
  });

  it('rejects unreviewed installer bytes and unexpected archive members', () => {
    const changed = fixture();
    writeFileSync(join(changed.kit, 'Start-ECHO.sh'), 'unreviewed source');
    changed.zipKit();
    expect(changed.prepare().status).toBe(1);
    expect(existsSync(changed.output)).toBe(false);
    const extra = fixture();
    writeFileSync(join(extra.kit, 'unexpected'), 'not in the kit contract');
    extra.zipKit();
    expect(extra.prepare().status).toBe(1);
  });
});
