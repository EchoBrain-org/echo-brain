import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Opens one readable-search plane without reading or changing its schema.
 * New-lineage callers use this pure opener after their empty-state guard.
 */
export function openReadableSearchPlane(path: string): Database.Database {
  const directory = dirname(path);
  if (!existsSync(directory))
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryState = lstatSync(directory);
  const currentUid = process.getuid?.();
  if (
    directoryState.isSymbolicLink() ||
    !directoryState.isDirectory() ||
    (currentUid !== undefined && directoryState.uid !== currentUid) ||
    (directoryState.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      "readable-search plane directory must be a current-user 0700 directory",
    );
  }
  if (existsSync(path)) {
    const state = lstatSync(path);
    if (
      state.isSymbolicLink() ||
      !state.isFile() ||
      (currentUid !== undefined && state.uid !== currentUid)
    ) {
      throw new Error(
        "readable-search plane must be a current-user regular file",
      );
    }
  }
  const database = new Database(path);
  try {
    chmodSync(path, 0o600);
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
