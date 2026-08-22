import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/** Options for a schema-neutral control-plane database open. */
export interface OpenOrganizationControlDatabaseOptions {
  fileMustExist?: boolean;
}

/**
 * Opens one control-plane SQLite file without importing or applying migrations.
 * New-lineage genesis uses this seam; legacy callers use the composed opener.
 */
export function openOrganizationControlDatabase(
  databasePath: string,
  options: OpenOrganizationControlDatabaseOptions = {},
): Database.Database {
  const fileMustExist = options.fileMustExist ?? false;
  if (databasePath !== ":memory:") {
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
        "organization control database directory must be a current-user 0700 directory",
      );
    }
    if (!existsSync(databasePath) && !fileMustExist) {
      const descriptor = openSync(databasePath, "wx", 0o600);
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
          "organization control database must be a current-user 0600 regular file",
        );
      }
    }
  }

  const database = new Database(databasePath, { fileMustExist });
  try {
    database.pragma("trusted_schema = OFF");
    database.pragma("journal_mode = DELETE");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("temp_store = MEMORY");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
