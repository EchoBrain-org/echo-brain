import { canonicalJson, canonicalSha256, type JsonObject, type JsonValue, type Sha256Digest } from '@echo-brain/federation-protocol';
import {
  APPROVAL_DECISION_CONSEQUENCE_KIND_V1, APPROVAL_DECISION_FIELD_V2, APPROVAL_DECISION_PROVIDER_ACTION_KIND_V2, APPROVAL_DECISION_REF_KIND_V2,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, RESTRICTED_REVIEWER_PERSON_POLICY_ID, approvalDecisionSubsetSnapshotV2, approvalRecordIdV2, isPrivateApprovalRecordV2,
  projectMembersReadablePersonPolicyContractSha256, restrictedReviewerPersonPolicyContractSha256, validateApprovalDecisionRecordInputV2,
  validateApprovedDecisionSnapshotV2, type ApprovalDecisionRecordInputV2, type ApprovalDecisionRefV2, type ApprovedDecisionSnapshotV2,
} from '@echo-brain/organization-protocol';
import {
  projectApprovedMeetingPolicyFactsV1, type RecordApproverProjectorV1, type RecordPolicyFactEnvelopeV1, type RecordPolicyFactProjectorV1,
} from '@echo-brain/organization-record/organization-record-api-v1';
import type { ApprovalDecisionBodyV1, ApprovalDecisionRequestV1, ApprovalRouteV1, ApprovalSurfaceV1 } from './approval-core-v1.js';

const keysAre = (value: unknown, expected: string): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === expected;
const same = (a: unknown, b: unknown) => canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue);
function refuse(): never { throw new Error('Approval decision witness differs from its record'); }

/** What authorized the decision. authorization_proof_sha256 = canonicalSha256(this). */
interface ApprovalDecisionEvidenceWitnessV1 {
  readonly surface: ApprovalSurfaceV1; readonly organization_id: string; readonly principal_id: string; readonly membership_id: string;
  readonly kind: 'person-session' | 'slack-click'; readonly sha256: Sha256Digest;
}
/** The decision's audit entry, keyed by the proposal it decided. audit_entry_sha256 = canonicalSha256(this). */
interface ApprovalDecisionAuditWitnessV1 {
  readonly approval_id: string; readonly event_id: string; readonly sequence: number;
  readonly action_sha256: Sha256Digest; readonly authorization_sha256: Sha256Digest; readonly approved_at: string;
}
/**
 * The append witness: the stored decision row, re-expressed, and the frozen snapshot it decided. Never stored (the record log
 * hands it to the policy projector only); each record carries the three digests of `decision`, `evidence` and `audit`, and
 * every record of one decision has the same witness. `decision` is body.request verbatim (6 keys); provider_action_sha256 =
 * canonicalSha256(decision). `proposal_snapshot` is what the reviewer saw; it enters none of those digests (the reference
 * names its own, proposal_snapshot_sha256), and the projector recomputes each record's subset from it. Slack decisions
 * produce the same shape.
 */
export interface ApprovalDecisionWitnessV1 {
  readonly decision: ApprovalDecisionRequestV1; readonly evidence: ApprovalDecisionEvidenceWitnessV1; readonly audit: ApprovalDecisionAuditWitnessV1;
  readonly proposal_snapshot: ApprovedDecisionSnapshotV2;
}

/**
 * Pure. sequence = authority_approval_decisions_v1.sequence, body = the parsed body_json, proposal_snapshot = the validated
 * frozen snapshot whose digest is body.request.snapshot_sha256 (the projector checks it). A route's `private` is copied as
 * stored, whatever its value, so the projector refuses any but `true` instead of reading it as shared.
 */
