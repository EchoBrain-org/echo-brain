import { readFileSync } from "node:fs";
import {
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";
import { ORGANIZATION_RECORD_LOG_DATABASE } from "./database-definition.js";

export const ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V3 = 3;

export function organizationRecordLogBaselineSqlV3(): string {
  return readFileSync(new URL("../../baselines/organization-record-log-baseline-v3.sql", import.meta.url), "utf8");
}

export function organizationRecordLogBaselineSha256V3(): Sha256Digest {
  return sha256Digest(organizationRecordLogBaselineSqlV3());
}

export function applyOrganizationRecordLogBaselineV3(database: Database.Database): void {
  const sql = organizationRecordLogBaselineSqlV3();
  database.exec("BEGIN IMMEDIATE");
  try {
    if (database.pragma("user_version", { simple: true }) !== 0 ||
        database.pragma("application_id", { simple: true }) !== 0 ||
        database.prepare("SELECT count(*) FROM sqlite_master").pluck().get() !== 0) {
      throw new Error("organization record log baseline requires a completely empty database");
    }
    database.exec(sql);
    database.pragma(`application_id = ${ORGANIZATION_RECORD_LOG_DATABASE.application_id}`);
    database.pragma(`user_version = ${ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V3}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}
