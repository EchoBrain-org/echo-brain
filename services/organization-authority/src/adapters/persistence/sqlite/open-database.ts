import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrateAuthorityDatabase } from './migrate.js';

export interface OpenAuthorityDatabaseOptions {
  fileMustExist?: boolean;
}

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
    // The Phase 1 authority is explicitly one process on one volume. DELETE
    // journaling lets a stopped authority be inspected through SQLite's true
    // read-only mode without creating WAL/SHM coordination files. A future
    // multi-replica storage design must choose its own concurrency contract.
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    database.pragma('temp_store = MEMORY');
    migrateAuthorityDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
