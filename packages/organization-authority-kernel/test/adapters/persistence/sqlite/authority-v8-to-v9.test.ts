import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  applyAuthorityBaselineV8,
  applyAuthorityBaselineV9,
  authorityBaselineSha256V8,
  authorityBaselineSha256V9,
} from "../../../../src/adapters/persistence/sqlite/baseline.js";
import { copyAuthorityV8ToV9 } from "../../../../src/adapters/persistence/sqlite/authority-v8-to-v9.js";

const databases: Database.Database[] = [];
const roots: string[] = [];
const NOW = "2026-09-23T00:00:00.000Z";
const SHA = `sha256:${"a".repeat(64)}`;
const ORG = "org_11111111-1111-4111-8111-111111111111";
const AUTHORITY = "oau_11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "prn_11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "mem_11111111-1111-4111-8111-111111111111";
const PROJECT_A = "prj_11111111-1111-4111-8111-111111111111";
const PROJECT_B = "prj_22222222-2222-4222-8222-222222222222";
const CONTEXT = `ctx_${"b".repeat(64)}`;
const DOCUMENT = `doc_${"c".repeat(64)}`;
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

function project(database: Database.Database, projectID: string, suffix: string): void {
  database.prepare(`INSERT INTO authority_projects_v1
    (project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type)
    VALUES (?, ?, ?, ?, ?, ?, 'owner')`).run(projectID, ORG, `Project ${suffix}`, NOW, PRINCIPAL, MEMBERSHIP);
}

function v8Fixture(): { path: string; source: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "echo-v8-v9-"));
  roots.push(root);
  const path = join(root, "authority-v8.sqlite");
  const source = opened(path);
  applyAuthorityBaselineV8(source);
  source.transaction(() => {
    source.prepare("INSERT INTO authority_metadata VALUES (1, ?, ?, 'Fixture', '{}', ?, ?)").run(AUTHORITY, ORG, NOW, NOW);
    source.prepare("INSERT INTO authority_principals VALUES (?, ?, 'PM', ?)").run(PRINCIPAL, ORG, NOW);
    source.prepare("INSERT INTO authority_memberships(membership_id, organization_id, principal_id, membership_type, status, provisioned_at) VALUES (?, ?, ?, 'owner', 'active', ?)").run(MEMBERSHIP, ORG, PRINCIPAL, NOW);
    source.prepare("INSERT INTO authority_project_authorization_state_v1 VALUES (?, 1, ?)").run(ORG, NOW);
    project(source, PROJECT_A, "A");
    project(source, PROJECT_B, "B");
    source.prepare(`INSERT INTO authority_person_updates_v2
      (organization_id, principal_id, membership_id, membership_type, request_id, context_id, payload_sha256, title, text, audience_kind, audience_project_id, project_id, received_at)
      VALUES (?, ?, ?, 'owner', 'legacy-text', ?, ?, 'Original title', ?, 'project', ?, ?, ?)`)
      .run(ORG, PRINCIPAL, MEMBERSHIP, CONTEXT, SHA, "Original CRLF\r\ntext", PROJECT_A, null, NOW);
    source.prepare("INSERT INTO authority_person_update_work_v2(context_id, state, retry_at) VALUES (?, 'pending', ?)").run(CONTEXT, NOW);
    source.prepare(`INSERT INTO authority_person_documents_v1
      (document_id, organization_id, principal_id, membership_id, membership_type, request_id, filename, title, detected_media_type, original_size, original_sha256, payload_sha256, audience_kind, received_at)
      VALUES (?, ?, ?, ?, 'owner', 'legacy-document', 'brief.txt', 'Immutable filename', 'text/plain', 5, ?, ?, 'team', ?)`)
      .run(DOCUMENT, ORG, PRINCIPAL, MEMBERSHIP, SHA, SHA, NOW);
    source.prepare("INSERT INTO authority_person_document_originals_v1 VALUES (?, ?)").run(DOCUMENT, Buffer.from("hello"));
    source.prepare("INSERT INTO authority_person_document_work_v1(document_id, retry_at) VALUES (?, ?)").run(DOCUMENT, NOW);
    source.prepare("UPDATE authority_person_document_work_v1 SET state = 'processing', lease_token = 'fixture-lease', lease_expires_at = ? WHERE document_id = ?").run("2026-09-23T00:01:00.000Z", DOCUMENT);
    source.prepare("INSERT INTO authority_person_document_text_v1(document_id, ordinal, anchor_kind, anchor_start, text, extractor) VALUES (?, 0, 'paragraph', 1, 'migration needle', 'fixture-extractor')").run(DOCUMENT);
    source.exec(MANIFEST_SQL);
    const manifest = {
      schema_version: 1,
      kind: "echo-state-lineage-database-manifest-v1",
      role: "authority",
      authority_id: AUTHORITY,
      organization_id: ORG,
      state_lineage_id: "v8-v9-fixture",
      database_schema_version: 8,
      schema_sha256: authorityBaselineSha256V8(),
      created_at: NOW,
      creating_artifact_revision: "test",
    };
    source.prepare("INSERT INTO echo_state_lineage_manifest VALUES (1, ?, ?)").run(canonicalJson(manifest), canonicalSha256(manifest));
  })();
  expect(source.pragma("foreign_key_check")).toEqual([]);
  return { path, source };
}

