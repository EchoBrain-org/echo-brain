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

/** Active schema; existing databases use the explicit offline transition. */
export function applyAuthorityBaselineV5(database: Database.Database): void {
  const sql = authorityBaselineSqlV5();
  database.exec("BEGIN IMMEDIATE");
  try {
    const userVersion = database.pragma("user_version", {
      simple: true,
    }) as number;
    const currentApplicationId = database.pragma("application_id", {
      simple: true,
    }) as number;
    const objectCount = database
      .prepare("SELECT count(*) AS objects FROM sqlite_master")
      .pluck()
      .get() as number;
    if (
      userVersion !== 0 ||
      currentApplicationId !== 0 ||
      objectCount !== 0
    ) {
      throw new Error(
        "authority baseline requires a completely empty database",
      );
    }
    database.exec(sql);
    database.pragma(`application_id = ${AUTHORITY_BASELINE_APPLICATION_ID_V1}`);
    database.pragma(`user_version = ${AUTHORITY_BASELINE_SCHEMA_VERSION_V5}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
