import { describe, expect, it } from "vitest";
import { applyAuthorityBaseline } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function appliedAuthorityDatabase() {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaseline(database);
  return database;
}

describe("Authority person read-decision audit schema", () => {
  it("binds record-read and answer-composition discriminators to their JSON bodies", () => {
    const database = appliedAuthorityDatabase();
    try {
      const promptSha256 = digest("a");
      const answerSha256 = digest("b");
      const insert = database.prepare(
        `INSERT INTO authority_person_read_decision_audit_v2
         (row_sha256, body_json, context_kind, prompt_sha256, answer_sha256, recorded_at)
         VALUES (?, ?, ?, ?, ?, '2026-08-22T00:00:00.000Z')`,
      );

      expect(() =>
        insert.run(
          digest("c"),
          JSON.stringify({
            schema_version: 1,
            context_kind: "record_read",
            prompt_sha256: null,
            answer_sha256: null,
          }),
          "record_read",
          null,
          null,
        ),
      ).not.toThrow();
      expect(() =>
        insert.run(
          digest("d"),
          JSON.stringify({
            schema_version: 1,
            context_kind: "answer_composition",
            prompt_sha256: promptSha256,
            answer_sha256: answerSha256,
          }),
          "answer_composition",
          promptSha256,
          answerSha256,
        ),
      ).not.toThrow();

      expect(() =>
        insert.run(
          digest("e"),
          JSON.stringify({
            context_kind: "answer_composition",
            prompt_sha256: promptSha256,
            answer_sha256: answerSha256,
          }),
          "record_read",
          null,
          null,
        ),
      ).toThrow();
      expect(() =>
        insert.run(
          digest("f"),
          JSON.stringify({
            context_kind: "answer_composition",
            prompt_sha256: digest("g"),
            answer_sha256: answerSha256,
          }),
          "answer_composition",
          promptSha256,
          answerSha256,
        ),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("makes each read-audit body append-only", () => {
    const database = appliedAuthorityDatabase();
    try {
      const rowSha256 = digest("h");
      database
        .prepare(
          `INSERT INTO authority_person_read_decision_audit_v2
           (row_sha256, body_json, context_kind, prompt_sha256, answer_sha256, recorded_at)
           VALUES (?, ?, 'record_read', NULL, NULL, ?)`,
        )
        .run(
          rowSha256,
          JSON.stringify({
            context_kind: "record_read",
            prompt_sha256: null,
            answer_sha256: null,
          }),
          "2026-08-22T00:00:00.000Z",
        );

      expect(() =>
        database
          .prepare(
            "UPDATE authority_person_read_decision_audit_v2 SET recorded_at = ? WHERE row_sha256 = ?",
          )
          .run("2026-08-22T00:00:01.000Z", rowSha256),
      ).toThrow(/immutable/);
      expect(() =>
        database
          .prepare(
            "DELETE FROM authority_person_read_decision_audit_v2 WHERE row_sha256 = ?",
          )
          .run(rowSha256),
      ).toThrow(/deletion is denied/);
    } finally {
      database.close();
    }
  });
});
