import type Database from 'better-sqlite3';
import type { JsonObject, Sha256Digest } from '../application/contracts.js';
import type { OrganizationMemberPolicyFactAppendInput } from '../application/organization-member-eligibility-capability.js';
import {
  deriveOrganizationMemberReadableEligibilityProof,
  organizationMemberFactInvalid,
  organizationMemberFactUnavailable,
  organizationMemberPolicyFactSetSha256,
  projectOrganizationMemberPolicyFacts,
  readOrganizationMemberReadableEnvelope,
  type OrganizationMemberReadableEnvelopeValidator,
  type OrganizationRecordOrganizationMemberPolicyFactRow,
} from '../application/organization-member-policy-fact.js';

export const ORGANIZATION_MEMBER_POLICY_FACT_COLUMNS = `log_position, record_hash,
 organization_id, envelope_sha256, atom_order, atom_id, signal_id_sha256, item_kind,
 policy_id, policy_contract_sha256, approving_principal_id, approving_membership_id,
 release_draft_sha256, approval_presentation_sha256, semantic_intent_sha256,
 message_presentation_sha256, authorization_audit_event_id,
 authorization_audit_entry_sha256, evaluated_at, authorization_proof_sha256,
 content_binding_sha256, provenance_binding_sha256`;

interface Identity {
  readonly organization_id: string;
  readonly position: number;
  readonly record_hash: Sha256Digest;
  readonly envelope: JsonObject;
  readonly envelope_sha256: Sha256Digest;
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly installation_id: string;
  readonly validate: OrganizationMemberReadableEnvelopeValidator | undefined;
}

export function organizationMemberPolicyFactsForAppend(
  identity: Identity,
  input: OrganizationMemberPolicyFactAppendInput,
): readonly OrganizationRecordOrganizationMemberPolicyFactRow[] {
  const consumed = input.channel.consume(input.capability, {
    organization_id: identity.organization_id,
    envelope_id: identity.envelope_id,
    idempotency_key: identity.idempotency_key,
    installation_id: identity.installation_id,
    canonical_envelope_sha256: identity.envelope_sha256,
  });
  const envelope = readOrganizationMemberReadableEnvelope(identity.envelope, identity.validate);
  const derived = deriveOrganizationMemberReadableEligibilityProof({
    organization_id: identity.organization_id,
    canonical_envelope_sha256: identity.envelope_sha256,
    envelope,
  });
  if (
    consumed.authorization_proof_sha256 !== derived.authorization_proof_sha256 ||
    JSON.stringify(consumed.preimage) !== JSON.stringify(derived.preimage)
  ) {
    organizationMemberFactInvalid('verified organization-member eligibility does not describe this exact canonical envelope');
  }
  return projectOrganizationMemberPolicyFacts({
    organization_id: identity.organization_id,
    log_position: identity.position,
    record_hash: identity.record_hash,
    envelope_sha256: identity.envelope_sha256,
    envelope,
  });
}

export function insertOrganizationMemberPolicyFacts(
  database: Database.Database,
  rows: readonly OrganizationRecordOrganizationMemberPolicyFactRow[],
): void {
  if (rows.length === 0) organizationMemberFactInvalid('organization-member facts must not be empty');
  const statement = database.prepare(
    `INSERT INTO organization_member_readable_policy_fact (${ORGANIZATION_MEMBER_POLICY_FACT_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [index, row] of rows.entries()) {
    if (row.atom_order !== index) organizationMemberFactInvalid('organization-member facts must be dense zero-based order');
    statement.run(
      row.log_position, row.record_hash, row.organization_id, row.envelope_sha256,
      row.atom_order, row.atom_id, row.signal_id_sha256, row.item_kind, row.policy_id,
      row.policy_contract_sha256, row.approving_principal_id, row.approving_membership_id,
      row.release_draft_sha256, row.approval_presentation_sha256,
      row.semantic_intent_sha256, row.message_presentation_sha256,
      row.authorization_audit_event_id, row.authorization_audit_entry_sha256,
      row.evaluated_at, row.authorization_proof_sha256, row.content_binding_sha256,
      row.provenance_binding_sha256,
    );
  }
}

export function readOrganizationMemberPolicyFactsAtPosition(
  database: Database.Database,
  position: number,
): readonly OrganizationRecordOrganizationMemberPolicyFactRow[] {
  return database.prepare(
    `SELECT ${ORGANIZATION_MEMBER_POLICY_FACT_COLUMNS}
     FROM organization_member_readable_policy_fact
     WHERE log_position = ? ORDER BY atom_order ASC`,
  ).all(position) as OrganizationRecordOrganizationMemberPolicyFactRow[];
}

export function assertCommittedOrganizationMemberPolicyFactsMatch(
  database: Database.Database,
  identity: Identity,
  input: OrganizationMemberPolicyFactAppendInput,
): void {
  const expected = organizationMemberPolicyFactsForAppend(identity, input);
  if (
    organizationMemberPolicyFactSetSha256(
      readOrganizationMemberPolicyFactsAtPosition(database, identity.position),
    ) !== organizationMemberPolicyFactSetSha256(expected)
  ) {
    organizationMemberFactUnavailable('committed organization-member facts do not match reproved eligibility');
  }
}
