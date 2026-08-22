import { readFileSync } from "node:fs";
import {
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";
import { ORGANIZATION_RECORD_LOG_DATABASE } from "./database-definition.js";

/**
 * New-lineage baseline v1 for the organization record log role.
 *
 * The new-lineage initializer owns composition and remains later Phase 3
 * work. This private applier only claims a completely empty database; it
 * never relabels, upgrades, or imports an existing file.
 */
export const ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V1 = 1;

const BASELINE_SQL_URL = new URL(
  "../../baselines/organization-record-log-baseline-v1.sql",
  import.meta.url,
);

export function organizationRecordLogBaselineSqlV1(): string {
  return readFileSync(BASELINE_SQL_URL, "utf8");
}

export function organizationRecordLogBaselineSha256V1(): Sha256Digest {
  return sha256Digest(organizationRecordLogBaselineSqlV1());
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