describe("offline Authority V8 to V9", () => {
  it("preserves originals and derives immutable legacy snapshots and audience links", () => {
    const fixture = v8Fixture();
    fixture.source.close();
    const source = opened(fixture.path, true);
    const target = opened();
    copyAuthorityV8ToV9(source, target);

    expect(target.pragma("user_version", { simple: true })).toBe(9);
    expect(target.pragma("foreign_key_check")).toEqual([]);
    expect(target.prepare("SELECT request_version, submitted_association_project_ids_json, audience_project_ids_json, text FROM authority_person_updates_v2 WHERE context_id = ?").get(CONTEXT)).toEqual({
      request_version: 2,
      submitted_association_project_ids_json: "[]",
      audience_project_ids_json: JSON.stringify([PROJECT_A]),
      text: "Original CRLF\r\ntext",
    });
    expect(target.prepare("SELECT request_version, submitted_association_project_ids_json, audience_project_ids_json, original FROM authority_person_documents_v1 JOIN authority_person_document_originals_v1 USING(document_id) WHERE document_id = ?").get(DOCUMENT)).toEqual({
      request_version: 1,
      submitted_association_project_ids_json: "[]",
      audience_project_ids_json: "[]",
      original: Buffer.from("hello"),
    });
    expect(target.prepare("SELECT project_id FROM authority_person_update_audience_projects_v1 WHERE context_id = ?").pluck().all(CONTEXT)).toEqual([PROJECT_A]);
    expect(target.prepare("SELECT count(*) FROM authority_person_document_audience_projects_v1").pluck().get()).toBe(0);
    expect(target.prepare("SELECT count(*) FROM authority_person_document_text_fts_v1 WHERE authority_person_document_text_fts_v1 MATCH 'needle'").pluck().get()).toBe(1);
    target.prepare("INSERT INTO authority_project_context_associations_v1 VALUES (?, ?, ?, ?, ?, 'owner', ?)").run(CONTEXT, PROJECT_A, ORG, PRINCIPAL, MEMBERSHIP, NOW);
    target.prepare("INSERT INTO authority_project_context_associations_v1 VALUES (?, ?, ?, ?, ?, 'owner', ?)").run(CONTEXT, PROJECT_B, ORG, PRINCIPAL, MEMBERSHIP, NOW);
    expect(target.prepare("SELECT project_id FROM authority_project_context_associations_v1 WHERE context_id = ? ORDER BY project_id").pluck().all(CONTEXT)).toEqual([PROJECT_A, PROJECT_B]);
    expect(() => target.prepare("DELETE FROM authority_person_update_audience_projects_v1 WHERE context_id = ? AND project_id = ?").run(CONTEXT, PROJECT_A)).toThrow("immutable");
    const manifest = JSON.parse(target.prepare("SELECT manifest_json FROM echo_state_lineage_manifest").pluck().get() as string);
    expect(manifest).toMatchObject({ database_schema_version: 9, schema_sha256: authorityBaselineSha256V9(), state_lineage_id: "v8-v9-fixture" });
    const fresh = opened();
    applyAuthorityBaselineV9(fresh);
    fresh.exec(MANIFEST_SQL);
    expect(target.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(fresh.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all());
  });

  it("refuses a writable source or a target whose foreign keys are disabled", () => {
    const fixture = v8Fixture();
    expect(() => copyAuthorityV8ToV9(fixture.source, opened())).toThrow("read-only");
    fixture.source.close();
    const target = opened();
    target.pragma("foreign_keys = OFF");
    expect(() => copyAuthorityV8ToV9(opened(fixture.path, true), target)).toThrow("foreign keys");
  });
});
