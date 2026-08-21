import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ReadableSearchPlaneDefinition } from './database-definition.js';
import { migrateReadableSearchPlane } from './migrate.js';

/**
 * Opens one readable-search plane database without touching its schema. The
 * open step is split from migration so a pre-open state-lineage guard can run
 * between filesystem verification and any schema decision; opening alone
 * never creates, upgrades, or rejects a schema version. Callers that need the
 * legacy open-then-migrate behavior use `openAndMigrateReadableSearchPlane`.
 */
export function openReadableSearchPlane(path: string): Database.Database {
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryState = lstatSync(directory);
  const currentUid = process.getuid?.();
  if (
    directoryState.isSymbolicLink() ||
    !directoryState.isDirectory() ||
    (currentUid !== undefined && directoryState.uid !== currentUid) ||
    (directoryState.mode & 0o777) !== 0o700
  ) {
    throw new Error('readable-search plane directory must be a current-user 0700 directory');
  }
  if (existsSync(path)) {
    const state = lstatSync(path);
    if (state.isSymbolicLink() || !state.isFile() || (currentUid !== undefined && state.uid !== currentUid)) {
      throw new Error('readable-search plane must be a current-user regular file');
    }
  }
  const database = new Database(path);
  try {
    chmodSync(path, 0o600);
    database.pragma('trusted_schema = OFF');
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    database.pragma('temp_store = MEMORY');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Opens one readable-search plane database and brings it to the definition's
 * current schema. This is the legacy-lineage entry point: every existing
 * writable caller keeps the open-then-migrate behavior through this name,
 * while new-lineage composition will pair the pure opener with the pre-open
 * guard and an explicit initializer instead of implicit migration.
 */
export function openAndMigrateReadableSearchPlane(
  path: string,
  definition: ReadableSearchPlaneDefinition,
): Database.Database {
  const database = openReadableSearchPlane(path);
  try {
    migrateReadableSearchPlane(database, definition);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
