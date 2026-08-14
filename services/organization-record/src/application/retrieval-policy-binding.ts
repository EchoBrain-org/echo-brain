import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from './contracts.js';

type RetrievalItemKind = 'decision' | 'action' | 'rationale';

interface ContentBindingInput {
  readonly organization_id: string;
  readonly envelope_sha256: Sha256Digest;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly atom_id: Sha256Digest;
  readonly atom_order: number;
  readonly signal_id_sha256: Sha256Digest;
  readonly item_kind: RetrievalItemKind;
  readonly text_sha256: Sha256Digest;
}

/** Record-side owner of the exact family-neutral content commitment. */
export function organizationRecordItemContentBindingSha256(
  input: ContentBindingInput,
): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: 'organization-record-item-content-binding-v1',
    organization_id: input.organization_id,
    envelope_sha256: input.envelope_sha256,
    log_position: input.log_position,
    record_hash: input.record_hash,
    atom_id: input.atom_id,
    atom_order: input.atom_order,
    signal_id_sha256: input.signal_id_sha256,
    item_kind: input.item_kind,
    text_sha256: input.text_sha256,
  });
}

interface SharedProvenanceBindingInput {
  readonly organization_id: string;
  readonly envelope_sha256: Sha256Digest;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly policy_contract_sha256: Sha256Digest;
  readonly release_draft_sha256: Sha256Digest;
  readonly approval_presentation_sha256: Sha256Digest;
  readonly semantic_intent_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly evaluated_at: string;
}

/** Record-side owner of the member-v3 policy provenance commitment. */
export function organizationRecordMemberProvenanceBindingSha256(
  input: SharedProvenanceBindingInput & {
    readonly approving_principal_id: string;
    readonly approving_membership_id: string;
  },
): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: 'organization-record-policy-provenance-binding-v1',
    organization_id: input.organization_id,
    envelope_sha256: input.envelope_sha256,
    log_position: input.log_position,
    record_hash: input.record_hash,
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256: input.policy_contract_sha256,
    approving_principal_id: input.approving_principal_id,
    approving_membership_id: input.approving_membership_id,
    release_draft_sha256: input.release_draft_sha256,
    approval_presentation_sha256: input.approval_presentation_sha256,
    semantic_intent_sha256: input.semantic_intent_sha256,
    message_presentation_sha256: input.message_presentation_sha256,
    authorization_audit_event_id: input.authorization_audit_event_id,
    authorization_audit_entry_sha256:
      input.authorization_audit_entry_sha256,
    authorization_proof_sha256: input.authorization_proof_sha256,
    evaluated_at: input.evaluated_at,
  });
}

/** Record-side owner of the reviewer-v2 policy provenance commitment. */
export function organizationRecordReviewerProvenanceBindingSha256(
  input: SharedProvenanceBindingInput & {
    readonly reviewer_principal_id: string;
    readonly reviewer_membership_id: string;
  },
): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: 'organization-record-policy-provenance-binding-v1',
    organization_id: input.organization_id,
    envelope_sha256: input.envelope_sha256,
    log_position: input.log_position,
    record_hash: input.record_hash,
    policy_id: 'restricted-reviewer-v1',
    policy_contract_sha256: input.policy_contract_sha256,
    reviewer_principal_id: input.reviewer_principal_id,
    reviewer_membership_id: input.reviewer_membership_id,
    release_draft_sha256: input.release_draft_sha256,
    approval_presentation_sha256: input.approval_presentation_sha256,
    semantic_intent_sha256: input.semantic_intent_sha256,
    message_presentation_sha256: input.message_presentation_sha256,
    authorization_audit_event_id: input.authorization_audit_event_id,
    authorization_audit_entry_sha256:
      input.authorization_audit_entry_sha256,
    authorization_proof_sha256: input.authorization_proof_sha256,
    evaluated_at: input.evaluated_at,
  });
}
