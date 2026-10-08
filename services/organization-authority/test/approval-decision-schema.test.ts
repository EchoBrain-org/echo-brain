import { describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV12,
  AUTHORITY_BASELINE_APPLICATION_ID_V1,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V12,
  authorityBaselineSha256V12,
} from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";

const AUTHORITY_BASELINE_SHA256_V12 =
  "sha256:246367cc63916bc55c1ce9fcfbbc6fa71c9ad2fbfe62c3e2a3bbc5bd63c59e77";
const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-30T00:00:00.000Z";

function openedCurrentDatabase() {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV12(database);
  return database;
}

function seedCandidate(database: ReturnType<typeof openedCurrentDatabase>): void {
  database
    .prepare(
      `INSERT INTO authority_metadata (
        singleton, authority_id, organization_id, organization_display_name,
        descriptor_json, created_at, last_observed_at
      ) VALUES (1, 'oau_1', 'org_1', 'Example', '{}', ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO authority_principals (
        principal_id, organization_id, display_name, provisioned_at
      ) VALUES ('prn_1', 'org_1', 'Owner', ?)`,
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO authority_memberships (
        membership_id, organization_id, principal_id, membership_type, status,
        provisioned_at, revoked_at, revocation_reason, employee_email,
        employee_email_sha256
      ) VALUES ('mem_1', 'org_1', 'prn_1', 'owner', 'active', ?, NULL, NULL, NULL, NULL)`,
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO authority_live_source_admission_v2 (
        source_key, organization_id, principal_id, membership_id, membership_type,
        source_adapter_id, source_adapter_version, source_adapter_instance_id,
        normalizer_version, source_custodian_sha256,
        source_custodian_assurance, source_custodian_observed_at,
        source_credential_reference_sha256, initial_cursor, cutoff_at,
        processor_adapter_id, processor_adapter_version, processor_instance_id,
        processor_configuration_sha256, processor_credential_reference_sha256,
        semantic_input_sha256, admitted_at
      ) VALUES (
        1, 'org_1', 'prn_1', 'mem_1', 'owner',
        'synthetic-meeting-fixture-v1', '1.0.0', 'synthetic-fixture',
        '1.0.0', ?, 'fixture_owner_declared', ?, ?,
        'fixture://cursor/zero', ?,
        'decision-processor', '1.0.0', 'processor', ?, ?, ?, ?
      )`,
    )
    .run(DIGEST, NOW, DIGEST, NOW, DIGEST, DIGEST, DIGEST, NOW);
  database
    .prepare(
      `INSERT INTO authority_live_source_candidates_v2 (
        candidate_id, candidate_semantic_sha256, admission_semantic_input_sha256,
        review_lineage_id, review_input_sha256, review_semantic_sha256,
        review_policy_id, review_policy_contract_sha256,
        review_policy_consequence_text, review_policy_consequence_sha256,
        disposition, source_cursor, meeting_sha256, meeting_json,
        decisions_sha256, decisions_json, created_at
      ) VALUES (
        'cnd_1', ?, ?, 'rli_1', ?, ?, 'restricted', ?, 'Only me', ?,
        'actionable', 'fixture://cursor/one', ?, '{"meeting":true}', ?,
        '{"decisions":true}', ?
      )`,
    )
    .run(
      DIGEST,
      DIGEST,
      DIGEST,
      DIGEST,
      DIGEST,
      DIGEST,
      DIGEST,
      DIGEST,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO authority_live_source_candidates_v2 (
        candidate_id, candidate_semantic_sha256, admission_semantic_input_sha256,
        review_lineage_id, review_input_sha256, review_semantic_sha256,
        review_policy_id, review_policy_contract_sha256,
        review_policy_consequence_text, review_policy_consequence_sha256,
        disposition, source_cursor, meeting_sha256, meeting_json,
        decisions_sha256, decisions_json, created_at
      ) VALUES (
        'cnd_2', ?, ?, 'rli_2', ?, ?, 'restricted', ?, 'Only me', ?,
        'actionable', 'fixture://cursor/two', ?, '{"meeting":false}', ?,
        '{"decisions":false}', ?
      )`,
    )
    .run(
      `sha256:${"b".repeat(64)}`,
      DIGEST,
      `sha256:${"c".repeat(64)}`,
      `sha256:${"d".repeat(64)}`,
      `sha256:${"e".repeat(64)}`,
      `sha256:${"f".repeat(64)}`,
      `sha256:${"1".repeat(64)}`,
      `sha256:${"2".repeat(64)}`,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO authority_live_source_candidates_v2 (
        candidate_id, candidate_semantic_sha256, admission_semantic_input_sha256,
        review_lineage_id, review_input_sha256, review_semantic_sha256,
        review_policy_id, review_policy_contract_sha256,
        review_policy_consequence_text, review_policy_consequence_sha256,
        disposition, source_cursor, meeting_sha256, meeting_json,
        decisions_sha256, decisions_json, created_at
      ) VALUES (
        'cnd_3', ?, ?, 'rli_3', ?, ?, 'restricted', ?, 'Only me', ?,
        'actionable', 'fixture://cursor/three', ?, '{"meeting":3}', ?,
        '{"decisions":3}', ?
      )`,
    )
    .run(`sha256:${"3".repeat(64)}`, DIGEST, `sha256:${"4".repeat(64)}`, `sha256:${"5".repeat(64)}`, `sha256:${"6".repeat(64)}`,
      `sha256:${"7".repeat(64)}`, `sha256:${"8".repeat(64)}`, `sha256:${"9".repeat(64)}`, NOW);
  for (const [candidate, approval] of [["cnd_1", "apr_1"], ["cnd_2", "apr_2"], ["cnd_3", "apr_3"]]) {
    database
      .prepare(
        `INSERT INTO authority_live_approval_outbox_v2 (
          candidate_id, approval_id, stage_command_id, state, updated_at
        ) VALUES (?, ?, ?, 'queued', ?)`,
      )
      .run(candidate, approval, `pas_${approval.slice(4)}`, NOW);
  }
  database.prepare("INSERT INTO authority_principals VALUES ('prn_2', 'org_1', 'Other', ?)").run(NOW);
  database.prepare("INSERT INTO authority_memberships (membership_id, organization_id, principal_id, membership_type, status, provisioned_at, employee_email, employee_email_sha256) VALUES ('mem_2', 'org_1', 'prn_2', 'employee', 'active', ?, 'other@example.test', ?)").run(NOW, DIGEST);
  for (const [project, status, creator] of [[PROJECT_A, "active", 1], [PROJECT_B, "archived", 1], [PROJECT_C, "active", 2]] as const) {
    database.prepare(`INSERT INTO authority_projects_v1 VALUES (?, 'org_1', ?, ?, ?, ?, ?, ?)`)
      .run(project, `Project ${project.slice(-2)}`, status, NOW, `prn_${creator}`, `mem_${creator}`, creator === 1 ? "owner" : "employee");
  }
  let grant = 0;
  for (const [project, member] of [[PROJECT_A, 1], [PROJECT_B, 1], [PROJECT_C, 2]] as const) {
    database.prepare("INSERT INTO authority_project_memberships_v1 VALUES (?, ?, 'org_1', ?, ?, ?, 'member', 'active', ?, NULL)")
      .run(`pgm_00000000-0000-4000-8000-${String(++grant).padStart(12, "0")}`, project, `prn_${member}`, `mem_${member}`, member === 1 ? "owner" : "employee", NOW);
  }
}

