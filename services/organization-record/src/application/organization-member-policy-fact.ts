import {
  canonicalSha256,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import type { JsonObject, Sha256Digest } from './contracts.js';
import { derivedAtomIdentity } from './atom-identity.js';
import {
  organizationRecordItemContentBindingSha256,
  organizationRecordMemberProvenanceBindingSha256,
} from './retrieval-policy-binding.js';

/**
 * The organization-member-readable v3 fact plane.  This is deliberately a
 * sibling of reviewer facts, not a generic policy interpreter: protocol owns
 * the durable v3 grammar and supplies the one closed validator below.
 */
export const ORGANIZATION_MEMBER_READABLE_POLICY_ID =
  'organization-member-readable-v1' as const;
export const ORGANIZATION_MEMBER_READABLE_ALLOW_REASON_CODE =
  'active_organization_member_readable_notice_v1' as const;
export const ORGANIZATION_MEMBER_READABLE_ENVELOPE_KIND =
  'echo-organization-record-envelope' as const;
export const ORGANIZATION_MEMBER_READABLE_ENVELOPE_SCHEMA_VERSION = 3 as const;
export const ORGANIZATION_MEMBER_READABLE_ELIGIBILITY_PROOF_KIND =
  'echo-organization-member-readable-eligibility-proof' as const;
export const MAX_ORGANIZATION_MEMBER_POLICY_FACTS = 10;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ORGANIZATION_ID = /^org_[\w.-]{1,128}$/;
const AUTHORITY_ID = /^oau_[\w.-]{1,128}$/;
const ENVELOPE_ID = /^rec_[\w.-]{1,128}$/;
const INSTALLATION_ID = /^ins_[\w.-]{1,128}$/;
const PRINCIPAL_ID = /^prn_[\w.-]{1,128}$/;
const MEMBERSHIP_ID = /^mem_[\w.-]{1,128}$/;
const AUDIT_EVENT_ID = /^aud_[\w.-]{1,128}$/;
const RELEASE_ITEM_KINDS = ['decision', 'action', 'rationale'] as const;
export type OrganizationMemberReadableReleaseItemKind =
  (typeof RELEASE_ITEM_KINDS)[number];

export class OrganizationMemberPolicyFactError extends Error {
  constructor(
    readonly code: 'invalid' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'OrganizationMemberPolicyFactError';
  }
}

export function organizationMemberFactInvalid(message: string): never {
  throw new OrganizationMemberPolicyFactError('invalid', message);
}

export function organizationMemberFactUnavailable(message: string): never {
  throw new OrganizationMemberPolicyFactError('unavailable', message);
}

function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    organizationMemberFactInvalid(`${label} must be a canonical sha256 digest`);
  }
  return value as Sha256Digest;
}

function field(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    organizationMemberFactInvalid(`${label} is invalid`);
  }
  return value;
}

export interface OrganizationMemberReadableEnvelopeView {
  readonly schema_version: 3;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly installation_id: string;
  readonly approving_principal_id: string;
  readonly approving_membership_id: string;
  readonly policy_contract_sha256: Sha256Digest;
  readonly release_draft_sha256: Sha256Digest;
  readonly approval_presentation_sha256: Sha256Digest;
  readonly semantic_intent_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly evaluated_at: string;
  readonly signals: readonly {
    readonly id: string;
    readonly kind: OrganizationMemberReadableReleaseItemKind;
    readonly text: string;
  }[];
}

/** The Authority-composed adapter from protocol validation to this pure view. */
export type OrganizationMemberReadableEnvelopeValidator = (
  envelope: JsonObject,
) => OrganizationMemberReadableEnvelopeView;

export function isOrganizationMemberReadableEnvelopeDocument(
  envelope: unknown,
): boolean {
  return (
    typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope) &&
    (envelope as Record<string, unknown>)['kind'] ===
      ORGANIZATION_MEMBER_READABLE_ENVELOPE_KIND &&
    (envelope as Record<string, unknown>)['schema_version'] ===
      ORGANIZATION_MEMBER_READABLE_ENVELOPE_SCHEMA_VERSION
  );
}

