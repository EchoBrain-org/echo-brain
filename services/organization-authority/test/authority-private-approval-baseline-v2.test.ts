import { describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV2,
  AUTHORITY_BASELINE_APPLICATION_ID_V2,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V2,
  authorityBaselineSha256V2,
} from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-unmigrated-database.js";

const AUTHORITY_BASELINE_SHA256_V2 =
  "sha256:0790f8d17300ee8cd500e58bacb9e216a9b8fb838f1da021ba6808705227c77c";

function openedV2Database() {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV2(database);
  return database;
}

function columns(database: ReturnType<typeof openedV2Database>, table: string) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { readonly name: string }).name);
}

describe("Authority private-approval baseline v2", () => {
  it("is a pinned fresh-only V1-plus-private schema with stable role headers", () => {
    const database = openedV2Database();
    try {
      expect(authorityBaselineSha256V2()).toBe(AUTHORITY_BASELINE_SHA256_V2);
      expect(database.pragma("application_id", { simple: true })).toBe(
        AUTHORITY_BASELINE_APPLICATION_ID_V2,
      );
      expect(database.pragma("user_version", { simple: true })).toBe(
        AUTHORITY_BASELINE_SCHEMA_VERSION_V2,
      );
      expect(columns(database, "authority_private_approval_assignments_v2")).toEqual([
        "approval_id",
        "candidate_id",
        "assignment_version",
        "assignment_json",
        "assignment_sha256",
        "connection_id",
        "connection_contract_sha256",
        "connection_state_sha256",
        "approval_binding_id",
        "approval_binding_contract_sha256",
        "external_identity_link_id",
        "external_identity_link_contract_sha256",
        "assignee_principal_id",
        "assignee_membership_id",
        "slack_workspace_id",
        "slack_enterprise_id",
        "slack_subject_id",
        "slack_dm_channel_id",
        "created_at",
      ]);
      expect(columns(database, "authority_private_approval_terminal_receipts_v2")).toEqual([
        "approval_id",
        "candidate_id",
        "outcome",
        "resolution_json",
        "resolution_sha256",
        "v4_receipt_json",
        "v4_receipt_sha256",
        "card_render_state",
        "card_rendered_at",
        "recorded_at",
      ]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("refuses to turn an existing V1 or V2 file into a V2 lineage", () => {
    const database = openedV2Database();
    try {
      expect(() => applyAuthorityBaselineV2(database)).toThrow(
        /completely empty database/,
      );
    } finally {
      database.close();
    }
  });
});
