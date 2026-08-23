import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV1,
  AUTHORITY_BASELINE_APPLICATION_ID_V1,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V1,
  authorityBaselineSha256V1,
  authorityBaselineSqlV1,
} from "../src/adapters/persistence/sqlite/baseline.js";
import {
  openAndMigrateAuthorityDatabase,
  openAuthorityDatabase,
} from "../src/adapters/persistence/sqlite/open-database.js";
import { STATE_LINEAGE_ROLE_APPLICATION_IDS_V1 } from "../src/state-lineage/state-lineage-manifest-v1.js";

const directories: string[] = [];

const NEW_LINEAGE_TABLE_COLUMNS = {
  authority_metadata: [
    "singleton",
    "authority_id",
    "organization_id",
    "organization_display_name",
    "descriptor_json",
    "created_at",
    "last_observed_at",
  ],
  authority_principals: [
    "principal_id",
    "organization_id",
    "display_name",
    "provisioned_at",
  ],
  authority_memberships: [
    "membership_id",
    "organization_id",
    "principal_id",
    "membership_type",
    "status",
    "provisioned_at",
    "revoked_at",
    "revocation_reason",
    "employee_email_sha256",
  ],
  authority_provider_human_action_reproofs: [
    "provider_action_sha256",
    "authorization_sha256",
    "integration_audit_entry_sha256",
    "durable_result_sha256",
    "currentness_reproof_sha256",
    "recorded_at",
  ],
  authority_record_write_inputs: [
    "semantic_idempotency_sha256",
    "human_act_sha256",
    "human_act_json",
    "envelope_sha256",
    "envelope_json",
    "provider_action_sha256",
    "currentness_reproof_sha256",
    "created_at",
  ],
  authority_record_write_receipts: [
    "receipt_sha256",
    "receipt_json",
    "semantic_idempotency_sha256",
    "recorded_at",
  ],
  authority_person_read_decision_audit_v2: [
    "row_sha256",
    "body_json",
    "context_kind",
    "prompt_sha256",
    "answer_sha256",
    "recorded_at",
  ],
  authority_readable_search_active_generation: [
    "singleton",
    "organization_id",
    "generation_id",
    "manifest_sha256",
    "retrieval_contract_sha256",
    "record_head_position",
    "record_head_hash",
    "published_at",
  ],
  authority_clean_granola_source_admission_v1: [
    "singleton",
    "organization_id",
    "principal_id",
    "membership_id",
    "membership_type",
    "source_instance_id",
    "source_adapter_version",
    "normalizer_version",
    "owner_email_sha256",
    "owner_observation_assurance",
    "owner_observed_at",
    "source_credential_reference_sha256",
    "cursor",
    "cutoff_at",
    "processor_instance_id",
    "processor_adapter_version",
    "processor_configuration_sha256",
    "processor_credential_reference_sha256",
    "semantic_input_sha256",
    "admitted_at",
  ],
  authority_clean_granola_source_progress_v1: [
    "singleton",
    "admission_semantic_input_sha256",
    "cursor",
    "cursor_version",
    "updated_at",
  ],
  authority_clean_live_candidates_v1: [
    "candidate_id",
    "candidate_semantic_sha256",
    "admission_semantic_input_sha256",
    "source_cursor",
    "meeting_sha256",
    "meeting_json",
    "decisions_sha256",
    "decisions_json",
    "created_at",
  ],
  authority_clean_live_approval_outbox_v1: [
    "candidate_id",
    "approval_id",
    "stage_command_id",
    "state",
    "provider_message_ts",
    "frozen_card_sha256",
    "approved_snapshot_json",
    "approved_snapshot_sha256",
    "control_approval_sha256",
    "updated_at",
  ],
  authority_clean_live_v4_receipts_v1: [
    "approval_id",
    "control_approval_sha256",
    "receipt_sha256",
    "receipt_json",
    "recorded_at",
  ],
} as const;

