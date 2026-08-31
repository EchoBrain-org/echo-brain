import { describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV3,
  AUTHORITY_BASELINE_APPLICATION_ID_V3,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V3,
  authorityBaselineSha256V3,
} from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-authority-database.js";

const AUTHORITY_BASELINE_SHA256_V3 =
  "sha256:ee53f22ed84b8e4bae20b5c86387d6eb4f8a96693618272fa3416fade0356673";
const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-29T00:00:00.000Z";

function openedV3Database() {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV3(database);
  return database;
}

function seedOwner(database: ReturnType<typeof openedV3Database>): void {
  database
    .prepare(
      `INSERT INTO authority_metadata (
        singleton, authority_id, organization_id, organization_display_name,
        descriptor_json, created_at, last_observed_at
      ) VALUES (1, 'oau_1', 'org_1', 'Example', '{}', ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO authority_principals (
        principal_id, organization_id, display_name, provisioned_at
      ) VALUES ('prn_1', 'org_1', 'Owner', ?)`,
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO authority_memberships (
        membership_id, organization_id, principal_id, membership_type, status,
        provisioned_at, revoked_at, revocation_reason, employee_email,
        employee_email_sha256
      ) VALUES ('mem_1', 'org_1', 'prn_1', 'owner', 'active', ?, NULL, NULL, NULL, NULL)`,
    )
    .run(NOW);
}

function admitSyntheticSource(
  database: ReturnType<typeof openedV3Database>,
): void {
  database
    .prepare(
      `INSERT INTO authority_live_source_admission_v2 (
        singleton, organization_id, principal_id, membership_id, membership_type,
        source_adapter_id, source_adapter_version, source_adapter_instance_id,
        normalizer_version, source_custodian_sha256,
        source_custodian_assurance, source_custodian_observed_at,
        source_credential_reference_sha256, initial_cursor, cutoff_at,
        processor_adapter_id, processor_adapter_version, processor_instance_id,
        processor_configuration_sha256, processor_credential_reference_sha256,
        semantic_input_sha256, admitted_at
      ) VALUES (
        1, 'org_1', 'prn_1', 'mem_1', 'owner',
        'synthetic-meeting-fixture-v1', '1.0.0', 'synthetic-fixture',
        '1.0.0', ?, 'fixture_owner_declared', ?, ?,
        'fixture://cursor/zero', ?,
        'decision-processor', '1.0.0', 'processor', ?, ?, ?, ?
      )`,
    )
    .run(DIGEST, NOW, DIGEST, NOW, DIGEST, DIGEST, DIGEST, NOW);
}

describe("Authority admitted meeting-source baseline v3", () => {
  it("is a pinned fresh-only provider-neutral schema with stable role headers", () => {
    const database = openedV3Database();
    try {
      expect(authorityBaselineSha256V3()).toBe(AUTHORITY_BASELINE_SHA256_V3);
      expect(database.pragma("application_id", { simple: true })).toBe(
        AUTHORITY_BASELINE_APPLICATION_ID_V3,
      );
      expect(database.pragma("user_version", { simple: true })).toBe(
        AUTHORITY_BASELINE_SCHEMA_VERSION_V3,
      );
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .pluck()
        .all() as string[];
      expect(tables).toEqual(
        expect.arrayContaining([
          "authority_live_source_admission_v2",
          "authority_live_source_progress_v2",
          "authority_live_source_candidates_v2",
          "authority_live_source_review_lineage_heads_v2",
          "authority_live_approval_outbox_v2",
          "authority_live_v4_receipts_v2",
          "authority_private_approval_assignments_v3",
          "authority_private_approval_terminal_receipts_v3",
        ]),
      );
      expect(tables).not.toContain("authority_clean_granola_source_admission_v1");
      expect(
        database
          .prepare("SELECT count(*) FROM sqlite_master WHERE lower(sql) LIKE '%granola%'")
          .pluck()
          .get(),
      ).toBe(0);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("accepts opaque provider cursors while retaining ordered, immutable state", () => {
    const database = openedV3Database();
    try {
      seedOwner(database);
      admitSyntheticSource(database);
      database
        .prepare(
          `INSERT INTO authority_live_source_progress_v2 (
            singleton, admission_semantic_input_sha256, cursor, cursor_version, updated_at
          ) VALUES (1, ?, 'not-a-granola-prefix', 0, ?)`,
        )
        .run(DIGEST, NOW);
      database
        .prepare(
          `UPDATE authority_live_source_progress_v2
           SET cursor = 'arbitrary-provider-cursor', cursor_version = 1, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(NOW);
      expect(() =>
        database
          .prepare(
            `UPDATE authority_live_source_progress_v2
             SET cursor = 'same-version', cursor_version = 1, updated_at = ?
             WHERE singleton = 1`,
          )
          .run(NOW),
      ).toThrow(/ordered cursor advances/);
      expect(() =>
        database
          .prepare("UPDATE authority_live_source_admission_v2 SET cutoff_at = ?")
          .run(NOW),
      ).toThrow(/admission is immutable/);
    } finally {
      database.close();
    }
  });

  it("keeps the existing Slack DM assignment contract while relinking it to generic candidates", () => {
    const database = openedV3Database();
    try {
      const sql = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'authority_private_approval_assignments_v3'",
        )
        .pluck()
        .get() as string;
      expect(sql).toContain("candidate_id TEXT NOT NULL UNIQUE REFERENCES authority_live_source_candidates_v2(candidate_id)");
      expect(sql).toContain("slack_workspace_id TEXT NOT NULL");
      expect(sql).toContain("slack_enterprise_id TEXT CHECK");
      expect(sql).toContain("slack_subject_id TEXT NOT NULL");
      expect(sql).toContain("slack_dm_channel_id TEXT NOT NULL CHECK");
      expect(sql).toContain("substr(slack_dm_channel_id, 1, 1) = 'D'");
      expect(sql).not.toContain("delivery_workspace_id");
    } finally {
      database.close();
    }
  });

  it("keeps the private-approval terminal receipt fence dependent on generic candidates", () => {
    const database = openedV3Database();
    try {
      seedOwner(database);
      admitSyntheticSource(database);
      database
        .prepare(
          `INSERT INTO authority_live_source_candidates_v2 (
            candidate_id, candidate_semantic_sha256, admission_semantic_input_sha256,
            review_lineage_id, review_input_sha256, review_semantic_sha256,
            review_policy_id, review_policy_contract_sha256,
            review_policy_consequence_text, review_policy_consequence_sha256,
            disposition, source_cursor, meeting_sha256, meeting_json,
            decisions_sha256, decisions_json, created_at
          ) VALUES (
            'cnd_1', ?, ?, 'rli_1', ?, ?, 'restricted', ?, 'Only me', ?,
            'actionable', 'fixture://cursor/one', ?, '{"meeting":true}', ?, '{"decisions":true}', ?
          )`,
        )
        .run(DIGEST, DIGEST, DIGEST, DIGEST, DIGEST, DIGEST, DIGEST, DIGEST, NOW);
      database
        .prepare(
          `INSERT INTO authority_private_approval_assignments_v3 (
            approval_id, candidate_id, candidate_sha256, frozen_card_sha256,
            approved_snapshot_sha256, connection_id, connection_contract_sha256,
            connection_state_sha256, external_identity_link_id,
            external_identity_link_contract_sha256, assignee_principal_id,
            assignee_membership_id, slack_workspace_id, slack_enterprise_id,
            slack_subject_id, slack_dm_channel_id, created_at
          ) VALUES (
            'apr_1', 'cnd_1', ?, ?, ?, 'con_1', ?, ?, 'clm_1', ?, 'prn_1',
            'mem_1', 'workspace', NULL, 'person', 'Dprivate-channel', ?
          )`,
        )
        .run(DIGEST, DIGEST, DIGEST, DIGEST, DIGEST, DIGEST, NOW);
      expect(() =>
        database
          .prepare(
            `INSERT INTO authority_private_approval_terminal_receipts_v3 (
              approval_id, candidate_id, outcome, resolution_json, resolution_sha256,
              v4_receipt_json, v4_receipt_sha256, card_render_state,
              card_rendered_at, recorded_at
            ) VALUES ('apr_missing', 'cnd_1', 'rejected', '{"outcome":"rejected"}', ?, NULL, NULL, 'unrendered', NULL, ?)`,
          )
          .run(DIGEST, NOW),
      ).toThrow(/FOREIGN KEY/);
      database
        .prepare(
          `INSERT INTO authority_private_approval_terminal_receipts_v3 (
            approval_id, candidate_id, outcome, resolution_json, resolution_sha256,
            v4_receipt_json, v4_receipt_sha256, card_render_state,
            card_rendered_at, recorded_at
          ) VALUES ('apr_1', 'cnd_1', 'rejected', '{"outcome":"rejected"}', ?, NULL, NULL, 'unrendered', NULL, ?)`,
        )
        .run(DIGEST, NOW);
      expect(() =>
        database
          .prepare("DELETE FROM authority_private_approval_terminal_receipts_v3")
          .run(),
      ).toThrow(/cannot be deleted/);
    } finally {
      database.close();
    }
  });

  it("refuses to turn an existing V1, V2, or V3 file into a V3 lineage", () => {
    const database = openedV3Database();
    try {
      expect(() => applyAuthorityBaselineV3(database)).toThrow(
        /completely empty database/,
      );
    } finally {
      database.close();
    }
  });
});
