import type Database from "better-sqlite3";

const DIGEST = `sha256:${"a".repeat(64)}`;

/**
 * Seeds one owner (org_1/prn_1/mem_1) and admits a synthetic meeting source
 * under `sourceKey`, for schema tests that write rows behind an admission.
 */
export function seedOwnerWithAdmission(database: Database.Database, sourceKey: string, now: string): void {
  database.prepare(`INSERT INTO authority_metadata (
      singleton, authority_id, organization_id, organization_display_name,
      descriptor_json, created_at, last_observed_at
    ) VALUES (1, 'oau_1', 'org_1', 'Example', '{}', ?, ?)`).run(now, now);
  database.prepare(`INSERT INTO authority_principals (
      principal_id, organization_id, display_name, provisioned_at
    ) VALUES ('prn_1', 'org_1', 'Owner', ?)`).run(now);
  database.prepare(`INSERT INTO authority_memberships (
      membership_id, organization_id, principal_id, membership_type, status,
      provisioned_at, revoked_at, revocation_reason, employee_email,
      employee_email_sha256
    ) VALUES ('mem_1', 'org_1', 'prn_1', 'owner', 'active', ?, NULL, NULL, NULL, NULL)`).run(now);
  database.prepare(`INSERT INTO authority_live_source_admission_v2 (
      source_key, organization_id, principal_id, membership_id, membership_type,
      source_adapter_id, source_adapter_version, source_adapter_instance_id,
      normalizer_version, source_custodian_sha256,
      source_custodian_assurance, source_custodian_observed_at,
      source_credential_reference_sha256, initial_cursor, cutoff_at,
      processor_adapter_id, processor_adapter_version, processor_instance_id,
      processor_configuration_sha256, processor_credential_reference_sha256,
      semantic_input_sha256, admitted_at
    ) VALUES (
      ?, 'org_1', 'prn_1', 'mem_1', 'owner',
      'synthetic-meeting-fixture-v1', '1.0.0', 'synthetic-fixture',
      '1.0.0', ?, 'fixture_owner_declared', ?, ?,
      'fixture://cursor/zero', ?,
      'decision-processor', '1.0.0', 'processor', ?, ?, ?, ?
    )`).run(sourceKey, DIGEST, now, DIGEST, now, DIGEST, DIGEST, DIGEST, now);
}
