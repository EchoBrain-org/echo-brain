import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID,
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V3,
  applyOrganizationControlBaselineV3,
  organizationControlBaselineSha256V3,
  organizationControlBaselineSqlV3,
} from "../src/persistence/baseline.js";
import { openOrganizationControlDatabase } from "../src/persistence/open-organization-control-database.js";

const directories: string[] = [];


function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "echo-control-baseline-"));
  directories.push(directory);
  return join(directory, "integrations.sqlite");
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function schemaObjects(database: Database.Database): Array<{
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}> {
  return database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all() as Array<{
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string;
  }>;
}

function seedConnection(database: Database.Database, id = "con_slack"): string {
  const contractSha256 = digest(`connection:${id}`);
  database
    .prepare(
      `INSERT INTO organization_tool_connection_contracts (
         connection_id, contract_json, contract_sha256, created_at
       ) VALUES (?, '{}', ?, '2026-08-21T12:00:00.000Z')`,
    )
    .run(id, contractSha256);
  return contractSha256;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("organization control state baseline V3", () => {
  const RETIRED_IDENTITY = /enrollment|installation|(?<!re)lease/i;

  it("freezes a migration-ledger-free ECOP schema without retired identity objects", () => {
    const sql = organizationControlBaselineSqlV3();
    expect(RETIRED_IDENTITY.test(sql)).toBe(false);
    expect(sql).not.toContain("organization_schema_migrations");
    expect(organizationControlBaselineSha256V3()).toBe(
      "sha256:9aa161419d77355058151d2dd41283594802fe6da62f62f4aa92dbce01029c69",
    );

    const database = openOrganizationControlDatabase(databasePath());
    try {
      applyOrganizationControlBaselineV3(database);
      const names = schemaObjects(database).map(({ name }) => name);
      expect(names).not.toContain("organization_schema_migrations");
      expect(names).not.toContain("organization_provider_human_action_evidence");
      expect(names).toContain("organization_private_approval_pending_contracts_v2");
      expect(names).toContain("organization_person_slack_link_challenges");
      expect(digest(JSON.stringify(schemaObjects(database)))).toBe(
        "sha256:bbc0351ea8234acb1f43f4ebf0316a4e8ecac30f25297fc45f3afd8c1a726229",
      );
      expect(database.pragma("application_id", { simple: true })).toBe(
        ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID,
      );
      expect(database.pragma("user_version", { simple: true })).toBe(
        ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V3,
      );
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("applies only to a completely empty database and leaves refusal targets untouched", () => {
    const database = openOrganizationControlDatabase(databasePath());
    try {
      applyOrganizationControlBaselineV3(database);
      const objects = schemaObjects(database);
      expect(() => applyOrganizationControlBaselineV3(database)).toThrow(
        /completely empty database/,
      );
      expect(schemaObjects(database)).toEqual(objects);
    } finally {
      database.close();
    }

    const occupied = new Database(":memory:");
    try {
      occupied.exec("CREATE TABLE occupied (value TEXT) STRICT");
      expect(() => applyOrganizationControlBaselineV3(occupied)).toThrow(
        /completely empty database/,
      );
      expect(
        occupied
          .prepare("SELECT name FROM sqlite_master WHERE name = 'occupied'")
          .get(),
      ).toEqual({ name: "occupied" });
    } finally {
      occupied.close();
    }
  });

  it("does not allow null enterprise IDs to bypass active human-link uniqueness", () => {
    const database = openOrganizationControlDatabase(databasePath());
    try {
      applyOrganizationControlBaselineV3(database);
      for (const [id, membership] of [
        ["clm_one", "mem_one"],
        ["clm_two", "mem_two"],
      ] as const) {
        const contract = digest(`link:${id}`);
        database
          .prepare(
            `INSERT INTO organization_external_human_link_contracts (
               external_identity_link_id, contract_sha256, contract_json, created_at
             ) VALUES (?, ?, '{}', '2026-08-21T12:00:00.000Z')`,
          )
          .run(id, contract);
        if (id === "clm_one") {
          database
            .prepare(
              `INSERT INTO organization_external_human_link_current (
                 external_identity_link_id, contract_sha256, provider_issuer,
                 provider_tenant_kind, provider_tenant_id, provider_enterprise_id,
                 provider_subject_id, principal_id, membership_id, current_status,
                 updated_at
               ) VALUES (?, ?, 'https://slack.com', 'workspace', 'T_ONE', NULL,
                 'U_ONE', 'prn_one', ?, 'active', '2026-08-21T12:00:00.000Z')`,
            )
            .run(id, contract, membership);
        } else {
          expect(() =>
            database
              .prepare(
                `INSERT INTO organization_external_human_link_current (
                   external_identity_link_id, contract_sha256, provider_issuer,
                   provider_tenant_kind, provider_tenant_id, provider_enterprise_id,
                   provider_subject_id, principal_id, membership_id, current_status,
                   updated_at
                 ) VALUES (?, ?, 'https://slack.com', 'workspace', 'T_ONE', NULL,
                   'U_ONE', 'prn_two', ?, 'active', '2026-08-21T12:00:00.000Z')`,
              )
              .run(id, contract, membership),
          ).toThrow(/UNIQUE constraint failed/);
        }
      }
    } finally {
      database.close();
    }
  });

  it("requires every mutable connection fence to name its exact frozen contract", () => {
    const database = openOrganizationControlDatabase(databasePath());
    try {
      applyOrganizationControlBaselineV3(database);
      const first = seedConnection(database, "con_one");
      const second = seedConnection(database, "con_two");
      expect(() =>
        database
          .prepare(
            `INSERT INTO organization_tool_connection_current_state (
               connection_id, connection_contract_sha256, state_json,
               state_sha256, current_status, updated_at
             ) VALUES ('con_one', ?, '{}', ?, 'active',
               '2026-08-21T12:00:00.000Z')`,
          )
          .run(second, digest("state:wrong")),
      ).toThrow(/does not match its contract/);
      database
        .prepare(
          `INSERT INTO organization_tool_connection_current_state (
             connection_id, connection_contract_sha256, state_json,
             state_sha256, current_status, updated_at
           ) VALUES ('con_one', ?, '{}', ?, 'active',
             '2026-08-21T12:00:00.000Z')`,
        )
        .run(first, digest("state:one"));
      expect(() =>
        database
          .prepare(
            `INSERT INTO organization_tool_connection_current_state (
               connection_id, connection_contract_sha256, state_json,
               state_sha256, current_status, updated_at
             ) VALUES ('con_two', ?, '{}', ?, 'active',
               '2026-08-21T12:00:00.000Z')`,
          )
          .run(second, digest("state:two")),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      database.close();
    }
  });

  it("permits only terminal Person Slack challenge transitions", () => {
    const database = openOrganizationControlDatabase(databasePath());
    try {
      applyOrganizationControlBaselineV3(database);
      seedConnection(database);
      database
        .prepare(
          `INSERT INTO organization_person_slack_link_challenges (
             challenge_attempt_id, connection_id, principal_id, membership_id,
             challenge_code_sha256, person_session_sha256, organization_tool_sha256,
             status, completion_sha256, challenge_message_ts, reply_message_ts,
             created_at, expires_at, completed_at
           ) VALUES (?, 'con_slack', 'prn_one', 'mem_one', ?, ?, ?, 'pending',
             NULL, NULL, NULL, '2026-08-21T12:00:00.000Z',
             '2026-08-21T12:05:00.000Z', NULL)`,
        )
        .run("cat_one", digest("code"), digest("session"), digest("tool"));
      database
        .prepare(
          `INSERT INTO organization_person_slack_link_commands
           (command_id, command_kind, command_semantic_sha256,
            challenge_attempt_id, created_at)
           VALUES ('psb_one', 'begin', ?, 'cat_one',
                   '2026-08-21T12:00:00.000Z')`,
        )
        .run(digest("begin"));
      expect(() =>
        database
          .prepare(
            `UPDATE organization_person_slack_link_commands
             SET command_kind = 'completion' WHERE command_id = 'psb_one'`,
          )
          .run(),
      ).toThrow(/command is immutable/);
      expect(() =>
        database
          .prepare(
            `UPDATE organization_person_slack_link_challenges
             SET principal_id = 'prn_two' WHERE challenge_attempt_id = 'cat_one'`,
          )
          .run(),
      ).toThrow(/transition is invalid/);
      database
        .prepare(
          `UPDATE organization_person_slack_link_challenges
           SET status = 'completed', completion_sha256 = ?,
               challenge_message_ts = '1750000000.000001',
               reply_message_ts = '1750000001.000001',
               completed_at = '2026-08-21T12:01:00.000Z'
           WHERE challenge_attempt_id = 'cat_one'`,
        )
        .run(digest("completion"));
      expect(() =>
        database
          .prepare(
            `UPDATE organization_person_slack_link_challenges
             SET status = 'expired' WHERE challenge_attempt_id = 'cat_one'`,
          )
          .run(),
      ).toThrow(/transition is invalid/);
    } finally {
      database.close();
    }
  });
});
