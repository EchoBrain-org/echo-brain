import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256, type JsonValue } from '@echo-brain/federation-protocol';
import { approvalRecordIdV2 } from '@echo-brain/organization-protocol';
import { SqliteApprovalWorkflowStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { bindApprovalWorkflowStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/approval-workflow-state-v1';
import { approvalCoreFixture } from './fixtures/approval-core.js';
import {
  approvalDecisionReceiptJsonV1, createApprovalCoreV1, createApprovalPublisherV1,
  type AfterApprovedRecordEventV1, type AfterApprovedRecordHookV1, type ApprovalDecisionBodyV1, type ApprovalDecisionReceiptV1,
} from '../src/composition/approval-core-v1.js';
import { buildApprovalDecisionRecordsV1 } from '../src/composition/approval-decision-projection-v1.js';
import { confirmedOwners } from '../src/composition/person-meeting-items-v1.js';
import { coreRuntimeIdentityV1, observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';

const signal = () => new AbortController().signal;
const publishedCount = (f: { db: import('better-sqlite3').Database }) => f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1 WHERE receipt_json IS NOT NULL').pluck().get() as number;
const decisionBody = (f: { db: import('better-sqlite3').Database }, id: string) =>
  JSON.parse(f.db.prepare('SELECT body_json FROM authority_approval_decisions_v1 WHERE approval_id=?').pluck().get(id) as string) as ApprovalDecisionBodyV1;
const hookLog = (f: { db: import('better-sqlite3').Database }) => { f.db.exec('CREATE TEMP TABLE IF NOT EXISTS hook_log(approval_id TEXT NOT NULL, hook TEXT NOT NULL)'); };
const logged = (f: { db: import('better-sqlite3').Database }) => f.db.prepare('SELECT hook FROM temp.hook_log ORDER BY rowid').pluck().all();
/** The stored receipt's records of one approval. */
const receiptRecords = (f: { receipt: (id?: string) => string | null | undefined }, id?: string) => (JSON.parse(f.receipt(id)!) as ApprovalDecisionReceiptV1).records;
const restore: (() => void)[] = [];
afterEach(() => { for (const undo of restore.splice(0)) undo(); });

describe('approval publisher: the brief', () => {
  it('links each committed publication to intake and its later research event outside the receipt transaction', async () => {
    const observations: CoreRuntimeObservationV1[] = [];
    const publicationStates: unknown[] = [];
    const f = await approvalCoreFixture({ after_record: [(tx, event) => {
      tx.prepare("INSERT INTO temp.hook_log VALUES (?, 'committed')").run(event.approval_id);
    }] });
    hookLog(f);
    f.core.decide('desktop', f.approve(), () => f.session);
    await observeCoreRuntimeV1('worker_execution', () => f.core.processing.appendFinalizedApprovalsToV4(signal()), {
      observer(event) {
        if (event.event_id !== undefined) {
          publicationStates.push({ inTransaction: f.db.inTransaction, published: publishedCount(f), hooks: logged(f) });
        }
        observations.push(event);
      },
    });
    const publication = observations.find(event => event.phase === 'record_append' && event.event === 'succeeded');
    const provenance = f.context.state.readFrozenCandidateForApproval(f.approvalId)!.meeting.provenance;
    const [record] = receiptRecords(f);
    // The record's own approval id is its run's event_ref, so the publication joins the record's later research run.
    expect(record!.approval_id).toBe(approvalRecordIdV2(f.approvalId, []));
    expect(publication).toMatchObject({ result: 'published',
      event_id: coreRuntimeIdentityV1('research-event', record!.approval_id),
      output_id: coreRuntimeIdentityV1('research-output', record!.record_sha256),
      source_revision: coreRuntimeIdentityV1('source_revision', JSON.stringify([provenance.external_id, provenance.canonical_revision])),
    });
    expect(observations.filter(event => event.event_id !== undefined)).toEqual([publication]);
    expect(publicationStates).toEqual([{ inTransaction: false, published: 1, hooks: ['committed'] }]);
    expect(JSON.stringify(observations)).not.toContain(f.approvalId);
  });
  it('does not claim publication when a hook rolls back and observation failures cannot undo a later commit', async () => {
    let fail = true;
    const f = await approvalCoreFixture({ after_record: [() => { if (fail) throw new Error('hook failed'); }] });
    f.core.decide('desktop', f.approve(), () => f.session);
    const observations: CoreRuntimeObservationV1[] = [];
    await expect(observeCoreRuntimeV1('worker_execution', () => f.core.processing.appendFinalizedApprovalsToV4(signal()), {
      observer: event => { observations.push(event); },
    })).rejects.toThrow('hook failed');
    expect(f.receipt()).toBeNull();
    expect(observations.every(event => event.event_id === undefined && event.output_id === undefined)).toBe(true);
    fail = false;
    await observeCoreRuntimeV1('worker_execution', () => f.core.processing.appendFinalizedApprovalsToV4(signal()), {
      observer: () => { throw new Error('telemetry failed'); },
    });
    expect(publishedCount(f)).toBe(1);
    expect(f.recordCount()).toBe(1);
  });
  it('runs every hook once inside the receipt transaction, even after a crash between append and receipt', async () => {
    const calls: unknown[] = [];
    const f = await approvalCoreFixture({ after_record: [(tx, event) => { expect(tx.inTransaction).toBe(true); calls.push(event); }] });
    f.core.decide('desktop', f.approve(), () => f.session);
    const interrupted = await f.withAppend(async (input, append) => { await append(input); throw new Error('crash after append'); });
    await expect(interrupted.processing.appendFinalizedApprovalsToV4(new AbortController().signal)).rejects.toThrow('crash');
    expect(f.receipt()).toBeNull();
    expect(calls).toHaveLength(0);
    await f.core.processing.recoverV4Appends(new AbortController().signal);
    await f.core.processing.recoverV4Appends(new AbortController().signal);
    expect(f.recordCount()).toBe(1);
    expect(f.core.proposal(f.approvalId)!.status).toBe('approved');
    expect(calls).toEqual([expect.objectContaining({ approval_id: approvalRecordIdV2(f.approvalId, []), proposal_approval_id: f.approvalId, record_sha256: expect.stringMatching(/^sha256:/) })]);
  });
  it('writes no record and runs no hook for a rejection', async () => {
    const calls: unknown[] = [];
    const f = await approvalCoreFixture({ after_record: [(_tx, e) => calls.push(e)] });
    f.core.decide('desktop', f.reject(), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(new AbortController().signal);
    expect(f.recordCount()).toBe(0);
    expect(f.receipt()).toBeNull();
    expect(f.core.proposal(f.approvalId)!.status).toBe('rejected');
    expect(calls).toEqual([]);
  });
});

describe('approval publisher: hooks', () => {
  it('gives each hook the transaction, the written receipt, the record and its proposal, the reviewer and the decision time', async () => {
    const seen: { event: AfterApprovedRecordEventV1; in_transaction: boolean; stored: unknown }[] = [];
    const f = await approvalCoreFixture({ after_record: [(tx, event) => {
      seen.push({ event, in_transaction: tx.inTransaction,
        stored: tx.prepare(`SELECT json_extract(record.value, '$.record_sha256') FROM authority_approval_decisions_v1, json_each(receipt_json, '$.records') AS record
          WHERE approval_id=? AND json_extract(record.value, '$.approval_id')=?`).pluck().get(event.proposal_approval_id, event.approval_id) });
    }] });
    f.core.decide('desktop', f.approve(), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    expect(seen).toHaveLength(1);
    const [{ event, in_transaction, stored }] = seen as [typeof seen[number]];
    const record = f.lastRecord(), ref = record.body.human_act_resolution_ref, body = decisionBody(f, f.approvalId);
    expect(in_transaction).toBe(true);
    expect(stored).toBe(event.record_sha256);
    expect(event.approval_id).toBe(ref.approval_id);
    expect(event.proposal_approval_id).toBe(f.approvalId);
    expect(event.record_sha256).toBe(f.record.prepare('SELECT record_sha256 FROM organization_record_log').pluck().get());
    expect(event.reviewer).toEqual({ organization_id: record.body.organization_id, principal_id: ref.final_approver.principal_id, membership_id: ref.final_approver.membership_id });
    expect(event.reviewer).toEqual({ organization_id: f.actor.organization_id, principal_id: f.actor.principal_id, membership_id: f.actor.membership_id });
    expect(event.decided_at).toBe(ref.approved_at);
    expect(event.decided_at).toBe(body.decided_at);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.reviewer)).toBe(true);
  });
  it('runs hooks in registration order and rolls the receipt back when one throws', async () => {
    let failures = 1;
    const f = await approvalCoreFixture({ after_record: [
      (tx, e) => { tx.prepare("INSERT INTO temp.hook_log VALUES (?, 'A')").run(e.approval_id); },
      (tx, e) => { if (failures-- > 0) throw new Error('hook B failed'); tx.prepare("INSERT INTO temp.hook_log VALUES (?, 'B')").run(e.approval_id); },
    ] });
    hookLog(f);
    f.core.decide('desktop', f.approve(), () => f.session);
    await expect(f.core.processing.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('hook B failed');
    expect(f.receipt()).toBeNull();
    expect(logged(f)).toEqual([]);
    expect(f.recordCount()).toBe(1);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    expect(logged(f)).toEqual(['A', 'B']);
    expect(publishedCount(f)).toBe(1);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    expect(logged(f)).toEqual(['A', 'B']);
  });
  it('accepts synchronous hooks that return a value', async () => {
    const calls: AfterApprovedRecordEventV1[] = [];
    // Each returns a value (a RunResult, a number); only a thenable is refused.
    const returning: ((tx: import('better-sqlite3').Database, e: AfterApprovedRecordEventV1) => unknown)[] = [
      (tx, e) => tx.prepare("INSERT INTO temp.hook_log VALUES (?, 'run')").run(e.approval_id),
      (_tx, e) => calls.push(e),
    ];
    const f = await approvalCoreFixture({ after_record: returning as AfterApprovedRecordHookV1[] });
    hookLog(f);
    f.core.decide('desktop', f.approve(), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    expect(publishedCount(f)).toBe(1);
    expect(logged(f)).toEqual(['run']);
    expect(calls).toHaveLength(1);
  });
  it('refuses async hook functions and after_record entries that are not functions at registration', async () => {
    const f = await approvalCoreFixture();
    let ran = 0;
    const hook = async () => { ran++; throw new Error('x'); };
    expect(() => createApprovalPublisherV1(f.db, f.context, [hook as unknown as AfterApprovedRecordHookV1])).toThrow(TypeError);
    expect(() => createApprovalPublisherV1(f.db, f.context, [hook as unknown as AfterApprovedRecordHookV1])).toThrow(/synchronous/);
    await expect(f.create({}, { after_record: [async () => {}] as unknown as AfterApprovedRecordHookV1[] })).rejects.toThrow(TypeError);
    await expect(createApprovalCoreV1(f.db, f.context, { suggestions: () => [], projects: () => {}, after_record: [async function* () {}] as unknown as AfterApprovedRecordHookV1[] })).rejects.toThrow(/synchronous/);
    for (const bad of [[1], [null], ['hook'], [{}]] as unknown as AfterApprovedRecordHookV1[][]) {
      expect(() => createApprovalPublisherV1(f.db, f.context, bad)).toThrow(TypeError);
      await expect(f.create({}, { after_record: bad })).rejects.toThrow(TypeError);
    }
    expect(() => createApprovalPublisherV1(f.db, f.context, 'hooks' as unknown as AfterApprovedRecordHookV1[])).toThrow(TypeError);
    f.core.decide('desktop', f.approve(), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    expect(ran).toBe(0);
  });
  it('refuses a hook that returns a promise without leaving an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    restore.push(() => process.off('unhandledRejection', unhandled));
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const promising = f.publisher([(() => Promise.reject(new Error('late'))) as unknown as AfterApprovedRecordHookV1]);
    await expect(promising.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('returned a promise');
    expect(f.receipt()).toBeNull();
    expect(f.recordCount()).toBe(1);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
    let calls = 0;
    await f.publisher([() => { calls++; }]).appendFinalizedApprovalsToV4(signal());
    expect(calls).toBe(1);
    expect(publishedCount(f)).toBe(1);
    expect(f.recordCount()).toBe(1);
  });
});

describe('approval publisher: R30(d) two publishers', () => {
  it('runs no hook when another publisher already wrote the receipt', async () => {
    const f = await approvalCoreFixture({ file: true });
    const peer = await f.peer();
    f.core.decide('desktop', f.approve(), () => f.session);
    let count = 0;
    const counter = () => { count++; };
    let release!: () => void, appended!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { appended = resolve; });
    const shared = f.context.record_append;
    const p1 = f.publisher([counter], undefined, { async append(input) { const result = await shared.append(input); appended(); await gate; return result; } });
    const p2 = f.publisher([counter], peer);
    const first = p1.appendFinalizedApprovalsToV4(signal());
    await reached;
    await p2.appendFinalizedApprovalsToV4(signal());
    expect(count).toBe(1);
    const stored = f.receipt();
    release();
    await first;
    expect(count).toBe(1);
    expect(f.recordCount()).toBe(1);
    expect(publishedCount(f)).toBe(1);
    expect(f.receipt()).toBe(stored);
  });
  it('refuses a zero-change receipt that names another record', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    let count = 0;
    const shared = f.context.record_append;
    let gateRelease!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { gateRelease = resolve; });
    const reachedP = new Promise<void>(resolve => { reached = resolve; });
    const stub = f.publisher([() => { count++; }], undefined, { async append(input) {
      const result = await shared.append(input);
      reached(); await gate;
      const other = canonicalSha256('another record');
      return { ...result, record_sha256: other, receipt: { ...(result.receipt as object), body: { ...(result.receipt as { body: object }).body, record_sha256: other } } } as typeof result;
    } });
    const real = f.publisher([() => { count++; }]);
    const pending = stub.appendFinalizedApprovalsToV4(signal());
    await reachedP;
    await real.appendFinalizedApprovalsToV4(signal());
    expect(count).toBe(1);
    gateRelease();
    await expect(pending).rejects.toThrow('approval receipt conflicts with the stored records');
    expect(count).toBe(1);
  });
  it('Race: desktop and Slack decide on two handles and publish one record', async () => {
    const f = await approvalCoreFixture({ file: true });
    const peer = await f.peer();
    expect(f.core.decide('desktop', f.approve(), () => f.session)).toMatchObject({ kind: 'decided', surface: 'desktop' });
    expect(peer.core.decide('slack', f.approve({ command_id: 'slack:race' }), () => f.click)).toEqual({ kind: 'already_decided', status: 'publishing', surface: 'desktop' });
    expect(f.decisionCount()).toBe(1);
    expect(peer.core.proposal(f.approvalId)!.status).toBe('publishing');
    await Promise.all([f.core.processing.appendFinalizedApprovalsToV4(signal()), peer.core.processing.appendFinalizedApprovalsToV4(signal())]);
    expect(f.recordCount()).toBe(1);
    expect(publishedCount(f)).toBe(1);
    expect(f.lastRecord().body.human_act_resolution_ref.surface).toBe('desktop');
    expect(peer.core.proposal(f.approvalId)!.status).toBe('approved');
  });
  it('Race: a peer finishes an append interrupted before its receipt', async () => {
    const f = await approvalCoreFixture({ file: true });
    const peer = await f.peer();
    f.core.decide('desktop', f.approve(), () => f.session);
    const interrupted = f.withAppend(async (input, append) => { await append(input); throw new Error('interrupted after signed append'); });
    await expect(interrupted.processing.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('interrupted');
    expect(f.receipt()).toBeNull();
    await peer.core.processing.recoverV4Appends(signal());
    expect(f.recordCount()).toBe(1);
    expect(f.core.proposal(f.approvalId)!.status).toBe('approved');
  });
});

describe('approval publisher: records', () => {
  it('records a Slack decision', async () => {
    const f = await approvalCoreFixture();
    expect(f.core.decide('slack', f.approve({ command_id: 'slack:k1' }), () => f.click).kind).toBe('decided');
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    const record = f.lastRecord(), ref = record.body.human_act_resolution_ref;
    expect(ref).toMatchObject({ surface: 'slack', command_id: 'slack:k1', audit_event_id: 'audit:slack:k1' });
    expect(f.core.proposal(f.approvalId)!.status).toBe('approved');
  });
  it('rebuilds the identical references on recovery', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno' } });
    f.core.decide('desktop', f.approve({ routes: f.routes(id => id === 'decision-1' ? [] : [f.projectA]), owners: [{ signal_id: 'act-1', owner: 'Rafael' }] }), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    const row = f.db.prepare('SELECT sequence, body_json FROM authority_approval_decisions_v1').get() as { sequence: number; body_json: string };
    const frozen = f.context.state.readFrozenCandidateForApproval(f.approvalId)!;
    const source = { coordinates: f.context.coordinates, decision: { sequence: row.sequence, body: JSON.parse(row.body_json) },
      candidate_sha256: frozen.candidate_semantic_sha256 as `sha256:${string}`, approved_snapshot: frozen.approved_snapshot };
    const built = buildApprovalDecisionRecordsV1(source);
    expect(canonicalJson(buildApprovalDecisionRecordsV1(source) as unknown as JsonValue)).toBe(canonicalJson(built as unknown as JsonValue));
    const records = f.records();
    expect(built).toHaveLength(2);
    expect(records).toHaveLength(2);
    for (const [index, record] of records.entries()) {
      expect(built[index]!.semantic_idempotency_key).toBe(record.body.semantic_idempotency_key);
      expect(canonicalJson(built[index]!.human_act_record_input.approval_decision_ref_v2 as unknown as JsonValue)).toBe(canonicalJson(record.body.human_act_resolution_ref));
    }
  });
  it('records no transcript choice or source, whatever the destination (ADR-0046)', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ routes: f.routes(id => id === 'decision-1' ? [] : [f.projectA]) }), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    expect(f.records()).toHaveLength(2);
    for (const record of f.records()) {
      for (const field of ['share_transcript', 'transcript_source']) {
        expect(record.body.human_act_resolution_ref).not.toHaveProperty(field);
        expect(record.body.event.policy_consequence).not.toHaveProperty(field);
      }
    }
  });
  it('publishes from the decision frozen at decide, after the meeting\'s retained revision changes', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const body = decisionBody(f, f.approvalId);
    // Retention changes after the decision (the revision rows are otherwise immutable).
    f.db.exec('DROP TRIGGER authority_source_revisions_v1_update_denied');
    f.db.prepare('UPDATE authority_source_revisions_v1 SET revision_sha256=?').run('0'.repeat(64));
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    expect(f.recordCount()).toBe(1);
    // The impact run still finds the meeting's own source in the decision, never in the record.
    expect(decisionBody(f, f.approvalId).transcript_source).toEqual(body.transcript_source);
  });
  it('keeps the snapshot owner-free and records only confirmed owners', async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno', 'act-2': 'Ana Lima' } });
    f.core.decide('desktop', f.approve({ owners: [{ signal_id: 'act-2', owner: 'Ana L.' }] }), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    const record = f.lastRecord();
    expect(record.body.human_act_resolution_ref.action_owners).toEqual([{ signal_id: 'act-2', owner: 'Ana L.' }]);
    expect(JSON.stringify(record.body.event)).not.toMatch(/Rafael|Ana/);
  });
  it("indexes confirmed owners from an approval decision reference: the published record's confirmed owners reach the search snapshot text", async () => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno', 'act-2': 'Jules Ortega' } });
    f.core.decide('desktop', f.approve({ owners: [{ signal_id: 'act-1', owner: 'Rafael M.' }] }), () => f.session);
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    const atoms = f.snapshotAtoms();
    const text = (prefix: string) => atoms.find(atom => atom.item_kind === 'action' && atom.text.startsWith(prefix))!.text;
    // atomText appends " Owner: <owner>." verbatim, so an owner ending in a period ends with two.
    expect(text('Follow up on item 1.')).toBe(`Follow up on item 1. Owner: ${'Rafael M.'}.`);
    expect(text('Follow up on item 2.')).not.toContain('Owner:');
    const ref = f.lastRecord().body.human_act_resolution_ref;
    expect(confirmedOwners(ref)).toEqual(new Map([['act-1', 'Rafael M.']]));
    const twice = { ...ref, action_owners: [{ signal_id: 'act-1', owner: 'A' }, { signal_id: 'act-1', owner: 'B' }] };
    expect(() => confirmedOwners(twice)).toThrow();
    const repeat = (envelope: unknown) => {
      const copy = JSON.parse(JSON.stringify(envelope));
      copy.body.human_act_resolution_ref.action_owners = twice.action_owners;
      return copy;
    };
    // With the production protocols the approval-decision codec refuses the repeat first ...
    expect(() => f.snapshotAtoms(repeat)).toThrow('owners must name approved actions once');
    // ... and the snapshot's own field reader refuses it too.
    const binding = { policy_id: 'restricted-reviewer-person-v2' as const, policy_contract_sha256: ref.policy_contract_sha256 };
    expect(() => f.snapshotAtoms(repeat, { policyBinding: () => binding, project: () => { throw new Error('unused'); } })).toThrow('confirmed action owners must name each action once');
  });
  it.each([[[]], [['A']], [['A', 'B']]] as const)('publishes every item to the exact audience %j with its owners, and recovers once', async (names) => {
    const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno', 'act-2': 'Jules Ortega' } });
    const ids = names.map(name => f.project(name));
    const request = f.approve({ routes: f.routes(ids), owners: [{ signal_id: 'act-1', owner: 'Rafael M.' }] });
    expect(f.core.decide('desktop', request, () => f.session)).toMatchObject({ kind: 'decided', status: 'publishing' });
    const resumed = await f.create();
    await resumed.processing.recoverV4Appends(signal());
    expect(resumed.decide('desktop', request, () => f.session)).toMatchObject({ kind: 'replayed', status: 'approved' });
    await resumed.processing.recoverV4Appends(signal());
    expect(f.recordCount()).toBe(1);
    const envelope = f.lastRecord(), ref = envelope.body.human_act_resolution_ref;
    expect(ref).toMatchObject({ kind: 'echo-approval-decision-ref-v2', schema_version: 2, surface: 'desktop',
      approval_id: approvalRecordIdV2(f.approvalId, ids), proposal_approval_id: f.approvalId, proposal_snapshot_sha256: request.snapshot_sha256,
      route_signal_ids: ['decision-1', 'act-1', 'act-2'], provider_action_kind: 'echo-approval-decision-v2', provider_action_schema_version: 2 });
    expect(ref.audience_project_ids).toEqual(ids);
    expect(ref.association_project_ids).toEqual(ids);
    expect(ref.action_owners).toEqual([{ signal_id: 'act-1', owner: 'Rafael M.' }]); // act-2 cleared, so absent
    expect(ref.selected_policy_id).toBe(ids.length === 0 ? 'restricted-reviewer-person-v2' : 'project-members-readable-person-v1');
    // One destination holds the whole proposal: its subset is the snapshot the reviewer saw, under the record's own id.
    const proposal = JSON.parse(f.core.proposal(f.approvalId)!.snapshot_json);
    expect(envelope.body.event.approved_snapshot.approved_payload.brief).toEqual(proposal.approved_payload.brief);
    expect(envelope.body.event.approved_snapshot.approval_id).toBe(ref.approval_id);
    const actions = envelope.body.event.approved_snapshot.approved_payload.brief.actions as { owner: unknown }[];
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(action => action.owner === null)).toBe(true);
    expect(resumed.decide('desktop', { ...request, routes: f.routes(id => id === 'act-2' ? null : ids) }, () => f.session).kind).toBe('already_decided');
  });
  it('stores one receipt entry per record, each with its signed receipt', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ routes: f.routes(id => id === 'decision-1' ? [f.projectA] : []) }), () => f.session);
    const captured: { approval_id: string; record_sha256: string; receipt: unknown }[] = [];
    const shared = f.context.record_append;
    await f.publisher([], undefined, { async append(input) { const result = await shared.append(input); captured.push({ approval_id: input.approval_id, ...result }); return result; } })
      .appendFinalizedApprovalsToV4(signal());
    const records = receiptRecords(f);
    expect(records.map(record => [record.approval_id, record.project_ids])).toEqual([
      [approvalRecordIdV2(f.approvalId, [f.projectA]), [f.projectA]], [approvalRecordIdV2(f.approvalId, []), []]]);
    expect(records.map(record => record.record_sha256)).toEqual(f.record.prepare('SELECT record_sha256 FROM organization_record_log ORDER BY position').pluck().all());
    expect(records.map(record => record.approval_id)).toEqual(captured.map(entry => entry.approval_id));
    for (const [index, record] of records.entries()) {
      expect((record.receipt as { body: { record_sha256: string } }).body.record_sha256).toBe(record.record_sha256);
      expect(record.receipt).toEqual(JSON.parse(JSON.stringify(captured[index]!.receipt)));
    }
    expect(f.receipt()).toBe(approvalDecisionReceiptJsonV1(captured.map((entry, index) => ({ ...entry, project_ids: records[index]!.project_ids }))));
    expect(() => approvalDecisionReceiptJsonV1([{ approval_id: records[0]!.approval_id, project_ids: [], record_sha256: canonicalSha256('other'), receipt: captured[0]!.receipt }])).toThrow();
    expect(() => approvalDecisionReceiptJsonV1([])).toThrow();
  });
  it('publishes a decided proposal after a newer revision superseded it', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    const next = await f.newRevision();
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    expect(f.recordCount()).toBe(1);
    expect(f.core.proposal(f.approvalId)!.status).toBe('approved');
    expect(f.core.proposal(next.approvalId)!.status).toBe('pending');
  });
});

