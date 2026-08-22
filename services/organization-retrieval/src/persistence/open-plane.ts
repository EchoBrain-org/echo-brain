import Database from "better-sqlite3";
import type { ReadableSearchPlaneDefinition } from "./database-definition.js";
import { migrateReadableSearchPlane } from "./migrate.js";
import { openReadableSearchPlane } from "./open-readable-search-plane.js";

export { openReadableSearchPlane } from "./open-readable-search-plane.js";

/**
 * Opens one readable-search plane database and brings it to the definition's
 * current schema. This is the legacy-lineage entry point: every existing
 * writable caller keeps the open-then-migrate behavior through this name,
 * while new-lineage composition will pair the pure opener with the pre-open
 * guard and an explicit initializer instead of implicit migration.
 */
export function openAndMigrateReadableSearchPlane(
  path: string,
  definition: ReadableSearchPlaneDefinition,
): Database.Database {
  const database = openReadableSearchPlane(path);
  try {
    migrateReadableSearchPlane(database, definition);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
