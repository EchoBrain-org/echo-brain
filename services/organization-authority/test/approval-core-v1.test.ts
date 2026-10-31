import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { isApprovalOwnerTextV1 } from '@echo-brain/organization-protocol';
import { ownerProposalsV1 } from '@echo-brain/organization-processing/core/processing/owner-proposals-v1';
import { retainedMeetingSourceCoordinateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import type { DecisionBrief } from '@echo-brain/organization-processing/core';
import { approvalCoreFixture } from './fixtures/approval-core.js';
import {
  APPROVAL_PROJECTS_MAX_V1, APPROVAL_ROUTES_MAX_V1, APPROVAL_SNAPSHOT_SURFACE_V1, approvalProposalSummaryV1, approvalReviewV1,
  createApprovalCoreV1, validateApprovalDecisionRequestV1, type ApprovalAuthorizationV1,
} from '../src/composition/approval-core-v1.js';

const refusal = vi.hoisted(() => ({ next: 0 }));
vi.mock('@echo-brain/organization-protocol', async (importOriginal) => {
  const original = await importOriginal<typeof import('@echo-brain/organization-protocol')>();
  return { ...original, validateApprovedDecisionSnapshotV2(value: unknown) {
    if (refusal.next > 0) { refusal.next--; throw new Error('snapshot refused by the record codec'); }
    return original.validateApprovedDecisionSnapshotV2(value);
  } };
});

const never = () => { throw new Error('authorize must not run'); };
const outbox = (f: { db: import('better-sqlite3').Database }, id: string) => f.db.prepare('SELECT state, suggested_projects_json, approved_snapshot_sha256 FROM authority_live_approval_outbox_v2 WHERE approval_id=?').get(id) as { state: string; suggested_projects_json: string | null; approved_snapshot_sha256: string | null };
const signal = () => new AbortController().signal;

describe('approval core: the brief', () => {
  it('refuses a project the approver lost and writes nothing', async () => {
    const f = await approvalCoreFixture({ projects: 2 });
    f.removeProjectMembership(f.projectB);
    expect(() => f.core.decide('desktop', f.approve({ routes: f.routes([f.projectA, f.projectB].sort()) }), () => f.session)).toThrow(/unauthorized|not available/);
    expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1').pluck().get()).toBe(0);
  });
  it('refuses someone other than the reviewer', async () => {
    const f = await approvalCoreFixture();
    expect(() => f.core.decide('desktop', f.approve(), () => ({ ...f.session, actor: { ...f.session.actor, membership_id: 'mem_00000000-0000-4000-8000-00000000009a' } }))).toThrow('not available');
  });
  it('supersedes an undecided proposal on a new revision', async () => {
    const f = await approvalCoreFixture();
    await f.newRevision();
    expect(f.core.proposal(f.approvalId)!.status).toBe('superseded');
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
    const advanced = await f.state.advanceCursor({ expected_cursor: f.first.admission.source.cursor, next_cursor: 'fixture-source:v1:live:{"folder":null,"baseline":false,"manual":[]}' });
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
    expect(JSON.parse(owned.core.proposal(owned.approvalId)!.snapshot_json).approved_payload.brief.actions.every((a: { owner: unknown }) => a.owner === null)).toBe(true);
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
    const many = Array.from({ length: 21 }, (_, i) => `prj_00000000-0000-4000-8000-${i.toString(16).padStart(12, 'a')}`);
    for (const bad of [
      { ...base, extra: true }, { ...base, approval_id: 'apr_x' }, { ...base, command_id: 'bad command' }, { ...base, command_id: '-lead' },
      { ...base, command_id: 'x'.repeat(129) }, { ...base, command_id: 'slack:desk' }, { ...base, snapshot_sha256: 'sha256:XYZ' }, { ...base, action: 'maybe' },
      { ...base, routes: f.routes([f.projectB, f.projectA]) }, { ...base, routes: f.routes([f.projectA, f.projectA]) }, { ...base, routes: f.routes(['prj_nope']) },
      { ...base, project_ids: [] }, { ...base, share_transcript: false }, { ...base, routes: 'all' }, { ...base, routes: [...base.routes, base.routes[0]] },
      { ...base, routes: f.routes(null) }, { ...base, routes: [] }, { ...base, routes: [{ signal_id: 'act 1', project_ids: [] }] },
      { ...base, routes: [{ signal_id: 'act-1' }] }, { ...base, routes: [{ signal_id: 'act-1', project_ids: [], note: 'x' }] },
      { ...base, routes: [{ signal_id: 'act-1', project_ids: 'prj_00000000-0000-4000-8000-0000000000a1' }] },
      { ...base, routes: f.routes(many) }, { ...base, routes: f.routes((_id, kind) => kind === 'decision' ? many.slice(0, 11) : many.slice(11)) },
      { ...base, routes: Array.from({ length: APPROVAL_ROUTES_MAX_V1 + 1 }, (_, i) => ({ signal_id: `act-${i}`, project_ids: [] })) },
      { ...base, owners: [{ signal_id: 'act-1' }] }, { ...base, owners: [{ signal_id: 'act 1', owner: 'A' }] },
      { ...base, action: 'reject' }, { ...base, action: 'reject', routes: [], owners: [{ signal_id: 'act-1', owner: 'A' }] }, null, 'approve',
      { ...base, owners: [{ signal_id: 'act-1', owner: 'A' }, { signal_id: 'act-1', owner: 'B' }] }, { ...base, owners: [{ signal_id: 'act-1', owner: ' padded ' }] },
      { ...base, owners: [{ signal_id: 'act-1', owner: 'x'.repeat(121) }] },
      // Kept private only inside a project, and said only as `true`.
      { ...base, routes: f.routes([]).map(route => ({ ...route, private: true })) }, { ...base, routes: f.routes(id => id === 'act-1' ? null : []).map(route => ({ ...route, private: true })) },
      { ...base, routes: f.routes([f.projectA]).map(route => ({ ...route, private: false })) }, { ...base, routes: f.routes([f.projectA]).map(route => ({ ...route, private: 'true' })) },
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
    const other = await f.otherProposal();
    core.decide('desktop', f.approve({ approval_id: other.approvalId, command_id: 'desk-projects', routes: f.routes([f.projectA, f.projectB], other.approvalId) }), () => f.session);
    expect(calls).toEqual([[f.projectA, f.projectB]]);
    // Once, with every project any route names.
    const third = await f.otherProposal(true, 'note-3');
    core.decide('desktop', f.approve({ approval_id: third.approvalId, command_id: 'desk-mixed',
      routes: f.routes(id => ({ 'decision-1': [f.projectB], 'act-1': null, 'act-2': [] })[id] ?? null, third.approvalId) }), () => f.session);
    expect(calls).toEqual([[f.projectA, f.projectB], [f.projectB]]);
  });
  it('takes routes that name every decision and action of the frozen snapshot once, in brief order', async () => {
    const f = await approvalCoreFixture();
    const routes = f.routes([f.projectA]);
    expect(routes.map(route => route.signal_id)).toEqual(['decision-1', 'act-1', 'act-2']);
    for (const bad of [routes.slice(1), [routes[1]!, routes[0]!, routes[2]!], [...routes, { signal_id: 'act-9', project_ids: [] }],
      routes.map(route => route.signal_id === 'act-2' ? { ...route, signal_id: 'act-3' } : route)]) {
      expect(() => f.core.decide('desktop', f.approve({ routes: bad }), () => f.session)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    }
    expect(f.decisionCount()).toBe(0);
    // Any mix of destinations, so long as one item is kept.
    const mixed = f.routes(id => ({ 'decision-1': [f.projectA, f.projectB], 'act-1': null, 'act-2': [] })[id] ?? null);
    expect(f.core.decide('desktop', f.approve({ routes: mixed }), () => f.session).kind).toBe('decided');
    expect(JSON.parse(f.db.prepare('SELECT body_json FROM authority_approval_decisions_v1').pluck().get() as string).request.routes).toEqual(mixed);
  });
  it('refuses an owner of an action that is not kept', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno', 'act-2': 'Ana Lima' } });
    const routes = f.routes(id => id === 'act-1' ? null : [f.projectA]);
    expect(() => f.core.decide('desktop', f.approve({ routes, owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }] }), () => f.session))
      .toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(f.core.decide('desktop', f.approve({ routes, owners: [{ signal_id: 'act-2', owner: 'Ana Lima' }] }), () => f.session).kind).toBe('decided');
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
    // A never-frozen proposal has no snapshot to route, so its routes are whatever the caller guessed.
    const g = await approvalCoreFixture({ stage: false });
    expect(g.core.decide('desktop', g.approve({ routes: [{ signal_id: 'decision-1', project_ids: [] }] }), () => g.session)).toEqual({ kind: 'stale' });
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
    expect(() => core.decide('desktop', f.approve({ routes: f.routes([f.projectC]) }), () => f.session)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    // Every route is checked: one unreadable project in one route refuses the decision.
    expect(() => core.decide('desktop', f.approve({ routes: f.routes(id => id === 'act-2' ? [f.projectC] : [f.projectA]) }), () => f.session))
      .toThrow(expect.objectContaining({ code: 'unauthorized' }));
    f.archiveProject(f.projectA);
    expect(() => core.decide('desktop', f.approve({ routes: f.routes([f.projectA]) }), () => f.session)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(f.decisionCount()).toBe(0);
  });
  it('refuses an approval whose meeting content is no longer retained', async () => {
    const f = await approvalCoreFixture({ retained: false });
    expect(() => f.core.decide('desktop', f.approve(), () => f.session)).toThrow(expect.objectContaining({ code: 'unavailable' }));
    expect(f.core.decide('desktop', f.reject(), () => f.session)).toMatchObject({ kind: 'decided', status: 'rejected' });
  });
  it('stores the retained transcript coordinate in an approval body and null in a rejection', async () => {
    const f = await approvalCoreFixture();
    const other = await f.otherProposal();
    f.core.decide('desktop', f.approve(), () => f.session);
    f.core.decide('desktop', f.reject({ approval_id: other.approvalId, command_id: 'desk-reject-other' }), () => f.session);
    const body = (id: string) => JSON.parse(f.db.prepare('SELECT body_json FROM authority_approval_decisions_v1 WHERE approval_id=?').pluck().get(id) as string);
    expect(body(f.approvalId).transcript_source).toEqual(retainedMeetingSourceCoordinateV1(f.db, f.actor.organization_id, f.first.meeting));
    expect(body(f.approvalId).transcript_source).toMatchObject({ source_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(body(other.approvalId).transcript_source).toBeNull();
    expect(Object.keys(body(f.approvalId)).sort()).toEqual(['actor', 'decided_at', 'evidence', 'request', 'surface', 'transcript_source']);
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
  it('keeps an item for the reviewer alone inside its projects: the same project checks, and the route stored verbatim', async () => {
    const f = await approvalCoreFixture();
    const routes = f.routes(id => ({ 'decision-1': [f.projectA], 'act-1': [f.projectA], 'act-2': [] })[id] ?? null)
      .map(route => route.signal_id === 'decision-1' ? { ...route, private: true as const } : route);
    // A private route names projects like any other: one the reviewer is not in refuses the decision, in the core and in the database.
    const outside = routes.map(route => route.signal_id === 'decision-1' ? { ...route, project_ids: [f.projectC] } : route);
    expect(() => f.core.decide('desktop', f.approve({ routes: outside }), () => f.session)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    const unchecked = await f.create({}, { projects: () => {} });
    expect(() => unchecked.decide('desktop', f.approve({ routes: outside }), () => f.session)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(f.decisionCount()).toBe(0);
    expect(f.core.decide('desktop', f.approve({ routes }), () => f.session).kind).toBe('decided');
    const stored = JSON.parse(f.db.prepare('SELECT body_json FROM authority_approval_decisions_v1').pluck().get() as string).request.routes;
    expect(stored).toEqual(routes);
    expect(stored.map((route: object) => Object.keys(route).sort().join())).toEqual(['private,project_ids,signal_id', 'project_ids,signal_id', 'project_ids,signal_id']);
    expect(f.core.proposal(f.approvalId)).toMatchObject({ status: 'publishing', project_ids: [f.projectA], routes });
  });
  it('validates a request without private routes to the bytes it always had', () => {
    const A = 'prj_00000000-0000-4000-8000-0000000000a1', B = 'prj_00000000-0000-4000-8000-0000000000b1';
    const routes = [{ signal_id: 'd1', project_ids: [B] }, { signal_id: 'd2', project_ids: null }, { signal_id: 'd3', project_ids: [] }, { signal_id: 'a1', project_ids: [A, B] },
      { signal_id: 'a2', project_ids: [B] }, { signal_id: 'a3', project_ids: [] }];
    const request = validateApprovalDecisionRequestV1('desktop', { approval_id: `apr_${'c'.repeat(64)}`, command_id: 'desk-1', snapshot_sha256: canonicalSha256('snapshot'), action: 'approve',
      routes, owners: [{ signal_id: 'a1', owner: 'Ana' }] });
    // Pinned before private routes existed (ADR-0049): the decision body and its provider action digest are unchanged.
    expect(canonicalSha256(request)).toBe('sha256:1db70cb3dff887ddaa0679b34281dcc6cf7273bbfec656792a07b672181c14a9');
    expect(canonicalJson(request.routes)).toBe(canonicalJson(routes));
  });
  it('validateApprovalDecisionRequestV1 accepts exactly what decide accepts', async () => {
    const f = await approvalCoreFixture();
    const good = f.approve({ routes: f.routes(id => id === 'act-1' ? null : [f.projectA]), owners: [] });
    const validated = validateApprovalDecisionRequestV1('desktop', good);
    expect(validated).toEqual(good);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(() => validateApprovalDecisionRequestV1('slack', good)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(validateApprovalDecisionRequestV1('slack', { ...good, command_id: 'slack:Zx_9-.' }).command_id).toBe('slack:Zx_9-.');
    expect(f.core.decide('desktop', good, () => f.session).kind).toBe('decided');
    expect(APPROVAL_PROJECTS_MAX_V1).toBe(20);
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
    // It says whether it froze anything, so a pass that froze nothing backs off.
    await expect(f.core.stagerForSource('pms_another').reconcilePendingDeliveries()).resolves.toBe(false);
    expect(outbox(f, f.approvalId).state).toBe('queued');
    await expect(f.core.stagerForSource(f.sourceKey).reconcilePendingDeliveries()).resolves.toBe(true);
    expect(outbox(f, f.approvalId).state).toBe('staged');
  });
  it('reconcile freezes the rest and rethrows the first failure', async () => {
    const f = await approvalCoreFixture({ stage: false });
    const other = await f.otherProposal(false);
    refusal.next = 1;
    await expect(f.core.stager.reconcilePendingDeliveries()).rejects.toThrow('refused by the record codec');
    expect([outbox(f, f.approvalId).state, outbox(f, other.approvalId).state].sort()).toEqual(['queued', 'staged']);
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
  it("lists each proposal's id and status alone exactly as proposals lists them, in every status (ADR-0036)", async () => {
    const f = await approvalCoreFixture({ stage: false });
    const statuses = (limit?: number) => f.core.proposalStatuses(f.person, limit);
    const listed = (limit?: number) => f.core.proposals(f.person, limit).map(view => ({ approval_id: view.approval_id, status: view.status }));
    // An unfrozen proposal is in neither.
    expect(statuses()).toEqual([]);
    await f.core.stager.stage({ admission: f.first.admission, candidate: f.first.candidate, meeting: f.first.meeting, decisions: f.first.decisions });
    const other = await f.otherProposal();
    const third = await f.otherProposal(true, 'note-3');
    await f.newRevision();                                                     // supersedes the first
    f.core.decide('desktop', f.approve({ approval_id: other.approvalId, command_id: 'approve-other' }), () => f.session);
    expect(statuses().map(entry => entry.status).sort()).toEqual(['pending', 'pending', 'publishing', 'superseded']);
    expect(statuses()).toEqual(listed());
    f.core.decide('desktop', f.reject({ approval_id: third.approvalId, command_id: 'reject-third' }), () => f.session);
    await f.publisher().appendFinalizedApprovalsToV4(new AbortController().signal);
    expect(statuses().map(entry => entry.status).sort()).toEqual(['approved', 'pending', 'rejected', 'superseded']);
    expect(statuses()).toEqual(listed());
    expect(statuses(1)).toEqual(listed(1));
    expect(f.core.proposalStatuses({ ...f.person, membership_id: 'mem_00000000-0000-4000-8000-0000000000e2' })).toEqual([]);
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
    expect(f.core.proposal(f.approvalId)!.project_ids).toEqual([f.projectA, f.projectB]);
    f.removeProjectMembership(f.projectB);
    expect(f.core.proposal(f.approvalId)!.project_ids).toEqual([f.projectA]);
    f.archiveProject(f.projectA);
    expect(f.core.proposal(f.approvalId)!.project_ids).toEqual([]);
    expect(JSON.parse(outbox(f, f.approvalId).suggested_projects_json!)).toEqual([f.projectA, f.projectB]);
  });
  it("reports the decision's routes, projects, owners, surface and time once decided, and its records once published", async () => {
    const f = await approvalCoreFixture({ suggestions: 2, owners: { 'act-2': 'Ana Lima' }, core: { now: () => '2026-10-07T11:22:33.444Z' } });
    expect(f.core.proposal(f.approvalId)).toMatchObject({ status: 'pending', routes: null, confirmed_owners: null, records: [] });
    const routes = f.routes(id => ({ 'decision-1': [f.projectB], 'act-1': null, 'act-2': [f.projectA, f.projectB] })[id] ?? null);
    f.core.decide('slack', f.approve({ command_id: 'slack:k1', routes, owners: [{ signal_id: 'act-2', owner: 'Ana Lima' }] }), () => f.click);
    f.removeProjectMembership(f.projectB);
    expect(f.core.proposal(f.approvalId)).toMatchObject({ status: 'publishing', decided_on: 'slack', decided_at: '2026-10-07T11:22:33.444Z',
      project_ids: [f.projectA, f.projectB], routes, confirmed_owners: [{ signal_id: 'act-2', owner: 'Ana Lima' }], records: [] });
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    const records = (JSON.parse(f.receipt()!) as { records: { approval_id: string; project_ids: string[] }[] }).records;
    expect(f.core.proposal(f.approvalId)).toMatchObject({ status: 'approved',
      records: records.map(record => ({ approval_id: record.approval_id, project_ids: record.project_ids })) });
    expect(f.core.proposal(f.approvalId)!.records.map(record => record.project_ids)).toEqual([[f.projectB], [f.projectA, f.projectB]]);
    expect(f.core.proposals(f.person)[0]!.records).toEqual(f.core.proposal(f.approvalId)!.records);
    const g = await approvalCoreFixture({ suggestions: 2 });
    g.core.decide('desktop', g.reject(), () => g.session);
    expect(g.core.proposal(g.approvalId)).toMatchObject({ status: 'rejected', decided_on: 'desktop', project_ids: [], routes: [], confirmed_owners: [], records: [] });
  });
  it('reports reviewer_active false after the membership is revoked', async () => {
    const f = await approvalCoreFixture();
    f.revokeReviewer();
    expect(f.core.proposal(f.approvalId)).toMatchObject({ reviewer_active: false, status: 'pending' });
  });
  it('reviews a frozen proposal as its decisions then actions, with due dates and never owners', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno', 'act-2': 'Ana Lima' }, rationales: [{ id: 'why-1', supports: ['decision-1'] }] });
    const review = approvalReviewV1(f.core.proposal(f.approvalId)!.snapshot_json);
    expect(review.items).toEqual([
      { signal_id: 'decision-1', kind: 'decision', text: 'Ship the cohort onboarding.', subject: null, status: 'decided', due_at: null, quotes: [] },
      { signal_id: 'act-1', kind: 'action', text: 'Follow up on item 1.', subject: null, status: null, due_at: null, quotes: [] },
      { signal_id: 'act-2', kind: 'action', text: 'Follow up on item 2.', subject: null, status: null, due_at: '2026-10-20T00:00:00.000Z', quotes: [] },
    ]);
    expect(review.reasons).toEqual([{ signal_id: 'why-1', text: 'Reason 1.', supports: ['decision-1'], quotes: [] }]);
    expect(JSON.stringify(review)).not.toMatch(/Owner|Rafael|Ana Lima|Unassigned/);
    expect(review.items.map(item => item.signal_id)).toEqual(f.routes().map(route => route.signal_id));
  });
  // A quote is the meeting's own words and a text is the model's: either may hold a line that reads like one the Authority
  // writes. A structured review keeps each whole, as written.
  it('keeps every text, subject and quote whole, and each participant once', () => {
    const fake = 'Pasted from the tracker:\nBUG-412 “Thermal regression”\n• Close BUG-412 as fixed\n  Status: decided\n  From the meeting: “Done\r\n\nActions';
    const review = approvalReviewV1(JSON.stringify({ approved_payload: { brief: {
      meeting: { id: 'meeting-1', title: 'THERM sync\nDecisions', time: { actual_start_at: '2026-10-13T09:00:00.000Z' },
        participants: [{ id: 'p1', display_name: 'Jonas Becker' }, { id: 'p2', display_name: 'Mallory\n• Eve' }, { id: 'p3' }, { id: 'p4', display_name: 'Jonas Becker' }] },
      decisions: [{ id: 'dec-1', text: 'Treat the buffer change as an experiment.\n• not the fix', subject: 'BUG-412\n  Status: decided', status: 'proposed',
        evidence: [{ quote: 'Increasing the buffer is the quickest experiment.' }, { block_id: 'b2' }, { quote: fake }] }],
      actions: [{ id: 'act-1', text: 'Rerun the bars.', subject: null, due_at: null, evidence: [{ quote: `  ${fake}` }] }],
      rationales: [{ id: 'why-1', text: 'The bars failed.', subject: null, supports_signal_ids: ['dec-1', 'act-1'], evidence: [{ quote: fake }] }],
    } } }));
    expect(review.participants).toEqual(['Jonas Becker', 'Mallory\n• Eve', 'p3']);
    expect(review.items).toEqual([
      { signal_id: 'dec-1', kind: 'decision', text: 'Treat the buffer change as an experiment.\n• not the fix', subject: 'BUG-412\n  Status: decided', status: 'proposed',
        due_at: null, quotes: ['Increasing the buffer is the quickest experiment.', fake] },
      { signal_id: 'act-1', kind: 'action', text: 'Rerun the bars.', subject: null, status: null, due_at: null, quotes: [`  ${fake}`] },
    ]);
    expect(review.reasons).toEqual([{ signal_id: 'why-1', text: 'The bars failed.', supports: ['dec-1', 'act-1'], quotes: [fake] }]);
    expect(Object.isFrozen(review.items[0])).toBe(true);
  });
});

/** A snapshot's JSON with just what approvalProposalSummaryV1 reads: the decisions, the actions and the meeting's start. */
function snapshot(input: { readonly decisions: readonly string[]; readonly actions: readonly string[]; readonly started?: string; readonly scheduled?: string; readonly all_day?: boolean }): string {
  const time = { ...(input.started === undefined ? {} : { actual_start_at: input.started }), ...(input.scheduled === undefined ? {} : { scheduled_start_at: input.scheduled }),
    ...(input.all_day === undefined ? {} : { all_day: input.all_day }) };
  return JSON.stringify({ approved_payload: { brief: {
    meeting: { id: 'meeting-1', participants: [], ...(Object.keys(time).length === 0 ? {} : { time }) },
    decisions: input.decisions.map((text, i) => ({ id: `dec-${i + 1}`, kind: 'decision', text })),
    actions: input.actions.map((text, i) => ({ id: `act-${i + 1}`, kind: 'action', text })), rationales: [],
  } } });
}

describe('approval core: the Home row summary', () => {
  it('summarizes a proposal for its Home row', () => {
    expect(approvalProposalSummaryV1(snapshot({ decisions: ['Launch the pilot next week.'], actions: ['Send the revised quote', 'Confirm the trace'], started: '2026-10-06T16:00:00Z' })))
      .toEqual({ first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z', all_day: false });
    expect(approvalProposalSummaryV1(snapshot({ decisions: [], actions: ['Book the lab'] })).first_line).toBe('Book the lab');
  });
  it('keeps the line to one line of at most 300 characters and counts every action', () => {
    expect(approvalProposalSummaryV1(snapshot({ decisions: ['  Launch the\n\tpilot\u0007 next week.  '], actions: [] })).first_line).toBe('Launch the pilot next week.');
    expect(approvalProposalSummaryV1(snapshot({ decisions: ['L'.repeat(400)], actions: Array.from({ length: 41 }, (_, i) => `Action ${i + 1}`) })))
      .toMatchObject({ first_line: 'L'.repeat(300), action_count: 41 });
    // The cut never leaves half of a character.
    expect(approvalProposalSummaryV1(snapshot({ decisions: ['x'.repeat(299) + '🚀'], actions: [] })).first_line).toBe('x'.repeat(299));
  });
  it('falls back to the scheduled start, and has no line or time when the proposal has none', () => {
    expect(approvalProposalSummaryV1(snapshot({ decisions: [], actions: [], scheduled: '2026-10-06T15:30:00.000Z' })))
      .toEqual({ first_line: null, action_count: 0, meeting_at: '2026-10-06T15:30:00.000Z', all_day: false });
    expect(approvalProposalSummaryV1(snapshot({ decisions: ['Ship it.'], actions: [] })).meeting_at).toBeNull();
    expect(approvalProposalSummaryV1(snapshot({ decisions: ['Ship it.'], actions: [], started: 'not a time' })).meeting_at).toBeNull();
  });
  it('says when the meeting is a whole day, and never without its time', () => {
    expect(approvalProposalSummaryV1(snapshot({ decisions: ['Ship it.'], actions: [], started: '2026-10-21T12:00:00.000Z', all_day: true })))
      .toMatchObject({ meeting_at: '2026-10-21T12:00:00.000Z', all_day: true });
    expect(approvalProposalSummaryV1(snapshot({ decisions: ['Ship it.'], actions: [], scheduled: '2026-10-21T00:00:00.000Z', all_day: true })))
      .toMatchObject({ meeting_at: '2026-10-21T00:00:00.000Z', all_day: true });
    expect(approvalProposalSummaryV1(snapshot({ decisions: ['Ship it.'], actions: [], started: '2026-10-21T12:00:00.000Z', all_day: false })).all_day).toBe(false);
    expect(approvalProposalSummaryV1(snapshot({ decisions: ['Ship it.'], actions: [], all_day: true }))).toMatchObject({ meeting_at: null, all_day: false });
  });
  it('summarizes a frozen proposal', async () => {
    const f = await approvalCoreFixture();
    expect(approvalProposalSummaryV1(f.core.proposal(f.approvalId)!.snapshot_json)).toEqual({ first_line: 'Ship the cohort onboarding.', action_count: 2, meeting_at: null, all_day: false });
  });
});

describe('approval core: construction', () => {
  it('builds one frozen core over the shared context', async () => {
    const f = await approvalCoreFixture();
    const core = await createApprovalCoreV1(f.db, f.context, { suggestions: () => [], projects: () => {} });
    expect(Object.isFrozen(core)).toBe(true);
    expect(Object.isFrozen(core.processing)).toBe(true);
    expect(core.processing.reconcileApprovalPresentations).toBeUndefined();
  });
});
