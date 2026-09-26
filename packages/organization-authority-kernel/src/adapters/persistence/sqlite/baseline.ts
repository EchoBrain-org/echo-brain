import { readFileSync } from "node:fs";
import {
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

/** `ECAU` is stable for the Authority database role. */
export const AUTHORITY_BASELINE_APPLICATION_ID_V1 = 0x45434155;
export const AUTHORITY_BASELINE_SCHEMA_VERSION_V5 = 5;

export function authorityBaselineSqlV5(): string {
  return readFileSync(new URL("../../../../baselines/authority-baseline-v5.sql", import.meta.url), "utf8");
}

export function authorityBaselineSha256V5(): Sha256Digest {
  return sha256Digest(authorityBaselineSqlV5());
}

/** Pinned previous schema, retained for offline compatibility verification. */
export function applyAuthorityBaselineV5(database: Database.Database): void {
  applyEmptyAuthorityBaseline(database, authorityBaselineSqlV5(), AUTHORITY_BASELINE_SCHEMA_VERSION_V5);
}

export const AUTHORITY_BASELINE_SCHEMA_VERSION_V6 = 6;

export function authorityBaselineSqlV6(): string {
  return readFileSync(new URL("../../../../baselines/authority-baseline-v6.sql", import.meta.url), "utf8");
}

export function authorityBaselineSha256V6(): Sha256Digest {
  return sha256Digest(authorityBaselineSqlV6());
}

/** Active schema; existing databases use the explicit offline transition. */
export function applyAuthorityBaselineV6(database: Database.Database): void {
  applyEmptyAuthorityBaseline(database, authorityBaselineSqlV6(), AUTHORITY_BASELINE_SCHEMA_VERSION_V6);
}

/** Active fresh-state schema; V5/V6 remain pinned historical baselines. */
export const AUTHORITY_BASELINE_SCHEMA_VERSION_V7 = 7;

export function authorityBaselineSqlV7(): string {
  return readFileSync(new URL("../../../../baselines/authority-baseline-v7.sql", import.meta.url), "utf8");
}

export function authorityBaselineSha256V7(): Sha256Digest {
  return sha256Digest(authorityBaselineSqlV7());
}

/** V7 applies only to a completely empty fresh Authority database. */
export function applyAuthorityBaselineV7(database: Database.Database): void {
  applyEmptyAuthorityBaseline(database, authorityBaselineSqlV7(), AUTHORITY_BASELINE_SCHEMA_VERSION_V7);
}

/** Active fresh-state schema; V5/V6/V7 remain pinned historical baselines. */
export const AUTHORITY_BASELINE_SCHEMA_VERSION_V8 = 8;

export function authorityBaselineSqlV8(): string {
  return readFileSync(new URL("../../../../baselines/authority-baseline-v8.sql", import.meta.url), "utf8");
}

export function authorityBaselineSha256V8(): Sha256Digest {
  return sha256Digest(authorityBaselineSqlV8());
}

/** V8 applies only to a completely empty fresh Authority database. */
export function applyAuthorityBaselineV8(database: Database.Database): void {
  applyEmptyAuthorityBaseline(database, authorityBaselineSqlV8(), AUTHORITY_BASELINE_SCHEMA_VERSION_V8);
}

/** Active fresh-state schema; V5 through V8 remain pinned historical baselines. */
export const AUTHORITY_BASELINE_SCHEMA_VERSION_V9 = 9;

export function authorityBaselineSqlV9(): string {
  return readFileSync(new URL("../../../../baselines/authority-baseline-v9.sql", import.meta.url), "utf8");
}

export function authorityBaselineSha256V9(): Sha256Digest {
  return sha256Digest(authorityBaselineSqlV9());
}

/** V9 applies only to a completely empty fresh Authority database. */
export function applyAuthorityBaselineV9(database: Database.Database): void {
  applyEmptyAuthorityBaseline(database, authorityBaselineSqlV9(), AUTHORITY_BASELINE_SCHEMA_VERSION_V9);
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
