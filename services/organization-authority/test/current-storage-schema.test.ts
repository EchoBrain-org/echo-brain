import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";
import { authorityBaselineSha256V9 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { organizationControlBaselineSha256V3 } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import { organizationRecordLogBaselineSha256V3 } from "@echo-brain/organization-record/organization-record-api-v1";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("pins the current baseline bytes", () => {
  expect(authorityBaselineSha256V9()).toBe("sha256:16da0d9d4f7cdd33c6f30001ec460644d8144d35bf4faa1062504ee037d1d163");
  expect(organizationControlBaselineSha256V3()).toBe("sha256:9aa161419d77355058151d2dd41283594802fe6da62f62f4aa92dbce01029c69");
  expect(organizationRecordLogBaselineSha256V3()).toBe("sha256:af089bff08b84aef53d4323084264d06d4620e9e0dc28a505f30ca4d7324221b");
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
  for (const [file, count, version] of [["authority.sqlite", 49, 9], ["integrations.sqlite", 11, 3], ["record-log.sqlite", 5, 3]] as const) {
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
      if (file === "record-log.sqlite") expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'organization_record_member_readable_person_fact_by_record'").get()).toBeUndefined();
    } finally { db.close(); }
  }
});

it("refuses an Authority database whose schema header predates V9", () => {
  const root = mkdtempSync(join(tmpdir(), "echo-current-storage-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const state = join(root, "state");
  bootstrapOrganizationAuthorityState({ state_directory: state,
    organization_display_name: "Schema fixture", owner_display_name: "Owner",
    created_at: "2026-09-12T00:00:00.000Z", creating_artifact_revision: "current-storage-test" });
  const database = new Database(join(state, "authority.sqlite"), { fileMustExist: true });
  try {
    database.pragma("user_version = 8");
  } finally {
    database.close();
  }
  expect(() => verifyAuthorityStateLineage(state)).toThrow();
});
