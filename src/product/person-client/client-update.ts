import { Buffer } from 'node:buffer';
import { constants, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClientUpdateError, type ClientUpdateConfig, type ClientUpdateManifest, type UpdateCheckpoint,
  type UpdatePlatform, parseUpdateConfig, parseUpdatePlatform, platformKey, rejectUpdate,
  selectUpdateArtifact, updateDigest, updateObject, verifyUpdateEnvelope,
  UPDATE_INTERVAL_MS, UPDATE_METADATA_LIMIT,
} from './client-update-contract.js';
import { readUpdateFile, safeUpdateDirectory, updateDirectory, writeUpdateJson } from './client-update-files.js';
import { installLinuxClientUpdate, type UpdateInstallerInput } from './client-update-linux.js';
import { createHash } from 'node:crypto';

export interface ClientUpdateState {
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
  installed_release: string;
  available_release: string | null;
  checked_at: number | null;
}
export interface ClientUpdateDependencies {
  root: string;
  platform: UpdatePlatform;
  fetch?: typeof fetch;
  now?: () => number;
  install?: (input: UpdateInstallerInput) => void | Promise<void>;
}
function configDigest(config: ClientUpdateConfig): string {
  const { automatic: _automatic, ...trust } = config;
  return updateDigest(JSON.stringify(trust));
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

/** A trusted local bootstrap operation. Feed downloads cannot replace this configuration. */
export function configureClientUpdates(root: string, raw: unknown): void {
  const config = parseUpdateConfig(raw);
  const directory = updateDirectory(root);
  installedRelease(root);
  const lock = join(directory, '.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { return rejectUpdate('update_busy'); }
  try {
    const old = readClientUpdateConfig(root);
    // Reconfiguration must not reset the anti-rollback checkpoint or silently
    // replace publisher trust. A new publisher requires a separate bootstrap.
    if (old && configDigest(old) !== configDigest(config)) rejectUpdate('already_configured');
    writeUpdateJson(join(directory, 'config.json'), config);
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
  const current = installedRelease(root);
  const config = readClientUpdateConfig(root);
  const result = (status: string, state?: ClientUpdateState): ClientUpdateResult => ({ kind: 'echo-client-update-result-v1', status, platform: platformKey(platform), installed_release: current, available_release: state?.available_release ?? null, checked_at: state?.checked_at ?? null });
  if (!config) return result('not_configured');
  const directory = updateDirectory(root);
  if (config.installation !== platform.installation) rejectUpdate('installation_mismatch');
  let state = loadState(directory, config);
  if (mode === 'status') return result(state?.result ?? 'not_checked', state);
  if (mode === 'automatic' && !config.automatic) return result('automatic_disabled', state);
  const now = (dependencies.now ?? Date.now)();
  if (mode === 'automatic' && state && state.result !== 'available' && state.checked_at <= now && now - state.checked_at < UPDATE_INTERVAL_MS) return result('not_due', state);
  // OS detection is independent of adapter availability. Containers are updated
  // by their deployment lane; desktop activation belongs to Electron packaging.
  if (platformKey(platform) !== 'linux/x64/glibc/cli-kit' && mode !== 'check') return result('adapter_unavailable', state);
  const lock = join(directory, '.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { return result('update_busy', state); }
  let temporary: string | undefined;
  let preserveRecovery = false;
  try {
    // Re-read under the lock before advancing the trusted sequence.
    state = loadState(directory, config);
    const fetcher = dependencies.fetch ?? fetch;
    const metadata: Buffer[] = [];
    await boundedDownload(config.feed_url, UPDATE_METADATA_LIMIT, fetcher, b => metadata.push(Buffer.from(b)), 5_000);
    const verified = verifyUpdateEnvelope(Buffer.concat(metadata), config, now, state?.checkpoint ?? undefined);
    const manifest: ClientUpdateManifest = verified.manifest;
    state = { schema_version: 1, config_sha256: configDigest(config), checkpoint: verified.checkpoint, checked_at: now, available_release: manifest.release_id, result: 'available' };
    // Persist freshness even if the artifact is unavailable or installation fails.
    writeUpdateJson(join(directory, 'state.json'), state);
    const artifact = selectUpdateArtifact(manifest, platform);
    const sameRelease = manifest.release_id === current;
    if (sameRelease) {
      const raw = readUpdateFile(join(root, 'releases', current, 'release.json'), 16 * 1024);
      if (updateDigest(raw) !== manifest.release_sha256) rejectUpdate('release_mismatch');
      state.result = 'current';
      writeUpdateJson(join(directory, 'state.json'), state);
      return result('current', state);
    }
    if (mode === 'check') return result('available', state);
    const expectedWrapper = updateDigest(readUpdateFile(join(root, 'bin', 'echo-brain'), 16 * 1024));
    temporary = mkdtempSync(join(directory, '.download-'));
    const archive = join(temporary, 'client.zip');
    const fd = openSync(archive, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash('sha256');
    let bytes: number;
    try {
      bytes = await boundedDownload(artifact.url, artifact.bytes, fetcher, b => {
        hash.update(b);
        let offset = 0;
        while (offset < b.length) offset += writeSync(fd, b, offset, b.length - offset);
      }, 120_000);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256) rejectUpdate('artifact_mismatch');
    await (dependencies.install ?? installLinuxClientUpdate)({ root, archive, artifact, manifest, expected_wrapper_sha256: expectedWrapper });
    if (installedRelease(root) !== manifest.release_id) rejectUpdate('activation_mismatch');
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
    if (!preserveRecovery) {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
      rmSync(lock, { recursive: true });
    }
  }
}
