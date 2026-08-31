import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V2,
  applyOrganizationRecordLogBaselineV1,
  applyOrganizationRecordLogBaselineV2,
  organizationRecordLogBaselineSha256V2,
} from "../src/persistence/record-log-baseline.js";
import { openOrganizationRecordDatabase } from "../src/persistence/open-unmigrated-database.js";

describe("organization record log baseline V2", () => {
  it("creates a fresh V2 lineage with a stable baseline digest", () => {
    const database = openOrganizationRecordDatabase(":memory:");
    try {
      applyOrganizationRecordLogBaselineV2(database);
      expect(database.pragma("user_version", { simple: true })).toBe(
        ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V2,
      );
      expect(organizationRecordLogBaselineSha256V2()).toMatch(
        /^sha256:[0-9a-f]{64}$/,
      );
    } finally {
      database.close();
    }
  });

  it("refuses to relabel an existing V1 file as private-capable V2", () => {
    const database = openOrganizationRecordDatabase(":memory:");
    try {
      applyOrganizationRecordLogBaselineV1(database);
      expect(() => applyOrganizationRecordLogBaselineV2(database)).toThrow(
        "completely empty database",
      );
    } finally {
      database.close();
    }
  });
});
