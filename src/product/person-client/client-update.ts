import { Buffer } from 'node:buffer';
import { constants, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClientUpdateError, type ClientUpdateConfig, type ClientUpdateManifest, type UpdateCheckpoint,
  type UpdatePlatform, parseUpdateConfig, parseUpdatePlatform, platformKey, rejectUpdate,
  selectUpdateArtifact, updateDigest, updateObject, verifyUpdateEnvelope,
  UPDATE_INTERVAL_MS, UPDATE_METADATA_LIMIT,
} from './client-update-contract.js';
import { readUpdateFile, safeUpdateDirectory, updateDirectory, writeUpdateJson } from './client-update-files.js';
import { installLinuxClientUpdate } from './client-update-linux.js';
import { installMacosClientUpdate } from './client-update-macos.js';
import { type UpdateInstallerInput } from './client-update-kit.js';
import { createHash } from 'node:crypto';

interface ClientUpdateState {
  schema_version: 1;
  config_sha256: string;
  checkpoint: UpdateCheckpoint | null;
  checked_at: number;
  available_release: string | null;
  result: string;
}
export interface ClientUpdateResult {
  kind: 'echo-client-update-result-v1';
  status: string;
  platform: string;
  /** The release the installation selects: the managed `bin/echo-brain` command, or the adapter's files. */
  installed_release: string;
  /** The release whose code ran this call, when known. A launcher can bypass the managed command. */
  running_release: string | null;
  available_release: string | null;
  checked_at: number | null;
}
/** How one kind of installation reads, guards and replaces itself. Without one, the core runs the CLI's. */
export interface ClientUpdateInstallation {
  /** The release this installation selects now. */
  installedRelease(): string;
  /** The sha256 of that release's canonical record. */
  installedReleaseSha256(): string;
  /** The race guard captured before download; installers receive it as expected_wrapper_sha256. */
  fingerprint(): string;
  install(input: UpdateInstallerInput): void | Promise<void>;
  /** `restart` stages the update for the app to activate after it quits, so no activation check runs. */
  activation: 'immediate' | 'restart';
  /** File name of the downloaded archive inside the core's temporary folder. */
  archive_name: string;
  download_timeout_ms: number;
}
interface ClientUpdateDependencies {
  root: string;
  platform: UpdatePlatform;
  running_release?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Replaces the CLI platform installer; an adapter installation brings its own install(). */
  install?: (input: UpdateInstallerInput) => void | Promise<void>;
  installation?: ClientUpdateInstallation;
  /**
   * Default true. False adds no signal listeners, for an embedding process with
   * its own quit path (Electron), which must then call releaseInterruptedClientUpdate.
   */
  handle_signals?: boolean;
}
/** The stamp state.json and floor.json carry: config.json without the person's `automatic` choice. */
function configDigest(config: ClientUpdateConfig): string {
  const { automatic: _automatic, ...trust } = config;
  return updateDigest(JSON.stringify(trust));
}
/** The pin: every config field but `automatic` and the floor, which only rises. */
function pinDigest(config: ClientUpdateConfig): string {
  const { automatic: _automatic, minimum_sequence: _floor, ...pin } = config;
  return updateDigest(JSON.stringify(pin));
}
export function detectUpdatePlatform(installation: ClientUpdateConfig['installation']): UpdatePlatform {
  let libc: string | null = null;
  if (process.platform === 'linux') {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    libc = report.header?.glibcVersionRuntime ? 'glibc' : 'musl';
  }
  return parseUpdatePlatform({ platform: process.platform, architecture: process.arch, libc, installation });
}
export function readClientUpdateConfig(root: string): ClientUpdateConfig | undefined {
  const path = join(root, 'updater', 'config.json');
  if (!existsSync(path)) return undefined;
  safeUpdateDirectory(root);
  safeUpdateDirectory(join(root, 'updater'));
  return parseUpdateConfig(JSON.parse(readUpdateFile(path, UPDATE_METADATA_LIMIT).toString('utf8')));
}
function loadState(directory: string, config: ClientUpdateConfig): ClientUpdateState | undefined {
  const path = join(directory, 'state.json');
  if (!existsSync(path)) return undefined;
  const v = updateObject(JSON.parse(readUpdateFile(path, UPDATE_METADATA_LIMIT).toString('utf8')), ['schema_version', 'config_sha256', 'checkpoint', 'checked_at', 'available_release', 'result']);
  if (v.schema_version !== 1 || typeof v.checked_at !== 'number' || !Number.isFinite(v.checked_at) ||
      typeof v.result !== 'string' || !(v.available_release === null || typeof v.available_release === 'string') ||
      v.config_sha256 !== configDigest(config)) rejectUpdate('invalid_update_state');
  if (v.checkpoint !== null) {
    const c = updateObject(v.checkpoint, ['sequence', 'manifest_sha256']);
    if (!Number.isSafeInteger(c.sequence) || Number(c.sequence) < 1 || typeof c.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(c.manifest_sha256)) rejectUpdate('invalid_update_state');
  }
  return v as unknown as ClientUpdateState;
}
/** A newer build's floor, above the one config.json keeps for older builds, which never read this file. */
function raisedFloor(directory: string, config: ClientUpdateConfig): number {
  const path = join(directory, 'floor.json');
  if (!existsSync(path)) return 0;
  const bytes = readUpdateFile(path, UPDATE_METADATA_LIMIT);
  let v: Record<string, unknown>;
  try { v = updateObject(JSON.parse(bytes.toString('utf8')), ['schema_version', 'config_sha256', 'minimum_sequence']); }
  catch { return rejectUpdate('invalid_update_state'); }
  if (v.schema_version !== 1 || !Number.isSafeInteger(v.minimum_sequence) || Number(v.minimum_sequence) < 1 ||
      v.config_sha256 !== configDigest(config)) rejectUpdate('invalid_update_state');
  return v.minimum_sequence as number;
}
function installedRelease(root: string): string {
  const wrapper = readUpdateFile(join(root, 'bin', 'echo-brain'), 16 * 1024).toString('utf8');
  // The installer emits a literal versioned release path in its stable wrapper.
  const ids = [...wrapper.matchAll(/\/releases\/(clean-v1-[a-z0-9][a-z0-9-]{2,63})\//g)].map(m => m[1]);
  if (!ids.length || ids.some(id => id !== ids[0])) rejectUpdate('unsafe_installation');
  const id = ids[0];
  safeUpdateDirectory(join(root, 'releases'));
  safeUpdateDirectory(join(root, 'releases', id));
  const marker = readUpdateFile(join(root, 'releases', id, '.echo-owned-release-v1'), 128).toString('utf8').trim();
  if (marker !== id) rejectUpdate('unsafe_installation');
  return id;
}
// OS detection is independent of adapter availability. Containers are updated
// by their deployment lane; the desktop app supplies its own installation.
function cliInstaller(platform: UpdatePlatform): ClientUpdateInstallation['install'] | undefined {
  const key = platformKey(platform);
  return key === 'linux/x64/glibc/cli-kit' ? installLinuxClientUpdate : key === 'darwin/arm64/native/cli-kit' ? installMacosClientUpdate : undefined;
}
/** The managed CLI: its stable wrapper names the owned release folder, and installation activates at once. */
function cliInstallation(root: string, install: ClientUpdateInstallation['install']): ClientUpdateInstallation {
  return {
    installedRelease: () => installedRelease(root),
    installedReleaseSha256: () => updateDigest(readUpdateFile(join(root, 'releases', installedRelease(root), 'release.json'), 16 * 1024)),
    fingerprint: () => updateDigest(readUpdateFile(join(root, 'bin', 'echo-brain'), 16 * 1024)),
    install, activation: 'immediate', archive_name: 'client.zip', download_timeout_ms: 120_000,
  };
}

/**
 * Releases the lock and download folders of a run whose process ended without
 * its `finally`, as an embedding app's quit does. Call it only while no other
 * process can update this root: for the app, at launch under Electron's
 * single-instance lock, before configuring or checking. An installer that
 * reported an unknown outcome keeps its lock and staging as recovery evidence.
 */
export function releaseInterruptedClientUpdate(root: string): void {
  const directory = updateDirectory(root);
  const config = readClientUpdateConfig(root);
  if (config && loadState(directory, config)?.result === 'installation_outcome_unknown') return;
  for (const name of readdirSync(directory)) {
    if (name === '.lock' || name.startsWith('.download-')) rmSync(join(directory, name), { recursive: true, force: true });
  }
}

/** A trusted local bootstrap operation. Feed downloads cannot replace this configuration. */
export function configureClientUpdates(root: string, raw: unknown, installation?: ClientUpdateInstallation): void {
  const config = parseUpdateConfig(raw);
  const directory = updateDirectory(root);
  if (installation) installation.installedRelease(); else installedRelease(root);
  const lock = join(directory, '.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { return rejectUpdate('update_busy'); }
  try {
    const old = readClientUpdateConfig(root);
    // Reconfiguration must not reset the anti-rollback checkpoint or silently
    // replace publisher trust. A new publisher requires a separate bootstrap.
    if (old && pinDigest(old) !== pinDigest(config)) rejectUpdate('already_configured');
    // The floor only rises. config.json keeps the floor it was first pinned
    // with, so it and the state stay what older builds read. A higher floor
    // goes to floor.json, read before and written after config.json.
    const floor = old ? Math.max(old.minimum_sequence, raisedFloor(directory, old)) : config.minimum_sequence;
    writeUpdateJson(join(directory, 'config.json'), old ? { ...config, minimum_sequence: old.minimum_sequence } : config);
    if (old && config.minimum_sequence > floor) writeUpdateJson(join(directory, 'floor.json'), { schema_version: 1, config_sha256: configDigest(old), minimum_sequence: config.minimum_sequence });
  } finally { rmSync(lock, { recursive: true }); }
}

async function boundedDownload(url: string, maximum: number, fetcher: typeof fetch, accept: (bytes: Uint8Array) => void, timeout: number): Promise<number> {
  try {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { 'Accept-Encoding': 'identity' } });
    if (response.status !== 200 || !response.body || response.redirected ||
        (response.url && response.url !== url) ||
        (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity')) rejectUpdate('download_failed');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) rejectUpdate('download_too_large');
    const reader = response.body.getReader();
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maximum) rejectUpdate('download_too_large');
        accept(part.value);
      }
    } finally { await reader.cancel(); }
    if (length !== null && total !== Number(length)) rejectUpdate('incomplete_download');
    return total;
  } catch (error) {
    if (error instanceof ClientUpdateError) throw error;
    return rejectUpdate('download_failed');
  }
}

