import { readFileSync } from "node:fs";
import {
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

/** `ECAU` is stable for the Authority database role. */
export const AUTHORITY_BASELINE_APPLICATION_ID_V1 = 0x45434155;
/** The only Authority schema; earlier baselines remain in Git history. */
export const AUTHORITY_BASELINE_SCHEMA_VERSION = 14;

export function authorityBaselineSql(): string {
  return readFileSync(new URL("../../../../baselines/authority-baseline-v14.sql", import.meta.url), "utf8");
}

export function authorityBaselineSha256(): Sha256Digest {
  return sha256Digest(authorityBaselineSql());
}

/**
 * Whether `database` holds current-baseline Authority state with foreign keys
 * enabled. Authority table adapters refuse any other database when opened.
 */
export function isCurrentAuthorityState(database: Database.Database): boolean {
  return database.pragma("user_version", { simple: true }) === AUTHORITY_BASELINE_SCHEMA_VERSION &&
    database.pragma("foreign_keys", { simple: true }) === 1;
}

/** The baseline applies only to a completely empty fresh Authority database. */
export function applyAuthorityBaseline(database: Database.Database): void {
  applyEmptyAuthorityBaseline(database, authorityBaselineSql(), AUTHORITY_BASELINE_SCHEMA_VERSION);
}

/**
 * Applies one pinned baseline to a completely empty Authority database and
 * stamps its application id and schema version in the same transaction.
 */
function applyEmptyAuthorityBaseline(
  database: Database.Database,
  sql: string,
  schemaVersion: number,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const userVersion = database.pragma("user_version", { simple: true }) as number;
    const currentApplicationId = database.pragma("application_id", { simple: true }) as number;
    const objectCount = database.prepare("SELECT count(*) AS objects FROM sqlite_master").pluck().get() as number;
    if (userVersion !== 0 || currentApplicationId !== 0 || objectCount !== 0) {
      throw new Error("authority baseline requires a completely empty database");
    }
    database.exec(sql);
    database.pragma(`application_id = ${AUTHORITY_BASELINE_APPLICATION_ID_V1}`);
    database.pragma(`user_version = ${schemaVersion}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
