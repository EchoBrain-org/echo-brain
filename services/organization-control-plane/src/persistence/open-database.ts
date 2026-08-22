import { migrateOrganizationControlDatabase } from "./migrate.js";
import type Database from "better-sqlite3";
import {
  openOrganizationControlDatabase,
  type OpenOrganizationControlDatabaseOptions,
} from "./open-unmigrated-database.js";

export {
  openOrganizationControlDatabase,
  type OpenOrganizationControlDatabaseOptions,
} from "./open-unmigrated-database.js";

/**
 * Opens the organization control database and brings it to the current
 * schema. This is the legacy-lineage entry point: every existing writable
 * caller keeps the open-then-migrate behavior through this name, while
 * new-lineage composition will pair the pure opener with the pre-open guard
 * and an explicit initializer instead of implicit migration.
 */
export function openAndMigrateOrganizationControlDatabase(
  databasePath: string,
  options: OpenOrganizationControlDatabaseOptions = {},
): Database.Database {
  const database = openOrganizationControlDatabase(databasePath, options);
  try {
    migrateOrganizationControlDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
