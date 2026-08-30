import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOrganizationControlBaselineV2,
  openOrganizationControlDatabase,
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
  organizationControlBaselineSha256V2,
} from "@echo-brain/organization-control-plane/organization-control-database-v1";
import {
  applyOrganizationRecordDerivedBaselineV1,
  applyOrganizationRecordLogBaselineV1,
  openOrganizationRecordDatabase,
  ORGANIZATION_RECORD_DERIVED_BASELINE_SCHEMA_VERSION_V1,
  ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V1,
  organizationRecordDerivedBaselineSha256V1,
  organizationRecordLogBaselineSha256V1,
} from "@echo-brain/organization-record/new-lineage-v1";
import {
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
  readableSearchPlaneBaselineSha256V1,
} from "@echo-brain/organization-retrieval/new-lineage-v1";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV3,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V3,
  authorityBaselineSha256V3,
} from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-authority-database.js";
import { runOrganizationAuthorityResetCli } from "../src/composition/organization-authority-reset-cli.js";
import { initializeAuthorityState } from "../src/composition/authority-state-initializer.js";
import { verifyAuthorityStateLineage } from "../src/composition/verify-authority-state-lineage.js";
import { initializeAuthorityStateLineageV1 } from "../src/state-lineage/authority-state-lineage-initializer.js";
import { StateLineagePreopenRefusal } from "../src/state-lineage/state-lineage-preopen-guard.js";

const roots: string[] = [];
const CREATED_AT = "2026-08-22T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "echo-authority-state-init-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function rows(
  path: string,
  statement: string,
): readonly Record<string, unknown>[] {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(statement).all() as readonly Record<
      string,
      unknown
    >[];
  } finally {
    database.close();
  }
}

