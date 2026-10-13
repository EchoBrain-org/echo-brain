// The app's updater (ADR-0035). The signed-feed rules live in the release-bound
// Person client's updater core; this is the desktop installation it drives:
// when the updater may run, what the sidebar row shows, how a verified release
// is staged, and the detached script that activates it once the app quits.
// Main hands it everything it touches, so nothing here imports Electron.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Failure, UpdateState } from '../shared/protocol.js';
import { RELAUNCHER, SWAP_HELPER } from './update-scripts.js';

export const IDENTITY_FILE = 'echo-desktop-identity.v1.json';
const HELPER = 'echo-desktop-update-helper';
const LINUX_RESOURCES = '/opt/ECHO/resources';
const BUNDLE_ID = 'org.echobrain.echo-desktop';
const RELEASE_ID = /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/;
const CHECK_DELAY_MS = 10_000;
// The core's hourly gate decides when the feed is due. Asking every ten
// minutes keeps a tick that lands just inside that hour from skipping the next.
const CHECK_INTERVAL_MS = 10 * 60_000;

/** The absolute commands an update runs. Tests replace some. */
export interface Commands { unzip: string; ditto: string; plutil: string; codesign: string; open: string; pkexec: string; helper: string; launcher: string }
const COMMANDS: Commands = {
  unzip: '/usr/bin/unzip', ditto: '/usr/bin/ditto', plutil: '/usr/bin/plutil', codesign: '/usr/bin/codesign', open: '/usr/bin/open',
  pkexec: '/usr/bin/pkexec', helper: join(LINUX_RESOURCES, HELPER), launcher: '/usr/bin/echo-desktop',
};

// ---- what main calls in the release-bound client's dist/client-update.js ----
// Declared here from src/product/person-client/client-update.ts and
// client-update-kit.ts: the app loads the copy it shipped, never this checkout's.

/** The one target each desktop package installs. */
export interface UpdateTarget { platform: 'darwin' | 'linux'; architecture: 'arm64' | 'x64'; libc: 'glibc' | null; installation: 'electron' }
export interface UpdateInstallerInput {
  root: string;
  archive: string;
  manifest: { release_id: string; release_sha256: string };
  artifact: { url: string; sha256: string; bytes: number };
  /** The installation's fingerprint(), captured before download. */
  expected_wrapper_sha256: string;
  /** The exact verified feed bytes, which the Linux root helper verifies again. */
  feed: Buffer;
}
export interface ClientUpdateInstallation {
  installedRelease(): string;
  installedReleaseSha256(): string;
  fingerprint(): string;
  install(input: UpdateInstallerInput): void | Promise<void>;
  activation: 'immediate' | 'restart';
  archive_name: string;
  download_timeout_ms: number;
}
export interface ClientUpdateResult {
  kind: 'echo-client-update-result-v1';
  status: string;
  platform: string;
  installed_release: string;
  running_release: string | null;
  available_release: string | null;
  checked_at: number | null;
}
interface ClientUpdateRun {
  root: string;
  platform: UpdateTarget;
  installation: ClientUpdateInstallation;
  running_release: string;
  /** The app quits through its own path: the core must not re-raise a signal. */
  handle_signals: false;
  fetch: typeof fetch;
}
export interface ClientUpdateModule {
  runClientUpdate(mode: 'apply' | 'automatic', dependencies: ClientUpdateRun): Promise<ClientUpdateResult>;
  configureClientUpdates(root: string, raw: unknown, installation: ClientUpdateInstallation): void;
  readClientUpdateConfig(root: string): object | undefined;
  releaseInterruptedClientUpdate(root: string): void;
}

// ---- identity and setup ----------------------------------------------------

/** echo-desktop-identity.v1.json, which only release packaging writes. */
export interface DesktopIdentity extends Omit<UpdateTarget, 'installation'> {
  schema_version: 1;
  kind: 'echo-desktop-identity-v1';
  release_id: string;
  release_record_sha256: string;
  installation: 'electron';
  /** The client update config this release pins on first run. */
  update_bootstrap: unknown;
}

/** An update stopped for a reason the log names; the core records it as update_failed. */
class UpdateRefusal extends Error {
  constructor(readonly code: string) { super(`ECHO update: ${code}`); }
}
const refuse = (code: string): never => { throw new UpdateRefusal(code); };

