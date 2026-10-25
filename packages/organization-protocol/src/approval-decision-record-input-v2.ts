import { canonicalSha256, type JsonValue, type Sha256Digest } from '@echo-brain/federation-protocol';
import { asRecord, assertExactKeys, assertDigest, assertPositiveSafeInteger, assertTimestamp, canonicalSnapshot } from './validation-support.js';
import { organizationProtocolValidationFailure as fail } from './validation-error.js';
import { MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES } from './record-payload.js';
import { approvedDecisionSnapshotV2Sha256, validateApprovedDecisionSnapshotV2, type ApprovedDecisionSnapshotV2 } from './human-act-record-input-v1.js';
import {
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, RESTRICTED_REVIEWER_PERSON_POLICY_ID, projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from './person-content-policy-v2.js';
import { APPROVAL_OWNERS_MAX_V1, isApprovalOwnerTextV1, isApprovalSignalIdV1 } from './approval-owner-choice-v1.js';
import type { RecordInputCodecV4, ValidatedRecordInputV4 } from './record-input-codec-v4.js';

/**
 * The one neutral record proof of a meeting approval decided in the approval core, on any surface (desktop or Slack).
 * A decision routes each decision and action to a destination; the publisher writes one record per destination group
 * (ADR-0046), each holding only its own items. The approval core's publisher writes it; the Authority's record codecs
 * and the approval-decision projector read it.
 */
export const APPROVAL_DECISION_REF_KIND_V2 = 'echo-approval-decision-ref-v2';
export const APPROVAL_DECISION_CONSEQUENCE_KIND_V1 = 'echo-approval-decision-consequence-v1';
export const APPROVAL_DECISION_FIELD_V2 = 'approval_decision_ref_v2';
/** provider_action_kind of every approval decision record; provider_action_sha256 = canonicalSha256(witness.decision). */
export const APPROVAL_DECISION_PROVIDER_ACTION_KIND_V2 = 'echo-approval-decision-v2';
/** approved_payload.surface of every snapshot the approval core freezes. approval-core-v1.ts aliases it as APPROVAL_SNAPSHOT_SURFACE_V1. */
export const APPROVAL_DECISION_SNAPSHOT_SURFACE_V1 = 'echo-approval-core';
/** The kind a destination's record approval id is derived under. */
export const APPROVAL_ROUTE_KIND_V1 = 'echo-approval-route-v1';
export type ApprovalDecisionSurfaceV1 = 'desktop' | 'slack';
/** Only me (restricted reviewer) or projects. Team (organization-member-readable) is not a choice (spec 1 ruling 2) and is refused. */
export type ApprovalDecisionPolicyIdV1 = typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID | typeof PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
export interface ApprovalDecisionActionOwnerV1 { readonly signal_id: string; readonly owner: string }
export interface ApprovalDecisionRefV2 {
  readonly schema_version: 2; readonly kind: typeof APPROVAL_DECISION_REF_KIND_V2;
  readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string;
  /** This record's own approval id: approvalRecordIdV2(proposal_approval_id, audience_project_ids). */
  readonly approval_id: string;
  /** The decided proposal, which every record of the decision shares. */
  readonly proposal_approval_id: string;
  readonly command_id: string; readonly action: 'approve'; readonly surface: ApprovalDecisionSurfaceV1;
  readonly candidate_sha256: Sha256Digest;
  /** The frozen snapshot the reviewer saw (the decision's snapshot_sha256). */
  readonly proposal_snapshot_sha256: Sha256Digest;
  /** This record's subset of that snapshot. */
  readonly approved_snapshot_sha256: Sha256Digest;
  /** The decisions then actions the reviewer routed here, in brief order: exactly this record's. */
  readonly route_signal_ids: readonly string[];
  readonly final_approver: { readonly principal_id: string; readonly membership_id: string };
  readonly selected_policy_id: ApprovalDecisionPolicyIdV1; readonly policy_contract_sha256: Sha256Digest; readonly policy_consequence_sha256: Sha256Digest;
  readonly audience_project_ids: readonly string[]; readonly association_project_ids: readonly string[];
  /** Confirmed owners of this record's actions, in brief order, each once (the Slack V3 shape). [] = none confirmed. */
  readonly action_owners: readonly ApprovalDecisionActionOwnerV1[];
  readonly audit_event_id: string; readonly audit_sequence: number; readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: typeof APPROVAL_DECISION_PROVIDER_ACTION_KIND_V2; readonly provider_action_schema_version: 2;
  readonly provider_action_sha256: Sha256Digest; readonly authorization_proof_sha256: Sha256Digest; readonly approved_at: string;
}
/** What a destination's policy selects: its project audience, which is also its association ([] for Only me). */
export interface ApprovalDecisionConsequenceV2 {
  readonly schema_version: 2; readonly kind: typeof APPROVAL_DECISION_CONSEQUENCE_KIND_V1; readonly policy_id: ApprovalDecisionPolicyIdV1;
  readonly audience_project_ids: readonly string[]; readonly association_project_ids: readonly string[];
}
/** One destination's approved event: its subset snapshot, its policy and the consequence that policy selects. */
export interface ApprovalDecisionEventV2 {
  readonly kind: 'approved'; readonly approved_snapshot: ApprovedDecisionSnapshotV2; readonly approved_snapshot_sha256: Sha256Digest;
  readonly policy_id: ApprovalDecisionPolicyIdV1; readonly policy_contract_sha256: Sha256Digest;
  readonly policy_consequence: ApprovalDecisionConsequenceV2; readonly policy_consequence_sha256: Sha256Digest;
}
export interface ApprovalDecisionRecordInputV2 {
  readonly approval_decision_ref_v2: ApprovalDecisionRefV2;
  readonly event: ApprovalDecisionEventV2;
}
export interface ValidatedApprovalDecisionRecordInputV2 extends ApprovalDecisionRecordInputV2 { readonly semantic_idempotency_key: Sha256Digest }

const REF_KEYS = ['schema_version', 'kind', 'authority_id', 'organization_id', 'state_lineage_id', 'approval_id', 'proposal_approval_id', 'command_id', 'action',
  'surface', 'candidate_sha256', 'proposal_snapshot_sha256', 'approved_snapshot_sha256', 'route_signal_ids', 'final_approver', 'selected_policy_id',
  'policy_contract_sha256', 'policy_consequence_sha256', 'audience_project_ids', 'association_project_ids', 'action_owners', 'audit_event_id', 'audit_sequence',
  'audit_entry_sha256', 'provider_action_kind', 'provider_action_schema_version', 'provider_action_sha256', 'authorization_proof_sha256', 'approved_at'] as const;
const DIGEST_KEYS = ['candidate_sha256', 'proposal_snapshot_sha256', 'approved_snapshot_sha256', 'policy_contract_sha256', 'policy_consequence_sha256',
  'audit_entry_sha256', 'provider_action_sha256', 'authorization_proof_sha256'] as const;
const EVENT_KEYS = ['kind', 'approved_snapshot', 'approved_snapshot_sha256', 'policy_id', 'policy_contract_sha256', 'policy_consequence', 'policy_consequence_sha256'] as const;
const CONSEQUENCE_KEYS = ['schema_version', 'kind', 'policy_id', 'audience_project_ids', 'association_project_ids'] as const;
const PROJECT_ID = /^prj_[0-9a-f-]{36}$/;
/** The record identifier pattern (the Authority's CHECK pins the proposal's apr_* separately). */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** The approval core's command rule. */
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLACK_COMMAND = /^slack:[A-Za-z0-9._:-]+$/;

/**
 * The record approval id of one destination of a decided proposal: `apr_` and the hex of the route's digest. Each
 * destination has its own, so the record log's one record per approval holds per destination and its baseline stays.
 */
export function approvalRecordIdV2(proposalApprovalId: string, projectIds: readonly string[]): string {
  return `apr_${canonicalSha256({ kind: APPROVAL_ROUTE_KIND_V1, approval_id: proposalApprovalId, project_ids: [...projectIds] } as unknown as JsonValue).slice(7)}`;
}

/** One destination group of a decision: the record's own approval id, its project set ([] = Only me), its decisions then actions. */
export interface ApprovalDecisionGroupV2 {
  readonly approval_id: string; readonly project_ids: readonly string[]; readonly signal_ids: readonly string[];
}
/**
 * The snapshot one destination group's record carries: the frozen proposal snapshot the reviewer saw, under the record's own
 * approval id, holding only the group's decisions and actions and every reason that supports one of them, its links pruned
 * to the group. A reason that supports nothing goes to the Only-me group; one that supports only items kept elsewhere, or
 * not kept, is left out. Pure: the publisher builds each record with it and the append projector recomputes it from the
 * proposal snapshot, so the two cannot drift. Throws unless every group item is a decision or action of the proposal.
 */
export function approvalDecisionSubsetSnapshotV2(proposal: unknown, group: ApprovalDecisionGroupV2): ApprovedDecisionSnapshotV2 {
  const snapshot = validateApprovedDecisionSnapshotV2(proposal);
  const brief = snapshot.approved_payload.brief;
  const ids = new Set(group.signal_ids);
  const items = new Set([...brief.decisions, ...brief.actions].map(signal => signal.id));
  if (ids.size === 0 || ids.size !== group.signal_ids.length || group.signal_ids.some(id => !items.has(id))) fail('Approval decision group names items its proposal does not');
  const rationales = brief.rationales.flatMap(reason => {
    if (reason.supports_signal_ids.length === 0) return group.project_ids.length === 0 ? [reason] : [];
    const supports = reason.supports_signal_ids.filter(id => ids.has(id));
    return supports.length === 0 ? [] : [{ ...reason, supports_signal_ids: supports }];
  });
  const payload = { ...snapshot.approved_payload, brief: { ...brief, decisions: brief.decisions.filter(signal => ids.has(signal.id)),
    actions: brief.actions.filter(signal => ids.has(signal.id)), rationales } };
  return validateApprovedDecisionSnapshotV2({ ...snapshot, approval_id: group.approval_id,
    final_content_sha256: canonicalSha256(payload as unknown as JsonValue), approved_payload: payload });
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const row = asRecord(value, label); assertExactKeys(row, keys, label); return row;
}
const same = (a: unknown, b: unknown) => canonicalSha256(a as JsonValue) === canonicalSha256(b as JsonValue);

/** Only me (restricted reviewer) or projects; Team is not a destination (spec 1 ruling 2). */
function policy(value: unknown): ApprovalDecisionPolicyIdV1 {
  if (value !== RESTRICTED_REVIEWER_PERSON_POLICY_ID && value !== PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID) fail('Approval decision audience is Only me or projects');
  return value;
}
const policyContract = (policyId: ApprovalDecisionPolicyIdV1): Sha256Digest => policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID
  ? restrictedReviewerPersonPolicyContractSha256() : projectMembersReadablePersonPolicyContractSha256();
/** 0 to 20 canonical project ids, sorted and unique; 1 to 20 when required. */
function projectIds(value: unknown, label: string, required: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 20 || (required && value.length === 0)) fail(`${label} has an invalid project count`);
  value.forEach((id: unknown, index) => {
    if (typeof id !== 'string' || !PROJECT_ID.test(id)) fail(`${label}[${index}] must be a canonical project ID`);
    if (index > 0 && value[index - 1] >= id) fail(`${label} must be sorted and unique`);
  });
  return Object.freeze([...value as string[]]);
}
function consequenceOf(value: unknown): ApprovalDecisionConsequenceV2 {
  const record = exact(value, CONSEQUENCE_KEYS, 'Approval decision consequence');
  if (record.schema_version !== 2 || record.kind !== APPROVAL_DECISION_CONSEQUENCE_KIND_V1) fail('Approval decision consequence has an unsupported envelope');
  const policyId = policy(record.policy_id);
  const projects = policyId === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
  const audience = projectIds(record.audience_project_ids, 'Approval decision consequence audience projects', projects);
  const association = projectIds(record.association_project_ids, 'Approval decision consequence association projects', projects);
  if (!same(audience, association)) fail('Approval decision consequence audience and association must match');
  if (!projects && audience.length !== 0) fail('Approval decision consequence for Only me must not carry projects');
  return Object.freeze({ schema_version: 2, kind: APPROVAL_DECISION_CONSEQUENCE_KIND_V1, policy_id: policyId, audience_project_ids: audience, association_project_ids: association });
}
/** The approved event, its snapshot digest, and the consequence and contract its policy selects. A rejection writes no record. */
function eventOf(value: unknown): ApprovalDecisionEventV2 {
  if (asRecord(value, 'Approval decision event').kind === 'rejected') fail('A rejection writes no approval decision record');
  const event = exact(value, EVENT_KEYS, 'Approval decision event');
  if (event.kind !== 'approved') fail('Approval decision event is unsupported');
  const snapshot = validateApprovedDecisionSnapshotV2(event.approved_snapshot);
  assertDigest(event.approved_snapshot_sha256, 'Approval decision event snapshot digest');
  if (event.approved_snapshot_sha256 !== approvedDecisionSnapshotV2Sha256(snapshot)) fail('Approval decision event snapshot digest does not match');
  const policyId = policy(event.policy_id);
  const consequence = consequenceOf(event.policy_consequence);
  assertDigest(event.policy_consequence_sha256, 'Approval decision event consequence digest');
  if (event.policy_contract_sha256 !== policyContract(policyId) || consequence.policy_id !== policyId
    || event.policy_consequence_sha256 !== canonicalSha256(consequence as unknown as JsonValue)) fail('Approval decision event policy consequence is invalid');
  return Object.freeze({ kind: 'approved', approved_snapshot: snapshot, approved_snapshot_sha256: event.approved_snapshot_sha256 as Sha256Digest, policy_id: policyId,
    policy_contract_sha256: event.policy_contract_sha256 as Sha256Digest, policy_consequence: consequence, policy_consequence_sha256: event.policy_consequence_sha256 as Sha256Digest });
}

