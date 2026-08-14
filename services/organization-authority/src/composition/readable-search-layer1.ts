import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  validateReadableSearchRetrievalPermissionFact,
  type ReadableSearchAdmittedAtom,
  type ReadableSearchUpstreamInputRootPreimageV1,
} from '@echo-brain/organization-retrieval/build';
import type {
  createOrganizationRecordRetrievalBuildPort,
  RetrievalBuildBatch,
} from '@echo-brain/organization-record/retrieval-build';
import { reviewerPolicyContractSha256 } from '../application/reviewer-policy-contract.js';

// Retrieval owns this value codec. Authority uses it only to close the DTO it
// hands across that boundary; both sides still recompute binding digests.

/**
 * Materializes the dense, text-free Layer 1 root from the exact fact objects
 * that will be handed to the builder. The record package provides only its
 * canonical row disposition; this bridge validates the one-to-one join so no
 * raw family-specific fact can drift from the builder shape.
 */
export function readableSearchUpstreamInputRoot(input: {
  readonly organization_id: string;
  readonly batch: RetrievalBuildBatch;
  readonly atoms: readonly ReadableSearchAdmittedAtom[];
}): Readonly<{
  preimage: ReadableSearchUpstreamInputRootPreimageV1;
  upstream_input_root: `sha256:${string}`;
}> {
  const rowsAreDense = input.batch.row_classifications.every(
    (row, index) => row.log_position === index + 1,
  );
  const lastRow = input.batch.row_classifications.at(-1);
  if (
    !rowsAreDense ||
    input.batch.record_head.position !== input.batch.row_classifications.length ||
    (lastRow === undefined
      ? input.batch.record_head.record_hash !== null
      : lastRow.record_hash !== input.batch.record_head.record_hash)
  ) {
    throw new Error('Layer 1 row classifications do not densely cover the record head');
  }
  const used = new Set<ReadableSearchAdmittedAtom['fact']>();
  const rows = input.batch.row_classifications.map((row) => {
    const items = input.atoms
      .map((atom, index) =>
        validateReadableSearchRetrievalPermissionFact(
          atom.fact,
          `Layer 1 retrieval fact ${index}`,
        ),
      )
      .filter((fact) => fact.log_position === row.log_position)
      .sort((left, right) => left.atom_order - right.atom_order);
    if (row.classification === 'legacy-schema-v1-excluded') {
      if (items.length !== 0) {
        throw new Error(`legacy Layer 1 row ${row.log_position} has retrieval facts`);
      }
    } else {
      const policy = row.classification === 'restricted-reviewer-v2-admitted'
        ? 'restricted-reviewer-v1'
        : 'organization-member-readable-v1';
      for (const [index, fact] of items.entries()) {
        if (
          fact.organization_id !== input.organization_id ||
          fact.policy_id !== policy ||
          fact.record_hash !== row.record_hash ||
          fact.envelope_sha256 !== row.envelope_sha256 ||
          fact.log_position !== row.log_position ||
          fact.atom_order !== index
        ) {
          throw new Error(`Layer 1 row ${row.log_position} does not bind exact retrieval facts`);
        }
      }
    }
    for (const fact of items) used.add(fact);
    return Object.freeze({
      classification: row.classification,
      log_position: row.log_position,
      record_hash: row.record_hash,
      envelope_sha256: row.envelope_sha256,
      items: Object.freeze(items),
    });
  });
  if (used.size !== input.atoms.length) {
    throw new Error('Layer 1 retrieval facts have no dense row classification');
  }
  const preimage: ReadableSearchUpstreamInputRootPreimageV1 = Object.freeze({
    schema_version: 1,
    kind: 'readable-search-upstream-input-root-v1',
    organization_id: input.organization_id,
    input_contract_version: 1,
    record_head: input.batch.record_head,
    rows: Object.freeze(rows),
  });
  return Object.freeze({ preimage, upstream_input_root: canonicalSha256(preimage) });
}

