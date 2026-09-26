import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  applyAuthorityBaselineV9,
  applyAuthorityBaselineV10,
  authorityBaselineSha256V9,
  authorityBaselineSha256V10,
} from "../../../../src/adapters/persistence/sqlite/baseline.js";
import { copyAuthorityV9ToV10 } from "../../../../src/adapters/persistence/sqlite/authority-v9-to-v10.js";

const databases: Database.Database[] = [];
const roots: string[] = [];
const NOW = "2026-09-26T00:00:00.000Z";
const ORG = "org_11111111-1111-4111-8111-111111111111";
const AUTHORITY = "oau_11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "prn_11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "mem_11111111-1111-4111-8111-111111111111";
const PROJECT = "prj_11111111-1111-4111-8111-111111111111";
const MANIFEST_SQL = `CREATE TABLE echo_state_lineage_manifest (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         manifest_json TEXT NOT NULL,
         manifest_sha256 TEXT NOT NULL
       ) STRICT`;

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function opened(path = ":memory:", readonly = false): Database.Database {
  const database = new Database(path, { readonly });
  database.pragma("foreign_keys = ON");
  databases.push(database);
  return database;
}

function fixture(): { path: string; source: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "echo-v9-v10-"));
  roots.push(root);
  const path = join(root, "authority-v9.sqlite");
  const source = opened(path);
  applyAuthorityBaselineV9(source);
  source.transaction(() => {
    source.prepare("INSERT INTO authority_metadata VALUES (1, ?, ?, 'Fixture', '{}', ?, ?)").run(AUTHORITY, ORG, NOW, NOW);
    source.prepare("INSERT INTO authority_principals VALUES (?, ?, 'PM', ?)").run(PRINCIPAL, ORG, NOW);
    source.prepare("INSERT INTO authority_memberships(membership_id, organization_id, principal_id, membership_type, status, provisioned_at) VALUES (?, ?, ?, 'owner', 'active', ?)").run(MEMBERSHIP, ORG, PRINCIPAL, NOW);
    source.prepare("INSERT INTO authority_project_authorization_state_v1 VALUES (?, 0, ?)").run(ORG, NOW);
    source.prepare(`INSERT INTO authority_projects_v1
      (project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type)
      VALUES (?, ?, 'Preserved', ?, ?, ?, 'owner')`).run(PROJECT, ORG, NOW, PRINCIPAL, MEMBERSHIP);
    source.exec(MANIFEST_SQL);
    const manifest = { schema_version: 1, kind: "echo-state-lineage-database-manifest-v1", role: "authority", authority_id: AUTHORITY, organization_id: ORG, state_lineage_id: "v9-v10-fixture", database_schema_version: 9, schema_sha256: authorityBaselineSha256V9(), created_at: NOW, creating_artifact_revision: "test" };
    source.prepare("INSERT INTO echo_state_lineage_manifest VALUES (1, ?, ?)").run(canonicalJson(manifest), canonicalSha256(manifest));
  })();
  return { path, source };
}

describe("offline Authority V9 to V10", () => {
  it("preserves V9 custody and initializes every project as active", () => {
    const current = fixture();
    current.source.close();
    const target = opened();
    copyAuthorityV9ToV10(opened(current.path, true), target);
    expect(target.pragma("user_version", { simple: true })).toBe(10);
    expect(target.prepare("SELECT name, status FROM authority_projects_v1 WHERE project_id = ?").get(PROJECT)).toEqual({ name: "Preserved", status: "active" });
    expect(target.pragma("foreign_key_check")).toEqual([]);
    expect(JSON.parse(target.prepare("SELECT manifest_json FROM echo_state_lineage_manifest").pluck().get() as string)).toMatchObject({ database_schema_version: 10, schema_sha256: authorityBaselineSha256V10() });
    const fresh = opened();
    applyAuthorityBaselineV10(fresh);
    fresh.exec(MANIFEST_SQL);
    expect(target.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(fresh.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all());
  });

  it("refuses a writable source", () => {
    const current = fixture();
    expect(() => copyAuthorityV9ToV10(current.source, opened())).toThrow("read-only");
  });
});
