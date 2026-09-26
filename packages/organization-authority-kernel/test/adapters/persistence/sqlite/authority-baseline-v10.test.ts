import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV9,
  applyAuthorityBaselineV10,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V10,
} from "../../../../src/adapters/persistence/sqlite/baseline.js";

const databases: Database.Database[] = [];
const NOW = "2026-09-26T00:00:00.000Z";
const SHA = `sha256:${"a".repeat(64)}`;
const ORG = "org_11111111-1111-4111-8111-111111111111";
const AUTHORITY = "oau_11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "prn_11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "mem_11111111-1111-4111-8111-111111111111";
const PROJECT = "prj_11111111-1111-4111-8111-111111111111";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function opened(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  databases.push(database);
  return database;
}

function seeded(): Database.Database {
  const database = opened();
  applyAuthorityBaselineV10(database);
  database.prepare("INSERT INTO authority_metadata VALUES (1, ?, ?, 'Fixture', '{}', ?, ?)").run(AUTHORITY, ORG, NOW, NOW);
  database.prepare("INSERT INTO authority_principals VALUES (?, ?, 'PM', ?)").run(PRINCIPAL, ORG, NOW);
  database.prepare("INSERT INTO authority_memberships(membership_id, organization_id, principal_id, membership_type, status, provisioned_at) VALUES (?, ?, ?, 'owner', 'active', ?)").run(MEMBERSHIP, ORG, PRINCIPAL, NOW);
  database.prepare("INSERT INTO authority_project_authorization_state_v1 VALUES (?, 0, ?)").run(ORG, NOW);
  database.prepare(`INSERT INTO authority_projects_v1
    (project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type)
    VALUES (?, ?, 'Project', ?, ?, ?, 'owner')`).run(PROJECT, ORG, NOW, PRINCIPAL, MEMBERSHIP);
  return database;
}

describe("Authority baseline V10", () => {
  it("is fresh-only and leaves V9 pinned", () => {
    const v9 = opened();
    applyAuthorityBaselineV9(v9);
    expect(v9.pragma("user_version", { simple: true })).toBe(9);
    expect(() => applyAuthorityBaselineV10(v9)).toThrow("completely empty");

    const database = seeded();
    expect(database.pragma("user_version", { simple: true })).toBe(AUTHORITY_BASELINE_SCHEMA_VERSION_V10);
    expect(database.prepare("SELECT status FROM authority_projects_v1 WHERE project_id = ?").pluck().get(PROJECT)).toBe("active");
    expect(database.pragma("foreign_key_check")).toEqual([]);
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

  it("freezes a nullable V2 private approval card after its first queued write", () => {
    const database = opened();
    database.pragma("foreign_keys = OFF");
    applyAuthorityBaselineV10(database);
    expect(database.pragma("user_version", { simple: true })).toBe(AUTHORITY_BASELINE_SCHEMA_VERSION_V10);
    expect(database.prepare("PRAGMA table_info(authority_live_approval_outbox_v2)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "private_approval_card_v2_json", notnull: 0 })]));
    database.prepare("INSERT INTO authority_live_approval_outbox_v2(candidate_id,approval_id,stage_command_id,state,updated_at) VALUES ('can_test','apr_test','pas_test','queued','2026-09-26T00:00:00.000Z')").run();
    database.prepare("UPDATE authority_live_approval_outbox_v2 SET private_approval_card_v2_json = '{\"kind\":\"card\"}' WHERE candidate_id = 'can_test'").run();
    expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET private_approval_card_v2_json = '{\"kind\":\"replacement\"}' WHERE candidate_id = 'can_test'").run()).toThrow("immutable");
    expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET private_approval_card_v2_json = NULL WHERE candidate_id = 'can_test'").run()).toThrow("immutable");
  });
});
