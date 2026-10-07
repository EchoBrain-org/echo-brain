import type { DecisionBrief } from '@echo-brain/organization-processing/core';
import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import {
  createRecordEnvelopeFactoryV4, createRecordReceiptFactoryV2, createRecordInputCodecRegistryV4,
  PERSON_MEETING_APPROVAL_RECORD_INPUT_CODEC_V1, PERSON_MEETING_APPROVAL_REF_KIND_V1, PERSON_MEETING_APPROVAL_CONSEQUENCE_KIND_V1,
  validatePersonMeetingApprovalRecordInputV1, organizationAuthorityPinSha256, verifyOrganizationAuthorityPin,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  projectMembersReadablePersonPolicyContractSha256, restrictedReviewerPersonPolicyContractSha256,
} from '@echo-brain/organization-protocol';
import type { ApprovalWorkflowContextV1, ApprovalWorkflowComponentsV1 } from '@echo-brain/organization-processing/ports/approval-workflow-bundle-v1';
import type { ApprovalWorkflowStageInputV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1';
import { compileDecisionBrief } from '@echo-brain/organization-processing/core/processing/brief';
import { retainedMeetingSourceCoordinateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import type { personToolAuthenticationV1 } from './person-tool-authentication-v1.js';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

export interface PersonMeetingReviewActionV1 {
  readonly command_id: string; readonly approval_id: string; readonly snapshot_sha256: Sha256Digest;
  readonly action: 'approve' | 'reject'; readonly project_id: string | null; readonly share_transcript: boolean;
}
type PersonConnectionAuthorizationV1 = ReturnType<ReturnType<typeof personToolAuthenticationV1>>;
interface ActionBody { readonly request: PersonMeetingReviewActionV1; readonly authorization: PersonConnectionAuthorizationV1; readonly approved_at: string }
interface ActionRow { readonly sequence: number; readonly approval_id: string; readonly command_id: string; readonly body_json: string; readonly receipt_json: string | null }
const codecs = createRecordInputCodecRegistryV4([PERSON_MEETING_APPROVAL_RECORD_INPUT_CODEC_V1]);
function denied(): never { throw new AuthorityOperationError('unauthorized', 'Meeting review is not available'); }

export function personMeetingReviewTextV1(snapshotJson: string): string {
  const brief = (JSON.parse(snapshotJson) as { approved_payload: { brief: DecisionBrief } }).approved_payload.brief;
  const lines = [brief.meeting.title ?? 'Meeting', ...Object.entries(brief.meeting.time ?? {}).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`),
    ...brief.meeting.participants.map(person => `Participant: ${person.display_name ?? person.id}`)];
  for (const [name, signals] of [['Decisions', brief.decisions], ['Actions', brief.actions], ['Rationales', brief.rationales]] as const) {
    lines.push('', name);
    if (signals.length === 0) lines.push('None');
    for (const signal of signals) {
      lines.push(`• ${signal.text}`);
      if (signal.subject) lines.push(`  Subject: ${signal.subject}`);
      if ('status' in signal) lines.push(`  Status: ${signal.status}`);
      if ('owner' in signal) lines.push(`  Owner: ${signal.owner ?? 'Unassigned'} · Due: ${signal.due_at ?? 'Not specified'}`);
      for (const span of signal.evidence) if (span.quote) lines.push(`  From the meeting: “${span.quote}”`);
    }
  }
  return lines.join('\n');
}

/** First-party presentation over the existing frozen candidate, outbox and signed append. */
export async function createPersonMeetingReviewV1(database: Database.Database, context: ApprovalWorkflowContextV1, sourceKey: string) {
  const descriptor = await context.signer.inspect();
  const factories = { pinned_authority: verifyOrganizationAuthorityPin(descriptor, organizationAuthorityPinSha256(descriptor)),
    state_lineage_id: context.coordinates.state_lineage_id, sign: (message: Buffer, keyId: Sha256Digest) => context.signer.sign(message, keyId), codecs };
  function assertOwned() {
    for (const row of context.state.listOutstandingApprovalPresentations()) {
      const outbox = context.state.readCandidateByApprovalId(row.approval_id);
      if (outbox?.presentation_external_id !== null && outbox?.presentation_external_id !== `echo:${row.approval_id}`) throw new Error('In-app review cannot take over another approval surface');
      const snapshot = outbox?.approved_snapshot_json === null ? null : JSON.parse(outbox!.approved_snapshot_json!) as { approved_payload?: { surface?: unknown } };
      if (snapshot?.approved_payload?.surface !== 'echo-person-review') throw new Error('In-app review does not own this frozen presentation');
    }
  }
  assertOwned();
  async function stage(input: ApprovalWorkflowStageInputV1) {
    const approval_id = input.candidate.approval_id;
    const payload = { brief: compileDecisionBrief(`brief:${approval_id}`, input.meeting, input.decisions),
      source: { adapter_id: input.meeting.provenance.source.adapter_id, instance_id: input.meeting.provenance.source.instance_id, external_id: input.meeting.provenance.external_id },
      alternatives: [], links: null, reviewed_at: input.decisions.generated_at, surface: 'echo-person-review' };
    const snapshot = { schema_version: 2, kind: 'echo-approved-decision-snapshot-v2', approval_id,
      staged_content_sha256: canonicalSha256({ meeting: input.meeting, decisions: input.decisions }), final_content_sha256: canonicalSha256(payload),
      payload_contract_id: 'organization-record-approval-payload-v1', approved_payload: payload };
    const frozen_card_sha256 = canonicalSha256(snapshot);
    const prepared = context.state.prepareApprovalPost({ candidate_id: input.candidate.candidate_id, frozen_card_sha256, approved_snapshot: snapshot });
    if (prepared.outbox.state === 'superseded') return { kind: 'state_drift' as const };
    if (prepared.outbox.state === 'posting') context.state.recordPostedApprovalCard({ candidate_id: input.candidate.candidate_id, frozen_card_sha256,
      approved_snapshot: snapshot, post_started_at: prepared.outbox.post_started_at!, presentation_external_id: `echo:${approval_id}` });
    context.state.markControlPlaneStaged({ candidate_id: input.candidate.candidate_id, control_approval_sha256: canonicalSha256({ kind: 'echo-person-meeting-review-v1', approval_id, frozen_card_sha256 }) });
    return { kind: 'staged' as const, stage_id: `echo:${approval_id}` };
  }
  function resolve(request: PersonMeetingReviewActionV1, authorize: () => PersonConnectionAuthorizationV1) {
    authorize();
    const candidate = context.state.readFrozenCandidateForApproval(request.approval_id);
    const result = database.transaction(() => {
      const actor = authorize();
      const owner = database.prepare(`SELECT a.organization_id,a.principal_id,a.membership_id,o.state,o.approved_snapshot_sha256 FROM authority_live_source_admission_v2 a
        JOIN authority_live_source_candidates_v2 c ON c.admission_semantic_input_sha256=a.semantic_input_sha256
        JOIN authority_live_approval_outbox_v2 o ON o.candidate_id=c.candidate_id WHERE o.approval_id=?`).get(request.approval_id) as (PersonConnectionAuthorizationV1 & { state: string; approved_snapshot_sha256: string }) | undefined;
      if (!candidate || !owner || actor.organization_id !== owner.organization_id || actor.principal_id !== owner.principal_id || actor.membership_id !== owner.membership_id || candidate.presentation_external_id !== `echo:${request.approval_id}`) denied();
      const old = database.prepare('SELECT * FROM authority_person_meeting_approval_actions_v1 WHERE approval_id=? OR command_id=?').all(request.approval_id, request.command_id) as ActionRow[];
      if (old.length > 0) {
        if (old.length !== 1 || canonicalJson((JSON.parse(old[0]!.body_json) as ActionBody).request) !== canonicalJson(request)) throw new AuthorityOperationError('stale_access_state', 'Meeting review has already been resolved');
        return { status: request.action === 'reject' ? 'rejected' : old[0]!.receipt_json === null ? 'publishing' : 'approved' };
      }
      if (owner.state !== 'staged' || owner.approved_snapshot_sha256 !== request.snapshot_sha256 || candidate.approved_snapshot_sha256 !== request.snapshot_sha256) throw new AuthorityOperationError('stale_access_state', 'Meeting review has changed');
      if (request.action === 'reject' && (request.project_id !== null || request.share_transcript)) throw new AuthorityOperationError('invalid_request', 'Rejection cannot share meeting content');
      const body: ActionBody = { request, authorization: actor, approved_at: new Date().toISOString() };
      authorize();
      database.prepare('INSERT INTO authority_person_meeting_approval_actions_v1(approval_id,command_id,body_json) VALUES (?,?,?)').run(request.approval_id, request.command_id, canonicalJson(body));
      return { status: request.action === 'reject' ? 'rejected' : 'publishing' };
    }).immediate();
    // The wake is observational and must run only after the action is durable.
    try { context.on_terminal_action_queued?.(); } catch { /* periodic recovery remains authoritative */ }
    return result;
  }
  async function appendPending(signal: AbortSignal) {
    const rows = database.prepare(`SELECT a.* FROM authority_person_meeting_approval_actions_v1 a
      JOIN authority_live_approval_outbox_v2 o ON o.approval_id=a.approval_id JOIN authority_live_source_candidates_v2 c ON c.candidate_id=o.candidate_id
      JOIN authority_live_source_admission_v2 admission ON admission.semantic_input_sha256=c.admission_semantic_input_sha256
      WHERE admission.source_key=? AND a.receipt_json IS NULL
      AND json_extract(a.body_json,'$.request.action')='approve' ORDER BY sequence LIMIT 25`).all(sourceKey) as ActionRow[];
    for (const row of rows) {
      signal.throwIfAborted();
      const frozen = context.state.readFrozenCandidateForApproval(row.approval_id);
      if (!frozen) continue;
      const body = JSON.parse(row.body_json) as ActionBody;
      if (frozen.approved_snapshot_sha256 !== body.request.snapshot_sha256) throw new Error('Frozen review changed after the human action');
      const transcript_source = retainedMeetingSourceCoordinateV1(database, context.coordinates.organization_id, frozen.meeting);
      if (transcript_source === undefined) throw new Error('Reviewed meeting is not retained under its exact source revision');
      const project = body.request.project_id;
      const policy_id = project === null ? RESTRICTED_REVIEWER_PERSON_POLICY_ID : PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
      const policy_contract_sha256 = project === null ? restrictedReviewerPersonPolicyContractSha256() : projectMembersReadablePersonPolicyContractSha256();
      const consequence = { schema_version: 2 as const, kind: PERSON_MEETING_APPROVAL_CONSEQUENCE_KIND_V1, policy_id,
        audience_project_ids: project === null ? [] : [project], association_project_ids: project === null ? [] : [project], share_transcript: body.request.share_transcript,
        transcript_source };
      const action_sha256 = canonicalSha256(body.request), authorization_sha256 = canonicalSha256(body.authorization);
      const audit = { approval_id: row.approval_id, event_id: `audit:${row.command_id}`, sequence: row.sequence, action_sha256, authorization_sha256, approved_at: body.approved_at };
      const human = validatePersonMeetingApprovalRecordInputV1({ person_meeting_approval_resolution_ref_v1: {
        schema_version: 1, kind: PERSON_MEETING_APPROVAL_REF_KIND_V1, ...context.coordinates, approval_id: row.approval_id, command_id: row.command_id, action: 'approve',
        candidate_sha256: frozen.candidate_semantic_sha256, frozen_card_sha256: frozen.frozen_card_sha256, approved_snapshot_sha256: frozen.approved_snapshot_sha256,
        final_approver: { principal_id: body.authorization.principal_id, membership_id: body.authorization.membership_id }, selected_policy_id: policy_id, policy_contract_sha256,
        policy_consequence_sha256: canonicalSha256(consequence), audience_project_ids: consequence.audience_project_ids, association_project_ids: consequence.association_project_ids,
        share_transcript: consequence.share_transcript, transcript_source: consequence.transcript_source, audit_event_id: audit.event_id, audit_sequence: audit.sequence,
        audit_entry_sha256: canonicalSha256(audit), provider_action_kind: 'echo-person-meeting-approval-action-v1', provider_action_schema_version: 1,
        provider_action_sha256: action_sha256, authorization_proof_sha256: authorization_sha256, approved_at: body.approved_at,
      }, event: { kind: 'approved', approved_snapshot: frozen.approved_snapshot, approved_snapshot_sha256: frozen.approved_snapshot_sha256,
        policy_id, policy_contract_sha256, policy_consequence: consequence, policy_consequence_sha256: canonicalSha256(consequence) } });
      const provenance = frozen.meeting.provenance, processor = frozen.decisions.processor;
      const result = await context.record_append.append({ approval_id: row.approval_id, action: 'approve', semantic_idempotency_key: human.semantic_idempotency_key,
        receipt_issued_at: body.approved_at, authorization_witness: { action: body.request, authorization: body.authorization, audit },
        envelope_factory: createRecordEnvelopeFactoryV4(factories, { issued_at: body.approved_at,
          human_act_record_input: { person_meeting_approval_resolution_ref_v1: human.person_meeting_approval_resolution_ref_v1, event: human.event },
          source_provenance: { schema_version: 1, kind: 'echo-meeting-source-provenance-v1', ...context.coordinates, source_adapter_kind: 'meeting-source', source_adapter_id: provenance.source.adapter_id,
            source_adapter_instance_id: provenance.source.instance_id, source_adapter_version: provenance.source.version, external_id: provenance.external_id,
            canonical_revision: provenance.canonical_revision, normalizer_version: provenance.normalizer_version, source_revision: provenance.source_revision ?? null },
          processor_provenance: { schema_version: 1, kind: 'echo-decision-processor-provenance-v1', ...context.coordinates, processor_adapter_kind: 'decision-processor',
            processor_adapter_id: processor.adapter_id, processor_adapter_instance_id: processor.instance_id, processor_adapter_version: processor.version,
            processor_contract_sha256: frozen.admission.processor.configuration_sha256 as Sha256Digest },
        }, context.next_envelope_id), receipt_factory: createRecordReceiptFactoryV2(factories) });
      database.prepare('UPDATE authority_person_meeting_approval_actions_v1 SET receipt_json=? WHERE approval_id=? AND receipt_json IS NULL').run(canonicalJson(result.receipt), row.approval_id);
    }
  }
  const components: ApprovalWorkflowComponentsV1 = {
    stager: { stage, async reconcilePendingDeliveries() { for (const item of context.state.listPendingApprovalDeliveries()) await stage({ admission: item.admission, candidate: item, meeting: item.meeting, decisions: item.decisions }); },
      async reconcileSuperseded() { for (const item of context.state.listPendingSupersededApprovalCards()) if (item.presentation_external_id !== null) context.state.recordSupersededApprovalCardTombstoned({ approval_id: item.approval_id, presentation_external_id: `echo:${item.approval_id}` }); } },
    processing: { recoverV4Appends: appendPending, appendFinalizedApprovalsToV4: appendPending, async observeAndFinalizePendingApprovals() {} },
  };
  return Object.freeze({ ...components, resolve });
}