/** A refusal's or the core's code for the log: a code, never a message or a path. */
export function updateCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z_]{1,64}$/.test(code) ? code : 'update_failed';
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A regular file, never a link, that this user (or root, when allowed) owns and no one else can write. */
function readOwned(path: string, limit: number, rootOwned: boolean): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || !(stats.uid === process.getuid?.() || (rootOwned && stats.uid === 0)) || (stats.mode & 0o022) !== 0 || stats.size > limit) {
      refuse('unsafe_file');
    }
    const bytes = readFileSync(fd);
    if (bytes.length > limit) refuse('unsafe_file');
    return bytes;
  } finally { closeSync(fd); }
}

/** The identity at `path`, for `target`, and its exact bytes. */
export function readIdentity(path: string, target: UpdateTarget): { identity: DesktopIdentity; bytes: Buffer } {
  try {
    const bytes = readOwned(path, 64 * 1024, true);
    const value = JSON.parse(bytes.toString('utf8')) as Partial<DesktopIdentity> | null;
    if (value === null || typeof value !== 'object' || value.schema_version !== 1 || value.kind !== 'echo-desktop-identity-v1' ||
        typeof value.release_id !== 'string' || !RELEASE_ID.test(value.release_id) ||
        typeof value.release_record_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.release_record_sha256) ||
        value.platform !== target.platform || value.architecture !== target.architecture || value.libc !== target.libc || value.installation !== 'electron') {
      refuse('invalid_identity');
    }
    return { identity: value as DesktopIdentity, bytes };
  } catch (error) {
    throw new UpdateRefusal((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no_identity' : 'invalid_identity');
  }
}

export interface UpdaterHost {
  packaged: boolean;
  smoke: boolean;
  test_build: boolean;
  platform: string;
  arch: string;
  exec_path: string;
  resources_path: string;
  app_data: string;
  /** Where the Linux package puts its resources; tests name another folder. */
  linux_resources?: string;
}
export interface UpdaterSetup {
  /** <appData>/ECHO/desktop, beside Chromium's ECHO/chromium and apart from the CLI's root. */
  root: string;
  target: UpdateTarget;
  identity_path: string;
  /** The identity read at launch: the release this process runs. */
  identity: DesktopIdentity;
  /** macOS: the running ECHO.app. */
  bundle: string | null;
}

/**
 * The updater runs only in a packaged release that is not a smoke run or a
 * test build, carries a valid identity, and is installed where it can replace
 * itself: an .app bundle on macOS arm64, or /opt/ECHO with the root-owned
 * helper on Linux x64. Otherwise it stays off and says why.
 */
export function updaterSetup(host: UpdaterHost): UpdaterSetup | { off: string } {
  if (!host.packaged) return { off: 'not_packaged' };
  if (host.smoke) return { off: 'smoke' };
  if (host.test_build) return { off: 'test_build' };
  // Electron's Linux builds run on glibc only.
  const target: UpdateTarget | null = host.platform === 'darwin' && host.arch === 'arm64' ? { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'electron' }
    : host.platform === 'linux' && host.arch === 'x64' ? { platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'electron' } : null;
  if (!target) return { off: 'unsupported_platform' };
  const identity_path = join(host.resources_path, IDENTITY_FILE);
  let identity: DesktopIdentity;
  try { identity = readIdentity(identity_path, target).identity; } catch (error) { return { off: updateCode(error) }; }
  const bundle = target.platform === 'darwin' ? resolve(host.exec_path, '..', '..', '..') : null;
  const installed = bundle !== null
    ? bundle.endsWith('.app') && host.resources_path === join(bundle, 'Contents', 'Resources') && kind(bundle) === 'directory'
    : host.resources_path === (host.linux_resources ?? LINUX_RESOURCES) && rootOnly(join(host.resources_path, HELPER));
  if (!installed) return { off: 'unsupported_installation' };
  return { root: join(host.app_data, 'ECHO', 'desktop'), target, identity_path, identity, bundle };
}

function kind(path: string): 'directory' | 'file' | 'other' | null {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
  } catch { return null; }
}

/** pkexec runs the helper as root: only root may have written it. */
function rootOnly(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && stats.uid === 0 && (stats.mode & 0o022) === 0;
  } catch { return false; }
}

// ---- what the row shows ----------------------------------------------------

/** Why update.install will not run now, or null. A row that changed under the click wins over held work. */
export function installRefusal(state: UpdateState, release: unknown, unresolved: boolean): Failure | null {
  if (state.state === 'none' || state.state === 'installing' || release !== state.release) return { code: 'update_changed', retryable: false };
  return unresolved ? { code: 'update_held', retryable: true } : null;
}

/**
 * The row after an automatic check: an available release, or newer files
 * already installed (restart to use them). Nothing else changes it. An install
 * in progress stays, and so does a failure until a different release appears.
 */
