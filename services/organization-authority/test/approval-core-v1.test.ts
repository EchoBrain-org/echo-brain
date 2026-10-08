import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { isApprovalOwnerTextV1 } from '@echo-brain/organization-protocol';
import { ownerProposalsV1 } from '@echo-brain/organization-processing/core/processing/owner-proposals-v1';
import { SqliteApprovalWorkflowStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { bindApprovalWorkflowStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/approval-workflow-state-v1';
import type { DecisionBrief } from '@echo-brain/organization-processing/core';
import { approvalCoreFixture } from './fixtures/approval-core.js';
import {
  APPROVAL_DECISION_RECORD_SHA256_PATH_V1, APPROVAL_PROJECTS_MAX_V1, APPROVAL_SNAPSHOT_SURFACE_V1, approvalDecisionReceiptJsonV1, approvalProposalTextV1,
  createApprovalCoreV1, validateApprovalDecisionRequestV1, type ApprovalAuthorizationV1,
} from '../src/composition/approval-core-v1.js';
import { projectPersonMeetingApproverV1 } from '../src/composition/person-meeting-approval-projection-v1.js';

const refusal = vi.hoisted(() => ({ next: 0 }));
vi.mock('@echo-brain/organization-protocol/record-codec-support-v4', async (importOriginal) => {
  const original = await importOriginal<typeof import('@echo-brain/organization-protocol/record-codec-support-v4')>();
  return { ...original, validateApprovedDecisionSnapshotV2(value: unknown) {
    if (refusal.next > 0) { refusal.next--; throw new Error('snapshot refused by the record codec'); }
    return original.validateApprovedDecisionSnapshotV2(value);
  } };
});

const never = () => { throw new Error('authorize must not run'); };
const outbox = (f: { db: import('better-sqlite3').Database }, id: string) => f.db.prepare('SELECT state, suggested_projects_json, approved_snapshot_sha256 FROM authority_live_approval_outbox_v2 WHERE approval_id=?').get(id) as { state: string; suggested_projects_json: string | null; approved_snapshot_sha256: string | null };
const signal = () => new AbortController().signal;

describe('approval core: the brief', () => {
  it('freezes a snapshot without proposed owners and offers them as proposals', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno' } });
    const snapshot = JSON.parse(f.core.proposal(f.approvalId)!.snapshot_json!);
    expect(snapshot.approved_payload.brief.actions.every((a: { owner: unknown }) => a.owner === null)).toBe(true);
    expect(f.core.ownerProposals(f.approvalId)).toEqual([{ signal_id: 'act-1', action: expect.any(String), proposed: 'Rafael Moreno' }]);
  });
  it('lets the first decision win across surfaces and reports where it was made', async () => {
    const f = await approvalCoreFixture();
    const desktop = f.core.decide('desktop', f.approve({ command_id: 'desk-1' }), () => f.session);
    const slack = f.core.decide('slack', f.approve({ command_id: 'slack:abc' }), () => f.click);
    expect(desktop).toMatchObject({ kind: 'decided', status: 'publishing', surface: 'desktop' });
    expect(slack).toMatchObject({ kind: 'already_decided', status: 'publishing', surface: 'desktop' });
    expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1').pluck().get()).toBe(1);
  });
  it('replays the same command and refuses a changed one', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ command_id: 'desk-1' }), () => f.session);
    expect(f.core.decide('desktop', f.approve({ command_id: 'desk-1' }), () => f.session).kind).toBe('replayed');
    expect(f.core.decide('desktop', f.approve({ command_id: 'desk-1', share_transcript: true }), () => f.session).kind).toBe('already_decided');
  });
  it('refuses a project the approver lost and writes nothing', async () => {
    const f = await approvalCoreFixture({ projects: 2 });
    f.removeProjectMembership(f.projectB);
    expect(() => f.core.decide('desktop', f.approve({ project_ids: [f.projectA, f.projectB].sort() }), () => f.session)).toThrow(/unauthorized|not available/);
    expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1').pluck().get()).toBe(0);
  });
  it('refuses someone other than the reviewer', async () => {
    const f = await approvalCoreFixture();
    expect(() => f.core.decide('desktop', f.approve(), () => ({ ...f.session, actor: { ...f.session.actor, membership_id: 'mem_00000000-0000-4000-8000-00000000009a' } }))).toThrow('not available');
  });
  it('validates owners and audience', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno' } });
    for (const bad of [
      { owners: [{ signal_id: 'act-404', owner: 'X' }] },
      { owners: [{ signal_id: 'act-1', owner: 'A' }, { signal_id: 'act-1', owner: 'B' }] },
      { owners: [{ signal_id: 'act-1', owner: ' padded ' }] },
      { owners: [{ signal_id: 'act-1', owner: 'x'.repeat(121) }] },
      { project_ids: Array.from({ length: 21 }, (_, i) => `prj_00000000-0000-4000-8000-${i.toString(16).padStart(12, 'a')}`) },
    ]) expect(() => f.core.decide('desktop', f.approve(bad), () => f.session)).toThrow();
    expect(() => f.core.decide('desktop', f.reject({ project_ids: [f.projectA] }), () => f.session)).toThrow();
    expect(f.decisionCount()).toBe(0);
  });
  it('supersedes an undecided proposal on a new revision but keeps a decided one', async () => {
    const f = await approvalCoreFixture();
    await f.newRevision();
    expect(f.core.proposal(f.approvalId)!.status).toBe('superseded');
    const g = await approvalCoreFixture();
    g.core.decide('desktop', g.approve(), () => g.session);
    const next = await g.newRevision();
    expect(g.core.proposal(g.approvalId)!.status).toBe('publishing');
    expect(next.approvalId).not.toBe(g.approvalId);
    expect(g.core.proposal(next.approvalId)!.status).toBe('pending');
  });
  it('freezes the suggested projects the import recorded', async () => {
    const f = await approvalCoreFixture({ suggestions: 2 });
    expect(f.core.proposal(f.approvalId)!.project_ids).toEqual([f.projectA, f.projectB].sort());
  });
});

