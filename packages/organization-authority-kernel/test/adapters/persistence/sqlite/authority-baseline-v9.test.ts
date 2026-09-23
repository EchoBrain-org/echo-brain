import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV8,
  applyAuthorityBaselineV9,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V9,
} from "../../../../src/adapters/persistence/sqlite/baseline.js";

const databases: Database.Database[] = [];
const NOW = "2026-09-23T00:00:00.000Z";
const SHA = `sha256:${"a".repeat(64)}`;
const ORG = "org_11111111-1111-4111-8111-111111111111";
const AUTHORITY = "oau_11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "prn_11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "mem_11111111-1111-4111-8111-111111111111";
const PROJECT_A = "prj_11111111-1111-4111-8111-111111111111";
const PROJECT_B = "prj_22222222-2222-4222-8222-222222222222";
const PROJECT_C = "prj_33333333-3333-4333-8333-333333333333";
const CONTEXT = `ctx_${"b".repeat(64)}`;
const DOCUMENT = `doc_${"c".repeat(64)}`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function opened(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  databases.push(database);
  return database;
}

function seedProject(database: Database.Database, projectID: string, suffix: string): void {
  database.prepare(`INSERT INTO authority_projects_v1
    (project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type)
    VALUES (?, ?, ?, ?, ?, ?, 'owner')`).run(projectID, ORG, `Project ${suffix}`, NOW, PRINCIPAL, MEMBERSHIP);
}

function seededV9(): Database.Database {
  const database = opened();
  applyAuthorityBaselineV9(database);
  database.prepare("INSERT INTO authority_metadata VALUES (1, ?, ?, 'Fixture', '{}', ?, ?)").run(AUTHORITY, ORG, NOW, NOW);
  database.prepare("INSERT INTO authority_principals VALUES (?, ?, 'PM', ?)").run(PRINCIPAL, ORG, NOW);
  database.prepare("INSERT INTO authority_memberships(membership_id, organization_id, principal_id, membership_type, status, provisioned_at) VALUES (?, ?, ?, 'owner', 'active', ?)").run(MEMBERSHIP, ORG, PRINCIPAL, NOW);
  database.prepare("INSERT INTO authority_project_authorization_state_v1 VALUES (?, 1, ?)").run(ORG, NOW);
  seedProject(database, PROJECT_A, "A");
  seedProject(database, PROJECT_B, "B");
  seedProject(database, PROJECT_C, "C");
  database.prepare(`INSERT INTO authority_person_updates_v2
    (organization_id, principal_id, membership_id, membership_type, request_id, request_version, context_id, payload_sha256, title, text, audience_kind, submitted_association_project_ids_json, audience_project_ids_json, received_at)
    VALUES (?, ?, ?, 'owner', 'text-v3', 3, ?, ?, 'Design note', 'Original text', 'projects', ?, ?, ?)`)
    .run(ORG, PRINCIPAL, MEMBERSHIP, CONTEXT, SHA, JSON.stringify([PROJECT_A, PROJECT_B]), JSON.stringify([PROJECT_A, PROJECT_B]), NOW);
  database.prepare("INSERT INTO authority_project_context_associations_v1 VALUES (?, ?, ?, ?, ?, 'owner', ?)").run(CONTEXT, PROJECT_A, ORG, PRINCIPAL, MEMBERSHIP, NOW);
  database.prepare("INSERT INTO authority_project_context_associations_v1 VALUES (?, ?, ?, ?, ?, 'owner', ?)").run(CONTEXT, PROJECT_B, ORG, PRINCIPAL, MEMBERSHIP, NOW);
  database.prepare("INSERT INTO authority_person_update_audience_projects_v1 VALUES (?, ?, ?)").run(CONTEXT, PROJECT_A, ORG);
  database.prepare("INSERT INTO authority_person_update_audience_projects_v1 VALUES (?, ?, ?)").run(CONTEXT, PROJECT_B, ORG);
  database.prepare(`INSERT INTO authority_person_documents_v1
    (document_id, organization_id, principal_id, membership_id, membership_type, request_id, request_version, filename, title, detected_media_type, original_size, original_sha256, payload_sha256, audience_kind, submitted_association_project_ids_json, audience_project_ids_json, received_at)
    VALUES (?, ?, ?, ?, 'owner', 'document-v2', 2, 'brief.txt', 'Brief', 'text/plain', 5, ?, ?, 'projects', ?, ?, ?)`)
    .run(DOCUMENT, ORG, PRINCIPAL, MEMBERSHIP, SHA, SHA, JSON.stringify([PROJECT_A, PROJECT_B]), JSON.stringify([PROJECT_A, PROJECT_B]), NOW);
  database.prepare("INSERT INTO authority_person_document_originals_v1 VALUES (?, ?)").run(DOCUMENT, Buffer.from("hello"));
  database.prepare("INSERT INTO authority_person_document_associations_v1 VALUES (?, ?, ?, ?)").run(DOCUMENT, PROJECT_A, ORG, NOW);
  database.prepare("INSERT INTO authority_person_document_associations_v1 VALUES (?, ?, ?, ?)").run(DOCUMENT, PROJECT_B, ORG, NOW);
  database.prepare("INSERT INTO authority_person_document_audience_projects_v1 VALUES (?, ?, ?)").run(DOCUMENT, PROJECT_A, ORG);
  database.prepare("INSERT INTO authority_person_document_audience_projects_v1 VALUES (?, ?, ?)").run(DOCUMENT, PROJECT_B, ORG);
  return database;
}

