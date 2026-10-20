import type Database from "better-sqlite3";

const DIGEST = `sha256:${"a".repeat(64)}`;

/** The Authority's metadata and its one active owner, org_1/prn_1/mem_1 unless told otherwise. */
export function seedOwner(database: Database.Database, now: string, owner: {
  readonly authority_id: string; readonly organization_id: string; readonly principal_id: string; readonly membership_id: string;
  readonly organization_name?: string; readonly name?: string;
} = { authority_id: 'oau_1', organization_id: 'org_1', principal_id: 'prn_1', membership_id: 'mem_1' }): void {
  database.prepare(`INSERT INTO authority_metadata (
      singleton, authority_id, organization_id, organization_display_name,
      descriptor_json, created_at, last_observed_at
    ) VALUES (1, ?, ?, ?, '{}', ?, ?)`).run(owner.authority_id, owner.organization_id, owner.organization_name ?? 'Example', now, now);
  database.prepare('INSERT INTO authority_principals (principal_id, organization_id, display_name, provisioned_at) VALUES (?, ?, ?, ?)')
    .run(owner.principal_id, owner.organization_id, owner.name ?? 'Owner', now);
  database.prepare(`INSERT INTO authority_memberships (membership_id, organization_id, principal_id, membership_type, status, provisioned_at)
    VALUES (?, ?, ?, 'owner', 'active', ?)`).run(owner.membership_id, owner.organization_id, owner.principal_id, now);
}

/**
 * Seeds one owner (org_1/prn_1/mem_1) and admits a synthetic meeting source
 * under `sourceKey`, for schema tests that write rows behind an admission.
 */
export function seedOwnerWithAdmission(database: Database.Database, sourceKey: string, now: string): void {
  seedOwner(database, now);
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