const NEW_LINEAGE_OBJECTS = [
  "index:authority_memberships_current",
  "index:authority_memberships_active_employee_email",
  "index:authority_oidc_identity_bindings_active_subject",
  "index:authority_person_login_grants_pending_membership",
  "table:authority_provider_human_action_reproofs",
  "table:authority_record_write_inputs",
  "table:authority_record_write_receipts",
  "table:authority_person_read_decision_audit_v2",
  "table:authority_readable_search_active_generation",
  "table:authority_clean_granola_source_admission_v1",
  "table:authority_clean_granola_source_progress_v1",
  "table:authority_clean_live_candidates_v1",
  "table:authority_clean_live_approval_outbox_v1",
  "table:authority_clean_live_v4_receipts_v1",
  "trigger:authority_provider_human_action_reproofs_immutable",
  "trigger:authority_person_read_decision_audit_v2_immutable",
  "trigger:authority_person_read_decision_audit_v2_delete_denied",
  "trigger:authority_clean_granola_source_admission_v1_delete_denied",
  "trigger:authority_clean_granola_source_admission_v1_immutable",
  "trigger:authority_clean_granola_source_progress_v1_delete_denied",
  "trigger:authority_clean_granola_source_progress_v1_only_advances",
  "trigger:authority_clean_live_candidates_v1_delete_denied",
  "trigger:authority_clean_live_candidates_v1_immutable_update",
  "trigger:authority_clean_live_approval_outbox_v1_delete_denied",
  "trigger:authority_clean_live_approval_outbox_v1_ordered_transition",
  "trigger:authority_clean_live_v4_receipts_v1_delete_denied",
  "trigger:authority_clean_live_v4_receipts_v1_immutable_update",
].sort();

const SETTLED_PERSON_SESSION_TABLES = [
  "authority_oidc_identity_bindings",
  "authority_person_session_families",
  "authority_person_session_credentials",
] as const;

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), "echo-authority-baseline-"));
  directories.push(directory);
  return join(directory, "authority.sqlite");
}