export function approvalDecisionWitnessV1(decision: { readonly sequence: number; readonly body: ApprovalDecisionBodyV1 },
  proposal_snapshot: ApprovedDecisionSnapshotV2): ApprovalDecisionWitnessV1 {
  const { body, sequence } = decision, r = body.request;
  const request: ApprovalDecisionRequestV1 = Object.freeze({ approval_id: r.approval_id, command_id: r.command_id, snapshot_sha256: r.snapshot_sha256, action: r.action,
    routes: Object.freeze(r.routes.map(route => Object.freeze({ signal_id: route.signal_id, project_ids: route.project_ids === null ? null : Object.freeze([...route.project_ids]),
      ...(Object.hasOwn(route, 'private') ? { private: route.private } : {}) }))),
    owners: Object.freeze(r.owners.map(o => Object.freeze({ signal_id: o.signal_id, owner: o.owner }))) });
  const evidence: ApprovalDecisionEvidenceWitnessV1 = Object.freeze({ surface: body.surface, organization_id: body.actor.organization_id, principal_id: body.actor.principal_id,
    membership_id: body.actor.membership_id, kind: body.evidence.kind, sha256: body.evidence.sha256 });
  const audit: ApprovalDecisionAuditWitnessV1 = Object.freeze({ approval_id: r.approval_id, event_id: `audit:${r.command_id}`, sequence,
    action_sha256: canonicalSha256(request as unknown as JsonValue), authorization_sha256: canonicalSha256(evidence as unknown as JsonValue), approved_at: body.decided_at });
  return Object.freeze({ decision: request, evidence, audit, proposal_snapshot });
}

/** One destination of a decision: the kept items routed to exactly one project set, kept private in it or not. */
interface ApprovalDecisionGroupV1 {
  /** The record's own approval id (approvalRecordIdV2). */
  readonly approval_id: string;
  /** [] = Only me. */
  readonly project_ids: readonly string[];
  /** Kept for the reviewer alone inside those projects (ADR-0049); absent otherwise. */
  readonly private?: true;
  /** On the first private group when the decision keeps nothing for Only me: it takes the reasons that support no item. */
  readonly unsupported_reasons?: true;
  /** Its decisions then actions, in brief order. */
  readonly signal_ids: readonly string[];
}
/**
 * Pure: the kept routes grouped by whether they are kept private and their exact project set, ordered by each group's first
 * item in the routes' (brief) order. The same projects shared and kept private are two groups, and two records. The reasons
 * that support no item go to the Only-me group; with none, the first private group takes them (`unsupported_reasons`), so
 * they land in one record. Throws on a route that says `private` other than as `true` beside a project: the Authority's
 * tables do not check it, and read any other way it would publish the item to the whole project.
 */
export function approvalDecisionGroupsV1(request: { readonly approval_id: string; readonly routes: readonly ApprovalRouteV1[] }): readonly ApprovalDecisionGroupV1[] {
  const groups = new Map<string, { readonly project_ids: readonly string[]; readonly private: boolean; readonly signal_ids: string[] }>();
  for (const route of request.routes) {
    if (Object.hasOwn(route, 'private') && (route.private !== true || route.project_ids === null || route.project_ids.length === 0)) {
      throw new Error('Approval decision route keeps an item private only as true, beside a project');
    }
    if (route.project_ids === null) continue;
    const kept = route.private === true;
    const key = canonicalJson({ private: kept, project_ids: [...route.project_ids] } as JsonValue);
    const group = groups.get(key) ?? { project_ids: Object.freeze([...route.project_ids]), private: kept, signal_ids: [] };
    group.signal_ids.push(route.signal_id);
    groups.set(key, group);
  }
  const all = [...groups.values()];
  const loose = all.some(group => group.project_ids.length === 0 && !group.private) ? undefined : all.find(group => group.private);
  return Object.freeze(all.map(group => Object.freeze({ approval_id: approvalRecordIdV2(request.approval_id, group.project_ids, group.private),
    project_ids: group.project_ids, ...(group.private ? { private: true as const } : {}), ...(group === loose ? { unsupported_reasons: true as const } : {}),
    signal_ids: Object.freeze(group.signal_ids) })));
}

interface ApprovalDecisionRecordSourceV1 {
  readonly coordinates: { readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string };
  readonly decision: { readonly sequence: number; readonly body: ApprovalDecisionBodyV1 };
  /** frozen.candidate_semantic_sha256 */
  readonly candidate_sha256: Sha256Digest;
  /** frozen.approved_snapshot (validated here) */
  readonly approved_snapshot: unknown;
}
export interface BuiltApprovalDecisionRecordV1 {
  /** The record's own approval id, which it is appended under. */
  readonly approval_id: string;
  readonly project_ids: readonly string[];
  /** Kept for the reviewer alone inside its projects; absent otherwise. */
  readonly private?: true;
  readonly human_act_record_input: ApprovalDecisionRecordInputV2;
  readonly semantic_idempotency_key: Sha256Digest;
  readonly authorization_witness: ApprovalDecisionWitnessV1;
}

