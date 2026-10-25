import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";
import { organizationRecordLogBaselineSha256V5 } from "@echo-brain/organization-record/organization-record-api-v1";
import { READABLE_SEARCH_FACTS_BASELINE_V3, readableSearchPlaneBaselineSha256 } from "@echo-brain/organization-retrieval/readable-search-engine-v1";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("pins the current record-log baseline bytes", () => {
  expect(organizationRecordLogBaselineSha256V5()).toBe("sha256:fd7fb6f5d68a4e9256dc6f333bead382ec83c279db1b770b8243450f7073a72b");
});

it("pins the readable-search facts baseline bytes, retired related-atom table included", () => {
  // The state-lineage guard checks every stored generation against these bytes (ADR-0044).
  expect(readableSearchPlaneBaselineSha256(READABLE_SEARCH_FACTS_BASELINE_V3)).toBe("sha256:0674d0feedc6609a5a7d08059a6ea9ca25f25c73ac31f8429fe6f88e4f87ff46");
});

it("initializes only the active storage roles and tables", () => {
  const root = mkdtempSync(join(tmpdir(), "echo-current-storage-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const state = join(root, "state");
  bootstrapOrganizationAuthorityState({ state_directory: state,
    organization_display_name: "Schema fixture", owner_display_name: "Owner",
    created_at: "2026-09-12T00:00:00.000Z", creating_artifact_revision: "current-storage-test" });
  const verification = verifyAuthorityStateLineage(state);
  expect(verification.root.schema_version).toBe(2);
  expect(verification.root.databases).toHaveLength(6);
  expect(existsSync(join(state, "record-derived.sqlite"))).toBe(false);
  for (const [file, count, version] of [["authority.sqlite", 55, 15], ["integrations.sqlite", 7, 4], ["record-log.sqlite", 8, 5]] as const) {
    const db = new Database(join(state, file), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'echo_state_lineage_manifest'").get()).toEqual({ n: count });
      expect(db.pragma("user_version", { simple: true })).toBe(version);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      if (file === "authority.sqlite") {
        expect(db.prepare("SELECT revision FROM authority_project_authorization_state_v1").get()).toEqual({ revision: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name IN ('authority_projects_v1', 'authority_project_memberships_v1', 'authority_person_updates_v2', 'authority_project_context_associations_v1', 'authority_project_command_receipts_v1', 'authority_project_read_audit_v1', 'authority_person_update_audience_projects_v1', 'authority_person_document_audience_projects_v1')").get()).toEqual({ n: 8 });
      }
      if (file === "record-log.sqlite") {
        expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'organization_record_member_readable_person_fact_by_record'").get()).toBeUndefined();
        // V5 retires the meeting transcript grant (ADR-0046).
        expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'organization_record_meeting_transcript_grant%'").all()).toEqual([]);
      }
    } finally { db.close(); }
  }
});

it("refuses an Authority database whose schema header predates V15", () => {
  const root = mkdtempSync(join(tmpdir(), "echo-current-storage-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const state = join(root, "state");
  bootstrapOrganizationAuthorityState({ state_directory: state,
    organization_display_name: "Schema fixture", owner_display_name: "Owner",
    created_at: "2026-09-12T00:00:00.000Z", creating_artifact_revision: "current-storage-test" });
  const database = new Database(join(state, "authority.sqlite"), { fileMustExist: true });
  try {
    database.pragma("user_version = 10");
  } finally {
    database.close();
  }
  expect(() => verifyAuthorityStateLineage(state)).toThrow();
});