export function checkedState(current: UpdateState, result: Pick<ClientUpdateResult, 'status' | 'installed_release' | 'available_release'>): UpdateState {
  const release = result.status === 'available' ? result.available_release : result.status === 'running_release_mismatch' ? result.installed_release : null;
  if (current.state === 'installing' || typeof release !== 'string' || !RELEASE_ID.test(release)) return current;
  if (current.state === 'failed' && current.release === release) return current;
  return { state: result.status === 'available' ? 'available' : 'restart', release };
}

interface Outcome { schema_version: 1; release: string; status: 'installed' | 'failed' | 'cancelled' }

/** Reads and removes the outcome a swap helper or relauncher left: null when there is none to use. */
function takeOutcome(updater: string): Outcome | null {
  const path = join(updater, 'outcome.json');
  let value: Partial<Outcome> | null = null;
  try {
    value = JSON.parse(readOwned(path, 4096, false).toString('utf8')) as Partial<Outcome> | null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  }
  rmSync(path, { force: true });
  return value !== null && typeof value === 'object' && value.schema_version === 1 && typeof value.release === 'string' && RELEASE_ID.test(value.release) &&
    (value.status === 'installed' || value.status === 'failed' || value.status === 'cancelled') ? value as Outcome : null;
}

/**
 * The last install's outcome, at launch. The expected release running clears
 * the row and what the install left, the previous macOS bundle included; any
 * other end shows the failure. A cancelled prompt shows nothing.
 */
export function launchOutcome(root: string, running: string): UpdateState | null {
  const updater = join(root, 'updater');
  const outcome = takeOutcome(updater);
  if (!outcome || outcome.status === 'cancelled') return null;
  if (outcome.status === 'failed' || outcome.release !== running) return { state: 'failed', release: outcome.release, reason: 'failed' };
  for (const name of readdirSync(updater)) {
    if (['previous', 'staged', 'progress'].includes(name) || /^activate-.*\.sh$/.test(name)) rmSync(join(updater, name), { recursive: true, force: true });
  }
  return { state: 'none' };
}

// ---- staging -----------------------------------------------------------------

const run = promisify(execFile);
/** A command's output, or a refusal with `code` when it fails. Never a shell. */
async function output(command: string, args: readonly string[], code: string): Promise<string> {
  try {
    return (await run(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 })).stdout;
  } catch { return refuse(code); }
}

/**
 * macOS: the verified ZIP expands to exactly one ECHO.app with ECHO's bundle
 * id and an intact signature, whose identity names the manifest's release and
 * this target. It must sit on the running bundle's volume, so the swap is a
 * rename.
 */
