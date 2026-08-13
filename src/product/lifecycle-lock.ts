import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { acquireProcessFileLock } from '../infrastructure/filesystem/process-file-lock.js';
import {
  assertDirectory,
  assertOwnerControlledDirectory,
  canonicalLocalPath,
  ensureDirectory,
  pathEntryExists,
} from './secure-local-files.js';
import type { ProductRuntimeConfig } from './config.js';

export type ProductLifecycleLockKind = 'runtime' | 'maintenance' | 'service';
export type ReleaseProductLifecycleLock = () => Promise<void>;

export interface AcquireProductLifecycleLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

export interface ProductMaintenanceLease {
  readonly stateDirectory: string;
  release(): Promise<void>;
}

const activeMaintenanceLeases = new WeakSet<ProductMaintenanceLease>();

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function canonicalProductConfigSha256(
  config: ProductRuntimeConfig,
): string {
  return createHash('sha256')
    .update(`${stableJson(config)}\n`)
    .digest('hex');
}

/**
 * Keep coordination metadata next to state, not inside it. Backups therefore
 * never copy a live lock and a whole-directory restore never replaces one.
 */
export function productLifecycleLockPath(
  stateDir: string,
  kind: ProductLifecycleLockKind,
): string {
  const canonicalState = canonicalLocalPath(
    stateDir,
    'product state directory',
    false,
  );
  if (pathEntryExists(canonicalState)) {
    assertDirectory(canonicalState, 'product state directory');
  }
  const identity = createHash('sha256')
    .update(`${canonicalState}\n`)
    .digest('hex')
    .slice(0, 16);
  return join(
    dirname(canonicalState),
    `.${basename(canonicalState)}.echo-brain-${kind}-${identity}.lock`,
  );
}

export async function acquireProductLifecycleLock(
  stateDir: string,
  kind: ProductLifecycleLockKind,
  options: AcquireProductLifecycleLockOptions = {},
): Promise<ReleaseProductLifecycleLock> {
  const lockPath = productLifecycleLockPath(stateDir, kind);
  // The state leaf must stay untouched until the lock is held. Only its
  // nearest missing parent may be created so a first-run installation has a
  // stable sibling location for coordination metadata.
  ensureDirectory(dirname(lockPath));
  assertOwnerControlledDirectory(
    dirname(lockPath),
    'product lifecycle coordination parent',
  );
  return await acquireProcessFileLock(lockPath, {
    timeoutMs: options.timeoutMs ?? 0,
    staleMs: options.staleMs ?? 30_000,
    retryMs: options.retryMs ?? 50,
  });
}

export async function acquireProductMaintenanceLease(
  stateDir: string,
  options: AcquireProductLifecycleLockOptions = {},
): Promise<ProductMaintenanceLease> {
  const canonicalState = canonicalLocalPath(
    stateDir,
    'product state directory',
    false,
  );
  const releaseRuntime = await acquireProductLifecycleLock(
    canonicalState,
    'runtime',
    options,
  );
  let releaseMaintenance: ReleaseProductLifecycleLock;
  try {
    releaseMaintenance = await acquireProductLifecycleLock(
      canonicalState,
      'maintenance',
      options,
    );
  } catch (error) {
    await releaseRuntime();
    throw error;
  }
  let released = false;
  const lease: ProductMaintenanceLease = {
    stateDirectory: canonicalState,
    async release() {
      if (released) return;
      released = true;
      activeMaintenanceLeases.delete(lease);
      let failure: unknown;
      try {
        await releaseMaintenance();
      } catch (error) {
        failure = error;
      }
      try {
        await releaseRuntime();
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    },
  };
  activeMaintenanceLeases.add(lease);
  return Object.freeze(lease);
}

export function assertProductMaintenanceLease(
  lease: ProductMaintenanceLease,
  stateDir: string,
): void {
  const canonicalState = canonicalLocalPath(
    stateDir,
    'product state directory',
    false,
  );
  if (
    !activeMaintenanceLeases.has(lease) ||
    lease.stateDirectory !== canonicalState
  ) {
    throw new Error(
      'product state operation requires an active maintenance lease for this state directory',
    );
  }
}
