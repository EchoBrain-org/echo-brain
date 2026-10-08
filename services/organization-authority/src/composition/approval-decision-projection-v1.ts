import { canonicalJson, canonicalSha256, type JsonObject, type JsonValue, type Sha256Digest } from '@echo-brain/federation-protocol';
import {
  APPROVAL_DECISION_CONSEQUENCE_KIND_V1, APPROVAL_DECISION_FIELD_V1, APPROVAL_DECISION_PROVIDER_ACTION_KIND_V1, APPROVAL_DECISION_REF_KIND_V1,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, RESTRICTED_REVIEWER_PERSON_POLICY_ID, projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256, validateApprovalDecisionRecordInputV1, type ApprovalDecisionRecordInputV1,
} from '@echo-brain/organization-protocol';
import { validateApprovedDecisionSnapshotV2 } from '@echo-brain/organization-protocol/record-codec-support-v4';
import {
  projectApprovedMeetingPolicyFactsV1, type RecordApproverProjectorV1, type RecordPolicyFactEnvelopeV1, type RecordPolicyFactProjectorV1,
} from '@echo-brain/organization-record/organization-record-api-v1';
import type { ApprovalDecisionBodyV1, ApprovalDecisionRequestV1, ApprovalSurfaceV1 } from './approval-core-v1.js';

/** What authorized the decision. authorization_proof_sha256 = canonicalSha256(this). */
export interface ApprovalDecisionEvidenceWitnessV1 {
  readonly surface: ApprovalSurfaceV1; readonly organization_id: string; readonly principal_id: string; readonly membership_id: string;
  readonly kind: 'person-session' | 'slack-click'; readonly sha256: Sha256Digest;
}
/** The decision's audit entry. audit_entry_sha256 = canonicalSha256(this). */
export interface ApprovalDecisionAuditWitnessV1 {
  readonly approval_id: string; readonly event_id: string; readonly sequence: number;
  readonly action_sha256: Sha256Digest; readonly authorization_sha256: Sha256Digest; readonly approved_at: string;
}
/**
 * The append witness: the stored decision row, re-expressed. Never stored; the record carries its three digests.
 * `decision` is body.request verbatim (7 keys); provider_action_sha256 = canonicalSha256(decision). Task 12's Slack decisions produce
 * the same shape.
 */
export interface ApprovalDecisionWitnessV1 {
  readonly decision: ApprovalDecisionRequestV1; readonly evidence: ApprovalDecisionEvidenceWitnessV1; readonly audit: ApprovalDecisionAuditWitnessV1;
}

/** Pure. sequence = authority_approval_decisions_v1.sequence, body = the parsed body_json. */
export function approvalDecisionWitnessV1(decision: { readonly sequence: number; readonly body: ApprovalDecisionBodyV1 }): ApprovalDecisionWitnessV1 {
  const { body, sequence } = decision, r = body.request;
  const request: ApprovalDecisionRequestV1 = Object.freeze({ approval_id: r.approval_id, command_id: r.command_id, snapshot_sha256: r.snapshot_sha256, action: r.action,
    project_ids: Object.freeze([...r.project_ids]), share_transcript: r.share_transcript,
    owners: Object.freeze(r.owners.map(o => Object.freeze({ signal_id: o.signal_id, owner: o.owner }))) });
  const evidence: ApprovalDecisionEvidenceWitnessV1 = Object.freeze({ surface: body.surface, organization_id: body.actor.organization_id, principal_id: body.actor.principal_id,
    membership_id: body.actor.membership_id, kind: body.evidence.kind, sha256: body.evidence.sha256 });
  const audit: ApprovalDecisionAuditWitnessV1 = Object.freeze({ approval_id: r.approval_id, event_id: `audit:${r.command_id}`, sequence,
    action_sha256: canonicalSha256(request as unknown as JsonValue), authorization_sha256: canonicalSha256(evidence as unknown as JsonValue), approved_at: body.decided_at });
  return Object.freeze({ decision: request, evidence, audit });
}

