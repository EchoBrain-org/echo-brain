import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V3,
  applyOrganizationRecordLogBaselineV3,
  organizationRecordLogBaselineSha256V3,
} from "../src/persistence/record-log-baseline.js";
import { openOrganizationRecordDatabase } from "../src/persistence/open-organization-record-database.js";

describe("organization record log baseline V3", () => {
  it("creates a fresh V3 lineage with a stable baseline digest", () => {
    const database = openOrganizationRecordDatabase(":memory:");
    try {
      applyOrganizationRecordLogBaselineV3(database);
      expect(database.pragma("user_version", { simple: true })).toBe(
        ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V3,
      );
      expect(organizationRecordLogBaselineSha256V3()).toMatch(
        /^sha256:[0-9a-f]{64}$/,
      );
    } finally {
      database.close();
    }
  });

  it("refuses to relabel an occupied file as the current V3 lineage", () => {
    const database = openOrganizationRecordDatabase(":memory:");
    try {
      database.exec("CREATE TABLE occupied (id INTEGER PRIMARY KEY)");
      database.pragma("user_version = 1");
      expect(() => applyOrganizationRecordLogBaselineV3(database)).toThrow(
        "completely empty database",
      );
    } finally {
      database.close();
    }
  });
});
