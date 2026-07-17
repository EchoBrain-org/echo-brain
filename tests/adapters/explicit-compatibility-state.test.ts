import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GRANOLA_CHECKPOINT_SCHEMA_VERSION,
  granolaCheckpointPath,
  loadGranolaCheckpoint,
  resolveGranolaApiKey,
  writeGranolaCheckpoint,
} from '../../src/adapters/meeting-sources/granola/compatibility/granola-poller.js';
import {
  GRANOLA_SIGNAL_CHECKPOINT_SCHEMA_VERSION,
  granolaSignalCheckpointPath,
  loadGranolaSignalCheckpoint,
  writeGranolaSignalCheckpoint,
} from '../../src/enrich/granola-signals.js';
import {
  GRANOLA_SIGNALS_WORKER,
  workerHeartbeatPath,
  writeWorkerHeartbeat,
} from '../../src/enrich/worker-heartbeat.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-explicit-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('legacy compatibility state paths', () => {
  it('derives filenames only from caller-supplied product directories', () => {
    const root = temporaryDirectory();
    const checkpoints = join(root, 'checkpoints');
    const health = join(root, 'health');

    expect(granolaCheckpointPath(checkpoints)).toBe(
      join(checkpoints, 'granola-raw-events.json'),
    );
    expect(granolaSignalCheckpointPath(checkpoints)).toBe(
      join(checkpoints, 'granola-signals.json'),
    );
    expect(workerHeartbeatPath(health, GRANOLA_SIGNALS_WORKER)).toBe(
      join(health, 'worker-heartbeat-granola-signals.json'),
    );
  });

  it('reads and writes checkpoints only at explicit destinations', () => {
    const root = temporaryDirectory();
    const rawCheckpoint = granolaCheckpointPath(join(root, 'checkpoints'));
    const signalCheckpoint = granolaSignalCheckpointPath(join(root, 'checkpoints'));

    writeGranolaCheckpoint(
      {
        schema_version: GRANOLA_CHECKPOINT_SCHEMA_VERSION,
        high_water_mark: null,
        ingested_note_ids: [],
        last_synced_at: null,
      },
      rawCheckpoint,
    );
    writeGranolaSignalCheckpoint(
      {
        schema_version: GRANOLA_SIGNAL_CHECKPOINT_SCHEMA_VERSION,
        notes: {},
      },
      signalCheckpoint,
    );

    expect(loadGranolaCheckpoint(rawCheckpoint).schema_version).toBe(1);
    expect(loadGranolaSignalCheckpoint(signalCheckpoint).schema_version).toBe(1);
  });

  it('uses an explicit legacy credential file and has no ambient fallback', () => {
    const root = temporaryDirectory();
    const configPath = join(root, 'granola.json');
    writeFileSync(configPath, '{"api_key":"grn_explicit"}\n');

    expect(resolveGranolaApiKey({}, undefined)).toEqual({
      enabled: false,
      reason: 'missing',
      source: 'none',
    });
    expect(resolveGranolaApiKey({}, configPath)).toEqual({
      enabled: true,
      apiKey: 'grn_explicit',
      source: 'config',
    });
  });

  it('writes worker health only to the supplied destination', () => {
    const root = temporaryDirectory();
    const destination = workerHeartbeatPath(
      join(root, 'health'),
      GRANOLA_SIGNALS_WORKER,
    );

    writeWorkerHeartbeat(
      GRANOLA_SIGNALS_WORKER,
      {
        schema_version: 1,
        worker: GRANOLA_SIGNALS_WORKER,
        last_tick_at: '2026-07-17T00:00:00.000Z',
        status: 'ok',
      },
      destination,
    );

    expect(dirname(destination)).toBe(join(root, 'health'));
    expect(JSON.parse(readFileSync(destination, 'utf8'))).toMatchObject({
      worker: GRANOLA_SIGNALS_WORKER,
      status: 'ok',
    });
  });
});
