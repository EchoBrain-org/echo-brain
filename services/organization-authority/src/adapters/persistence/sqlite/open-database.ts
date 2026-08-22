import { migrateAuthorityDatabase } from "./migrate.js";
import type Database from "better-sqlite3";
import {
  openAuthorityDatabase,
  type OpenAuthorityDatabaseOptions,
} from "./open-unmigrated-database.js";

export {
  openAuthorityDatabase,
  type OpenAuthorityDatabaseOptions,
} from "./open-unmigrated-database.js";

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
