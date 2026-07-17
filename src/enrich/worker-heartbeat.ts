// Item 120 — worker heartbeat artifacts: the paired invariant for fail-closed
// workers. "Never crash the daemon" was adopted without its twin: a degraded or
// self-disabled worker must be externally OBSERVABLE. Each enrichment worker
// writes a small, atomically-overwritten heartbeat at a caller-supplied product
// health path at the end of every tick and on boot-time disable, so a stalled
// tick or an accidental disablement becomes queryable.
//
// This module is the whole contract item 117's doctor imports — path + type +
// worker-name constants only, no doctor coupling. No worker ever READS a
// heartbeat; writes are atomic overwrites, so a pre-existing malformed file
// cannot affect a worker.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite } from '../infrastructure/filesystem/atomic-write.js';
import { createLogger } from '../logging/index.js';

const log = createLogger('enrich.worker-heartbeat');

// Worker-name constants (AC1a): the stable identifiers doctor keys on.
export const GRANOLA_SIGNALS_WORKER = 'granola-signals';
export const DRIFT_SWEEP_WORKER = 'drift-sweep';
export const GRANOLA_INTAKE_BRIDGE_WORKER = 'granola-intake-bridge';

export type WorkerName =
  | typeof GRANOLA_SIGNALS_WORKER
  | typeof DRIFT_SWEEP_WORKER
  | typeof GRANOLA_INTAKE_BRIDGE_WORKER;

/**
 * The heartbeat artifact (AC1c). `counters` is a flat numeric map so doctor reads
 * ONE shape across every worker — each worker copies its own numeric result
 * fields in; the artifact stays worker-agnostic. `schema_version` is written
 * fresh each tick and the file is always overwritten, so there is nothing to
 * migrate.
 */
export interface WorkerHeartbeat {
  schema_version: 1;
  worker: string;
  last_tick_at: string;
  status: 'ok' | 'degraded' | 'disabled';
  reason?: string;
  counters?: Record<string, number>;
}

/**
 * Derive a worker heartbeat path inside the configured product health
 * directory. The caller owns the directory policy; this module owns only the
 * stable filename.
 */
export function workerHeartbeatPath(healthDirectory: string, name: string): string {
  return join(healthDirectory, `worker-heartbeat-${name}.json`);
}

/**
 * Best-effort atomic overwrite. Create the destination directory first because
 * a fresh installation may not have its health directory yet. Any write
 * failure (symlinked target, ENOSPC, …) is caught and logged, never propagated
 * into the worker's `run()` or boot path.
 */
export function writeWorkerHeartbeat(
  name: string,
  heartbeat: WorkerHeartbeat,
  destination: string,
): void {
  const filePath = destination;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    atomicWrite({ filePath, content: `${JSON.stringify(heartbeat, null, 2)}\n` });
  } catch (err) {
    log.warn('heartbeat_write_failed', { worker: name, message: (err as Error).message });
  }
}
