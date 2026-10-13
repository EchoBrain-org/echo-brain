import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { installedUpdateRoot } from '../../src/product/person-client/client-update-cli.js';
import { ClientUpdateError, type ClientUpdateManifest, type UpdatePlatform, parseUpdateConfig, parseUpdateManifest, selectUpdateArtifact, updateDigest, verifyUpdateEnvelope, UPDATE_INTERVAL_MS } from '../../src/product/person-client/client-update-contract.js';
import { type ClientUpdateInstallation, configureClientUpdates, readClientUpdateConfig, releaseInterruptedClientUpdate, runClientUpdate } from '../../src/product/person-client/client-update.js';
import { type UpdateInstallerInput } from '../../src/product/person-client/client-update-kit.js';

const NOW = Date.parse('2026-09-24T21:00:00.000Z');
const PLATFORM: UpdatePlatform = { platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'cli-kit' };
const roots: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'echo-update-test-'));
  roots.push(directory);
  const root = join(directory, 'echo', 'person');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'bin'), { mode: 0o700 });
  mkdirSync(join(root, 'releases'), { mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config = parseUpdateConfig({ schema_version: 1, kind: 'echo-client-update-config-v1', channel: 'staging-accepted', feed_url: 'https://updates.example.test/staging/feed.json', public_key_spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), minimum_sequence: 3, automatic: true, installation: 'cli-kit' });
  const archive = Buffer.from('synthetic verified artifact');
  const release = Buffer.from('{"release_id":"clean-v1-release-b"}\n');
  const manifest: ClientUpdateManifest = { schema_version: 1, kind: 'echo-client-update-manifest-v1', channel: config.channel, sequence: 3, issued_at: '2026-09-24T20:00:00.000Z', expires_at: '2026-10-01T20:00:00.000Z', release_id: 'clean-v1-release-b', source_sha: 'b'.repeat(40), release_sha256: updateDigest(release), product_version: '0.1.1', artifacts: [{ ...PLATFORM, url: 'https://updates.example.test/staging/artifacts/b.zip', bytes: archive.length, sha256: updateDigest(archive) }] };
  const envelope = (value: unknown = manifest) => {
    const payload = Buffer.from(JSON.stringify(value));
    return Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }));
  };
  const activate = (id: string, record = Buffer.from('{}\n')) => {
    mkdirSync(join(root, 'releases', id), { mode: 0o700 });
    writeFileSync(join(root, 'releases', id, '.echo-owned-release-v1'), `${id}\n`, { mode: 0o600 });
    writeFileSync(join(root, 'releases', id, 'release.json'), record, { mode: 0o600 });
    writeFileSync(join(root, 'bin', 'echo-brain'), `#!/bin/bash\nexec '${root}/releases/${id}/node' '${root}/releases/${id}/package/dist/main.js' "$@"\n`, { mode: 0o700 });
  };
  activate('clean-v1-release-a');
  configureClientUpdates(root, config);
  const fetcher = vi.fn(async (url: string | URL | Request) => new Response(new Uint8Array(String(url) === config.feed_url ? envelope() : archive)));
  const install = vi.fn(async () => { activate(manifest.release_id, release); });
  const dependencies = { root, platform: PLATFORM, now: () => NOW, fetch: fetcher as typeof fetch, install };
  return { root, directory, config, archive, manifest, envelope, activate, dependencies, fetcher, install, publicKey };
}
const APP: UpdatePlatform = { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'electron' };
/** The desktop app's adapter over the same root, with no CLI wrapper or release folders to read. */
function appFixture(activation: ClientUpdateInstallation['activation'] = 'restart') {
  const f = fixture();
  rmSync(join(f.root, 'bin'), { recursive: true });
  rmSync(join(f.root, 'releases'), { recursive: true });
  rmSync(join(f.root, 'updater/config.json'));
  const appBytes = Buffer.from('synthetic verified ECHO.app archive');
  f.manifest.artifacts.push({ ...APP, url: 'https://updates.example.test/staging/artifacts/app.zip', bytes: appBytes.length, sha256: updateDigest(appBytes) });
  const fetcher = vi.fn(async (url: string | URL | Request) => new Response(new Uint8Array(String(url) === f.config.feed_url ? f.envelope() : appBytes)));
  const app = { release: 'clean-v1-release-a', record: 'a'.repeat(64) };
  const installedRelease = vi.fn(() => app.release);
  const install = vi.fn(async (_input: UpdateInstallerInput) => {});
  const installation: ClientUpdateInstallation = {
    installedRelease, installedReleaseSha256: () => app.record, fingerprint: () => 'f'.repeat(64), install,
    activation, archive_name: 'ECHO.zip', download_timeout_ms: 15 * 60_000,
  };
  const config = { ...f.config, installation: 'electron' as const };
  configureClientUpdates(f.root, config, installation);
  const dependencies = { root: f.root, platform: APP, now: () => NOW, fetch: fetcher as typeof fetch, installation };
  return { ...f, config, app, appBytes, fetcher, install, installedRelease, installation, dependencies };
}
const appState = (root: string) => JSON.parse(readFileSync(join(root, 'updater/state.json'), 'utf8'));
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe('signed cross-platform client updates', () => {
  it.skipIf(process.platform !== 'darwin')('enrolls only the independent Mac CLI root and rejects legacy paired kits', () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'echo Mac enrollment '));
    roots.push(home);
    vi.stubEnv('HOME', home);
    try {
      const macRoot = join(home, 'Library/Application Support/ECHO/cli');
      const release = join(macRoot, 'releases/clean-v1-mac-enrollment');
      mkdirSync(release, { recursive: true, mode: 0o700 });
      writeFileSync(join(release, '.echo-owned-release-v1'), 'clean-v1-mac-enrollment', { mode: 0o600 });
      const metadata = join(release, 'kit-manifest.v1.json');
      const url = pathToFileURL(join(release, 'package/dist/client-update-cli.js')).href;
      writeFileSync(metadata, JSON.stringify({ schema_version: 1, kind: 'echo-person-onboarding-kit-v1' }), { mode: 0o600 });
      expect(installedUpdateRoot(url)).toBeUndefined();
      const manifest = { schema_version: 3, kind: 'echo-person-cli-kit-v1', runtime: { platform: 'darwin', architecture: 'arm64' } };
      writeFileSync(metadata, JSON.stringify(manifest));
      expect(installedUpdateRoot(url)).toBe(macRoot);
      const paired = join(home, 'Library/Application Support/ECHO/releases/clean-v1-mac-enrollment');
      mkdirSync(paired, { recursive: true, mode: 0o700 });
      writeFileSync(join(paired, '.echo-owned-release-v1'), 'clean-v1-mac-enrollment', { mode: 0o600 });
      writeFileSync(join(paired, 'kit-manifest.v1.json'), JSON.stringify(manifest), { mode: 0o600 });
      expect(installedUpdateRoot(pathToFileURL(join(paired, 'package/dist/client-update-cli.js')).href)).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });

  it('selects exact OS, architecture, libc, and installation type from one signed feed', () => {
    const f = fixture();
    const mac = { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'electron' } as const;
    const windows = { platform: 'win32', architecture: 'x64', libc: null, installation: 'electron' } as const;
    const manifest = parseUpdateManifest({ ...f.manifest, artifacts: [f.manifest.artifacts[0], { ...f.manifest.artifacts[0], ...mac }, { ...f.manifest.artifacts[0], ...windows }] });
    const verified = verifyUpdateEnvelope(f.envelope(manifest), f.config, NOW);
    expect(selectUpdateArtifact(verified.manifest, mac).platform).toBe('darwin');
    expect(selectUpdateArtifact(verified.manifest, windows).platform).toBe('win32');
    for (const target of [{ ...PLATFORM, libc: 'musl' }, { ...PLATFORM, architecture: 'arm64' }, { ...PLATFORM, installation: 'container' }]) {
      expect(() => selectUpdateArtifact(manifest, target as UpdatePlatform)).toThrow('unsupported_platform');
    }
  });

  it('rejects tampering, another publisher, expired/future metadata, and stale or conflicting sequence', () => {
    const f = fixture();
    const original = f.envelope();
    const changed = JSON.parse(original.toString());
    changed.payload = Buffer.from(JSON.stringify({ ...f.manifest, release_id: 'clean-v1-attacker' })).toString('base64');
    expect(() => verifyUpdateEnvelope(Buffer.from(JSON.stringify(changed)), f.config, NOW)).toThrow('invalid_signature');
    const another = fixture();
    expect(() => verifyUpdateEnvelope(original, another.config, NOW)).toThrow('invalid_signature');
    expect(() => verifyUpdateEnvelope(original, f.config, Date.parse(f.manifest.expires_at))).toThrow('expired_metadata');
    expect(() => verifyUpdateEnvelope(original, f.config, NOW - 2 * UPDATE_INTERVAL_MS)).toThrow('expired_metadata');
    expect(() => verifyUpdateEnvelope(f.envelope({ ...f.manifest, sequence: 2 }), f.config, NOW)).toThrow('stale_metadata');
    const { checkpoint } = verifyUpdateEnvelope(original, f.config, NOW);
    expect(() => verifyUpdateEnvelope(f.envelope({ ...f.manifest, product_version: '0.1.2' }), f.config, NOW, checkpoint)).toThrow('changed_metadata');
    expect(() => verifyUpdateEnvelope(original, f.config, NOW, { ...checkpoint, sequence: 4 })).toThrow('stale_metadata');
  });

  it('rejects unknown fields, duplicate platform artifacts, cross-channel metadata, and a second download origin', () => {
    const f = fixture();
    expect(() => parseUpdateManifest({ ...f.manifest, command: 'run' })).toThrow('invalid_metadata');
    expect(() => parseUpdateManifest({ ...f.manifest, artifacts: [...f.manifest.artifacts, ...f.manifest.artifacts] })).toThrow('invalid_metadata');
    expect(() => verifyUpdateEnvelope(f.envelope({ ...f.manifest, channel: 'another' }), f.config, NOW)).toThrow('wrong_channel');
    expect(() => verifyUpdateEnvelope(f.envelope({ ...f.manifest, artifacts: [{ ...f.manifest.artifacts[0], url: 'https://another.example.test/b.zip' }] }), f.config, NOW)).toThrow('wrong_artifact_origin');
  });

  it('automatically checks for a release without downloading or activating it', async () => {
    const f = fixture();
    const initial = readFileSync(join(f.root, 'bin', 'echo-brain'));
    const result = await runClientUpdate('automatic', f.dependencies);
    expect(result).toMatchObject({ status: 'available', installed_release: 'clean-v1-release-a', available_release: f.manifest.release_id, checked_at: NOW });
    expect(f.fetcher.mock.calls.map(args => args[0])).toEqual([f.config.feed_url]);
    expect(f.install).not.toHaveBeenCalled();
    expect(readFileSync(join(f.root, 'bin', 'echo-brain'))).toEqual(initial);
  });

  it('downloads B, verifies bytes before installation, activates once, and preserves session bytes', async () => {
    const f = fixture();
    const session = join(f.directory, 'session-sentinel');
    writeFileSync(session, 'synthetic untouched session', { mode: 0o600 });
    // The updating process runs A and installs B; that is not a mismatch.
    const result = await runClientUpdate('apply', { ...f.dependencies, running_release: 'clean-v1-release-a' });
    expect(result).toMatchObject({ status: 'updated', installed_release: f.manifest.release_id, running_release: 'clean-v1-release-a' });
    expect(f.install).toHaveBeenCalledOnce();
    expect(readFileSync(session, 'utf8')).toBe('synthetic untouched session');
    const next = { ...f.dependencies, running_release: f.manifest.release_id };
    expect((await runClientUpdate('automatic', next)).status).toBe('not_due');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect((await runClientUpdate('apply', next)).status).toBe('current');
    expect(f.install).toHaveBeenCalledOnce();
  });

  it('reports a launcher still running A after the managed command selects B, without checking or installing', async () => {
    const f = fixture();
    await runClientUpdate('apply', f.dependencies);
    const wrapper = readFileSync(join(f.root, 'bin', 'echo-brain'));
    const state = readFileSync(join(f.root, 'updater/state.json'));
    const pinned = { ...f.dependencies, running_release: 'clean-v1-release-a' };
    for (const mode of ['apply', 'check', 'status', 'automatic'] as const) {
      expect(await runClientUpdate(mode, pinned)).toMatchObject({ status: 'running_release_mismatch', installed_release: f.manifest.release_id, running_release: 'clean-v1-release-a' });
    }
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.install).toHaveBeenCalledOnce();
    expect(readFileSync(join(f.root, 'bin', 'echo-brain'))).toEqual(wrapper);
    expect(readFileSync(join(f.root, 'updater/state.json'))).toEqual(state);
    expect(readFileSync(join(f.root, 'releases/clean-v1-release-a/.echo-owned-release-v1'), 'utf8').trim()).toBe('clean-v1-release-a');
  });

  it('selects and activates the macOS CLI kit from the same feed as Linux', async () => {
    const f = fixture();
    const mac: UpdatePlatform = { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'cli-kit' };
    const macBytes = Buffer.from('verified Mac CLI kit');
    const macArtifact = { ...mac, url: 'https://updates.example.test/staging/artifacts/mac.zip', bytes: macBytes.length, sha256: updateDigest(macBytes) };
    f.manifest.artifacts.push(macArtifact);
    const fetcher = vi.fn(async (url: string | URL | Request) => new Response(new Uint8Array(String(url) === f.config.feed_url ? f.envelope() : macBytes)));
    const updated = await runClientUpdate('apply', { ...f.dependencies, platform: mac, fetch: fetcher as typeof fetch });
    expect(updated.status).toBe('updated');
    expect(updated.platform).toBe('darwin/arm64/native/cli-kit');
    expect(fetcher.mock.calls.map(args => args[0])).toEqual([f.config.feed_url, macArtifact.url]);
    expect(f.install).toHaveBeenCalledOnce();
  });

  it('keeps availability cached until the next automatic check and requires an explicit apply', async () => {
    const f = fixture();
    expect((await runClientUpdate('check', f.dependencies)).status).toBe('available');
    expect(await runClientUpdate('automatic', { ...f.dependencies, now: () => NOW + UPDATE_INTERVAL_MS - 1 })).toMatchObject({ status: 'available', available_release: f.manifest.release_id, checked_at: NOW });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(await runClientUpdate('automatic', { ...f.dependencies, now: () => NOW + UPDATE_INTERVAL_MS })).toMatchObject({ status: 'available', available_release: f.manifest.release_id, checked_at: NOW + UPDATE_INTERVAL_MS });
    expect(f.fetcher.mock.calls.map(args => args[0])).toEqual([f.config.feed_url, f.config.feed_url]);
    expect(f.install).not.toHaveBeenCalled();
    expect((await runClientUpdate('apply', { ...f.dependencies, now: () => NOW + UPDATE_INTERVAL_MS })).status).toBe('updated');
    expect(f.install).toHaveBeenCalledOnce();
  });

  it('stops announcing a cached release that was installed separately', async () => {
    const f = fixture();
    await runClientUpdate('check', f.dependencies);
    f.activate(f.manifest.release_id);
    expect(await runClientUpdate('automatic', f.dependencies)).toMatchObject({ status: 'not_due', installed_release: f.manifest.release_id });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.install).not.toHaveBeenCalled();
  });

  it('refuses to report current when the installed release record is not the signed one', async () => {
    const f = fixture();
    // The wrapper selects B, but B's folder holds other release.json bytes.
    f.activate(f.manifest.release_id, Buffer.from('{"release_id":"clean-v1-release-b","source_sha":"unsigned"}\n'));
    for (const mode of ['check', 'apply'] as const) {
      await expect(runClientUpdate(mode, f.dependencies)).rejects.toThrow('release_mismatch');
      expect(appState(f.root)).toMatchObject({ result: 'release_mismatch', available_release: f.manifest.release_id });
    }
    expect(f.fetcher.mock.calls.map(args => args[0])).toEqual([f.config.feed_url, f.config.feed_url]);
    expect(f.install).not.toHaveBeenCalled();
  });

  it('does not announce stale availability after a failed automatic check', async () => {
    const f = fixture();
    await runClientUpdate('check', f.dependencies);
    f.fetcher.mockImplementation(async () => new Response('{}'));
    const dependencies = { ...f.dependencies, now: () => NOW + UPDATE_INTERVAL_MS };
    expect((await runClientUpdate('automatic', dependencies)).status).toBe('invalid_metadata');
    expect((await runClientUpdate('automatic', dependencies)).status).toBe('not_due');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.install).not.toHaveBeenCalled();
  });

  it.each(['corrupt', 'truncated', 'oversized', 'redirected', 'encoded', 'network'])('keeps A on %s download failure and never invokes the installer', async (failure) => {
    const f = fixture();
    const initial = readFileSync(join(f.root, 'bin', 'echo-brain'));
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === f.config.feed_url) return new Response(new Uint8Array(f.envelope()));
      if (failure === 'network') throw new Error('untrusted remote response');
      if (failure === 'redirected') return new Response(null, { status: 302, headers: { location: 'https://another.example.test/a' } });
      if (failure === 'encoded') return new Response(new Uint8Array(f.archive), { headers: { 'content-encoding': 'gzip' } });
      if (failure === 'oversized') return new Response(new Uint8Array(f.archive.length + 1));
      if (failure === 'truncated') return new Response(new Uint8Array(f.archive.subarray(1)), { headers: { 'content-length': String(f.archive.length) } });
      return new Response(new Uint8Array(f.archive.length).fill(33));
    });
    await expect(runClientUpdate('apply', { ...f.dependencies, fetch: fetcher as typeof fetch })).rejects.toBeInstanceOf(ClientUpdateError);
    expect(f.install).not.toHaveBeenCalled();
    expect(readFileSync(join(f.root, 'bin', 'echo-brain'))).toEqual(initial);
    expect((await runClientUpdate('automatic', { ...f.dependencies, fetch: fetcher as typeof fetch })).status).toBe('not_due');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent invocations and persists freshness across restart', async () => {
    const f = fixture();
    let unblock!: () => void;
    const gate = new Promise<void>(r => { unblock = r; });
    const first = runClientUpdate('apply', { ...f.dependencies, fetch: (async (...args) => { await gate; return f.fetcher(args[0]); }) as typeof fetch });
    await Promise.resolve();
    expect((await runClientUpdate('apply', f.dependencies)).status).toBe('update_busy');
    unblock();
    await first;
    expect(f.install).toHaveBeenCalledOnce();
    f.manifest.sequence = 2;
    await expect(runClientUpdate('apply', f.dependencies)).rejects.toThrow('stale_metadata');
  });

  it('supports disabling automatic checks without resetting trust or preventing manual updates', async () => {
    const f = fixture();
    await runClientUpdate('check', f.dependencies);
    const before = JSON.parse(readFileSync(join(f.root, 'updater/state.json'), 'utf8')).checkpoint;
    configureClientUpdates(f.root, { ...f.config, automatic: false });
    expect((await runClientUpdate('automatic', f.dependencies)).status).toBe('automatic_disabled');
    expect(JSON.parse(readFileSync(join(f.root, 'updater/state.json'), 'utf8')).checkpoint).toEqual(before);
    expect(() => configureClientUpdates(f.root, { ...f.config, minimum_sequence: 1 })).toThrow('already_configured');
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect((await runClientUpdate('apply', f.dependencies)).status).toBe('updated');
    expect(f.install).toHaveBeenCalledOnce();
  });

  it('retains recovery evidence and the lock after an uncertain installer outcome, even through releaseInterruptedClientUpdate', async () => {
    const f = fixture();
    await expect(runClientUpdate('apply', { ...f.dependencies, install: () => { throw new ClientUpdateError('installation_outcome_unknown'); } })).rejects.toThrow('installation_outcome_unknown');
    const evidence = readdirSync(join(f.root, 'updater')).sort();
    expect(evidence).toEqual(expect.arrayContaining(['.lock', expect.stringMatching(/^\.download-/)]));
    releaseInterruptedClientUpdate(f.root);
    expect(readdirSync(join(f.root, 'updater')).sort()).toEqual(evidence);
    expect((await runClientUpdate('apply', f.dependencies)).status).toBe('update_busy');
  });

  it('releases the lock when a signal interrupts a check before installation', async () => {
    const f = fixture();
    // The child runs the built client, as installed seats do.
    const client = new URL('../../src/product/person-client/dist/client-update.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { runClientUpdate } = await import(${JSON.stringify(client)});
      setTimeout(() => {}, 60_000);
      await runClientUpdate('automatic', { root: ${JSON.stringify(f.root)}, platform: ${JSON.stringify(PLATFORM)}, now: () => ${NOW},
        fetch: () => { process.stdout.write('fetching\\n'); return new Promise(() => {}); } });
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    await once(child.stdout, 'data');
    expect(existsSync(join(f.root, 'updater/.lock'))).toBe(true);
    child.kill('SIGINT');
    expect(await once(child, 'exit')).toEqual([null, 'SIGINT']);
    expect(existsSync(join(f.root, 'updater/.lock'))).toBe(false);
    const listeners = process.listenerCount('SIGINT');
    expect((await runClientUpdate('check', f.dependencies)).status).toBe('available');
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });

  it('refuses symlinked update state and leaves other installation types unchanged', async () => {
    const f = fixture();
    const outside = join(f.directory, 'outside');
    writeFileSync(outside, '{}');
    symlinkSync(outside, join(f.root, 'updater/state.json'));
    await expect(runClientUpdate('apply', f.dependencies)).rejects.toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('{}');
    const other = fixture();
    const config = { ...other.config, installation: 'electron' };
    rmSync(join(other.root, 'updater/config.json'));
    configureClientUpdates(other.root, config);
    expect((await runClientUpdate('apply', { ...other.dependencies, platform: { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'electron' } })).status).toBe('adapter_unavailable');
    expect(other.fetcher).not.toHaveBeenCalled();
  });

  it('checks availability automatically even when the installation has no activation adapter', async () => {
    const f = fixture();
    const platform: UpdatePlatform = { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'electron' };
    rmSync(join(f.root, 'updater/config.json'));
    configureClientUpdates(f.root, { ...f.config, installation: platform.installation });
    f.manifest.artifacts.push({ ...f.manifest.artifacts[0], ...platform });
    expect(await runClientUpdate('automatic', { ...f.dependencies, platform })).toMatchObject({ status: 'available', available_release: f.manifest.release_id });
    expect(f.fetcher.mock.calls.map(args => args[0])).toEqual([f.config.feed_url]);
    expect(f.install).not.toHaveBeenCalled();
  });
});

