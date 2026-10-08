import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256, type JsonValue } from '@echo-brain/federation-protocol';
import {
  APPROVAL_DECISION_FIELD_V1, PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, createRecordEnvelopeFactoryV4, createRecordReceiptFactoryV2,
  organizationAuthorityPinSha256, organizationMemberReadablePersonPolicyContractSha256, projectMembersReadablePersonPolicyContractSha256, verifyOrganizationAuthorityPin,
  validateApprovalDecisionRecordInputV1, APPROVAL_DECISION_CONSEQUENCE_KIND_V1,
} from '@echo-brain/organization-protocol';
import { approvalCoreFixture, type ApprovalCoreFixtureV1 } from './fixtures/approval-core.js';
import type { ApprovalDecisionBodyV1 } from '../src/composition/approval-core-v1.js';
import {
  approvalDecisionWitnessV1, buildApprovalDecisionRecordV1, createApprovalDecisionPolicyProjectorV1, projectApprovalDecisionApproverV1, type ApprovalDecisionWitnessV1,
} from '../src/composition/approval-decision-projection-v1.js';
import { AUTHORITY_RECORD_INPUT_CODECS_V1, authorityRecordPolicyProjectorsV1 } from '../src/composition/authority-record-protocols-v1.js';

const signal = () => new AbortController().signal;
type Mutable = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The stored decision row and frozen proposal of the fixture's one decision, as the publisher reads them. */
function source(f: ApprovalCoreFixtureV1) {
  const row = f.db.prepare('SELECT sequence, body_json FROM authority_approval_decisions_v1 WHERE approval_id=?').get(f.approvalId) as { sequence: number; body_json: string };
  const frozen = f.context.state.readFrozenCandidateForApproval(f.approvalId)!;
  return { coordinates: f.context.coordinates, decision: { sequence: row.sequence, body: JSON.parse(row.body_json) as ApprovalDecisionBodyV1 },
    candidate_sha256: frozen.candidate_semantic_sha256 as `sha256:${string}`, approved_snapshot: frozen.approved_snapshot };
}
/** Appends a hand-made record input and witness through the fixture's real appender and the production codecs. */
async function appendRaw(f: ApprovalCoreFixtureV1, human_act_record_input: unknown, witness: unknown, key = canonicalSha256('raw')) {
  const descriptor = await f.context.signer.inspect();
  const options = { pinned_authority: verifyOrganizationAuthorityPin(descriptor, organizationAuthorityPinSha256(descriptor)), state_lineage_id: f.context.coordinates.state_lineage_id,
    sign: f.context.signer.sign.bind(f.context.signer), codecs: AUTHORITY_RECORD_INPUT_CODECS_V1 };
  const frozen = f.context.state.readFrozenCandidateForApproval(f.approvalId)!;
  const provenance = frozen.meeting.provenance, processor = frozen.decisions.processor;
  return f.context.record_append.append({ approval_id: f.approvalId, action: 'approve', semantic_idempotency_key: key, receipt_issued_at: '2026-10-07T09:00:00.000Z',
    authorization_witness: witness as JsonValue,
    envelope_factory: createRecordEnvelopeFactoryV4(options, { issued_at: '2026-10-07T09:00:00.000Z', human_act_record_input: human_act_record_input as never,
      source_provenance: { schema_version: 1, kind: 'echo-meeting-source-provenance-v1', ...f.context.coordinates, source_adapter_kind: 'meeting-source', source_adapter_id: provenance.source.adapter_id,
        source_adapter_instance_id: provenance.source.instance_id, source_adapter_version: provenance.source.version, external_id: provenance.external_id,
        canonical_revision: provenance.canonical_revision, normalizer_version: provenance.normalizer_version, source_revision: provenance.source_revision ?? null },
      processor_provenance: { schema_version: 1, kind: 'echo-decision-processor-provenance-v1', ...f.context.coordinates, processor_adapter_kind: 'decision-processor',
        processor_adapter_id: processor.adapter_id, processor_adapter_instance_id: processor.instance_id, processor_adapter_version: processor.version,
        processor_contract_sha256: frozen.admission.processor.configuration_sha256 as `sha256:${string}` } } as never, () => 'envelope-raw'),
    receipt_factory: createRecordReceiptFactoryV2(options) });
}

