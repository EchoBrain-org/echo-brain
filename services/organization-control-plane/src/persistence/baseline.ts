import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { sha256Digest } from "../canonical/canonical-json.js";

/** Private fresh-lineage control-plane baseline. It is not live-wired. */
export const ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V1 = 1;
export const ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID = 0x45434f50;

const BASELINE_SQL_URL = new URL(
  "../../baselines/organization-control-plane-baseline-v1.sql",
  import.meta.url,
);

export function organizationControlBaselineSqlV1(): string {
  return readFileSync(BASELINE_SQL_URL, "utf8");
}

export function organizationControlBaselineSha256V1(): `sha256:${string}` {
  return sha256Digest(organizationControlBaselineSqlV1());
}

/**
 * Installs the fresh baseline only into a completely empty database. This is
 * deliberately not an upgrade or a way to claim an existing state file.
 */
export function applyOrganizationControlBaselineV1(
  database: Database.Database,
): void {
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
    database.exec(organizationControlBaselineSqlV1());
    database.pragma(
      `application_id = ${ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID}`,
    );
    database.pragma(
      `user_version = ${ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V1}`,
    );
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
