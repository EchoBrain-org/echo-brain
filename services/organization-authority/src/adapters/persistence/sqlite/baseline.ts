import { readFileSync } from "node:fs";
import {
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

/** Private, unwired Authority new-lineage baseline. */
export const AUTHORITY_BASELINE_SCHEMA_VERSION_V1 = 1;
/** `ECAU`, the role-stable Authority SQLite header application ID. */
export const AUTHORITY_BASELINE_APPLICATION_ID_V1 = 0x45434155;

const BASELINE_SQL_URL = new URL(
  "../../../../baselines/authority-baseline-v1.sql",
  import.meta.url,
);

export function authorityBaselineSqlV1(): string {
  return readFileSync(BASELINE_SQL_URL, "utf8");
}

export function authorityBaselineSha256V1(): Sha256Digest {
  return sha256Digest(authorityBaselineSqlV1());
}

/**
 * Applies the fresh Authority baseline to a completely empty database only.
 * It is deliberately not an upgrade or a lineage conversion mechanism.
 */
export function applyAuthorityBaselineV1(database: Database.Database): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const userVersion = database.pragma("user_version", {
      simple: true,
    }) as number;
    const applicationId = database.pragma("application_id", {
      simple: true,
    }) as number;
    const objectCount = database
      .prepare("SELECT count(*) AS objects FROM sqlite_master")
      .pluck()
      .get() as number;
    if (userVersion !== 0 || applicationId !== 0 || objectCount !== 0) {
      throw new Error(
        "authority baseline requires a completely empty database",
      );
    }
    database.exec(authorityBaselineSqlV1());
    database.pragma(`application_id = ${AUTHORITY_BASELINE_APPLICATION_ID_V1}`);
    database.pragma(`user_version = ${AUTHORITY_BASELINE_SCHEMA_VERSION_V1}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