/**
 * Pure and deterministic: no clock, no randomness, no I/O. It reads only the immutable decision row (which must hold its
 * frozen transcript_source) and the decided-final frozen proposal, so every retry rebuilds identical bytes and each append returns
 * `duplicate`. One record per destination group, in group order, each holding only its own items; every group is built and
 * checked (record codec and projector) before any is returned, so a publish never appends some groups of a decision it
 * cannot finish. The publisher and the test fixtures use it.
 */
export function buildApprovalDecisionRecordsV1(source: ApprovalDecisionRecordSourceV1): readonly BuiltApprovalDecisionRecordV1[] {
  const { body } = source.decision;
  if (body.request.action !== 'approve') throw new Error('Only an approval writes a record');
  if (body.transcript_source === null || body.transcript_source === undefined || typeof body.transcript_source !== 'object') {
    throw new Error('Approval decision has no frozen transcript source');
  }
  const snapshot = validateApprovedDecisionSnapshotV2(source.approved_snapshot);
  const proposal_snapshot_sha256 = canonicalSha256(snapshot as unknown as JsonValue);
  if (proposal_snapshot_sha256 !== body.request.snapshot_sha256) throw new Error('Approval decision names another frozen snapshot');
  const brief = snapshot.approved_payload.brief;
  if (!same(body.request.routes.map(route => route.signal_id), [...brief.decisions, ...brief.actions].map(signal => signal.id))) {
    throw new Error('Approval decision routes differ from its frozen snapshot');
  }
  const groups = approvalDecisionGroupsV1(body.request);
  if (groups.length === 0) throw new Error('Approval decision keeps nothing');
  const witness = approvalDecisionWitnessV1(source.decision, snapshot);
  return Object.freeze(groups.map(group => {
    // The one subset function, which the append projector also runs on the witness's proposal snapshot.
    const subset = approvalDecisionSubsetSnapshotV2(snapshot, group);
    const approved_snapshot_sha256 = canonicalSha256(subset as unknown as JsonValue);
    const ids = [...group.project_ids];
    // Projects are its audience unless it is kept for the reviewer alone: then they are only where it is filed (ADR-0049).
    const shared = ids.length > 0 && group.private !== true;
    const audience = shared ? ids : [];
    const policy_id = shared ? PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID : RESTRICTED_REVIEWER_PERSON_POLICY_ID;
    const policy_contract_sha256 = shared ? projectMembersReadablePersonPolicyContractSha256() : restrictedReviewerPersonPolicyContractSha256();
    const consequence = { schema_version: 2 as const, kind: APPROVAL_DECISION_CONSEQUENCE_KIND_V1, policy_id, audience_project_ids: audience, association_project_ids: ids };
    const policy_consequence_sha256 = canonicalSha256(consequence as unknown as JsonValue);
    const actions = new Set(subset.approved_payload.brief.actions.map(action => action.id));
    const ref = { schema_version: 2, kind: APPROVAL_DECISION_REF_KIND_V2, ...source.coordinates,
      approval_id: group.approval_id, proposal_approval_id: body.request.approval_id, command_id: body.request.command_id, action: 'approve', surface: body.surface,
      candidate_sha256: source.candidate_sha256, proposal_snapshot_sha256, approved_snapshot_sha256, route_signal_ids: [...group.signal_ids],
      final_approver: { principal_id: body.actor.principal_id, membership_id: body.actor.membership_id },
      selected_policy_id: policy_id, policy_contract_sha256, policy_consequence_sha256, audience_project_ids: audience, association_project_ids: ids,
      action_owners: witness.decision.owners.filter(owner => actions.has(owner.signal_id)),
      audit_event_id: witness.audit.event_id, audit_sequence: witness.audit.sequence, audit_entry_sha256: canonicalSha256(witness.audit as unknown as JsonValue),
      provider_action_kind: APPROVAL_DECISION_PROVIDER_ACTION_KIND_V2, provider_action_schema_version: 2,
      provider_action_sha256: witness.audit.action_sha256, authorization_proof_sha256: witness.audit.authorization_sha256, approved_at: body.decided_at };
    const event = { kind: 'approved', approved_snapshot: subset, approved_snapshot_sha256, policy_id, policy_contract_sha256, policy_consequence: consequence, policy_consequence_sha256 };
    const v = validateApprovalDecisionRecordInputV2({ [APPROVAL_DECISION_FIELD_V2]: ref, event });
    // The append projector refuses what it would refuse later, so a group it cannot accept fails here, before the first append.
    verifyApprovalDecisionWitnessV1(v, witness);
    return Object.freeze({ approval_id: group.approval_id, project_ids: Object.freeze(ids), ...(group.private === true ? { private: true as const } : {}),
      human_act_record_input: Object.freeze({ approval_decision_ref_v2: v.approval_decision_ref_v2, event: v.event }),
      semantic_idempotency_key: v.semantic_idempotency_key, authorization_witness: witness });
  }));
}

