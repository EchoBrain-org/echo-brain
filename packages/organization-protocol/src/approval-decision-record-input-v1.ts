import { canonicalSha256, type JsonValue, type Sha256Digest } from '@echo-brain/federation-protocol';
import { asRecord, assertExactKeys, assertDigest, assertPositiveSafeInteger, assertTimestamp, canonicalSnapshot } from './validation-support.js';
import { organizationProtocolValidationFailure as fail } from './validation-error.js';
import { MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES } from './record-payload.js';
import { validateMeetingApprovalEventV2, type MeetingApprovedEventV2, type MeetingApprovalTranscriptSourceV2 } from './meeting-approval-event-v2.js';
import { PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, RESTRICTED_REVIEWER_PERSON_POLICY_ID } from './person-content-policy-v2.js';
import { APPROVAL_OWNERS_MAX_V1, isApprovalOwnerTextV1, isApprovalSignalIdV1 } from './approval-owner-choice-v1.js';
import type { RecordInputCodecV4, ValidatedRecordInputV4 } from './record-input-codec-v4.js';

/**
 * The one neutral record proof of a meeting approval decided in the approval core, on any surface (desktop or Slack).
 * The approval core's publisher writes it; the Authority's record codecs and the approval-decision projector read it.
 */
export const APPROVAL_DECISION_REF_KIND_V1 = 'echo-approval-decision-ref-v1';
export const APPROVAL_DECISION_CONSEQUENCE_KIND_V1 = 'echo-approval-decision-consequence-v1';
export const APPROVAL_DECISION_FIELD_V1 = 'approval_decision_ref_v1';
/** provider_action_kind of every approval decision record; provider_action_sha256 = canonicalSha256(witness.decision). */
export const APPROVAL_DECISION_PROVIDER_ACTION_KIND_V1 = 'echo-approval-decision-v1';
/** approved_payload.surface of every snapshot the approval core freezes. approval-core-v1.ts aliases it as APPROVAL_SNAPSHOT_SURFACE_V1. */
export const APPROVAL_DECISION_SNAPSHOT_SURFACE_V1 = 'echo-approval-core';
export type ApprovalDecisionSurfaceV1 = 'desktop' | 'slack';
/** Only me (restricted reviewer) or projects. Team (organization-member-readable) is not a choice (spec 1 ruling 2) and is refused. */
export type ApprovalDecisionPolicyIdV1 = typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID | typeof PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
export interface ApprovalDecisionActionOwnerV1 { readonly signal_id: string; readonly owner: string }
export interface ApprovalDecisionRefV1 {
  readonly schema_version: 1; readonly kind: typeof APPROVAL_DECISION_REF_KIND_V1;
  readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string;
  readonly approval_id: string; readonly command_id: string; readonly action: 'approve'; readonly surface: ApprovalDecisionSurfaceV1;
  readonly candidate_sha256: Sha256Digest; readonly approved_snapshot_sha256: Sha256Digest;
  readonly final_approver: { readonly principal_id: string; readonly membership_id: string };
  readonly selected_policy_id: ApprovalDecisionPolicyIdV1; readonly policy_contract_sha256: Sha256Digest; readonly policy_consequence_sha256: Sha256Digest;
  readonly audience_project_ids: readonly string[]; readonly association_project_ids: readonly string[];
  readonly share_transcript: boolean; readonly transcript_source: MeetingApprovalTranscriptSourceV2;
  /** Confirmed owners by approved action signal id, in brief order, each once (the Slack V3 shape). [] = none confirmed. */
  readonly action_owners: readonly ApprovalDecisionActionOwnerV1[];
  readonly audit_event_id: string; readonly audit_sequence: number; readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: typeof APPROVAL_DECISION_PROVIDER_ACTION_KIND_V1; readonly provider_action_schema_version: 1;
  readonly provider_action_sha256: Sha256Digest; readonly authorization_proof_sha256: Sha256Digest; readonly approved_at: string;
}
export interface ApprovalDecisionRecordInputV1 {
  readonly approval_decision_ref_v1: ApprovalDecisionRefV1;
  readonly event: MeetingApprovedEventV2 & { readonly policy_id: ApprovalDecisionPolicyIdV1 };
}
export interface ValidatedApprovalDecisionRecordInputV1 extends ApprovalDecisionRecordInputV1 { readonly semantic_idempotency_key: Sha256Digest }

const REF_KEYS = ['schema_version', 'kind', 'authority_id', 'organization_id', 'state_lineage_id', 'approval_id', 'command_id', 'action', 'surface',
  'candidate_sha256', 'approved_snapshot_sha256', 'final_approver', 'selected_policy_id', 'policy_contract_sha256', 'policy_consequence_sha256',
  'audience_project_ids', 'association_project_ids', 'share_transcript', 'transcript_source', 'action_owners', 'audit_event_id', 'audit_sequence',
  'audit_entry_sha256', 'provider_action_kind', 'provider_action_schema_version', 'provider_action_sha256', 'authorization_proof_sha256', 'approved_at'] as const;
const DIGEST_KEYS = ['candidate_sha256', 'approved_snapshot_sha256', 'policy_contract_sha256', 'policy_consequence_sha256',
  'audit_entry_sha256', 'provider_action_sha256', 'authorization_proof_sha256'] as const;
