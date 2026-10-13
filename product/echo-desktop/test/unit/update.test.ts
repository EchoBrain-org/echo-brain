// The app's updater (ADR-0035) with fakes for the release-bound client, the
// detached script and the quit: no Electron. macOS staging runs the real
// unzip, ditto, plutil and codesign against an ad-hoc signed stand-in bundle.
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../src/shared/protocol.js';
import {
  checkedState, createUpdater, desktopInstallation, IDENTITY_FILE, installRefusal, launchOutcome, readIdentity, updaterSetup,
  type ClientUpdateModule, type ClientUpdateResult, type UpdateInstallerInput, type UpdateTarget,
} from '../../src/main/update.js';
import { RELAUNCHER, SWAP_HELPER } from '../../src/main/update-scripts.js';

const MAC: UpdateTarget = { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'electron' };
const LINUX: UpdateTarget = { platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'electron' };
const A = 'clean-v1-release-a';
const B = 'clean-v1-release-b';
const C = 'clean-v1-release-c';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const folders: string[] = [];
const locked: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const path of locked.splice(0)) chmodSync(path, 0o755);
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

function folder(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'echo-update-')));
  folders.push(path);
  return path;
}

function identityOf(target: UpdateTarget, release = A, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1, kind: 'echo-desktop-identity-v1', release_id: release, release_record_sha256: sha256(release),
    source_sha: 'a'.repeat(40), product_version: '0.1.0', person_client_artifact_sha256: 'b'.repeat(64),
    ...target, update_bootstrap: { pinned: release }, ...extra,
  };
}
function writeJson(path: string, value: unknown, mode = 0o644): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode });
  chmodSync(path, mode);
}