function namedObjects(database: Database.Database, names: readonly string[]) {
  return database
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name IN (${names.map(() => "?").join(", ")})
       ORDER BY type, name`,
    )
    .all(...names) as Array<{ type: string; name: string; sql: string }>;
}

function identityObjectNames(database: Database.Database): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE name LIKE 'authority_person_login_grants%'
            OR name LIKE 'authority_oidc_%'
            OR name LIKE 'authority_person_session_%'
            OR name = 'authority_memberships_revoke_person_session_families'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("private Authority new-lineage baseline v1", () => {
  it("retains the settled Person/OIDC/session terminal schema except genesis-only employee lifecycle facts", () => {
    const baseline = openAuthorityDatabase(path());
    const legacyPath = path();
    try {
      applyAuthorityBaselineV1(baseline);
      openAndMigrateAuthorityDatabase(legacyPath).close();
      const legacy = new Database(legacyPath, { readonly: true });
      try {
        const names = identityObjectNames(legacy).filter(
          (name) =>
            !name.startsWith("authority_person_login_grants") &&
            !name.startsWith("authority_oidc_login_attempts") &&
            !name.startsWith("authority_oidc_identity_bindings") &&
            name !== "authority_memberships_revoke_person_session_families",
        );
        expect(
          identityObjectNames(baseline).filter(
            (name) =>
              !name.startsWith("authority_person_login_grants") &&
              !name.startsWith("authority_oidc_login_attempts") &&
              !name.startsWith("authority_oidc_identity_bindings") &&
              name !== "authority_memberships_revoke_person_session_families",
          ),
        ).toEqual(names);
        expect(namedObjects(baseline, names)).toEqual(
          namedObjects(legacy, names),
        );
        for (const table of SETTLED_PERSON_SESSION_TABLES) {
          expect(baseline.pragma(`table_xinfo(${table})`)).toEqual(
            legacy.pragma(`table_xinfo(${table})`),
          );
        }
      } finally {
        legacy.close();
      }
    } finally {
      baseline.close();
    }
  });

  it("has an exact lean new-lineage allowlist and role-stable headers", () => {
    const database = openAuthorityDatabase(path());
    try {
      applyAuthorityBaselineV1(database);
      for (const [table, expected] of Object.entries(
        NEW_LINEAGE_TABLE_COLUMNS,
      )) {
        const columns = database.pragma(`table_xinfo(${table})`) as Array<{
          name: string;
        }>;
        expect(
          columns.map(({ name }) => name),
          table,
        ).toEqual(expected);
      }
      const objects = namedObjects(
        database,
        NEW_LINEAGE_OBJECTS.map((item) => item.slice(item.indexOf(":") + 1)),
      )
        .map(({ type, name }) => `${type}:${name}`)
        .sort();
      expect(objects).toEqual(NEW_LINEAGE_OBJECTS);
      expect(AUTHORITY_BASELINE_APPLICATION_ID_V1).toBe(0x45434155);
      expect(AUTHORITY_BASELINE_APPLICATION_ID_V1).toBe(
        STATE_LINEAGE_ROLE_APPLICATION_IDS_V1.authority,
      );
      expect(database.pragma("application_id", { simple: true })).toBe(
        AUTHORITY_BASELINE_APPLICATION_ID_V1,
      );
      expect(database.pragma("user_version", { simple: true })).toBe(
        AUTHORITY_BASELINE_SCHEMA_VERSION_V1,
      );
    } finally {
      database.close();
    }
  });

  it("keeps D2 references narrow and makes D2/D6 evidence immutable", () => {
    const database = openAuthorityDatabase(path());
    try {
      applyAuthorityBaselineV1(database);
      const schema = authorityBaselineSqlV1();
      expect(schema).not.toContain("provider_action_json");
      expect(schema).not.toContain("integration_audit_json");
      database
        .prepare(
          `INSERT INTO authority_provider_human_action_reproofs
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          digest("a"),
          digest("b"),
          digest("c"),
          digest("d"),
          digest("e"),
          "2026-08-22T00:00:00.000Z",
        );
      expect(() =>
        database
          .prepare(
            `UPDATE authority_provider_human_action_reproofs
            SET recorded_at = ? WHERE provider_action_sha256 = ?`,
          )
          .run("2026-08-22T00:00:01.000Z", digest("a")),
      ).toThrow(/immutable/);

      database
        .prepare(
          `INSERT INTO authority_person_read_decision_audit_v2
           (row_sha256, body_json, context_kind, prompt_sha256, answer_sha256, recorded_at)
           VALUES (?, ?, 'record_read', NULL, NULL, ?)`,
        )
        .run(
          digest("f"),
          '{"kind":"echo-clean-person-record-read-audit-v1","context_kind":"record_read","prompt_sha256":null,"answer_sha256":null}',
          "2026-08-22T00:00:00.000Z",
        );
      expect(() =>
        database
          .prepare(
            `UPDATE authority_person_read_decision_audit_v2
             SET recorded_at = ? WHERE row_sha256 = ?`,
          )
          .run("2026-08-22T00:00:01.000Z", digest("f")),
      ).toThrow(/immutable/);
      expect(() =>
        database
          .prepare(
            `INSERT INTO authority_person_read_decision_audit_v2
           VALUES (?, ?, 'record_read', ?, NULL, ?)`,
          )
          .run(digest("g"), "{}", digest("prompt"), "2026-08-22T00:00:00.000Z"),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO authority_person_read_decision_audit_v2
           VALUES (?, ?, 'answer_composition', NULL, NULL, ?)`,
          )
          .run(digest("h"), '{"x":1}', "2026-08-22T00:00:00.000Z"),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("binds read-audit discriminator and hash columns to their immutable JSON body", () => {
    const database = openAuthorityDatabase(path());
    try {
      applyAuthorityBaselineV1(database);
      const recordRead = JSON.stringify({
        context_kind: "record_read",
        prompt_sha256: null,
        answer_sha256: null,
      });
      const prompt = digest("a");
      const answer = digest("b");
      const answerComposition = JSON.stringify({
        context_kind: "answer_composition",
        prompt_sha256: prompt,
        answer_sha256: answer,
      });

      expect(() =>
        database
          .prepare(
            `INSERT INTO authority_person_read_decision_audit_v2
             (row_sha256, body_json, context_kind, prompt_sha256, answer_sha256, recorded_at)
             VALUES (?, ?, 'record_read', NULL, NULL, ?)`,
          )
          .run(digest("i"), recordRead, "2026-08-22T00:00:00.000Z"),
      ).not.toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO authority_person_read_decision_audit_v2
             (row_sha256, body_json, context_kind, prompt_sha256, answer_sha256, recorded_at)
             VALUES (?, ?, 'answer_composition', ?, ?, ?)`,
          )
          .run(
            digest("j"),
            answerComposition,
            prompt,
            answer,
            "2026-08-22T00:00:00.000Z",
          ),
      ).not.toThrow();

      expect(() =>
        database
          .prepare(
            `INSERT INTO authority_person_read_decision_audit_v2
             VALUES (?, ?, 'record_read', ?, NULL, ?)`,
          )
          .run(
            digest("k"),
            JSON.stringify({
              context_kind: "record_read",
              prompt_sha256: prompt,
              answer_sha256: null,
            }),
            prompt,
            "2026-08-22T00:00:00.000Z",
          ),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO authority_person_read_decision_audit_v2
             VALUES (?, ?, 'answer_composition', NULL, NULL, ?)`,
          )
          .run(
            digest("l"),
            JSON.stringify({
              context_kind: "answer_composition",
              prompt_sha256: null,
              answer_sha256: null,
            }),
            "2026-08-22T00:00:00.000Z",
          ),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO authority_person_read_decision_audit_v2
             VALUES (?, ?, 'record_read', NULL, NULL, ?)`,
          )
          .run(
            digest("m"),
            '{"context_kind":"record_read","answer_sha256":null}',
            "2026-08-22T00:00:00.000Z",
          ),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO authority_person_read_decision_audit_v2
             VALUES (?, ?, 'answer_composition', ?, ?, ?)`,
          )
          .run(
            digest("n"),
            JSON.stringify({
              context_kind: "answer_composition",
              prompt_sha256: digest("c"),
              answer_sha256: answer,
            }),
            prompt,
            answer,
            "2026-08-22T00:00:00.000Z",
          ),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("contains no retired employee-machine vocabulary and freezes the SQL digest", () => {
    const sql = authorityBaselineSqlV1();
    expect(sql).not.toMatch(
      /installation|enrollment|lease|internal[_ -]?live/i,
    );
    expect(sql).toContain(
      "owner_observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', owner_observed_at)",
    );
    expect(authorityBaselineSha256V1()).toBe(
      "sha256:0742b4e106e26773cda0c0fd99115818fcd0022eb6d2b7d5c0b3eac61b397e0f",
    );
  });

  it("is empty-only and never relabels a legacy database", () => {
    const fresh = openAuthorityDatabase(path());
    try {
      applyAuthorityBaselineV1(fresh);
      expect(() => applyAuthorityBaselineV1(fresh)).toThrow(
        /completely empty database/,
      );
    } finally {
      fresh.close();
    }
    const legacyPath = path();
    openAndMigrateAuthorityDatabase(legacyPath).close();
    const legacy = new Database(legacyPath);
    try {
      expect(() => applyAuthorityBaselineV1(legacy)).toThrow(
        /completely empty database/,
      );
      expect(legacy.pragma("user_version", { simple: true })).toBe(19);
      expect(legacy.pragma("application_id", { simple: true })).toBe(0);
    } finally {
      legacy.close();
    }
  });
});