/** A meeting for THERM (project A), ECHO (project B) and its reviewer: three decisions, three actions with proposed owners, and four reasons. */
async function destinationsFixture(after_record: readonly AfterApprovedRecordHookV1[] = []) {
  const f = await approvalCoreFixture({
    decisions: [{ id: 'dec-1' }, { id: 'dec-2' }, { id: 'dec-3' }],
    actions: [{ id: 'act-1', owner: 'Rafael Moreno' }, { id: 'act-2', owner: 'Ana Lima' }, { id: 'act-3', owner: 'Jules Ortega' }],
    rationales: [{ id: 'why-1', supports: ['dec-1', 'dec-2'] }, { id: 'why-2', supports: ['dec-3'] }, { id: 'why-3', supports: [] }, { id: 'why-4', supports: ['act-3'] }, { id: 'why-5', supports: ['dec-1', 'act-2'] }],
    after_record,
  });
  const THERM = [f.projectA], BOTH = [f.projectA, f.projectB];
  const to: Readonly<Record<string, readonly string[] | null>> = { 'dec-1': THERM, 'dec-2': BOTH, 'dec-3': null, 'act-1': BOTH, 'act-2': THERM, 'act-3': [] };
  const request = f.approve({ routes: f.routes(id => to[id]!), owners: [{ signal_id: 'act-1', owner: 'Rafael M.' }, { signal_id: 'act-2', owner: 'Ana L.' }, { signal_id: 'act-3', owner: 'Jules O.' }] });
  return { ...f, THERM, BOTH, request };
}
const ids = (signals: readonly { readonly id: string }[]) => signals.map(signal => signal.id);

