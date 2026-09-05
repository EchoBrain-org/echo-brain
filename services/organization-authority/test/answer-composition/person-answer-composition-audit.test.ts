import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { SqlitePersonAnswerCompositionAuditV1 } from "../../src/adapters/persistence/sqlite/person-answer-composition-audit-v1.js";
import { applyAuthorityBaselineV1 } from "../../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../../src/adapters/persistence/sqlite/open-authority-database.js";

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
      outcome: "answered",
      retrieval: {
        planned_query_count: 1,
        released_atom_count: 1,
        context_atom_count: 1,
        query_hit_counts: [1],
      },
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
    expect(row.body_json).toContain('"query_hit_counts":[1]');
    const body = JSON.parse(row.body_json) as Record<string, unknown>;
    expect(body.schema_version).toBe(1);
    expect(body.kind).toBe("echo-person-answer-composition-audit-v1");
    expect(body).not.toHaveProperty("operation_correlation_sha256");
  });

  it("writes a V2 body containing only an operation-correlation commitment", () => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV1(database);
    const writer = new SqlitePersonAnswerCompositionAuditV1(database);
    const operationCorrelation = "operation_binding_ABCD1234";
    const operationCorrelationSha256 = canonicalSha256({
      schema_version: 1,
      kind: "echo-person-operation-correlation-commitment-v1",
      operation_correlation: operationCorrelation,
    });
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
      prompt_sha256: digest("prompt"),
      answer_sha256: digest("answer"),
      response_sha256: digest("response"),
      citation_count: 1,
      outcome: "answered",
      retrieval: {
        planned_query_count: 1,
        released_atom_count: 1,
        context_atom_count: 1,
        query_hit_counts: [1],
      },
      checked_at: "2026-08-23T00:00:00.000Z",
      operation_correlation_sha256: operationCorrelationSha256,
    });
    const row = database
      .prepare("SELECT body_json FROM authority_person_read_decision_audit_v2")
      .get() as { body_json: string };
    const body = JSON.parse(row.body_json) as Record<string, unknown>;
    expect(body).toMatchObject({
      schema_version: 2,
      kind: "echo-person-answer-composition-audit-v2",
      operation_correlation_sha256: operationCorrelationSha256,
    });
    expect(row.body_json).not.toContain(operationCorrelation);
    database.close();
  });
});
