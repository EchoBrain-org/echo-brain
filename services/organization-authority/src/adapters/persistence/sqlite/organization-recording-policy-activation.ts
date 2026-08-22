import Database from 'better-sqlite3';
import {
  canonicalJson,
  parseCanonicalJson,
} from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_MEMBER_RECORDING_ACTIVATED_ACTION,
  organizationMemberRecordingActivationCommandSha256,
  organizationMemberRecordingActivationSha256,
  validateOrganizationMemberRecordingActivationCommand,
  type OrganizationMemberRecordingActivationCommandV1,
  type StoredOrganizationMemberRecordingActivation,
} from '../../../application/organization-recording-policy-activation.js';
import { openAndMigrateAuthorityDatabase } from './open-database.js';

interface ActivationRow {
  command_id: string;
  command_sha256: string;
  command_json: string;
  authority_id: string;
  organization_id: string;
  initialized_runtime_config_sha256: string;
  initialization_manifest_sha256: string;
  owner_principal_id: string;
  owner_membership_id: string;
  decision_processor_adapter_instance_id: string;
  approval_surface_adapter_instance_id: string;
  policy_contract_sha256: string;
  activated_at: string;
  activation_sha256: string;
  audit_sequence: number;
  audit_occurred_at: string;
  audit_actor_kind: string;
  audit_action: string;
  audit_subject_id: string;
  audit_detail_json: string;
}

const ACTIVATION_SELECT = `
  SELECT activation.command_id, activation.command_sha256,
         activation.command_json, activation.authority_id,
         activation.organization_id,
         activation.initialized_runtime_config_sha256,
         activation.initialization_manifest_sha256,
         activation.owner_principal_id, activation.owner_membership_id,
         activation.decision_processor_adapter_instance_id,
         activation.approval_surface_adapter_instance_id,
         activation.policy_contract_sha256, activation.activated_at,
         activation.activation_sha256, activation.audit_sequence,
         audit.occurred_at AS audit_occurred_at,
         audit.actor_kind AS audit_actor_kind, audit.action AS audit_action,
         audit.subject_id AS audit_subject_id,
         audit.detail_json AS audit_detail_json
    FROM authority_organization_member_recording_activation AS activation
    JOIN authority_audit_log AS audit
      ON audit.audit_sequence = activation.audit_sequence
   WHERE activation.singleton = 1`;

function storedActivation(row: ActivationRow): StoredOrganizationMemberRecordingActivation {
  const command = validateOrganizationMemberRecordingActivationCommand(
    parseCanonicalJson(row.command_json),
    { authority_id: row.authority_id, organization_id: row.organization_id },
  );
  const commandSha256 = organizationMemberRecordingActivationCommandSha256(command);
  if (
    canonicalJson(command) !== row.command_json ||
    command.command_id !== row.command_id ||
    commandSha256 !== row.command_sha256 ||
    command.initialized_runtime_config_sha256 !== row.initialized_runtime_config_sha256 ||
    command.initialization_manifest_sha256 !== row.initialization_manifest_sha256 ||
    command.owner_principal_id !== row.owner_principal_id ||
    command.owner_membership_id !== row.owner_membership_id ||
    command.target_policy.decision_processor_adapter_instance_id !== row.decision_processor_adapter_instance_id ||
    command.target_policy.approval_surface_adapter_instance_id !== row.approval_surface_adapter_instance_id ||
    command.target_policy.policy_contract_sha256 !== row.policy_contract_sha256 ||
    row.audit_occurred_at !== row.activated_at ||
    row.audit_actor_kind !== 'admin' ||
    row.audit_action !== ORGANIZATION_MEMBER_RECORDING_ACTIVATED_ACTION ||
    row.audit_subject_id !== row.organization_id
  ) {
    throw new Error('stored organization-member recording activation is invalid');
  }
  const detail = canonicalJson({
    command_id: command.command_id,
    command_sha256: commandSha256,
    activation_sha256: row.activation_sha256,
    initialized_runtime_config_sha256: command.initialized_runtime_config_sha256,
    initialization_manifest_sha256: command.initialization_manifest_sha256,
    owner_principal_id: command.owner_principal_id,
    owner_membership_id: command.owner_membership_id,
    target_policy: command.target_policy,
  });
  if (detail !== row.audit_detail_json) {
    throw new Error('organization-member recording activation audit is invalid');
  }
  const activationSha256 = organizationMemberRecordingActivationSha256({
    command_sha256: commandSha256,
    activated_at: row.activated_at,
    audit_sequence: row.audit_sequence,
  });
  if (activationSha256 !== row.activation_sha256) {
    throw new Error('organization-member recording activation digest is invalid');
  }
  return Object.freeze({
    command,
    command_sha256: commandSha256,
    activated_at: row.activated_at,
    activation_sha256: activationSha256,
    audit_sequence: row.audit_sequence,
  });
}

function row(database: Database.Database): ActivationRow | undefined {
  return database.prepare(ACTIVATION_SELECT).get() as ActivationRow | undefined;
}

