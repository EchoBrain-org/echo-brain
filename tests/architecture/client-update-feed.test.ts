import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { updateDigest } from '../../src/product/person-client/client-update-contract.js';
import { cleanReleaseRecord } from '../support/clean-v1-release.js';
import { canonicalJsonForTest as canonical } from '../support/test-canonical-json.js';
import { cliKits, desktopArtifacts, gnuTar, infoPlist, linuxDeb, type CliKitTarget, type DesktopTarget, type LinuxDeb, type TarMember } from '../support/client-update-desktop.js';

const REPO = resolve(import.meta.dirname, '../..');
const roots: string[] = [];
type Artifact = 'linux-kit' | 'macos-kit' | 'macos-app' | 'linux-deb';
const RELEASE_ARTIFACTS: Artifact[] = ['linux-kit', 'macos-kit', 'macos-app', 'linux-deb'];
const RELEASE_TARGETS = [['linux', 'x64', 'glibc', 'cli-kit'], ['darwin', 'arm64', null, 'cli-kit'], ['darwin', 'arm64', null, 'electron'], ['linux', 'x64', 'glibc', 'electron']];
type ManifestArtifact = { platform: string; architecture: string; libc: string | null; installation: string; url: string; sha256: string };
// HEAD and its committed bytes cannot change during the run, so read them once.
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
const committedSources = new Map<string, Buffer>();
function committedSource(path: string): Buffer {
  if (!committedSources.has(path)) committedSources.set(path, execFileSync('git', ['show', `${sourceSha}:${path}`], { cwd: REPO }));
  return committedSources.get(path)!;
}
const canonicalLine = (value: unknown) => canonical(value) + '\n';
function rewriteJson(path: string, mutate: (value: any) => void, serialize: (value: unknown) => string) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, serialize(value));
  return value;
}