describe('client updates through an installation adapter', () => {
  it('stages a restart installation with the exact verified feed and leaves activation to the restart', async () => {
    const f = appFixture();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    let staged: Buffer | undefined;
    let selections = 0;
    f.install.mockImplementation(async input => { staged = readFileSync(input.archive); selections = f.installedRelease.mock.calls.length; });
    try {
      expect(await runClientUpdate('apply', f.dependencies)).toMatchObject({ status: 'staged', platform: 'darwin/arm64/native/electron', installed_release: 'clean-v1-release-a', available_release: f.manifest.release_id, checked_at: NOW });
      expect(timeout.mock.calls.map(args => args[0])).toEqual([5_000, 15 * 60_000]);
    } finally { timeout.mockRestore(); }
    expect(f.install).toHaveBeenCalledOnce();
    const input = f.install.mock.calls[0][0];
    expect(input.feed).toEqual(f.envelope());
    expect(basename(input.archive)).toBe('ECHO.zip');
    expect(dirname(dirname(input.archive))).toBe(join(f.root, 'updater'));
    expect(staged).toEqual(f.appBytes);
    expect(input).toMatchObject({ root: f.root, expected_wrapper_sha256: 'f'.repeat(64), artifact: APP, manifest: { release_id: f.manifest.release_id } });
    // The app activates after it quits, so nothing re-reads the installed release here.
    expect(f.installedRelease).toHaveBeenCalledTimes(selections);
    expect(existsSync(dirname(input.archive))).toBe(false);
    expect(existsSync(join(f.root, 'updater/.lock'))).toBe(false);
    expect(appState(f.root)).toMatchObject({ result: 'staged', available_release: f.manifest.release_id });
  });

  it('refuses an archive name that leaves the download folder', async () => {
    const f = appFixture();
    await expect(runClientUpdate('apply', { ...f.dependencies, installation: { ...f.installation, archive_name: '../ECHO.zip' } })).rejects.toThrow('unsafe_installation');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.install).not.toHaveBeenCalled();
  });

  it('confirms an immediate installation selects the new release, else reports activation_mismatch', async () => {
    const f = appFixture('immediate');
    await expect(runClientUpdate('apply', f.dependencies)).rejects.toThrow('activation_mismatch');
    expect(appState(f.root).result).toBe('activation_mismatch');
    f.install.mockImplementation(async () => { f.app.release = f.manifest.release_id; });
    expect(await runClientUpdate('apply', f.dependencies)).toMatchObject({ status: 'updated', installed_release: f.manifest.release_id, available_release: f.manifest.release_id });
    expect(f.install).toHaveBeenCalledTimes(2);
    expect(appState(f.root).result).toBe('updated');
  });

  it('adds no signal listeners during an in-flight apply when the caller handles signals', async () => {
    const f = appFixture();
    const counts = () => (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => process.listenerCount(signal));
    const baseline = counts();
    const seen: number[][] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => { seen.push(counts()); return f.fetcher(url); });
    f.install.mockImplementation(async () => { seen.push(counts()); });
    expect((await runClientUpdate('apply', { ...f.dependencies, fetch: fetcher as typeof fetch, handle_signals: false })).status).toBe('staged');
    expect(seen).toEqual([baseline, baseline, baseline]);
    // The default still releases the lock on a signal while it downloads.
    seen.length = 0;
    expect((await runClientUpdate('check', { ...f.dependencies, fetch: fetcher as typeof fetch })).status).toBe('available');
    expect(seen).toEqual([baseline.map(n => n + 1)]);
  });

  it('releases a run the app quit mid-download once it relaunches', async () => {
    const f = appFixture();
    const client = new URL('../../src/product/person-client/dist/client-update.js', import.meta.url).href;
    // Electron's quit ends the process without running the core's pending `finally`.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { runClientUpdate } = await import(${JSON.stringify(client)});
      setTimeout(() => {}, 60_000);
      let pulls = 0;
      const partial = new ReadableStream({ pull(controller) {
        if (pulls++ === 0) return controller.enqueue(new Uint8Array([1, 2, 3]));
        setTimeout(() => process.exit(0), 0);
        return new Promise(() => {});
      } });
      await runClientUpdate('apply', { root: ${JSON.stringify(f.root)}, platform: ${JSON.stringify(APP)}, now: () => ${NOW}, handle_signals: false,
        fetch: async url => new Response(String(url) === ${JSON.stringify(f.config.feed_url)} ? Buffer.from(${JSON.stringify(f.envelope().toString('base64'))}, 'base64') : partial),
        installation: { installedRelease: () => 'clean-v1-release-a', installedReleaseSha256: () => 'a'.repeat(64), fingerprint: () => 'f'.repeat(64),
          install() {}, activation: 'restart', archive_name: 'ECHO.zip', download_timeout_ms: 900_000 } });
    `], { stdio: ['ignore', 'ignore', 'inherit'] });
    expect(await once(child, 'exit')).toEqual([0, null]);
    const downloads = () => readdirSync(join(f.root, 'updater')).filter(name => name.startsWith('.download-'));
    expect(downloads()).toHaveLength(1);
    expect(readFileSync(join(f.root, 'updater', downloads()[0], 'ECHO.zip'))).toEqual(Buffer.from([1, 2, 3]));
    expect((await runClientUpdate('check', f.dependencies)).status).toBe('update_busy');
    releaseInterruptedClientUpdate(f.root);
    expect(existsSync(join(f.root, 'updater/.lock'))).toBe(false);
    expect(downloads()).toEqual([]);
    expect(appState(f.root)).toMatchObject({ result: 'available', available_release: f.manifest.release_id });
    expect((await runClientUpdate('apply', f.dependencies)).status).toBe('staged');
    expect(f.install).toHaveBeenCalledOnce();
  });

  it('announces a staged release until the app restarts into it', async () => {
    const f = appFixture();
    expect((await runClientUpdate('apply', f.dependencies)).status).toBe('staged');
    expect(await runClientUpdate('automatic', { ...f.dependencies, now: () => NOW + 1 })).toMatchObject({ status: 'available', installed_release: 'clean-v1-release-a', available_release: f.manifest.release_id, checked_at: NOW });
    f.app.release = f.manifest.release_id;
    expect(await runClientUpdate('automatic', f.dependencies)).toMatchObject({ status: 'not_due', installed_release: f.manifest.release_id });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.install).toHaveBeenCalledOnce();
  });

  it('configures through the installation release read, under the same lock', () => {
    const f = appFixture();
    expect(readClientUpdateConfig(f.root)).toEqual(f.config);
    expect(f.installedRelease).toHaveBeenCalledOnce();
    const path = join(f.root, 'updater/config.json');
    rmSync(path);
    // Without the adapter, configuration needs the CLI wrapper this root lacks.
    expect(() => configureClientUpdates(f.root, f.config)).toThrow();
    f.installedRelease.mockImplementationOnce(() => { throw new ClientUpdateError('unsafe_installation'); });
    expect(() => configureClientUpdates(f.root, f.config, f.installation)).toThrow('unsafe_installation');
    expect(existsSync(path)).toBe(false);
    mkdirSync(join(f.root, 'updater/.lock'), { mode: 0o700 });
    expect(() => configureClientUpdates(f.root, f.config, f.installation)).toThrow('update_busy');
    expect(existsSync(path)).toBe(false);
  });

  it('reports installed files that select another release than the running app, without checking or installing', async () => {
    const f = appFixture();
    // For example, another Linux user updated the shared app folder.
    f.app.release = f.manifest.release_id;
    f.app.record = f.manifest.release_sha256;
    const pinned = { ...f.dependencies, running_release: 'clean-v1-release-a' };
    for (const mode of ['apply', 'check', 'status', 'automatic'] as const) {
      expect(await runClientUpdate(mode, pinned)).toMatchObject({ status: 'running_release_mismatch', installed_release: f.manifest.release_id, running_release: 'clean-v1-release-a' });
    }
    expect(await runClientUpdate('check', { ...pinned, running_release: f.manifest.release_id })).toMatchObject({ status: 'current', running_release: f.manifest.release_id });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.install).not.toHaveBeenCalled();
  });
});