describe('approval decision projection', () => {
  it('projects one reviewer fact per signal for Only me and project facts for projects', async () => {
    for (const projects of [[], ['A']] as const) {
      const f = await approvalCoreFixture();
      f.core.decide('desktop', f.approve({ project_ids: projects.map(name => f.project(name)) }), () => f.session);
      await f.core.processing.appendFinalizedApprovalsToV4(signal());
      const brief = JSON.parse(f.core.proposal(f.approvalId)!.snapshot_json).approved_payload.brief;
      const signals = brief.decisions.length + brief.actions.length + brief.rationales.length;
      const reviewer = f.record.prepare('SELECT * FROM organization_record_restricted_reviewer_person_fact ORDER BY atom_order').all() as Record<string, unknown>[];
      const project = f.record.prepare('SELECT * FROM organization_record_project_members_readable_person_fact ORDER BY atom_order').all() as Record<string, unknown>[];
      if (projects.length === 0) {
        expect(reviewer).toHaveLength(signals);
        expect(project).toHaveLength(0);
        expect(reviewer.every(fact => fact.reviewer_principal_id === f.actor.principal_id && fact.reviewer_membership_id === f.actor.membership_id)).toBe(true);
      } else {
        expect(project).toHaveLength(signals);
        expect(reviewer).toHaveLength(0);
        expect(f.record.prepare('SELECT project_id FROM organization_record_project_members_readable_person_record_fact').pluck().all()).toEqual([f.projectA]);
        expect(f.record.prepare('SELECT project_id FROM organization_record_project_association_v1').pluck().all()).toEqual([f.projectA]);
      }
    }
  });
  it.each<[string, (w: { decision: Mutable; evidence: Mutable; audit: Mutable } & Mutable) => void]>([
    ['decision.owners', w => { w.decision.owners = [{ signal_id: 'act-1', owner: 'Mallory' }]; }],
    ['decision.project_ids', w => { w.decision.project_ids = ['prj_00000000-0000-4000-8000-0000000000b1']; }],
    ['decision.share_transcript', w => { w.decision.share_transcript = true; }],
    ['decision.command_id', w => { w.decision.command_id = 'desk-other'; }],
    ['decision.snapshot_sha256', w => { w.decision.snapshot_sha256 = canonicalSha256('other'); }],
    ['an extra decision key', w => { w.decision.note = 'x'; }],
    ['evidence.surface', w => { w.evidence.surface = 'slack'; }],
    ['evidence.kind for the surface', w => { w.evidence.kind = 'slack-click'; }],
    ['evidence.principal_id', w => { w.evidence.principal_id = 'prn_00000000-0000-4000-8000-0000000000ff'; }],
    ['evidence.sha256 format', w => { w.evidence.sha256 = 'not-a-digest'; }],
    ['audit.sequence', w => { w.audit.sequence = (w.audit.sequence as number) + 1; }],
    ['audit.approved_at', w => { w.audit.approved_at = '2026-10-07T09:59:00.000Z'; }],
    ['audit.event_id', w => { w.audit.event_id = 'audit:other'; }],
    ['an extra witness key', w => { w.extra = {}; }],
  ])('refuses a witness that differs from its record: %s', async (_label, tamper) => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno' } });
    f.core.decide('desktop', f.approve({ owners: [{ signal_id: 'act-1', owner: 'Rafael' }] }), () => f.session);
    const tampered = f.withAppend((input, append) => {
      const witness = clone(input.authorization_witness) as { decision: Mutable; evidence: Mutable; audit: Mutable } & Mutable;
      tamper(witness);
      return append({ ...input, authorization_witness: witness });
    });
    await expect(tampered.processing.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('Approval decision witness differs from its record');
    expect(f.recordCount()).toBe(0);
  });
  it.each(['decision', 'evidence', 'audit'] as const)('refuses a witness whose %s digest differs from the reference', async (part) => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const built = buildApprovalDecisionRecordV1(source(f));
    const ref = clone(built.human_act_record_input.approval_decision_ref_v1) as unknown as Mutable;
    const field = { decision: 'provider_action_sha256', evidence: 'authorization_proof_sha256', audit: 'audit_entry_sha256' }[part];
    ref[field] = canonicalSha256(`other ${part}`);
    // The audit witness carries the action and authorization digests, so the record must stay internally consistent to reach the digest check.
    const witness = clone(built.authorization_witness) as unknown as { audit: Mutable };
    if (part === 'decision') witness.audit.action_sha256 = ref[field];
    if (part === 'evidence') witness.audit.authorization_sha256 = ref[field];
    if (part !== 'audit') ref.audit_entry_sha256 = canonicalSha256(witness.audit as JsonValue);
    const input = { [APPROVAL_DECISION_FIELD_V1]: ref, event: built.human_act_record_input.event };
    await expect(appendRaw(f, input, witness, canonicalSha256(ref as JsonValue))).rejects.toThrow('Approval decision witness differs from its record');
    expect(f.recordCount()).toBe(0);
  });
  it('refuses a hand-built reference whose policy does not follow the choice', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const built = buildApprovalDecisionRecordV1(source(f));
    for (const [policy_id, policy_contract_sha256] of [[PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, projectMembersReadablePersonPolicyContractSha256()],
      [ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, organizationMemberReadablePersonPolicyContractSha256()]] as const) {
      const event = clone(built.human_act_record_input.event) as unknown as Mutable;
      const consequence = { ...(event.policy_consequence as Mutable), kind: APPROVAL_DECISION_CONSEQUENCE_KIND_V1, policy_id };
      Object.assign(event, { policy_id, policy_contract_sha256, policy_consequence: consequence, policy_consequence_sha256: canonicalSha256(consequence as JsonValue) });
      const ref = { ...clone(built.human_act_record_input.approval_decision_ref_v1), selected_policy_id: policy_id, policy_contract_sha256,
        policy_consequence_sha256: event.policy_consequence_sha256 } as unknown as Mutable;
      const input = { [APPROVAL_DECISION_FIELD_V1]: ref, event };
      expect(() => validateApprovalDecisionRecordInputV1(input)).toThrow();
      await expect(appendRaw(f, input, built.authorization_witness, canonicalSha256(ref as JsonValue))).rejects.toThrow();
    }
    expect(f.recordCount()).toBe(0);
  });
  it('approver projector returns the final approver and nothing for another kind or coordinates', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    const record = f.lastRecord();
    expect(projectApprovalDecisionApproverV1(record)).toEqual({ ...f.context.coordinates, approval_id: f.approvalId, principal_id: f.actor.principal_id, membership_id: f.actor.membership_id });
    const other = clone(record); other.body.state_lineage_id = 'another-lineage';
    expect(projectApprovalDecisionApproverV1(other)).toBeUndefined();
    const kind = clone(record); kind.body.human_act_resolution_ref.kind = 'echo-unknown-ref-v1';
    expect(projectApprovalDecisionApproverV1(kind)).toBeUndefined();
    expect(projectApprovalDecisionApproverV1({ body: 'nothing' })).toBeUndefined();
  });
  it('policyBinding names the selected policy', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ project_ids: [f.projectA] }), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    const record = f.lastRecord();
    expect(createApprovalDecisionPolicyProjectorV1().policyBinding(record)).toEqual({ policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, policy_contract_sha256: projectMembersReadablePersonPolicyContractSha256() });
    expect(authorityRecordPolicyProjectorsV1().policyBinding(record).policy_id).toBe(PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
    expect(createApprovalDecisionPolicyProjectorV1().matches({ ...record, body: { ...record.body, human_act_resolution_ref: { ...record.body.human_act_resolution_ref, schema_version: 2 } } })).toBe(false);
  });
  it('approvalDecisionWitnessV1 and buildApprovalDecisionRecordV1 are deterministic', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno' } });
    f.core.decide('slack', f.approve({ command_id: 'slack:k1', owners: [{ signal_id: 'act-1', owner: 'Rafael' }] }), () => f.click);
    const input = source(f);
    const witness: ApprovalDecisionWitnessV1 = approvalDecisionWitnessV1(input.decision);
    expect(Object.keys(witness).sort()).toEqual(['audit', 'decision', 'evidence']);
    expect(witness.decision).toEqual(input.decision.body.request);
    expect(witness.evidence).toEqual({ surface: 'slack', organization_id: f.actor.organization_id, principal_id: f.actor.principal_id, membership_id: f.actor.membership_id,
      kind: 'slack-click', sha256: f.click.evidence.sha256 });
    expect(witness.audit).toMatchObject({ approval_id: f.approvalId, event_id: 'audit:slack:k1', sequence: input.decision.sequence, approved_at: input.decision.body.decided_at,
      action_sha256: canonicalSha256(witness.decision as unknown as JsonValue), authorization_sha256: canonicalSha256(witness.evidence as unknown as JsonValue) });
    expect(canonicalJson(approvalDecisionWitnessV1(clone(input.decision)) as unknown as JsonValue)).toBe(canonicalJson(witness as unknown as JsonValue));
    const once = buildApprovalDecisionRecordV1(input), twice = buildApprovalDecisionRecordV1(clone(input));
    expect(canonicalJson(twice as unknown as JsonValue)).toBe(canonicalJson(once as unknown as JsonValue));
    expect(once.semantic_idempotency_key).toBe(canonicalSha256(once.human_act_record_input.approval_decision_ref_v1 as unknown as JsonValue));
    expect(once.human_act_record_input.approval_decision_ref_v1).toMatchObject({ surface: 'slack', command_id: 'slack:k1', action_owners: [{ signal_id: 'act-1', owner: 'Rafael' }] });
  });
  it('buildApprovalDecisionRecordV1 refuses a reject, a missing transcript source and another snapshot', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const input = source(f);
    const reject = clone(input); (reject.decision.body.request as unknown as Mutable).action = 'reject';
    expect(() => buildApprovalDecisionRecordV1(reject)).toThrow('Only an approval writes a record');
    const missing = clone(input); (missing.decision.body as unknown as Mutable).transcript_source = null;
    expect(() => buildApprovalDecisionRecordV1(missing)).toThrow('no frozen transcript source');
    const absent = clone(input); delete (absent.decision.body as unknown as Mutable).transcript_source;
    expect(() => buildApprovalDecisionRecordV1(absent)).toThrow('no frozen transcript source');
    const other = clone(input); (other.decision.body.request as unknown as Mutable).snapshot_sha256 = canonicalSha256('other');
    expect(() => buildApprovalDecisionRecordV1(other)).toThrow('another frozen snapshot');
  });
});
