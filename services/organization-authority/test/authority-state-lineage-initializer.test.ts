import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  STATE_LINEAGE_MANIFEST_TABLE,
  STATE_LINEAGE_ROOT_MANIFEST_FILENAME,
  STATE_LINEAGE_ROLE_APPLICATION_IDS_V1,
} from "../src/state-lineage/state-lineage-manifest-v1.js";
import {
  initializeAuthorityStateLineageV1,
  type InitializeAuthorityStateLineageV1Input,
} from "../src/state-lineage/authority-state-lineage-initializer.js";
import {
  applyAuthorityBaselineV1,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V1,
  authorityBaselineSha256V1,
} from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-authority-database.js";
import {
  applyOrganizationControlBaselineV1,
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V1,
  organizationControlBaselineSha256V1,
  openOrganizationControlDatabase,
} from "@echo-brain/organization-control-plane/organization-control-database-v1";
import {
  applyOrganizationRecordDerivedBaselineV1,
  applyOrganizationRecordLogBaselineV1,
  ORGANIZATION_RECORD_DERIVED_BASELINE_SCHEMA_VERSION_V1,
  ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V1,
  organizationRecordDerivedBaselineSha256V1,
  organizationRecordLogBaselineSha256V1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/organization-record-service-v1";
import {
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
  readableSearchPlaneBaselineSha256V1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";

const roots: string[] = [];
const AUTHORITY_ID = "oau_11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "org_22222222-2222-4222-8222-222222222222";
const LINEAGE_ID = "lineage-2026-08-22-genesis";
const CREATED_AT = "2026-08-22T00:00:00.000Z";
const ARTIFACT = "15d18effbb022c90061ccbe26236734d21df9d55";

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "echo-authority-state-lineage-"));
  roots.push(root);
  return root;
}

function input(
  stateDirectory: string,
  overrides: Partial<InitializeAuthorityStateLineageV1Input> = {},
): InitializeAuthorityStateLineageV1Input {
  const schemas = Object.fromEntries(
    Object.keys(STATE_LINEAGE_ROLE_APPLICATION_IDS_V1).map((role) => [
      role,
      {
        database_schema_version: 1,
        schema_sha256: `sha256:${"a".repeat(64)}` as Sha256Digest,
      },
    ]),
  ) as InitializeAuthorityStateLineageV1Input["schemas"];
  return {
    state_directory: stateDirectory,
    binding: {
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: LINEAGE_ID,
    },
    created_at: CREATED_AT,
    creating_artifact_revision: ARTIFACT,
    schemas,
    top_level_appliers: {
      authority: {
        apply: (database) => {
          database.exec(
            "CREATE TABLE authority_v1 (singleton INTEGER PRIMARY KEY) STRICT",
          );
          database.pragma(
            `application_id = ${STATE_LINEAGE_ROLE_APPLICATION_IDS_V1.authority}`,
          );
          database.pragma("user_version = 1");
        },
      },
      "control-plane": {
        apply: (database) => {
          database.exec(
            "CREATE TABLE control_plane_v1 (singleton INTEGER PRIMARY KEY) STRICT",
          );
          database.pragma(
            `application_id = ${STATE_LINEAGE_ROLE_APPLICATION_IDS_V1["control-plane"]}`,
          );
          database.pragma("user_version = 1");
        },
      },
      "record-log": {
        apply: (database) => {
          database.exec(
            "CREATE TABLE record_log_v1 (singleton INTEGER PRIMARY KEY) STRICT",
          );
          database.pragma(
            `application_id = ${STATE_LINEAGE_ROLE_APPLICATION_IDS_V1["record-log"]}`,
          );
          database.pragma("user_version = 1");
        },
      },
      "record-derived": {
        apply: (database) => {
          database.exec(
            "CREATE TABLE record_derived_v1 (singleton INTEGER PRIMARY KEY) STRICT",
          );
          database.pragma(
            `application_id = ${STATE_LINEAGE_ROLE_APPLICATION_IDS_V1["record-derived"]}`,
          );
          database.pragma("user_version = 1");
        },
      },
    },
    open_writable_database: (path) => new Database(path),
    ...overrides,
  };
}

