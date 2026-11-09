import { randomUUID } from 'node:crypto';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { approvalRecordIdV2 } from '@echo-brain/organization-protocol';
import { describe, expect, it, vi } from 'vitest';
import { enqueueApprovedRecordRunV1, SqliteTriggerRunsV1 } from '../src/adapters/persistence/sqlite/trigger-runs-v1.js';
import { approvalCoreFixture } from './fixtures/approval-core.js';
import { approvedRunFixture } from './fixtures/trigger-runs.js';

const signal = () => new AbortController().signal;
const NOW = '2026-10-07T10:00:00.000Z';
/** A stored result; the store never reads inside it. */
const card = () => ({ json: '{"schema_version":1}', sha256: canonicalSha256({ schema_version: 1 }) });

describe('SQLite trigger runs v1', () => {
  it('enqueues exactly one pending run per approved record through the publisher hook', async () => {
    const f = await approvedRunFixture();
    await f.core.processing.recoverV4Appends(signal());
    expect(f.db.prepare('SELECT trigger, event_ref, state FROM authority_trigger_runs_v1').all()).toEqual([
      { trigger: 'approved_record', event_ref: f.recordApprovalId, state: 'pending' },
    ]);
  });

  it('enqueues one run per record of a decision, each keyed by its record approval id', async () => {
    const f = await approvalCoreFixture();
    const runs = new SqliteTriggerRunsV1(f.db);
    const events: string[] = [];
    f.core.decide('desktop', f.approve({ routes: f.routes(id => ({ 'decision-1': [f.projectA], 'act-1': [f.projectA, f.projectB], 'act-2': [] })[id] ?? null) }), () => f.session);
    const enqueue = enqueueApprovedRecordRunV1(runs);
    await f.publisher((tx, event) => { enqueue(tx, event); events.push(event.approval_id); }).appendFinalizedApprovalsToV4(signal());
    const records = (JSON.parse(f.receipt()!) as { records: { approval_id: string; record_sha256: string }[] }).records;
    expect(records).toHaveLength(3);
    expect(events).toEqual(records.map(record => record.approval_id));
    expect(f.db.prepare('SELECT event_ref, record_sha256, state FROM authority_trigger_runs_v1 ORDER BY rowid').all())
      .toEqual(records.map(record => ({ event_ref: record.approval_id, record_sha256: record.record_sha256, state: 'pending' })));
    expect(records.map(record => record.approval_id)).toEqual([[f.projectA], [f.projectA, f.projectB], []].map(projects => approvalRecordIdV2(f.approvalId, projects)));
    // Retries change nothing: the receipt is written, and each record's run already exists.
    await f.publisher(enqueueApprovedRecordRunV1(runs)).recoverV4Appends(signal());
    expect(f.db.prepare('SELECT count(*) FROM authority_trigger_runs_v1').pluck().get()).toBe(3);
    // Each record's siblings are the decision's other records.
    const digests = records.map(record => record.record_sha256 as Sha256Digest);
    for (const digest of digests) expect([...runs.siblingRecords(f.person, digest)].sort()).toEqual(digests.filter(other => other !== digest).sort());
    expect(runs.siblingRecords({ ...f.person, membership_id: 'mem_00000000-0000-4000-8000-0000000000e2' }, digests[0]!)).toEqual([]);
    expect(runs.siblingRecords(f.person, canonicalSha256('unknown record') as Sha256Digest)).toEqual([]);
  });

  it('a run of an approval with one record has no siblings', async () => {
    const f = await approvedRunFixture();
    expect(f.runs.siblingRecords(f.owner, f.recordSha256)).toEqual([]);
  });

  it('refuses a run for a record its approval did not publish, or under another record\'s id', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve({ routes: f.routes(id => id === 'act-2' ? [f.projectA] : []) }), () => f.session);
    await f.publisher(null).appendFinalizedApprovalsToV4(signal());
    const [first, second] = (JSON.parse(f.receipt()!) as { records: { approval_id: string; record_sha256: string }[] }).records;
    const insert = (event_ref: string, record_sha256: string) => () => f.db.prepare(`INSERT INTO authority_trigger_runs_v1
      (run_id, trigger, event_ref, organization_id, principal_id, membership_id, record_sha256, state, attempts, created_at, updated_at)
      VALUES (?, 'approved_record', ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(`run_${randomUUID()}`, event_ref, f.person.organization_id, f.person.principal_id, f.person.membership_id, record_sha256, NOW, NOW);
    expect(insert(first!.approval_id, second!.record_sha256)).toThrow('approved-record run needs its published approval');
    expect(insert(f.approvalId, first!.record_sha256)).toThrow('approved-record run needs its published approval');
    expect(insert(first!.approval_id, canonicalSha256('another record'))).toThrow('approved-record run needs its published approval');
    insert(first!.approval_id, first!.record_sha256)();
    insert(second!.approval_id, second!.record_sha256)();
    expect(f.db.prepare('SELECT count(*) FROM authority_trigger_runs_v1').pluck().get()).toBe(2);
  });

  it('recovers a crash after record append with exactly one enqueued run, while rejection enqueues none', async () => {
    const f = await approvalCoreFixture();
    const runs = new SqliteTriggerRunsV1(f.db);
    const hook = enqueueApprovedRecordRunV1(runs);
    f.core.decide('desktop', f.approve(), () => f.session);
    const crash = f.publisher(hook, undefined, { append: async input => {
      await f.context.record_append.append(input);
      throw new Error('crash after append');
    } });
    await expect(crash.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('crash after append');
    expect(f.db.prepare('SELECT count(*) FROM authority_trigger_runs_v1').pluck().get()).toBe(0);
    await f.publisher(hook).recoverV4Appends(signal());
    await f.publisher(hook).recoverV4Appends(signal());
    expect(f.db.prepare('SELECT trigger, event_ref, state FROM authority_trigger_runs_v1').all()).toEqual([
      { trigger: 'approved_record', event_ref: approvalRecordIdV2(f.approvalId, []), state: 'pending' },
    ]);

    const rejected = await approvalCoreFixture();
    rejected.core.decide('desktop', rejected.reject(), () => rejected.session);
    await rejected.publisher(enqueueApprovedRecordRunV1(new SqliteTriggerRunsV1(rejected.db))).recoverV4Appends(signal());
    expect(rejected.db.prepare('SELECT count(*) FROM authority_trigger_runs_v1').pluck().get()).toBe(0);
  });

  it('refuses a run for an approval that has no receipt', async () => {
    const f = await approvalCoreFixture();
    const digest = canonicalSha256('unpublished record') as Sha256Digest;
    expect(() => f.db.prepare(`INSERT INTO authority_trigger_runs_v1
      (run_id, trigger, event_ref, organization_id, principal_id, membership_id, record_sha256, state, attempts, created_at, updated_at)
      VALUES ('run_unpublished', 'approved_record', 'apr_unpublished', ?, ?, ?, ?, 'pending', 0, '2026-10-07T10:00:00.000Z', '2026-10-07T10:00:00.000Z')`)
      .run(f.person.organization_id, f.person.principal_id, f.person.membership_id, digest)).toThrow('needs its published approval');
  });

  it('keeps lease, result and error fields confined to their matching states', async () => {
    const f = await approvedRunFixture();
    const run = f.runs.list(f.owner, 1)[0]!;
    expect(() => f.db.prepare("UPDATE authority_trigger_runs_v1 SET lease_token='orphan' WHERE run_id=?").run(run.run_id)).toThrow();
    expect(() => f.db.prepare("UPDATE authority_trigger_runs_v1 SET result_json='{}', result_sha256=? WHERE run_id=?")
      .run(canonicalSha256({}), run.run_id)).toThrow();
    expect(() => f.db.prepare("UPDATE authority_trigger_runs_v1 SET error_code='unavailable' WHERE run_id=?").run(run.run_id)).toThrow();
  });

  it('claims once, fences other people and a second live run, then takes over an expired lease', async () => {
    const f = await approvedRunFixture({ runs: 2 });
    const [first, second] = f.runs.list(f.owner, 10);
    expect(first).toBeDefined(); expect(second).toBeDefined();
    expect(f.runs.claim(f.stranger, first!.run_id, 600_000).kind).toBe('not_found');
    expect(f.runs.claim(f.owner, first!.run_id, 600_000).kind).toBe('claimed');
    expect(f.runs.claim(f.owner, first!.run_id, 600_000).kind).toBe('running');
    expect(f.runs.claim(f.owner, second!.run_id, 600_000).kind).toBe('busy');
    f.advance(600_001);
    expect(f.runs.claim(f.owner, first!.run_id, 600_000).kind).toBe('claimed');
  });

  it('names the person\'s oldest queued impact check by created_at, then run id: pending, or running past its lease, and nothing else', async () => {
    const f = await approvalCoreFixture();
    let now = new Date(NOW);
    const runs = new SqliteTriggerRunsV1(f.db, () => now);
    f.core.decide('desktop', f.approve({ routes: f.routes(id => ({ 'decision-1': [f.projectA], 'act-1': [f.projectA, f.projectB], 'act-2': [] })[id] ?? null) }), () => f.session);
    await f.publisher(null).appendFinalizedApprovalsToV4(signal());
    const [first, second, third] = (JSON.parse(f.receipt()!) as { records: { approval_id: string; record_sha256: string }[] }).records;
    // Each record's check, queued under an id and at a time the test picks.
    const queue = (run_id: string, record: { approval_id: string; record_sha256: string }, at: string) => f.db.prepare(`INSERT INTO authority_trigger_runs_v1
      (run_id, trigger, event_ref, organization_id, principal_id, membership_id, record_sha256, state, attempts, created_at, updated_at)
      VALUES (?, 'approved_record', ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(run_id, record.approval_id, f.person.organization_id, f.person.principal_id, f.person.membership_id, record.record_sha256, at, at);
    const next = () => runs.nextQueued(f.person)?.run_id;
    const lease = (run_id: string) => {
      const claimed = runs.claim(f.person, run_id, 600_000);
      if (claimed.kind !== 'claimed') throw new Error(`expected a lease on ${run_id}`);
      return claimed.lease_token;
    };
    expect(next()).toBeUndefined();
    // A leftover sweep, older than every check and first by id, is never a check-in's to start.
    f.db.prepare(`INSERT INTO authority_trigger_runs_v1 (run_id, trigger, event_ref, organization_id, principal_id, membership_id, scope_kind, state, attempts, created_at, updated_at)
      VALUES ('run_0000', 'sweep', 'sweep_leftover', ?, ?, ?, 'mine', 'pending', 0, '2026-10-07T09:00:00.000Z', '2026-10-07T09:00:00.000Z')`).run(f.person.organization_id, f.person.principal_id, f.person.membership_id);
    expect(next()).toBeUndefined();
    queue('run_zzzz', first!, NOW);
    queue('run_aaaa', second!, '2026-10-07T10:05:00.000Z');
    expect(next()).toBe('run_zzzz');                                        // the oldest, though a newer one has the lower id
    queue('run_mmmm', third!, NOW);
    expect(next()).toBe('run_mmmm');                                        // queued at the same time: the lower id
    expect(runs.nextQueued({ ...f.person, membership_id: 'mem_00000000-0000-4000-8000-0000000000f2' })).toBeUndefined();
    // A live attempt is not queued; once its lease lapses it is, since `claim` takes it again.
    const lapsing = lease('run_mmmm');
    expect(next()).toBe('run_zzzz');
    now = new Date(Date.parse(NOW) + 599_999);
    expect(next()).toBe('run_zzzz');
    now = new Date(Date.parse(NOW) + 600_000);
    expect(runs.nextQueued(f.person)).toMatchObject({ run_id: 'run_mmmm', trigger: 'approved_record', state: 'running', lease_token: lapsing });
    // A finished or failed check is not queued, and a failed one is again once it is tried again.
    expect(runs.finish('run_mmmm', lease('run_mmmm'), card())).toBe(true);
    expect(runs.fail('run_zzzz', lease('run_zzzz'), 'research_failed')).toBe(true);
    expect(next()).toBe('run_aaaa');
    expect(runs.retry(f.person, 'run_zzzz')).toBe(true);
    expect(next()).toBe('run_zzzz');
  });

  it('fails after three counted attempts and retries with attempts reset', async () => {
    const f = await approvedRunFixture();
    const run = f.runs.list(f.owner, 1)[0]!;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = f.runs.claim(f.owner, run.run_id, 600_000);
      expect(claimed.kind).toBe('claimed');
      if (claimed.kind !== 'claimed') throw new Error('expected lease');
      f.runs.release(run.run_id, claimed.lease_token, { counted: true, exhausted: 'timed_out' });
      if (attempt < 3) expect(f.runs.read(f.owner, run.run_id)).toMatchObject({ state: 'pending', attempts: attempt });
    }
    expect(f.runs.read(f.owner, run.run_id)).toMatchObject({ state: 'failed', attempts: 3, error_code: 'timed_out' });
    expect(f.runs.retry(f.owner, run.run_id)).toBe(true);
    expect(f.runs.read(f.owner, run.run_id)).toMatchObject({ state: 'pending', attempts: 0, error_code: null });
  });

  it('does not let an expired lease release or count an attempt before a successor claims it', async () => {
    const f = await approvedRunFixture();
    const run = f.runs.list(f.owner, 1)[0]!;
    const claimed = f.runs.claim(f.owner, run.run_id, 600_000);
    if (claimed.kind !== 'claimed') throw new Error('expected lease');
    f.advance(600_001);
    f.runs.release(run.run_id, claimed.lease_token, { counted: true, exhausted: 'timed_out' });
    expect(f.runs.read(f.owner, run.run_id)).toMatchObject({ state: 'running', attempts: 0, lease_token: claimed.lease_token });
  });

  it('never lets a lost lease finish a run', async () => {
    const f = await approvedRunFixture();
    const run = f.runs.list(f.owner, 1)[0]!;
    const first = f.runs.claim(f.owner, run.run_id, 600_000);
    if (first.kind !== 'claimed') throw new Error('expected first lease');
    f.advance(600_001);
    const second = f.runs.claim(f.owner, run.run_id, 600_000);
    if (second.kind !== 'claimed') throw new Error('expected replacement lease');
    expect(f.runs.finish(run.run_id, first.lease_token, { json: '{}', sha256: canonicalSha256({}) })).toBe(false);
    expect(f.runs.read(f.owner, run.run_id)).toMatchObject({ state: 'running', lease_token: second.lease_token });
  });

  it('refuses an approved-record row without its record, by its insert trigger', async () => {
    const f = await approvedRunFixture();
    expect(() => f.db.prepare(`INSERT INTO authority_trigger_runs_v1 (run_id, trigger, event_ref, organization_id, principal_id, membership_id, state, attempts, created_at, updated_at)
      VALUES ('run_badimpact', 'approved_record', 'apr_without_record', ?, ?, ?, 'pending', 0, ?, ?)`).run(f.person.organization_id, f.person.principal_id, f.person.membership_id, NOW, NOW))
      .toThrow('approved-record run needs its published approval');
  });

  it('runs the finishing callback in the same transaction and never after a lost lease', async () => {
    const f = await approvedRunFixture();
    const run = f.runs.list(f.owner, 1)[0]!;
    const lease = f.runs.claim(f.owner, run.run_id, 600_000);
    if (lease.kind !== 'claimed') throw new Error('expected lease');
    f.advance(600_001);
    const then = vi.fn();
    expect(f.runs.finish(run.run_id, lease.lease_token, card(), then)).toBe(false);
    expect(then).not.toHaveBeenCalled();
  });

  it('commits a finishing callback with the run, and undoes the finish when the callback throws', async () => {
    const f = await approvedRunFixture();
    const run = f.runs.list(f.owner, 1)[0]!;
    const lease = f.runs.claim(f.owner, run.run_id, 600_000);
    if (lease.kind !== 'claimed') throw new Error('expected lease');
    expect(() => f.runs.finish(run.run_id, lease.lease_token, card(), () => { throw new Error('items refused'); })).toThrow('items refused');
    expect(f.runs.read(f.owner, run.run_id)).toMatchObject({ state: 'running', result_json: null, lease_token: lease.lease_token });
    const seen: unknown[] = [];
    expect(f.runs.finish(run.run_id, lease.lease_token, card(), transaction => {
      seen.push([transaction === f.db, transaction.inTransaction, transaction.prepare('SELECT state FROM authority_trigger_runs_v1 WHERE run_id=?').pluck().get(run.run_id)]);
    })).toBe(true);
    expect(seen).toEqual([[true, true, 'done']]);
  });

  it('finds the impact runs of records, and any run by id', async () => {
    const f = await approvedRunFixture({ runs: 2 });
    const impact = f.runs.list(f.owner, 10);
    expect(impact.map(row => row.trigger)).toEqual(['approved_record', 'approved_record']);
    expect(f.runs.read(f.stranger, impact[0]!.run_id)).toBeUndefined();
    expect(f.runs.readUnfenced(impact[0]!.run_id)).toMatchObject({ run_id: impact[0]!.run_id, actor: f.owner, record_sha256: impact[0]!.record_sha256 });
    expect(f.runs.readUnfenced('run_missing')).toBeUndefined();
    expect(f.runs.impactRunsFor([f.recordSha256]).map(row => row.event_ref)).toEqual([f.recordApprovalId]);
    expect(f.runs.impactRunsFor(impact.map(row => row.record_sha256)).map(row => row.run_id).sort()).toEqual(impact.map(row => row.run_id).sort());
    expect(f.runs.impactRunsFor([])).toEqual([]);
  });

  it('never reads, lists, claims, retries or waits for a sweep row an Authority left before sweeps were retired (SVC-2)', async () => {
    const f = await approvedRunFixture();
    const impact = f.runs.list(f.owner, 10)[0]!;
    // The owner's sweeps as a V16 Authority left them, older than the impact check: one failed, one running with a live lease.
    const leftover = (run_id: string, state: 'failed' | 'running') => f.db.prepare(`INSERT INTO authority_trigger_runs_v1
      (run_id, trigger, event_ref, organization_id, principal_id, membership_id, scope_kind, state, attempts, lease_token, lease_expires_at, error_code, created_at, updated_at)
      VALUES (?, 'sweep', ?, ?, ?, ?, 'mine', ?, 1, ?, ?, ?, '2026-10-07T09:00:00.000Z', '2026-10-07T09:00:00.000Z')`).run(run_id, `sweep_${run_id}`,
      f.owner.organization_id, f.owner.principal_id, f.owner.membership_id, state,
      state === 'running' ? 'leftover-lease' : null, state === 'running' ? '2026-10-07T10:10:00.000Z' : null, state === 'failed' ? 'unavailable' : null);
    leftover('run_sweep-failed', 'failed');
    leftover('run_sweep-running', 'running');
    expect(f.runs.list(f.owner, 10).map(row => row.run_id)).toEqual([impact.run_id]);
    for (const run_id of ['run_sweep-failed', 'run_sweep-running']) {
      expect(f.runs.read(f.owner, run_id), run_id).toBeUndefined();
      expect(f.runs.readUnfenced(run_id), run_id).toBeUndefined();
      expect(f.runs.claim(f.owner, run_id, 600_000).kind, run_id).toBe('not_found');
    }
    expect(f.runs.retry(f.owner, 'run_sweep-failed')).toBe(false);
    expect(f.runs.nextQueued(f.owner)?.run_id).toBe(impact.run_id);
    // The sweep's live lease never holds the owner's impact check back, and the leftover rows stay as they were.
    expect(f.runs.claim(f.owner, impact.run_id, 600_000).kind).toBe('claimed');
    expect(f.db.prepare("SELECT run_id, state FROM authority_trigger_runs_v1 WHERE trigger='sweep' ORDER BY run_id").all())
      .toEqual([{ run_id: 'run_sweep-failed', state: 'failed' }, { run_id: 'run_sweep-running', state: 'running' }]);
  });
});
