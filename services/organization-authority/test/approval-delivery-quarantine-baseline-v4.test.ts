import { describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV3,
  applyAuthorityBaselineV4,
  AUTHORITY_BASELINE_APPLICATION_ID_V4,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V4,
  authorityBaselineSha256V4,
} from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-authority-database.js";

const AUTHORITY_BASELINE_SHA256_V4 =
  "sha256:70778da965c467d04be350bd36cc73b711ba783310077c6d0c04c85777b76512";
const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-30T00:00:00.000Z";

function openedV4Database() {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV4(database);
  return database;
}

function seedCandidate(database: ReturnType<typeof openedV4Database>): void {
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
        'actionable', 'fixture://cursor/one', ?, '{"meeting":true}', ?,
        '{"decisions":true}', ?
      )`,
    )
    .run(
      DIGEST,
      DIGEST,
      DIGEST,
      DIGEST,
      DIGEST,
      DIGEST,
      DIGEST,
      DIGEST,
      NOW,
    );
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
        'cnd_2', ?, ?, 'rli_2', ?, ?, 'restricted', ?, 'Only me', ?,
        'actionable', 'fixture://cursor/two', ?, '{"meeting":false}', ?,
        '{"decisions":false}', ?
      )`,
    )
    .run(
      `sha256:${"b".repeat(64)}`,
      DIGEST,
      `sha256:${"c".repeat(64)}`,
      `sha256:${"d".repeat(64)}`,
      `sha256:${"e".repeat(64)}`,
      `sha256:${"f".repeat(64)}`,
      `sha256:${"1".repeat(64)}`,
      `sha256:${"2".repeat(64)}`,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO authority_live_approval_outbox_v2 (
        candidate_id, approval_id, stage_command_id, state, updated_at
      ) VALUES ('cnd_1', 'apr_1', 'pas_1', 'queued', ?)`,
    )
    .run(NOW);
}

describe("Authority approval-delivery-quarantine baseline v4", () => {
  it("is a pinned fresh-only V3-plus-quarantine schema while preserving V3 bytes", () => {
    const database = openedV4Database();
    try {
      expect(authorityBaselineSha256V4()).toBe(AUTHORITY_BASELINE_SHA256_V4);
      expect(database.pragma("application_id", { simple: true })).toBe(
        AUTHORITY_BASELINE_APPLICATION_ID_V4,
      );
      expect(database.pragma("user_version", { simple: true })).toBe(
        AUTHORITY_BASELINE_SCHEMA_VERSION_V4,
      );
      expect(
        database
          .prepare("PRAGMA table_info(authority_live_approval_delivery_quarantines_v1)")
          .all()
          .map((row) => (row as { readonly name: string }).name),
      ).toEqual(["candidate_id", "reason_code", "quarantined_at"]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("makes quarantine immutable and fences a quarantined outbox to supersession", () => {
    const database = openedV4Database();
    try {
      seedCandidate(database);
      database
        .prepare(
          `INSERT INTO authority_live_approval_delivery_quarantines_v1 (
            candidate_id, reason_code, quarantined_at
          ) VALUES ('cnd_1', 'approval_package_unrepresentable', ?)`,
        )
        .run(NOW);
      expect(() =>
        database
          .prepare(
            `UPDATE authority_live_approval_outbox_v2
             SET state = 'posting', frozen_card_sha256 = ?,
                 approved_snapshot_json = '{}', approved_snapshot_sha256 = ?,
                 post_started_at = ?
             WHERE candidate_id = 'cnd_1'`,
          )
          .run(DIGEST, DIGEST, NOW),
      ).toThrow(/quarantined approval outbox only permits supersession/);
      database
        .prepare(
          `UPDATE authority_live_approval_outbox_v2
           SET state = 'superseded', superseded_by_candidate_id = 'cnd_2',
               superseded_at = ?, updated_at = ?
           WHERE candidate_id = 'cnd_1'`,
        )
        .run(NOW, NOW);
      expect(() =>
        database
          .prepare(
            `UPDATE authority_live_approval_outbox_v2
             SET updated_at = ? WHERE candidate_id = 'cnd_1'`,
          )
          .run("2026-08-30T00:00:01.000Z"),
      ).toThrow(/quarantined approval outbox only permits supersession/);
      expect(() =>
        database
          .prepare(
            `UPDATE authority_live_approval_delivery_quarantines_v1
             SET quarantined_at = ? WHERE candidate_id = 'cnd_1'`,
          )
          .run("2026-08-30T00:00:01.000Z"),
      ).toThrow(/approval delivery quarantine is immutable/);
      expect(() =>
        database
          .prepare(
            "DELETE FROM authority_live_approval_delivery_quarantines_v1 WHERE candidate_id = 'cnd_1'",
          )
          .run(),
      ).toThrow(/approval delivery quarantine deletion is denied/);
      expect(() =>
        database
          .prepare(
            `INSERT INTO authority_live_approval_delivery_quarantines_v1 (
              candidate_id, reason_code, quarantined_at
            ) VALUES ('cnd_2', 'other', ?)`,
          )
          .run(NOW),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      database.close();
    }
  });

  it("refuses to turn an existing V3 or V4 file into a V4 lineage", () => {
    const database = openedV4Database();
    try {
      expect(() => applyAuthorityBaselineV4(database)).toThrow(
        /completely empty database/,
      );
    } finally {
      database.close();
    }
    const v3 = openAuthorityDatabase(":memory:");
    try {
      applyAuthorityBaselineV3(v3);
      expect(() => applyAuthorityBaselineV4(v3)).toThrow(
        /completely empty database/,
      );
    } finally {
      v3.close();
    }
  });
});
