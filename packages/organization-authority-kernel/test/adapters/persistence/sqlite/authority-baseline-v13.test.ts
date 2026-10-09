import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV13,
  AUTHORITY_BASELINE_APPLICATION_ID_V1,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V13,
  authorityBaselineSha256V13,
} from "../../../../src/adapters/persistence/sqlite/baseline.js";

const databases: Database.Database[] = [];
const NOW = "2026-09-26T00:00:00.000Z";
const SHA = `sha256:${"a".repeat(64)}`;
const ORG = "org_11111111-1111-4111-8111-111111111111";
const AUTHORITY = "oau_11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "prn_11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "mem_11111111-1111-4111-8111-111111111111";
const PROJECT = "prj_11111111-1111-4111-8111-111111111111";
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

function seedProject(database: Database.Database, projectID: string, name: string): void {
  database.prepare(`INSERT INTO authority_projects_v1
    (project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type)
    VALUES (?, ?, ?, ?, ?, ?, 'owner')`).run(projectID, ORG, name, NOW, PRINCIPAL, MEMBERSHIP);
}

function seeded(): Database.Database {
  const database = opened();
  applyAuthorityBaselineV13(database);
  database.prepare("INSERT INTO authority_metadata VALUES (1, ?, ?, 'Fixture', '{}', ?, ?)").run(AUTHORITY, ORG, NOW, NOW);
  database.prepare("INSERT INTO authority_principals VALUES (?, ?, 'PM', ?)").run(PRINCIPAL, ORG, NOW);
  database.prepare("INSERT INTO authority_memberships(membership_id, organization_id, principal_id, membership_type, status, provisioned_at) VALUES (?, ?, ?, 'owner', 'active', ?)").run(MEMBERSHIP, ORG, PRINCIPAL, NOW);
  database.prepare("INSERT INTO authority_project_authorization_state_v1 VALUES (?, 0, ?)").run(ORG, NOW);
  seedProject(database, PROJECT, "Project");
  return database;
}

function seededWithSources(): Database.Database {
  const database = seeded();
  seedProject(database, PROJECT_B, "Project B");
  seedProject(database, PROJECT_C, "Project C");
  database.prepare(`INSERT INTO authority_person_updates_v2
    (organization_id, principal_id, membership_id, membership_type, request_id, request_version, context_id, payload_sha256, title, text, audience_kind, submitted_association_project_ids_json, audience_project_ids_json, received_at)
    VALUES (?, ?, ?, 'owner', 'text-v3', 3, ?, ?, 'Design note', 'Original text', 'projects', ?, ?, ?)`)
    .run(ORG, PRINCIPAL, MEMBERSHIP, CONTEXT, SHA, JSON.stringify([PROJECT, PROJECT_B]), JSON.stringify([PROJECT, PROJECT_B]), NOW);
  database.prepare("INSERT INTO authority_project_context_associations_v1 VALUES (?, ?, ?, ?, ?, 'owner', ?)").run(CONTEXT, PROJECT, ORG, PRINCIPAL, MEMBERSHIP, NOW);
  database.prepare("INSERT INTO authority_project_context_associations_v1 VALUES (?, ?, ?, ?, ?, 'owner', ?)").run(CONTEXT, PROJECT_B, ORG, PRINCIPAL, MEMBERSHIP, NOW);
  database.prepare("INSERT INTO authority_person_update_audience_projects_v1 VALUES (?, ?, ?)").run(CONTEXT, PROJECT, ORG);
  database.prepare("INSERT INTO authority_person_update_audience_projects_v1 VALUES (?, ?, ?)").run(CONTEXT, PROJECT_B, ORG);
  database.prepare(`INSERT INTO authority_person_documents_v1
    (document_id, organization_id, principal_id, membership_id, membership_type, request_id, request_version, filename, title, detected_media_type, original_size, original_sha256, payload_sha256, audience_kind, submitted_association_project_ids_json, audience_project_ids_json, received_at)
    VALUES (?, ?, ?, ?, 'owner', 'document-v2', 2, 'brief.txt', 'Brief', 'text/plain', 5, ?, ?, 'projects', ?, ?, ?)`)
    .run(DOCUMENT, ORG, PRINCIPAL, MEMBERSHIP, SHA, SHA, JSON.stringify([PROJECT, PROJECT_B]), JSON.stringify([PROJECT, PROJECT_B]), NOW);
  database.prepare("INSERT INTO authority_person_document_originals_v1 VALUES (?, ?)").run(DOCUMENT, Buffer.from("hello"));
  database.prepare("INSERT INTO authority_person_document_associations_v1 VALUES (?, ?, ?, ?)").run(DOCUMENT, PROJECT, ORG, NOW);
  database.prepare("INSERT INTO authority_person_document_associations_v1 VALUES (?, ?, ?, ?)").run(DOCUMENT, PROJECT_B, ORG, NOW);
  database.prepare("INSERT INTO authority_person_document_audience_projects_v1 VALUES (?, ?, ?)").run(DOCUMENT, PROJECT, ORG);
  database.prepare("INSERT INTO authority_person_document_audience_projects_v1 VALUES (?, ?, ?)").run(DOCUMENT, PROJECT_B, ORG);
  return database;
}

