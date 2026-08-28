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
/** Fresh private-approval lineage. It composes V1 plus V2 additions. */
export const AUTHORITY_BASELINE_SCHEMA_VERSION_V2 = 2;
/** The Authority application ID is role-stable across fresh schemas. */
export const AUTHORITY_BASELINE_APPLICATION_ID_V2 =
  AUTHORITY_BASELINE_APPLICATION_ID_V1;

const BASELINE_SQL_URL = new URL(
  "../../../../baselines/authority-baseline-v1.sql",
  import.meta.url,
);
const PRIVATE_APPROVAL_SQL_V2_URL = new URL(
  "../../../../baselines/authority-private-approval-v2.sql",
  import.meta.url,
);

export function authorityBaselineSqlV1(): string {
  return readFileSync(BASELINE_SQL_URL, "utf8");
}

export function authorityBaselineSha256V1(): Sha256Digest {
  return sha256Digest(authorityBaselineSqlV1());
}

/** V2-only companion SQL. It requires the V1 tables to have been created. */
export function authorityPrivateApprovalSqlV2(): string {
  return readFileSync(PRIVATE_APPROVAL_SQL_V2_URL, "utf8");
}

/** Complete fresh Authority V2 schema: retained V1 plus private approvals. */
export function authorityBaselineSqlV2(): string {
  return `${authorityBaselineSqlV1()}\n${authorityPrivateApprovalSqlV2()}`;
}

export function authorityBaselineSha256V2(): Sha256Digest {
  return sha256Digest(authorityBaselineSqlV2());
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

/**
 * Applies the private-approval Authority baseline only to a completely empty
 * database. This is a distinct fresh lineage, never a V1 upgrade.
 */
export function applyAuthorityBaselineV2(database: Database.Database): void {
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
    database.exec(authorityBaselineSqlV2());
    database.pragma(`application_id = ${AUTHORITY_BASELINE_APPLICATION_ID_V2}`);
    database.pragma(`user_version = ${AUTHORITY_BASELINE_SCHEMA_VERSION_V2}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
