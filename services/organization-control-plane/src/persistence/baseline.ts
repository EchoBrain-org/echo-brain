import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { sha256Digest } from "../canonical/canonical-json.js";

/** Private fresh-lineage control-plane baseline. It is not live-wired. */
export const ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V1 = 1;
export const ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID = 0x45434f50;
/** Fresh private-approval control-plane lineage: retained V1 plus V2 tables. */
export const ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2 = 2;
/** `ECOP` is stable for the Control Plane database role. */
export const ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID_V2 =
  ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID;

const BASELINE_SQL_URL = new URL(
  "../../baselines/organization-control-plane-baseline-v1.sql",
  import.meta.url,
);
const PRIVATE_APPROVAL_SQL_V2_URL = new URL(
  "../../baselines/organization-control-plane-private-approval-v2.sql",
  import.meta.url,
);

export function organizationControlBaselineSqlV1(): string {
  return readFileSync(BASELINE_SQL_URL, "utf8");
}

export function organizationControlBaselineSha256V1(): `sha256:${string}` {
  return sha256Digest(organizationControlBaselineSqlV1());
}

/** V2-only companion SQL. It depends on the retained V1 tables. */
export function organizationControlPrivateApprovalSqlV2(): string {
  return readFileSync(PRIVATE_APPROVAL_SQL_V2_URL, "utf8");
}

/** Complete fresh Control Plane V2 schema. This is not an upgrade script. */
export function organizationControlBaselineSqlV2(): string {
  return `${organizationControlBaselineSqlV1()}\n${organizationControlPrivateApprovalSqlV2()}`;
}

export function organizationControlBaselineSha256V2(): `sha256:${string}` {
  return sha256Digest(organizationControlBaselineSqlV2());
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

/**
 * Installs the V2 private-approval fresh lineage only into an empty database.
 * Existing V1 files are deliberately refused rather than mutated in place.
 */
export function applyOrganizationControlBaselineV2(
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
    database.exec(organizationControlBaselineSqlV2());
    database.pragma(
      `application_id = ${ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID_V2}`,
    );
    database.pragma(
      `user_version = ${ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2}`,
    );
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
