import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanResetCli } from "../src/composition/clean-reset-cli.js";
import { initializeCleanResetState } from "../src/composition/clean-reset-state.js";

const roots: string[] = [];
const CREATED_AT = "2026-08-22T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "echo-clean-reset-"));
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

describe("clean reset state initialization", () => {
  it("creates only the fresh binding metadata, active owner, and derived cursor", () => {
    const root = fixtureRoot();
    const stateDirectory = join(root, "new-state");
    const result = initializeCleanResetState({
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

  it("exposes the clean reset through its dedicated CLI without legacy flags", () => {
    const root = fixtureRoot();
    const stateDirectory = join(root, "new-state");
    const output: string[] = [];
    expect(
      runCleanResetCli(
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
      runCleanResetCli(["--config", join(root, "legacy-config.json")], {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).toThrow("usage:");
  });
});