const PROJECT_A = "prj_00000000-0000-4000-8000-0000000000a1";
const PROJECT_B = "prj_00000000-0000-4000-8000-0000000000b1";
const PROJECT_C = "prj_00000000-0000-4000-8000-0000000000c1";

type Database = ReturnType<typeof openedCurrentDatabase>;
function freeze(database: Database, candidate: string, approval: string, projects: unknown = [], snapshot: unknown = { approval_id: approval }, sha: unknown = DIGEST) {
  database.prepare(`UPDATE authority_live_approval_outbox_v2 SET state = 'staged', approved_snapshot_json = ?, approved_snapshot_sha256 = ?,
    suggested_projects_json = ?, updated_at = ? WHERE candidate_id = ?`).run(JSON.stringify(snapshot), sha, projects === null ? null : JSON.stringify(projects), NOW, candidate);
}
function body(o: { approval?: string; command?: string; surface?: string; action?: string; request?: Record<string, unknown>; actor?: Record<string, unknown>; evidence?: Record<string, unknown>; decided_at?: unknown } = {}) {
  const approval = o.approval ?? "apr_1", command = o.command ?? "desk-1", surface = o.surface ?? "desktop", action = o.action ?? "approve";
  return {
    request: { approval_id: approval, command_id: command, snapshot_sha256: DIGEST, action, project_ids: [], share_transcript: false, owners: [], ...o.request },
    surface, actor: { organization_id: "org_1", principal_id: "prn_1", membership_id: "mem_1", ...o.actor },
    evidence: { kind: surface === "desktop" ? "person-session" : "slack-click", sha256: DIGEST, ...o.evidence },
    decided_at: o.decided_at === undefined ? NOW : o.decided_at,
  };
}
function decide(database: Database, o: Parameters<typeof body>[0] & { readonly row?: { approval?: string; command?: string; surface?: string; action?: string }; readonly json?: unknown } = {}) {
  const row = { approval: o.approval ?? "apr_1", command: o.command ?? "desk-1", surface: o.surface ?? "desktop", action: o.action ?? "approve", ...o.row };
  return database.prepare("INSERT INTO authority_approval_decisions_v1 (approval_id, command_id, surface, action, body_json) VALUES (?, ?, ?, ?, ?)")
    .run(row.approval, row.command, row.surface, row.action, JSON.stringify(o.json === undefined ? body(o) : o.json));
}
function receipt(record: unknown, body: unknown = { record_sha256: record }) {
  return JSON.stringify({ record_sha256: record, receipt: { body, signature: "fixture" } });
}