describe('approval publisher: destinations', () => {
  it('publishes one record per destination group, each holding only its own items, reasons and owners', async () => {
    const events: AfterApprovedRecordEventV1[] = [];
    const f = await destinationsFixture([(_tx, event) => { events.push(event); }]);
    expect(f.core.decide('desktop', f.request, () => f.session).kind).toBe('decided');
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    const records = f.records();
    // Ordered by each group's first item: dec-1 (THERM), dec-2 (THERM and ECHO), act-3 (Only me).
    expect(records.map(record => record.body.human_act_resolution_ref.audience_project_ids)).toEqual([f.THERM, f.BOTH, []]);
    const refs = records.map(record => record.body.human_act_resolution_ref);
    expect(refs.map(ref => ref.approval_id)).toEqual([f.THERM, f.BOTH, []].map(projects => approvalRecordIdV2(f.approvalId, projects)));
    expect(new Set(refs.map(ref => ref.approval_id)).size).toBe(3);
    for (const ref of refs) {
      expect(ref).toMatchObject({ proposal_approval_id: f.approvalId, proposal_snapshot_sha256: f.request.snapshot_sha256, command_id: 'desk-approve' });
      expect(ref.association_project_ids).toEqual(ref.audience_project_ids);
    }
    expect(refs.map(ref => ref.selected_policy_id)).toEqual(['project-members-readable-person-v1', 'project-members-readable-person-v1', 'restricted-reviewer-person-v2']);
    expect(refs.map(ref => ref.route_signal_ids)).toEqual([['dec-1', 'act-2'], ['dec-2', 'act-1'], ['act-3']]);
    expect(refs.map(ref => ref.action_owners)).toEqual([[{ signal_id: 'act-2', owner: 'Ana L.' }], [{ signal_id: 'act-1', owner: 'Rafael M.' }], [{ signal_id: 'act-3', owner: 'Jules O.' }]]);
    // Every record physically holds only its subset: a record is released verbatim.
    const briefs = records.map(record => record.body.event.approved_snapshot.approved_payload.brief);
    expect(briefs.map(brief => [ids(brief.decisions), ids(brief.actions)])).toEqual([[['dec-1'], ['act-2']], [['dec-2'], ['act-1']], [[], ['act-3']]]);
    expect(JSON.stringify(records)).not.toContain('dec-3');
    // The append witness carries the whole snapshot the reviewer saw, but the log never stores it: no row names the item not kept.
    expect(JSON.stringify(f.record.prepare('SELECT * FROM organization_record_log').all())).not.toContain('dec-3');
    // A project reads a reason, whole, only when it holds every item the reason supports: why-1 speaks of dec-1 and dec-2,
    // routed to different projects, so neither reads it. Only me keeps its own reasons and the one supporting nothing; one
    // supporting only an item not kept is left out.
    expect(briefs.map(brief => brief.rationales.map((reason: { id: string; supports_signal_ids: string[] }) => [reason.id, reason.supports_signal_ids]))).toEqual([
      [['why-5', ['dec-1', 'act-2']]], [], [['why-3', []], ['why-4', ['act-3']]]]);
    for (const reason of ['why-1', 'why-2']) expect(JSON.stringify(records)).not.toContain(reason);
    for (const [index, record] of records.entries()) {
      const snapshot = record.body.event.approved_snapshot;
      expect(snapshot.approval_id).toBe(refs[index]!.approval_id);
      expect(refs[index]!.approved_snapshot_sha256).toBe(canonicalSha256(snapshot));
      expect(snapshot.final_content_sha256).toBe(canonicalSha256(snapshot.approved_payload));
      expect(snapshot.approved_payload.brief.actions.every((action: { owner: unknown }) => action.owner === null)).toBe(true);
    }
    // Every record shares the decision's witness digests.
    expect(new Set(refs.map(ref => ref.provider_action_sha256)).size).toBe(1);
    expect(new Set(refs.map(ref => ref.audit_entry_sha256)).size).toBe(1);
    // One receipt with every record in group order, and one hook call per record, in that order.
    expect(receiptRecords(f).map(record => [record.approval_id, record.project_ids, record.record_sha256]))
      .toEqual(refs.map((ref, index) => [ref.approval_id, ref.audience_project_ids, records[index]!.record_sha256]));
    expect(events.map(event => [event.approval_id, event.proposal_approval_id, event.record_sha256])).toEqual(refs.map((ref, index) => [ref.approval_id, f.approvalId, records[index]!.record_sha256]));
    // Each record's facts follow its own audience.
    const projects = (record_sha256: string) => f.record.prepare('SELECT project_id FROM organization_record_project_association_v1 WHERE record_sha256=? ORDER BY project_id').pluck().all(record_sha256);
    expect(records.map(record => projects(record.record_sha256))).toEqual([f.THERM, f.BOTH, []]);
    expect(f.record.prepare('SELECT DISTINCT record_sha256 FROM organization_record_restricted_reviewer_person_fact').pluck().all()).toEqual([records[2]!.record_sha256]);
    expect(f.core.proposal(f.approvalId)).toMatchObject({ status: 'approved', project_ids: f.BOTH,
      records: refs.map(ref => ({ approval_id: ref.approval_id, project_ids: ref.audience_project_ids })) });
  });
  it('builds every group before the first append, so a group it cannot build appends nothing', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ routes: f.routes(id => id === 'decision-1' ? [f.projectA] : []) }), () => f.session);
    // A stored body the publisher cannot turn into records for its second group: a project id no record may carry.
    f.db.exec('DROP TRIGGER authority_approval_decision_immutable_v1');
    const body = decisionBody(f, f.approvalId);
    const broken = { ...body, request: { ...body.request, routes: body.request.routes.map(route => route.signal_id === 'act-2' ? { ...route, project_ids: ['prj_broken'] } : route) } };
    f.db.prepare('UPDATE authority_approval_decisions_v1 SET body_json=? WHERE approval_id=?').run(canonicalJson(broken as unknown as JsonValue), f.approvalId);
    const appends: string[] = [];
    const publisher = f.withAppend((input, append) => { appends.push(input.approval_id); return append(input); });
    await expect(publisher.processing.appendFinalizedApprovalsToV4(signal())).rejects.toThrow();
    expect(appends).toEqual([]);
    expect(f.recordCount()).toBe(0);
    expect(f.receipt()).toBeNull();
  });
  it('retries after a partial append: the groups already in the log return duplicate, and one receipt names them all', async () => {
    const events: AfterApprovedRecordEventV1[] = [];
    const f = await destinationsFixture([(_tx, event) => { events.push(event); }]);
    f.core.decide('desktop', f.request, () => f.session);
    let calls = 0;
    const interrupted = f.withAppend(async (input, append) => { if (++calls === 2) throw new Error('crash before the second group'); return append(input); });
    await expect(interrupted.processing.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('crash before the second group');
    expect(f.recordCount()).toBe(1);
    expect(f.receipt()).toBeNull();
    expect(events).toEqual([]);
    const outcomes: string[] = [];
    const retry = f.withAppend(async (input, append) => { const result = await append(input); outcomes.push(result.outcome); return result; });
    await retry.processing.recoverV4Appends(signal());
    expect(outcomes).toEqual(['duplicate', 'appended', 'appended']);
    expect(f.recordCount()).toBe(3);
    expect(receiptRecords(f)).toHaveLength(3);
    expect(events).toHaveLength(3);
    await retry.processing.recoverV4Appends(signal());
    await f.core.processing.recoverV4Appends(signal());
    expect(outcomes).toHaveLength(3);
    expect(events).toHaveLength(3);
    expect(publishedCount(f)).toBe(1);
  });
  it('links each record to its own research event', async () => {
    const observations: CoreRuntimeObservationV1[] = [];
    const f = await destinationsFixture();
    f.core.decide('desktop', f.request, () => f.session);
    await observeCoreRuntimeV1('worker_execution', () => f.core.processing.appendFinalizedApprovalsToV4(signal()), { observer(event) { observations.push(event); } });
    const linked = observations.filter(event => event.event_id !== undefined);
    expect(linked.map(event => event.event_id)).toEqual(receiptRecords(f).map(record => coreRuntimeIdentityV1('research-event', record.approval_id)));
    expect(linked.map(event => event.output_id)).toEqual(receiptRecords(f).map(record => coreRuntimeIdentityV1('research-output', record.record_sha256)));
    expect(linked.every(event => event.phase === 'record_append' && event.result === 'published')).toBe(true);
  });
});