function parse(envelope: { readonly body: { readonly human_act_resolution_ref: unknown; readonly event: unknown } }) {
  return validateApprovalDecisionRecordInputV2({ [APPROVAL_DECISION_FIELD_V2]: envelope.body.human_act_resolution_ref, event: envelope.body.event });
}

/** A stored route: its signal and destination, and `private: true` when it was kept for the reviewer alone. */
const isRoute = (route: unknown): route is Record<string, unknown> =>
  keysAre(route, 'project_ids,signal_id') || (keysAre(route, 'private,project_ids,signal_id') && route.private === true);

/**
 * That a record is one destination group of the stored, authorized decision: the proposal, the snapshot its reviewer saw,
 * the record's derived id, the routes to its destination (its project set, kept private in it or not), the owners of its
 * actions and the policy its destination selects, the authorized actor, the audit entry, the three digests that bind the
 * witness to the signed reference, and the record's content: its group's subset of that snapshot, recomputed.
 */
function verifyApprovalDecisionWitnessV1(parsed: ReturnType<typeof validateApprovalDecisionRecordInputV2>, w: unknown): void {
  const ref: ApprovalDecisionRefV2 = parsed.approval_decision_ref_v2;
  if (!keysAre(w, 'audit,decision,evidence,proposal_snapshot')) refuse();
  const d = w.decision, e = w.evidence, a = w.audit;
  // The record's destination: its association (a project record's audience, none for Only me), and whether it is kept private there.
  const projects = ref.association_project_ids;
  const kept = isPrivateApprovalRecordV2({ policy_id: ref.selected_policy_id, association_project_ids: projects });
  // (a) the human choice equals the record: this record holds exactly the items routed to its destination, and the policy follows it
  if (!keysAre(d, 'action,approval_id,command_id,owners,routes,snapshot_sha256')
    || d.approval_id !== ref.proposal_approval_id || d.command_id !== ref.command_id || d.action !== 'approve' || d.snapshot_sha256 !== ref.proposal_snapshot_sha256
    || typeof d.approval_id !== 'string' || ref.approval_id !== approvalRecordIdV2(d.approval_id, projects, kept)
    || !Array.isArray(d.routes) || !Array.isArray(d.owners)
    || ref.selected_policy_id !== (ref.audience_project_ids.length === 0 ? RESTRICTED_REVIEWER_PERSON_POLICY_ID : PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID)) refuse();
  const routed = (d.routes as unknown[]).flatMap(route => isRoute(route) && route.project_ids !== null
    && same(route.project_ids, projects) && (route.private === true) === kept ? [route.signal_id] : []);
  const actions = new Set(parsed.event.approved_snapshot.approved_payload.brief.actions.map(action => action.id));
  const owners = (d.owners as unknown[]).filter(owner => keysAre(owner, 'owner,signal_id') && actions.has(owner.signal_id as string));
  if (!same(routed, ref.route_signal_ids) || !same(owners, ref.action_owners)) refuse();
  // (b) the authorized actor is the record's final approver in this organization, on this surface
  if (!keysAre(e, 'kind,membership_id,organization_id,principal_id,sha256,surface')
    || e.surface !== ref.surface || e.kind !== (ref.surface === 'desktop' ? 'person-session' : 'slack-click')
    || typeof e.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(e.sha256)
    || e.organization_id !== ref.organization_id || e.principal_id !== ref.final_approver.principal_id || e.membership_id !== ref.final_approver.membership_id) refuse();
  // (c) the audit entry is this decision's
  if (!keysAre(a, 'action_sha256,approval_id,approved_at,authorization_sha256,event_id,sequence')
    || a.approval_id !== ref.proposal_approval_id || a.event_id !== ref.audit_event_id || a.sequence !== ref.audit_sequence
    || a.action_sha256 !== ref.provider_action_sha256 || a.authorization_sha256 !== ref.authorization_proof_sha256 || a.approved_at !== ref.approved_at) refuse();
  // (d) the three digests bind the witness to the signed reference
  if (canonicalSha256(d as JsonValue) !== ref.provider_action_sha256 || canonicalSha256(e as JsonValue) !== ref.authorization_proof_sha256
    || canonicalSha256(a as JsonValue) !== ref.audit_entry_sha256) refuse();
  // (e) the record holds exactly its group's share of what the reviewer saw: the witness's snapshot is the proposal's and the
  //     one the decision names, its routes name every decision and action of it once, in order, and the subset is recomputed
  //     with the publisher's own function. Altered text, a reason moved from another group or one that supports nothing fail.
  let proposal: ApprovedDecisionSnapshotV2, subset: ApprovedDecisionSnapshotV2;
  try {
    proposal = validateApprovedDecisionSnapshotV2(w.proposal_snapshot);
    // The record's group as the publisher made it from the same routes, which also says whether it takes the reasons that
    // support no item.
    const group = approvalDecisionGroupsV1({ approval_id: d.approval_id, routes: d.routes as ApprovalRouteV1[] }).find(entry => entry.approval_id === ref.approval_id);
    if (group === undefined || !same(group.signal_ids, routed) || !same(group.project_ids, projects) || (group.private === true) !== kept) refuse();
    subset = approvalDecisionSubsetSnapshotV2(proposal, group);
  } catch { refuse(); }
  const brief = proposal.approved_payload.brief;
  const proposal_sha256 = canonicalSha256(proposal as unknown as JsonValue);
  if (proposal.approval_id !== d.approval_id || proposal_sha256 !== ref.proposal_snapshot_sha256 || proposal_sha256 !== d.snapshot_sha256
    || !same((d.routes as unknown[]).map(route => isRoute(route) ? route.signal_id : null), [...brief.decisions, ...brief.actions].map(signal => signal.id))
    || canonicalSha256(subset as unknown as JsonValue) !== ref.approved_snapshot_sha256 || !same(subset, parsed.event.approved_snapshot)) refuse();
}

