import { afterEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createPublicKey, verify } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeClientUpdateSigner, signClientUpdateFeed } from '../../tools/client-update-sign.mjs';
import { updateDigest } from '../../src/product/person-client/client-update-contract.js';

const REPO = resolve(import.meta.dirname, '../..');
const roots: string[] = [];
function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function save(path: string, value: unknown) { writeFileSync(path, `${canonical(value)}\n`, { mode: 0o600 }); }
function temporary() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'echo-update-sign-test-'));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
function fixture() {
  const root = temporary();
  const signer = join(root, 'signer');
  const metadata = initializeClientUpdateSigner({ directory: signer });
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  mkdirSync(join(root, 'package/dist'), { recursive: true, mode: 0o700 });
  save(join(root, 'package/dist/build-identity.v1.json'), { schema_version: 1, kind: 'echo-packaged-build-identity', product_version: '0.1.1', source_sha: sourceSha, source_kind: 'materialized-commit' });
  writeFileSync(join(root, 'package/dist/client-update-cli.js'), '/* synthetic updater */');
  const client = join(root, 'person-client.tgz');
  execFileSync('tar', ['-czf', client, 'package'], { cwd: root });
  const clientHash = updateDigest(readFileSync(client));
  const release = { schema_version: 1, kind: 'echo-clean-v1-release', release_id: 'clean-v1-sign-fixture', source_sha: sourceSha, released_at: '2026-09-24T00:00:00Z', baseline_compatibility_class: 'clean-v1', authority_image: { reference: `registry.example.test/authority@sha256:${'a'.repeat(64)}` }, person_client: { artifact_sha256: clientHash, artifact_url: 'https://fixture.invalid/client.tgz', package: '@echo-brain/person-client', version: '0.1.1' }, runtime_profile: { artifact_sha256: 'b'.repeat(64), artifact_url: 'https://fixture.invalid/profile.json', profile_version: 'clean-v1-profile-1' } };
  const releasePath = join(root, 'release.json');
  save(releasePath, release);
  const kit = join(root, 'echo-person-onboarding-kit');
  mkdirSync(kit, { mode: 0o700 });
  for (const [file, source] of [['Start-ECHO.sh', 'deploy/release/start-person-cli-kit-macos.sh'], ['clean-v1-release.mjs', 'tools/clean-v1-release.mjs'], ['verify-person-onboarding-kit.mjs', 'deploy/release/verify-person-onboarding-kit.mjs']]) {
    writeFileSync(join(kit, file), execFileSync('git', ['show', `${sourceSha}:${source}`], { cwd: REPO }), { mode: 0o600 });
  }
  writeFileSync(join(kit, 'release.json'), readFileSync(releasePath), { mode: 0o600 });
  writeFileSync(join(kit, 'person-client.tgz'), readFileSync(client), { mode: 0o600 });
  save(join(kit, 'build-identity.v1.json'), { schema_version: 1, kind: 'echo-person-onboarding-kit-identity-v1', product_version: '0.1.1', source_sha: sourceSha, platform: 'darwin', architecture: 'arm64', release_id: release.release_id });
  writeFileSync(join(kit, 'node'), 'synthetic macOS runtime', { mode: 0o600 });
  const digest = (file: string) => updateDigest(readFileSync(join(kit, file)));
  save(join(kit, 'kit-manifest.v1.json'), { schema_version: 3, kind: 'echo-person-cli-kit-v1', release_id: release.release_id, source_sha: sourceSha, release_record_sha256: digest('release.json'), person_client_artifact_sha256: clientHash, build_identity_sha256: digest('build-identity.v1.json'), runtime: { platform: 'darwin', architecture: 'arm64', version: 'v22.22.1', node_sha256: digest('node') } });
  const archive = join(root, 'macos.zip');
  execFileSync('zip', ['-qr', archive, 'echo-person-onboarding-kit'], { cwd: root });
  const configPath = join(root, 'config.json');
  const config = { schema_version: 1, kind: 'echo-client-update-config-v1', channel: 'fixture', feed_url: 'https://fixture.invalid/feed.json', public_key_spki: metadata.public_key_spki, minimum_sequence: 1, automatic: true, installation: 'cli-kit' };
  save(configPath, config);
  const prepared = join(root, 'prepared');
  const prepare = spawnSync(process.execPath, [join(REPO, 'tools/client-update-feed.mjs'), 'prepare', '--config', configPath, '--release', releasePath, '--macos-kit', archive, '--sequence', '1', '--expires', new Date(Date.now() + 86_400_000).toISOString(), '--out', prepared], { cwd: REPO, encoding: 'utf8' });
  expect(prepare.status, prepare.stderr).toBe(0);
  const authorizationPath = join(root, 'authorization.json');
  const authorization = { kind: 'echo-staging-release-founder-authorization-v1', release_sha256: updateDigest(readFileSync(releasePath)), person_client_sha256: clientHash, slack_approved: true, person_records_passed: true, person_ask_passed: true, release_authorized: true };
  save(authorizationPath, authorization);
  const signaturePath = join(root, 'manifest.sig');
  const payload = readFileSync(join(prepared, 'manifest.json'));
  const options = { directory: signer, prepared, authorizationPath, signaturePath, approveManifest: updateDigest(payload) };
  return { root, signer, metadata, prepared, config, authorization, authorizationPath, signaturePath, payload, options };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

describe('local approved release signer', () => {
  it('creates one private identity and reports only its public identity', () => {
    const root = temporary();
    const directory = join(root, 'signer');
    const result = spawnSync(process.execPath, [join(REPO, 'tools/client-update-sign.mjs'), 'init', '--directory', directory], { cwd: REPO, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(Object.keys(summary).sort()).toEqual(['kind', 'public_key_sha256', 'public_key_spki', 'schema_version', 'status']);
    expect(summary.public_key_sha256).toBe(updateDigest(Buffer.from(summary.public_key_spki, 'base64')));
    expect(result.stderr).toBe('');
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(directory, 'private-key.pkcs8.der')).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(directory, 'signer.json')).mode & 0o777).toBe(0o600);
    const before = lstatSync(join(directory, 'private-key.pkcs8.der'));
    expect(() => initializeClientUpdateSigner({ directory })).toThrow();
    expect(lstatSync(join(directory, 'private-key.pkcs8.der')).ino).toBe(before.ino);
  });

  it('previews without writing and signs the exact approved bytes including newline', () => {
    const f = fixture();
    expect(signClientUpdateFeed({ ...f.options, approveManifest: undefined }).status).toBe('ready_to_sign');
    expect(existsSync(f.signaturePath)).toBe(false);
    expect(f.payload.at(-1)).toBe(10);
    const result = signClientUpdateFeed(f.options);
    const signature = readFileSync(f.signaturePath);
    expect(result.status).toBe('signed');
    expect(result.signature_sha256).toBe(updateDigest(signature));
    expect(signature.length).toBe(64);
    expect(lstatSync(f.signaturePath).mode & 0o777).toBe(0o600);
    const publicKey = createPublicKey({ key: Buffer.from(f.metadata.public_key_spki, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, f.payload, publicKey, signature)).toBe(true);
    expect(verify(null, f.payload.subarray(0, -1), publicKey, signature)).toBe(false);
    expect(() => signClientUpdateFeed(f.options)).toThrow('signature_already_exists');
  });

  it.each(['slack_approved', 'person_records_passed', 'person_ask_passed', 'release_authorized'] as const)('refuses without existing %s authorization', (field) => {
    const f = fixture();
    save(f.authorizationPath, { ...f.authorization, [field]: false });
    expect(() => signClientUpdateFeed(f.options)).toThrow();
    expect(existsSync(f.signaturePath)).toBe(false);
  });

  it.each(['digest', 'manifest', 'artifact', 'release', 'expired', 'pin', 'metadata'] as const)('refuses changed %s inputs', (change) => {
    const f = fixture();
    const manifestPath = join(f.prepared, 'manifest.json');
    const manifest = JSON.parse(f.payload.toString('utf8'));
    if (change === 'digest') f.options.approveManifest = '0'.repeat(64);
    if (change === 'manifest') writeFileSync(manifestPath, f.payload.subarray(0, -1));
    if (change === 'artifact') writeFileSync(join(f.prepared, 'artifacts', `${manifest.artifacts[0].sha256}.zip`), 'tampered');
    if (change === 'release') { manifest.source_sha = 'c'.repeat(40); save(manifestPath, manifest); f.options.approveManifest = updateDigest(readFileSync(manifestPath)); }
    if (change === 'expired') { manifest.issued_at = '2020-01-01T00:00:00.000Z'; manifest.expires_at = '2020-01-02T00:00:00.000Z'; save(manifestPath, manifest); f.options.approveManifest = updateDigest(readFileSync(manifestPath)); }
    if (change === 'pin') { const other = initializeClientUpdateSigner({ directory: join(f.root, 'other-signer') }); save(join(f.prepared, 'bootstrap-config.json'), { ...f.config, public_key_spki: other.public_key_spki }); }
    if (change === 'metadata') save(join(f.signer, 'signer.json'), { ...f.metadata, public_key_sha256: '0'.repeat(64) });
    expect(() => signClientUpdateFeed(f.options)).toThrow();
    expect(existsSync(f.signaturePath)).toBe(false);
  });

  it.each(['file-mode', 'directory-mode', 'hardlink', 'symlink', 'ancestor-symlink'] as const)('refuses unsafe signer %s', (change) => {
    const f = fixture();
    const key = join(f.signer, 'private-key.pkcs8.der');
    if (change === 'file-mode') chmodSync(key, 0o644);
    if (change === 'directory-mode') chmodSync(f.signer, 0o755);
    if (change === 'hardlink') linkSync(key, join(f.root, 'linked-key'));
    if (change === 'symlink') { const original = join(f.signer, 'signer.json'); rmSync(original); symlinkSync(f.authorizationPath, original); }
    if (change === 'ancestor-symlink') { const alias = join(f.root, 'alias'); symlinkSync(f.signer, alias); f.options.directory = alias; }
    expect(() => signClientUpdateFeed(f.options)).toThrow();
    expect(existsSync(f.signaturePath)).toBe(false);
  });

  it('refuses initialization inside a checkout, through aliases, or beneath a public parent', () => {
    const root = temporary();
    const checkout = join(root, 'checkout');
    mkdirSync(checkout, { mode: 0o700 });
    writeFileSync(join(checkout, '.git'), 'gitdir: fixture');
    expect(() => initializeClientUpdateSigner({ directory: join(checkout, 'signer') })).toThrow('signer_outside_checkout_required');
    const alias = join(root, 'alias');
    symlinkSync(checkout, alias);
    expect(() => initializeClientUpdateSigner({ directory: join(alias, 'signer') })).toThrow('real_directory_required');
    chmodSync(checkout, 0o755);
    expect(() => initializeClientUpdateSigner({ directory: join(checkout, 'signer') })).toThrow('private_directory_required');
  });
});