export function validateApprovalDecisionRecordInputV2(value: unknown): ValidatedApprovalDecisionRecordInputV2 {
  const input = exact(canonicalSnapshot(value, 'Approval decision', MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES), [APPROVAL_DECISION_FIELD_V2, 'event'], 'Approval decision');
  const ref = exact(input[APPROVAL_DECISION_FIELD_V2], REF_KEYS, 'Approval decision reference');
  if (ref.schema_version !== 2 || ref.kind !== APPROVAL_DECISION_REF_KIND_V2 || ref.action !== 'approve'
    || ref.provider_action_kind !== APPROVAL_DECISION_PROVIDER_ACTION_KIND_V2 || ref.provider_action_schema_version !== 2) fail('Approval decision reference is unsupported');
  if (ref.surface !== 'desktop' && ref.surface !== 'slack') fail('Approval decision surface is unsupported');
  const approver = exact(ref.final_approver, ['principal_id', 'membership_id'], 'Approval decision approver');
  for (const id of [ref.authority_id, ref.organization_id, ref.state_lineage_id, ref.approval_id, ref.proposal_approval_id, ref.audit_event_id,
    approver.principal_id, approver.membership_id]) {
    if (typeof id !== 'string' || !IDENTIFIER.test(id)) fail('Approval decision identifier is invalid');
  }
  const command = ref.command_id;
  if (typeof command !== 'string' || !COMMAND.test(command) || (ref.surface === 'slack' ? !SLACK_COMMAND.test(command) : command.startsWith('slack:'))) {
    fail('Approval decision command does not match its surface');
  }
  if (ref.audit_event_id !== `audit:${command}`) fail('Approval decision audit event is not its command');
  for (const key of DIGEST_KEYS) assertDigest(ref[key], `Approval decision ${key}`);
  assertPositiveSafeInteger(ref.audit_sequence, 'Approval decision audit sequence');
  assertTimestamp(ref.approved_at, 'Approval decision time');
  const event = eventOf(input.event);
  if (ref.approval_id !== event.approved_snapshot.approval_id || ref.approved_snapshot_sha256 !== event.approved_snapshot_sha256 || ref.selected_policy_id !== event.policy_id
    || ref.policy_contract_sha256 !== event.policy_contract_sha256 || ref.policy_consequence_sha256 !== event.policy_consequence_sha256) fail('Approval decision differs from its approved event');
  for (const key of ['audience_project_ids', 'association_project_ids'] as const) {
    if (!same(ref[key], event.policy_consequence[key])) fail('Approval decision audience differs from its event');
  }
  // The audience is validated (sorted, unique, canonical) by the event's consequence, which the reference equals.
  if (ref.approval_id !== approvalRecordIdV2(ref.proposal_approval_id as string, event.policy_consequence.audience_project_ids)) {
    fail('Approval decision record is not its destination\'s');
  }
  const payload = event.approved_snapshot.approved_payload;
  if (payload.surface !== APPROVAL_DECISION_SNAPSHOT_SURFACE_V1) fail('Approval decision snapshot was not frozen by the approval core');
  const brief = payload.brief;
  if (brief.decisions.length + brief.actions.length === 0) fail('Approval decision brief keeps no decision or action');
  const routed = ref.route_signal_ids;
  // A record holds the items routed to it and nothing else: its decisions then actions are exactly its routes.
  if (!Array.isArray(routed) || routed.some(id => !isApprovalSignalIdV1(id))
    || !same(routed, [...brief.decisions, ...brief.actions].map(signal => signal.id))) fail('Approval decision routes differ from its brief');
  const actions = brief.actions;
  // Every action, named or not: proposed owners are cleared at the freeze, and only the reference names confirmed ones.
  if (actions.some(action => action.owner !== null)) fail('Approval decision snapshot must not carry an owner');
  const owners = ref.action_owners;
  if (!Array.isArray(owners) || owners.length > APPROVAL_OWNERS_MAX_V1) fail('Approval decision owners are invalid');
  let prior = -1;
  owners.forEach((item: unknown, index: number) => {
    const entry = exact(item, ['signal_id', 'owner'], `Approval decision owner ${index}`);
    if (!isApprovalSignalIdV1(entry.signal_id) || !isApprovalOwnerTextV1(entry.owner)) fail(`Approval decision owner ${index} is invalid`);
    // -1 (an unknown id, another record's action, or a decision or rationale id) fails because -1 <= prior.
    const at = actions.findIndex(action => action.id === entry.signal_id);
    if (at <= prior) fail('Approval decision owners must name approved actions once, in brief order');
    prior = at;
  });
  const reference = ref as unknown as ApprovalDecisionRefV2;
  return Object.freeze({ approval_decision_ref_v2: reference, event, semantic_idempotency_key: canonicalSha256(reference as unknown as JsonValue) });
}

function result(input: ValidatedApprovalDecisionRecordInputV2): ValidatedRecordInputV4 {
  return { human_act_resolution_ref: input.approval_decision_ref_v2, event: input.event, semantic_idempotency_key: input.semantic_idempotency_key };
}
/** Plain closures for clarity. (The registry copies validateInput onto its own frozen object, so `this` would also work.) */
export const APPROVAL_DECISION_RECORD_INPUT_CODEC_V2: RecordInputCodecV4 = Object.freeze({
  input_reference_field: APPROVAL_DECISION_FIELD_V2, reference_kind: APPROVAL_DECISION_REF_KIND_V2, reference_schema_version: 2,
  validateInput: (value: unknown) => result(validateApprovalDecisionRecordInputV2(value)),
  fromReference: (reference: unknown, event: unknown) => result(validateApprovalDecisionRecordInputV2({ [APPROVAL_DECISION_FIELD_V2]: reference, event })),
});
