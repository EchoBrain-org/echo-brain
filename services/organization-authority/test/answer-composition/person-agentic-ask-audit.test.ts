import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { SqlitePersonAgenticAskAuditV1 } from "../../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import { applyAuthorityBaselineV5 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });
const requestContext = {
  authority_id: "authority_1", organization_id: "organization_1", state_lineage_id: "lineage_1",
  principal_id: "person_1", membership_id: "member_1", session_family_id: "session_1", request_id: "ask_1",
};

describe("agentic Ask audit", () => {
  it("writes a content-free success terminal witness to the existing immutable table", () => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV5(database);
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

  it.each(["cancelled", "timed_out"] as const)("records %s without output hashes", (outcome) => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV5(database);
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
