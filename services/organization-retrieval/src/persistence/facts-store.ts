import type { RetrievalPermissionFact } from '../application/contracts.js';
import { READABLE_SEARCH_FACTS_DATABASE } from './database-definition.js';
import { openReadableSearchPlane } from './open-plane.js';
import { ReadableSearchPlaneStore } from './plane-store.js';

export class ReadableSearchFactsStore extends ReadableSearchPlaneStore {
  private constructor(path: string) {
    super(openReadableSearchPlane(path, READABLE_SEARCH_FACTS_DATABASE), 'facts');
  }

  static open(path: string): ReadableSearchFactsStore {
    return new ReadableSearchFactsStore(path);
  }

  insert(fact: RetrievalPermissionFact): void {
    this.database.prepare(
      `INSERT INTO retrieval_permission_fact (
        atom_id, organization_id, envelope_sha256, log_position, record_hash, atom_order,
        signal_id_sha256, item_kind, policy_id, policy_contract_sha256,
        approval_actor_principal_id, approval_actor_membership_id, reviewer_principal_id,
        reviewer_membership_id, release_draft_sha256, approval_presentation_sha256,
        semantic_intent_sha256, message_presentation_sha256, authorization_audit_event_id,
        authorization_audit_entry_sha256, evaluated_at, authorization_proof_sha256,
        content_binding_sha256, provenance_binding_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fact.atom_id, fact.organization_id, fact.envelope_sha256, fact.log_position, fact.record_hash,
      fact.atom_order, fact.signal_id_sha256, fact.item_kind, fact.policy_id,
      fact.policy_contract_sha256, fact.approval_actor_principal_id,
      fact.approval_actor_membership_id, fact.reviewer_principal_id, fact.reviewer_membership_id,
      fact.release_draft_sha256, fact.approval_presentation_sha256, fact.semantic_intent_sha256,
      fact.message_presentation_sha256, fact.authorization_audit_event_id,
      fact.authorization_audit_entry_sha256, fact.evaluated_at, fact.authorization_proof_sha256,
      fact.content_binding_sha256, fact.provenance_binding_sha256,
    );
  }

  rows(): readonly RetrievalPermissionFact[] {
    return this.database.prepare(
      'SELECT * FROM retrieval_permission_fact ORDER BY log_position, atom_order, atom_id',
    ).all() as RetrievalPermissionFact[];
  }
}