describe("Authority baseline V9", () => {
  it("is a fresh-only V9 schema and leaves V8 pinned", () => {
    const v8 = opened();
    applyAuthorityBaselineV8(v8);
    expect(v8.pragma("user_version", { simple: true })).toBe(8);
    expect(() => applyAuthorityBaselineV9(v8)).toThrow("completely empty");

    const database = seededV9();
    expect(database.pragma("user_version", { simple: true })).toBe(AUTHORITY_BASELINE_SCHEMA_VERSION_V9);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps upload-time audience grants immutable while allowing one original in multiple projects", () => {
    const database = seededV9();
    expect(database.prepare("SELECT project_id FROM authority_project_context_associations_v1 WHERE context_id = ? ORDER BY project_id").pluck().all(CONTEXT)).toEqual([PROJECT_A, PROJECT_B]);
    expect(database.prepare("SELECT project_id FROM authority_person_document_associations_v1 WHERE document_id = ? ORDER BY project_id").pluck().all(DOCUMENT)).toEqual([PROJECT_A, PROJECT_B]);
    expect(database.prepare("SELECT audience_project_ids_json FROM authority_person_updates_v2 WHERE context_id = ?").pluck().get(CONTEXT)).toBe(JSON.stringify([PROJECT_A, PROJECT_B]));
    expect(() => database.prepare("DELETE FROM authority_person_update_audience_projects_v1 WHERE context_id = ? AND project_id = ?").run(CONTEXT, PROJECT_A)).toThrow("immutable");
    expect(() => database.prepare("UPDATE authority_person_document_audience_projects_v1 SET project_id = ? WHERE document_id = ? AND project_id = ?").run(PROJECT_A, DOCUMENT, PROJECT_B)).toThrow("immutable");
    expect(() => database.prepare("INSERT INTO authority_person_update_audience_projects_v1 VALUES (?, ?, ?)").run(CONTEXT, PROJECT_C, ORG)).toThrow("immutable custody");
    expect(() => database.prepare("INSERT INTO authority_person_document_audience_projects_v1 VALUES (?, ?, ?)").run(DOCUMENT, PROJECT_C, ORG)).toThrow("immutable custody");
    database.prepare("DELETE FROM authority_project_context_associations_v1 WHERE context_id = ? AND project_id = ?").run(CONTEXT, PROJECT_B);
    expect(database.prepare("SELECT count(*) FROM authority_project_context_associations_v1 WHERE context_id = ?").pluck().get(CONTEXT)).toBe(1);
    expect(database.prepare("SELECT count(*) FROM authority_person_update_audience_projects_v1 WHERE context_id = ?").pluck().get(CONTEXT)).toBe(2);
  });
});
