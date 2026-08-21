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
import type { OrganizationRecordDatabaseDefinition } from './database-definition.js';
import { migrateOrganizationRecordDatabase } from './migrate.js';

export interface OpenOrganizationRecordDatabaseOptions {
  readonly fileMustExist?: boolean;
  readonly readonly?: boolean;
}

function assertPrivatePaths(databasePath: string, fileMustExist: boolean): void {
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
      'organization record database directory must be a current-user 0700 directory',
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
        'organization record database must be a current-user 0600 regular file',
      );
    }
  }
}

/**
 * Opens one organization-record database without touching its schema.
 *
 * Both databases follow the existing service convention: `journal_mode =
 * DELETE`, so a stopped database is inspectable read-only without WAL/SHM
 * sidecars and `state-backup` — which refuses WAL sidecars — keeps working.
 * The record module is hosted in the authority process and does not claim
 * process ownership here; the host acquires its authenticated singleton guard
 * before calling this.
 *
 * The open step is split from migration so a pre-open state-lineage guard can
 * run between filesystem verification and any schema decision; opening alone
 * never creates, upgrades, or rejects a schema version. Writable callers that
 * need the legacy open-then-migrate behavior use
 * `openAndMigrateOrganizationRecordDatabase`.
 */
export function openOrganizationRecordDatabase(
  databasePath: string,
  options: OpenOrganizationRecordDatabaseOptions = {},
): Database.Database {
  const readOnly = options.readonly ?? false;
  const fileMustExist = options.fileMustExist ?? readOnly;
  if (databasePath !== ':memory:') assertPrivatePaths(databasePath, fileMustExist);

  const database = new Database(databasePath, { fileMustExist, readonly: readOnly });
  try {
    database.pragma('trusted_schema = OFF');
    if (!readOnly) {
      database.pragma('journal_mode = DELETE');
      database.pragma('synchronous = FULL');
    }
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
 * Opens one writable organization-record database and brings it to the
 * definition's current schema. This is the legacy-lineage entry point: every
 * existing writable caller keeps the open-then-migrate behavior through this
 * name, while new-lineage composition will pair the pure opener with the
 * pre-open guard and an explicit initializer instead of implicit migration.
 * Read-only callers use `openOrganizationRecordDatabase` directly; a
 * read-only handle never migrated and never will.
 */
export function openAndMigrateOrganizationRecordDatabase(
  databasePath: string,
  definition: OrganizationRecordDatabaseDefinition,
  options: { readonly fileMustExist?: boolean } = {},
): Database.Database {
  const database = openOrganizationRecordDatabase(databasePath, {
    fileMustExist: options.fileMustExist ?? false,
  });
  try {
    migrateOrganizationRecordDatabase(database, definition);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
