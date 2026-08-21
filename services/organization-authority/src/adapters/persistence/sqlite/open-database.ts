import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrateAuthorityDatabase } from './migrate.js';

export interface OpenAuthorityDatabaseOptions {
  fileMustExist?: boolean;
}

/**
 * Opens the authority database without touching its schema. The open step is
 * deliberately split from migration so a pre-open state-lineage guard can run
 * between filesystem verification and any schema decision; opening alone never
 * creates, upgrades, or rejects a schema version.
 */
export function openAuthorityDatabase(
  databasePath: string,
  options: OpenAuthorityDatabaseOptions = {},
): Database.Database {
  const fileMustExist = options.fileMustExist ?? false;
  if (databasePath !== ':memory:') {
    const databaseDirectory = dirname(databasePath);
    if (!fileMustExist) {
      const directoryExisted = existsSync(databaseDirectory);
      mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
      if (!directoryExisted) chmodSync(databaseDirectory, 0o700);
    }
    const directoryState = lstatSync(databaseDirectory);
    const currentUid = process.getuid?.();
    if (
      directoryState.isSymbolicLink() ||
      !directoryState.isDirectory() ||
      (currentUid !== undefined && directoryState.uid !== currentUid) ||
      (directoryState.mode & 0o777) !== 0o700
    ) {
      throw new Error(
        'organization authority database directory must be a current-user 0700 directory',
      );
    }
    if (existsSync(databasePath)) {
      const state = lstatSync(databasePath);
      if (
        state.isSymbolicLink() ||
        !state.isFile() ||
        (currentUid !== undefined && state.uid !== currentUid)
      ) {
        throw new Error(
          'organization authority database must be a regular file',
        );
      }
    }
  }
  const database = new Database(databasePath, { fileMustExist });
  try {
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
    database.pragma('trusted_schema = OFF');
    // The authority is explicitly one process on one volume. DELETE
    // journaling lets a stopped authority be inspected through SQLite's true
    // read-only mode without creating WAL/SHM coordination files. A future
    // multi-replica storage design must choose its own concurrency contract.
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
 * Opens the authority database and brings it to the current schema. This is
 * the legacy-lineage entry point: every existing writable caller keeps the
 * open-then-migrate behavior through this name, while new-lineage composition
 * will pair the pure opener with the pre-open guard and an explicit
 * initializer instead of implicit migration.
 */
export function openAndMigrateAuthorityDatabase(
  databasePath: string,
  options: OpenAuthorityDatabaseOptions = {},
): Database.Database {
  const database = openAuthorityDatabase(databasePath, options);
  try {
    migrateAuthorityDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
