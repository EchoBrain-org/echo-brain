import { sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
import { derivedAtomIdentity } from './atom-identity.js';
import { PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, type PersonPolicyFactItemKindV2, type PersonPolicyFactProjectionV2, type PersonPolicyFactRowV2, type PersonPolicyIdV2 } from './person-policy-fact-contracts-v2.js';
import type { RecordPolicyFactEnvelopeV1, RecordPolicyFactResolutionRefV1 } from './record-policy-fact-projection-v1.js';
function fail(detail: string): never { throw new Error('Approved meeting policy projection: ' + detail); }
function object(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object'); return value as Record<string, unknown>; }
function text(value: unknown, label: string): string { if (typeof value !== 'string' || value.length === 0) fail(label + ' must be text'); return value; }
function signals(event: unknown): readonly { readonly id: string; readonly kind: PersonPolicyFactItemKindV2 }[] {
  const approved = object(event, "event"); const snapshot = object(approved.approved_snapshot, "snapshot"); const payload = object(snapshot.approved_payload, "payload"); const brief = object(payload.brief, "brief"); const result: { id: string; kind: PersonPolicyFactItemKindV2 }[] = []; const seen = new Set<string>();
  for (const [field, kind] of [["decisions", "decision"], ["actions", "action"], ["rationales", "rationale"]] as const) {
    const items = brief[field]; if (!Array.isArray(items)) fail(`brief ${field} must be an array`);
    for (const item of items) { const signal = object(item, `brief ${field} signal`); const id = text(signal.id, `brief ${field} signal id`); if (signal.kind !== kind || seen.has(id)) fail("brief signal is invalid"); seen.add(id); result.push({ id, kind }); }
  }
  return Object.freeze(result);
}

/** The selecting codec and surface witness must already be verified before deriving policy facts. */
export function projectApprovedMeetingPolicyFactsV1(input: {
  readonly envelope: RecordPolicyFactEnvelopeV1; readonly record_position: number; readonly event: unknown;
  readonly reference: RecordPolicyFactResolutionRefV1 & {
    readonly selected_policy_id: PersonPolicyIdV2; readonly policy_contract_sha256: Sha256Digest;
    readonly final_approver: { readonly principal_id: string; readonly membership_id: string };
  };
}): PersonPolicyFactProjectionV2 {
  if (!Number.isSafeInteger(input.record_position) || input.record_position < 1) fail('record position is invalid');
  const ref = input.reference;
  const facts: PersonPolicyFactRowV2[] = signals(input.event).map((signal, atom_order) => {
    const common = { authority_id: ref.authority_id, organization_id: ref.organization_id, state_lineage_id: ref.state_lineage_id, approval_id: ref.approval_id, action: "approve" as const, policy_id: ref.selected_policy_id!, policy_contract_sha256: ref.policy_contract_sha256!, record_position: input.record_position, record_sha256: input.envelope.record_sha256, atom_order, signal_id_sha256: sha256Digest(signal.id), atom_id: derivedAtomIdentity(input.envelope.record_sha256, signal.id), item_kind: signal.kind, audit_event_id: ref.audit_event_id, audit_sequence: ref.audit_sequence, audit_entry_sha256: ref.audit_entry_sha256, provider_action_sha256: ref.provider_action_sha256, authorization_proof_sha256: ref.authorization_proof_sha256 };
    if (ref.selected_policy_id === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID) return Object.freeze({ ...common, policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID });
    if (ref.selected_policy_id === "restricted-reviewer-person-v2") return Object.freeze({ ...common, policy_id: ref.selected_policy_id, reviewer_principal_id: ref.final_approver.principal_id, reviewer_membership_id: ref.final_approver.membership_id });
    return Object.freeze({ ...common, policy_id: "organization-member-readable-person-v2" as const });
  });
  return Object.freeze({ facts: Object.freeze(facts), policy_fact_outcome: Object.freeze({ kind: "appended", policy_id: ref.selected_policy_id! }) });
}