function realBaselineInput(
  stateDirectory: string,
): InitializeAuthorityStateLineageV1Input {
  return {
    ...input(stateDirectory),
    schemas: {
      authority: {
        database_schema_version: AUTHORITY_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: authorityBaselineSha256V1(),
      },
      "control-plane": {
        database_schema_version:
          ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: organizationControlBaselineSha256V1(),
      },
      "record-log": {
        database_schema_version:
          ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: organizationRecordLogBaselineSha256V1(),
      },
      "record-derived": {
        database_schema_version:
          ORGANIZATION_RECORD_DERIVED_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: organizationRecordDerivedBaselineSha256V1(),
      },
      "retrieval-facts": {
        database_schema_version:
          READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: readableSearchPlaneBaselineSha256V1(
          READABLE_SEARCH_FACTS_BASELINE_V1,
        ),
      },
      "retrieval-lexical": {
        database_schema_version:
          READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: readableSearchPlaneBaselineSha256V1(
          READABLE_SEARCH_LEXICAL_BASELINE_V1,
        ),
      },
      "retrieval-content": {
        database_schema_version:
          READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: readableSearchPlaneBaselineSha256V1(
          READABLE_SEARCH_CONTENT_BASELINE_V1,
        ),
      },
    },
    top_level_appliers: {
      authority: { apply: applyAuthorityBaselineV1 },
      "control-plane": { apply: applyOrganizationControlBaselineV1 },
      "record-log": { apply: applyOrganizationRecordLogBaselineV1 },
      "record-derived": { apply: applyOrganizationRecordDerivedBaselineV1 },
    },
    open_writable_database: (path, role) => {
      if (role === "authority") return openAuthorityDatabase(path);
      if (role === "control-plane")
        return openOrganizationControlDatabase(path);
      return openOrganizationRecordDatabase(path);
    },
  };
}

describe("Authority state-lineage initializer", () => {
  it("publishes and verifies the actual four top-level baseline set", () => {
    const parent = fixtureRoot();
    const stateDirectory = join(parent, "state");
    const result = initializeAuthorityStateLineageV1(
      realBaselineInput(stateDirectory),
    );

    expect(
      result.verification.databases.map((database) => database.role),
    ).toEqual(["authority", "control-plane", "record-log", "record-derived"]);
    expect(result.verification.retrieval.present).toBe(false);
  });

  it("publishes all top-level roles, stamps manifests, and verifies the absent retrieval tree", () => {
    const parent = fixtureRoot();
    const stateDirectory = join(parent, "state");
    const result = initializeAuthorityStateLineageV1(input(stateDirectory));

    expect(result.state_directory).toBe(stateDirectory);
    expect(result.verification.retrieval).toEqual({
      present: false,
      generation_count: 0,
      segment_count: 0,
    });
    expect(readdirSync(stateDirectory).sort()).toEqual([
      "authority.sqlite",
      "integrations.sqlite",
      "record-derived.sqlite",
      "record-log.sqlite",
      STATE_LINEAGE_ROOT_MANIFEST_FILENAME,
    ]);
    for (const databaseName of [
      "authority.sqlite",
      "integrations.sqlite",
      "record-log.sqlite",
      "record-derived.sqlite",
    ]) {
      const database = new Database(join(stateDirectory, databaseName), {
        readonly: true,
      });
      try {
        expect(
          database
            .prepare(
              `SELECT count(*) AS count FROM ${STATE_LINEAGE_MANIFEST_TABLE}`,
            )
            .pluck()
            .get(),
        ).toBe(1);
      } finally {
        database.close();
      }
    }
  });

  it("never publishes a partially initialized directory when an applier fails", () => {
    const parent = fixtureRoot();
    const stateDirectory = join(parent, "state");
    const base = input(stateDirectory);
    const failing = input(stateDirectory, {
      top_level_appliers: {
        ...base.top_level_appliers,
        "record-log": {
          apply: () => {
            throw new Error("record-log baseline failed");
          },
        },
      },
    });

    expect(() => initializeAuthorityStateLineageV1(failing)).toThrow(
      "record-log baseline failed",
    );
    expect(existsSync(stateDirectory)).toBe(false);
    expect(
      readdirSync(parent).filter((entry) => entry.startsWith(".installing-")),
    ).toEqual([]);
  });

  it("rejects a missing role schema before creating staging state", () => {
    const parent = fixtureRoot();
    const stateDirectory = join(parent, "state");
    const base = input(stateDirectory);
    const missing = input(stateDirectory, {
      schemas: {
        ...base.schemas,
        "record-log": undefined,
      } as unknown as InitializeAuthorityStateLineageV1Input["schemas"],
    });

    expect(() => initializeAuthorityStateLineageV1(missing)).toThrow(
      "Authority state schemas must give the record-log role a schema",
    );
    expect(existsSync(stateDirectory)).toBe(false);
    expect(
      readdirSync(parent).filter((entry) => entry.startsWith(".installing-")),
    ).toEqual([]);
  });

  it("refuses an occupied target before opening a new database", () => {
    const parent = fixtureRoot();
    const stateDirectory = join(parent, "state");
    const first = initializeAuthorityStateLineageV1(input(stateDirectory));
    expect(first.verification.databases).toHaveLength(4);
    expect(() => initializeAuthorityStateLineageV1(input(stateDirectory))).toThrow(
      "must not already exist",
    );
  });
});
