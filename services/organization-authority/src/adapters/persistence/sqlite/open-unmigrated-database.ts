import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface OpenAuthorityDatabaseOptions {
  fileMustExist?: boolean;
}

/**
 * Opens an Authority SQLite file without importing or applying migrations.
 * The stopped clean-reset composer is the only new-lineage consumer.
 */
export function openAuthorityDatabase(
  databasePath: string,
  options: OpenAuthorityDatabaseOptions = {},
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
        "organization authority database directory must be a current-user 0700 directory",
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
          "organization authority database must be a regular file",
        );
      }
    }
  }
  const database = new Database(databasePath, { fileMustExist });
  try {
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
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