describe('approval publisher: failures', () => {
  it('isolates a failing approval: recovery publishes the rest, append still rejects, and each pass retries the row', async () => {
    const f = await approvalCoreFixture();
    const other = await f.otherProposal();
    f.core.decide('desktop', f.approve(), () => f.session);
    f.core.decide('desktop', f.approve({ approval_id: other.approvalId, command_id: 'desk-other' }), () => f.session);
    let attempts = 0;
    const failing = f.withAppend((input, append) => { if (input.approval_id === approvalRecordIdV2(f.approvalId, [])) { attempts++; throw new Error('first approval cannot publish'); } return append(input); });
    await failing.processing.recoverV4Appends(signal());
    expect(publishedCount(f)).toBe(1);
    await expect(failing.processing.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('first approval cannot publish');
    expect(attempts).toBe(2);
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
  it('refuses to publish inside an open Authority transaction', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    // Someone opens a transaction on the Authority handle while the append is in flight; a nested .immediate() would be a savepoint.
    const open = f.publisher([], undefined, { append: async (input) => { const result = await f.context.record_append.append(input); f.db.exec('BEGIN'); return result; } });
    await expect(open.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('idle Authority transaction');
    f.db.exec('ROLLBACK');
    expect(f.receipt()).toBeNull();
    await f.core.processing.appendFinalizedApprovalsToV4(signal());
    expect(publishedCount(f)).toBe(1);
  });
  it('retries a failed signer inspection on the next pass', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    let ready = false, inspections = 0;
    const inspect = f.context.signer.inspect.bind(f.context.signer);
    const publisher = createApprovalPublisherV1(f.db, { ...f.context, signer: { ...f.context.signer, inspect: async () => { inspections++; if (!ready) throw new Error('signer unavailable'); return inspect(); } } }, []);
    await expect(publisher.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('signer unavailable');
    expect(f.recordCount()).toBe(0);
    ready = true;
    await publisher.appendFinalizedApprovalsToV4(signal());
    expect(f.recordCount()).toBe(1);
    expect(inspections).toBeGreaterThanOrEqual(2);
    await publisher.appendFinalizedApprovalsToV4(signal());
    expect(publishedCount(f)).toBe(1);
  });
});
