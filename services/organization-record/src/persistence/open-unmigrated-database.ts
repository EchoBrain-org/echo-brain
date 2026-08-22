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

export interface OpenOrganizationRecordDatabaseOptions {
  readonly fileMustExist?: boolean;
  readonly readonly?: boolean;
}

function assertPrivatePaths(
  databasePath: string,
  fileMustExist: boolean,
): void {
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
      "organization record database directory must be a current-user 0700 directory",
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
        "organization record database must be a current-user 0600 regular file",
      );
    }
  }
}

/** Opens a record database without importing or applying migrations. */
export function openOrganizationRecordDatabase(
  databasePath: string,
  options: OpenOrganizationRecordDatabaseOptions = {},
): Database.Database {
  const readOnly = options.readonly ?? false;
  const fileMustExist = options.fileMustExist ?? readOnly;
  if (databasePath !== ":memory:")
    assertPrivatePaths(databasePath, fileMustExist);

  const database = new Database(databasePath, {
    fileMustExist,
    readonly: readOnly,
  });
  try {
    database.pragma("trusted_schema = OFF");
    if (!readOnly) {
      database.pragma("journal_mode = DELETE");
      database.pragma("synchronous = FULL");
    }
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("temp_store = MEMORY");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
