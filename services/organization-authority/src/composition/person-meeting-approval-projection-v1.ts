import { canonicalSha256, type JsonObject } from '@echo-brain/federation-protocol';
import { PERSON_MEETING_APPROVAL_REF_KIND_V1, validatePersonMeetingApprovalRecordInputV1 } from '@echo-brain/organization-protocol';
import { projectApprovedMeetingPolicyFactsV1, type RecordPolicyFactProjectorV1, type RecordApproverProjectorV1 } from '@echo-brain/organization-record/organization-record-api-v1';

function parse(reference: unknown, event: unknown) {
  return validatePersonMeetingApprovalRecordInputV1({ person_meeting_approval_resolution_ref_v1: reference, event });
}
/** The native session action and Authority audit are committed before this append witness is used. */
export function createPersonMeetingApprovalPolicyProjectorV1(): RecordPolicyFactProjectorV1 {
  return {
    id: PERSON_MEETING_APPROVAL_REF_KIND_V1,
    matches: envelope => (envelope.body.human_act_resolution_ref as { kind?: unknown }).kind === PERSON_MEETING_APPROVAL_REF_KIND_V1,
    policyBinding(envelope) {
      const { event } = parse(envelope.body.human_act_resolution_ref, envelope.body.event);
      return { policy_id: event.policy_id, policy_contract_sha256: event.policy_contract_sha256 };
    },
    project(input) {
      const parsed = parse(input.envelope.body.human_act_resolution_ref, input.envelope.body.event);
      const ref = parsed.person_meeting_approval_resolution_ref_v1;
      const witness = input.witness as { action?: Record<string, unknown>; authorization?: Record<string, unknown>; audit?: unknown } | null;
      if (!witness || Object.keys(witness).sort().join(',') !== 'action,audit,authorization' ||
          canonicalSha256(witness.action) !== ref.provider_action_sha256 || canonicalSha256(witness.authorization) !== ref.authorization_proof_sha256 || canonicalSha256(witness.audit) !== ref.audit_entry_sha256 ||
          witness.action?.approval_id !== ref.approval_id || witness.action?.command_id !== ref.command_id || witness.action?.action !== 'approve' || witness.action?.snapshot_sha256 !== ref.approved_snapshot_sha256 ||
          witness.authorization?.organization_id !== ref.organization_id || witness.authorization?.principal_id !== ref.final_approver.principal_id || witness.authorization?.membership_id !== ref.final_approver.membership_id ||
          witness.action?.share_transcript !== ref.share_transcript || canonicalSha256(witness.action?.project_id === null ? [] : [witness.action?.project_id]) !== canonicalSha256(ref.audience_project_ids)) throw new Error('Person approval witness differs from the authenticated action');
      const audit = witness.audit as Record<string, unknown> | null;
      if (!audit || audit.approval_id !== ref.approval_id || audit.sequence !== ref.audit_sequence || audit.event_id !== ref.audit_event_id || audit.action_sha256 !== ref.provider_action_sha256 || audit.authorization_sha256 !== ref.authorization_proof_sha256 || audit.approved_at !== ref.approved_at) throw new Error('Person approval audit differs from the record');
      return projectApprovedMeetingPolicyFactsV1({ ...input, event: parsed.event, reference: ref });
    },
  };
}
export const projectPersonMeetingApproverV1: RecordApproverProjectorV1 = (envelope: JsonObject) => {
  try {
    const body = envelope.body as JsonObject;
    const { person_meeting_approval_resolution_ref_v1: ref } = parse(body.human_act_resolution_ref, body.event);
    if (ref.authority_id !== body.authority_id || ref.organization_id !== body.organization_id || ref.state_lineage_id !== body.state_lineage_id) return undefined;
    return { authority_id: ref.authority_id, organization_id: ref.organization_id, state_lineage_id: ref.state_lineage_id, approval_id: ref.approval_id,
      principal_id: ref.final_approver.principal_id, membership_id: ref.final_approver.membership_id };
  } catch { return undefined; }
};