function initializeRecordLogV1State(stateDirectory: string): void {
  initializeAuthorityStateLineageV1({
    state_directory: stateDirectory,
    binding: {
      authority_id: "oau_00000000-0000-4000-8000-000000000001",
      organization_id: "org_00000000-0000-4000-8000-000000000001",
      state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
    },
    created_at: CREATED_AT,
    creating_artifact_revision: "legacy-v1-fixture",
    schemas: {
      authority: {
        database_schema_version: AUTHORITY_BASELINE_SCHEMA_VERSION_V3,
        schema_sha256: authorityBaselineSha256V3(),
      },
      "control-plane": {
        database_schema_version:
          ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
        schema_sha256: organizationControlBaselineSha256V2(),
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
      authority: { apply: applyAuthorityBaselineV3 },
      "control-plane": { apply: applyOrganizationControlBaselineV2 },
      "record-log": { apply: applyOrganizationRecordLogBaselineV1 },
      "record-derived": { apply: applyOrganizationRecordDerivedBaselineV1 },
    },
    open_writable_database: (path, role) => {
      if (role === "authority") return openAuthorityDatabase(path);
      if (role === "control-plane") return openOrganizationControlDatabase(path);
      return openOrganizationRecordDatabase(path);
    },
  });
}

describe("Authority state initialization", () => {
  it("creates only the fresh binding metadata, active owner, and derived cursor", () => {
    const root = fixtureRoot();
    const stateDirectory = join(root, "new-state");
    const result = initializeAuthorityState({
      state_directory: stateDirectory,
      organization_display_name: "Example Organization",
      owner_display_name: "Ada Owner",
      created_at: CREATED_AT,
      creating_artifact_revision: "clean-reset-test-artifact",
    });

    expect(readdirSync(stateDirectory).sort()).toEqual([
      "authority.sqlite",
      "integrations.sqlite",
      "keys",
      "record-derived.sqlite",
      "record-log.sqlite",
      "state-lineage-root.v1.json",
    ]);
    expect(
      existsSync(
        join(stateDirectory, "keys", "authority-development-key.v1.json"),
      ),
    ).toBe(true);
    expect(result.authority_id).toMatch(/^oau_/);
    expect(result.organization_id).toMatch(/^org_/);
    expect(result.owner_principal_id).toMatch(/^prn_/);
    expect(result.owner_membership_id).toMatch(/^mem_/);
    expect(result.control_plane_id).toMatch(/^ocp_/);
    expect(result.state_lineage_id).toMatch(/^lineage-/);
    expect(result.manifests.retrieval_present).toBe(false);
    expect(Object.keys(result.manifests.database_manifests).sort()).toEqual([
      "authority",
      "control-plane",
      "record-derived",
      "record-log",
    ]);
    expect(
      rows(
        join(stateDirectory, "authority.sqlite"),
        "PRAGMA user_version",
      ),
    ).toEqual([{ user_version: 3 }]);
    expect(
      rows(
        join(stateDirectory, "integrations.sqlite"),
        "PRAGMA user_version",
      ),
    ).toEqual([{ user_version: 2 }]);
    expect(
      rows(
        join(stateDirectory, "record-log.sqlite"),
        "PRAGMA user_version",
      ),
    ).toEqual([{ user_version: 2 }]);

    expect(
      rows(
        join(stateDirectory, "authority.sqlite"),
        `SELECT authority_id, organization_id, organization_display_name,
                created_at, last_observed_at
         FROM authority_metadata`,
      ),
    ).toEqual([
      {
        authority_id: result.authority_id,
        organization_id: result.organization_id,
        organization_display_name: "Example Organization",
        created_at: CREATED_AT,
        last_observed_at: CREATED_AT,
      },
    ]);
    expect(
      rows(
        join(stateDirectory, "authority.sqlite"),
        `SELECT membership_id, principal_id, membership_type, status
         FROM authority_memberships`,
      ),
    ).toEqual([
      {
        membership_id: result.owner_membership_id,
        principal_id: result.owner_principal_id,
        membership_type: "owner",
        status: "active",
      },
    ]);
    expect(
      rows(
        join(stateDirectory, "authority.sqlite"),
        `SELECT count(*) AS count
         FROM authority_person_login_grants
         UNION ALL SELECT count(*) FROM authority_oidc_identity_bindings
         UNION ALL SELECT count(*) FROM authority_oidc_login_attempts
         UNION ALL SELECT count(*) FROM authority_person_session_families
         UNION ALL SELECT count(*) FROM authority_person_session_credentials
         UNION ALL SELECT count(*) FROM authority_provider_human_action_reproofs
         UNION ALL SELECT count(*) FROM authority_record_write_inputs
         UNION ALL SELECT count(*) FROM authority_record_write_receipts
         UNION ALL SELECT count(*) FROM authority_readable_search_active_generation`,
      ).map((row) => row.count),
    ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(
      rows(
        join(stateDirectory, "integrations.sqlite"),
        `SELECT control_plane_id, organization_id, authority_id,
                authority_descriptor_sha256, created_at
         FROM organization_control_plane_metadata`,
      ),
    ).toEqual([
      {
        control_plane_id: result.control_plane_id,
        organization_id: result.organization_id,
        authority_id: result.authority_id,
        authority_descriptor_sha256: result.authority_descriptor_sha256,
        created_at: CREATED_AT,
      },
    ]);
    expect(
      rows(
        join(stateDirectory, "record-log.sqlite"),
        `SELECT authority_id, organization_id, state_lineage_id, created_at
         FROM organization_record_log_metadata`,
      ),
    ).toEqual([
      {
        authority_id: result.authority_id,
        organization_id: result.organization_id,
        state_lineage_id: result.state_lineage_id,
        created_at: CREATED_AT,
      },
    ]);
    expect(
      rows(
        join(stateDirectory, "record-derived.sqlite"),
        "SELECT organization_id, created_at FROM organization_derived_metadata",
      ),
    ).toEqual([
      { organization_id: result.organization_id, created_at: CREATED_AT },
    ]);
    expect(
      rows(
        join(stateDirectory, "record-derived.sqlite"),
        "SELECT last_position, updated_at FROM organization_derived_cursor",
      ),
    ).toEqual([{ last_position: 0, updated_at: CREATED_AT }]);
  });

  it("exposes state initialization through its compatibility CLI without legacy flags", () => {
    const root = fixtureRoot();
    const stateDirectory = join(root, "new-state");
    const output: string[] = [];
    expect(
      runOrganizationAuthorityResetCli(
        [
          "--state-dir",
          stateDirectory,
          "--organization-name",
          "Example Organization",
          "--owner-display-name",
          "Ada Owner",
          "--created-at",
          CREATED_AT,
          "--artifact-revision",
          "clean-reset-cli-test",
        ],
        { stdout: (value) => output.push(value), stderr: () => undefined },
      ),
    ).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      kind: "echo-organization-authority-clean-reset-state-v1",
      state_directory: stateDirectory,
    });
    expect(() =>
      runOrganizationAuthorityResetCli(["--config", join(root, "legacy-config.json")], {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).toThrow("usage:");
  });

  it("rejects a caller seed with the wrong identifier namespaces before creating state", () => {
    const root = fixtureRoot();
    const stateDirectory = join(root, "new-state");
    expect(() =>
      initializeAuthorityState({
        state_directory: stateDirectory,
        organization_display_name: "Example Organization",
        owner_display_name: "Ada Owner",
        created_at: CREATED_AT,
        creating_artifact_revision: "clean-reset-test-artifact",
        seed: {
          authority_id: "org_00000000-0000-4000-8000-000000000001",
          organization_id: "org_00000000-0000-4000-8000-000000000001",
          state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
          owner_principal_id: "prn_00000000-0000-4000-8000-000000000001",
          owner_membership_id: "mem_00000000-0000-4000-8000-000000000001",
          control_plane_id: "ocp_00000000-0000-4000-8000-000000000001",
        },
      }),
    ).toThrow("invalid federation identifier");
    expect(existsSync(stateDirectory)).toBe(false);
  });

  it("refuses a V1 record-log lineage rather than upgrading it in place", () => {
    const root = fixtureRoot();
    const stateDirectory = join(root, "legacy-v1-state");
    initializeRecordLogV1State(stateDirectory);

    expect(() => verifyAuthorityStateLineage(stateDirectory)).toThrow(
      StateLineagePreopenRefusal,
    );
    try {
      verifyAuthorityStateLineage(stateDirectory);
      throw new Error("expected V1 lineage to be refused");
    } catch (error) {
      expect(error).toMatchObject({ family: "schema_version_mismatch" });
    }
    expect(() =>
      initializeAuthorityState({
        state_directory: stateDirectory,
        organization_display_name: "Example Organization",
        owner_display_name: "Ada Owner",
        created_at: CREATED_AT,
        creating_artifact_revision: "must-not-upgrade-v1",
      }),
    ).toThrow("state directory must not already exist");
  });
});