/** A seat: a running bundle (or /opt/ECHO stand-in) carrying release A, and the app's private update root. */
function seat(target = MAC) {
  const base = folder();
  const bundle = join(base, 'Applications', 'ECHO.app');
  const resources = target.platform === 'darwin' ? join(bundle, 'Contents', 'Resources') : join(base, 'opt', 'ECHO', 'resources');
  const identity_path = join(resources, IDENTITY_FILE);
  writeJson(identity_path, identityOf(target));
  const root = join(base, 'appData', 'ECHO', 'desktop');
  const updater = join(root, 'updater');
  mkdirSync(updater, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const pkexec = join(base, 'pkexec');
  writeFileSync(pkexec, '', { mode: 0o700 });
  return { base, bundle, resources, identity_path, root, updater, pkexec, target };
}

const result = (status: string, extra: Partial<ClientUpdateResult> = {}): ClientUpdateResult => ({
  kind: 'echo-client-update-result-v1', status, platform: 'test', installed_release: A, running_release: A, available_release: null, checked_at: null, ...extra,
});

function fakeClient(apply: ClientUpdateResult | Error = result('staged', { available_release: B })) {
  return {
    runClientUpdate: vi.fn(async (mode: 'apply' | 'automatic') => {
      if (mode === 'automatic') return result('available', { available_release: B });
      if (apply instanceof Error) throw apply;
      return apply;
    }),
    configureClientUpdates: vi.fn(),
    readClientUpdateConfig: vi.fn((): object | undefined => undefined),
    releaseInterruptedClientUpdate: vi.fn(),
  } satisfies ClientUpdateModule;
}

function harness(options: { target?: UpdateTarget; client?: ReturnType<typeof fakeClient>; state?: UpdateState; bundle?: string; pkexec?: string } = {}) {
  const s = seat(options.target);
  const client = options.client ?? fakeClient();
  let state: UpdateState = options.state ?? { state: 'available', release: B };
  const sent: UpdateState[] = [];
  const started: string[][] = [];
  const quit = vi.fn();
  const relaunch = vi.fn();
  const log = vi.fn();
  const fetcher = vi.fn() as unknown as typeof fetch;
  let holding = false;
  const updater = createUpdater({
    root: s.root, target: s.target, identity_path: s.identity_path, identity: readIdentity(s.identity_path, s.target).identity,
    bundle: s.target.platform === 'darwin' ? options.bundle ?? s.bundle : null,
    client, pid: 4242, fetch: fetcher, state: () => state, set: next => { state = next; sent.push(next); }, held: () => holding,
    quit, relaunch, log, start: args => { started.push([...args]); }, commands: { pkexec: options.pkexec ?? s.pkexec }, poll_ms: 10,
  });
  /** Main's unresolved work, as the page reports it. */
  const hold = (held: boolean) => { holding = held; };
  return { ...s, client, run: updater, sent, started, quit, relaunch, log, fetcher, hold, state: () => state };
}

describe('the desktop identity', () => {
  it('reads a release identity the user or root owns and no one else can write', () => {
    const s = seat();
    const { identity, bytes } = readIdentity(s.identity_path, MAC);
    expect(identity).toMatchObject({ release_id: A, release_record_sha256: sha256(A), update_bootstrap: { pinned: A } });
    expect(bytes).toEqual(readFileSync(s.identity_path));
  });

  it('refuses a writable, linked, malformed or other-platform identity', () => {
    const s = seat();
    const refuse = (value: unknown, mode = 0o644) => {
      writeJson(s.identity_path, value, mode);
      expect(() => readIdentity(s.identity_path, MAC)).toThrow('invalid_identity');
    };
    refuse(identityOf(MAC), 0o664);
    refuse(identityOf(MAC), 0o646);
    refuse(identityOf(MAC, 'clean-v1-X'));
    refuse(identityOf(MAC, 'release-a'));
    refuse(identityOf(MAC, A, { kind: 'echo-desktop-identity-v2' }));
    refuse(identityOf(MAC, A, { release_record_sha256: 'nope' }));
    refuse(identityOf(LINUX));
    refuse('not an object');
    writeJson(join(s.base, 'real.json'), identityOf(MAC));
    rmSync(s.identity_path);
    symlinkSync(join(s.base, 'real.json'), s.identity_path);
    expect(() => readIdentity(s.identity_path, MAC)).toThrow('invalid_identity');
  });
});

describe('when the updater runs', () => {
  const host = (s: ReturnType<typeof seat>, extra: Partial<Parameters<typeof updaterSetup>[0]> = {}) => ({
    packaged: true, smoke: false, test_build: false, platform: 'darwin', arch: 'arm64',
    exec_path: join(s.bundle, 'Contents', 'MacOS', 'ECHO'), resources_path: s.resources, app_data: join(s.base, 'appData'), ...extra,
  });

  it('runs a packaged macOS arm64 release bundle, with its state beside Chromium', () => {
    const s = seat();
    expect(updaterSetup(host(s))).toEqual({
      root: join(s.base, 'appData', 'ECHO', 'desktop'), target: MAC, identity_path: s.identity_path, bundle: s.bundle,
      identity: readIdentity(s.identity_path, MAC).identity,
    });
  });

  it('stays off for development, smoke, test and unsupported builds', () => {
    const s = seat();
    expect(updaterSetup(host(s, { packaged: false }))).toEqual({ off: 'not_packaged' });
    expect(updaterSetup(host(s, { smoke: true }))).toEqual({ off: 'smoke' });
    expect(updaterSetup(host(s, { test_build: true }))).toEqual({ off: 'test_build' });
    expect(updaterSetup(host(s, { arch: 'x64' }))).toEqual({ off: 'unsupported_platform' });
    expect(updaterSetup(host(s, { platform: 'win32', arch: 'x64' }))).toEqual({ off: 'unsupported_platform' });
    // An executable outside an .app bundle, or one whose resources are not its own.
    expect(updaterSetup(host(s, { exec_path: join(s.base, 'ECHO', 'Contents', 'MacOS', 'ECHO') }))).toEqual({ off: 'unsupported_installation' });
    rmSync(s.identity_path);
    expect(updaterSetup(host(s))).toEqual({ off: 'no_identity' });
    writeJson(s.identity_path, identityOf(MAC), 0o666);
    expect(updaterSetup(host(s))).toEqual({ off: 'invalid_identity' });
  });

  it('runs on Linux only from /opt/ECHO with a root-owned helper', () => {
    const s = seat(LINUX);
    const linux = host(s, { platform: 'linux', arch: 'x64', exec_path: join(s.resources, '..', 'echo-desktop') });
    // This test's resources are not /opt/ECHO/resources.
    expect(updaterSetup(linux)).toEqual({ off: 'unsupported_installation' });
    writeFileSync(join(s.resources, 'echo-desktop-update-helper'), '#!/usr/bin/python3\n', { mode: 0o755 });
    // The test user, not root, owns this helper.
    expect(updaterSetup({ ...linux, linux_resources: s.resources })).toEqual(
      process.getuid?.() === 0 ? expect.objectContaining({ target: LINUX, bundle: null }) : { off: 'unsupported_installation' },
    );
  });
});

describe('what a check shows', () => {
  const available = (release: string) => result('available', { available_release: release });

  it('announces an available release, and files on disk that name another as a restart', () => {
    expect(checkedState({ state: 'none' }, available(B))).toEqual({ state: 'available', release: B });
    expect(checkedState({ state: 'available', release: B }, available(C))).toEqual({ state: 'available', release: C });
    expect(checkedState({ state: 'none' }, result('running_release_mismatch', { installed_release: B }))).toEqual({ state: 'restart', release: B });
  });

  it('leaves the row as it is for every other status', () => {
    const shown: UpdateState = { state: 'available', release: B };
    for (const status of ['current', 'not_due', 'not_configured', 'automatic_disabled', 'update_busy', 'invalid_signature', 'staged']) {
      expect(checkedState(shown, result(status, { available_release: C }))).toBe(shown);
    }
    expect(checkedState(shown, result('available'))).toBe(shown);
  });

  it('never replaces installing, and keeps a failure until a different release appears', () => {
    const installing: UpdateState = { state: 'installing', release: B };
    expect(checkedState(installing, available(C))).toBe(installing);
    const failed: UpdateState = { state: 'failed', release: B, reason: 'failed' };
    expect(checkedState(failed, available(B))).toBe(failed);
    expect(checkedState(failed, available(C))).toEqual({ state: 'available', release: C });
    expect(checkedState(failed, result('running_release_mismatch', { installed_release: B }))).toBe(failed);
  });
});

describe('what install refuses', () => {
  it('holds an install while work is unresolved', () => {
    expect(installRefusal({ state: 'available', release: B }, B, true)).toEqual({ code: 'update_held', retryable: true });
  });

  it('refuses a release the row no longer shows, and a row with nothing to install', () => {
    const changed = { code: 'update_changed', retryable: false };
    expect(installRefusal({ state: 'available', release: B }, C, false)).toEqual(changed);
    expect(installRefusal({ state: 'none' }, B, false)).toEqual(changed);
    expect(installRefusal({ state: 'installing', release: B }, B, false)).toEqual(changed);
    expect(installRefusal({ state: 'installing', release: B }, B, true)).toEqual(changed);
    expect(installRefusal({ state: 'available', release: B }, 7, false)).toEqual(changed);
  });

  it('lets the shown release install, restart or try again', () => {
    expect(installRefusal({ state: 'available', release: B }, B, false)).toBeNull();
    expect(installRefusal({ state: 'restart', release: B }, B, false)).toBeNull();
    expect(installRefusal({ state: 'failed', release: B, reason: 'location' }, B, false)).toBeNull();
  });
});

describe('the outcome of the last install, at launch', () => {
  function leftovers(root: string, outcome: unknown) {
    const updater = join(root, 'updater');
    for (const path of ['previous/ECHO.app/Contents', 'staged/ECHO.app/Contents']) mkdirSync(join(updater, path), { recursive: true });
    writeFileSync(join(updater, 'progress'), 'verified\n');
    writeFileSync(join(updater, 'activate-1.sh'), '#!/bin/bash\n', { mode: 0o700 });
    writeFileSync(join(updater, 'state.json'), '{}\n', { mode: 0o600 });
    if (outcome !== undefined) writeJson(join(updater, 'outcome.json'), outcome, 0o600);
    return updater;
  }

  it('clears the row and every leftover when the expected release is running', () => {
    const s = seat();
    const updater = leftovers(s.root, { schema_version: 1, release: B, status: 'installed' });
    expect(launchOutcome(s.root, B)).toEqual({ state: 'none' });
    expect(readdirSync(updater)).toEqual(['state.json']);
  });

  it('shows a failure when another release is running after an install, or the install failed', () => {
    const s = seat();
    const updater = leftovers(s.root, { schema_version: 1, release: B, status: 'installed' });
    expect(launchOutcome(s.root, A)).toEqual({ state: 'failed', release: B, reason: 'failed' });
    expect(existsSync(join(updater, 'outcome.json'))).toBe(false);
    // The old bundle stays until the expected release starts.
    expect(existsSync(join(updater, 'previous', 'ECHO.app'))).toBe(true);
    writeJson(join(updater, 'outcome.json'), { schema_version: 1, release: B, status: 'failed' }, 0o600);
    expect(launchOutcome(s.root, A)).toEqual({ state: 'failed', release: B, reason: 'failed' });
    expect(existsSync(join(updater, 'outcome.json'))).toBe(false);
  });

  it('shows nothing for a cancelled prompt, a missing outcome or one it cannot read', () => {
    const s = seat();
    const updater = leftovers(s.root, { schema_version: 1, release: B, status: 'cancelled' });
    expect(launchOutcome(s.root, A)).toBeNull();
    expect(existsSync(join(updater, 'outcome.json'))).toBe(false);
    expect(launchOutcome(s.root, A)).toBeNull();
    for (const outcome of [{ schema_version: 2, release: B, status: 'installed' }, { schema_version: 1, release: 'B', status: 'installed' }, { schema_version: 1, release: B, status: 'done' }]) {
      writeJson(join(updater, 'outcome.json'), outcome, 0o600);
      expect(launchOutcome(s.root, B)).toBeNull();
      expect(existsSync(join(updater, 'outcome.json'))).toBe(false);
    }
    expect(existsSync(join(updater, 'staged', 'ECHO.app'))).toBe(true);
  });
});

describe('launch', () => {
  it('releases an interrupted run, then reads the outcome, then pins the embedded bootstrap', () => {
    const h = harness({ state: { state: 'none' } });
    writeJson(join(h.updater, 'outcome.json'), { schema_version: 1, release: C, status: 'failed' }, 0o600);
    expect(h.run.launch()).toBe(true);
    expect(h.client.releaseInterruptedClientUpdate).toHaveBeenCalledWith(h.root);
    expect(h.sent).toEqual([{ state: 'failed', release: C, reason: 'failed' }]);
    expect(h.client.configureClientUpdates).toHaveBeenCalledWith(h.root, { pinned: A }, expect.objectContaining({ activation: 'restart', archive_name: 'ECHO.zip', download_timeout_ms: 900_000 }));
    expect(h.client.releaseInterruptedClientUpdate.mock.invocationCallOrder[0]).toBeLessThan(h.client.configureClientUpdates.mock.invocationCallOrder[0]!);
    expect(statSync(h.root).mode & 0o777).toBe(0o700);
  });

  it('offers its bootstrap to an existing pin on every launch, and stays off when the pin refuses this app', () => {
    const h = harness({ state: { state: 'none' } });
    h.client.readClientUpdateConfig.mockReturnValue({ automatic: false });
    expect(h.run.launch()).toBe(true);
    // The core rewrites the same trust and refuses a different one: the app never skips that check.
    expect(h.client.configureClientUpdates).toHaveBeenCalledWith(h.root, { pinned: A, automatic: false }, expect.objectContaining({ activation: 'restart' }));
    h.client.configureClientUpdates.mockImplementationOnce(() => { throw Object.assign(new Error('ECHO update: already_configured'), { code: 'already_configured' }); });
    writeJson(join(h.updater, 'outcome.json'), { schema_version: 1, release: C, status: 'failed' }, 0o600);
    expect(h.run.launch()).toBe(false);
    expect(h.log).toHaveBeenCalledWith('update off already_configured');
    // A row the updater cannot act on is not shown.
    expect(h.state()).toEqual({ state: 'none' });
  });
});

describe('checks', () => {
  it('runs the automatic check for the running release, and shows what it found', async () => {
    const h = harness({ state: { state: 'none' } });
    await h.run.check();
    expect(h.client.runClientUpdate).toHaveBeenCalledWith('automatic', {
      root: h.root, platform: MAC, installation: expect.objectContaining({ activation: 'restart' }), running_release: A, handle_signals: false, fetch: h.fetcher,
    });
    expect(h.sent).toEqual([{ state: 'available', release: B }]);
    // The same answer again sends nothing.
    await h.run.check();
    expect(h.sent).toHaveLength(1);
  });

  it('only logs a failed check, and skips one while installing', async () => {
    const h = harness({ state: { state: 'none' } });
    h.client.runClientUpdate.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'invalid_config' }));
    await h.run.check();
    expect(h.sent).toEqual([]);
    expect(h.log).toHaveBeenCalledWith('update check invalid_config');
    const busy = harness({ state: { state: 'installing', release: B } });
    await busy.run.check();
    expect(busy.client.runClientUpdate).not.toHaveBeenCalled();
  });
});