function fixture(desktop: Parameters<typeof desktopArtifacts>[1] = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'echo-feed-test-'));
  roots.push(root);
  const clientIdentity = { schema_version: 1, kind: 'echo-packaged-build-identity', product_version: '0.1.1', source_sha: sourceSha, source_kind: 'materialized-commit' };
  mkdirSync(join(root, 'package/dist'), { recursive: true });
  writeFileSync(join(root, 'package/dist/build-identity.v1.json'), JSON.stringify(clientIdentity));
  writeFileSync(join(root, 'package/dist/client-update-cli.js'), '/* synthetic capability */');
  // A path that needs a GNU long-name record in the deb.
  const deep = join(root, 'package/dist', 'nested-module/'.repeat(6));
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'index.js'), '/* synthetic dependency */');
  const clientArchive = join(root, 'person-client.tgz');
  execFileSync('tar', ['-czf', clientArchive, 'package'], { cwd: root });
  const clientHash = updateDigest(readFileSync(clientArchive));
  const release = cleanReleaseRecord({ release_id: 'clean-v1-update-fixture', source_sha: sourceSha, person_client: { version: '0.1.1', artifact_sha256: clientHash } });
  const releasePath = join(root, 'release.json');
  writeFileSync(releasePath, canonical(release) + '\n');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config = { schema_version: 1, kind: 'echo-client-update-config-v1', channel: 'fixture', feed_url: 'https://fixture.invalid/feed.json', public_key_spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), minimum_sequence: 1, automatic: true, installation: 'cli-kit' };
  const inputs = { root, clientArchive, release, releaseSha256: updateDigest(readFileSync(releasePath)), config, committed: committedSource };
  const kits = cliKits(inputs);
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const output = join(root, 'prepared');
  const run = (args: string[]) => spawnSync(process.execPath, [join(REPO, 'tools/client-update-feed.mjs'), ...args], { cwd: REPO, encoding: 'utf8' });
  const desktops = desktopArtifacts(inputs, desktop);
  const paths: Record<Artifact, string> = { 'linux-kit': kits.linux.zip, 'macos-kit': kits.macos.zip, 'macos-app': desktops['macos-app'].path, 'linux-deb': desktops['linux-deb'].path };
  const prepare = (artifacts: Artifact[] = RELEASE_ARTIFACTS) => run(['prepare', '--config', configPath, '--release', releasePath, ...artifacts.flatMap(artifact => [`--${artifact}`, paths[artifact]]), '--sequence', '1', '--expires', new Date(Date.now() + 86400000).toISOString(), '--out', output]);
  const signaturePath = join(root, 'manifest.sig');
  const approvalPath = join(root, 'approval.json');
  const authorize = (authorized = true) => {
    writeFileSync(signaturePath, sign(null, readFileSync(join(output, 'manifest.json')), privateKey));
    writeFileSync(approvalPath, JSON.stringify({ kind: 'echo-staging-release-founder-authorization-v1', release_sha256: updateDigest(readFileSync(releasePath)), person_client_sha256: clientHash, slack_approved: true, person_records_passed: true, person_ask_passed: true, release_authorized: authorized }));
  };
  const seal = () => run(['seal', '--prepared', output, '--signature', signaturePath, '--authorization', approvalPath]);
  const retain = (keep: (artifact: ManifestArtifact) => boolean) => rewriteJson(join(output, 'manifest.json'), manifest => { manifest.artifacts = manifest.artifacts.filter(keep); }, canonicalLine);
  const writeHistoricalEnvelope = () => writeFileSync(join(output, 'feed.json'), canonical({
    payload: readFileSync(join(output, 'manifest.json')).toString('base64'),
    signature: readFileSync(signaturePath).toString('base64'),
  }) + '\n');
  const validateSealed = (now = Date.now(), allowExpired = false) => spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { validateSealedClientUpdateFeed } from "./tools/client-update-feed.mjs"; validateSealedClientUpdateFeed({prepared: process.argv[1], authorizationPath: process.argv[2], now: Number(process.argv[3]), allowExpired: process.argv[4] === "true"});', output, approvalPath, String(now), String(allowExpired)], { cwd: REPO, encoding: 'utf8' });
  return { root, config, kits, desktops, output, prepare, authorize, seal, signaturePath, approvalPath, retain, writeHistoricalEnvelope, validateSealed };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('approved update feed publisher', () => {
  const kitManifest = (kit: string) => join(kit, 'kit-manifest.v1.json');
  it.each<{ name: string; target: CliKitTarget; mutate: (kit: string) => void }>([
    { name: 'a kit enrolled to a different feed configuration', target: 'linux', mutate: kit => rewriteJson(kitManifest(kit), manifest => { manifest.update_bootstrap.feed_url = 'https://fixture.invalid/different-feed.json'; }, JSON.stringify) },
    { name: 'a macOS kit whose runtime claims Linux', target: 'macos', mutate: kit => rewriteJson(kitManifest(kit), manifest => { manifest.runtime.platform = 'linux'; }, JSON.stringify) },
    { name: 'the legacy macOS desktop-kit shape', target: 'macos', mutate: kit => rewriteJson(kitManifest(kit), manifest => { manifest.schema_version = 1; manifest.kind = 'echo-person-onboarding-kit-v1'; }, JSON.stringify) },
    { name: 'unreviewed installer bytes', target: 'linux', mutate: kit => writeFileSync(join(kit, 'Start-ECHO.sh'), 'unreviewed source') },
    { name: 'an unexpected archive member', target: 'linux', mutate: kit => writeFileSync(join(kit, 'unexpected'), 'not in the kit contract') },
  ])('rejects $name before preparing a feed', ({ target, mutate }) => {
    const f = fixture();
    mutate(f.kits[target].directory);
    f.kits[target].rebuild();
    expect(f.prepare().status).toBe(1);
    expect(existsSync(f.output)).toBe(false);
  });

  it('retains preparation and audit support for legacy Linux kits without bootstrap metadata', () => {
    const f = fixture();
    rewriteJson(kitManifest(f.kits.linux.directory), manifest => { delete manifest.update_bootstrap; }, JSON.stringify);
    f.kits.linux.rebuild();
    const prepared = f.prepare();
    expect(prepared.status, prepared.stderr).toBe(0);
    f.authorize();
    expect(f.seal().status).toBe(0);
    expect(f.validateSealed().status).toBe(0);
  });

  // A refused preparation writes nothing, so one fixture serves every case.
  it('refuses preparation without any one of the release artifacts', () => {
    const f = fixture();
    for (const missing of RELEASE_ARTIFACTS) {
      expect(f.prepare(RELEASE_ARTIFACTS.filter(artifact => artifact !== missing)).status, missing).toBe(1);
      expect(existsSync(f.output), missing).toBe(false);
    }
  });

  // Each case below starts from the prepared manifest, so one preparation serves them all.
  const reductions: Array<[string, (artifact: ManifestArtifact) => boolean]> = [
    ['two-CLI-kit', artifact => artifact.installation === 'cli-kit'],
    ['Linux-kit-only', artifact => artifact.installation === 'cli-kit' && artifact.platform === 'linux'],
    ['macOS-kit-only', artifact => artifact.installation === 'cli-kit' && artifact.platform === 'darwin'],
  ];
  it('refuses to seal a manually reduced manifest', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const prepared = readFileSync(join(f.output, 'manifest.json'));
    for (const [name, keep] of [...reductions, ['app-less', (artifact: ManifestArtifact) => artifact.installation !== 'electron' || artifact.platform !== 'darwin'] as const]) {
      writeFileSync(join(f.output, 'manifest.json'), prepared);
      f.retain(keep);
      f.authorize();
      const sealed = f.seal();
      expect(sealed.status, name).toBe(1);
      expect(sealed.stderr, name).toContain('all_release_targets_required');
      expect(existsSync(join(f.output, 'feed.json')), name).toBe(false);
    }
  });

  it('still audits previously signed reduced feeds, including after expiry', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const prepared = readFileSync(join(f.output, 'manifest.json'));
    for (const [name, keep] of reductions) {
      writeFileSync(join(f.output, 'manifest.json'), prepared);
      const manifest = f.retain(keep);
      f.authorize();
      // Historical bytes are constructed directly, without asking new-release
      // preparation or sealing to authorize a CLI-only publication.
      f.writeHistoricalEnvelope();
      const audited = f.validateSealed();
      expect(audited.status, `${name}: ${audited.stderr}`).toBe(0);
      expect(f.validateSealed(Date.parse(manifest.expires_at) + 1, true).status, name).toBe(0);
    }
  });

  it('prepares one signed feed with exactly the four release targets', () => {
    const f = fixture();
    const prepared = f.prepare();
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(existsSync(join(f.output, 'feed.json'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(f.output, 'manifest.json'), 'utf8'));
    expect(manifest.artifacts.map((artifact: ManifestArtifact) => [artifact.platform, artifact.architecture, artifact.libc, artifact.installation])).toEqual(RELEASE_TARGETS);
    const files = manifest.artifacts.map((artifact: ManifestArtifact, index: number) => `${artifact.sha256}.${index === 3 ? 'deb' : 'zip'}`);
    expect(manifest.artifacts.map((artifact: ManifestArtifact) => artifact.url)).toEqual(files.map((file: string) => new URL(`artifacts/${file}`, f.config.feed_url).href));
    expect(readdirSync(join(f.output, 'artifacts')).sort()).toEqual([...files].sort());
    expect(readFileSync(join(f.output, 'artifacts', files[3]))).toEqual(readFileSync(f.desktops['linux-deb'].path));
    f.authorize();
    expect(f.seal().status).toBe(0);
    const envelope = JSON.parse(readFileSync(join(f.output, 'feed.json'), 'utf8'));
    expect(Buffer.from(envelope.payload, 'base64')).toEqual(readFileSync(join(f.output, 'manifest.json')));
    expect(f.seal().status).toBe(1);
  });

  // The manifest case also covers a signature that does not match the manifest.
  it.each(['authorization', 'manifest', 'artifact'])('refuses %s changes before publishing a feed', (change) => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    f.authorize(change !== 'authorization');
    if (change === 'manifest') rewriteJson(join(f.output, 'manifest.json'), manifest => { manifest.sequence = 2; }, canonicalLine);
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
    rewriteJson(join(f.output, 'manifest.json'), manifest => { manifest.sequence = 2; }, canonicalLine);
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
    rewriteJson(join(f.output, 'feed.json'), feed => { feed.signature = Buffer.alloc(64).toString('base64'); }, JSON.stringify);
    expect(f.validateSealed(afterExpiry, true).status).toBe(1);
  });

  it('refuses an audit of a signed feed issued more than five minutes in the future', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const manifestPath = join(f.output, 'manifest.json');
    const now = Date.now();
    rewriteJson(manifestPath, manifest => {
      manifest.issued_at = new Date(now + 6 * 60 * 1000).toISOString();
      manifest.expires_at = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    }, canonicalLine);
    f.authorize();
    const envelope = { payload: readFileSync(manifestPath).toString('base64'), signature: readFileSync(f.signaturePath).toString('base64') };
    writeFileSync(join(f.output, 'feed.json'), JSON.stringify(envelope));
    expect(f.validateSealed(now, true).status).toBe(1);
  });

  it('rejects altered release metadata before accepting a valid signature', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    rewriteJson(join(f.output, 'manifest.json'), manifest => { manifest.product_version = '0.1.2'; }, canonicalLine);
    f.authorize();
    const result = f.seal();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release_mismatch');
    expect(existsSync(join(f.output, 'feed.json'))).toBe(false);
  });
});

