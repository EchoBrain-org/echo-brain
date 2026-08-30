import { readFileSync } from "node:fs";
import {
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";
import { ORGANIZATION_RECORD_LOG_DATABASE } from "./database-definition.js";

/**
 * Exact schema baseline v1 for the organization record log role.
 *
 * Runtime composition opens this through the organization-record database
 * port. This private applier only claims a completely empty database; it never
 * relabels, upgrades, or imports an existing file.
 */
export const ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V1 = 1;
export const ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V2 = 2;

const BASELINE_SQL_URL = new URL(
  "../../baselines/organization-record-log-baseline-v1.sql",
  import.meta.url,
);
const BASELINE_V2_SQL_URL = new URL(
  "../../baselines/organization-record-log-baseline-v2.sql",
  import.meta.url,
);

export function organizationRecordLogBaselineSqlV1(): string {
  return readFileSync(BASELINE_SQL_URL, "utf8");
}

export function organizationRecordLogBaselineSha256V1(): Sha256Digest {
  return sha256Digest(organizationRecordLogBaselineSqlV1());
}

/** Fresh V2 lineage: accepts either legacy or private policy coordinates. */
export function organizationRecordLogBaselineSqlV2(): string {
  return readFileSync(BASELINE_V2_SQL_URL, "utf8");
}

export function organizationRecordLogBaselineSha256V2(): Sha256Digest {
  return sha256Digest(organizationRecordLogBaselineSqlV2());
}

export function applyOrganizationRecordLogBaselineV1(
  database: Database.Database,
): void {
  const sql = organizationRecordLogBaselineSqlV1();
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
        "organization record log baseline requires a completely empty database",
      );
    }
    database.exec(sql);
    database.pragma(
      `application_id = ${ORGANIZATION_RECORD_LOG_DATABASE.application_id}`,
    );
    database.pragma(
      `user_version = ${ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V1}`,
    );
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

/**
 * Fresh-only companion for the private Block Kit lineage. This refuses any
 * populated V1/V2 file rather than attempting an in-place policy upgrade.
 */
export function applyOrganizationRecordLogBaselineV2(
  database: Database.Database,
): void {
  const sql = organizationRecordLogBaselineSqlV2();
  database.exec("BEGIN IMMEDIATE");
  try {
    const userVersion = database.pragma("user_version", { simple: true }) as number;
    const applicationId = database.pragma("application_id", { simple: true }) as number;
    const objectCount = database
      .prepare("SELECT count(*) AS objects FROM sqlite_master")
      .pluck()
      .get() as number;
    if (userVersion !== 0 || applicationId !== 0 || objectCount !== 0) {
      throw new Error(
        "organization record log baseline requires a completely empty database",
      );
    }
    database.exec(sql);
    database.pragma(
      `application_id = ${ORGANIZATION_RECORD_LOG_DATABASE.application_id}`,
    );
    database.pragma(
      `user_version = ${ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V2}`,
    );
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