async function stageBundle(input: UpdateInstallerInput, staged: string, bundle: string, target: UpdateTarget, commands: Commands): Promise<void> {
  const entries = (await output(commands.unzip, ['-Z1', input.archive], 'invalid_archive')).split('\n').filter(Boolean);
  if (entries.length === 0 || entries.some(entry => !entry.startsWith('ECHO.app/') || isAbsolute(entry) || entry.split('/').includes('..'))) {
    refuse('invalid_archive');
  }
  await output(commands.ditto, ['-x', '-k', input.archive, staged], 'invalid_archive');
  const app = join(staged, 'ECHO.app');
  if (readdirSync(staged).join('/') !== 'ECHO.app' || kind(app) !== 'directory') refuse('invalid_archive');
  const id = await output(commands.plutil, ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')], 'wrong_bundle_id');
  if (id.trim() !== BUNDLE_ID) refuse('wrong_bundle_id');
  await output(commands.codesign, ['--verify', '--deep', '--strict', app], 'invalid_signature');
  const { identity } = readIdentity(join(app, 'Contents', 'Resources', IDENTITY_FILE), target);
  if (identity.release_id !== input.manifest.release_id || identity.release_record_sha256 !== input.manifest.release_sha256) refuse('release_mismatch');
  if (statSync(staged).dev !== statSync(dirname(bundle)).dev) refuse('other_volume');
}

/** Linux: the verified package and the exact feed, for the root helper to check again. */
async function stagePackage(input: UpdateInstallerInput, staged: string): Promise<void> {
  const deb = join(staged, 'echo-desktop.deb');
  await copyFile(input.archive, deb, constants.COPYFILE_EXCL);
  await chmod(deb, 0o600);
  await writeFile(join(staged, 'feed.json'), input.feed, { mode: 0o600, flag: 'wx' });
}

/**
 * The app as the core's installation: its release is the identity on disk,
 * which another Linux user's update can change under it, and an install stages
 * the verified update in <root>/updater/staged for activation after the quit.
 */
export function desktopInstallation(setup: Pick<UpdaterSetup, 'root' | 'target' | 'identity_path' | 'bundle'>, commands: Partial<Commands>,
  log: (line: string) => void): ClientUpdateInstallation {
  const mac = setup.target.platform === 'darwin';
  const tools = { ...COMMANDS, ...commands };
  const disk = () => readIdentity(setup.identity_path, setup.target);
  return {
    installedRelease: () => disk().identity.release_id,
    installedReleaseSha256: () => disk().identity.release_record_sha256,
    fingerprint: () => sha256(disk().bytes),
    install: async input => {
      const staged = join(setup.root, 'updater', 'staged');
      await rm(staged, { recursive: true, force: true });
      try {
        // The race guard: files installed during the download are not the ones checked.
        if (sha256(disk().bytes) !== input.expected_wrapper_sha256) refuse('installation_changed');
        await mkdir(staged, { mode: 0o700 });
        if (mac) await stageBundle(input, staged, setup.bundle!, setup.target, tools);
        else await stagePackage(input, staged);
      } catch (error) {
        log(`update staging ${updateCode(error)}`);
        await rm(staged, { recursive: true, force: true });
        throw error;
      }
    },
    activation: 'restart',
    archive_name: mac ? 'ECHO.zip' : 'echo-desktop.deb',
    download_timeout_ms: 15 * 60_000,
  };
}

// ---- the updater -------------------------------------------------------------

export interface UpdaterDependencies extends UpdaterSetup {
  client: ClientUpdateModule;
  pid: number;
  fetch: typeof fetch;
  /** Main holds the row; set() also tells the page. */
  state(): UpdateState;
  set(next: UpdateState): void;
  /** Main holds unresolved work: a save or a project change whose outcome is unknown. */
  held(): boolean;
  /** The app's normal quit: the host drains, and work unresolved by then is asked about. */
  quit(): void;
  relaunch(): void;
  log(line: string): void;
  /** Starts `/bin/bash script args…` detached. */
  start?: (args: readonly string[]) => void;
  commands?: Partial<Commands>;
  poll_ms?: number;
}
export interface Updater {
  /** At launch, under the single-instance lock. False leaves the updater off. */
  launch(): boolean;
  check(): Promise<void>;
  /** Installs the row's release, or relaunches into files already installed. Refusals are main's. */
  install(release: string): Promise<void>;
}

/** `/bin/bash script args…` in its own session, so it outlives the quit. */
function detached(args: readonly string[]): void {
  const child = spawn('/bin/bash', args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* no pid: refused below */ });
  if (child.pid === undefined) refuse('activation_unavailable');
  child.unref();
}

/** Readable text up to 4 KiB, or '' while the file is not there. */
function readSmall(path: string): string {
  try { return readOwned(path, 4096, false).toString('utf8'); } catch { return ''; }
}

