import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAuthorityBaseline,
  AUTHORITY_BASELINE_APPLICATION_ID_V1,
  AUTHORITY_BASELINE_SCHEMA_VERSION,
  authorityBaselineSha256,
} from "../../../../src/adapters/persistence/sqlite/baseline.js";
import { ASK_FOLLOW_UP_ABOUT_KINDS_V1 } from "../../../../src/answer-composition/ask-follow-ups-v1.js";

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
  applyAuthorityBaseline(database);
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
  for (const project of [PROJECT, PROJECT_B]) database.prepare("INSERT INTO authority_project_context_associations_v1 VALUES (?, ?, ?, ?, ?, 'owner', ?)").run(CONTEXT, project, ORG, PRINCIPAL, MEMBERSHIP, NOW);
  for (const project of [PROJECT, PROJECT_B]) database.prepare("INSERT INTO authority_person_update_audience_projects_v1 VALUES (?, ?, ?)").run(CONTEXT, project, ORG);
  database.prepare(`INSERT INTO authority_person_documents_v1
    (document_id, organization_id, principal_id, membership_id, membership_type, request_id, request_version, filename, title, detected_media_type, original_size, original_sha256, payload_sha256, audience_kind, submitted_association_project_ids_json, audience_project_ids_json, received_at)
    VALUES (?, ?, ?, ?, 'owner', 'document-v2', 2, 'brief.txt', 'Brief', 'text/plain', 5, ?, ?, 'projects', ?, ?, ?)`)
    .run(DOCUMENT, ORG, PRINCIPAL, MEMBERSHIP, SHA, SHA, JSON.stringify([PROJECT, PROJECT_B]), JSON.stringify([PROJECT, PROJECT_B]), NOW);
  database.prepare("INSERT INTO authority_person_document_originals_v1 VALUES (?, ?)").run(DOCUMENT, Buffer.from("hello"));
  for (const project of [PROJECT, PROJECT_B]) database.prepare("INSERT INTO authority_person_document_associations_v1 VALUES (?, ?, ?, ?)").run(DOCUMENT, project, ORG, NOW);
  for (const project of [PROJECT, PROJECT_B]) database.prepare("INSERT INTO authority_person_document_audience_projects_v1 VALUES (?, ?, ?)").run(DOCUMENT, project, ORG);
  return database;
}