describe('desktop release artifacts', () => {
  type Fixture = ReturnType<typeof fixture>;
  const identity = (target: DesktopTarget, mutate: (identity: any) => void, serialize = canonicalLine) => (f: Fixture) => { rewriteJson(f.desktops[target].identity, mutate, serialize); };
  const client = (f: Fixture, target: DesktopTarget, path = 'package/dist/client-update-cli.js') => join(f.desktops[target].client, path);
  const flipByte = (path: string) => { const bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes); };
  const helper = (f: Fixture) => join(f.root, 'linux-deb/data/opt/ECHO/resources/echo-desktop-update-helper');
  // A ZIP member added after the packaged tree, as one a case-folding Mac would
  // install over the path it names once that tree has been checked.
  const appendEntry = (name: string, bytes = 'not the release bytes') => (f: Fixture) => {
    const staging = mkdtempSync(join(f.root, 'entry-'));
    mkdirSync(join(staging, dirname(name)), { recursive: true });
    writeFileSync(join(staging, name), bytes);
    execFileSync('zip', ['-q', f.desktops['macos-app'].path, name], { cwd: staging });
  };
  it.each<{ name: string; target: DesktopTarget; code: string; mutate?: (f: Fixture) => void; after?: (f: Fixture) => void }>([
    { name: 'an identity for another product version', target: 'macos-app', code: 'desktop_identity_mismatch', mutate: identity('macos-app', value => { value.product_version = '0.1.2'; }) },
    { name: 'an identity for another release record', target: 'linux-deb', code: 'desktop_identity_mismatch', mutate: identity('linux-deb', value => { value.release_record_sha256 = 'f'.repeat(64); }) },
    { name: 'an identity claiming the other platform', target: 'linux-deb', code: 'desktop_identity_mismatch', mutate: identity('linux-deb', value => { value.platform = 'darwin'; value.libc = null; }) },
    { name: 'an identity with an extra field', target: 'macos-app', code: 'desktop_identity_mismatch', mutate: identity('macos-app', value => { value.channel = 'fixture'; }) },
    { name: 'a non-canonical identity', target: 'macos-app', code: 'desktop_identity_mismatch', mutate: identity('macos-app', () => {}, value => JSON.stringify(value, null, 2)) },
    { name: 'a bootstrap pinned to another channel', target: 'macos-app', code: 'desktop_bootstrap_mismatch', mutate: identity('macos-app', value => { value.update_bootstrap.channel = 'other'; }) },
    { name: 'a bootstrap still naming the cli-kit installation', target: 'linux-deb', code: 'desktop_bootstrap_mismatch', mutate: identity('linux-deb', value => { value.update_bootstrap.installation = 'cli-kit'; }) },
    { name: 'one changed byte in the embedded app client', target: 'macos-app', code: 'desktop_client_mismatch', mutate: f => flipByte(client(f, 'macos-app')) },
    { name: 'one changed byte in the embedded package client', target: 'linux-deb', code: 'desktop_client_mismatch', mutate: f => flipByte(client(f, 'linux-deb', 'package/dist/build-identity.v1.json')) },
    { name: 'an extra embedded file', target: 'linux-deb', code: 'desktop_client_mismatch', mutate: f => writeFileSync(client(f, 'linux-deb', 'package/dist/extra.js'), 'unreviewed') },
    { name: 'an extra file beside the embedded package', target: 'macos-app', code: 'desktop_client_mismatch', mutate: f => writeFileSync(client(f, 'macos-app', 'extra.js'), 'unreviewed') },
    { name: 'a missing embedded file', target: 'macos-app', code: 'desktop_client_mismatch', mutate: f => rmSync(client(f, 'macos-app')) },
    { name: 'an embedded symlink to identical bytes', target: 'macos-app', code: 'desktop_client_mismatch', mutate: f => {
      const path = client(f, 'macos-app');
      renameSync(path, join(f.root, 'linked.js')); symlinkSync(join(f.root, 'linked.js'), path);
    } },
    { name: 'a ZIP entry outside ECHO.app', target: 'macos-app', code: 'desktop_archive_invalid', after: appendEntry('README.txt') },
    { name: 'a case-variant entry over an embedded client file', target: 'macos-app', code: 'desktop_archive_invalid', after: appendEntry('ECHO.app/Contents/Resources/Person-Client/package/dist/client-update-cli.js') },
    { name: 'a case-variant identity entry', target: 'macos-app', code: 'desktop_archive_invalid', after: appendEntry('ECHO.app/Contents/Resources/Echo-Desktop-Identity.v1.json', '{}\n') },
    { name: 'a case-variant Info.plist', target: 'macos-app', code: 'desktop_archive_invalid', after: appendEntry('ECHO.app/Contents/info.plist', infoPlist('org.example.other')) },
    { name: 'a new file under a case-variant directory above the client', target: 'macos-app', code: 'desktop_archive_invalid', after: appendEntry('ECHO.app/Contents/resources/person-client/package/dist/added.js') },
    { name: 'a file entry where the archive holds a directory', target: 'macos-app', code: 'desktop_archive_invalid', after: appendEntry('ECHO.app/Contents/Resources/person-client/package') },
    { name: 'a non-ASCII entry name', target: 'macos-app', code: 'desktop_archive_invalid', after: appendEntry('ECHO.app/Contents/Resources/café.txt') },
    { name: 'a wrong bundle id', target: 'macos-app', code: 'desktop_bundle_mismatch', mutate: f => writeFileSync(join(f.root, 'macos-app/ECHO.app/Contents/Info.plist'), infoPlist('org.example.other')) },
    { name: 'a bundle id behind a comment', target: 'macos-app', code: 'desktop_bundle_mismatch', mutate: f => writeFileSync(join(f.root, 'macos-app/ECHO.app/Contents/Info.plist'),
      infoPlist('org.example.other').replace('<dict>', '<dict><!-- <key>CFBundleIdentifier</key><string>org.echobrain.echo-desktop</string> -->')) },
    // The package contents checks have their own cases below; this one shows
    // prepare binds them to release.source_sha.
    { name: 'a modified root helper', target: 'linux-deb', code: 'desktop_root_file_mismatch', mutate: f => writeFileSync(helper(f), Buffer.concat([readFileSync(helper(f)), Buffer.from('\n')])) },
    { name: 'a symlink in the embedded package client', target: 'linux-deb', code: 'desktop_client_mismatch', mutate: f => {
      const path = client(f, 'linux-deb');
      rmSync(path); symlinkSync('build-identity.v1.json', path);
    } },
  ])('refuses $name before preparing a feed', ({ target, code, mutate, after }) => {
    const f = fixture();
    mutate?.(f);
    f.desktops[target].rebuild();
    after?.(f);
    const prepared = f.prepare();
    expect(prepared.status).toBe(1);
    expect(prepared.stderr).toContain(code);
    expect(existsSync(f.output)).toBe(false);
  });

  it('reads a deb with BSD ar member names and a gzip control tarball', () => {
    const f = fixture({ gnuAr: false, controlCompression: 'gz' });
    const prepared = f.prepare();
    expect(prepared.status, prepared.stderr).toBe(0);
  });

  it('refuses a deb served under a .zip key', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    rewriteJson(join(f.output, 'manifest.json'), manifest => {
      const deb = manifest.artifacts.find((artifact: ManifestArtifact) => artifact.installation === 'electron' && artifact.platform === 'linux');
      renameSync(join(f.output, 'artifacts', `${deb.sha256}.deb`), join(f.output, 'artifacts', `${deb.sha256}.zip`));
      deb.url = deb.url.replace(/\.deb$/, '.zip');
    }, canonicalLine);
    f.authorize();
    const sealed = f.seal();
    expect(sealed.status).toBe(1);
    expect(sealed.stderr).toContain('artifact_mismatch');
    expect(existsSync(join(f.output, 'feed.json'))).toBe(false);
  });
});