describe('approval core: freeze suggestions under R28', () => {
  it("freezes an import's pending projects before the cursor advance records them", async () => {
    const f = await approvalCoreFixture({ pending: ['A'], suggestions: 0, projects: 1 });
    expect(JSON.parse(outbox(f, f.approvalId).suggested_projects_json!)).toEqual([f.projectA]);
    expect(f.core.proposal(f.approvalId)!.project_ids).toEqual([f.projectA]);
    expect(f.db.prepare('SELECT count(*) FROM authority_person_meeting_suggestions_v1').pluck().get()).toBe(0);
  });
  it('freezes the sorted union of recorded and pending projects', async () => {
    const f = await approvalCoreFixture({ suggestions: 1, pending: ['B', 'A'] });
    expect(JSON.parse(outbox(f, f.approvalId).suggested_projects_json!)).toEqual([f.projectA, f.projectB]);
  });
  it('leaves out a pending project the importer has left', async () => {
    const f = await approvalCoreFixture({ pending: ['A', 'C'] });
    expect(JSON.parse(outbox(f, f.approvalId).suggested_projects_json!)).toEqual([f.projectA]);
  });
  it('pre-ticks but grants nothing when the import is cancelled after the freeze', async () => {
    const f = await approvalCoreFixture({ pending: ['A'] });
    f.intake.cancelImport(f.setting(), f.externalId, () => {});
    const advanced = await f.state.advanceCursor({ expected_cursor: f.first.admission.source.cursor, next_cursor: 'fixture-source:v1:live:{"folder":null,"baseline":false,"revisions":{},"manual":[]}' });
    expect(advanced).toBe('state_drift');
    expect(JSON.parse(outbox(f, f.approvalId).suggested_projects_json!)).toEqual([f.projectA]);
    expect(f.db.prepare('SELECT count(*) FROM authority_person_meeting_suggestions_v1').pluck().get()).toBe(0);
    expect(f.db.prepare('SELECT count(*) FROM authority_person_meeting_pending_suggestions_v1').pluck().get()).toBe(0);
  });
});

