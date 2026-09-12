import { describe, expect, it } from "vitest";
import {
  applyOrganizationControlBaselineV3,
} from "../src/persistence/baseline.js";
import { openOrganizationControlDatabase } from "../src/persistence/open-organization-control-database.js";

function openedCurrentDatabase() {
  const database = openOrganizationControlDatabase(":memory:");
  applyOrganizationControlBaselineV3(database);
  return database;
}

describe("Control Plane current private-approval schema", () => {
  it("bounds a durable Slack interaction enqueue below Slack's acknowledgement deadline", () => {
    const database = openOrganizationControlDatabase(":memory:");
    try {
      expect(database.pragma("busy_timeout", { simple: true })).toBe(2_000);
    } finally {
      database.close();
    }
  });

  it("stores the immutable pending contract and exact Slack card binding in one staged row", () => {
    const database = openedCurrentDatabase();
    try {
      const columns = database
        .prepare("SELECT name FROM pragma_table_info('organization_private_approval_pending_contracts_v2') ORDER BY cid")
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "pending_json",
        "pending_sha256",
        "card_binding_json",
        "card_binding_sha256",
        "dm_channel_id",
        "provider_message_ts",
        "card_sha256",
      ]));
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organization_private_approval_card_bindings_v2'").get()).toBeUndefined();
      const receiptFence = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'organization_private_approval_signed_action_receipts_v2_exact_card'")
        .get() as { sql: string } | undefined;
      expect(receiptFence?.sql).toContain("organization_private_approval_pending_contracts_v2");
      expect(receiptFence?.sql).not.toContain("organization_private_approval_card_bindings_v2");
    } finally {
      database.close();
    }
  });
});