/**
 * Re-checks at append time that the record is one destination group of exactly what the stored, authorized decision chose,
 * holding exactly that group's share of the snapshot its reviewer saw. The decision and its audit are committed in
 * authority_approval_decisions_v1 before this witness is used.
 */
export function createApprovalDecisionPolicyProjectorV1(): RecordPolicyFactProjectorV1 {
  return Object.freeze({
    id: APPROVAL_DECISION_REF_KIND_V2,
    matches: (envelope: RecordPolicyFactEnvelopeV1) => {
      const ref = envelope.body.human_act_resolution_ref as { kind?: unknown; schema_version?: unknown };
      return ref.kind === APPROVAL_DECISION_REF_KIND_V2 && ref.schema_version === 2;
    },
    policyBinding(envelope: RecordPolicyFactEnvelopeV1) {
      const { event } = parse(envelope);
      return { policy_id: event.policy_id, policy_contract_sha256: event.policy_contract_sha256 };
    },
    project(input: Parameters<RecordPolicyFactProjectorV1['project']>[0]) {
      const parsed = parse(input.envelope), ref = parsed.approval_decision_ref_v2, body = input.envelope.body;
      if (ref.authority_id !== body.authority_id || ref.organization_id !== body.organization_id || ref.state_lineage_id !== body.state_lineage_id) refuse();
      verifyApprovalDecisionWitnessV1(parsed, input.witness);
      return projectApprovedMeetingPolicyFactsV1({ ...input, event: parsed.event, reference: ref });
    },
  });
}

/** Derived identity only (the approver a meeting names); any parse failure or coordinate mismatch omits it. The approval id is the record's own. */
export const projectApprovalDecisionApproverV1: RecordApproverProjectorV1 = (envelope: JsonObject) => {
  try {
    const body = envelope.body as JsonObject;
    const ref = parse({ body: body as never }).approval_decision_ref_v2;
    if (ref.authority_id !== body.authority_id || ref.organization_id !== body.organization_id || ref.state_lineage_id !== body.state_lineage_id) return undefined;
    return { authority_id: ref.authority_id, organization_id: ref.organization_id, state_lineage_id: ref.state_lineage_id, approval_id: ref.approval_id,
      principal_id: ref.final_approver.principal_id, membership_id: ref.final_approver.membership_id };
  } catch { return undefined; }
};