/** Reads and fully verifies the additive activation through one SQLite snapshot. */
export function readOrganizationMemberRecordingActivation(
  databasePath: string,
): StoredOrganizationMemberRecordingActivation | null {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma('query_only = ON');
    database.pragma('trusted_schema = OFF');
    database.exec('BEGIN');
    try {
      const found = row(database);
      const result = found === undefined ? null : storedActivation(found);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  } finally {
    database.close();
  }
}

export function appendOrganizationMemberRecordingActivation(input: {
  readonly database_path: string;
  readonly command: OrganizationMemberRecordingActivationCommandV1;
  readonly activated_at: string;
  readonly fault_after_audit?: () => void;
}): { readonly created: boolean; readonly activation: StoredOrganizationMemberRecordingActivation } {
  const database = openAndMigrateAuthorityDatabase(input.database_path, { fileMustExist: true });
  const commandSha256 = organizationMemberRecordingActivationCommandSha256(input.command);
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = row(database);
      if (existing !== undefined) {
        const stored = storedActivation(existing);
        if (stored.command.command_id !== input.command.command_id || stored.command_sha256 !== commandSha256) {
          throw new Error('organization-member recording was already activated by a different command');
        }
        database.exec('COMMIT');
        return Object.freeze({ created: false, activation: stored });
      }
      const metadata = database.prepare(
        `SELECT authority_id, organization_id, last_observed_at
           FROM authority_metadata WHERE singleton = 1`,
      ).get() as { authority_id: string; organization_id: string; last_observed_at: string } | undefined;
      const owner = database.prepare(
        `SELECT membership_id, organization_id, principal_id,
                membership_type, status, revoked_at
           FROM authority_memberships
          WHERE organization_id = ? AND membership_id = ?`,
      ).get(input.command.organization_id, input.command.owner_membership_id) as
        | {
            membership_id: string;
            organization_id: string;
            principal_id: string;
            membership_type: string;
            status: string;
            revoked_at: string | null;
          }
        | undefined;
      if (
        metadata === undefined ||
        metadata.authority_id !== input.command.authority_id ||
        metadata.organization_id !== input.command.organization_id ||
        input.activated_at < metadata.last_observed_at ||
        owner === undefined ||
        owner.membership_id !== input.command.owner_membership_id ||
        owner.organization_id !== input.command.organization_id ||
        owner.principal_id !== input.command.owner_principal_id ||
        owner.membership_type !== 'owner' ||
        owner.status !== 'active' ||
        owner.revoked_at !== null
      ) {
        throw new Error('organization-member recording activation requires the current active owner');
      }
      database.prepare('UPDATE authority_metadata SET last_observed_at = ? WHERE singleton = 1').run(input.activated_at);
      const auditDetailWithoutActivation = {
        command_id: input.command.command_id,
        command_sha256: commandSha256,
        initialized_runtime_config_sha256: input.command.initialized_runtime_config_sha256,
        initialization_manifest_sha256: input.command.initialization_manifest_sha256,
        owner_principal_id: input.command.owner_principal_id,
        owner_membership_id: input.command.owner_membership_id,
        target_policy: input.command.target_policy,
      } as const;
      // BEGIN IMMEDIATE owns the only writer, so reserving the next explicit
      // sequence and inserting it below is atomic with the marker.
      const auditSequence = (database.prepare(
        'SELECT COALESCE(MAX(audit_sequence), 0) + 1 AS value FROM authority_audit_log',
      ).get() as { value: number }).value;
      const activationSha256 = organizationMemberRecordingActivationSha256({
        command_sha256: commandSha256,
        activated_at: input.activated_at,
        audit_sequence: auditSequence,
      });
      database.prepare(
        `INSERT INTO authority_audit_log
           (audit_sequence, occurred_at, actor_kind, action, subject_id, detail_json)
         VALUES (?, ?, 'admin', ?, ?, ?)`,
      ).run(
        auditSequence,
        input.activated_at,
        ORGANIZATION_MEMBER_RECORDING_ACTIVATED_ACTION,
        input.command.organization_id,
        canonicalJson({ ...auditDetailWithoutActivation, activation_sha256: activationSha256 }),
      );
      input.fault_after_audit?.();
      database.prepare(
        `INSERT INTO authority_organization_member_recording_activation (
           singleton, command_id, command_sha256, command_json, authority_id,
           organization_id, initialized_runtime_config_sha256,
           initialization_manifest_sha256, owner_principal_id,
           owner_membership_id, decision_processor_adapter_instance_id,
           approval_surface_adapter_instance_id, policy_contract_sha256,
           activated_at, activation_sha256, audit_sequence
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.command.command_id,
        commandSha256,
        canonicalJson(input.command),
        input.command.authority_id,
        input.command.organization_id,
        input.command.initialized_runtime_config_sha256,
        input.command.initialization_manifest_sha256,
        input.command.owner_principal_id,
        input.command.owner_membership_id,
        input.command.target_policy.decision_processor_adapter_instance_id,
        input.command.target_policy.approval_surface_adapter_instance_id,
        input.command.target_policy.policy_contract_sha256,
        input.activated_at,
        activationSha256,
        auditSequence,
      );
      const inserted = row(database);
      if (inserted === undefined) throw new Error('organization-member recording activation was not stored');
      const stored = storedActivation(inserted);
      database.exec('COMMIT');
      return Object.freeze({ created: true, activation: stored });
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  } finally {
    database.close();
  }
}
