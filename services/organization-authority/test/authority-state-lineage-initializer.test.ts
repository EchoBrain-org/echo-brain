import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  STATE_LINEAGE_MANIFEST_TABLE,
  STATE_LINEAGE_ROOT_MANIFEST_V2_FILENAME,
  STATE_LINEAGE_ROLE_APPLICATION_IDS_V1,
} from "@echo-brain/organization-authority-kernel/state-lineage/state-lineage-manifest-v1";
import {
  initializeAuthorityStateLineageV2,
  type InitializeAuthorityStateLineageV2Input,
} from "../src/state-lineage/authority-state-lineage-initializer.js";

import { applyAuthorityBaselineV5, AUTHORITY_BASELINE_SCHEMA_VERSION_V5, authorityBaselineSha256V5 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import {
  openOrganizationControlDatabase, applyOrganizationControlBaselineV3, ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V3, organizationControlBaselineSha256V3,
} from "@echo-brain/organization-control-plane/organization-control-database-v1";
import {
  openOrganizationRecordDatabase, applyOrganizationRecordLogBaselineV3, ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V3, organizationRecordLogBaselineSha256V3,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  READABLE_SEARCH_FACTS_BASELINE_V2, READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V2, readableSearchPlaneBaselineSha256,
  READABLE_SEARCH_CONTENT_BASELINE_V1,
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
  overrides: Partial<InitializeAuthorityStateLineageV2Input> = {},
): InitializeAuthorityStateLineageV2Input {
  const schemas = Object.fromEntries(
    Object.keys(STATE_LINEAGE_ROLE_APPLICATION_IDS_V1).map((role) => [
      role,
      {
        database_schema_version: 1,
        schema_sha256: `sha256:${"a".repeat(64)}` as Sha256Digest,
      },
    ]),
  ) as InitializeAuthorityStateLineageV2Input["schemas"];
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
    },
    open_writable_database: (path) => new Database(path),
    ...overrides,
  };
}

function realBaselineInput(
  stateDirectory: string,
): InitializeAuthorityStateLineageV2Input {
  return {
    ...input(stateDirectory),
    schemas: {
      authority: {
        database_schema_version: AUTHORITY_BASELINE_SCHEMA_VERSION_V5,
        schema_sha256: authorityBaselineSha256V5(),
      },
      "control-plane": {
        database_schema_version:
          ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V3,
        schema_sha256: organizationControlBaselineSha256V3(),
      },
      "record-log": {
        database_schema_version:
          ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V3,
        schema_sha256: organizationRecordLogBaselineSha256V3(),
      },
      "retrieval-facts": {
        database_schema_version:
          READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V2,
        schema_sha256: readableSearchPlaneBaselineSha256(
          READABLE_SEARCH_FACTS_BASELINE_V2,
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
      authority: { apply: applyAuthorityBaselineV5 },
      "control-plane": { apply: applyOrganizationControlBaselineV3 },
      "record-log": { apply: applyOrganizationRecordLogBaselineV3 },
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
  it("publishes and verifies the actual three top-level baseline set", () => {
    const parent = fixtureRoot();
    const stateDirectory = join(parent, "state");
    const result = initializeAuthorityStateLineageV2(
      realBaselineInput(stateDirectory),
    );

    expect(
      result.verification.databases.map((database) => database.role),
    ).toEqual(["authority", "control-plane", "record-log"]);
    expect(result.verification.retrieval.present).toBe(false);
  });

  it("publishes all top-level roles, stamps manifests, and verifies the absent retrieval tree", () => {
    const parent = fixtureRoot();
    const stateDirectory = join(parent, "state");
    const result = initializeAuthorityStateLineageV2(input(stateDirectory));

    expect(result.state_directory).toBe(stateDirectory);
    expect(result.verification.retrieval).toEqual({
      present: false,
      generation_count: 0,
      segment_count: 0,
    });
    expect(readdirSync(stateDirectory).sort()).toEqual([
      "authority.sqlite",
      "integrations.sqlite",
      "record-log.sqlite",
      STATE_LINEAGE_ROOT_MANIFEST_V2_FILENAME,
    ]);
    for (const databaseName of [
      "authority.sqlite",
      "integrations.sqlite",
      "record-log.sqlite",
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

    expect(() => initializeAuthorityStateLineageV2(failing)).toThrow(
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
      } as unknown as InitializeAuthorityStateLineageV2Input["schemas"],
    });

    expect(() => initializeAuthorityStateLineageV2(missing)).toThrow(
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
    const first = initializeAuthorityStateLineageV2(input(stateDirectory));
    expect(first.verification.databases).toHaveLength(3);
    expect(() => initializeAuthorityStateLineageV2(input(stateDirectory))).toThrow(
      "must not already exist",
    );
  });
});
