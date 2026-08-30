import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { SqlitePersonAnswerCompositionAuditV1 } from "../../src/adapters/persistence/sqlite/person-answer-composition-audit-v1.js";
import { applyAuthorityBaselineV1 } from "../../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../../src/adapters/persistence/sqlite/open-unmigrated-database.js";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });

describe("answer composition audit", () => {
  it("uses the existing immutable audit table without persisting question, prompt, or answer", () => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV1(database);
    const writer = new SqlitePersonAnswerCompositionAuditV1(database);
    writer.append({
      authority_id: "oau_clean",
      organization_id: "org_clean",
      state_lineage_id: "lineage_clean",
      principal_id: "person_1",
      membership_id: "membership_1",
      session_family_id: "session_1",
      release_id: digest("release"),
      generation_id: digest("generation"),
      record_head: { position: 4, record_sha256: digest("head") },
      released_atoms_sha256: digest("released-atoms"),
      prompt_sha256: digest("private question and prompt"),
      answer_sha256: digest("private answer"),
      response_sha256: digest("response"),
      citation_count: 1,
      checked_at: "2026-08-23T00:00:00.000Z",
    });
    const row = database
      .prepare(
        `SELECT context_kind, prompt_sha256, answer_sha256, body_json
           FROM authority_person_read_decision_audit_v2`,
      )
      .get() as { context_kind: string; prompt_sha256: string; answer_sha256: string; body_json: string };
    expect(row.context_kind).toBe("answer_composition");
    expect(row.prompt_sha256).toBe(digest("private question and prompt"));
    expect(row.answer_sha256).toBe(digest("private answer"));
    expect(row.body_json).not.toContain("private question");
    expect(row.body_json).not.toContain("private answer");
  });
});
