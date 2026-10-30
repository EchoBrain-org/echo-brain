// The Linux root helper (ADR-0035) re-verifies a desktop update before apt
// installs it. main needs root, so its checks and install run here as plain
// functions, install with stand-in paths and commands.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helperPath = resolve(import.meta.dirname, '../../linux/echo-desktop-update-helper');
const DRIVER = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader('echo_desktop_update_helper', sys.argv[1])
helper = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(helper)
call, args, patch = json.loads(sys.argv[2])
for name, value in patch.items():
    setattr(helper, name, value)
try:
    print(json.dumps({'result': getattr(helper, call)(*args)}))
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
const ORIGIN = 'https://updates.example.test';
const SIGNED = Buffer.from('the signed package');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Reply = { result?: unknown; exit_code?: number; reason?: string };
type Manifest = Record<string, unknown> & { artifacts: Array<Record<string, unknown>> };
type Envelope = { payload: string; signature: string; [field: string]: string };
type Patch = Record<string, string | number>;
interface Options { channel?: string; deb?: Buffer; manifest?: (value: Manifest) => void; envelope?: (value: Envelope) => void }
interface Fixture { root: string; identity: string; feed: string; deb: string; checkpoint: string; payload: Buffer }

const driver = (call: string, args: unknown[], patch: Patch = {}) =>
  ['-I', '-B', '-c', DRIVER, helperPath, JSON.stringify([call, args, { OPENSSL: openssl, ...patch }])];

