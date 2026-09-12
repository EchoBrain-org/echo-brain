import { readFileSync } from "node:fs";
import { sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";
import { STATE_LINEAGE_ROLE_APPLICATION_IDS_V1, type StateLineageRoleV1 } from "@echo-brain/organization-authority-kernel/state-lineage/state-lineage-manifest-v1";

// Shared historical-lineage refusal and conversion fixtures; never runtime APIs.
// Runtime packages expose current baseline appliers exclusively.
function historicalBaseline(role: StateLineageRoleV1, version: number, workspace: string, files: string[]) {
  const sql = () => files.map(file => readFileSync(new URL(`../../packages/${workspace}/baselines/${file}`, import.meta.url), "utf8")).join("\n");
  return {
    version,
    sha256: () => sha256Digest(sql()),
    apply: (database: Database.Database) => {
      if (database.prepare("SELECT count(*) FROM sqlite_master").pluck().get() !== 0) throw new Error("historical fixture requires an empty database");
      database.exec(sql());
      database.pragma(`application_id = ${STATE_LINEAGE_ROLE_APPLICATION_IDS_V1[role]}`);
      database.pragma(`user_version = ${version}`);
    },
  };
}

export const historicalAuthorityV1 = historicalBaseline("authority", 1, "organization-authority-kernel", ["authority-baseline-v1.sql"]);
export const historicalAuthorityV3 = historicalBaseline("authority", 3, "organization-authority-kernel", ["authority-baseline-v1.sql", "authority-meeting-processing-v3.sql"]);
export const historicalAuthorityV4 = historicalBaseline("authority", 4, "organization-authority-kernel", ["authority-baseline-v1.sql", "authority-meeting-processing-v3.sql", "authority-approval-delivery-quarantine-v4.sql"]);
export const historicalControlV1 = historicalBaseline("control-plane", 1, "organization-control-plane", ["organization-control-plane-baseline-v1.sql"]);
export const historicalControlV2 = historicalBaseline("control-plane", 2, "organization-control-plane", ["organization-control-plane-baseline-v1.sql", "organization-control-plane-private-approval-v2.sql"]);
export const historicalRecordLogV1 = historicalBaseline("record-log", 1, "organization-record", ["organization-record-log-baseline-v1.sql"]);
export const historicalRecordLogV2 = historicalBaseline("record-log", 2, "organization-record", ["organization-record-log-baseline-v2.sql"]);
export const historicalRecordDerivedV1 = historicalBaseline("record-derived", 1, "organization-record", ["organization-record-derived-baseline-v1.sql"]);
export const historicalFactsV1 = {
  plane: "facts" as const,
  application_id: STATE_LINEAGE_ROLE_APPLICATION_IDS_V1["retrieval-facts"],
  baseline_sql_url: new URL("../../packages/organization-retrieval/baselines/readable-search-facts-baseline-v1.sql", import.meta.url),
};