/**
 * Produces text-bearing builder atoms plus the independent dense text-free
 * Layer 1 root. Each atom reuses the same fact object committed into the root.
 */
export function readableSearchCanonicalInput(
  organizationId: string,
  batch: ReturnType<ReturnType<typeof createOrganizationRecordRetrievalBuildPort>['readAt']>,
): Readonly<{
  atoms: readonly ReadableSearchAdmittedAtom[];
  upstream_input_root: `sha256:${string}`;
  upstream_input_preimage: ReadableSearchUpstreamInputRootPreimageV1;
}> {
  const reviewerContract = reviewerPolicyContractSha256();
  const reviewer = batch.reviewer_items.map((item) => Object.freeze({
    fact: Object.freeze({
      atom_id: item.atom_id, organization_id: organizationId,
      envelope_sha256: item.envelope_sha256, log_position: item.log_position,
      record_hash: item.record_hash, atom_order: item.atom_order,
      signal_id_sha256: item.signal_id_sha256, item_kind: item.item_kind,
      policy_id: item.policy_id, policy_contract_sha256: reviewerContract,
      approval_actor_principal_id: item.provenance.reviewer_principal_id,
      approval_actor_membership_id: item.provenance.reviewer_membership_id,
      reviewer_principal_id: item.provenance.reviewer_principal_id,
      reviewer_membership_id: item.provenance.reviewer_membership_id,
      release_draft_sha256: item.release_draft_sha256,
      approval_presentation_sha256: item.approval_presentation_sha256,
      semantic_intent_sha256: item.provenance.semantic_intent_sha256,
      message_presentation_sha256: item.message_presentation_sha256,
      authorization_audit_event_id: item.provenance.authorization_audit_event_id,
      authorization_audit_entry_sha256: item.provenance.authorization_audit_entry_sha256,
      evaluated_at: item.evaluated_at,
      authorization_proof_sha256: item.provenance.authorization_proof_sha256,
      content_binding_sha256: item.content_binding_sha256,
      provenance_binding_sha256: item.provenance_binding_sha256,
    }), text: item.text, text_sha256: item.text_sha256,
  } satisfies ReadableSearchAdmittedAtom));
  const member = batch.organization_member_items.map((item) => Object.freeze({
    fact: Object.freeze({
      atom_id: item.atom_id, organization_id: item.provenance.organization_id,
      envelope_sha256: item.envelope_sha256, log_position: item.log_position,
      record_hash: item.record_hash, atom_order: item.atom_order,
      signal_id_sha256: item.signal_id_sha256, item_kind: item.item_kind,
      policy_id: item.policy_id, policy_contract_sha256: item.provenance.policy_contract_sha256,
      approval_actor_principal_id: item.provenance.approving_principal_id,
      approval_actor_membership_id: item.provenance.approving_membership_id,
      reviewer_principal_id: null, reviewer_membership_id: null,
      release_draft_sha256: item.provenance.release_draft_sha256,
      approval_presentation_sha256: item.provenance.approval_presentation_sha256,
      semantic_intent_sha256: item.provenance.semantic_intent_sha256,
      message_presentation_sha256: item.provenance.message_presentation_sha256,
      authorization_audit_event_id: item.provenance.authorization_audit_event_id,
      authorization_audit_entry_sha256: item.provenance.authorization_audit_entry_sha256,
      evaluated_at: item.provenance.evaluated_at,
      authorization_proof_sha256: item.provenance.authorization_proof_sha256,
      content_binding_sha256: item.provenance.content_binding_sha256,
      provenance_binding_sha256: item.provenance.provenance_binding_sha256,
    }), text: item.text, text_sha256: item.text_sha256,
  } satisfies ReadableSearchAdmittedAtom));
  const atoms = Object.freeze([...reviewer, ...member]);
  const root = readableSearchUpstreamInputRoot({
    organization_id: organizationId,
    batch,
    atoms,
  });
  return Object.freeze({
    atoms,
    upstream_input_root: root.upstream_input_root,
    upstream_input_preimage: root.preimage,
  });
}