describe('approval core: owners', () => {
  it('freezes identical approved brief bytes whether or not owners were proposed', async () => {
    const plain = await approvalCoreFixture();
    const owned = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno', 'act-2': 'Ana Lima' } });
    const payload = (f: typeof plain) => canonicalJson(JSON.parse(f.core.proposal(f.approvalId)!.snapshot_json).approved_payload);
    expect(payload(owned)).toBe(payload(plain));
    expect(JSON.parse(plain.core.proposal(plain.approvalId)!.snapshot_json).approved_payload.surface).toBe(APPROVAL_SNAPSHOT_SURFACE_V1);
  });
  it('offers only owner proposals that the shared owner rule accepts', async () => {
    const f = await approvalCoreFixture({ actions: [{ id: 'act-1', owner: '  Rafael \t Moreno ' }, { id: 'act 2', owner: 'Odd Id' }, { id: 'act-3', owner: 'Zoë' }, { id: 'act-4', owner: 'x'.repeat(130) }] });
    const offered = f.core.ownerProposals(f.approvalId);
    expect(offered).toEqual([{ signal_id: 'act-1', action: 'Follow up on item 1.', proposed: 'Rafael Moreno' }, { signal_id: 'act-3', action: 'Follow up on item 3.', proposed: 'Zoë' }]);
    for (const item of offered) expect(isApprovalOwnerTextV1(item.proposed)).toBe(true);
    expect(f.core.ownerProposals('apr_' + '0'.repeat(64))).toEqual([]);
  });
  it('keeps every canonical proposed owner within the shared owner rule', () => {
    const owners = ['Rafael Moreno', ' a b ', 'x'.repeat(130), 'é', 'tab\tname', 'x'.repeat(119) + ' y', 'Ana​', '  多  人  '];
    const brief = { actions: owners.map((owner, i) => ({ id: `a${i}`, kind: 'action', text: 'Do it.', owner, due_at: null })) } as unknown as DecisionBrief;
    for (const proposal of ownerProposalsV1(brief)) expect(isApprovalOwnerTextV1(proposal.owner)).toBe(true);
  });
  it('offers no owners above 40 proposals and then refuses any owner', async () => {
    const f = await approvalCoreFixture({ actions: Array.from({ length: 41 }, (_, i) => ({ id: `act-${i + 1}`, owner: `Owner ${i + 1}` })) });
    expect(f.core.ownerProposals(f.approvalId)).toEqual([]);
    expect(() => f.core.decide('desktop', f.approve({ owners: [{ signal_id: 'act-1', owner: 'Owner 1' }] }), () => f.session)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
  it('refuses owners out of brief order or for an action without a proposal', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno', 'act-2': 'Ana Lima' } });
    expect(() => f.core.decide('desktop', f.approve({ owners: [{ signal_id: 'act-2', owner: 'B' }, { signal_id: 'act-1', owner: 'A' }] }), () => f.session)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    const g = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno' } });
    expect(() => g.core.decide('desktop', g.approve({ owners: [{ signal_id: 'act-2', owner: 'B' }] }), () => g.session)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(f.decisionCount() + g.decisionCount()).toBe(0);
  });
  it('accepts the owner text the spec allows and stores it verbatim', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno', 'act-2': 'Ana Lima' } });
    const owners = [{ signal_id: 'act-1', owner: 'Ana  María (ops)' }, { signal_id: 'act-2', owner: 'é Lima' }];
    expect(f.core.decide('desktop', f.approve({ owners }), () => f.session).kind).toBe('decided');
    const body = JSON.parse(f.db.prepare('SELECT body_json FROM authority_approval_decisions_v1').pluck().get() as string);
    expect(body.request.owners).toEqual(owners);
  });
});

describe('approval core: decide', () => {
  it('refuses malformed requests before reading state', async () => {
    const f = await approvalCoreFixture();
    const base = f.approve();
    for (const bad of [
      { ...base, extra: true }, { ...base, approval_id: 'apr_x' }, { ...base, command_id: 'bad command' }, { ...base, command_id: '-lead' },
      { ...base, command_id: 'x'.repeat(129) }, { ...base, command_id: 'slack:desk' }, { ...base, snapshot_sha256: 'sha256:XYZ' }, { ...base, action: 'maybe' },
      { ...base, project_ids: [f.projectB, f.projectA] }, { ...base, project_ids: [f.projectA, f.projectA] }, { ...base, project_ids: ['prj_nope'] },
      { ...base, share_transcript: 'yes' }, { ...base, owners: [{ signal_id: 'act-1' }] }, { ...base, owners: [{ signal_id: 'act 1', owner: 'A' }] },
      { ...base, action: 'reject', share_transcript: true }, { ...base, action: 'reject', owners: [{ signal_id: 'act-1', owner: 'A' }] }, null, 'approve',
    ]) {
      expect(() => f.core.decide('desktop', bad as never, never)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    }
    expect(() => f.core.decide('email' as never, base, never)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(f.decisionCount()).toBe(0);
  });
  it('binds command ids to their surface', async () => {
    const f = await approvalCoreFixture();
    expect(() => f.core.decide('slack', f.approve({ command_id: 'desk-1' }), never)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => f.core.decide('desktop', f.approve({ command_id: 'slack:abc' }), never)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(f.core.decide('slack', f.approve({ command_id: 'slack:abc' }), () => f.click)).toMatchObject({ kind: 'decided', surface: 'slack' });
  });
  it('refuses an evidence kind that does not match the surface', async () => {
    const f = await approvalCoreFixture();
    expect(() => f.core.decide('desktop', f.approve(), () => f.click)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => f.core.decide('slack', f.approve({ command_id: 'slack:1' }), () => f.session)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(f.decisionCount()).toBe(0);
  });
  it('refuses an actor from another organization and a revoked reviewer', async () => {
    const f = await approvalCoreFixture();
    expect(() => f.core.decide('desktop', f.approve(), () => ({ ...f.session, actor: { ...f.session.actor, organization_id: 'org_other' } }))).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    f.revokeReviewer();
    expect(() => f.core.decide('desktop', f.approve(), () => f.session)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(f.decisionCount()).toBe(0);
  });
  it('does not reveal decision state to a non-reviewer', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const stranger: ApprovalAuthorizationV1 = { ...f.session, actor: { ...f.session.actor, membership_id: 'mem_00000000-0000-4000-8000-0000000000e2', principal_id: 'prn_00000000-0000-4000-8000-0000000000e1' } };
    expect(() => f.core.decide('desktop', f.approve(), () => stranger)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });
  it('refuses a command id already used for another proposal', async () => {
    const f = await approvalCoreFixture();
    const other = await f.otherProposal();
    f.core.decide('desktop', f.approve({ command_id: 'desk-shared' }), () => f.session);
    expect(() => f.core.decide('desktop', f.approve({ approval_id: other.approvalId, command_id: 'desk-shared' }), () => f.session)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(f.decisionCount()).toBe(1);
  });
  it('checks projects only when the approval names them', async () => {
    const f = await approvalCoreFixture();
    const calls: (readonly string[])[] = [];
    const core = await f.create({}, { projects: (_actor, ids) => { calls.push(ids); } });
    core.decide('desktop', f.approve({ command_id: 'desk-only-me' }), () => f.session);
    expect(calls).toEqual([]);
    const g = await approvalCoreFixture();
    const seen: (readonly string[])[] = [];
    const gcore = await g.create({}, { projects: (_actor, ids) => { seen.push(ids); } });
    gcore.decide('desktop', g.approve({ project_ids: [g.projectA, g.projectB] }), () => g.session);
    expect(seen).toEqual([[g.projectA, g.projectB]]);
  });
  it('refuses when access changes between the two authorizations', async () => {
    const f = await approvalCoreFixture();
    let calls = 0;
    expect(() => f.core.decide('desktop', f.approve(), () => (++calls === 1 ? f.session : { ...f.session, evidence: { kind: 'person-session', sha256: canonicalSha256('rotated') } })))
      .toThrow(expect.objectContaining({ code: 'stale_access_state' }));
    expect(calls).toBe(2);
    expect(f.decisionCount()).toBe(0);
  });
  it('returns stale for a changed snapshot, a superseded proposal and a never-frozen one', async () => {
    const f = await approvalCoreFixture();
    expect(f.core.decide('desktop', f.approve({ snapshot_sha256: canonicalSha256('different snapshot') }), () => f.session)).toEqual({ kind: 'stale' });
    const original = f.approve();
    await f.newRevision();
    expect(f.core.decide('desktop', original, () => f.session)).toEqual({ kind: 'stale' });
    const g = await approvalCoreFixture({ stage: false });
    expect(g.core.proposal(g.approvalId)).toBeUndefined();
    expect(g.core.decide('desktop', g.approve(), () => g.session)).toEqual({ kind: 'stale' });
    expect(f.decisionCount() + g.decisionCount()).toBe(0);
  });
  it('holds the write lock from BEGIN', async () => {
    const f = await approvalCoreFixture({ file: true });
    const peer = await f.peer();
    peer.db.pragma('busy_timeout=0');
    let blocked: unknown;
    f.core.decide('desktop', f.approve(), () => {
      if (blocked === undefined) {
        try { peer.db.prepare('BEGIN IMMEDIATE').run(); peer.db.prepare('ROLLBACK').run(); blocked = false; }
        catch (error) { blocked = error; }
      }
      return f.session;
    });
    expect(String(blocked)).toMatch(/locked|busy/i);
  });
  it('rolls back to stale when a supersession lands inside the decision', async () => {
    const f = await approvalCoreFixture();
    const other = await f.otherProposal(false);
    let calls = 0;
    const result = f.core.decide('desktop', f.approve(), () => {
      if (++calls === 2) {
        f.db.prepare("UPDATE authority_live_approval_outbox_v2 SET state='superseded', superseded_by_candidate_id=?, superseded_at=?, updated_at=? WHERE approval_id=?")
          .run(other.candidate.candidate_id, '2026-10-07T10:00:00.000Z', '2026-10-07T10:00:00.000Z', f.approvalId);
      }
      return f.session;
    });
    expect(result).toEqual({ kind: 'stale' });
    expect(outbox(f, f.approvalId).state).toBe('staged');
    expect(f.decisionCount()).toBe(0);
  });
  it('backs the audience rule with the database', async () => {
    const f = await approvalCoreFixture();
    const core = await f.create({}, { projects: () => {} });
    expect(() => core.decide('desktop', f.approve({ project_ids: [f.projectC] }), () => f.session)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    f.archiveProject(f.projectA);
    expect(() => core.decide('desktop', f.approve({ project_ids: [f.projectA] }), () => f.session)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(f.decisionCount()).toBe(0);
  });
  it('refuses an approval whose meeting content is no longer retained', async () => {
    const f = await approvalCoreFixture({ retained: false });
    expect(() => f.core.decide('desktop', f.approve(), () => f.session)).toThrow(expect.objectContaining({ code: 'unavailable' }));
    expect(f.core.decide('desktop', f.reject(), () => f.session)).toMatchObject({ kind: 'decided', status: 'rejected' });
  });
  it('refuses to decide inside an open transaction', async () => {
    const f = await approvalCoreFixture();
    expect(() => f.db.transaction(() => f.core.decide('desktop', f.approve(), never))()).toThrow(/idle/);
    expect(f.decisionCount()).toBe(0);
  });
  it('wakes after commit only for decided and replayed', async () => {
    let observed: { inTransaction: boolean; rows: unknown } | undefined;
    const f = await approvalCoreFixture({ wake: () => { observed = { inTransaction: f.db.inTransaction, rows: f.decisionCount() }; throw new Error('wake unavailable'); } });
    expect(f.core.decide('desktop', f.approve(), () => f.session).kind).toBe('decided');
    expect(observed).toEqual({ inTransaction: false, rows: 1 });
    expect(f.wakes()).toBe(1);
    expect(f.core.decide('desktop', f.approve(), () => f.session).kind).toBe('replayed');
    expect(f.wakes()).toBe(2);
    expect(f.core.decide('desktop', f.approve({ command_id: 'desk-other' }), () => f.session).kind).toBe('already_decided');
    expect(f.core.decide('desktop', f.approve({ snapshot_sha256: canonicalSha256('x'), approval_id: (await f.otherProposal()).approvalId, command_id: 'desk-x' }), () => f.session).kind).toBe('stale');
    expect(f.wakes()).toBe(2);
    const g = await approvalCoreFixture();
    expect(g.core.decide('desktop', g.reject(), () => g.session)).toEqual({ kind: 'decided', status: 'rejected', surface: 'desktop' });
    expect(g.wakes()).toBe(1);
  });
  it('validateApprovalDecisionRequestV1 accepts exactly what decide accepts', async () => {
    const f = await approvalCoreFixture();
    const good = f.approve({ project_ids: [f.projectA], share_transcript: true, owners: [] });
    const validated = validateApprovalDecisionRequestV1('desktop', good);
    expect(validated).toEqual(good);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(() => validateApprovalDecisionRequestV1('desktop', { ...good, extra: 1 })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => validateApprovalDecisionRequestV1('slack', good)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(validateApprovalDecisionRequestV1('slack', { ...good, command_id: 'slack:Zx_9-.' }).command_id).toBe('slack:Zx_9-.');
    expect(f.core.decide('desktop', good, () => f.session).kind).toBe('decided');
    expect(APPROVAL_PROJECTS_MAX_V1).toBe(20);
  });
});

describe('approval core: publication', () => {
  it('Race: desktop and Slack decide on two handles and publish one record', async () => {
    const f = await approvalCoreFixture({ file: true });
    const peer = await f.peer();
    expect(f.core.decide('desktop', f.approve(), () => f.session)).toMatchObject({ kind: 'decided', surface: 'desktop' });
    expect(peer.core.decide('slack', f.approve({ command_id: 'slack:race' }), () => f.click)).toEqual({ kind: 'already_decided', status: 'publishing', surface: 'desktop' });
    expect(f.decisionCount()).toBe(1);
    await Promise.all([f.core.processing.appendFinalizedApprovalsToV4(signal()), peer.core.processing.appendFinalizedApprovalsToV4(signal())]);
    expect(f.recordCount()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1 WHERE receipt_json IS NOT NULL').pluck().get()).toBe(1);
    expect(f.core.proposal(f.approvalId)!.status).toBe('approved');
    expect(peer.core.proposal(f.approvalId)!.status).toBe('approved');
  });
  it('Race: a peer finishes an append interrupted before its receipt', async () => {
    const f = await approvalCoreFixture({ file: true });
    const peer = await f.peer();
    f.core.decide('desktop', f.approve(), () => f.session);
    const interrupted = await f.create({ record_append: { async append(input) { await f.context.record_append.append(input); throw new Error('interrupted after signed append'); } } });
    await expect(interrupted.processing.recoverV4Appends(signal())).rejects.toThrow('interrupted');
    expect(f.receipt()).toBeNull();
    await peer.core.processing.recoverV4Appends(signal());
    expect(f.recordCount()).toBe(1);
    expect(f.core.proposal(f.approvalId)!.status).toBe('approved');
  });
  it('runs the after-receipt step once when two publishers append the same approval', async () => {
    const f = await approvalCoreFixture({ file: true });
    const peerHandle = await f.peer();
    f.core.decide('desktop', f.approve(), () => f.session);
    let count = 0;
    const counter = () => { count++; };
    let release!: () => void, appended!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { appended = resolve; });
    const shared = f.context.record_append;
    f.withAppend(() => ({ async append(input) { const result = await shared.append(input); appended(); await gate; return result; } }));
    const p1 = await f.publisher(counter);
    f.withAppend(() => shared);
    const p2 = await f.publisher(counter, peerHandle);
    const first = p1.appendFinalizedApprovalsToV4(signal());
    await reached;
    await p2.appendFinalizedApprovalsToV4(signal());
    expect(count).toBe(1);
    const stored = f.receipt();
    release();
    await first;
    expect(count).toBe(1);
    expect(f.recordCount()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1 WHERE receipt_json IS NOT NULL').pluck().get()).toBe(1);
    expect(f.receipt()).toBe(stored);
  });
  it('refuses a second receipt that names another record', async () => {
    const f = await approvalCoreFixture({ file: true });
    f.core.decide('desktop', f.approve(), () => f.session);
    let count = 0;
    const shared = f.context.record_append;
    let gateRelease!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { gateRelease = resolve; });
    const reachedP = new Promise<void>(resolve => { reached = resolve; });
    f.withAppend(() => ({ async append(input) {
      const result = await shared.append(input);
      reached(); await gate;
      const other = canonicalSha256('another record');
      return { ...result, record_sha256: other, receipt: { ...(result.receipt as object), body: { ...(result.receipt as { body: object }).body, record_sha256: other } } } as typeof result;
    } }));
    const stub = await f.publisher(() => { count++; });
    f.withAppend(() => shared);
    const real = await f.publisher(() => { count++; });
    const pending = stub.appendFinalizedApprovalsToV4(signal());
    await reachedP;
    await real.appendFinalizedApprovalsToV4(signal());
    expect(count).toBe(1);
    gateRelease();
    await expect(pending).rejects.toThrow('approval receipt conflicts with the stored record');
    expect(count).toBe(1);
  });
  it.each([[[], false], [[], true], [['A'], false], [['A'], true], [['A', 'B'], false], [['A', 'B'], true]] as const)('publishes the exact audience %j (share %s) and recovers once', async (names, share) => {
    const f = await approvalCoreFixture();
    const ids = names.map(name => f.project(name));
    expect(f.core.decide('desktop', f.approve({ project_ids: ids, share_transcript: share }), () => f.session)).toMatchObject({ kind: 'decided', status: 'publishing' });
    const resumed = await f.create();
    await resumed.processing.recoverV4Appends(signal());
    expect(resumed.decide('desktop', f.approve({ project_ids: ids, share_transcript: share }), () => f.session)).toMatchObject({ kind: 'replayed', status: 'approved' });
    await resumed.processing.recoverV4Appends(signal());
    expect(f.recordCount()).toBe(1);
    const envelope = f.lastRecord();
    expect(envelope.body.human_act_resolution_ref.share_transcript).toBe(share);
    expect(envelope.body.human_act_resolution_ref.audience_project_ids).toEqual(ids);
    expect(envelope.body.human_act_resolution_ref.association_project_ids).toEqual(ids);
    expect(projectPersonMeetingApproverV1(envelope)?.membership_id).toBe(f.actor.membership_id);
    expect(resumed.decide('desktop', f.approve({ project_ids: ids, share_transcript: !share }), () => f.session).kind).toBe('already_decided');
  });
  it('stores the receipt wrapper with the record digest at $.record_sha256', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    let captured: { record_sha256: string; receipt: unknown } | undefined;
    const shared = f.context.record_append;
    const core = await f.create({ record_append: { async append(input) { const result = await shared.append(input); captured = result; return result; } } });
    await core.processing.appendFinalizedApprovalsToV4(signal());
    const digest = f.db.prepare('SELECT json_extract(receipt_json, ?) FROM authority_approval_decisions_v1').pluck().get(APPROVAL_DECISION_RECORD_SHA256_PATH_V1);
    expect(digest).toBe(f.record.prepare('SELECT record_sha256 FROM organization_record_log').pluck().get());
    expect(digest).toBe(f.db.prepare("SELECT json_extract(receipt_json, '$.receipt.body.record_sha256') FROM authority_approval_decisions_v1").pluck().get());
    expect(JSON.parse(f.receipt()!).receipt).toEqual(JSON.parse(JSON.stringify(captured!.receipt)));
    expect(f.receipt()).toBe(approvalDecisionReceiptJsonV1(captured!));
    expect(() => approvalDecisionReceiptJsonV1({ record_sha256: canonicalSha256('other'), receipt: captured!.receipt })).toThrow();
  });
  it('recovers an append committed just before the local receipt was saved', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const interrupted = await f.create({ record_append: { async append(input) { await f.context.record_append.append(input); throw new Error('interrupted after signed append'); } } });
    await expect(interrupted.processing.recoverV4Appends(signal())).rejects.toThrow('interrupted');
    expect(f.receipt()).toBeNull();
    await f.core.processing.recoverV4Appends(signal());
    expect(f.recordCount()).toBe(1);
    expect(f.core.proposal(f.approvalId)!.status).toBe('approved');
  });
  it('a rejection writes no record and keeps no receipt', async () => {
    const f = await approvalCoreFixture();
    expect(f.core.decide('desktop', f.reject(), () => f.session)).toMatchObject({ kind: 'decided', status: 'rejected' });
    await f.core.processing.recoverV4Appends(signal());
    expect(f.receipt()).toBeNull();
    expect(f.recordCount()).toBe(0);
    expect(f.core.proposal(f.approvalId)!.status).toBe('rejected');
  });
  it('publishes a decided proposal after a newer revision replaced it', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const next = await f.newRevision();
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    expect(f.recordCount()).toBe(1);
    expect(f.core.proposal(f.approvalId)!.status).toBe('approved');
    expect(f.core.proposal(next.approvalId)!.status).toBe('pending');
  });
  it('isolates a failing approval and keeps publishing the rest', async () => {
    const f = await approvalCoreFixture();
    const other = await f.otherProposal();
    f.core.decide('desktop', f.approve(), () => f.session);
    f.core.decide('desktop', f.approve({ approval_id: other.approvalId, command_id: 'desk-other' }), () => f.session);
    const shared = f.context.record_append;
    const core = await f.create({ record_append: { async append(input) { if (input.approval_id === f.approvalId) throw new Error('first approval cannot publish'); return shared.append(input); } } });
    await expect(core.processing.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('first approval cannot publish');
    expect(f.recordCount()).toBe(1);
    expect(f.core.proposal(other.approvalId)!.status).toBe('approved');
    expect(f.core.proposal(f.approvalId)!.status).toBe('publishing');
  });
  it('skips approvals of a source this runtime does not configure', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const unconfigured = bindApprovalWorkflowStateV1(new SqliteApprovalWorkflowStateV1(f.db, { source_cursor_policies: [{ source_adapter_id: 'another-source', assert_live_cursor() {} }], processor_adapter_id: 'llm' }), () => {});
    const core = await f.create({ state: unconfigured });
    await core.processing.appendFinalizedApprovalsToV4(signal());
    expect(f.recordCount()).toBe(0);
    expect(core.proposal(f.approvalId)!.status).toBe('publishing');
  });
});

describe('approval core: freeze', () => {
  it('returns staged on a repeat stage without rebuilding', async () => {
    const f = await approvalCoreFixture();
    const before = outbox(f, f.approvalId);
    refusal.next = 1;
    try {
      expect(await f.core.stager.stage({ admission: f.first.admission, candidate: f.first.candidate, meeting: f.first.meeting, decisions: f.first.decisions })).toEqual({ kind: 'staged', stage_id: f.approvalId });
      expect(refusal.next).toBe(1);
    } finally { refusal.next = 0; }
    expect(outbox(f, f.approvalId)).toEqual(before);
  });
  it('returns state_drift for a superseded candidate', async () => {
    const f = await approvalCoreFixture({ stage: false });
    await f.newRevision();
    expect(await f.core.stager.stage({ admission: f.first.admission, candidate: f.first.candidate, meeting: f.first.meeting, decisions: f.first.decisions })).toEqual({ kind: 'state_drift' });
    expect(outbox(f, f.approvalId)).toMatchObject({ state: 'superseded', suggested_projects_json: null });
  });
  it('returns revoked for an inactive reviewer and leaves the proposal queued', async () => {
    const f = await approvalCoreFixture({ stage: false });
    f.revokeReviewer();
    expect(await f.core.stager.stage({ admission: f.first.admission, candidate: f.first.candidate, meeting: f.first.meeting, decisions: f.first.decisions })).toEqual({ kind: 'revoked' });
    expect(outbox(f, f.approvalId).state).toBe('queued');
    expect(f.state.listPendingApprovalDeliveries()).toEqual([]);
  });
  it('refuses to freeze a snapshot the record codec would refuse', async () => {
    const f = await approvalCoreFixture({ stage: false });
    refusal.next = 1;
    await expect(f.core.stager.stage({ admission: f.first.admission, candidate: f.first.candidate, meeting: f.first.meeting, decisions: f.first.decisions })).rejects.toThrow('refused by the record codec');
    expect(outbox(f, f.approvalId).state).toBe('queued');
    await f.core.stager.reconcilePendingDeliveries();
    expect(outbox(f, f.approvalId).state).toBe('staged');
  });
  it('freezes at most 20 suggestions, sorted, and ignores suggestions recorded later', async () => {
    const f = await approvalCoreFixture({ stage: false, suggestions: 2 });
    const extra = Array.from({ length: 20 }, (_, i) => `prj_00000000-0000-4000-8000-0000000001${i.toString(16).padStart(2, '0')}`);
    for (const [i, id] of extra.entries()) {
      f.db.prepare("INSERT INTO authority_projects_v1 VALUES (?,?,?,'active',?,?,?,'owner')").run(id, f.actor.organization_id, `Extra ${i}`, '2026-10-07T09:00:00.000Z', f.actor.principal_id, f.actor.membership_id);
      f.db.prepare("INSERT INTO authority_project_memberships_v1 VALUES (?,?,?,?,?,'owner','member','active',?,NULL)").run(`pgm_00000000-0000-4000-8000-0000000002${i.toString(16).padStart(2, '0')}`, id, f.actor.organization_id, f.actor.principal_id, f.actor.membership_id, '2026-10-07T09:00:00.000Z');
      f.db.prepare('INSERT INTO authority_person_meeting_suggestions_v1 VALUES (?,?,?,?)').run(f.sourceKey, f.externalId, id, '2026-10-07T09:00:00.000Z');
    }
    await f.core.stager.reconcilePendingDeliveries();
    const frozen = JSON.parse(outbox(f, f.approvalId).suggested_projects_json!) as string[];
    expect(frozen).toEqual([...extra, f.projectA, f.projectB].sort().slice(0, 20));
    f.db.prepare('INSERT INTO authority_person_meeting_suggestions_v1 VALUES (?,?,?,?)').run(f.sourceKey, f.externalId, f.projectC, '2026-10-07T09:00:00.000Z');
    expect(JSON.parse(outbox(f, f.approvalId).suggested_projects_json!)).toEqual(frozen);
  });
  it('reconciles queued proposals of one source only', async () => {
    const f = await approvalCoreFixture({ stage: false });
    await f.core.stagerForSource('pms_another').reconcilePendingDeliveries();
    expect(outbox(f, f.approvalId).state).toBe('queued');
    await f.core.stagerForSource(f.sourceKey).reconcilePendingDeliveries();
    expect(outbox(f, f.approvalId).state).toBe('staged');
  });
  it('reconcile freezes the rest and rethrows the first failure', async () => {
    const f = await approvalCoreFixture({ stage: false });
    const other = await f.otherProposal(false);
    refusal.next = 1;
    await expect(f.core.stager.reconcilePendingDeliveries()).rejects.toThrow('refused by the record codec');
    expect([outbox(f, f.approvalId).state, outbox(f, other.approvalId).state].sort()).toEqual(['queued', 'staged']);
    await f.core.stager.reconcileSuperseded();
  });
});

describe('approval core: views', () => {
  it('lists undecided staged proposals first and only for their reviewer', async () => {
    const f = await approvalCoreFixture();
    const other = await f.otherProposal();
    f.core.decide('desktop', f.approve(), () => f.session);
    const listed = f.core.proposals(f.person);
    expect(listed.map(view => view.approval_id)).toEqual([other.approvalId, f.approvalId]);
    expect(listed[0]).toMatchObject({ status: 'pending', decided_on: null, decided_at: null, reviewer: f.person, reviewer_active: true, title: 'Untitled meeting' });
    expect(f.core.proposals({ ...f.person, membership_id: 'mem_00000000-0000-4000-8000-0000000000e2' })).toEqual([]);
  });
  it('never returns an unfrozen proposal', async () => {
    const f = await approvalCoreFixture({ stage: false });
    expect(f.core.proposal(f.approvalId)).toBeUndefined();
    expect(f.core.proposals(f.person)).toEqual([]);
    expect(f.core.proposal('apr_' + 'f'.repeat(64))).toBeUndefined();
  });
  it('clamps the list limit to 1..100', async () => {
    const f = await approvalCoreFixture();
    await f.otherProposal();
    expect(f.core.proposals(f.person, 0)).toHaveLength(1);
    expect(f.core.proposals(f.person, 1)).toHaveLength(1);
    expect(f.core.proposals(f.person, 1000)).toHaveLength(2);
  });
  it('filters undecided suggestions to projects the reviewer can still read', async () => {
    const f = await approvalCoreFixture({ suggestions: 2 });
    f.removeProjectMembership(f.projectB);
    expect(f.core.proposal(f.approvalId)!.project_ids).toEqual([f.projectA]);
    f.archiveProject(f.projectA);
    expect(f.core.proposal(f.approvalId)!.project_ids).toEqual([]);
    expect(JSON.parse(outbox(f, f.approvalId).suggested_projects_json!)).toEqual([f.projectA, f.projectB]);
  });
  it("reports the decision's projects, surface and time once decided", async () => {
    const f = await approvalCoreFixture({ suggestions: 2, core: { now: () => '2026-10-07T11:22:33.444Z' } });
    f.core.decide('slack', f.approve({ command_id: 'slack:k1', project_ids: [f.projectB] }), () => f.click);
    f.removeProjectMembership(f.projectB);
    expect(f.core.proposal(f.approvalId)).toMatchObject({ status: 'publishing', decided_on: 'slack', decided_at: '2026-10-07T11:22:33.444Z', project_ids: [f.projectB] });
    const g = await approvalCoreFixture({ suggestions: 2 });
    g.core.decide('desktop', g.reject(), () => g.session);
    expect(g.core.proposal(g.approvalId)).toMatchObject({ status: 'rejected', decided_on: 'desktop', project_ids: [] });
  });
  it('reports reviewer_active false after the membership is revoked', async () => {
    const f = await approvalCoreFixture();
    f.revokeReviewer();
    expect(f.core.proposal(f.approvalId)).toMatchObject({ reviewer_active: false, status: 'pending' });
  });
  it('prints due dates and never owners', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno', 'act-2': 'Ana Lima' } });
    const text = approvalProposalTextV1(f.core.proposal(f.approvalId)!.snapshot_json);
    expect(text).toContain('  Due: Not specified');
    expect(text).toContain('  Due: 2026-10-20T00:00:00.000Z');
    expect(text).not.toMatch(/Owner|Rafael|Ana Lima|Unassigned/);
  });
});

describe('approval core: construction', () => {
  it('builds one frozen core over the shared context', async () => {
    const f = await approvalCoreFixture();
    const core = await createApprovalCoreV1(f.db, f.context, { suggestions: () => [], projects: () => {} });
    expect(Object.isFrozen(core)).toBe(true);
    expect(core.processing.reconcileApprovalPresentations).toBeUndefined();
    await core.processing.observeAndFinalizePendingApprovals(signal());
  });
});