describe("Authority baseline V13", () => {
  it("is fresh-only and stamps the Authority application id", () => {
    expect(authorityBaselineSha256V13()).toBe("sha256:9e3726b7b559664979e08ee32380fad94537e1633ae8a537fce758d526927049");
    const database = seeded();
    expect(() => applyAuthorityBaselineV13(database)).toThrow("completely empty");
    expect(database.pragma("application_id", { simple: true })).toBe(AUTHORITY_BASELINE_APPLICATION_ID_V1);
    expect(database.pragma("user_version", { simple: true })).toBe(AUTHORITY_BASELINE_SCHEMA_VERSION_V13);
    expect(database.prepare("SELECT status FROM authority_projects_v1 WHERE project_id = ?").pluck().get(PROJECT)).toBe("active");
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("stamps user_version 13 on a fresh database", () => {
    const database = new Database(":memory:");
    databases.push(database);
    applyAuthorityBaselineV13(database);
    expect(database.pragma("user_version", { simple: true })).toBe(13);
    expect(AUTHORITY_BASELINE_SCHEMA_VERSION_V13).toBe(13);
  });

  it("refuses a nonempty database without mutating it", () => {
    const database = opened();
    database.exec("CREATE TABLE prior_state (id INTEGER PRIMARY KEY)");
    expect(() => applyAuthorityBaselineV13(database)).toThrow("authority baseline requires a completely empty database");
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'prior_state'").get()).toEqual({ name: "prior_state" });
  });

  it("keeps upload-time audience grants immutable while allowing one original in multiple projects", () => {
    const database = seededWithSources();
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.prepare("SELECT project_id FROM authority_project_context_associations_v1 WHERE context_id = ? ORDER BY project_id").pluck().all(CONTEXT)).toEqual([PROJECT, PROJECT_B]);
    expect(database.prepare("SELECT project_id FROM authority_person_document_associations_v1 WHERE document_id = ? ORDER BY project_id").pluck().all(DOCUMENT)).toEqual([PROJECT, PROJECT_B]);
    expect(database.prepare("SELECT audience_project_ids_json FROM authority_person_updates_v2 WHERE context_id = ?").pluck().get(CONTEXT)).toBe(JSON.stringify([PROJECT, PROJECT_B]));
    expect(() => database.prepare("DELETE FROM authority_person_update_audience_projects_v1 WHERE context_id = ? AND project_id = ?").run(CONTEXT, PROJECT)).toThrow("immutable");
    expect(() => database.prepare("UPDATE authority_person_document_audience_projects_v1 SET project_id = ? WHERE document_id = ? AND project_id = ?").run(PROJECT, DOCUMENT, PROJECT_B)).toThrow("immutable");
    expect(() => database.prepare("INSERT INTO authority_person_update_audience_projects_v1 VALUES (?, ?, ?)").run(CONTEXT, PROJECT_C, ORG)).toThrow("immutable custody");
    expect(() => database.prepare("INSERT INTO authority_person_document_audience_projects_v1 VALUES (?, ?, ?)").run(DOCUMENT, PROJECT_C, ORG)).toThrow("immutable custody");
    database.prepare("DELETE FROM authority_project_context_associations_v1 WHERE context_id = ? AND project_id = ?").run(CONTEXT, PROJECT_B);
    expect(database.prepare("SELECT count(*) FROM authority_project_context_associations_v1 WHERE context_id = ?").pluck().get(CONTEXT)).toBe(1);
    expect(database.prepare("SELECT count(*) FROM authority_person_update_audience_projects_v1 WHERE context_id = ?").pluck().get(CONTEXT)).toBe(2);
  });

  it("permits only name and status changes and advances the project authorization revision", () => {
    const database = seeded();
    expect(database.prepare("SELECT revision FROM authority_project_authorization_state_v1").pluck().get()).toBe(1);

    database.prepare("UPDATE authority_projects_v1 SET name = 'Renamed' WHERE project_id = ?").run(PROJECT);
    database.prepare("UPDATE authority_projects_v1 SET status = 'archived' WHERE project_id = ?").run(PROJECT);
    database.prepare("UPDATE authority_projects_v1 SET status = 'active' WHERE project_id = ?").run(PROJECT);
    expect(database.prepare("SELECT name, status FROM authority_projects_v1 WHERE project_id = ?").get(PROJECT)).toEqual({ name: "Renamed", status: "active" });
    expect(database.prepare("SELECT revision FROM authority_project_authorization_state_v1").pluck().get()).toBe(4);
    expect(() => database.prepare("UPDATE authority_projects_v1 SET created_at = ? WHERE project_id = ?").run("2026-09-26T00:00:01.000Z", PROJECT)).toThrow("identity is immutable");
    expect(() => database.prepare("UPDATE authority_projects_v1 SET status = 'deleted' WHERE project_id = ?").run(PROJECT)).toThrow();
  });

  it("requires the V1 settings receipt fields for project setting operations", () => {
    const database = seeded();
    const insert = database.prepare(`INSERT INTO authority_project_command_receipts_v1
      (organization_id, principal_id, membership_id, membership_type, request_id, operation, command_sha256, receipt_json, receipt_sha256, committed_at)
      VALUES (?, ?, ?, 'owner', ?, 'archive', ?, ?, ?, ?)`);
    expect(() => insert.run(ORG, PRINCIPAL, MEMBERSHIP, "request-1", SHA, "{}", SHA, NOW)).toThrow();
    const receipt = {
      schema_version: 1,
      kind: "echo-project-settings-receipt-v1",
      request_id: "request-1",
      project_id: PROJECT,
      operation: "archive",
      received_at: NOW,
      state: "applied",
    };
    insert.run(ORG, PRINCIPAL, MEMBERSHIP, "request-1", SHA, JSON.stringify(receipt), SHA, NOW);
  });

  it("freezes the approved snapshot and suggestions once and keeps them through supersession", () => {
    const database = opened();
    database.pragma("foreign_keys = OFF");
    applyAuthorityBaselineV13(database);
    expect(database.pragma("user_version", { simple: true })).toBe(AUTHORITY_BASELINE_SCHEMA_VERSION_V13);
    const columns = (database.prepare("PRAGMA table_info(authority_live_approval_outbox_v2)").all() as { name: string }[]).map(row => row.name);
    expect(columns).toContain("suggested_projects_json");
    expect(columns).not.toContain("private_approval_card_v2_json");
    for (const id of ["test", "next"]) {
      database.prepare("INSERT INTO authority_live_approval_outbox_v2(candidate_id,approval_id,stage_command_id,state,updated_at) VALUES (?,?,?,'queued',?)").run(`cnd_${id}`, `apr_${id}`, `pas_${id}`, NOW);
    }
    const freeze = "UPDATE authority_live_approval_outbox_v2 SET state = 'staged', approved_snapshot_json = '{\"approval_id\":\"apr_test\"}', approved_snapshot_sha256 = ?, suggested_projects_json = '[]', updated_at = ? WHERE candidate_id = 'cnd_test'";
    database.prepare(freeze).run(SHA, NOW);
    expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET approved_snapshot_sha256 = ? WHERE candidate_id = 'cnd_test'").run(`sha256:${"b".repeat(64)}`)).toThrow("queued-staged-superseded");
    expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET suggested_projects_json = NULL, approved_snapshot_json = NULL, approved_snapshot_sha256 = NULL WHERE candidate_id = 'cnd_test'").run()).toThrow("queued-staged-superseded");
    database.prepare("UPDATE authority_live_approval_outbox_v2 SET state = 'superseded', superseded_by_candidate_id = 'cnd_next', superseded_at = ?, updated_at = ? WHERE candidate_id = 'cnd_test'").run(NOW, NOW);
    expect(database.prepare("SELECT state, approved_snapshot_sha256, suggested_projects_json FROM authority_live_approval_outbox_v2 WHERE candidate_id = 'cnd_test'").get())
      .toEqual({ state: "superseded", approved_snapshot_sha256: SHA, suggested_projects_json: "[]" });
  });
});
