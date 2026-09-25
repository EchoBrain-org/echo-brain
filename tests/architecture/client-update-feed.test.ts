import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { updateDigest } from '../../src/product/person-client/client-update-contract.js';
import { canonicalJsonForTest as canonical } from '../support/test-canonical-json.js';

const REPO = resolve(import.meta.dirname, '../..');
const roots: string[] = [];
type Target = 'linux' | 'macos';
const TARGET = {
  linux: { platform: 'linux', architecture: 'x64', libc: 'glibc', schema_version: 2, kind: 'echo-person-onboarding-kit-v2', startSource: 'deploy/release/start-person-onboarding-kit-linux.sh' },
  macos: { platform: 'darwin', architecture: 'arm64', libc: null, schema_version: 3, kind: 'echo-person-cli-kit-v1', startSource: 'deploy/release/start-person-cli-kit-macos.sh' },
} as const;

function fixture(targets: Target[] = ['linux']) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'echo-feed-test-'));
  roots.push(root);
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const clientIdentity = { schema_version: 1, kind: 'echo-packaged-build-identity', product_version: '0.1.1', source_sha: sourceSha, source_kind: 'materialized-commit' };
  mkdirSync(join(root, 'package/dist'), { recursive: true });
  writeFileSync(join(root, 'package/dist/build-identity.v1.json'), JSON.stringify(clientIdentity));
  writeFileSync(join(root, 'package/dist/client-update-cli.js'), '/* synthetic capability */');
  const clientArchive = join(root, 'person-client.tgz');
  execFileSync('tar', ['-czf', clientArchive, 'package'], { cwd: root });
  const clientHash = updateDigest(readFileSync(clientArchive));
  const release = { schema_version: 1, kind: 'echo-clean-v1-release', release_id: 'clean-v1-update-fixture', source_sha: sourceSha, released_at: '2026-09-24T00:00:00Z', baseline_compatibility_class: 'clean-v1', authority_image: { reference: `registry.example.test/authority@sha256:${'a'.repeat(64)}` }, person_client: { artifact_sha256: clientHash, artifact_url: 'https://fixture.invalid/client.tgz', package: '@echo-brain/person-client', version: '0.1.1' }, runtime_profile: { artifact_sha256: 'b'.repeat(64), artifact_url: 'https://fixture.invalid/profile.json', profile_version: 'clean-v1-profile-1' } };
  const releasePath = join(root, 'release.json');
  writeFileSync(releasePath, canonical(release) + '\n');
  const kits = {} as Record<Target, { directory: string; zip: string; zipKit: () => void }>;
  for (const targetName of targets) {
    const target = TARGET[targetName];
    const kit = join(root, targetName, 'echo-person-onboarding-kit');
    mkdirSync(kit, { recursive: true, mode: 0o700 });
    for (const [file, source] of [['Start-ECHO.sh', target.startSource], ['clean-v1-release.mjs', 'tools/clean-v1-release.mjs'], ['verify-person-onboarding-kit.mjs', 'deploy/release/verify-person-onboarding-kit.mjs']]) {
      writeFileSync(join(kit, file), execFileSync('git', ['show', `${sourceSha}:${source}`], { cwd: REPO }), { mode: 0o600 });
    }
    writeFileSync(join(kit, 'release.json'), canonical(release) + '\n');
    writeFileSync(join(kit, 'person-client.tgz'), readFileSync(clientArchive));
    writeFileSync(join(kit, 'build-identity.v1.json'), JSON.stringify({ schema_version: 1, kind: 'echo-person-onboarding-kit-identity-v1', product_version: release.person_client.version, source_sha: sourceSha, platform: target.platform, architecture: target.architecture, release_id: release.release_id }));
    writeFileSync(join(kit, 'node'), `synthetic ${targetName} runtime bytes`);
    const digest = (name: string) => updateDigest(readFileSync(join(kit, name)));
    writeFileSync(join(kit, 'kit-manifest.v1.json'), JSON.stringify({ schema_version: target.schema_version, kind: target.kind, release_id: release.release_id, source_sha: sourceSha, release_record_sha256: digest('release.json'), person_client_artifact_sha256: clientHash, build_identity_sha256: digest('build-identity.v1.json'), runtime: { platform: target.platform, architecture: target.architecture, version: 'v22.22.1', node_sha256: digest('node') } }));
    const zip = join(root, `${targetName}-kit.zip`);
    const zipKit = () => { rmSync(zip, { force: true }); execFileSync('zip', ['-qr', zip, 'echo-person-onboarding-kit'], { cwd: join(root, targetName) }); };
    zipKit();
    kits[targetName] = { directory: kit, zip, zipKit };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config = { schema_version: 1, kind: 'echo-client-update-config-v1', channel: 'fixture', feed_url: 'https://fixture.invalid/feed.json', public_key_spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), minimum_sequence: 1, automatic: true, installation: 'cli-kit' };
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const output = join(root, 'prepared');
  const run = (args: string[]) => spawnSync(process.execPath, [join(REPO, 'tools/client-update-feed.mjs'), ...args], { cwd: REPO, encoding: 'utf8' });
  const prepare = () => run(['prepare', '--config', configPath, '--release', releasePath, ...targets.flatMap(target => [target === 'linux' ? '--linux-kit' : '--macos-kit', kits[target].zip]), '--sequence', '1', '--expires', new Date(Date.now() + 86400000).toISOString(), '--out', output]);
  const signaturePath = join(root, 'manifest.sig');
  const approvalPath = join(root, 'approval.json');
  const authorize = (authorized = true) => {
    writeFileSync(signaturePath, sign(null, readFileSync(join(output, 'manifest.json')), privateKey));
    writeFileSync(approvalPath, JSON.stringify({ kind: 'echo-staging-release-founder-authorization-v1', release_sha256: updateDigest(readFileSync(releasePath)), person_client_sha256: clientHash, slack_approved: true, person_records_passed: true, person_ask_passed: true, release_authorized: authorized }));
  };
  const seal = () => run(['seal', '--prepared', output, '--signature', signaturePath, '--authorization', approvalPath]);
  const validateSealed = (now = Date.now(), allowExpired = false) => spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { validateSealedClientUpdateFeed } from "./tools/client-update-feed.mjs"; validateSealedClientUpdateFeed({prepared: process.argv[1], authorizationPath: process.argv[2], now: Number(process.argv[3]), allowExpired: process.argv[4] === "true"});', output, approvalPath, String(now), String(allowExpired)], { cwd: REPO, encoding: 'utf8' });
  return { root, kits, output, prepare, authorize, seal, signaturePath, approvalPath, validateSealed };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('approved update feed publisher', () => {
  it.each([[['linux'] as Target[]], [['macos'] as Target[]]])('prepares a %s-only CLI feed', (targets) => {
    const f = fixture(targets);
    expect(f.prepare().status).toBe(0);
    expect(JSON.parse(readFileSync(join(f.output, 'manifest.json'), 'utf8')).artifacts).toHaveLength(1);
    f.authorize();
    expect(f.seal().status).toBe(0);
  });

  it('prepares one signed feed with both exact supported CLI targets', () => {
    const f = fixture(['linux', 'macos']);
    const prepared = f.prepare();
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(existsSync(join(f.output, 'feed.json'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(f.output, 'manifest.json'), 'utf8'));
    expect(manifest.artifacts.map((artifact: any) => [artifact.platform, artifact.architecture, artifact.libc, artifact.installation])).toEqual([['linux', 'x64', 'glibc', 'cli-kit'], ['darwin', 'arm64', null, 'cli-kit']]);
    f.authorize();
    expect(f.seal().status).toBe(0);
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

  it('rejects a valid signed envelope that differs from the prepared manifest', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    f.authorize();
    expect(f.seal().status).toBe(0);
    expect(f.validateSealed().status).toBe(0);
    const file = join(f.output, 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.sequence = 2;
    writeFileSync(file, canonical(manifest) + '\n');
    const result = f.validateSealed();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('prepared_manifest_mismatch');
  });

  it('audits expired signed feeds at their last valid instant, while retaining every other metadata check', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    f.authorize();
    expect(f.seal().status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(f.output, 'manifest.json'), 'utf8'));
    const afterExpiry = Date.parse(manifest.expires_at) + 1;
    expect(f.validateSealed(afterExpiry).status).toBe(1);
    expect(f.validateSealed(afterExpiry, true).status).toBe(0);
    const feed = JSON.parse(readFileSync(join(f.output, 'feed.json'), 'utf8'));
    feed.signature = Buffer.alloc(64).toString('base64');
    writeFileSync(join(f.output, 'feed.json'), JSON.stringify(feed));
    expect(f.validateSealed(afterExpiry, true).status).toBe(1);
  });

  it('refuses an audit of a signed feed issued more than five minutes in the future', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const manifestPath = join(f.output, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const now = Date.now();
    manifest.issued_at = new Date(now + 6 * 60 * 1000).toISOString();
    manifest.expires_at = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(manifestPath, canonical(manifest) + '\n');
    f.authorize();
    const envelope = { payload: readFileSync(manifestPath).toString('base64'), signature: readFileSync(f.signaturePath).toString('base64') };
    writeFileSync(join(f.output, 'feed.json'), JSON.stringify(envelope));
    expect(f.validateSealed(now, true).status).toBe(1);
  });

  it('rejects altered release metadata before accepting a valid signature', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const file = join(f.output, 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.product_version = '0.1.2';
    writeFileSync(file, canonical(manifest) + '\n');
    f.authorize();
    const result = f.seal();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verify the inputs, signature, and exact release authorization');
    expect(existsSync(join(f.output, 'feed.json'))).toBe(false);
  });

  it('refuses a macOS kit whose runtime claims Linux, or the legacy desktop-kit shape', () => {
    const mismatched = fixture(['macos']);
    const manifest = join(mismatched.kits.macos.directory, 'kit-manifest.v1.json');
    const value = JSON.parse(readFileSync(manifest, 'utf8'));
    value.runtime.platform = 'linux';
    writeFileSync(manifest, JSON.stringify(value));
    mismatched.kits.macos.zipKit();
    expect(mismatched.prepare().status).toBe(1);
    const legacy = fixture(['macos']);
    const legacyManifest = join(legacy.kits.macos.directory, 'kit-manifest.v1.json');
    const legacyValue = JSON.parse(readFileSync(legacyManifest, 'utf8'));
    legacyValue.schema_version = 1;
    legacyValue.kind = 'echo-person-onboarding-kit-v1';
    writeFileSync(legacyManifest, JSON.stringify(legacyValue));
    legacy.kits.macos.zipKit();
    expect(legacy.prepare().status).toBe(1);
  });

  it('rejects unreviewed installer bytes and unexpected archive members', () => {
    const changed = fixture();
    writeFileSync(join(changed.kits.linux.directory, 'Start-ECHO.sh'), 'unreviewed source');
    changed.kits.linux.zipKit();
    expect(changed.prepare().status).toBe(1);
    expect(existsSync(changed.output)).toBe(false);
    const extra = fixture();
    writeFileSync(join(extra.kits.linux.directory, 'unexpected'), 'not in the kit contract');
    extra.kits.linux.zipKit();
    expect(extra.prepare().status).toBe(1);
  });
});
