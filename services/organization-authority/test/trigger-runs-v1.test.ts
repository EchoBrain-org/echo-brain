import { randomUUID } from 'node:crypto';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
import { enqueueApprovedRecordRunV1, SqliteTriggerRunsV1 } from '../src/adapters/persistence/sqlite/trigger-runs-v1.js';
import { approvalCoreFixture } from './fixtures/approval-core.js';
import { approvedRunFixture } from './fixtures/trigger-runs.js';

const signal = () => new AbortController().signal;
const NOW = '2026-10-07T10:00:00.000Z';
/** A stored result; the store never reads inside it. */
const card = () => ({ json: '{"schema_version":1}', sha256: canonicalSha256({ schema_version: 1 }) });
/** Runs each of the person's pending impact checks to done: impact checks start before sweeps. */
function finishImpactRuns(f: Awaited<ReturnType<typeof approvedRunFixture>>): void {
  for (const run of f.runs.list(f.owner, 100).filter(row => row.trigger === 'approved_record' && row.state === 'pending')) {
    const lease = f.runs.claim(f.owner, run.run_id, 600_000);
    if (lease.kind !== 'claimed' || !f.runs.finish(run.run_id, lease.lease_token, card())) throw new Error('expected the impact check to finish');
  }
}

describe('SQLite trigger runs v1', () => {
  it('enqueues exactly one pending run per approved record through the publisher hook', async () => {
    const f = await approvedRunFixture();
    await f.core.processing.recoverV4Appends(signal());
    expect(f.db.prepare('SELECT trigger, event_ref, state FROM authority_trigger_runs_v1').all()).toEqual([
      { trigger: 'approved_record', event_ref: f.approvalId, state: 'pending' },
    ]);
  });

  it('recovers a crash after record append with exactly one enqueued run, while rejection enqueues none', async () => {
    const f = await approvalCoreFixture();
    const runs = new SqliteTriggerRunsV1(f.db);
    const hook = enqueueApprovedRecordRunV1(runs);
    f.core.decide('desktop', f.approve(), () => f.session);
    const crash = f.publisher([hook], undefined, { append: async input => {
      await f.context.record_append.append(input);
      throw new Error('crash after append');
    } });
    await expect(crash.appendFinalizedApprovalsToV4(signal())).rejects.toThrow('crash after append');
    expect(f.db.prepare('SELECT count(*) FROM authority_trigger_runs_v1').pluck().get()).toBe(0);
    await f.publisher([hook]).recoverV4Appends(signal());
    await f.publisher([hook]).recoverV4Appends(signal());
    expect(f.db.prepare('SELECT trigger, event_ref, state FROM authority_trigger_runs_v1').all()).toEqual([
      { trigger: 'approved_record', event_ref: f.approvalId, state: 'pending' },
    ]);

    const rejected = await approvalCoreFixture();
    rejected.core.decide('desktop', rejected.reject(), () => rejected.session);
    await rejected.publisher([enqueueApprovedRecordRunV1(new SqliteTriggerRunsV1(rejected.db))]).recoverV4Appends(signal());
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

  it('queues one live sweep per person and scope, and a new one once it is done', async () => {
    const f = await approvedRunFixture();
    finishImpactRuns(f);
    const first = f.runs.enqueueSweep(f.owner, { kind: 'mine' });
    expect(first.created).toBe(true);
    expect(f.runs.enqueueSweep(f.owner, { kind: 'mine' })).toEqual({ run_id: first.run_id, created: false });
    expect(f.runs.enqueueSweep(f.owner, { kind: 'record', record_sha256: f.recordSha256 }).created).toBe(true);
    expect(f.runs.read(f.owner, first.run_id)).toMatchObject({ trigger: 'sweep', record_sha256: null, scope: { kind: 'mine' }, state: 'pending' });
    const claimed = f.runs.claim(f.owner, first.run_id, 600_000);
    if (claimed.kind !== 'claimed') throw new Error('expected lease');
    expect(f.runs.finish(first.run_id, claimed.lease_token, { json: '{"schema_version":1}', sha256: canonicalSha256({ schema_version: 1 }) })).toBe(true);
    expect(f.runs.enqueueSweep(f.owner, { kind: 'mine' }).created).toBe(true);
  });

  it('refuses a sweep row with a record and an approved-record row without one', async () => {
    const f = await approvedRunFixture();
    expect(() => f.db.prepare(`INSERT INTO authority_trigger_runs_v1 (run_id, trigger, event_ref, organization_id, principal_id, membership_id, record_sha256, scope_kind, state, attempts, created_at, updated_at)
      VALUES ('run_badsweep', 'sweep', 'sweep_x', ?, ?, ?, ?, 'mine', 'pending', 0, ?, ?)`).run(f.person.organization_id, f.person.principal_id, f.person.membership_id, f.recordSha256, NOW, NOW))
      .toThrow("CHECK constraint failed: (trigger = 'approved_record') = (record_sha256 IS NOT NULL)");
    // The approved-record insert trigger refuses a record-less row before the CHECK is reached.
    expect(() => f.db.prepare(`INSERT INTO authority_trigger_runs_v1 (run_id, trigger, event_ref, organization_id, principal_id, membership_id, state, attempts, created_at, updated_at)
      VALUES ('run_badimpact', 'approved_record', 'apr_without_record', ?, ?, ?, 'pending', 0, ?, ?)`).run(f.person.organization_id, f.person.principal_id, f.person.membership_id, NOW, NOW))
      .toThrow('approved-record run needs its published approval');
    const sweep = (scopeKind: string | null, scopeId: string | null) => () => f.db.prepare(`INSERT INTO authority_trigger_runs_v1
      (run_id, trigger, event_ref, organization_id, principal_id, membership_id, scope_kind, scope_id, state, attempts, created_at, updated_at)
      VALUES (?, 'sweep', ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(`run_${randomUUID()}`, `sweep_${randomUUID()}`, f.person.organization_id, f.person.principal_id, f.person.membership_id, scopeKind, scopeId, NOW, NOW);
    const scopeCheck = "CHECK constraint failed: (scope_kind IS NOT NULL AND scope_kind IN ('record', 'project')) = (scope_id IS NOT NULL)";
    expect(sweep(null, null)).toThrow("CHECK constraint failed: (trigger = 'sweep') = (scope_kind IS NOT NULL)");
    expect(sweep('mine', f.projectA)).toThrow(scopeCheck);
    expect(sweep('project', null)).toThrow(scopeCheck);
    expect(sweep('record', null)).toThrow(scopeCheck);
    sweep('project', f.projectA)();
    expect(sweep('project', f.projectA)).toThrow("UNIQUE constraint failed: index 'authority_trigger_runs_one_live_sweep_v1'");
  });

  it('refuses a published approval\'s run that carries a sweep scope, by the CHECK alone', async () => {
    const f = await approvalCoreFixture();
    f.core.decide('desktop', f.approve(), () => f.session);
    await f.publisher([]).appendFinalizedApprovalsToV4(signal());
    const record = (JSON.parse(f.receipt()!) as { readonly record_sha256: Sha256Digest }).record_sha256;
    const impact = (scopeKind: string | null) => () => f.db.prepare(`INSERT INTO authority_trigger_runs_v1
      (run_id, trigger, event_ref, organization_id, principal_id, membership_id, record_sha256, scope_kind, state, attempts, created_at, updated_at)
      VALUES (?, 'approved_record', ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(`run_${randomUUID()}`, f.approvalId, f.person.organization_id, f.person.principal_id, f.person.membership_id, record, scopeKind, NOW, NOW);
    expect(impact('mine')).toThrow("CHECK constraint failed: (trigger = 'sweep') = (scope_kind IS NOT NULL)");
    impact(null)();
    expect(f.db.prepare('SELECT trigger, scope_kind FROM authority_trigger_runs_v1').all()).toEqual([{ trigger: 'approved_record', scope_kind: null }]);
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

  it('retries a failed impact run only; a failed sweep stays failed and the next sweep replaces it', async () => {
    const f = await approvedRunFixture();
    finishImpactRuns(f);
    const scope = { kind: 'project', project_id: f.projectA } as const;
    const sweep = f.runs.enqueueSweep(f.owner, scope);
    const lease = f.runs.claim(f.owner, sweep.run_id, 600_000);
    if (lease.kind !== 'claimed') throw new Error('expected lease');
    expect(f.runs.fail(sweep.run_id, lease.lease_token, 'research_failed')).toBe(true);
    expect(f.runs.retry(f.owner, sweep.run_id)).toBe(false);
    expect(f.runs.read(f.owner, sweep.run_id)).toMatchObject({ state: 'failed', error_code: 'research_failed', scope });
    expect(f.runs.enqueueSweep(f.owner, scope)).toMatchObject({ created: true });
  });

  it('finds the newest and the running sweep of any scope, the impact runs of records, and any run by id', async () => {
    const f = await approvedRunFixture({ runs: 2 });
    const impact = f.runs.list(f.owner, 10);
    expect(f.runs.newestSweep(f.owner)).toBeUndefined();
    f.advance(1_000);
    const sweep = f.runs.enqueueSweep(f.owner, { kind: 'record', record_sha256: f.recordSha256 });
    expect(f.runs.newestSweep(f.owner)).toMatchObject({ run_id: sweep.run_id, trigger: 'sweep', record_sha256: null, scope: { kind: 'record', record_sha256: f.recordSha256 } });
    expect(f.runs.newestSweep(f.stranger)).toBeUndefined();
    expect(f.runs.list(f.owner, 10).map(row => row.trigger)).toEqual(['sweep', 'approved_record', 'approved_record']);
    expect(f.runs.read(f.stranger, sweep.run_id)).toBeUndefined();
    expect(f.runs.readUnfenced(sweep.run_id)).toMatchObject({ run_id: sweep.run_id, actor: f.owner, scope: { kind: 'record' } });
    expect(f.runs.readUnfenced('run_missing')).toBeUndefined();
    expect(f.runs.impactRunsFor([f.recordSha256]).map(row => row.event_ref)).toEqual([f.approvalId]);
    expect(f.runs.impactRunsFor(impact.map(row => row.record_sha256!)).map(row => row.run_id).sort()).toEqual(impact.map(row => row.run_id).sort());
    expect(f.runs.impactRunsFor([])).toEqual([]);
    finishImpactRuns(f);
    const lease = f.runs.claim(f.owner, sweep.run_id, 600_000);
    if (lease.kind !== 'claimed') throw new Error('expected lease');
    expect(f.runs.runningSweep(f.owner)).toMatchObject({ run_id: sweep.run_id, state: 'running' });
    expect(f.runs.finish(sweep.run_id, lease.lease_token, card())).toBe(true);
    expect(f.runs.runningSweep(f.owner)).toBeUndefined();
  });

  it('starts a sweep only once none of the person\'s impact checks is pending or running', async () => {
    const f = await approvedRunFixture();
    const impact = f.runs.list(f.owner, 1)[0]!;
    const sweep = f.runs.enqueueSweep(f.owner, { kind: 'mine' });
    expect(f.runs.claim(f.owner, sweep.run_id, 600_000).kind).toBe('busy');          // the impact check is pending
    const first = f.runs.claim(f.owner, impact.run_id, 600_000);                     // a pending sweep never holds up an impact check
    if (first.kind !== 'claimed') throw new Error('expected lease');
    expect(f.runs.claim(f.owner, sweep.run_id, 600_000).kind).toBe('busy');          // running
    f.advance(600_001);
    expect(f.runs.claim(f.owner, sweep.run_id, 600_000).kind).toBe('busy');          // still running, its lease lapsed
    const second = f.runs.claim(f.owner, impact.run_id, 600_000);
    if (second.kind !== 'claimed') throw new Error('expected lease');
    expect(f.runs.fail(impact.run_id, second.lease_token, 'research_failed')).toBe(true);
    // A failed impact check waits for Try again; it does not hold sweeps back.
    expect(f.runs.claim(f.owner, sweep.run_id, 600_000).kind).toBe('claimed');
    // Someone else's impact check is theirs alone.
    const other = await approvedRunFixture();
    const strangers = other.runs.enqueueSweep(other.stranger, { kind: 'mine' });
    expect(other.runs.claim(other.stranger, strangers.run_id, 600_000).kind).toBe('claimed');
  });

  it('reads a person\'s running sweep only while its lease holds', async () => {
    const f = await approvedRunFixture();
    finishImpactRuns(f);
    const sweep = f.runs.enqueueSweep(f.owner, { kind: 'mine' });
    expect(f.runs.runningSweep(f.owner)).toBeUndefined();                           // pending
    expect(f.runs.claim(f.owner, sweep.run_id, 600_000).kind).toBe('claimed');
    expect(f.runs.runningSweep(f.owner)).toMatchObject({ run_id: sweep.run_id, state: 'running' });
    expect(f.runs.runningSweep(f.stranger)).toBeUndefined();
    f.advance(600_001);
    expect(f.runs.runningSweep(f.owner)).toBeUndefined();                           // its attempt stopped without finishing
  });

  it('reads a person\'s newest sweep, whatever its scope or state', async () => {
    const f = await approvedRunFixture();
    finishImpactRuns(f);
    expect(f.runs.newestSweep(f.owner)).toBeUndefined();
    const first = f.runs.enqueueSweep(f.owner, { kind: 'mine' });
    f.advance(1_000);
    const second = f.runs.enqueueSweep(f.owner, { kind: 'project', project_id: f.projectA });
    expect(f.runs.newestSweep(f.owner)).toMatchObject({ run_id: second.run_id, trigger: 'sweep', state: 'pending', created_at: f.clock().toISOString() });
    const lease = f.runs.claim(f.owner, second.run_id, 600_000);
    if (lease.kind !== 'claimed') throw new Error('expected lease');
    expect(f.runs.fail(second.run_id, lease.lease_token, 'unavailable')).toBe(true);
    expect(f.runs.newestSweep(f.owner)).toMatchObject({ run_id: second.run_id, state: 'failed' });
    expect(f.runs.newestSweep(f.stranger)).toBeUndefined();
    expect(f.runs.read(f.owner, first.run_id)).toMatchObject({ state: 'pending' });
  });
});