describe("Authority baseline V17", () => {
  it("is fresh-only and stamps the Authority application id", () => {
    expect(authorityBaselineSha256()).toBe("sha256:d037af1328e0719532506c732e13db649082aaf5c3a9c770dadc09265568a3cb");
    const database = seeded();
    expect(() => applyAuthorityBaseline(database)).toThrow("completely empty");
    expect(database.pragma("application_id", { simple: true })).toBe(AUTHORITY_BASELINE_APPLICATION_ID_V1);
    expect(database.pragma("user_version", { simple: true })).toBe(AUTHORITY_BASELINE_SCHEMA_VERSION);
    expect(database.prepare("SELECT status FROM authority_projects_v1 WHERE project_id = ?").pluck().get(PROJECT)).toBe("active");
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("stamps user_version 17 on a fresh database", () => {
    const database = new Database(":memory:");
    databases.push(database);
    applyAuthorityBaseline(database);
    expect(database.pragma("user_version", { simple: true })).toBe(17);
    expect(AUTHORITY_BASELINE_SCHEMA_VERSION).toBe(17);
  });

  it("does not install storage for the removed pasted-meeting input", () => {
    const database = seeded();
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'authority_person_hand_in_meetings_%'").all()).toEqual([]);
  });

  describe("follow-ups from a chat (ADR-0053)", () => {
    const ITEM = "itm_0123456789abcdef0123456789abcdef";
    const OTHER_PRINCIPAL = "prn_22222222-2222-4222-8222-222222222222";
    const OTHER = "mem_22222222-2222-4222-8222-222222222222";
    const columns = ["item_id", "run_id", "item_key", "pointer_json", "record_sha256", "organization_id", "approver_principal_id", "approver_membership_id",
      "relation", "expected", "due_on", "owner_membership_id", "owner_match", "state", "created_at", "updated_at"] as const;
    type Row = Partial<Record<(typeof columns)[number] | "state_set_by" | "state_set_at" | "owner_set_by" | "owner_set_at", unknown>>;
    function chatRow(overrides: Row = {}): Row {
      return {
        item_id: ITEM, run_id: null, item_key: SHA, pointer_json: JSON.stringify({ kind: "chat_action", id: ITEM }), record_sha256: null,
        organization_id: ORG, approver_principal_id: PRINCIPAL, approver_membership_id: MEMBERSHIP, relation: "needs_updating",
        expected: "Send the vendor the plan", due_on: "2026-12-01", owner_membership_id: MEMBERSHIP, owner_match: "approver",
        state: "unsent", created_at: NOW, updated_at: NOW, ...overrides,
      };
    }
    function insert(database: Database.Database, row: Row): void {
      const keys = Object.keys(row);
      database.prepare(`INSERT INTO authority_impact_items_v1 (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...Object.values(row));
    }
    function withMember(): Database.Database {
      const database = seeded();
      database.prepare("INSERT INTO authority_principals VALUES (?, ?, 'Owner', ?)").run(OTHER_PRINCIPAL, ORG, NOW);
      database.prepare("INSERT INTO authority_memberships(membership_id, organization_id, principal_id, membership_type, status, provisioned_at, employee_email, employee_email_sha256) VALUES (?, ?, ?, 'employee', 'active', ?, 'owner@example.test', ?)").run(OTHER, ORG, OTHER_PRINCIPAL, NOW, `sha256:${"e".repeat(64)}`);
      return database;
    }

    it("lets a chat follow-up point only at itself or at an item of the kinds Ask's writer may link (ASK_FOLLOW_UP_ABOUT_KINDS_V1)", () => {
      const { sql } = seeded().prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'authority_impact_item_chat_insert_v1'").get() as { sql: string };
      const kinds = /'\$\.kind'\), ''\) NOT IN \(([^)]*)\)/u.exec(sql)?.[1]?.split(",").map(kind => kind.trim().replace(/^'|'$/gu, ""));
      expect(new Set(kinds)).toEqual(new Set(["chat_action", ...ASK_FOLLOW_UP_ABOUT_KINDS_V1]));
      expect(kinds).toHaveLength(ASK_FOLLOW_UP_ABOUT_KINDS_V1.length + 1);
    });

    it("makes the run, the record and the due date optional columns", () => {
      const database = seeded();
      const info = database.prepare("PRAGMA table_info(authority_impact_items_v1)").all() as { name: string; notnull: number }[];
      const column = (name: string) => info.find(entry => entry.name === name);
      expect(column("run_id")?.notnull).toBe(0);
      expect(column("record_sha256")?.notnull).toBe(0);
      expect(column("due_on")).toMatchObject({ notnull: 0 });
    });

    it("stores an unsent follow-up with its creator, owned by its creator or by a member matched by name", () => {
      const database = withMember();
      insert(database, chatRow());
      const ticket = "itm_ticket0123456789abcdef0123456789ab";
      insert(database, chatRow({ item_id: ticket, item_key: `sha256:${"d".repeat(64)}`, due_on: null, owner_membership_id: OTHER, owner_match: "name",
        pointer_json: JSON.stringify({ kind: "ticket", tool_id: "jira", external_scope_id: "site", ticket_id: "10012" }) }));
      expect(database.prepare("SELECT item_id, run_id, record_sha256, due_on FROM authority_impact_items_v1 ORDER BY item_id").all())
        .toEqual([{ item_id: ITEM, run_id: null, record_sha256: null, due_on: "2026-12-01" }, { item_id: ticket, run_id: null, record_sha256: null, due_on: null }]);
      // The primary key is the idempotency key: the same follow-up twice is refused, never a second row.
      expect(() => insert(database, chatRow())).toThrow(/UNIQUE|PRIMARY KEY/u);
    });

    it("refuses a follow-up that is not a whole, unsent, needs-updating line with its own run and record both absent", () => {
      const database = withMember();
      expect(() => insert(database, chatRow({ record_sha256: SHA }))).toThrow(/CHECK/u);
      expect(() => insert(database, chatRow({ relation: "conflicts" }))).toThrow(/CHECK/u);
      expect(() => insert(database, chatRow({ relation: null, expected: null }))).toThrow(/CHECK/u);
      expect(() => insert(database, chatRow({ expected: null }))).toThrow(/CHECK/u);
      expect(() => insert(database, chatRow({ expected: "x".repeat(121) }))).toThrow(/CHECK/u);
      for (const due_on of ["2026-02-30", "2026-1-01", "tomorrow", "2026-12-01T00:00:00Z", ""]) expect(() => insert(database, chatRow({ due_on }))).toThrow(/CHECK/u);
      expect(() => insert(database, chatRow({ state: "open" }))).toThrow(/CHECK|starts unsent/u);
      expect(() => insert(database, chatRow({ state: "unsent", state_set_by: MEMBERSHIP, state_set_at: NOW }))).toThrow("starts unsent with its creator");
      expect(() => insert(database, chatRow({ owner_match: "picked" }))).toThrow("starts unsent with its creator");
      expect(() => insert(database, chatRow({ owner_match: "jira_account" }))).toThrow("starts unsent with its creator");
      // Nobody owns it yet: it stays with its creator.
      expect(() => insert(database, chatRow({ owner_membership_id: OTHER, owner_match: "approver" }))).toThrow("starts unsent with its creator");
      for (const pointer of [{ kind: "meeting_action", record_sha256: SHA, signal_id: "a" }, { kind: "chat_action", id: "itm_another000000" }, { id: ITEM }, { kind: "tool_container" }]) {
        expect(() => insert(database, chatRow({ pointer_json: JSON.stringify(pointer) }))).toThrow("starts unsent with its creator");
      }
      // Its creator is a member of the organization, as their own principal.
      expect(() => insert(database, chatRow({ approver_principal_id: OTHER_PRINCIPAL }))).toThrow("starts unsent with its creator");
      expect(database.prepare("SELECT count(*) FROM authority_impact_items_v1").pluck().get()).toBe(0);
    });

    it("lets a run's item carry a due date, fixed from its insert like its line", () => {
      const database = withMember();
      // An item from a run needs its finished impact run to be inserted; that trigger is the run's own provenance, not the
      // due date's, so it is set aside here to reach the two rules about the due date.
      database.exec("DROP TRIGGER authority_impact_item_insert_v1");
      database.pragma("foreign_keys = OFF");
      insert(database, chatRow({ run_id: "run_meeting0001", record_sha256: SHA, pointer_json: JSON.stringify({ kind: "meeting_action", record_sha256: SHA, signal_id: "a1" }),
        owner_match: "name", owner_membership_id: OTHER, due_on: "2026-11-20" }));
      expect(database.prepare("SELECT run_id, due_on FROM authority_impact_items_v1").get()).toEqual({ run_id: "run_meeting0001", due_on: "2026-11-20" });
      const update = (set: string, ...values: unknown[]) => database.prepare(`UPDATE authority_impact_items_v1 SET ${set} WHERE item_id = ?`).run(...values, ITEM);
      expect(() => update("due_on = ?", "2026-11-21")).toThrow("identity is immutable");
      expect(() => update("due_on = NULL")).toThrow("identity is immutable");
      expect(() => update("due_on = ?", "2026-02-30")).toThrow(/CHECK|immutable/u);
      expect(database.prepare("SELECT due_on FROM authority_impact_items_v1").pluck().get()).toBe("2026-11-20");
    });

    it("lets a follow-up's line and due date change until it is closed, and nothing else of who or what it is", () => {
      const database = withMember();
      insert(database, chatRow());
      const update = (set: string, ...values: unknown[]) => database.prepare(`UPDATE authority_impact_items_v1 SET ${set} WHERE item_id = ?`).run(...values, ITEM);
      update("expected = ?, due_on = ?", "Send the vendor the final plan", null);
      update("due_on = ?", "2027-01-15");
      expect(database.prepare("SELECT expected, due_on FROM authority_impact_items_v1").get()).toEqual({ expected: "Send the vendor the final plan", due_on: "2027-01-15" });
      expect(() => update("due_on = ?", "2027-02-30")).toThrow(/CHECK/u);
      expect(() => update("expected = NULL")).toThrow(/CHECK/u);
      // It never gains a run or a record, nor changes what it points at, who made it or its relation.
      expect(() => update("record_sha256 = ?", SHA)).toThrow(/CHECK|immutable/u);
      expect(() => update("pointer_json = ?", JSON.stringify({ kind: "chat_action", id: "itm_another000000" }))).toThrow("identity is immutable");
      expect(() => update("approver_membership_id = ?, approver_principal_id = ?", OTHER, OTHER_PRINCIPAL)).toThrow("identity is immutable");
      expect(() => update("relation = 'conflicts'")).toThrow(/CHECK|immutable/u);
      // Sent, it can still change; closed, it cannot.
      update("owner_membership_id = ?, owner_match = 'picked', owner_set_by = ?, owner_set_at = ?", OTHER, MEMBERSHIP, NOW);
      update("state = 'open', sent_at = ?, send_command_id = 'send-1', send_included = 1, state_set_by = ?, state_set_at = ?", NOW, MEMBERSHIP, NOW);
      update("expected = ?", "Send the vendor the signed plan");
      update("state = 'done', state_set_by = ?, state_set_at = ?", OTHER, NOW);
      expect(() => update("expected = ?", "Too late")).toThrow("identity is immutable");
      expect(() => update("due_on = NULL")).toThrow("identity is immutable");
      expect(() => database.prepare("DELETE FROM authority_impact_items_v1").run()).toThrow("deletion is denied");
    });
  });

  it("refuses a nonempty database without mutating it", () => {
    const database = opened();
    database.exec("CREATE TABLE prior_state (id INTEGER PRIMARY KEY)");
    expect(() => applyAuthorityBaseline(database)).toThrow("authority baseline requires a completely empty database");
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
    applyAuthorityBaseline(database);
    expect(database.pragma("user_version", { simple: true })).toBe(AUTHORITY_BASELINE_SCHEMA_VERSION);
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
