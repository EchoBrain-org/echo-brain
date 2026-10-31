import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256, type JsonValue } from '@echo-brain/federation-protocol';
import {
  APPROVAL_DECISION_FIELD_V2, PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, createRecordEnvelopeFactoryV4, createRecordReceiptFactoryV2,
  organizationAuthorityPinSha256, organizationMemberReadablePersonPolicyContractSha256, projectMembersReadablePersonPolicyContractSha256, verifyOrganizationAuthorityPin,
  validateApprovalDecisionRecordInputV2, approvalRecordIdV2, APPROVAL_DECISION_CONSEQUENCE_KIND_V1, validateApprovedDecisionSnapshotV2,
} from '@echo-brain/organization-protocol';
import { approvalCoreFixture, type ApprovalCoreFixtureV1 } from './fixtures/approval-core.js';
import type { ApprovalDecisionBodyV1, ApprovalRouteV1 } from '../src/composition/approval-core-v1.js';
import {
  approvalDecisionGroupsV1, approvalDecisionWitnessV1, buildApprovalDecisionRecordsV1, createApprovalDecisionPolicyProjectorV1, projectApprovalDecisionApproverV1,
  type ApprovalDecisionWitnessV1, type BuiltApprovalDecisionRecordV1,
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
/** Appends a hand-made record input and witness through the fixture's real appender and the production codecs, under its reference's approval id. */
async function appendRaw(f: ApprovalCoreFixtureV1, human_act_record_input: { readonly [APPROVAL_DECISION_FIELD_V2]: Mutable } & Mutable, witness: unknown, key = canonicalSha256('raw')) {
  const descriptor = await f.context.signer.inspect();
  const options = { pinned_authority: verifyOrganizationAuthorityPin(descriptor, organizationAuthorityPinSha256(descriptor)), state_lineage_id: f.context.coordinates.state_lineage_id,
    sign: f.context.signer.sign.bind(f.context.signer), codecs: AUTHORITY_RECORD_INPUT_CODECS_V1 };
  const frozen = f.context.state.readFrozenCandidateForApproval(f.approvalId)!;
  const provenance = frozen.meeting.provenance, processor = frozen.decisions.processor;
  return f.context.record_append.append({ approval_id: human_act_record_input[APPROVAL_DECISION_FIELD_V2].approval_id as string, action: 'approve', semantic_idempotency_key: key,
    receipt_issued_at: '2026-10-07T09:00:00.000Z', authorization_witness: witness as JsonValue,
    envelope_factory: createRecordEnvelopeFactoryV4(options, { issued_at: '2026-10-07T09:00:00.000Z', human_act_record_input: human_act_record_input as never,
      source_provenance: { schema_version: 1, kind: 'echo-meeting-source-provenance-v1', ...f.context.coordinates, source_adapter_kind: 'meeting-source', source_adapter_id: provenance.source.adapter_id,
        source_adapter_instance_id: provenance.source.instance_id, source_adapter_version: provenance.source.version, external_id: provenance.external_id,
        canonical_revision: provenance.canonical_revision, normalizer_version: provenance.normalizer_version, source_revision: provenance.source_revision ?? null },
      processor_provenance: { schema_version: 1, kind: 'echo-decision-processor-provenance-v1', ...f.context.coordinates, processor_adapter_kind: 'decision-processor',
        processor_adapter_id: processor.adapter_id, processor_adapter_instance_id: processor.instance_id, processor_adapter_version: processor.version,
        processor_contract_sha256: frozen.admission.processor.configuration_sha256 as `sha256:${string}` } } as never, () => 'envelope-raw'),
    receipt_factory: createRecordReceiptFactoryV2(options) });
}

/** A built record whose subset brief was reshaped and kept internally consistent (its digests, reference and key follow it). */
function reshaped(built: BuiltApprovalDecisionRecordV1, reshape: (brief: { decisions: Mutable[]; actions: Mutable[]; rationales: Mutable[] }) => void) {
  const ref = clone(built.human_act_record_input.approval_decision_ref_v2) as unknown as Mutable;
  const event = clone(built.human_act_record_input.event) as unknown as Mutable & { approved_snapshot: Mutable & { approved_payload: Mutable & { brief: { decisions: Mutable[]; actions: Mutable[]; rationales: Mutable[] } } } };
  reshape(event.approved_snapshot.approved_payload.brief);
  event.approved_snapshot.final_content_sha256 = canonicalSha256(event.approved_snapshot.approved_payload as unknown as JsonValue);
  event.approved_snapshot_sha256 = ref.approved_snapshot_sha256 = canonicalSha256(event.approved_snapshot as unknown as JsonValue);
  return { input: { [APPROVAL_DECISION_FIELD_V2]: ref, event }, key: canonicalSha256(ref as JsonValue) };
}

describe('approval decision projection', () => {
  it('projects one reviewer fact per signal for Only me and project facts for projects', async () => {
    for (const projects of [[], ['A']] as const) {
      const f = await approvalCoreFixture();
      f.core.decide('desktop', f.approve({ routes: f.routes(projects.map(name => f.project(name))) }), () => f.session);
      await f.core.processing.appendFinalizedApprovalsToV4(signal());
      const brief = JSON.parse(f.core.proposal(f.approvalId)!.snapshot_json).approved_payload.brief;
      const signals = brief.decisions.length + brief.actions.length + brief.rationales.length;
      const reviewer = f.record.prepare('SELECT * FROM organization_record_restricted_reviewer_person_fact ORDER BY atom_order').all() as Record<string, unknown>[];
      const project = f.record.prepare('SELECT * FROM organization_record_project_members_readable_person_fact ORDER BY atom_order').all() as Record<string, unknown>[];
      // Facts carry the record's own approval id.
      const own = approvalRecordIdV2(f.approvalId, projects.map(name => f.project(name)));
      if (projects.length === 0) {
        expect(reviewer).toHaveLength(signals);
        expect(project).toHaveLength(0);
        expect(reviewer.every(fact => fact.reviewer_principal_id === f.actor.principal_id && fact.reviewer_membership_id === f.actor.membership_id && fact.approval_id === own)).toBe(true);
      } else {
        expect(project).toHaveLength(signals);
        expect(reviewer).toHaveLength(0);
        expect(project.every(fact => fact.approval_id === own)).toBe(true);
        expect(f.record.prepare('SELECT project_id FROM organization_record_project_members_readable_person_record_fact').pluck().all()).toEqual([f.projectA]);
        expect(f.record.prepare('SELECT project_id FROM organization_record_project_association_v1').pluck().all()).toEqual([f.projectA]);
      }
    }
  });
  it('projects reviewer facts and association rows, and no audience fact, for items kept private inside a project', async () => {
    const f = await approvalCoreFixture();
    const routes = f.routes([f.projectA]).map(route => ({ ...route, private: true as const }));
    f.core.decide('desktop', f.approve({ routes }), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    const own = approvalRecordIdV2(f.approvalId, [f.projectA], true);
    const reviewer = f.record.prepare('SELECT * FROM organization_record_restricted_reviewer_person_fact ORDER BY atom_order').all() as Record<string, unknown>[];
    expect(reviewer.length).toBeGreaterThan(0);
    expect(reviewer.every(fact => fact.reviewer_principal_id === f.actor.principal_id && fact.reviewer_membership_id === f.actor.membership_id && fact.approval_id === own)).toBe(true);
    expect(f.record.prepare('SELECT count(*) FROM organization_record_project_members_readable_person_fact').pluck().get()).toBe(0);
    expect(f.record.prepare('SELECT count(*) FROM organization_record_project_members_readable_person_record_fact').pluck().get()).toBe(0);
    expect(f.record.prepare('SELECT project_id FROM organization_record_project_association_v1').pluck().all()).toEqual([f.projectA]);
    expect(f.lastRecord().body.human_act_resolution_ref).toMatchObject({ approval_id: own, selected_policy_id: 'restricted-reviewer-person-v2', audience_project_ids: [], association_project_ids: [f.projectA] });
  });
  it.each<[string, (routes: Mutable[]) => Mutable[]]>([
    ['the private route made plain', routes => routes.map(({ private: _kept, ...route }) => route)],
    ['the private route made private: false', routes => routes.map(route => ({ ...route, private: false }))],
    ['the private route made private: "true"', routes => routes.map(route => route.signal_id === 'act-2' ? route : { ...route, private: 'true' })],
    ['a plain route made private', routes => routes.map(route => route.signal_id === 'act-2' ? { ...route, private: true } : route)],
  ])('refuses a private record whose witness routes differ: %s', async (_label, change) => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ routes: f.routes([f.projectA]).map(route => route.signal_id === 'act-2' ? route : { ...route, private: true as const }) }), () => f.session);
    const tampered = f.withAppend((input, append) => {
      const witness = clone(input.authorization_witness) as { decision: Mutable } & Mutable;
      witness.decision.routes = change(witness.decision.routes as Mutable[]);
      return append({ ...input, authorization_witness: witness });
    });
    await expect(tampered.processing.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('Approval decision witness differs from its record');
    expect(f.recordCount()).toBe(0);
  });
  it('refuses a private record rebuilt as shared, and a shared one rebuilt as private, under either id', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ routes: f.routes(id => id === 'act-2' ? [f.projectA] : [f.projectA]).map(route => route.signal_id === 'act-2' ? route : { ...route, private: true as const }) }), () => f.session);
    const [kept, shared] = buildApprovalDecisionRecordsV1(source(f));
    expect([kept!.private, shared!.private]).toEqual([true, undefined]);
    expect(kept!.human_act_record_input.approval_decision_ref_v2).toMatchObject({ selected_policy_id: 'restricted-reviewer-person-v2', audience_project_ids: [], association_project_ids: [f.projectA] });
    expect(shared!.human_act_record_input.approval_decision_ref_v2).toMatchObject({ selected_policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, audience_project_ids: [f.projectA] });
    // The private record with the shared record's id and the project audience: the codec takes it as the shared destination, and the projector refuses it.
    const reshare = (built: BuiltApprovalDecisionRecordV1, from: BuiltApprovalDecisionRecordV1) => {
      const ref = { ...clone(built.human_act_record_input.approval_decision_ref_v2), approval_id: from.approval_id, selected_policy_id: from.human_act_record_input.event.policy_id,
        policy_contract_sha256: from.human_act_record_input.event.policy_contract_sha256, policy_consequence_sha256: from.human_act_record_input.event.policy_consequence_sha256,
        audience_project_ids: from.human_act_record_input.approval_decision_ref_v2.audience_project_ids } as unknown as Mutable;
      const event = { ...clone(built.human_act_record_input.event), policy_id: from.human_act_record_input.event.policy_id, policy_contract_sha256: from.human_act_record_input.event.policy_contract_sha256,
        policy_consequence: from.human_act_record_input.event.policy_consequence, policy_consequence_sha256: from.human_act_record_input.event.policy_consequence_sha256 } as unknown as Mutable;
      const snapshot = { ...(event.approved_snapshot as Mutable), approval_id: from.approval_id };
      event.approved_snapshot = snapshot;
      event.approved_snapshot_sha256 = ref.approved_snapshot_sha256 = canonicalSha256(snapshot as JsonValue);
      return { input: { [APPROVAL_DECISION_FIELD_V2]: ref, event }, key: canonicalSha256(ref as JsonValue) };
    };
    for (const [built, from] of [[kept!, shared!], [shared!, kept!]] as const) {
      const { input, key } = reshare(built, from);
      await expect(appendRaw(f, input, built.authorization_witness, key)).rejects.toThrow();
    }
    expect(f.recordCount()).toBe(0);
    // The private record as built appends.
    await expect(appendRaw(f, clone(kept!.human_act_record_input) as never, kept!.authorization_witness, kept!.semantic_idempotency_key)).resolves.toMatchObject({ outcome: 'appended' });
  });
  it.each<[string, (w: { decision: Mutable; evidence: Mutable; audit: Mutable } & Mutable) => void]>([
    ['decision.owners', w => { w.decision.owners = [{ signal_id: 'act-1', owner: 'Mallory' }]; }],
    ['decision.routes, to another destination', w => { w.decision.routes = (w.decision.routes as Mutable[]).map(route => ({ ...route, project_ids: ['prj_00000000-0000-4000-8000-0000000000b1'] })); }],
    ['decision.routes, an item moved away', w => { w.decision.routes = (w.decision.routes as Mutable[]).map(route => route.signal_id === 'act-2' ? { ...route, project_ids: null } : route); }],
    ['decision.routes, an item moved in', w => { w.decision.routes = [...(w.decision.routes as Mutable[]), { signal_id: 'act-9', project_ids: [] }]; }],
    ['decision.approval_id', w => { w.decision.approval_id = `apr_${'b'.repeat(64)}`; }],
    ['decision.command_id', w => { w.decision.command_id = 'desk-other'; }],
    ['decision.snapshot_sha256', w => { w.decision.snapshot_sha256 = canonicalSha256('other'); }],
    ['an extra decision key', w => { w.decision.note = 'x'; }],
    ['the v1 decision shape', w => { delete w.decision.routes; w.decision.project_ids = []; w.decision.share_transcript = false; }],
    ['evidence.surface', w => { w.evidence.surface = 'slack'; }],
    ['evidence.kind for the surface', w => { w.evidence.kind = 'slack-click'; }],
    ['evidence.principal_id', w => { w.evidence.principal_id = 'prn_00000000-0000-4000-8000-0000000000ff'; }],
    ['evidence.sha256 format', w => { w.evidence.sha256 = 'not-a-digest'; }],
    ['audit.approval_id', w => { w.audit.approval_id = `apr_${'b'.repeat(64)}`; }],
    ['audit.sequence', w => { w.audit.sequence = (w.audit.sequence as number) + 1; }],
    ['audit.approved_at', w => { w.audit.approved_at = '2026-10-07T09:59:00.000Z'; }],
    ['audit.event_id', w => { w.audit.event_id = 'audit:other'; }],
    ['an extra witness key', w => { w.extra = {}; }],
    ['no proposal snapshot', w => { delete w.proposal_snapshot; }],
    ['a proposal snapshot that is not one', w => { w.proposal_snapshot = { note: 'x' }; }],
    ['another text in the proposal snapshot', w => { ((w.proposal_snapshot as { approved_payload: { brief: { actions: Mutable[] } } }).approved_payload.brief.actions[0]!).text = 'Send it to everyone.'; }],
    ['another proposal\'s snapshot', w => { (w.proposal_snapshot as Mutable).approval_id = `apr_${'b'.repeat(64)}`; }],
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
    const [built] = buildApprovalDecisionRecordsV1(source(f));
    const ref = clone(built!.human_act_record_input.approval_decision_ref_v2) as unknown as Mutable;
    const field = { decision: 'provider_action_sha256', evidence: 'authorization_proof_sha256', audit: 'audit_entry_sha256' }[part];
    ref[field] = canonicalSha256(`other ${part}`);
    // The audit witness carries the action and authorization digests, so the record must stay internally consistent to reach the digest check.
    const witness = clone(built!.authorization_witness) as unknown as { audit: Mutable };
    if (part === 'decision') witness.audit.action_sha256 = ref[field];
    if (part === 'evidence') witness.audit.authorization_sha256 = ref[field];
    if (part !== 'audit') ref.audit_entry_sha256 = canonicalSha256(witness.audit as JsonValue);
    const input = { [APPROVAL_DECISION_FIELD_V2]: ref, event: built!.human_act_record_input.event as unknown as Mutable };
    await expect(appendRaw(f, input, witness, canonicalSha256(ref as JsonValue))).rejects.toThrow('Approval decision witness differs from its record');
    expect(f.recordCount()).toBe(0);
  });
  it('refuses a hand-built reference whose policy does not follow the choice', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const [built] = buildApprovalDecisionRecordsV1(source(f));
    for (const [policy_id, policy_contract_sha256] of [[PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, projectMembersReadablePersonPolicyContractSha256()],
      [ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, organizationMemberReadablePersonPolicyContractSha256()]] as const) {
      const event = clone(built!.human_act_record_input.event) as unknown as Mutable;
      const consequence = { ...(event.policy_consequence as Mutable), kind: APPROVAL_DECISION_CONSEQUENCE_KIND_V1, policy_id };
      Object.assign(event, { policy_id, policy_contract_sha256, policy_consequence: consequence, policy_consequence_sha256: canonicalSha256(consequence as JsonValue) });
      const ref = { ...clone(built!.human_act_record_input.approval_decision_ref_v2), selected_policy_id: policy_id, policy_contract_sha256,
        policy_consequence_sha256: event.policy_consequence_sha256 } as unknown as Mutable;
      const input = { [APPROVAL_DECISION_FIELD_V2]: ref, event };
      expect(() => validateApprovalDecisionRecordInputV2(input)).toThrow();
      await expect(appendRaw(f, input, built!.authorization_witness, canonicalSha256(ref as JsonValue))).rejects.toThrow();
    }
    expect(f.recordCount()).toBe(0);
  });
  it('refuses a record that claims a destination group the decision does not route', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ routes: f.routes(id => id === 'act-2' ? [] : [f.projectA]) }), () => f.session);
    const [first, second] = buildApprovalDecisionRecordsV1(source(f));
    // The second group's record with only the first group's items: it no longer holds exactly what the routes send it.
    const ref = { ...clone(second!.human_act_record_input.approval_decision_ref_v2), route_signal_ids: first!.human_act_record_input.approval_decision_ref_v2.route_signal_ids } as unknown as Mutable;
    await expect(appendRaw(f, { [APPROVAL_DECISION_FIELD_V2]: ref, event: second!.human_act_record_input.event as unknown as Mutable }, second!.authorization_witness,
      canonicalSha256(ref as JsonValue))).rejects.toThrow();
    expect(f.recordCount()).toBe(0);
  });
  it.each<[string, (brief: { decisions: Mutable[]; actions: Mutable[]; rationales: Mutable[] }, proposal: { rationales: readonly Mutable[] }) => void]>([
    ['changed text', brief => { brief.actions[0]!.text = 'Send the pilot plan to every customer.'; }],
    ['a reason moved from another group, its supports rewritten', (brief, proposal) => {
      brief.rationales.push({ ...proposal.rationales.find(reason => reason.id === 'reason-decision')!, supports_signal_ids: ['act-1'] });
    }],
    ['a reason that supports nothing, in a project group', (brief, proposal) => { brief.rationales.push({ ...proposal.rationales.find(reason => reason.id === 'reason-loose')! }); }],
  ])('refuses at append a project record whose content is not its share of the snapshot the reviewer saw: %s', async (_label, reshape) => {
    const f = await approvalCoreFixture({ rationales: [{ id: 'reason-decision', supports: ['decision-1'] }, { id: 'reason-actions', supports: ['act-1', 'act-2'] }, { id: 'reason-loose', supports: [] }] });
    // The decision goes to the reviewer alone and both actions to project A.
    f.core.decide('desktop', f.approve({ routes: f.routes(id => id === 'decision-1' ? [] : [f.projectA]) }), () => f.session);
    const built = buildApprovalDecisionRecordsV1(source(f));
    const project = built.find(record => record.project_ids.length === 1)!;
    expect(project.human_act_record_input.event.approved_snapshot.approved_payload.brief.rationales.map(reason => reason.id)).toEqual(['reason-actions']);
    const proposal = clone(source(f).approved_snapshot) as { approved_payload: { brief: { rationales: readonly Mutable[] } } };
    const { input, key } = reshaped(project, brief => reshape(brief, proposal.approved_payload.brief));
    // The record codec alone accepts it: only the projector, recomputing the subset from the witness, can tell.
    expect(() => validateApprovalDecisionRecordInputV2(input)).not.toThrow();
    await expect(appendRaw(f, input, project.authorization_witness, key)).rejects.toThrow('Approval decision witness differs from its record');
    expect(f.recordCount()).toBe(0);
    // The record as built appends.
    await expect(appendRaw(f, clone(project.human_act_record_input) as never, project.authorization_witness, project.semantic_idempotency_key)).resolves.toMatchObject({ outcome: 'appended' });
  });
  it('approver projector returns the final approver under the record approval id and nothing for another kind or coordinates; policyBinding names the selected policy', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ routes: f.routes([f.projectA]) }), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    const record = f.lastRecord();
    expect(projectApprovalDecisionApproverV1(record)).toEqual({ ...f.context.coordinates, approval_id: approvalRecordIdV2(f.approvalId, [f.projectA]),
      principal_id: f.actor.principal_id, membership_id: f.actor.membership_id });
    const other = clone(record); other.body.state_lineage_id = 'another-lineage';
    expect(projectApprovalDecisionApproverV1(other)).toBeUndefined();
    const kind = clone(record); kind.body.human_act_resolution_ref.kind = 'echo-approval-decision-ref-v1';
    expect(projectApprovalDecisionApproverV1(kind)).toBeUndefined();
    expect(projectApprovalDecisionApproverV1({ body: 'nothing' })).toBeUndefined();
    expect(createApprovalDecisionPolicyProjectorV1().policyBinding(record)).toEqual({ policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, policy_contract_sha256: projectMembersReadablePersonPolicyContractSha256() });
    expect(authorityRecordPolicyProjectorsV1().policyBinding(record).policy_id).toBe(PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
    for (const schema_version of [1, 3]) {
      expect(createApprovalDecisionPolicyProjectorV1().matches({ ...record, body: { ...record.body, human_act_resolution_ref: { ...record.body.human_act_resolution_ref, schema_version } } })).toBe(false);
    }
  });
  it('approvalDecisionWitnessV1 and buildApprovalDecisionRecordsV1 are deterministic', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno' } });
    f.core.decide('slack', f.approve({ command_id: 'slack:k1', routes: f.routes(id => id === 'act-1' ? [f.projectA] : []), owners: [{ signal_id: 'act-1', owner: 'Rafael' }] }), () => f.click);
    const input = source(f);
    const witness: ApprovalDecisionWitnessV1 = approvalDecisionWitnessV1(input.decision, validateApprovedDecisionSnapshotV2(input.approved_snapshot));
    expect(Object.keys(witness).sort()).toEqual(['audit', 'decision', 'evidence', 'proposal_snapshot']);
    // The snapshot the reviewer saw rides along, outside every digest the reference names.
    expect(witness.proposal_snapshot).toEqual(input.approved_snapshot);
    expect(canonicalSha256(witness.proposal_snapshot as unknown as JsonValue)).toBe(input.decision.body.request.snapshot_sha256);
    expect(witness.decision).toEqual(input.decision.body.request);
    expect(Object.keys(witness.decision).sort()).toEqual(['action', 'approval_id', 'command_id', 'owners', 'routes', 'snapshot_sha256']);
    expect(witness.evidence).toEqual({ surface: 'slack', organization_id: f.actor.organization_id, principal_id: f.actor.principal_id, membership_id: f.actor.membership_id,
      kind: 'slack-click', sha256: f.click.evidence.sha256 });
    expect(witness.audit).toMatchObject({ approval_id: f.approvalId, event_id: 'audit:slack:k1', sequence: input.decision.sequence, approved_at: input.decision.body.decided_at,
      action_sha256: canonicalSha256(witness.decision as unknown as JsonValue), authorization_sha256: canonicalSha256(witness.evidence as unknown as JsonValue) });
    expect(canonicalJson(approvalDecisionWitnessV1(clone(input.decision), validateApprovedDecisionSnapshotV2(clone(input.approved_snapshot))) as unknown as JsonValue))
      .toBe(canonicalJson(witness as unknown as JsonValue));
    const once = buildApprovalDecisionRecordsV1(input), twice = buildApprovalDecisionRecordsV1(clone(input));
    expect(canonicalJson(twice as unknown as JsonValue)).toBe(canonicalJson(once as unknown as JsonValue));
    expect(once.map(record => record.project_ids)).toEqual([[], [f.projectA]]);
    for (const record of once) {
      expect(record.semantic_idempotency_key).toBe(canonicalSha256(record.human_act_record_input.approval_decision_ref_v2 as unknown as JsonValue));
      expect(record.authorization_witness).toEqual(witness);
    }
    expect(once[1]!.human_act_record_input.approval_decision_ref_v2).toMatchObject({ surface: 'slack', command_id: 'slack:k1', action_owners: [{ signal_id: 'act-1', owner: 'Rafael' }] });
    expect(once[0]!.human_act_record_input.approval_decision_ref_v2.action_owners).toEqual([]);
  });
  it('groups kept routes by their exact project set, in the order of each group\'s first item', () => {
    const A = 'prj_00000000-0000-4000-8000-0000000000a1', B = 'prj_00000000-0000-4000-8000-0000000000b1', approval_id = `apr_${'c'.repeat(64)}`;
    const groups = approvalDecisionGroupsV1({ approval_id, routes: [
      { signal_id: 'd1', project_ids: [B] }, { signal_id: 'd2', project_ids: null }, { signal_id: 'd3', project_ids: [] },
      { signal_id: 'a1', project_ids: [A, B] }, { signal_id: 'a2', project_ids: [B] }, { signal_id: 'a3', project_ids: [] },
    ] });
    expect(groups).toEqual([
      { approval_id: approvalRecordIdV2(approval_id, [B]), project_ids: [B], signal_ids: ['d1', 'a2'] },
      { approval_id: approvalRecordIdV2(approval_id, []), project_ids: [], signal_ids: ['d3', 'a3'] },
      { approval_id: approvalRecordIdV2(approval_id, [A, B]), project_ids: [A, B], signal_ids: ['a1'] },
    ]);
    expect(approvalDecisionGroupsV1({ approval_id, routes: [{ signal_id: 'd1', project_ids: null }] })).toEqual([]);
    // Pinned before private routes existed (ADR-0049): the groups of routes without `private` are byte for byte what they were.
    expect(canonicalJson(groups as unknown as JsonValue)).toBe('[{"approval_id":"apr_f64eb3e8713ad1fd731c0fdb72e27655566e422e81eb8daec1d317ac324edbcb","project_ids":["prj_00000000-0000-4000-8000-0000000000b1"],"signal_ids":["d1","a2"]},{"approval_id":"apr_211f5279d7fdda4a4fb5654c868564c607e8a80636b7f3d68e616334cf44dbe8","project_ids":[],"signal_ids":["d3","a3"]},{"approval_id":"apr_27a3e3a263f2cf4c729da71b80d06342f095b501fba674b59fd722160cae0e50","project_ids":["prj_00000000-0000-4000-8000-0000000000a1","prj_00000000-0000-4000-8000-0000000000b1"],"signal_ids":["a1"]}]');
  });
  it('groups the same projects kept private apart from them shared, each under its own id', () => {
    const B = 'prj_00000000-0000-4000-8000-0000000000b1', approval_id = `apr_${'c'.repeat(64)}`;
    const groups = approvalDecisionGroupsV1({ approval_id, routes: [
      { signal_id: 'd1', project_ids: [B], private: true }, { signal_id: 'd2', project_ids: [B] }, { signal_id: 'a1', project_ids: [] }, { signal_id: 'a2', project_ids: [B], private: true },
    ] });
    expect(groups).toEqual([
      { approval_id: approvalRecordIdV2(approval_id, [B], true), project_ids: [B], private: true, signal_ids: ['d1', 'a2'] },
      { approval_id: approvalRecordIdV2(approval_id, [B]), project_ids: [B], signal_ids: ['d2'] },
      { approval_id: approvalRecordIdV2(approval_id, []), project_ids: [], signal_ids: ['a1'] },
    ]);
    expect(new Set(groups.map(group => group.approval_id)).size).toBe(3);
    expect(groups.map(group => Object.keys(group).sort().join())).toEqual(['approval_id,private,project_ids,signal_ids', 'approval_id,project_ids,signal_ids', 'approval_id,project_ids,signal_ids']);
  });
  it('gives the reasons that support no item to the Only-me group, else to the first private group alone', () => {
    const A = 'prj_00000000-0000-4000-8000-0000000000a1', B = 'prj_00000000-0000-4000-8000-0000000000b1', approval_id = `apr_${'c'.repeat(64)}`;
    const marks = (routes: readonly ApprovalRouteV1[]) => approvalDecisionGroupsV1({ approval_id, routes }).map(group => [group.project_ids, group.private === true, group.unsupported_reasons === true]);
    // Nothing kept for Only me: the first private group in group order takes them, and no other.
    expect(marks([{ signal_id: 'd1', project_ids: [B] }, { signal_id: 'd2', project_ids: [A], private: true }, { signal_id: 'a1', project_ids: [B], private: true },
      { signal_id: 'a2', project_ids: [A], private: true }])).toEqual([[[B], false, false], [[A], true, true], [[B], true, false]]);
    // With an item kept for Only me, that group takes them, unmarked as ever.
    expect(marks([{ signal_id: 'd1', project_ids: [A], private: true }, { signal_id: 'd2', project_ids: [] }])).toEqual([[[A], true, false], [[], false, false]]);
  });
  it('refuses at append a reason that supports no item in any record but the one the grouping gives it', async () => {
    const f = await approvalCoreFixture({ rationales: [{ id: 'reason-loose', supports: [] }] });
    // The decision kept for the reviewer alone in A, both actions in B: no Only me, so the first private group (A) takes it.
    f.core.decide('desktop', f.approve({ routes: f.routes(id => id === 'decision-1' ? [f.projectA] : [f.projectB]).map(route => ({ ...route, private: true as const })) }), () => f.session);
    const [first, second] = buildApprovalDecisionRecordsV1(source(f));
    const reasons = (built: BuiltApprovalDecisionRecordV1) => built.human_act_record_input.event.approved_snapshot.approved_payload.brief.rationales.map(reason => reason.id);
    expect([reasons(first!), reasons(second!)]).toEqual([['reason-loose'], []]);
    // The second record with it as well: the record codec accepts that, the projector recomputing the groups refuses it.
    const proposal = clone(source(f).approved_snapshot) as { approved_payload: { brief: { rationales: readonly Mutable[] } } };
    const { input, key } = reshaped(second!, brief => { brief.rationales.push({ ...proposal.approved_payload.brief.rationales.find(reason => reason.id === 'reason-loose')! }); });
    expect(() => validateApprovalDecisionRecordInputV2(input)).not.toThrow();
    await expect(appendRaw(f, input, second!.authorization_witness, key)).rejects.toThrow('Approval decision witness differs from its record');
    expect(f.recordCount()).toBe(0);
    await expect(appendRaw(f, clone(first!.human_act_record_input) as never, first!.authorization_witness, first!.semantic_idempotency_key)).resolves.toMatchObject({ outcome: 'appended' });
  });
  it('refuses a route that says private other than as true beside a project, rather than read it as shared', () => {
    const B = 'prj_00000000-0000-4000-8000-0000000000b1', approval_id = `apr_${'c'.repeat(64)}`;
    for (const route of [{ signal_id: 'd1', project_ids: [B], private: false }, { signal_id: 'd1', project_ids: [B], private: 'true' },
      { signal_id: 'd1', project_ids: [], private: true }, { signal_id: 'd1', project_ids: null, private: true }]) {
      expect(() => approvalDecisionGroupsV1({ approval_id, routes: [route as never] })).toThrow('private only as true, beside a project');
    }
  });
  it.each([[false], ['true'], [null]])('publishes nothing from a stored route that says private: %j, which the Authority tables do not check', async (flag) => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ routes: f.routes([f.projectA]) }), () => f.session);
    f.db.exec('DROP TRIGGER authority_approval_decision_immutable_v1');
    const body = JSON.parse(f.db.prepare('SELECT body_json FROM authority_approval_decisions_v1 WHERE approval_id=?').pluck().get(f.approvalId) as string) as { request: { routes: Mutable[] } };
    body.request.routes[0]!.private = flag;
    f.db.prepare('UPDATE authority_approval_decisions_v1 SET body_json=? WHERE approval_id=?').run(canonicalJson(body as unknown as JsonValue), f.approvalId);
    // The witness carries the flag as stored, so the append projector would refuse it as well.
    const input = source(f);
    expect(approvalDecisionWitnessV1(input.decision, validateApprovedDecisionSnapshotV2(input.approved_snapshot)).decision.routes[0]).toEqual(body.request.routes[0]);
    expect(() => buildApprovalDecisionRecordsV1(input)).toThrow('private only as true, beside a project');
    await expect(f.core.processing.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('private only as true, beside a project');
    expect(f.recordCount()).toBe(0);
  });
  it('buildApprovalDecisionRecordsV1 refuses a reject, a missing transcript source, another snapshot, routes of another brief and a decision that keeps nothing', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const input = source(f);
    const reject = clone(input); (reject.decision.body.request as unknown as Mutable).action = 'reject';
    expect(() => buildApprovalDecisionRecordsV1(reject)).toThrow('Only an approval writes a record');
    const missing = clone(input); (missing.decision.body as unknown as Mutable).transcript_source = null;
    expect(() => buildApprovalDecisionRecordsV1(missing)).toThrow('no frozen transcript source');
    const absent = clone(input); delete (absent.decision.body as unknown as Mutable).transcript_source;
    expect(() => buildApprovalDecisionRecordsV1(absent)).toThrow('no frozen transcript source');
    const other = clone(input); (other.decision.body.request as unknown as Mutable).snapshot_sha256 = canonicalSha256('other');
    expect(() => buildApprovalDecisionRecordsV1(other)).toThrow('another frozen snapshot');
    const shuffled = clone(input); (shuffled.decision.body.request as unknown as Mutable).routes = [...input.decision.body.request.routes].reverse();
    expect(() => buildApprovalDecisionRecordsV1(shuffled)).toThrow('routes differ from its frozen snapshot');
    const nothing = clone(input); (nothing.decision.body.request as unknown as Mutable).routes = input.decision.body.request.routes.map(route => ({ ...route, project_ids: null }));
    expect(() => buildApprovalDecisionRecordsV1(nothing)).toThrow('keeps nothing');
  });
});
