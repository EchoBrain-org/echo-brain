import { describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV11,
  AUTHORITY_BASELINE_APPLICATION_ID_V1,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V11,
  authorityBaselineSha256V11,
} from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";

const AUTHORITY_BASELINE_SHA256_V11 =
  "sha256:3c688e2d1504b1ecb7b214c54864c0347dd1df22d09e252b22fc6fd7ec8335b2";

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function appliedAuthorityDatabase() {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV11(database);
  return database;
}

describe("Authority person read-decision audit schema", () => {
  it("freezes the Authority baseline and stamps its genesis headers", () => {
    const database = appliedAuthorityDatabase();
    try {
      expect(authorityBaselineSha256V11()).toBe(AUTHORITY_BASELINE_SHA256_V11);
      expect(database.pragma("application_id", { simple: true })).toBe(
        AUTHORITY_BASELINE_APPLICATION_ID_V1,
      );
      expect(database.pragma("user_version", { simple: true })).toBe(
        AUTHORITY_BASELINE_SCHEMA_VERSION_V11,
      );
    } finally {
      database.close();
    }
  });

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

  it("applies only to an empty database", () => {
    const fresh = openAuthorityDatabase(":memory:");
    try {
      applyAuthorityBaselineV11(fresh);
      expect(() => applyAuthorityBaselineV11(fresh)).toThrow(
        /completely empty database/,
      );
    } finally {
      fresh.close();
    }

    const nonempty = openAuthorityDatabase(":memory:");
    try {
      nonempty.exec("CREATE TABLE preexisting (id INTEGER PRIMARY KEY) STRICT");
      expect(() => applyAuthorityBaselineV11(nonempty)).toThrow(
        /completely empty database/,
      );
    } finally {
      nonempty.close();
    }
  });
});