/** The record identifier pattern (the Authority's CHECK pins apr_* separately). */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** The approval core's command rule. */
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLACK_COMMAND = /^slack:[A-Za-z0-9._:-]+$/;

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const row = asRecord(value, label); assertExactKeys(row, keys, label); return row;
}
const same = (a: unknown, b: unknown) => canonicalSha256(a as JsonValue) === canonicalSha256(b as JsonValue);

export function validateApprovalDecisionRecordInputV1(value: unknown): ValidatedApprovalDecisionRecordInputV1 {
  const input = exact(canonicalSnapshot(value, 'Approval decision', MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES), [APPROVAL_DECISION_FIELD_V1, 'event'], 'Approval decision');
  const ref = exact(input[APPROVAL_DECISION_FIELD_V1], REF_KEYS, 'Approval decision reference');
  if (ref.schema_version !== 1 || ref.kind !== APPROVAL_DECISION_REF_KIND_V1 || ref.action !== 'approve'
    || ref.provider_action_kind !== APPROVAL_DECISION_PROVIDER_ACTION_KIND_V1 || ref.provider_action_schema_version !== 1) fail('Approval decision reference is unsupported');
  if (ref.surface !== 'desktop' && ref.surface !== 'slack') fail('Approval decision surface is unsupported');
  const approver = exact(ref.final_approver, ['principal_id', 'membership_id'], 'Approval decision approver');
  for (const id of [ref.authority_id, ref.organization_id, ref.state_lineage_id, ref.approval_id, ref.audit_event_id, approver.principal_id, approver.membership_id]) {
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
  const event = validateMeetingApprovalEventV2(input.event, APPROVAL_DECISION_CONSEQUENCE_KIND_V1);
  if (event.kind !== 'approved') fail('A rejection writes no approval decision record');
  if (event.policy_id !== RESTRICTED_REVIEWER_PERSON_POLICY_ID && event.policy_id !== PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID) fail('Approval decision audience is Only me or projects');
  if (ref.approval_id !== event.approved_snapshot.approval_id || ref.approved_snapshot_sha256 !== event.approved_snapshot_sha256 || ref.selected_policy_id !== event.policy_id
    || ref.policy_contract_sha256 !== event.policy_contract_sha256 || ref.policy_consequence_sha256 !== event.policy_consequence_sha256) fail('Approval decision differs from its approved event');
  for (const key of ['audience_project_ids', 'association_project_ids', 'share_transcript', 'transcript_source'] as const) {
    if (!same(ref[key], event.policy_consequence[key])) fail('Approval decision audience or transcript choice differs from its event');
  }
  const payload = event.approved_snapshot.approved_payload;
  if (payload.surface !== APPROVAL_DECISION_SNAPSHOT_SURFACE_V1) fail('Approval decision snapshot was not frozen by the approval core');
  const brief = payload.brief;
  // A record with no signals has no reviewer fact, so an Only-me transcript share could never append (record-log-v4-append.ts).
  if (brief.decisions.length + brief.actions.length + brief.rationales.length === 0) fail('Approval decision brief has no signals');
  const actions = brief.actions;
  // Every action, named or not: proposed owners are cleared at the freeze, and only the reference names confirmed ones.
  if (actions.some(action => action.owner !== null)) fail('Approval decision snapshot must not carry an owner');
  const owners = ref.action_owners;
  if (!Array.isArray(owners) || owners.length > APPROVAL_OWNERS_MAX_V1) fail('Approval decision owners are invalid');
  let prior = -1;
  owners.forEach((item: unknown, index: number) => {
    const entry = exact(item, ['signal_id', 'owner'], `Approval decision owner ${index}`);
    if (!isApprovalSignalIdV1(entry.signal_id) || !isApprovalOwnerTextV1(entry.owner)) fail(`Approval decision owner ${index} is invalid`);
    // -1 (an unknown id, or a decision or rationale id) fails because -1 <= prior.
    const at = actions.findIndex(action => action.id === entry.signal_id);
    if (at <= prior) fail('Approval decision owners must name approved actions once, in brief order');
    prior = at;
  });
  const reference = ref as unknown as ApprovalDecisionRefV1;
  return Object.freeze({ approval_decision_ref_v1: reference, event: event as ApprovalDecisionRecordInputV1['event'],
    semantic_idempotency_key: canonicalSha256(reference as unknown as JsonValue) });
}

function result(input: ValidatedApprovalDecisionRecordInputV1): ValidatedRecordInputV4 {
  return { human_act_resolution_ref: input.approval_decision_ref_v1, event: input.event, semantic_idempotency_key: input.semantic_idempotency_key };
}
/** Plain closures for clarity. (The registry copies validateInput onto its own frozen object, so `this` would also work.) */
export const APPROVAL_DECISION_RECORD_INPUT_CODEC_V1: RecordInputCodecV4 = Object.freeze({
  input_reference_field: APPROVAL_DECISION_FIELD_V1, reference_kind: APPROVAL_DECISION_REF_KIND_V1, reference_schema_version: 1,
  validateInput: (value: unknown) => result(validateApprovalDecisionRecordInputV1(value)),
  fromReference: (reference: unknown, event: unknown) => result(validateApprovalDecisionRecordInputV1({ [APPROVAL_DECISION_FIELD_V1]: reference, event })),
});