describe('install', () => {
  it('relaunches into files already installed, without installing', async () => {
    const h = harness({ state: { state: 'restart', release: B } });
    await h.run.install(B);
    expect(h.relaunch).toHaveBeenCalledOnce();
    expect(h.relaunch.mock.invocationCallOrder[0]).toBeLessThan(h.quit.mock.invocationCallOrder[0]!);
    expect(h.client.runClientUpdate).not.toHaveBeenCalled();
  });

  it('asks for Applications when macOS runs the app translocated or from a folder it cannot write', async () => {
    const translocated = harness({ bundle: '/private/var/folders/x/AppTranslocation/1234/d/ECHO.app' });
    await translocated.run.install(B);
    expect(translocated.sent).toEqual([{ state: 'failed', release: B, reason: 'location' }]);
    // Clicked again from the same row: the page still hears back.
    await translocated.run.install(B);
    expect(translocated.sent).toHaveLength(2);
    expect(translocated.client.runClientUpdate).not.toHaveBeenCalled();
    if (process.getuid?.() === 0) return; // root writes anywhere
    const readOnly = harness();
    chmodSync(join(readOnly.bundle, '..'), 0o555);
    locked.push(join(readOnly.bundle, '..'));
    await readOnly.run.install(B);
    expect(readOnly.sent).toEqual([{ state: 'failed', release: B, reason: 'location' }]);
    expect(readOnly.client.runClientUpdate).not.toHaveBeenCalled();
  });

  it('fails on Linux without pkexec, before downloading anything', async () => {
    const h = harness({ target: LINUX, pkexec: '/nonexistent/pkexec' });
    await h.run.install(B);
    expect(h.sent).toEqual([{ state: 'failed', release: B, reason: 'failed' }]);
    expect(h.client.runClientUpdate).not.toHaveBeenCalled();
  });

  it('shows the outcome of an apply that staged nothing', async () => {
    for (const [apply, shown] of [
      [new Error('download_failed'), { state: 'failed', release: B, reason: 'failed' }],
      [result('update_busy'), { state: 'failed', release: B, reason: 'failed' }],
      [result('current', { available_release: B }), { state: 'none' }],
      [result('running_release_mismatch', { installed_release: C }), { state: 'restart', release: C }],
    ] as const) {
      const h = harness({ client: fakeClient(apply) });
      await h.run.install(B);
      expect(h.sent).toEqual([{ state: 'installing', release: B }, shown]);
      expect(h.started).toEqual([]);
      expect(h.quit).not.toHaveBeenCalled();
    }
  });

  it('on macOS stages, starts the swap helper detached and quits at once', async () => {
    const h = harness();
    await h.run.install(B);
    expect(h.client.runClientUpdate).toHaveBeenCalledWith('apply', expect.objectContaining({ root: h.root, platform: MAC, running_release: A, handle_signals: false }));
    expect(h.sent).toEqual([{ state: 'installing', release: B }]);
    expect(h.started).toHaveLength(1);
    const [script, ...args] = h.started[0]!;
    expect(script).toMatch(new RegExp(`^${h.updater}/activate-[0-9a-f-]{36}\\.sh$`));
    expect(readFileSync(script!, 'utf8')).toBe(SWAP_HELPER);
    expect(statSync(script!).mode & 0o777).toBe(0o700);
    expect(args).toEqual(['4242', h.bundle, join(h.updater, 'staged', 'ECHO.app'), join(h.updater, 'previous', 'ECHO.app'),
      join(h.updater, 'outcome.json'), B, '/usr/bin/open']);
    expect(h.quit).toHaveBeenCalledOnce();
    expect(h.relaunch).not.toHaveBeenCalled();
  });

  it('offers the staged release again, and starts nothing, when work became unresolved during the download', async () => {
    for (const target of [MAC, LINUX]) {
      const h = harness({ target });
      // The person sent a note after the click, and it is still sending when the apply returns.
      h.client.runClientUpdate.mockImplementationOnce(async () => { h.hold(true); return result('staged', { available_release: C }); });
      await h.run.install(B);
      expect(h.sent, target.platform).toEqual([{ state: 'installing', release: B }, { state: 'available', release: C }]);
      expect(h.started, target.platform).toEqual([]);
      expect(h.log, target.platform).toHaveBeenCalledWith('update install held');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(h.quit, target.platform).not.toHaveBeenCalled();
    }
  });

  it('keeps watching after the quit, so one the person cancelled at the unresolved-work question shows the failure', async () => {
    for (const target of [MAC, LINUX]) {
      const h = harness({ target });
      await h.run.install(B);
      // macOS quits at once; Linux once the root helper has verified the update.
      if (target === LINUX) writeFileSync(join(h.updater, 'progress'), 'verified\n');
      await expect.poll(() => h.quit.mock.calls.length).toBe(1);
      // ECHO stayed open, so the script's wait for it ran out.
      writeJson(join(h.updater, 'outcome.json'), { schema_version: 1, release: B, status: 'failed' }, 0o600);
      await expect.poll(() => h.sent.length, { message: target.platform }).toBe(2);
      expect(h.sent[1], target.platform).toEqual({ state: 'failed', release: B, reason: 'failed' });
      expect(h.quit, target.platform).toHaveBeenCalledOnce();
    }
  });

  it('on Linux starts the relauncher and quits once the helper has verified the update', async () => {
    const h = harness({ target: LINUX });
    writeFileSync(join(h.updater, 'outcome.json'), 'stale');
    await h.run.install(B);
    const [script, ...args] = h.started[0]!;
    expect(readFileSync(script!, 'utf8')).toBe(RELAUNCHER);
    const progress = join(h.updater, 'progress');
    expect(args).toEqual(['4242', join(h.updater, 'staged', 'feed.json'), join(h.updater, 'staged', 'echo-desktop.deb'), progress,
      join(h.updater, 'outcome.json'), B, h.pkexec, '/opt/ECHO/resources/echo-desktop-update-helper', '/usr/bin/echo-desktop']);
    // An earlier attempt's outcome is not this one's.
    expect(existsSync(join(h.updater, 'outcome.json'))).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.quit).not.toHaveBeenCalled();
    writeFileSync(progress, 'verified\n');
    await expect.poll(() => h.quit.mock.calls.length).toBe(1);
    expect(h.sent).toEqual([{ state: 'installing', release: B }]);
  });

  it('on Linux goes back to the row a cancelled or failed prompt left', async () => {
    for (const [status, shown] of [
      ['cancelled', { state: 'available', release: B }],
      ['failed', { state: 'failed', release: B, reason: 'failed' }],
    ] as const) {
      const h = harness({ target: LINUX });
      await h.run.install(B);
      writeJson(join(h.updater, 'outcome.json'), { schema_version: 1, release: B, status }, 0o600);
      await expect.poll(() => h.sent.length).toBe(2);
      expect(h.sent[1]).toEqual(shown);
      expect(existsSync(join(h.updater, 'outcome.json'))).toBe(false);
      expect(h.quit).not.toHaveBeenCalled();
    }
  });
});

