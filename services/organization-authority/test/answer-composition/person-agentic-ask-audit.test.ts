import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { SqlitePersonAgenticAskAuditV1 } from "../../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import { AGENTIC_TRIGGER_NAMES_V1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1";
import { applyAuthorityBaselineV13 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });
const requestContext = {
  authority_id: "authority_1", organization_id: "organization_1", state_lineage_id: "lineage_1",
  principal_id: "person_1", membership_id: "member_1", session_family_id: "session_1", request_id: "ask_1",
};

describe("agentic Ask audit", () => {
  it("writes a content-free success terminal witness to the existing immutable table", () => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV13(database);
    try {
      const context = { ...requestContext };
      const audit = new SqlitePersonAgenticAskAuditV1(database).forRequest(context);
      context.principal_id = "person_changed_after_binding";
      audit.append({
        kind: "echo-agentic-ask-audit-v1", outcome: "partial", receipt_digests: [digest("receipt")],
        rounds: 2, model_calls: 0, repairs: 0, fallbacks: 1, citation_count: 3,
        checked_at: "2026-09-27T00:00:00.000Z", prompt_sha256: digest("question"),
        answer_sha256: digest("answer"), response_sha256: digest("response"),
        generations: [], generation_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, finish_reason_counts: {},
      });
      const row = database.prepare("SELECT context_kind, prompt_sha256, answer_sha256, body_json FROM authority_person_read_decision_audit_v2").get() as { context_kind: string; prompt_sha256: string; answer_sha256: string; body_json: string };
      expect(row.context_kind).toBe("answer_composition");
      expect(row.prompt_sha256).toBe(digest("question"));
      expect(row.answer_sha256).toBe(digest("answer"));
      expect(row.body_json).toContain('"kind":"echo-person-agentic-ask-audit-v1"');
      expect(JSON.parse(row.body_json)).toMatchObject(requestContext);
      expect(row.body_json).not.toContain("question");
    } finally { database.close(); }
  });

  it("records a research-only trigger under the background limits and keeps Ask limits for Ask", () => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV13(database);
    try {
      const store = new SqlitePersonAgenticAskAuditV1(database);
      const entry = {
        kind: "echo-agentic-ask-audit-v1" as const, outcome: "partial" as const, receipt_digests: [digest("receipt")],
        rounds: 20, model_calls: 0, repairs: 0, fallbacks: 0, citation_count: 3,
        checked_at: "2026-10-06T00:00:00.000Z", prompt_sha256: digest("prompt"), answer_sha256: digest("plan"), response_sha256: digest("result"),
        generations: [], generation_usage: { input_tokens: null, output_tokens: null, total_tokens: null }, finish_reason_counts: {},
      };
      store.forRequest(requestContext).append({ ...entry, trigger: "approved_record" });
      const row = database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2").get() as { body_json: string };
      expect(JSON.parse(row.body_json)).toMatchObject({ trigger: "approved_record", rounds: 20, outcome: "partial" });
      expect(() => store.forRequest({ ...requestContext, request_id: "ask_2" }).append(entry)).toThrow("Agentic Ask audit entry is invalid");
      expect(() => store.forRequest({ ...requestContext, request_id: "ask_3" }).append({ ...entry, trigger: "ask" as never })).toThrow("Agentic Ask audit entry is invalid");
      // A background-budget Ask (the evaluation's diagnostic) carries its budget instead of a trigger.
      store.forRequest({ ...requestContext, request_id: "ask_4" }).append({ ...entry, budget: "background" });
      expect(() => store.forRequest({ ...requestContext, request_id: "ask_5" }).append({ ...entry, budget: "huge" as never })).toThrow("Agentic Ask audit entry is invalid");
      const rows = database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2").all() as { body_json: string }[];
      expect(rows).toHaveLength(2);
      expect(rows.map(value => JSON.parse(value.body_json))).toEqual(expect.arrayContaining([expect.objectContaining({ trigger: "approved_record" }), expect.objectContaining({ budget: "background", rounds: 20 })]));
    } finally { database.close(); }
  });

  it("accepts every research-only trigger the definitions name, and no other", () => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV13(database);
    try {
      const store = new SqlitePersonAgenticAskAuditV1(database);
      const entry = {
        kind: "echo-agentic-ask-audit-v1" as const, outcome: "partial" as const, receipt_digests: [digest("receipt")],
        rounds: 20, model_calls: 0, repairs: 0, fallbacks: 0, citation_count: 3,
        checked_at: "2026-10-06T00:00:00.000Z", prompt_sha256: digest("prompt"), answer_sha256: digest("plan"), response_sha256: digest("result"),
        generations: [], generation_usage: { input_tokens: null, output_tokens: null, total_tokens: null }, finish_reason_counts: {},
      };
      // The list is the definitions': the approved record replaced Check, so a new row may no longer say check.
      expect(AGENTIC_TRIGGER_NAMES_V1).toContain("approved_record");
      for (const [index, trigger] of AGENTIC_TRIGGER_NAMES_V1.entries()) store.forRequest({ ...requestContext, request_id: `named_${index}` }).append({ ...entry, trigger });
      for (const trigger of ["check", "ask", "drift", "", "APPROVED_RECORD"]) {
        expect(() => store.forRequest({ ...requestContext, request_id: `other_${trigger}` }).append({ ...entry, trigger })).toThrow("Agentic Ask audit entry is invalid");
      }
      const rows = database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2").all() as { body_json: string }[];
      expect(rows.map(value => JSON.parse(value.body_json).trigger as string).sort()).toEqual([...AGENTIC_TRIGGER_NAMES_V1].sort());
    } finally { database.close(); }
  });

  it.each(["cancelled", "timed_out"] as const)("records %s without output hashes", (outcome) => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV13(database);
    try {
      new SqlitePersonAgenticAskAuditV1(database, () => "2026-09-27T00:00:00.000Z").forRequest(requestContext).append({
        kind: "echo-agentic-ask-audit-v1", outcome, receipt_digests: [],
        rounds: 0, model_calls: 0, repairs: 0, fallbacks: 0, citation_count: 0,
        checked_at: null, prompt_sha256: null, answer_sha256: null, response_sha256: null,
        generations: [], generation_usage: { input_tokens: null, output_tokens: null, total_tokens: null }, finish_reason_counts: {},
      });
      const row = database.prepare("SELECT prompt_sha256, answer_sha256, body_json FROM authority_person_read_decision_audit_v2").get() as { prompt_sha256: null; answer_sha256: null; body_json: string };
      expect(row.prompt_sha256).toMatch(/^sha256:/);
      expect(row.answer_sha256).toMatch(/^sha256:/);
      expect(JSON.parse(row.body_json)).toMatchObject({ ...requestContext, outcome });
      const sentinelKind = outcome === "timed_out" ? "echo-agentic-ask-timed-out-v1" : "echo-agentic-ask-cancelled-v1";
      expect(row.prompt_sha256).toBe(canonicalSha256({ kind: sentinelKind, field: "prompt" }));
    } finally { database.close(); }
  });
});
