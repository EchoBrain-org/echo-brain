import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { SqlitePersonAgenticAskAuditV1 } from "../../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import { AGENTIC_TRIGGER_NAMES_V1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1";
import { applyAuthorityBaseline } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });
const requestContext = {
  authority_id: "authority_1", organization_id: "organization_1", state_lineage_id: "lineage_1",
  principal_id: "person_1", membership_id: "member_1", session_family_id: "session_1", request_id: "ask_1",
};
const entry = {
  kind: "echo-agentic-ask-audit-v1" as const, outcome: "partial" as const, receipt_digests: [digest("receipt")],
  rounds: 20, model_calls: 0, repairs: 0, fallbacks: 0, citation_count: 3,
  checked_at: "2026-10-06T00:00:00.000Z", prompt_sha256: digest("prompt"), answer_sha256: digest("plan"), response_sha256: digest("result"),
  generations: [], generation_usage: { input_tokens: null, output_tokens: null, total_tokens: null }, finish_reason_counts: {},
};
const databases: ReturnType<typeof openAuthorityDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function openedDatabase() {
  const database = openAuthorityDatabase(":memory:");
  databases.push(database);
  applyAuthorityBaseline(database);
  return database;
}

describe("agentic Ask audit", () => {
  it('retains native writer model identity under the answer role and rejects a mismatched role', () => {
    const store = new SqlitePersonAgenticAskAuditV1(openedDatabase());
    const writer = { ...entry, rounds: 1, model_calls: 1, generations: [{ role: 'answer' as const, engine: 'external_writer' as const, model: 'claude-sonnet-fixture', finish_reason: 'stop', usage: null }] };
    expect(() => store.forRequest(requestContext).append(writer)).not.toThrow();
    expect(() => store.forRequest({ ...requestContext, request_id: 'bad-role' }).append({ ...writer, generations: [{ ...writer.generations[0]!, role: 'step' }] })).toThrow('audit entry is invalid');
  });
  it('records native research calls under the call budget with their actual model identity', () => {
    const database = openedDatabase(), store = new SqlitePersonAgenticAskAuditV1(database);
    const native = { ...entry, rounds: 13, model_calls: 13, generations: Array.from({ length: 13 }, () => ({ role: 'step' as const, engine: 'external_research' as const, model: 'claude-sonnet-fixture', finish_reason: 'tool_use', usage: null })) };
    store.forRequest(requestContext).append(native);
    const row = database.prepare('SELECT body_json FROM authority_person_read_decision_audit_v2').get() as { body_json: string };
    expect(JSON.parse(row.body_json)).toMatchObject({ rounds: 13, model_calls: 13, generations: native.generations });
    expect(() => store.forRequest({ ...requestContext, request_id: 'over' }).append({ ...native, rounds: 25, model_calls: 25, generations: Array.from({ length: 25 }, () => native.generations[0]!) })).toThrow('audit entry is invalid');
    expect(() => store.forRequest({ ...requestContext, request_id: 'legacy' }).append({ ...native, generations: native.generations.map(({ engine: _engine, model: _model, ...entry }) => entry) })).toThrow('audit entry is invalid');
  });

  it("records a follow-up that asked which one as clarify, its resolver an answer generation, and never off_scope (ADR-0047)", () => {
    const database = openedDatabase(), store = new SqlitePersonAgenticAskAuditV1(database);
    const clarify = { ...entry, outcome: "clarify" as const, receipt_digests: [], rounds: 0, model_calls: 1, citation_count: 0,
      generations: [{ role: "answer" as const, finish_reason: "stop", usage: null }], finish_reason_counts: { stop: 1 } };
    store.forRequest(requestContext).append(clarify);
    const row = database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2").get() as { body_json: string };
    expect(JSON.parse(row.body_json)).toMatchObject({ outcome: "clarify", rounds: 0, model_calls: 1, citation_count: 0, generations: clarify.generations });
    expect(() => store.forRequest({ ...requestContext, request_id: "off_scope" }).append({ ...entry, outcome: "off_scope" as never })).toThrow("Agentic Ask audit entry is invalid");
  });

  it("writes a content-free success terminal witness to the existing immutable table", () => {
    const database = openedDatabase();
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
  });

  it("records a research-only trigger under the background limits and keeps Ask limits for Ask", () => {
    const database = openedDatabase();
    const store = new SqlitePersonAgenticAskAuditV1(database);
    store.forRequest(requestContext).append({ ...entry, trigger: "approved_record" });
    const row = database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2").get() as { body_json: string };
    expect(JSON.parse(row.body_json)).toMatchObject({ trigger: "approved_record", rounds: 20, outcome: "partial" });
    expect(() => store.forRequest({ ...requestContext, request_id: "ask_2" }).append(entry)).toThrow("Agentic Ask audit entry is invalid");
    // A background-budget Ask (the evaluation's diagnostic) carries its budget instead of a trigger.
    store.forRequest({ ...requestContext, request_id: "ask_4" }).append({ ...entry, budget: "background" });
    expect(() => store.forRequest({ ...requestContext, request_id: "ask_5" }).append({ ...entry, budget: "huge" as never })).toThrow("Agentic Ask audit entry is invalid");
    const rows = database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2").all() as { body_json: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map(value => JSON.parse(value.body_json))).toEqual(expect.arrayContaining([expect.objectContaining({ trigger: "approved_record" }), expect.objectContaining({ budget: "background", rounds: 20 })]));
  });

  it("accepts every research-only trigger the definitions name, and no other", () => {
    const database = openedDatabase();
    const store = new SqlitePersonAgenticAskAuditV1(database);
    // The list is the definitions': the approved record replaced Check, so a new row may no longer say check.
    expect(AGENTIC_TRIGGER_NAMES_V1).toContain("approved_record");
    for (const [index, trigger] of AGENTIC_TRIGGER_NAMES_V1.entries()) store.forRequest({ ...requestContext, request_id: `named_${index}` }).append({ ...entry, trigger });
    for (const trigger of ["check", "ask", "drift", "", "APPROVED_RECORD"]) {
      expect(() => store.forRequest({ ...requestContext, request_id: `other_${trigger}` }).append({ ...entry, trigger })).toThrow("Agentic Ask audit entry is invalid");
    }
    const rows = database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2").all() as { body_json: string }[];
    expect(rows.map(value => JSON.parse(value.body_json).trigger as string).sort()).toEqual([...AGENTIC_TRIGGER_NAMES_V1].sort());
  });

  it.each(["cancelled", "timed_out"] as const)("records %s without output hashes", (outcome) => {
    const database = openedDatabase();
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
  });

  it("copies a streamed Ask's named citation commitments, on any outcome, and omits the field when the Ask did not stream", () => {
    const database = openedDatabase();
    const store = new SqlitePersonAgenticAskAuditV1(database);
    const named = [digest("first named citation"), digest("second named citation")];
    const terminal = { ...entry, rounds: 2, prompt_sha256: null, answer_sha256: null, response_sha256: null };
    store.forRequest({ ...requestContext, request_id: "ask_named" }).append({ ...entry, rounds: 2, named_citation_digests: named });
    store.forRequest({ ...requestContext, request_id: "ask_cancelled" }).append({ ...terminal, outcome: "cancelled", named_citation_digests: [] });
    store.forRequest({ ...requestContext, request_id: "ask_timed_out" }).append({ ...terminal, outcome: "timed_out", named_citation_digests: named.slice(0, 1) });
    store.forRequest({ ...requestContext, request_id: "ask_plain" }).append({ ...entry, rounds: 2 });
    const bodies = (database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2").all() as { body_json: string }[]).map(row => JSON.parse(row.body_json) as Record<string, unknown>);
    const byRequest = new Map(bodies.map(body => [body.request_id, body]));
    expect(byRequest.get("ask_named")).toMatchObject({ outcome: "partial", named_citation_digests: named });
    expect(byRequest.get("ask_cancelled")).toMatchObject({ outcome: "cancelled", named_citation_digests: [] });
    expect(byRequest.get("ask_timed_out")).toMatchObject({ outcome: "timed_out", named_citation_digests: named.slice(0, 1) });
    expect(byRequest.get("ask_plain")).not.toHaveProperty("named_citation_digests");
  });

  it("refuses named citations that are not distinct commitments or exceed the naming bound", () => {
    const store = new SqlitePersonAgenticAskAuditV1(openedDatabase());
    const ask = { ...entry, rounds: 2 };
    const invalid = [
      { ...ask, named_citation_digests: [digest("same"), digest("same")] },
      { ...ask, named_citation_digests: ["Launch review" as Sha256Digest] },
      { ...ask, named_citation_digests: Array.from({ length: 101 }, (_, index) => digest(`named ${index}`)) },
      { ...ask, named_citation_digests: "sha256:" as unknown as Sha256Digest[] },
    ];
    for (const [index, value] of invalid.entries()) {
      expect(() => store.forRequest({ ...requestContext, request_id: `invalid_${index}` }).append(value)).toThrow("Agentic Ask audit entry is invalid");
    }
  });
});