export interface ApprovalDecisionRecordSourceV1 {
  readonly coordinates: { readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string };
  readonly decision: { readonly sequence: number; readonly body: ApprovalDecisionBodyV1 };
  /** frozen.candidate_semantic_sha256 */
  readonly candidate_sha256: Sha256Digest;
  /** frozen.approved_snapshot (validated here) */
  readonly approved_snapshot: unknown;
}
export interface BuiltApprovalDecisionRecordV1 {
  readonly human_act_record_input: ApprovalDecisionRecordInputV1;
  readonly semantic_idempotency_key: Sha256Digest;
  readonly authorization_witness: ApprovalDecisionWitnessV1;
}
/**
 * Pure and deterministic: no clock, no randomness, no I/O. It reads only the immutable decision row (including its frozen
 * transcript_source) and the decided-final frozen proposal, so every retry rebuilds identical bytes and the append returns
 * `duplicate`. The publisher and the test fixture both use it.
 */
export function buildApprovalDecisionRecordV1(source: ApprovalDecisionRecordSourceV1): BuiltApprovalDecisionRecordV1 {
  const { body } = source.decision;
  if (body.request.action !== 'approve') throw new Error('Only an approval writes a record');
  if (body.transcript_source === null || body.transcript_source === undefined || typeof body.transcript_source !== 'object') {
    throw new Error('Approval decision has no frozen transcript source');
  }
  const snapshot = validateApprovedDecisionSnapshotV2(source.approved_snapshot);
  const approved_snapshot_sha256 = canonicalSha256(snapshot as unknown as JsonValue);
  if (approved_snapshot_sha256 !== body.request.snapshot_sha256) throw new Error('Approval decision names another frozen snapshot');
  const ids = [...body.request.project_ids];
  const policy_id = ids.length === 0 ? RESTRICTED_REVIEWER_PERSON_POLICY_ID : PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
  const policy_contract_sha256 = ids.length === 0 ? restrictedReviewerPersonPolicyContractSha256() : projectMembersReadablePersonPolicyContractSha256();
  const consequence = { schema_version: 2 as const, kind: APPROVAL_DECISION_CONSEQUENCE_KIND_V1, policy_id,
    audience_project_ids: ids, association_project_ids: ids, share_transcript: body.request.share_transcript, transcript_source: body.transcript_source };
  const policy_consequence_sha256 = canonicalSha256(consequence as unknown as JsonValue);
  const witness = approvalDecisionWitnessV1(source.decision);
  const ref = { schema_version: 1, kind: APPROVAL_DECISION_REF_KIND_V1, ...source.coordinates,
    approval_id: body.request.approval_id, command_id: body.request.command_id, action: 'approve', surface: body.surface,
    candidate_sha256: source.candidate_sha256, approved_snapshot_sha256,
    final_approver: { principal_id: body.actor.principal_id, membership_id: body.actor.membership_id },
    selected_policy_id: policy_id, policy_contract_sha256, policy_consequence_sha256, audience_project_ids: ids, association_project_ids: ids,
    share_transcript: consequence.share_transcript, transcript_source: consequence.transcript_source, action_owners: witness.decision.owners,
    audit_event_id: witness.audit.event_id, audit_sequence: witness.audit.sequence, audit_entry_sha256: canonicalSha256(witness.audit as unknown as JsonValue),
    provider_action_kind: APPROVAL_DECISION_PROVIDER_ACTION_KIND_V1, provider_action_schema_version: 1,
    provider_action_sha256: witness.audit.action_sha256, authorization_proof_sha256: witness.audit.authorization_sha256, approved_at: body.decided_at };
  const event = { kind: 'approved', approved_snapshot: snapshot, approved_snapshot_sha256, policy_id, policy_contract_sha256, policy_consequence: consequence, policy_consequence_sha256 };
  const v = validateApprovalDecisionRecordInputV1({ [APPROVAL_DECISION_FIELD_V1]: ref, event });
  return Object.freeze({ human_act_record_input: Object.freeze({ approval_decision_ref_v1: v.approval_decision_ref_v1, event: v.event }),
    semantic_idempotency_key: v.semantic_idempotency_key, authorization_witness: witness });
}

function parse(envelope: { readonly body: { readonly human_act_resolution_ref: unknown; readonly event: unknown } }) {
  return validateApprovalDecisionRecordInputV1({ [APPROVAL_DECISION_FIELD_V1]: envelope.body.human_act_resolution_ref, event: envelope.body.event });
}
const keysAre = (value: unknown, expected: string): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === expected;
const same = (a: unknown, b: unknown) => canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue);
function refuse(): never { throw new Error('Approval decision witness differs from its record'); }

