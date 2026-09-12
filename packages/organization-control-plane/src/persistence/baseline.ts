import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { sha256Digest } from "../canonical/canonical-json.js";

/** `ECOP` is stable for the Control Plane database role. */
export const ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID = 0x45434f50;
export const ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V3 = 3;

export function organizationControlBaselineSqlV3(): string {
  return readFileSync(new URL("../../baselines/organization-control-plane-baseline-v3.sql", import.meta.url), "utf8");
}

export function organizationControlBaselineSha256V3(): `sha256:${string}` {
  return sha256Digest(organizationControlBaselineSqlV3());
}

export function applyOrganizationControlBaselineV3(database: Database.Database): void {
  const sql = organizationControlBaselineSqlV3();
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
        "organization control baseline requires a completely empty database",
      );
    }
    database.exec(sql);
    database.pragma(
      `application_id = ${ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID}`,
    );
    database.pragma(
      `user_version = ${ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V3}`,
    );
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
