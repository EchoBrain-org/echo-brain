import { describe, expect, it } from "vitest";
import {
  applyOrganizationControlBaselineV2,
  ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID_V2,
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
  organizationControlBaselineSha256V2,
} from "../src/persistence/baseline.js";
import { openOrganizationControlDatabase } from "../src/persistence/open-organization-control-database.js";

const ORGANIZATION_CONTROL_BASELINE_SHA256_V2 =
  "sha256:477d32c5ffacc8207661498770965e6800bf46990d06ba55518c7c608b267d9d";

function openedV2Database() {
  const database = openOrganizationControlDatabase(":memory:");
  applyOrganizationControlBaselineV2(database);
  return database;
}

describe("Control Plane private-approval baseline v2", () => {
  it("bounds a durable Slack interaction enqueue below Slack's acknowledgement deadline", () => {
    const database = openOrganizationControlDatabase(":memory:");
    try {
      expect(database.pragma("busy_timeout", { simple: true })).toBe(2_000);
    } finally {
      database.close();
    }
  });

  it("pins the fresh V1-plus-private schema and preserves its role application ID", () => {
    const database = openedV2Database();
    try {
      expect(organizationControlBaselineSha256V2()).toBe(
        ORGANIZATION_CONTROL_BASELINE_SHA256_V2,
      );
      expect(database.pragma("application_id", { simple: true })).toBe(
        ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID_V2,
      );
      expect(database.pragma("user_version", { simple: true })).toBe(
        ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
      );
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("refuses in-place installation into a nonempty database", () => {
    const database = openedV2Database();
    try {
      expect(() => applyOrganizationControlBaselineV2(database)).toThrow(
        /completely empty database/,
      );
    } finally {
      database.close();
    }
  });

  it("stores the immutable pending contract and exact Slack card binding in one staged row", () => {
    const database = openedV2Database();
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
