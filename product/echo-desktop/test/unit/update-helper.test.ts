// The Linux root helper (ADR-0035) re-verifies a desktop update before apt
// installs it. Its checks run here as plain functions: main needs root.
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helperPath = resolve(import.meta.dirname, '../../linux/echo-desktop-update-helper');
const DRIVER = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader('echo_desktop_update_helper', sys.argv[1])
helper = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(helper)
request = json.loads(sys.argv[2])
helper.OPENSSL = request['openssl']
try:
    print(json.dumps({'result': getattr(helper, request['call'])(*request['args'])}))
except helper.HelperError as error:
    print(json.dumps({'exit_code': error.exit_code, 'reason': error.reason}))
`;

// The helper verifies Ed25519 with `openssl pkeyutl -rawin`, which needs
// OpenSSL 3. macOS ships LibreSSL as /usr/bin/openssl, so search PATH too.
const openssl = [...(process.env.PATH ?? '').split(delimiter), '/usr/bin']
  .map(directory => join(directory, 'openssl'))
  .find(path => existsSync(path) && /^OpenSSL [3-9]\./.test(spawnSync(path, ['version'], { encoding: 'utf8' }).stdout ?? ''));
const python = spawnSync('python3', ['-I', '-c', 'import sys; assert sys.version_info >= (3, 8)']).status === 0;
const missing = !python ? 'python3 3.8+ is not on PATH' : !openssl ? 'no OpenSSL 3 with pkeyutl -rawin' : '';
const dpkgDeb = existsSync('/usr/bin/dpkg-deb');

const uid = process.getuid?.() ?? 0;
const nowMs = Date.now();
const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const HOUR = 60 * 60 * 1000;
const FEED = 'https://updates.example.test/stable/feed.json';
const ORIGIN = 'https://updates.example.test';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Reply = { result?: Record<string, unknown>; exit_code?: number; reason?: string };
type Manifest = Record<string, unknown> & { artifacts: Array<Record<string, unknown>> };
interface Fixture { root: string; identity: string; feed: string; deb: string; checkpoint: string; payload: Buffer }

function helper(call: string, args: unknown[]): Reply {
  const result = spawnSync('python3', ['-I', '-B', '-c', DRIVER, helperPath, JSON.stringify({ call, args, openssl })], { encoding: 'utf8', timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Reply;
}

function setup({ channel = 'stable', deb = Buffer.from('the signed package'), manifest, envelope }: {
  channel?: string;
  deb?: Buffer;
  manifest?: (value: Manifest) => void;
  envelope?: (value: { payload: string; signature: string }) => void;
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'echo-update-helper-'));
  roots.push(root);
  const signed = Buffer.from('the signed package');
  const identity = join(root, 'echo-desktop-identity.v1.json');
  writeFileSync(identity, `${JSON.stringify({
    schema_version: 1, kind: 'echo-desktop-identity-v1', release_id: 'clean-v1-20261012-001',
    release_record_sha256: 'd'.repeat(64), source_sha: 'e'.repeat(40), product_version: '0.1.0-internal.5',
    person_client_artifact_sha256: 'f'.repeat(64), platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'electron',
    update_bootstrap: {
      schema_version: 1, kind: 'echo-client-update-config-v1', channel, feed_url: FEED,
      public_key_spki: spki, minimum_sequence: 3, automatic: true, installation: 'electron',
    },
  })}\n`);
  chmodSync(identity, 0o644);
  const value: Manifest = {
    schema_version: 1, kind: 'echo-client-update-manifest-v1', channel: 'stable', sequence: 7,
    issued_at: iso(-HOUR), expires_at: iso(7 * 24 * HOUR), release_id: 'clean-v1-20261013-001',
    release_sha256: 'a'.repeat(64), source_sha: 'b'.repeat(40), product_version: '0.1.0-internal.6',
    artifacts: [
      { platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'cli-kit', url: `${ORIGIN}/stable/artifacts/${'1'.repeat(64)}.zip`, sha256: '1'.repeat(64), bytes: 10 },
      { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'cli-kit', url: `${ORIGIN}/stable/artifacts/${'2'.repeat(64)}.zip`, sha256: '2'.repeat(64), bytes: 10 },
      { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'electron', url: `${ORIGIN}/stable/artifacts/${'3'.repeat(64)}.zip`, sha256: '3'.repeat(64), bytes: 10 },
      { platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'electron', url: `${ORIGIN}/stable/artifacts/${sha256(signed)}.deb`, sha256: sha256(signed), bytes: signed.length },
    ],
  };
  manifest?.(value);
  const payload = Buffer.from(JSON.stringify(value));
  const sealed = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
  envelope?.(sealed);
  const feed = join(root, 'feed.json');
  writeFileSync(feed, JSON.stringify(sealed));
  writeFileSync(join(root, 'update.deb'), deb);
  return { root, identity, feed, deb: join(root, 'update.deb'), checkpoint: join(root, 'update-checkpoint.json'), payload };
}

function verify(fixture: Fixture): Reply {
  return helper('verify_update', [fixture.identity, fixture.feed, fixture.deb, fixture.checkpoint, nowMs / 1000, uid]);
}

function saveCheckpoint(fixture: Fixture, sequence: number, digest: string): void {
  writeFileSync(fixture.checkpoint, `${JSON.stringify({ manifest_sha256: digest, schema_version: 1, sequence })}\n`, { mode: 0o600 });
}

function refused(reply: Reply, exitCode: number, reason?: string): void {
  expect(reply.result).toBeUndefined();
  expect(reply.exit_code).toBe(exitCode);
  if (reason) expect(reply.reason).toBe(reason);
}

it('ships as an isolated, executable Python script', () => {
  expect(readFileSync(helperPath, 'utf8').split('\n')[0]).toBe('#!/usr/bin/python3 -I');
  expect(statSync(helperPath).mode & 0o111).toBe(0o111);
});

describe.skipIf(missing !== '')(`Linux update helper${missing ? ` (skipped: ${missing})` : ''}`, () => {
  it('accepts a signed update for this package and reports what to checkpoint', () => {
    const fixture = setup();
    expect(verify(fixture)).toEqual({
      result: { sequence: 7, manifest_sha256: sha256(fixture.payload), release_id: 'clean-v1-20261013-001' },
    });
  });

  it('refuses a payload or signature changed after signing', () => {
    refused(verify(setup({ envelope: value => {
      value.payload = Buffer.from(Buffer.from(value.payload, 'base64').toString('utf8').replace('"sequence":7', '"sequence":9')).toString('base64');
    } })), 3, 'invalid_signature');
    refused(verify(setup({ envelope: value => {
      const signature = Buffer.from(value.signature, 'base64');
      signature[0] = (signature[0] ?? 0) ^ 1;
      value.signature = signature.toString('base64');
    } })), 3, 'invalid_signature');
  });

  it('refuses another channel, expired metadata and metadata issued in the future', () => {
    refused(verify(setup({ channel: 'beta' })), 3, 'wrong_channel');
    refused(verify(setup({ manifest: value => { value.issued_at = iso(-2 * HOUR); value.expires_at = iso(-60_000); } })), 3, 'expired_metadata');
    refused(verify(setup({ manifest: value => { value.issued_at = iso(10 * 60_000); } })), 3, 'expired_metadata');
  });

  it('refuses a package whose bytes the feed did not sign', () => {
    refused(verify(setup({ deb: Buffer.from('another package') })), 3, 'artifact_mismatch');
  });

  it('refuses a feed without the Linux desktop artifact', () => {
    refused(verify(setup({ manifest: value => {
      value.artifacts = value.artifacts.filter(artifact => !(artifact.platform === 'linux' && artifact.installation === 'electron'));
    } })), 3, 'unsupported_platform');
  });

  it('refuses any artifact on another origin', () => {
    refused(verify(setup({ manifest: value => {
      const artifact = value.artifacts[2];
      if (artifact) artifact.url = `https://elsewhere.example.test/stable/artifacts/${'3'.repeat(64)}.zip`;
    } })), 3, 'wrong_artifact_origin');
  });

  it('refuses a rollback below the checkpoint and a changed manifest at the same sequence', () => {
    const fixture = setup();
    saveCheckpoint(fixture, 8, 'c'.repeat(64));
    refused(verify(fixture), 3, 'stale_metadata');
    saveCheckpoint(fixture, 7, 'c'.repeat(64));
    refused(verify(fixture), 3, 'changed_metadata');
    saveCheckpoint(fixture, 7, sha256(fixture.payload));
    expect(verify(fixture).result).toMatchObject({ sequence: 7 });
  });

  it('refuses a symlinked feed or identity, and an oversized feed', () => {
    const feed = setup();
    const realFeed = join(feed.root, 'real-feed.json');
    writeFileSync(realFeed, readFileSync(feed.feed));
    rmSync(feed.feed);
    symlinkSync(realFeed, feed.feed);
    refused(verify(feed), 2);

    const identity = setup();
    const realIdentity = join(identity.root, 'real-identity.json');
    writeFileSync(realIdentity, readFileSync(identity.identity), { mode: 0o644 });
    rmSync(identity.identity);
    symlinkSync(realIdentity, identity.identity);
    refused(verify(identity), 3);

    const oversized = setup();
    writeFileSync(oversized.feed, Buffer.alloc(65_537, 0x20));
    refused(verify(oversized), 2);
  });

  it('refuses an identity that group or others can write', () => {
    for (const mode of [0o664, 0o646]) {
      const fixture = setup();
      chmodSync(fixture.identity, mode);
      refused(verify(fixture), 3);
    }
  });

  it.skipIf(!dpkgDeb)(`reads the package control fields${dpkgDeb ? '' : ' (skipped: needs /usr/bin/dpkg-deb)'}`, () => {
    const fixture = setup();
    const control = join(fixture.root, 'package', 'DEBIAN');
    mkdirSync(control, { recursive: true });
    chmodSync(control, 0o755);
    writeFileSync(join(control, 'control'), [
      'Package: echo-desktop', 'Version: 0.1.0', 'Architecture: amd64', 'Maintainer: EchoBrain', 'Description: ECHO', '',
    ].join('\n'));
    const deb = join(fixture.root, 'echo-desktop.deb');
    expect(spawnSync('/usr/bin/dpkg-deb', ['--root-owner-group', '--build', join(fixture.root, 'package'), deb]).status).toBe(0);
    expect(helper('read_control', [deb]).result).toMatchObject({ Package: 'echo-desktop', Architecture: 'amd64' });
  });
});