// ADR-0035: the root helper installs a signed deb with apt-get, so everything
// dpkg runs or places as root must be reviewed source. scripts/check-deb.mjs is
// the check prepare runs, and CI runs it on the deb electron-builder builds.
describe('Linux desktop package contents', () => {
  const CHECK = join(REPO, 'product/echo-desktop/scripts/check-deb.mjs');
  const relationships = () => JSON.parse(committedSource('product/echo-desktop/linux/deb-relationships.json').toString('utf8'));
  function deb() {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'echo-deb-test-'));
    roots.push(root);
    return linuxDeb(root, committedSource);
  }
  const check = (path: string) => spawnSync(process.execPath, [CHECK, path], { cwd: REPO, encoding: 'utf8' });
  const inData = (path: string, mode = 0o644) => (d: LinuxDeb) => {
    mkdirSync(dirname(join(d.data, path)), { recursive: true });
    writeFileSync(join(d.data, path), 'unreviewed', { mode });
  };
  const extraData = (...members: TarMember[]) => (d: LinuxDeb) => { d.extraData.push(...members); };
  const appendLine = (path: (d: LinuxDeb) => string) => (d: LinuxDeb) => { writeFileSync(path(d), Buffer.concat([readFileSync(path(d)), Buffer.from('\n')])); };

  it('accepts the layout electron-builder and fpm build, checked against HEAD', () => {
    const result = check(deb().path);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'checked', source_sha: sourceSha });
  });

  it.each<{ name: string; code: string; mutate: (d: LinuxDeb) => void }>([
    ...['preinst', 'prerm', 'config', 'triggers', 'conffiles', 'templates'].map(member => ({
      name: `a control member ${member}`, code: 'desktop_package_unsafe', mutate: (d: LinuxDeb) => writeFileSync(join(d.control, member), '#!/bin/bash\n', { mode: 0o755 }),
    })),
    { name: 'a modified postinst', code: 'desktop_root_file_mismatch', mutate: appendLine(d => join(d.control, 'postinst')) },
    { name: 'a modified postrm', code: 'desktop_root_file_mismatch', mutate: appendLine(d => join(d.control, 'postrm')) },
    { name: 'no postrm', code: 'desktop_root_file_mismatch', mutate: d => rmSync(join(d.control, 'postrm')) },
    { name: 'a modified AppArmor profile', code: 'desktop_root_file_mismatch', mutate: appendLine(d => join(d.data, 'opt/ECHO/resources/apparmor-profile')) },
    { name: 'a modified update helper', code: 'desktop_root_file_mismatch', mutate: appendLine(d => join(d.data, 'opt/ECHO/resources/echo-desktop-update-helper')) },
    { name: 'the wrong Package', code: 'desktop_package_mismatch', mutate: d => d.writeControl({ Package: 'echo-desktop-beta' }) },
    { name: 'another architecture', code: 'desktop_package_mismatch', mutate: d => d.writeControl({ Architecture: 'arm64' }) },
    { name: 'an extra dependency', code: 'desktop_package_mismatch', mutate: d => d.writeControl({ Depends: [...relationships().depends, 'openssh-server'].join(', ') }) },
    { name: 'a recommendation on a continuation line', code: 'desktop_package_mismatch', mutate: d => d.writeControl({ Recommends: `${relationships().recommends.join(', ')}\n , telnetd` }) },
    { name: 'no Recommends', code: 'desktop_package_mismatch', mutate: d => d.writeControl({ Recommends: undefined }) },
    { name: 'a Conflicts field', code: 'desktop_package_mismatch', mutate: d => d.writeControl({ Conflicts: 'apparmor' }) },
    { name: 'a Pre-Depends field', code: 'desktop_package_mismatch', mutate: d => d.writeControl({ 'Pre-Depends': 'openssh-server' }) },
    { name: 'a file under /etc', code: 'desktop_package_unsafe', mutate: inData('etc/cron.d/echo-desktop') },
    { name: 'a file under /usr/bin', code: 'desktop_package_unsafe', mutate: inData('usr/bin/echo-desktop', 0o755) },
    { name: 'another desktop entry', code: 'desktop_package_unsafe', mutate: inData('usr/share/applications/other.desktop') },
    { name: 'a folder beside /opt/ECHO', code: 'desktop_package_unsafe', mutate: inData('opt/ECHO-helper/run', 0o755) },
    { name: 'a setuid file', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/chrome-sandbox-suid', mode: 0o4755, bytes: 'synthetic' }) },
    { name: 'a setgid folder', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/shared/', type: 'directory', mode: 0o2755 }) },
    { name: 'a sticky folder', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/tmp/', type: 'directory', mode: 0o1777 }) },
    { name: 'a file anyone can write', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/resources/writable', mode: 0o646 }) },
    { name: 'a folder its group can write', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/plugins/', type: 'directory', mode: 0o775 }) },
    { name: 'a file a person owns', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/owned', uid: 1000 }) },
    { name: 'a file owned by a named user', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/named', uname: 'person' }) },
    { name: 'a symlink to /etc', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/escape', type: 'symlink', link: '/etc/shadow' }) },
    { name: 'a relative symlink out of /opt/ECHO', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/resources/escape', type: 'symlink', link: '../../../etc/shadow' }) },
    { name: 'a symlink through ..', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/escape', type: 'symlink', link: 'resources/../echo-desktop' }) },
    { name: 'a symlink outside /opt/ECHO', code: 'desktop_package_unsafe', mutate: extraData({ name: './usr/share/applications/linked.desktop', type: 'symlink', link: '/opt/ECHO/echo-desktop' }) },
    { name: 'a member under a symlinked folder', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/lib', type: 'symlink', link: 'resources' }, { name: './opt/ECHO/lib/added' }) },
    { name: 'a device node', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/disk', type: 'device' }) },
    { name: 'a fifo', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/pipe', type: 'fifo' }) },
    { name: 'a hard link', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/shadow', type: 'hard link', link: '/etc/shadow' }) },
    { name: 'an absolute path', code: 'desktop_package_unsafe', mutate: extraData({ name: '/opt/ECHO/absolute' }) },
    { name: 'a path through ..', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/../../etc/passwd' }) },
    { name: 'a duplicate path', code: 'desktop_package_unsafe', mutate: extraData({ name: './opt/ECHO/echo-desktop', mode: 0o755, bytes: 'replaced' }) },
    { name: 'a PAX header', code: 'desktop_package_invalid', mutate: extraData({ name: './PaxHeaders/added', type: 'pax', bytes: '30 path=./etc/cron.d/echo-added\n' }) },
    { name: 'members after the end of the archive', code: 'desktop_package_invalid', mutate: d => { d.dataTail = gnuTar([{ name: './etc/cron.d/echo-added' }]); } },
  ])('refuses $name', ({ code, mutate }) => {
    const d = deb();
    mutate(d);
    d.rebuild();
    const result = check(d.path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(code);
  });
});
