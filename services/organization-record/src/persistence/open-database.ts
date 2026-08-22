import type { OrganizationRecordDatabaseDefinition } from "./database-definition.js";
import type Database from "better-sqlite3";
import { migrateOrganizationRecordDatabase } from "./migrate.js";
import { openOrganizationRecordDatabase } from "./open-unmigrated-database.js";

export {
  openOrganizationRecordDatabase,
  type OpenOrganizationRecordDatabaseOptions,
} from "./open-unmigrated-database.js";

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