describe("Authority approval decision schema", () => {
  it("retains the current proposal and decision schema", () => {
    const database = openedCurrentDatabase();
    try {
      expect(authorityBaselineSha256V12()).toBe(AUTHORITY_BASELINE_SHA256_V12);
      expect(database.pragma("application_id", { simple: true })).toBe(AUTHORITY_BASELINE_APPLICATION_ID_V1);
      expect(database.pragma("user_version", { simple: true })).toBe(AUTHORITY_BASELINE_SCHEMA_VERSION_V12);
      const columns = (table: string) => database.prepare(`PRAGMA table_info(${table})`).all().map((row) => (row as { readonly name: string }).name);
      expect(columns("authority_live_approval_outbox_v2")).toEqual([
        "candidate_id", "approval_id", "stage_command_id", "state", "approved_snapshot_json", "approved_snapshot_sha256",
        "suggested_projects_json", "superseded_by_candidate_id", "superseded_at", "updated_at",
      ]);
      expect(columns("authority_approval_decisions_v1")).toEqual(["sequence", "approval_id", "command_id", "surface", "action", "body_json", "receipt_json"]);
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all();
      expect(tables).not.toContain("authority_live_approval_delivery_quarantines_v1");
      expect(tables).not.toContain("authority_person_meeting_approval_actions_v1");
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("freezes a proposal once, with a snapshot of its own approval and sorted existing suggestions", () => {
    const database = openedCurrentDatabase();
    try {
      seedCandidate(database);
      for (const [label, args, error] of [
        ["another approval's snapshot", [[], { approval_id: "apr_2" }], /CHECK constraint failed/],
        ["an uppercase digest", [[], { approval_id: "apr_1" }, `sha256:${"A".repeat(64)}`], /CHECK constraint failed/],
        ["suggestions that are not an array", [{ project: PROJECT_A }], /CHECK constraint failed/],
        ["more than 20 suggestions", [Array.from({ length: 21 }, () => PROJECT_A)], /CHECK constraint failed|sorted, unique, existing projects/],
        ["a snapshot without suggestions", [null], /CHECK constraint failed/],
        ["unsorted suggestions", [[PROJECT_B, PROJECT_A]], /sorted, unique, existing projects/],
        ["duplicate suggestions", [[PROJECT_A, PROJECT_A]], /sorted, unique, existing projects/],
        ["an unknown project", [["prj_00000000-0000-4000-8000-0000000000f1"]], /sorted, unique, existing projects/],
        ["a non-text suggestion", [[7]], /sorted, unique, existing projects/],
      ] as const) {
        expect(() => freeze(database, "cnd_1", "apr_1", ...(args as unknown as [unknown, unknown?, unknown?])), label).toThrow(error);
      }
      freeze(database, "cnd_1", "apr_1", [PROJECT_A, PROJECT_B]);
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET suggested_projects_json = '[]' WHERE candidate_id = 'cnd_1'").run())
        .toThrow(/only permits queued-staged-superseded/);
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET approved_snapshot_sha256 = ? WHERE candidate_id = 'cnd_1'").run(`sha256:${"b".repeat(64)}`))
        .toThrow(/only permits queued-staged-superseded/);
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET state = 'queued', approved_snapshot_json = NULL, approved_snapshot_sha256 = NULL, suggested_projects_json = NULL WHERE candidate_id = 'cnd_1'").run())
        .toThrow(/only permits queued-staged-superseded/);
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET state = 'superseded', approved_snapshot_json = NULL, approved_snapshot_sha256 = NULL, suggested_projects_json = NULL, superseded_by_candidate_id = 'cnd_2', superseded_at = ? WHERE candidate_id = 'cnd_1'").run(NOW))
        .toThrow(/only permits queued-staged-superseded/);
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET state = 'superseded', superseded_by_candidate_id = 'cnd_2', superseded_at = ? WHERE candidate_id = 'cnd_2'").run(NOW))
        .toThrow(/CHECK constraint failed/);
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET state = 'superseded', approved_snapshot_json = '{\"approval_id\":\"apr_2\"}', approved_snapshot_sha256 = ?, suggested_projects_json = '[]', superseded_by_candidate_id = 'cnd_1', superseded_at = ? WHERE candidate_id = 'cnd_2'").run(DIGEST, NOW))
        .toThrow(/only permits queued-staged-superseded/);
      // An undecided frozen proposal is superseded with its snapshot kept; it never returns.
      database.prepare("UPDATE authority_live_approval_outbox_v2 SET state = 'superseded', superseded_by_candidate_id = 'cnd_2', superseded_at = ? WHERE candidate_id = 'cnd_1'").run(NOW);
      expect(database.prepare("SELECT state, suggested_projects_json FROM authority_live_approval_outbox_v2 WHERE candidate_id = 'cnd_1'").get())
        .toEqual({ state: "superseded", suggested_projects_json: JSON.stringify([PROJECT_A, PROJECT_B]) });
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET state = 'staged', superseded_by_candidate_id = NULL, superseded_at = NULL WHERE candidate_id = 'cnd_1'").run())
        .toThrow(/only permits queued-staged-superseded/);
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET updated_at = ? WHERE candidate_id = 'cnd_1'").run(NOW))
        .toThrow(/only permits queued-staged-superseded/);
      expect(() => decide(database)).toThrow(/needs its staged proposal/);
    } finally {
      database.close();
    }
  });

  it("refuses a decision body that does not match its row, NULL fields included", () => {
    const database = openedCurrentDatabase();
    try {
      seedCandidate(database);
      freeze(database, "cnd_1", "apr_1", [PROJECT_A]);
      // Only the CHECKs refuse here; the insert triggers are covered below.
      for (const trigger of ["staged", "reviewer", "audience"]) database.exec(`DROP TRIGGER authority_approval_decision_${trigger}_v1`);
      const { request: _request, ...withoutRequest } = body();
      for (const [label, input] of [
        ["no request.action", { request: { action: undefined } }],
        ["another action", { row: { action: "reject" } }],
        ["another approval", { request: { approval_id: "apr_2" } }],
        ["another command", { request: { command_id: "desk-2" } }],
        ["another surface", { json: { ...body(), surface: "slack" } }],
        ["no surface", { json: { ...body(), surface: undefined } }],
        ["projects that are not an array", { request: { project_ids: PROJECT_A } }],
        ["a string share choice", { request: { share_transcript: "false" } }],
        ["no share choice", { request: { share_transcript: undefined } }],
        ["owners that are not an array", { request: { owners: {} } }],
        ["more than 40 owners", { request: { owners: Array.from({ length: 41 }, (_, i) => ({ signal_id: `a${i}`, owner: "A" })) } }],
        ["no membership", { actor: { membership_id: undefined } }],
        ["a numeric principal", { actor: { principal_id: 1 } }],
        ["slack evidence on desktop", { evidence: { kind: "slack-click" } }],
        ["no evidence digest", { evidence: { sha256: undefined } }],
        ["an invalid decision time", { decided_at: "yesterday" }],
        ["a desktop command named slack:", { command: "slack:1", request: { command_id: "slack:1" } }],
        ["a slack command without the prefix", { surface: "slack", command: "click-1", request: { command_id: "click-1" } }],
        ["a command with a space", { command: "desk 1", request: { command_id: "desk 1" } }],
        ["a command over 128 characters", { command: "d".repeat(129), request: { command_id: "d".repeat(129) } }],
        ["an unknown surface", { surface: "email", evidence: { kind: "slack-click" } }],
        ["a rejection with projects", { action: "reject", request: { project_ids: [PROJECT_A] } }],
        ["a rejection that shares the transcript", { action: "reject", request: { share_transcript: true } }],
        ["a rejection with owners", { action: "reject", request: { owners: [{ signal_id: "a1", owner: "A" }] } }],
      ] as const) {
        expect(() => decide(database, input as Parameters<typeof decide>[1]), label).toThrow(/CHECK constraint failed/);
      }
      // With no request at all, the staged-snapshot trigger refuses it before the CHECK runs.
      expect(() => decide(database, { json: withoutRequest })).toThrow(/needs its staged proposal|CHECK constraint failed/);
      expect(() => decide(database, { request: { snapshot_sha256: 7 } })).toThrow(/needs its staged proposal|CHECK constraint failed/);
      expect(() => decide(database, { request: { project_ids: Array.from({ length: 21 }, () => PROJECT_A) } })).toThrow(/audience needs active project membership|CHECK constraint failed/);
      expect(database.prepare("SELECT count(*) FROM authority_approval_decisions_v1").pluck().get()).toBe(0);
      // The well-formed body each case was derived from is accepted.
      decide(database, { request: { project_ids: [PROJECT_A], share_transcript: true, owners: [{ signal_id: "act-1", owner: "Ana" }] } });
      expect(database.prepare("SELECT count(*) FROM authority_approval_decisions_v1").pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("lets only the active reviewer decide the exact staged snapshot for projects they can read", () => {
    const database = openedCurrentDatabase();
    try {
      seedCandidate(database);
      expect(() => decide(database)).toThrow(/needs its staged proposal/);
      freeze(database, "cnd_1", "apr_1", [PROJECT_A]);
      expect(() => decide(database, { request: { snapshot_sha256: `sha256:${"b".repeat(64)}` } })).toThrow(/needs its staged proposal/);
      expect(() => decide(database, { actor: { principal_id: "prn_2", membership_id: "mem_2" } })).toThrow(/needs the active reviewer/);
      expect(() => decide(database, { actor: { organization_id: "org_2" } })).toThrow(/needs the active reviewer/);
      for (const projects of [[PROJECT_C, PROJECT_A], [PROJECT_A, PROJECT_A], [PROJECT_B], [PROJECT_C], [7]]) {
        expect(() => decide(database, { request: { project_ids: projects } }), JSON.stringify(projects)).toThrow(/audience needs active project membership/);
      }
      database.prepare("UPDATE authority_memberships SET status = 'revoked', revoked_at = ?, revocation_reason = 'fixture' WHERE membership_id = 'mem_1'").run(NOW);
      expect(() => decide(database)).toThrow(/needs the active reviewer/);
      expect(database.prepare("SELECT count(*) FROM authority_approval_decisions_v1").pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("keeps one immutable decision per proposal and fills its receipt once", () => {
    const database = openedCurrentDatabase();
    try {
      seedCandidate(database);
      freeze(database, "cnd_1", "apr_1", [PROJECT_A]);
      freeze(database, "cnd_2", "apr_2");
      freeze(database, "cnd_3", "apr_3");
      decide(database, { request: { project_ids: [PROJECT_A], share_transcript: true, owners: [{ signal_id: "act-1", owner: "Ana" }] } });
      expect(() => decide(database, { command: "desk-other", request: { command_id: "desk-other" } })).toThrow(/UNIQUE constraint failed: authority_approval_decisions_v1.approval_id/);
      expect(() => decide(database, { approval: "apr_2", request: { approval_id: "apr_2" } })).toThrow(/UNIQUE constraint failed: authority_approval_decisions_v1.command_id/);
      decide(database, { approval: "apr_2", command: "slack:k", surface: "slack", action: "reject", request: { approval_id: "apr_2", command_id: "slack:k" } });
      expect(() => database.prepare("UPDATE authority_approval_decisions_v1 SET body_json = ? WHERE approval_id = 'apr_1'").run(JSON.stringify(body({ request: { share_transcript: false } }))))
        .toThrow(/approval decision is immutable/);
      expect(() => database.prepare("UPDATE authority_approval_decisions_v1 SET surface = 'slack' WHERE approval_id = 'apr_1'").run()).toThrow(/approval decision is immutable/);
      const record = `sha256:${"c".repeat(64)}`;
      for (const [label, value] of [
        ["a receipt without its record digest", JSON.stringify({ receipt: { body: { record_sha256: record } } })],
        ["a receipt naming another record", receipt(record, { record_sha256: `sha256:${"d".repeat(64)}` })],
        ["a receipt without a signed body digest", receipt(record, {})],
        ["a receipt that is not an object", JSON.stringify({ record_sha256: record, receipt: "signed" })],
        ["a numeric record digest", JSON.stringify({ record_sha256: 7, receipt: { body: { record_sha256: 7 } } })],
        ["a receipt array", "[]"],
      ] as const) {
        expect(() => database.prepare("UPDATE authority_approval_decisions_v1 SET receipt_json = ? WHERE approval_id = 'apr_1'").run(value), label).toThrow(/CHECK constraint failed/);
      }
      expect(() => database.prepare("UPDATE authority_approval_decisions_v1 SET receipt_json = ? WHERE approval_id = 'apr_2'").run(receipt(record))).toThrow(/CHECK constraint failed/);
      database.prepare("UPDATE authority_approval_decisions_v1 SET receipt_json = ? WHERE approval_id = 'apr_1'").run(receipt(record));
      expect(database.prepare("SELECT json_extract(receipt_json, '$.record_sha256') FROM authority_approval_decisions_v1 WHERE approval_id = 'apr_1'").pluck().get()).toBe(record);
      expect(() => database.prepare("UPDATE authority_approval_decisions_v1 SET receipt_json = ? WHERE approval_id = 'apr_1'").run(receipt(`sha256:${"e".repeat(64)}`)))
        .toThrow(/approval decision is immutable/);
      expect(() => database.prepare("DELETE FROM authority_approval_decisions_v1 WHERE approval_id = 'apr_2'").run()).toThrow(/approval decision deletion is denied/);
      // A decided proposal is final: never superseded, frozen fields never change.
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET state = 'superseded', superseded_by_candidate_id = 'cnd_3', superseded_at = ? WHERE candidate_id = 'cnd_1'").run(NOW))
        .toThrow(/a decided approval proposal is final/);
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET state = 'superseded', superseded_by_candidate_id = 'cnd_3', superseded_at = ? WHERE candidate_id = 'cnd_2'").run(NOW))
        .toThrow(/a decided approval proposal is final/);
      database.prepare("UPDATE authority_live_approval_outbox_v2 SET state = 'superseded', superseded_by_candidate_id = 'cnd_1', superseded_at = ? WHERE candidate_id = 'cnd_3'").run(NOW);
      expect(() => decide(database, { approval: "apr_3", command: "desk-3", request: { approval_id: "apr_3", command_id: "desk-3" } })).toThrow(/needs its staged proposal/);
      expect(() => database.prepare("DELETE FROM authority_live_approval_outbox_v2 WHERE candidate_id = 'cnd_3'").run()).toThrow(/deletion is denied/);
      expect(database.prepare("SELECT count(*) FROM authority_approval_decisions_v1 WHERE receipt_json IS NULL AND action = 'approve'").pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("refuses to relabel occupied state as a fresh database", () => {
    const database = openedCurrentDatabase();
    try {
      expect(() => applyAuthorityBaselineV12(database)).toThrow(
        /completely empty database/,
      );
    } finally {
      database.close();
    }
  });
});