function assertView(value: unknown): OrganizationMemberReadableEnvelopeView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    organizationMemberFactInvalid('organization-member envelope view must be an object');
  }
  const view = value as Record<string, unknown>;
  if (view['schema_version'] !== 3) {
    organizationMemberFactInvalid('organization-member envelope view is not schema version 3');
  }
  const signals = view['signals'];
  if (!Array.isArray(signals) || signals.length < 1 || signals.length > MAX_ORGANIZATION_MEMBER_POLICY_FACTS) {
    organizationMemberFactInvalid('organization-member envelope must release 1 to 10 signals');
  }
  const released = signals.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      organizationMemberFactInvalid('organization-member released signal is invalid');
    }
    const signal = value as Record<string, unknown>;
    if (
      typeof signal['id'] !== 'string' || signal['id'].length === 0 ||
      typeof signal['text'] !== 'string' || signal['text'].length === 0 ||
      typeof signal['kind'] !== 'string' ||
      !(RELEASE_ITEM_KINDS as readonly string[]).includes(signal['kind'])
    ) {
      organizationMemberFactInvalid('organization-member released signal is invalid');
    }
    return Object.freeze({
      id: signal['id'],
      kind: signal['kind'] as OrganizationMemberReadableReleaseItemKind,
      text: signal['text'],
    });
  });
  if (new Set(released.map((signal) => signal.id)).size !== released.length) {
    organizationMemberFactInvalid('organization-member signal ids must be unique');
  }
  return Object.freeze({
    schema_version: 3,
    authority_id: field(view['authority_id'], AUTHORITY_ID, 'organization-member authority_id'),
    organization_id: field(view['organization_id'], ORGANIZATION_ID, 'organization-member organization_id'),
    envelope_id: field(view['envelope_id'], ENVELOPE_ID, 'organization-member envelope_id'),
    idempotency_key: field(view['idempotency_key'], /^[0-9a-f]{64}$/, 'organization-member idempotency_key'),
    installation_id: field(view['installation_id'], INSTALLATION_ID, 'organization-member installation_id'),
    approving_principal_id: field(view['approving_principal_id'], PRINCIPAL_ID, 'organization-member approving_principal_id'),
    approving_membership_id: field(view['approving_membership_id'], MEMBERSHIP_ID, 'organization-member approving_membership_id'),
    policy_contract_sha256: digest(view['policy_contract_sha256'], 'organization-member policy_contract_sha256'),
    release_draft_sha256: digest(view['release_draft_sha256'], 'organization-member release_draft_sha256'),
    approval_presentation_sha256: digest(view['approval_presentation_sha256'], 'organization-member approval_presentation_sha256'),
    semantic_intent_sha256: digest(view['semantic_intent_sha256'], 'organization-member semantic_intent_sha256'),
    message_presentation_sha256: digest(view['message_presentation_sha256'], 'organization-member message_presentation_sha256'),
    authorization_audit_event_id: field(view['authorization_audit_event_id'], AUDIT_EVENT_ID, 'organization-member authorization_audit_event_id'),
    authorization_audit_entry_sha256: digest(view['authorization_audit_entry_sha256'], 'organization-member authorization_audit_entry_sha256'),
    evaluated_at: field(view['evaluated_at'], TIMESTAMP, 'organization-member evaluated_at'),
    signals: Object.freeze(released),
  });
}

