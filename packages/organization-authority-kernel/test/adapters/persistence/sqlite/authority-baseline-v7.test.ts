import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV7,
  AUTHORITY_BASELINE_APPLICATION_ID_V1,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V7,
  authorityBaselineSha256V5,
  authorityBaselineSha256V6,
  authorityBaselineSha256V7,
} from "../../../../src/adapters/persistence/sqlite/baseline.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function opened(): Database.Database {
  const database = new Database(":memory:");
  databases.push(database);
  return database;
}

describe("Authority baseline V7", () => {
  it("pins V5/V6 history while making V7 the fresh constructor", () => {
    expect(authorityBaselineSha256V5()).toBe(
      "sha256:0c11226af116345f5d2eafe6bd833a421e4dcb3ccb5728642ab1134da09bd9ea",
    );
    expect(authorityBaselineSha256V6()).toBe(
      "sha256:f710c722038d56712e7fe35df08db31d50aecb44578fcf12fb51ce2e45f6895d",
    );
    expect(authorityBaselineSha256V7()).toBe(
      "sha256:593fbdc54ab102b679f84735b724bff8233d0238eae89c11a0137194e9273da9",
    );

    const database = opened();
    applyAuthorityBaselineV7(database);
    expect(database.pragma("application_id", { simple: true })).toBe(
      AUTHORITY_BASELINE_APPLICATION_ID_V1,
    );
    expect(database.pragma("user_version", { simple: true })).toBe(
      AUTHORITY_BASELINE_SCHEMA_VERSION_V7,
    );
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'authority_projects_v1'",
        )
        .get(),
    ).toEqual({ name: "authority_projects_v1" });
  });

  it("refuses a nonempty database instead of treating V7 as a migration", () => {
    const database = opened();
    database.exec("CREATE TABLE prior_state (id INTEGER PRIMARY KEY)");
    expect(() => applyAuthorityBaselineV7(database)).toThrow(
      "authority baseline requires a completely empty database",
    );
    expect(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'prior_state'")
        .get(),
    ).toEqual({ name: "prior_state" });
  });
});