function helper(call: string, args: unknown[]): Reply {
  const result = spawnSync('python3', driver(call, args), { encoding: 'utf8', timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Reply;
}

// Runs install() in the background, since it prints "verified" and then waits
// for app to exit.
function install(fixture: Fixture, app: ChildProcess, patch: Patch) {
  const child = spawn('python3', driver('install', [fixture.feed, fixture.deb, app.pid, uid], patch));
  children.push(child);
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  const lines = () => stdout.trim().split('\n');
  const done = new Promise<Reply>((settle, fail) => child.on('close', status => {
    if (status === 0) settle(JSON.parse(lines().at(-1) ?? '') as Reply);
    else fail(new Error(`helper install exited ${status}`));
  }));
  done.catch(() => undefined); // A test that fails first kills the child; its own assertion reports.
  const verified = async (withinMs: number) => {
    for (const deadline = Date.now() + withinMs; Date.now() < deadline; await delay(50)) {
      if (lines().includes('verified')) return true;
    }
    return false;
  };
  return { done, verified, lines };
}

const delay = (ms: number) => new Promise(settle => setTimeout(settle, ms));

function shellScript(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

// A stand-in for the app, running until quit.
function startApp(): ChildProcess {
  const app = spawn('sleep', ['60']);
  children.push(app);
  return app;
}

// Resolves once the app is reaped, so the helper's os.kill(pid, 0) no longer finds it.
async function quit(app: ChildProcess): Promise<void> {
  if (app.exitCode !== null || app.signalCode !== null) return;
  const exited = new Promise(settle => app.once('exit', settle));
  app.kill();
  await exited;
}

// Moves path aside and leaves a symlink to it in its place.
function symlinkInPlace(path: string): void {
  renameSync(path, `${path}.real`);
  symlinkSync(`${path}.real`, path);
}

function setup({ channel = 'stable', deb = SIGNED, manifest, envelope }: Options = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'echo-update-helper-'));
  roots.push(root);
  const identity = join(root, 'echo-desktop-identity.v1.json');
  writeFileSync(identity, `${JSON.stringify({
    schema_version: 1, kind: 'echo-desktop-identity-v1', release_id: 'clean-v1-20261012-001', platform: 'linux', installation: 'electron',
    update_bootstrap: {
      schema_version: 1, kind: 'echo-client-update-config-v1', channel, feed_url: `${ORIGIN}/stable/feed.json`,
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
      { platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'electron', url: `${ORIGIN}/stable/artifacts/${sha256(SIGNED)}.deb`, sha256: sha256(SIGNED), bytes: SIGNED.length },
    ],
  };
  manifest?.(value);
  const payload = Buffer.from(JSON.stringify(value));
  const sealed: Envelope = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
  envelope?.(sealed);
  const feed = join(root, 'feed.json');
  writeFileSync(feed, JSON.stringify(sealed));
  writeFileSync(join(root, 'update.deb'), deb);
  return { root, identity, feed, deb: join(root, 'update.deb'), checkpoint: join(root, 'update-checkpoint.json'), payload };
}

// install() pointed at the fixture: a private state folder of its own, an
// apt-get that logs its arguments (after whether the app's process still
// exists, when app is given) and prints to stdout, a dpkg-deb that prints
// control, and a wait for the app's exit short enough for a test.
function installPatch(fixture: Fixture, { app, control = ['Package: echo-desktop', 'Architecture: amd64'], waitSeconds = 20, aptStatus = 0 }: {
  app?: number; control?: string[]; waitSeconds?: number; aptStatus?: number;
} = {}) {
  const state = join(fixture.root, 'state');
  mkdirSync(state, { mode: 0o700 });
  const aptLog = join(fixture.root, 'apt-get.log');
  const liveness = app === undefined ? '' : `if kill -0 ${app} 2>/dev/null; then printf 'app running ' >> '${aptLog}'; else printf 'app exited ' >> '${aptLog}'; fi\n`;
  const checkpoint = join(state, 'update-checkpoint.json');
  // Whether the checkpoint was raised before apt-get ran.
  const saved = `if [ -f '${checkpoint}' ]; then printf 'checkpoint saved ' >> '${aptLog}'; fi\n`;
  const patch = {
    IDENTITY: fixture.identity, STATE: state, CHECKPOINT: checkpoint, LOCK: join(state, 'update.lock'),
    APT_GET: shellScript(fixture.root, 'apt-get', `${liveness}${saved}echo "$@" >> '${aptLog}'\necho 'apt-get output'\nexit ${aptStatus}`),
    DPKG_DEB: shellScript(fixture.root, 'dpkg-deb', `printf '%s\\n' ${control.map(line => `'${line}'`).join(' ')}`),
    EXIT_WAIT_SECONDS: waitSeconds,
  };
  return { state, aptLog, checkpoint, patch };
}

function verify(fixture: Fixture, trustedUid = uid): Reply {
  return helper('verify_update', [fixture.identity, fixture.feed, fixture.deb, fixture.checkpoint, nowMs / 1000, trustedUid]);
}

function saveCheckpoint(fixture: Fixture, sequence: number, digest: string): void {
  writeFileSync(fixture.checkpoint, `${JSON.stringify({ manifest_sha256: digest, schema_version: 1, sequence })}\n`, { mode: 0o600 });
}

function refused(reply: Reply, exitCode: number, reason?: string): void {
  expect(reply.result).toBeUndefined();
  expect(reply.exit_code).toBe(exitCode);
  if (reason) expect(reply.reason).toBe(reason);
}

const desktop = (value: Manifest) => value.artifacts[3]!;

it('ships as an isolated, executable Python script', () => {
  expect(readFileSync(helperPath, 'utf8').split('\n')[0]).toBe('#!/usr/bin/python3 -I');
  expect(statSync(helperPath).mode & 0o111).toBe(0o111);
});

describe.skipIf(missing !== '')(`Linux update helper${missing ? ` (skipped: ${missing})` : ''}`, () => {
  it('accepts a signed update for this package and reports what to checkpoint', () => {
    const fixture = setup();
    expect(verify(fixture)).toEqual({ result: { schema_version: 1, sequence: 7, manifest_sha256: sha256(fixture.payload) } });
  });

  it.each<[string, Options, string]>([
    ['a payload changed after signing', { envelope: value => {
      value.payload = Buffer.from(Buffer.from(value.payload, 'base64').toString('utf8').replace('"sequence":7', '"sequence":9')).toString('base64');
    } }, 'invalid_signature'],
    ['a signature changed after signing', { envelope: value => {
      const signature = Buffer.from(value.signature, 'base64');
      signature[0] = (signature[0] ?? 0) ^ 1;
      value.signature = signature.toString('base64');
    } }, 'invalid_signature'],
    ['an envelope with another field', { envelope: value => { value.note = 'unsigned'; } }, 'invalid_metadata'],
    ['a payload that is not strict base64', { envelope: value => { value.payload += ' '; } }, 'invalid_signature'],
    ['a signature that is not 64 bytes', { envelope: value => { value.signature = Buffer.alloc(63).toString('base64'); } }, 'invalid_signature'],
    ['a manifest of another kind', { manifest: value => { value.kind = 'echo-client-update-manifest-v2'; } }, 'invalid_metadata'],
    ['a manifest of another schema version', { manifest: value => { value.schema_version = 2; } }, 'invalid_metadata'],
    ['another channel', { channel: 'beta' }, 'wrong_channel'],
    ['expired metadata', { manifest: value => { value.issued_at = iso(-2 * HOUR); value.expires_at = iso(-60_000); } }, 'expired_metadata'],
    ['metadata issued in the future', { manifest: value => { value.issued_at = iso(10 * 60_000); } }, 'expired_metadata'],
    ['metadata that lives longer than 31 days', { manifest: value => { value.expires_at = iso(31 * 24 * HOUR); } }, 'invalid_metadata'],
    ['a sequence below the bootstrap floor without any checkpoint', { manifest: value => { value.sequence = 2; } }, 'stale_metadata'],
    ['an artifact on another origin', { manifest: value => {
      value.artifacts[2]!.url = `https://elsewhere.example.test/stable/artifacts/${'3'.repeat(64)}.zip`;
    } }, 'wrong_artifact_origin'],
    ['a feed without the Linux desktop artifact', { manifest: value => { value.artifacts.splice(3, 1); } }, 'unsupported_platform'],
    ['a feed with two Linux desktop artifacts', { manifest: value => { value.artifacts.push({ ...desktop(value) }); } }, 'invalid_metadata'],
    ['a package whose bytes the feed did not sign, even at the signed size', { deb: Buffer.from('the signed packagE') }, 'artifact_mismatch'],
    ['a package of another size than the feed signed', { manifest: value => { desktop(value).bytes = SIGNED.length + 1; } }, 'artifact_mismatch'],
  ])('refuses %s', (_, options, reason) => {
    refused(verify(setup(options)), 3, reason);
  });

  it('trusts only an identity the trusted owner wrote, that group and others cannot write, and not through a symlink', () => {
    const fixture = setup();
    refused(verify(fixture, uid + 1), 3, 'untrusted_identity');
    for (const mode of [0o664, 0o646]) {
      chmodSync(fixture.identity, mode);
      refused(verify(fixture), 3, 'untrusted_identity');
    }
    chmodSync(fixture.identity, 0o644);
    symlinkInPlace(fixture.identity);
    refused(verify(fixture), 3);
  });

  it('refuses a symlinked or oversized feed as invalid input', () => {
    const linked = setup();
    symlinkInPlace(linked.feed);
    refused(verify(linked), 2);
    const oversized = setup();
    writeFileSync(oversized.feed, Buffer.alloc(65_537, 0x20));
    refused(verify(oversized), 2);
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

  it('saves the checkpoint once the app exits, then reinstalls the root-only copy', async () => {
    const fixture = setup();
    const app = startApp();
    const { state, aptLog, checkpoint, patch } = installPatch(fixture, { app: app.pid });
    const run = install(fixture, app, patch);
    expect(await run.verified(10_000)).toBe(true);
    // Room for a helper that skipped the wait to reach apt-get while the app still runs.
    await delay(750);
    expect(existsSync(aptLog)).toBe(false);
    await quit(app);
    expect(await run.done).toEqual({ result: 0 });
    // "verified" is all the helper prints; apt-get's output goes to stderr.
    expect(run.lines().slice(0, -1)).toEqual(['verified']);
    // apt-get runs once, on the root-only copy, never the path the app passed.
    const logged = readFileSync(aptLog, 'utf8');
    const copy = logged.trim().split(' ').at(-1) ?? '';
    expect(logged).toBe(`app exited checkpoint saved -o DPkg::Lock::Timeout=120 install --reinstall -y ${copy}\n`);
    expect(copy.startsWith(`${state}/install-`) && copy.endsWith('/update.deb')).toBe(true);
    expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toEqual({ schema_version: 1, sequence: 7, manifest_sha256: sha256(fixture.payload) });
  }, 30_000);

  it.each<[string, string[] | undefined, number, string, boolean]>([
    ['a package named otherwise', ['Package: echo-desktop-other', 'Architecture: amd64'], 3, 'wrong_package', false],
    ['a package for another architecture', ['Package: echo-desktop', 'Architecture: arm64'], 3, 'wrong_package', false],
    ['an app that never exits', undefined, 4, 'the app did not exit', true],
  ])('refuses %s without apt-get or a checkpoint', async (_, control, exitCode, reason, printedVerified) => {
    const fixture = setup();
    const app = startApp();
    const { aptLog, checkpoint, patch } = installPatch(fixture, { app: app.pid, control, waitSeconds: 0.5 });
    const run = install(fixture, app, patch);
    refused(await run.done, exitCode, reason);
    expect(run.lines().includes('verified')).toBe(printedVerified);
    expect(app.exitCode).toBeNull();
    expect(existsSync(aptLog)).toBe(false);
    expect(existsSync(checkpoint)).toBe(false);
  }, 30_000);

  it('keeps the raised checkpoint when apt-get fails: an older feed stays refused, the same one may retry', async () => {
    // apt-get may have unpacked the new release before failing, or the helper
    // may be killed after it: the floor must already be up.
    const fixture = setup();
    const app = startApp();
    await quit(app);
    const { checkpoint, patch } = installPatch(fixture, { aptStatus: 100 });
    refused(await install(fixture, app, patch).done, 5, 'apt-get failed');
    expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toEqual({ schema_version: 1, sequence: 7, manifest_sha256: sha256(fixture.payload) });
    const older = setup({ manifest: value => { value.sequence = 6; } });
    refused(helper('verify_update', [older.identity, older.feed, older.deb, checkpoint, nowMs / 1000, uid]), 3, 'stale_metadata');
    expect(helper('verify_update', [fixture.identity, fixture.feed, fixture.deb, checkpoint, nowMs / 1000, uid]).result).toMatchObject({ sequence: 7 });
  }, 30_000);

  it('installs one update at a time, so a later helper cannot install an older release over a newer one', async () => {
    // Two seats: A staged sequence 9 and B a still-valid sequence 8. Both
    // passwords were approved before either app quit.
    const newer = setup({ manifest: value => { value.sequence = 9; } });
    const older = setup({ manifest: value => { value.sequence = 8; } });
    const { aptLog, checkpoint, patch } = installPatch(newer);
    const [appA, appB] = [startApp(), startApp()];
    const a = install(newer, appA, patch);
    expect(await a.verified(10_000)).toBe(true);
    const b = install(older, appB, patch);
    // B must not verify against the checkpoint that A is about to raise.
    expect(await b.verified(1_500)).toBe(false);
    await quit(appA);
    expect(await a.done).toEqual({ result: 0 });
    await quit(appB);
    refused(await b.done, 3, 'stale_metadata');
    expect(readFileSync(aptLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toEqual({ schema_version: 1, sequence: 9, manifest_sha256: sha256(newer.payload) });
    expect(statSync(patch.LOCK).mode & 0o777).toBe(0o600);
  }, 30_000);

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
