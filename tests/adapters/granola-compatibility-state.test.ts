import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GRANOLA_CHECKPOINT_SCHEMA_VERSION,
  granolaCheckpointPath,
  loadGranolaCheckpoint,
  resolveGranolaApiKey,
  writeGranolaCheckpoint,
} from '../../src/adapters/meeting-sources/granola/compatibility/granola-poller.js';

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

describe('Granola raw-event compatibility state', () => {
  it('derives filenames only from caller-supplied product directories', () => {
    const root = temporaryDirectory();
    const checkpoints = join(root, 'checkpoints');

    expect(granolaCheckpointPath(checkpoints)).toBe(
      join(checkpoints, 'granola-raw-events.json'),
    );
  });

  it('reads and writes its checkpoint only at an explicit destination', () => {
    const root = temporaryDirectory();
    const rawCheckpoint = granolaCheckpointPath(join(root, 'checkpoints'));

    writeGranolaCheckpoint(
      {
        schema_version: GRANOLA_CHECKPOINT_SCHEMA_VERSION,
        high_water_mark: null,
        ingested_note_ids: [],
        last_synced_at: null,
      },
      rawCheckpoint,
    );

    expect(loadGranolaCheckpoint(rawCheckpoint).schema_version).toBe(1);
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

});
