import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClientUpdateError, type ClientUpdateManifest, type UpdatePlatform, parseUpdateConfig, parseUpdateManifest, selectUpdateArtifact, updateDigest, verifyUpdateEnvelope, UPDATE_INTERVAL_MS } from '../../src/product/person-client/client-update-contract.js';
import { configureClientUpdates, runClientUpdate } from '../../src/product/person-client/client-update.js';

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
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe('signed cross-platform client updates', () => {
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

  it('downloads B, verifies bytes before installation, activates once, and preserves session bytes', async () => {
    const f = fixture();
    const session = join(f.directory, 'session-sentinel');
    writeFileSync(session, 'synthetic untouched session', { mode: 0o600 });
    const result = await runClientUpdate('automatic', f.dependencies);
    expect(result.status).toBe('updated');
    expect(result.installed_release).toBe(f.manifest.release_id);
    expect(f.install).toHaveBeenCalledOnce();
    expect(f.install.mock.calls[0]).toBeDefined();
    expect(readFileSync(session, 'utf8')).toBe('synthetic untouched session');
    expect((await runClientUpdate('automatic', f.dependencies)).status).toBe('not_due');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect((await runClientUpdate('apply', f.dependencies)).status).toBe('current');
    expect(f.install).toHaveBeenCalledOnce();
  });

  it('allows discovery without applying, then applies on the next automatic invocation', async () => {
    const f = fixture();
    expect((await runClientUpdate('check', f.dependencies)).status).toBe('available');
    expect(f.install).not.toHaveBeenCalled();
    expect((await runClientUpdate('automatic', f.dependencies)).status).toBe('updated');
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
    const result = await runClientUpdate('automatic', { ...f.dependencies, fetch: fetcher as typeof fetch });
    expect(result.status).not.toBe('updated');
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

  it('supports disabling automatic updates without resetting publisher trust or the checkpoint', async () => {
    const f = fixture();
    await runClientUpdate('check', f.dependencies);
    const before = JSON.parse(readFileSync(join(f.root, 'updater/state.json'), 'utf8')).checkpoint;
    configureClientUpdates(f.root, { ...f.config, automatic: false });
    expect((await runClientUpdate('automatic', f.dependencies)).status).toBe('automatic_disabled');
    expect(JSON.parse(readFileSync(join(f.root, 'updater/state.json'), 'utf8')).checkpoint).toEqual(before);
    expect(() => configureClientUpdates(f.root, { ...f.config, minimum_sequence: 1 })).toThrow('already_configured');
  });

  it('retains recovery evidence and the lock after an uncertain installer outcome', async () => {
    const f = fixture();
    const result = await runClientUpdate('automatic', { ...f.dependencies, install: () => { throw new ClientUpdateError('installation_outcome_unknown'); } });
    expect(result.status).toBe('installation_outcome_unknown');
    expect(existsSync(join(f.root, 'updater/.lock'))).toBe(true);
    expect((await runClientUpdate('apply', f.dependencies)).status).toBe('update_busy');
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
});