export function readOrganizationMemberReadableEnvelope(
  envelope: JsonObject,
  validate: OrganizationMemberReadableEnvelopeValidator | undefined,
): OrganizationMemberReadableEnvelopeView {
  if (!isOrganizationMemberReadableEnvelopeDocument(envelope)) {
    organizationMemberFactInvalid('organization-member envelope kind or schema version is unsupported');
  }
  if (typeof validate !== 'function') {
    organizationMemberFactUnavailable('schema-v3 handling requires the injected closed organization-member validator');
  }
  try {
    return assertView(validate(envelope));
  } catch (error) {
    if (error instanceof OrganizationMemberPolicyFactError) throw error;
    organizationMemberFactInvalid(
      `organization-member envelope failed closed schema-v3 validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface OrganizationMemberReadableEligibilityProofPreimage {
  readonly organization_id: string;
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly installation_id: string;
  readonly canonical_envelope_sha256: Sha256Digest;
  readonly policy_contract_sha256: Sha256Digest;
  readonly approving_principal_id: string;
  readonly approving_membership_id: string;
  readonly release_draft_sha256: Sha256Digest;
  readonly approval_presentation_sha256: Sha256Digest;
  readonly semantic_intent_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly evaluated_at: string;
}

export function validateOrganizationMemberReadableEligibilityProofPreimage(
  proof: OrganizationMemberReadableEligibilityProofPreimage,
): OrganizationMemberReadableEligibilityProofPreimage {
  return Object.freeze({
    organization_id: field(proof.organization_id, ORGANIZATION_ID, 'organization-member eligibility organization_id'),
    envelope_id: field(proof.envelope_id, ENVELOPE_ID, 'organization-member eligibility envelope_id'),
    idempotency_key: field(proof.idempotency_key, /^[0-9a-f]{64}$/, 'organization-member eligibility idempotency_key'),
    installation_id: field(proof.installation_id, INSTALLATION_ID, 'organization-member eligibility installation_id'),
    canonical_envelope_sha256: digest(proof.canonical_envelope_sha256, 'organization-member eligibility canonical_envelope_sha256'),
    policy_contract_sha256: digest(proof.policy_contract_sha256, 'organization-member eligibility policy_contract_sha256'),
    approving_principal_id: field(proof.approving_principal_id, PRINCIPAL_ID, 'organization-member eligibility approving_principal_id'),
    approving_membership_id: field(proof.approving_membership_id, MEMBERSHIP_ID, 'organization-member eligibility approving_membership_id'),
    release_draft_sha256: digest(proof.release_draft_sha256, 'organization-member eligibility release_draft_sha256'),
    approval_presentation_sha256: digest(proof.approval_presentation_sha256, 'organization-member eligibility approval_presentation_sha256'),
    semantic_intent_sha256: digest(proof.semantic_intent_sha256, 'organization-member eligibility semantic_intent_sha256'),
    message_presentation_sha256: digest(proof.message_presentation_sha256, 'organization-member eligibility message_presentation_sha256'),
    authorization_audit_event_id: field(proof.authorization_audit_event_id, AUDIT_EVENT_ID, 'organization-member eligibility authorization_audit_event_id'),
    authorization_audit_entry_sha256: digest(proof.authorization_audit_entry_sha256, 'organization-member eligibility authorization_audit_entry_sha256'),
    evaluated_at: field(proof.evaluated_at, TIMESTAMP, 'organization-member eligibility evaluated_at'),
  });
}

export function organizationMemberReadableEligibilityProofSha256(
  proof: OrganizationMemberReadableEligibilityProofPreimage,
): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: ORGANIZATION_MEMBER_READABLE_ELIGIBILITY_PROOF_KIND,
    organization_id: proof.organization_id,
    envelope_id: proof.envelope_id,
    idempotency_key: proof.idempotency_key,
    installation_id: proof.installation_id,
    canonical_envelope_sha256: proof.canonical_envelope_sha256,
    policy_id: ORGANIZATION_MEMBER_READABLE_POLICY_ID,
    policy_contract_sha256: proof.policy_contract_sha256,
    approving_principal_id: proof.approving_principal_id,
    approving_membership_id: proof.approving_membership_id,
    release_draft_sha256: proof.release_draft_sha256,
    approval_presentation_sha256: proof.approval_presentation_sha256,
    semantic_intent_sha256: proof.semantic_intent_sha256,
    message_presentation_sha256: proof.message_presentation_sha256,
    authorization_audit_event_id: proof.authorization_audit_event_id,
    authorization_audit_entry_sha256: proof.authorization_audit_entry_sha256,
    evaluated_at: proof.evaluated_at,
  });
}

export function deriveOrganizationMemberReadableEligibilityProof(input: {
  readonly organization_id: string;
  readonly canonical_envelope_sha256: Sha256Digest;
  readonly envelope: OrganizationMemberReadableEnvelopeView;
}): { readonly preimage: OrganizationMemberReadableEligibilityProofPreimage; readonly authorization_proof_sha256: Sha256Digest } {
  const { envelope } = input;
  if (envelope.organization_id !== input.organization_id) {
    organizationMemberFactInvalid('organization-member envelope organization does not match this record log');
  }
  const preimage = validateOrganizationMemberReadableEligibilityProofPreimage({
    organization_id: field(input.organization_id, ORGANIZATION_ID, 'organization-member eligibility organization_id'),
    envelope_id: envelope.envelope_id,
    idempotency_key: envelope.idempotency_key,
    installation_id: envelope.installation_id,
    canonical_envelope_sha256: digest(input.canonical_envelope_sha256, 'organization-member eligibility canonical_envelope_sha256'),
    policy_contract_sha256: envelope.policy_contract_sha256,
    approving_principal_id: envelope.approving_principal_id,
    approving_membership_id: envelope.approving_membership_id,
    release_draft_sha256: envelope.release_draft_sha256,
    approval_presentation_sha256: envelope.approval_presentation_sha256,
    semantic_intent_sha256: envelope.semantic_intent_sha256,
    message_presentation_sha256: envelope.message_presentation_sha256,
    authorization_audit_event_id: envelope.authorization_audit_event_id,
    authorization_audit_entry_sha256: envelope.authorization_audit_entry_sha256,
    evaluated_at: envelope.evaluated_at,
  });
  return Object.freeze({
    preimage,
    authorization_proof_sha256: organizationMemberReadableEligibilityProofSha256(preimage),
  });
}

export interface OrganizationRecordOrganizationMemberPolicyFactRow {
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly organization_id: string;
  readonly envelope_sha256: Sha256Digest;
  readonly atom_order: number;
  readonly atom_id: Sha256Digest;
  readonly signal_id_sha256: Sha256Digest;
  readonly item_kind: OrganizationMemberReadableReleaseItemKind;
  readonly policy_id: typeof ORGANIZATION_MEMBER_READABLE_POLICY_ID;
  readonly policy_contract_sha256: Sha256Digest;
  readonly approving_principal_id: string;
  readonly approving_membership_id: string;
  readonly release_draft_sha256: Sha256Digest;
  readonly approval_presentation_sha256: Sha256Digest;
  readonly semantic_intent_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly evaluated_at: string;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly content_binding_sha256: Sha256Digest;
  readonly provenance_binding_sha256: Sha256Digest;
}

export function projectOrganizationMemberPolicyFacts(input: {
  readonly organization_id: string;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly envelope_sha256: Sha256Digest;
  readonly envelope: OrganizationMemberReadableEnvelopeView;
}): readonly OrganizationRecordOrganizationMemberPolicyFactRow[] {
  const proof = deriveOrganizationMemberReadableEligibilityProof({
    organization_id: input.organization_id,
    canonical_envelope_sha256: input.envelope_sha256,
    envelope: input.envelope,
  });
  const { envelope } = input;
  const provenanceBindingSha256 =
    organizationRecordMemberProvenanceBindingSha256({
      organization_id: input.organization_id,
      envelope_sha256: input.envelope_sha256,
      log_position: input.log_position,
      record_hash: input.record_hash,
      policy_contract_sha256: envelope.policy_contract_sha256,
      approving_principal_id: envelope.approving_principal_id,
      approving_membership_id: envelope.approving_membership_id,
      release_draft_sha256: envelope.release_draft_sha256,
      approval_presentation_sha256: envelope.approval_presentation_sha256,
      semantic_intent_sha256: envelope.semantic_intent_sha256,
      message_presentation_sha256: envelope.message_presentation_sha256,
      authorization_audit_event_id: envelope.authorization_audit_event_id,
      authorization_audit_entry_sha256:
        envelope.authorization_audit_entry_sha256,
      authorization_proof_sha256: proof.authorization_proof_sha256,
      evaluated_at: envelope.evaluated_at,
    });
  const rows = envelope.signals.map((signal, atom_order) => {
    const signal_id_sha256 = sha256Digest(signal.id);
    const atom_id = derivedAtomIdentity(input.record_hash, signal.id);
    return Object.freeze({
      log_position: input.log_position,
      record_hash: input.record_hash,
      organization_id: input.organization_id,
      envelope_sha256: input.envelope_sha256,
      atom_order,
      atom_id,
      signal_id_sha256,
      item_kind: signal.kind,
      policy_id: ORGANIZATION_MEMBER_READABLE_POLICY_ID,
      policy_contract_sha256: envelope.policy_contract_sha256,
      approving_principal_id: envelope.approving_principal_id,
      approving_membership_id: envelope.approving_membership_id,
      release_draft_sha256: envelope.release_draft_sha256,
      approval_presentation_sha256: envelope.approval_presentation_sha256,
      semantic_intent_sha256: envelope.semantic_intent_sha256,
      message_presentation_sha256: envelope.message_presentation_sha256,
      authorization_audit_event_id: envelope.authorization_audit_event_id,
      authorization_audit_entry_sha256: envelope.authorization_audit_entry_sha256,
      evaluated_at: envelope.evaluated_at,
      authorization_proof_sha256: proof.authorization_proof_sha256,
      content_binding_sha256: organizationRecordItemContentBindingSha256({
        organization_id: input.organization_id,
        envelope_sha256: input.envelope_sha256,
        log_position: input.log_position,
        record_hash: input.record_hash,
        atom_id,
        atom_order,
        signal_id_sha256,
        item_kind: signal.kind,
        text_sha256: sha256Digest(signal.text),
      }),
      provenance_binding_sha256: provenanceBindingSha256,
    });
  });
  if (new Set(rows.map((row) => row.atom_id)).size !== rows.length) {
    organizationMemberFactInvalid('organization-member fact identities must be unique within a record');
  }
  return Object.freeze(rows);
}

export function organizationMemberPolicyFactSetSha256(
  rows: readonly OrganizationRecordOrganizationMemberPolicyFactRow[],
): Sha256Digest {
  return canonicalSha256(rows);
}