describe('staging an update', () => {
  function input(s: ReturnType<typeof seat>, archive: string, manifest = { release_id: B, release_sha256: sha256(B) }): UpdateInstallerInput {
    return {
      root: s.root, archive, manifest: manifest as UpdateInstallerInput['manifest'], artifact: {} as UpdateInstallerInput['artifact'],
      expected_wrapper_sha256: sha256(readFileSync(s.identity_path)), feed: Buffer.from('{"payload":"","signature":""}'),
    };
  }

  it('on Linux copies the verified package and the exact feed for the root helper, private to the user', async () => {
    const s = seat(LINUX);
    const deb = join(s.base, 'downloaded.deb');
    writeFileSync(deb, 'a verified package', { mode: 0o600 });
    mkdirSync(join(s.updater, 'staged', 'old'), { recursive: true });
    const installation = desktopInstallation(s, {}, () => {});
    expect(installation).toMatchObject({ activation: 'restart', archive_name: 'echo-desktop.deb', download_timeout_ms: 900_000 });
    const given = input(s, deb);
    await installation.install(given);
    expect(readdirSync(join(s.updater, 'staged')).sort()).toEqual(['echo-desktop.deb', 'feed.json']);
    expect(readFileSync(join(s.updater, 'staged', 'echo-desktop.deb'), 'utf8')).toBe('a verified package');
    expect(readFileSync(join(s.updater, 'staged', 'feed.json'))).toEqual(given.feed);
    for (const name of ['echo-desktop.deb', 'feed.json']) expect(statSync(join(s.updater, 'staged', name)).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.updater, 'staged')).mode & 0o777).toBe(0o700);
  });

  it('reads the installed release, its record and its fingerprint from the identity on disk', async () => {
    const s = seat(LINUX);
    const installation = desktopInstallation(s, {}, () => {});
    expect([installation.installedRelease(), installation.installedReleaseSha256(), installation.fingerprint()])
      .toEqual([A, sha256(A), sha256(readFileSync(s.identity_path))]);
    const deb = join(s.base, 'downloaded.deb');
    writeFileSync(deb, 'a verified package', { mode: 0o600 });
    const given = input(s, deb);
    // Another user updated /opt/ECHO during the download.
    writeJson(s.identity_path, identityOf(LINUX, C));
    expect(installation.installedRelease()).toBe(C);
    await expect(installation.install(given)).rejects.toThrow('installation_changed');
    expect(existsSync(join(s.updater, 'staged'))).toBe(false);
  });

  describe.runIf(process.platform === 'darwin')('on macOS', () => {
    /** An ad-hoc signed stand-in ECHO.app, zipped as electron-builder ships it. */
    function signedApp(s: ReturnType<typeof seat>, options: { bundleId?: string; release?: string; tamper?: boolean; extra?: boolean } = {}): string {
      const work = mkdtempSync(join(s.base, 'build-'));
      const app = join(work, 'ECHO.app');
      mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
      execFileSync('/bin/cp', ['/usr/bin/true', join(app, 'Contents', 'MacOS', 'ECHO')]);
      writeFileSync(join(app, 'Contents', 'Info.plist'), [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        `<key>CFBundleIdentifier</key><string>${options.bundleId ?? 'org.echobrain.echo-desktop'}</string>`,
        '<key>CFBundleExecutable</key><string>ECHO</string><key>CFBundlePackageType</key><string>APPL</string>',
        '</dict></plist>', '',
      ].join('\n'));
      const release = options.release ?? B;
      writeJson(join(app, 'Contents', 'Resources', IDENTITY_FILE), identityOf(MAC, release));
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
      if (options.tamper) writeFileSync(join(app, 'Contents', 'Resources', 'added.txt'), 'after signing');
      if (options.extra) writeFileSync(join(work, 'outside.txt'), 'not in the bundle');
      const zip = join(s.base, `ECHO-${Math.random().toString(16).slice(2)}.zip`);
      execFileSync('/usr/bin/ditto', options.extra ? ['-c', '-k', work, zip] : ['-c', '-k', '--keepParent', app, zip]);
      return zip;
    }
    const staged = (s: ReturnType<typeof seat>) => join(s.updater, 'staged');

    it('accepts a signed ECHO.app that names the manifest release, staged beside the running bundle', async () => {
      const s = seat();
      const installation = desktopInstallation(s, {}, () => {});
      expect(installation).toMatchObject({ archive_name: 'ECHO.zip' });
      await installation.install(input(s, signedApp(s)));
      expect(readdirSync(staged(s))).toEqual(['ECHO.app']);
      expect(readIdentity(join(staged(s), 'ECHO.app', 'Contents', 'Resources', IDENTITY_FILE), MAC).identity.release_id).toBe(B);
      expect(statSync(staged(s)).mode & 0o777).toBe(0o700);
    });

    it('refuses another bundle id, a broken signature, another release or an entry outside ECHO.app, and removes what it staged', async () => {
      const s = seat();
      const codes: string[] = [];
      const installation = desktopInstallation(s, {}, line => { codes.push(line); });
      for (const [options, code] of [
        [{ bundleId: 'org.example.other' }, 'wrong_bundle_id'],
        [{ tamper: true }, 'invalid_signature'],
        [{ release: C }, 'release_mismatch'],
        [{ extra: true }, 'invalid_archive'],
      ] as const) {
        await expect(installation.install(input(s, signedApp(s, options))), code).rejects.toThrow(code);
        expect(existsSync(staged(s)), code).toBe(false);
      }
      expect(codes).toEqual(['update staging wrong_bundle_id', 'update staging invalid_signature', 'update staging release_mismatch', 'update staging invalid_archive']);
      // The manifest's record digest is checked too, not only its release id.
      await expect(installation.install(input(s, signedApp(s), { release_id: B, release_sha256: sha256(C) }))).rejects.toThrow('release_mismatch');
    });
  });
});

