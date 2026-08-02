import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrateOrganizationControlDatabase } from './migrate.js';

export interface OpenOrganizationControlDatabaseOptions {
  fileMustExist?: boolean;
}

/**
 * Opens the customer-owned organization control database.
 *
 * The database contains no provider bearer credentials. Opaque secret handles
 * point to an independently protected customer secret broker. This persistence
 * helper does not claim live process ownership; the future service must acquire
 * its authenticated kernel singleton guard before calling it.
 */
export function openOrganizationControlDatabase(
  databasePath: string,
  options: OpenOrganizationControlDatabaseOptions = {},
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
        'organization control database directory must be a current-user 0700 directory',
      );
    }
    if (!existsSync(databasePath) && !fileMustExist) {
      const descriptor = openSync(databasePath, 'wx', 0o600);
      closeSync(descriptor);
    }
    if (existsSync(databasePath)) {
      const state = lstatSync(databasePath);
      if (
        state.isSymbolicLink() ||
        !state.isFile() ||
        (currentUid !== undefined && state.uid !== currentUid) ||
        (state.mode & 0o777) !== 0o600
      ) {
        throw new Error(
          'organization control database must be a current-user 0600 regular file',
        );
      }
    }
  }

  const database = new Database(databasePath, { fileMustExist });
  try {
    database.pragma('trusted_schema = OFF');
    // The customer-hosted authority owns this database from one process under
    // its authenticated singleton guard. DELETE journaling keeps the complete
    // durable database in one file for read-only status checks and explicit
    // installation without WAL/SHM sidecars.
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    database.pragma('temp_store = MEMORY');
    migrateOrganizationControlDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