/**
 * Re-checks at append time that the record says exactly what the stored, authorized decision chose.
 * The decision and its audit are committed in authority_approval_decisions_v1 before this witness is used.
 */
export function createApprovalDecisionPolicyProjectorV1(): RecordPolicyFactProjectorV1 {
  return Object.freeze({
    id: APPROVAL_DECISION_REF_KIND_V1,
    matches: (envelope: RecordPolicyFactEnvelopeV1) => {
      const ref = envelope.body.human_act_resolution_ref as { kind?: unknown; schema_version?: unknown };
      return ref.kind === APPROVAL_DECISION_REF_KIND_V1 && ref.schema_version === 1;
    },
    policyBinding(envelope: RecordPolicyFactEnvelopeV1) {
      const { event } = parse(envelope);
      return { policy_id: event.policy_id, policy_contract_sha256: event.policy_contract_sha256 };
    },
    project(input: Parameters<RecordPolicyFactProjectorV1['project']>[0]) {
      const parsed = parse(input.envelope), ref = parsed.approval_decision_ref_v1, body = input.envelope.body;
      if (ref.authority_id !== body.authority_id || ref.organization_id !== body.organization_id || ref.state_lineage_id !== body.state_lineage_id) refuse();
      const w = input.witness;
      if (!keysAre(w, 'audit,decision,evidence')) refuse();
      const d = w.decision, e = w.evidence, a = w.audit;
      // (a) the human choice equals the record, and the policy follows the choice
      if (!keysAre(d, 'action,approval_id,command_id,owners,project_ids,share_transcript,snapshot_sha256')
        || d.approval_id !== ref.approval_id || d.command_id !== ref.command_id || d.action !== 'approve' || d.snapshot_sha256 !== ref.approved_snapshot_sha256
        || d.share_transcript !== ref.share_transcript || !Array.isArray(d.project_ids) || !same(d.project_ids, ref.audience_project_ids) || !same(d.owners, ref.action_owners)
        || ref.selected_policy_id !== (d.project_ids.length === 0 ? RESTRICTED_REVIEWER_PERSON_POLICY_ID : PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID)) refuse();
      // (b) the authorized actor is the record's final approver in this organization, on this surface
      if (!keysAre(e, 'kind,membership_id,organization_id,principal_id,sha256,surface')
        || e.surface !== ref.surface || e.kind !== (ref.surface === 'desktop' ? 'person-session' : 'slack-click')
        || typeof e.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(e.sha256)
        || e.organization_id !== ref.organization_id || e.principal_id !== ref.final_approver.principal_id || e.membership_id !== ref.final_approver.membership_id) refuse();
      // (c) the audit entry is this decision's
      if (!keysAre(a, 'action_sha256,approval_id,approved_at,authorization_sha256,event_id,sequence')
        || a.approval_id !== ref.approval_id || a.event_id !== ref.audit_event_id || a.sequence !== ref.audit_sequence
        || a.action_sha256 !== ref.provider_action_sha256 || a.authorization_sha256 !== ref.authorization_proof_sha256 || a.approved_at !== ref.approved_at) refuse();
      // (d) the three digests bind the witness to the signed reference
      if (canonicalSha256(d as JsonValue) !== ref.provider_action_sha256 || canonicalSha256(e as JsonValue) !== ref.authorization_proof_sha256
        || canonicalSha256(a as JsonValue) !== ref.audit_entry_sha256) refuse();
      return projectApprovedMeetingPolicyFactsV1({ ...input, event: parsed.event, reference: ref });
    },
  });
}

/** Derived identity only (display and "mine"); any parse failure or coordinate mismatch omits it. */
export const projectApprovalDecisionApproverV1: RecordApproverProjectorV1 = (envelope: JsonObject) => {
  try {
    const body = envelope.body as JsonObject;
    const ref = parse({ body: body as never }).approval_decision_ref_v1;
    if (ref.authority_id !== body.authority_id || ref.organization_id !== body.organization_id || ref.state_lineage_id !== body.state_lineage_id) return undefined;
    return { authority_id: ref.authority_id, organization_id: ref.organization_id, state_lineage_id: ref.state_lineage_id, approval_id: ref.approval_id,
      principal_id: ref.final_approver.principal_id, membership_id: ref.final_approver.membership_id };
  } catch { return undefined; }
};
