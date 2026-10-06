import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { asRecord, assertExactKeys, assertDigest, assertPositiveSafeInteger, assertTimestamp, canonicalSnapshot } from './validation-support.js';
import { organizationProtocolValidationFailure as fail } from './validation-error.js';
import { MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES } from './record-payload.js';
import { validateMeetingApprovalEventV2, type MeetingApprovedEventV2 } from './meeting-approval-event-v2.js';
import type { RecordInputCodecV4 } from './record-input-codec-v4.js';

export const PERSON_MEETING_APPROVAL_REF_KIND_V1 = 'echo-person-meeting-approval-resolution-ref-v1';
export const PERSON_MEETING_APPROVAL_CONSEQUENCE_KIND_V1 = 'echo-person-meeting-approval-consequence-v1';
export const PERSON_MEETING_APPROVAL_FIELD_V1 = 'person_meeting_approval_resolution_ref_v1';
export interface PersonMeetingApprovalResolutionRefV1 {
  readonly schema_version: 1; readonly kind: typeof PERSON_MEETING_APPROVAL_REF_KIND_V1;
  readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string;
  readonly approval_id: string; readonly command_id: string; readonly action: 'approve';
  readonly candidate_sha256: Sha256Digest; readonly frozen_card_sha256: Sha256Digest; readonly approved_snapshot_sha256: Sha256Digest;
  readonly final_approver: { readonly principal_id: string; readonly membership_id: string };
  readonly selected_policy_id: MeetingApprovedEventV2['policy_id']; readonly policy_contract_sha256: Sha256Digest; readonly policy_consequence_sha256: Sha256Digest;
  readonly audience_project_ids: readonly string[]; readonly association_project_ids: readonly string[];
  readonly share_transcript: boolean; readonly transcript_source: MeetingApprovedEventV2['policy_consequence']['transcript_source'];
  readonly audit_event_id: string; readonly audit_sequence: number; readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: 'echo-person-meeting-approval-action-v1'; readonly provider_action_schema_version: 1;
  readonly provider_action_sha256: Sha256Digest; readonly authorization_proof_sha256: Sha256Digest; readonly approved_at: string;
}
export interface PersonMeetingApprovalRecordInputV1 {
  readonly person_meeting_approval_resolution_ref_v1: PersonMeetingApprovalResolutionRefV1;
  readonly event: MeetingApprovedEventV2;
}
function exact(value: unknown, keys: readonly string[], label: string) {
  const row = asRecord(value, label); assertExactKeys(row, keys, label); return row;
}
export function validatePersonMeetingApprovalRecordInputV1(value: unknown): PersonMeetingApprovalRecordInputV1 & { readonly semantic_idempotency_key: Sha256Digest } {
  const input = exact(canonicalSnapshot(value, 'Person approval', MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES), [PERSON_MEETING_APPROVAL_FIELD_V1, 'event'], 'Person approval');
  const ref = exact(input[PERSON_MEETING_APPROVAL_FIELD_V1], ['schema_version', 'kind', 'authority_id', 'organization_id', 'state_lineage_id', 'approval_id', 'command_id', 'action',
    'candidate_sha256', 'frozen_card_sha256', 'approved_snapshot_sha256', 'final_approver', 'selected_policy_id', 'policy_contract_sha256', 'policy_consequence_sha256',
    'audience_project_ids', 'association_project_ids', 'share_transcript', 'transcript_source', 'audit_event_id', 'audit_sequence', 'audit_entry_sha256',
    'provider_action_kind', 'provider_action_schema_version', 'provider_action_sha256', 'authorization_proof_sha256', 'approved_at'], 'Person approval reference');
  if (ref.schema_version !== 1 || ref.kind !== PERSON_MEETING_APPROVAL_REF_KIND_V1 || ref.action !== 'approve' || ref.provider_action_kind !== 'echo-person-meeting-approval-action-v1' || ref.provider_action_schema_version !== 1) fail('Person approval reference is unsupported');
  const actor = exact(ref.final_approver, ['principal_id', 'membership_id'], 'Person approver');
  for (const id of [ref.authority_id, ref.organization_id, ref.state_lineage_id, ref.approval_id, ref.command_id, ref.audit_event_id, actor.principal_id, actor.membership_id]) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) fail('Person approval identifier is invalid');
  }
  for (const key of ['candidate_sha256', 'frozen_card_sha256', 'approved_snapshot_sha256', 'policy_contract_sha256', 'policy_consequence_sha256', 'audit_entry_sha256', 'provider_action_sha256', 'authorization_proof_sha256']) assertDigest(ref[key], key);
  assertPositiveSafeInteger(ref.audit_sequence, 'Person approval audit sequence'); assertTimestamp(ref.approved_at, 'Person approval time');
  const event = validateMeetingApprovalEventV2(input.event, PERSON_MEETING_APPROVAL_CONSEQUENCE_KIND_V1);
  if (event.kind !== 'approved') fail('A rejected Person review cannot append an approved record');
  if (ref.approval_id !== event.approved_snapshot.approval_id || ref.approved_snapshot_sha256 !== event.approved_snapshot_sha256 || ref.selected_policy_id !== event.policy_id || ref.policy_contract_sha256 !== event.policy_contract_sha256 || ref.policy_consequence_sha256 !== event.policy_consequence_sha256) fail('Person approval differs from the frozen event');
  for (const key of ['audience_project_ids', 'association_project_ids', 'share_transcript', 'transcript_source'] as const) {
    if (canonicalSha256(ref[key]) !== canonicalSha256(event.policy_consequence[key])) fail('Person approval audience or transcript choice differs');
  }
  const reference = ref as unknown as PersonMeetingApprovalResolutionRefV1;
  return Object.freeze({ person_meeting_approval_resolution_ref_v1: reference, event, semantic_idempotency_key: canonicalSha256(reference) });
}
export const PERSON_MEETING_APPROVAL_RECORD_INPUT_CODEC_V1: RecordInputCodecV4 = Object.freeze({
  input_reference_field: PERSON_MEETING_APPROVAL_FIELD_V1, reference_kind: PERSON_MEETING_APPROVAL_REF_KIND_V1, reference_schema_version: 1,
  validateInput(value: unknown) {
    const input = validatePersonMeetingApprovalRecordInputV1(value);
    return { human_act_resolution_ref: input.person_meeting_approval_resolution_ref_v1, event: input.event, semantic_idempotency_key: input.semantic_idempotency_key };
  },
  fromReference(reference: unknown, event: unknown) { return this.validateInput({ [PERSON_MEETING_APPROVAL_FIELD_V1]: reference, event }); },
});
