import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { enqueueApprovedRecordRunV1, SqliteTriggerRunsV1 } from '../src/adapters/persistence/sqlite/trigger-runs-v1.js';
import { approvalCoreFixture } from './fixtures/approval-core.js';

const signal = () => new AbortController().signal;

async function approvedRunFixture(options: { readonly runs?: number; readonly now?: string } = {}) {
  let now = new Date(options.now ?? '2026-10-07T10:00:00.000Z');
  const f = await approvalCoreFixture();
  const runs = new SqliteTriggerRunsV1(f.db, () => now);
  const hook = enqueueApprovedRecordRunV1(runs);
  const approvals = [f.approvalId];
  for (let index = 1; index < (options.runs ?? 1); index++) approvals.push((await f.otherProposal()).approvalId);
  for (const approvalId of approvals) {
    f.core.decide('desktop', f.approve({ approval_id: approvalId, command_id: `approve-${approvalId}` }), () => f.session);
  }
  const publisher = f.publisher([hook]);
  await publisher.appendFinalizedApprovalsToV4(signal());
  return {
    ...f, runs, approvals,
    owner: f.person,
    stranger: { ...f.person, principal_id: 'prn_00000000-0000-4000-8000-0000000000f1', membership_id: 'mem_00000000-0000-4000-8000-0000000000f2' },
    advance(ms: number) { now = new Date(now.getTime() + ms); },
  };
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
});