export function createUpdater(deps: UpdaterDependencies): Updater {
  const { root, target, client, log } = deps;
  const mac = target.platform === 'darwin';
  const commands = { ...COMMANDS, ...deps.commands };
  const updater = join(root, 'updater');
  const outcome = join(updater, 'outcome.json');
  const progress = join(updater, 'progress');
  const installation = desktopInstallation(deps, commands, log);
  const runs: ClientUpdateRun = { root, platform: target, installation, running_release: deps.identity.release_id, handle_signals: false, fetch: deps.fetch };
  let checking: Promise<void> | null = null;
  /** Checks repeat their answer hourly: only a change is sent. Each install step is, so a click always hears back. */
  const show = (next: UpdateState) => { if (JSON.stringify(next) !== JSON.stringify(deps.state())) deps.set(next); };
  const failed = (release: string, reason: 'failed' | 'location' = 'failed') => deps.set({ state: 'failed', release, reason });

  /** Writes the activation script and starts it. Every value is an argument. */
  function activate(release: string): void {
    const staged = join(updater, 'staged');
    const script = join(updater, `activate-${randomUUID()}.sh`);
    // An earlier attempt's progress and outcome are not this one's.
    rmSync(outcome, { force: true });
    rmSync(progress, { force: true });
    writeFileSync(script, mac ? SWAP_HELPER : RELAUNCHER, { mode: 0o700, flag: 'wx' });
    const pid = String(deps.pid);
    (deps.start ?? detached)([script, ...mac
      ? [pid, deps.bundle!, join(staged, 'ECHO.app'), join(updater, 'previous', 'ECHO.app'), outcome, release, commands.open]
      : [pid, join(staged, 'feed.json'), join(staged, 'echo-desktop.deb'), progress, outcome, release, commands.pkexec, commands.helper, commands.launcher]]);
  }

  /**
   * After activation, until the app exits. Linux quits once the root helper has
   * verified the update. A script that ends while the app still runs did not
   * install: a cancelled password prompt puts the row back, and anything else,
   * such as a quit the person cancelled at the unresolved-work question until
   * the script's wait ran out, shows the failure.
   */
  function watch(release: string): void {
    let quitting = mac;
    const timer = setInterval(() => {
      if (!quitting && /^verified$/m.test(readSmall(progress))) {
        quitting = true;
        deps.quit();
        return;
      }
      const ended = takeOutcome(updater);
      if (!ended) return;
      clearInterval(timer);
      log(`update install ${ended.status}`);
      // Cancelled at the password prompt: the release is still there to install.
      if (ended.status === 'cancelled') deps.set({ state: 'available', release }); else failed(release);
    }, deps.poll_ms ?? 250);
    timer.unref();
  }

  return {
    launch() {
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        chmodSync(root, 0o700);
        client.releaseInterruptedClientUpdate(root);
        const last = launchOutcome(root, deps.identity.release_id);
        if (last) show(last);
        // First run pins this release's bootstrap. Every later launch offers its
        // own again: the same trust is kept, and a different one (another key,
        // feed, channel or sequence floor) stops updates with already_configured.
        // The pinned automatic choice is the person's and survives.
        const pinned = client.readClientUpdateConfig(root) as { automatic?: unknown } | undefined;
        client.configureClientUpdates(root, pinned ? { ...(deps.identity.update_bootstrap as Record<string, unknown>), automatic: pinned.automatic } : deps.identity.update_bootstrap, installation);
        return true;
      } catch (error) {
        log(`update off ${updateCode(error)}`);
        show({ state: 'none' });
        return false;
      }
    },
    async check() {
      if (checking || deps.state().state === 'installing') return;
      checking = (async () => {
        try {
          const result = await client.runClientUpdate('automatic', runs);
          log(`update check ${result.status}`);
          show(checkedState(deps.state(), result));
        } catch (error) {
          log(`update check ${updateCode(error)}`);
        }
      })();
      try { await checking; } finally { checking = null; }
    },
    async install(release) {
      if (deps.state().state === 'restart') {
        deps.relaunch();
        deps.quit();
        return;
      }
      if (mac ? !movable(deps.bundle!, root) : !existsSync(commands.pkexec)) return failed(release, mac ? 'location' : 'failed');
      deps.set({ state: 'installing', release });
      // A check holding the core's lock would make this apply busy.
      await checking;
      let result: ClientUpdateResult;
      try {
        result = await client.runClientUpdate('apply', runs);
      } catch (error) {
        log(`update install ${updateCode(error)}`);
        return failed(release);
      }
      log(`update install ${result.status}`);
      if (result.status === 'current') return deps.set({ state: 'none' });
      if (result.status === 'running_release_mismatch' && RELEASE_ID.test(result.installed_release)) {
        return deps.set({ state: 'restart', release: result.installed_release });
      }
      const staged = result.available_release;
      if (result.status !== 'staged' || staged === null || !RELEASE_ID.test(staged)) return failed(release);
      // The click found nothing unresolved, but the page kept working through
      // the download. The quit would cut off what started since, so offer the
      // release again (the core keeps a staged release on offer) and start nothing.
      if (deps.held()) {
        log('update install held');
        return deps.set({ state: 'available', release: staged });
      }
      try {
        activate(staged);
      } catch (error) {
        log(`update activate ${updateCode(error)}`);
        return failed(release);
      }
      if (mac) deps.quit();
      watch(staged);
    },
  };
}

/**
 * macOS replaces the bundle by renames: it must be writable, in a writable
 * folder on the updater's volume, and not translocated. Checked before the
 * download, so an app that cannot be replaced never fetches one.
 */
function movable(bundle: string, root: string): boolean {
  if (bundle.includes('/AppTranslocation/')) return false;
  try {
    accessSync(bundle, constants.W_OK);
    accessSync(dirname(bundle), constants.W_OK);
    return statSync(root).dev === statSync(dirname(bundle)).dev;
  } catch { return false; }
}

/** Creates the updater and runs its launch, then checks about 10 s later and every ten minutes. Null when it stays off. */
export function startUpdater(deps: UpdaterDependencies): Updater | null {
  const updater = createUpdater(deps);
  if (!updater.launch()) return null;
  setTimeout(() => void updater.check(), CHECK_DELAY_MS).unref();
  setInterval(() => void updater.check(), CHECK_INTERVAL_MS).unref();
  return updater;
}