export async function runClientUpdate(mode: 'apply' | 'check' | 'status' | 'automatic', dependencies: ClientUpdateDependencies): Promise<ClientUpdateResult> {
  const { root, platform } = dependencies;
  const installer = cliInstaller(platform);
  const installation = dependencies.installation ?? cliInstallation(root, dependencies.install ?? installer ?? (() => rejectUpdate('adapter_unavailable')));
  // The archive is created inside the core's download folder and nowhere else.
  if (!/^\w[\w.-]{0,127}$/.test(installation.archive_name)) rejectUpdate('unsafe_installation');
  const current = installation.installedRelease();
  const config = readClientUpdateConfig(root);
  const running = dependencies.running_release ?? null;
  const result = (status: string, state?: ClientUpdateState): ClientUpdateResult => ({ kind: 'echo-client-update-result-v1', status, platform: platformKey(platform), installed_release: current, running_release: running, available_release: state?.available_release ?? null, checked_at: state?.checked_at ?? null });
  // A launcher that runs another release directly is not served by the managed
  // command, so the managed release's state is not its state. Compare on entry:
  // an apply that starts on A and installs B is the normal transition. For the
  // app, files that now name another release mean "restart to use it".
  if (running !== null && running !== current) return result('running_release_mismatch');
  if (!config) return result('not_configured');
  const directory = updateDirectory(root);
  if (config.installation !== platform.installation) rejectUpdate('installation_mismatch');
  let state = loadState(directory, config);
  // config.json keeps its first floor; a newer build may have raised it since.
  let floor = Math.max(config.minimum_sequence, raisedFloor(directory, config));
  // An offer saved from a feed below the floor is withdrawn: it is never
  // offered again, and the saved status reads as no check.
  const belowFloor = (saved: ClientUpdateState) => ['available', 'staged'].includes(saved.result) && (saved.checkpoint?.sequence ?? 0) < floor;
  if (mode === 'status') return state && !belowFloor(state) ? result(state.result, state) : result('not_checked');
  if (mode === 'automatic' && !config.automatic) return result('automatic_disabled', state);
  const now = (dependencies.now ?? Date.now)();
  if (mode === 'automatic' && state && state.checked_at <= now && now - state.checked_at < UPDATE_INTERVAL_MS) {
    // A staged release stays on offer until the app restarts into it.
    const available = ['available', 'staged'].includes(state.result) && state.available_release !== null && state.available_release !== current && !belowFloor(state);
    return result(available ? 'available' : 'not_due', state);
  }
  if (!dependencies.installation && !installer && mode === 'apply') return result('adapter_unavailable', state);
  const lock = join(directory, '.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { return result('update_busy', state); }
  let temporary: string | undefined;
  let preserveRecovery = false;
  // Default signal handling skips `finally`. Until the installer starts, an
  // interrupt has changed nothing installed, so release the lock and staging,
  // then re-raise the signal with no listener left so the default action ends
  // the process by that signal. An embedding app opts out: the re-raise would
  // end it without its normal quit.
  const interrupted = (signal: NodeJS.Signals) => {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
    detach();
    process.kill(process.pid, signal);
  };
  const signals: readonly NodeJS.Signals[] = dependencies.handle_signals === false ? [] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const detach = () => { for (const signal of signals) process.removeListener(signal, interrupted); };
  for (const signal of signals) process.once(signal, interrupted);
  try {
    // Re-read under the lock before advancing the trusted sequence.
    state = loadState(directory, config);
    // The floor too: a configure may have raised it since the read above.
    floor = Math.max(config.minimum_sequence, raisedFloor(directory, config));
    const fetcher = dependencies.fetch ?? fetch;
    const metadata: Buffer[] = [];
    await boundedDownload(config.feed_url, UPDATE_METADATA_LIMIT, fetcher, b => metadata.push(Buffer.from(b)), 5_000);
    const feed = Buffer.concat(metadata);
    const verified = verifyUpdateEnvelope(feed, { ...config, minimum_sequence: floor }, now, state?.checkpoint ?? undefined);
    const manifest: ClientUpdateManifest = verified.manifest;
    state = { schema_version: 1, config_sha256: configDigest(config), checkpoint: verified.checkpoint, checked_at: now, available_release: manifest.release_id, result: 'available' };
    // Persist freshness even if the artifact is unavailable or installation fails.
    writeUpdateJson(join(directory, 'state.json'), state);
    const artifact = selectUpdateArtifact(manifest, platform);
    const sameRelease = manifest.release_id === current;
    if (sameRelease) {
      if (installation.installedReleaseSha256() !== manifest.release_sha256) rejectUpdate('release_mismatch');
      state.result = 'current';
      writeUpdateJson(join(directory, 'state.json'), state);
      return result('current', state);
    }
    // Automatic checks announce availability. Only an explicit apply may
    // download an artifact or change the installed client.
    if (mode !== 'apply') return result('available', state);
    const fingerprint = installation.fingerprint();
    temporary = mkdtempSync(join(directory, '.download-'));
    const archive = join(temporary, installation.archive_name);
    const fd = openSync(archive, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash('sha256');
    let bytes: number;
    try {
      bytes = await boundedDownload(artifact.url, artifact.bytes, fetcher, b => {
        hash.update(b);
        let offset = 0;
        while (offset < b.length) offset += writeSync(fd, b, offset, b.length - offset);
      }, installation.download_timeout_ms);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256) rejectUpdate('artifact_mismatch');
    // An interrupted installer keeps the lock and staging as recovery evidence.
    detach();
    await installation.install({ root, archive, artifact, manifest, expected_wrapper_sha256: fingerprint, feed });
    if (installation.activation === 'restart') {
      // The app activates the staged copy after it quits; this download folder
      // is still removed below, so the installer kept whatever it needs.
      state.result = 'staged';
      writeUpdateJson(join(directory, 'state.json'), state);
      return result('staged', state);
    }
    if (installation.installedRelease() !== manifest.release_id) rejectUpdate('activation_mismatch');
    state.result = 'updated';
    writeUpdateJson(join(directory, 'state.json'), state);
    return { ...result('updated', state), installed_release: manifest.release_id };
  } catch (error) {
    const code = error instanceof ClientUpdateError ? error.code : 'update_failed';
    preserveRecovery = code === 'installation_outcome_unknown';
    const failure: ClientUpdateState = { schema_version: 1, config_sha256: configDigest(config), checkpoint: state?.checkpoint ?? null, checked_at: now, available_release: state?.available_release ?? null, result: code };
    writeUpdateJson(join(directory, 'state.json'), failure);
    if (mode === 'automatic') return result(code, failure);
    throw new ClientUpdateError(code);
  } finally {
    detach();
    if (!preserveRecovery) {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
      rmSync(lock, { recursive: true });
    }
  }
}
