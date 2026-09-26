import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyAuthorityBaselineV10, AUTHORITY_BASELINE_SCHEMA_VERSION_V10 } from "../../../../src/adapters/persistence/sqlite/baseline.js";

describe("Authority baseline V10", () => {
  it("freezes a nullable V2 private approval card after its first queued write", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = OFF");
      applyAuthorityBaselineV10(database);
      expect(database.pragma("user_version", { simple: true })).toBe(AUTHORITY_BASELINE_SCHEMA_VERSION_V10);
      expect(database.prepare("PRAGMA table_info(authority_live_approval_outbox_v2)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "private_approval_card_v2_json", notnull: 0 })]));
      database.prepare("INSERT INTO authority_live_approval_outbox_v2(candidate_id,approval_id,stage_command_id,state,updated_at) VALUES ('can_test','apr_test','pas_test','queued','2026-09-26T00:00:00.000Z')").run();
      database.prepare("UPDATE authority_live_approval_outbox_v2 SET private_approval_card_v2_json = '{\"kind\":\"card\"}' WHERE candidate_id = 'can_test'").run();
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET private_approval_card_v2_json = '{\"kind\":\"replacement\"}' WHERE candidate_id = 'can_test'").run()).toThrow("immutable");
      expect(() => database.prepare("UPDATE authority_live_approval_outbox_v2 SET private_approval_card_v2_json = NULL WHERE candidate_id = 'can_test'").run()).toThrow("immutable");
    } finally { database.close(); }
  });
});