// The release-bound client this app embeds, built from this checkout: the
// shapes main declares for it must be the ones it has.
describe('with the real client updater core', () => {
  const core = resolve(import.meta.dirname, '../../../../src/product/person-client/dist/client-update.js');

  it('configures, checks and stages a Linux update through the adapter', async () => {
    const client = await import(pathToFileURL(core).href) as ClientUpdateModule;
    const s = seat(LINUX);
    rmSync(s.updater, { recursive: true });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const feedUrl = 'https://updates.example.test/staging/feed.json';
    const config = {
      schema_version: 1, kind: 'echo-client-update-config-v1', channel: 'staging', feed_url: feedUrl,
      public_key_spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), minimum_sequence: 1, automatic: true, installation: 'electron',
    };
    writeJson(s.identity_path, identityOf(LINUX, A, { update_bootstrap: config }));
    const deb = Buffer.from('the release B package');
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({
      schema_version: 1, kind: 'echo-client-update-manifest-v1', channel: 'staging', sequence: 2,
      issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 86_400_000).toISOString(),
      release_id: B, release_sha256: sha256(B), source_sha: 'c'.repeat(40), product_version: '0.1.0',
      artifacts: [{ ...LINUX, url: 'https://updates.example.test/staging/artifacts/b.deb', sha256: sha256(deb), bytes: deb.length }],
    }));
    const envelope = Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }));
    const fetcher = vi.fn(async (url: string | URL | Request) => new Response(new Uint8Array(String(url) === feedUrl ? envelope : deb)));
    let state: UpdateState = { state: 'none' };
    const started: string[][] = [];
    const quit = vi.fn();
    const updater = createUpdater({
      root: s.root, target: LINUX, identity_path: s.identity_path, identity: readIdentity(s.identity_path, LINUX).identity, bundle: null,
      client, pid: 4242, fetch: fetcher as typeof fetch, state: () => state, set: next => { state = next; }, held: () => false,
      quit, relaunch: vi.fn(), log: vi.fn(), start: args => { started.push([...args]); }, commands: { pkexec: s.pkexec }, poll_ms: 10,
    });
    expect(updater.launch()).toBe(true);
    expect(client.readClientUpdateConfig(s.root)).toEqual(config);
    await updater.check();
    expect(state).toEqual({ state: 'available', release: B });
    await updater.install(B);
    expect(state).toEqual({ state: 'installing', release: B });
    expect(readFileSync(join(s.updater, 'staged', 'echo-desktop.deb'))).toEqual(deb);
    expect(readFileSync(join(s.updater, 'staged', 'feed.json'))).toEqual(envelope);
    expect(started[0]!.slice(1, 4)).toEqual(['4242', join(s.updater, 'staged', 'feed.json'), join(s.updater, 'staged', 'echo-desktop.deb')]);
    // The core's download folder and lock are gone; only what activation needs stays.
    expect(readdirSync(s.updater).filter(name => name.startsWith('.'))).toEqual([]);
    writeJson(join(s.updater, 'outcome.json'), { schema_version: 1, release: B, status: 'cancelled' }, 0o600);
    await expect.poll(() => state).toEqual({ state: 'available', release: B });
  });

  it('re-pins the same bootstrap at each launch, and stays off once a later release carries another', async () => {
    const client = await import(pathToFileURL(core).href) as ClientUpdateModule;
    const s = seat(LINUX);
    rmSync(s.updater, { recursive: true });
    const config = {
      schema_version: 1, kind: 'echo-client-update-config-v1', channel: 'staging', feed_url: 'https://updates.example.test/staging/feed.json',
      public_key_spki: generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      minimum_sequence: 1, automatic: true, installation: 'electron',
    };
    const log = vi.fn();
    /** The app at launch, carrying `bootstrap` in its identity. */
    const launch = (bootstrap: unknown) => {
      writeJson(s.identity_path, identityOf(LINUX, A, { update_bootstrap: bootstrap }));
      let state: UpdateState = { state: 'none' };
      return createUpdater({
        root: s.root, target: LINUX, identity_path: s.identity_path, identity: readIdentity(s.identity_path, LINUX).identity, bundle: null,
        client, pid: 4242, fetch: vi.fn() as unknown as typeof fetch, state: () => state, set: next => { state = next; }, held: () => false,
        quit: vi.fn(), relaunch: vi.fn(), log,
      }).launch();
    };
    expect(launch(config)).toBe(true);
    expect(launch(config)).toBe(true);
    // The person's automatic choice is theirs: a relaunch keeps it.
    const pinned = join(s.updater, 'config.json');
    writeJson(pinned, { ...config, automatic: false }, 0o600);
    expect(launch(config)).toBe(true);
    expect(client.readClientUpdateConfig(s.root)).toEqual({ ...config, automatic: false });
    writeJson(pinned, config, 0o600);
    // A raised sequence floor, as a rotated key or feed would be: the pin stands and updates stop.
    expect(launch({ ...config, minimum_sequence: 2 })).toBe(false);
    expect(log).toHaveBeenLastCalledWith('update off already_configured');
    expect(client.readClientUpdateConfig(s.root)).toEqual(config);
  });
});
