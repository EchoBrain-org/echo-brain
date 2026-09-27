import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { SqlitePersonAgenticAskAuditV1 } from "../../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import { applyAuthorityBaselineV5 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });

describe("agentic Ask audit", () => {
  it("writes a content-free success terminal witness to the existing immutable table", () => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV5(database);
    try {
      new SqlitePersonAgenticAskAuditV1(database).append({
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
      expect(row.body_json).not.toContain("question");
    } finally { database.close(); }
  });

  it("records a cancellation without output hashes", () => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV5(database);
    try {
      new SqlitePersonAgenticAskAuditV1(database, () => "2026-09-27T00:00:00.000Z").append({
        kind: "echo-agentic-ask-audit-v1", outcome: "cancelled", receipt_digests: [],
        rounds: 0, model_calls: 0, repairs: 0, fallbacks: 0, citation_count: 0,
        checked_at: null, prompt_sha256: null, answer_sha256: null, response_sha256: null,
        generations: [], generation_usage: { input_tokens: null, output_tokens: null, total_tokens: null }, finish_reason_counts: {},
      });
      const row = database.prepare("SELECT prompt_sha256, answer_sha256, body_json FROM authority_person_read_decision_audit_v2").get() as { prompt_sha256: null; answer_sha256: null; body_json: string };
      expect(row.prompt_sha256).toMatch(/^sha256:/);
      expect(row.answer_sha256).toMatch(/^sha256:/);
      expect(row.body_json).toContain('"outcome":"cancelled"');
    } finally { database.close(); }
  });
});
