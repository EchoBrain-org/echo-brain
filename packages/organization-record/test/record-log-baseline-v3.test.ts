import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V3,
  ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V4,
  applyOrganizationRecordLogBaselineV3,
  applyOrganizationRecordLogBaselineV4,
  organizationRecordLogBaselineSha256V3,
  organizationRecordLogBaselineSha256V4,
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

describe("organization record log baseline V4", () => {
  it("creates fresh immutable project audience, association, and transcript-grant facts", () => {
    const database = openOrganizationRecordDatabase(":memory:");
    try {
      applyOrganizationRecordLogBaselineV4(database);
      expect(database.pragma("user_version", { simple: true })).toBe(
        ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V4,
      );
      expect(organizationRecordLogBaselineSha256V4()).toMatch(
        /^sha256:[0-9a-f]{64}$/,
      );
      expect(
        database.prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN (
              'organization_record_project_members_readable_person_record_fact',
              'organization_record_project_association_v1',
              'organization_record_meeting_transcript_grant_v1'
            ) ORDER BY name`,
        ).all(),
      ).toHaveLength(3);
    } finally {
      database.close();
    }
  });

  it("never treats occupied V3 state as a V4 lineage", () => {
    const database = openOrganizationRecordDatabase(":memory:");
    try {
      applyOrganizationRecordLogBaselineV3(database);
      expect(() => applyOrganizationRecordLogBaselineV4(database)).toThrow(
        "completely empty database",
      );
    } finally {
      database.close();
    }
  });
});
