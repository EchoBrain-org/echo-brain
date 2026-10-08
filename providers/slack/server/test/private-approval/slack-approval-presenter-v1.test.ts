import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createSlackApprovalPresenterV1 } from '../../src/private-approval/slack-approval-presenter-v1.js';

const databases: Database.Database[] = [];
const signal = () => new AbortController().signal;
const target = { connection_id: 'con_1', external_identity_link_id: 'lnk_1', external_identity_link_contract_sha256: `sha256:${'a'.repeat(64)}`, slack_workspace_id: 'T1', slack_subject_id: 'U1', api_app_id: 'A1' };
afterEach(() => databases.splice(0).forEach(db => db.close()));

type Outcome = 'opened' | 'retry_allowed' | 'posted' | 'uncertain' | 'done' | Error;
function proposal(approval_id: string) {
  return { approval_id, reviewer: { organization_id: 'org_1', principal_id: 'prn_1', membership_id: 'mem_1' }, reviewer_active: true, title: 'Roadmap', status: 'pending' as const, decided_on: null,
    project_ids: [], snapshot_sha256: `sha256:${'b'.repeat(64)}`, snapshot_json: JSON.stringify({ approved_payload: { brief: { meeting: { title: 'Roadmap' }, decisions: [], actions: [{ text: 'Send draft', evidence: [{ block_id: 'blk_1' }] }], rationales: [] } } }) };
}
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE authority_live_approval_outbox_v2(approval_id TEXT PRIMARY KEY,state TEXT,updated_at TEXT);
    CREATE TABLE authority_approval_decisions_v1(approval_id TEXT PRIMARY KEY,action TEXT);
    CREATE TABLE authority_approval_presentations_v1(approval_id TEXT,surface TEXT,target_json TEXT,dm_channel_id TEXT,delivery TEXT,message_ts TEXT,card_sha256 TEXT,shows TEXT,attempts INTEGER,retry_at TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(approval_id,surface));`);
  const calls: string[] = [], outcomes: Record<string, Outcome[]> = { open: ['opened'], post: ['posted'], reconcile: ['posted'], publish: ['done'] };
  const views = new Map<string, ReturnType<typeof proposal>>();
  let projects: { project_id: string; name: string }[] = [];
  let owners: { signal_id: string; action: string; proposed: string }[] = [];
  let linked = true, current = true, clock = new Date('2026-10-07T00:00:00.000Z');
  const next = (name: string): Outcome => outcomes[name]?.shift() ?? (name === 'open' ? 'opened' : name === 'publish' ? 'done' : 'posted');
  const take = (name: string) => { calls.push(name); const result = next(name); if (result instanceof Error) throw result; return result; };
  const presenter = createSlackApprovalPresenterV1({ database: db,
    core: { proposal: id => views.get(id), ownerProposals: () => owners },
    target: () => linked ? target : null, targetCurrent: () => current, projects: () => projects, now: () => clock,
    poster: {
      async openDirectMessage() { const x = take('open'); return x === 'opened' ? { kind: 'opened' as const, channel_id: 'D1' } : { kind: 'retry_allowed' as const }; },
      async postMarker() { const x = take('post'); return x === 'posted' ? { kind: 'posted' as const, provider_message_ts: '1.000001' } : { kind: x as 'retry_allowed' | 'uncertain' }; },
      async reconcileMarker() { const x = take('reconcile'); return x === 'posted' ? { kind: 'posted' as const, provider_message_ts: '1.000001' } : { kind: x as 'retry_allowed' | 'uncertain' }; },
      async publish() { const x = take('publish'); return x === 'done' ? { kind: 'done' as const } : { kind: 'uncertain' as const }; },
    } });
  const stage = (id = 'apr_live', patch: Partial<ReturnType<typeof proposal>> = {}) => {
    views.set(id, { ...proposal(id), ...patch });
    db.prepare('INSERT INTO authority_live_approval_outbox_v2 VALUES (?,?,?)').run(id, 'staged', clock.toISOString());
    return id;
  };
  return { db, calls, outcomes, presenter, stage, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, set projects(value: { project_id: string; name: string }[]) { projects = value; }, set owners(value: { signal_id: string; action: string; proposed: string }[]) { owners = value; }, set linked(value: boolean) { linked = value; }, set current(value: boolean) { current = value; } };
}
function row(f: ReturnType<typeof fixture>, id = 'apr_live') { return f.db.prepare('SELECT * FROM authority_approval_presentations_v1 WHERE approval_id=?').get(id) as { delivery: string; attempts: number; retry_at: string | null; dm_channel_id: string | null; shows: string; message_ts: string | null }; }

describe('Slack approval presenter V1', () => {
  it('starts from an eligible staged proposal and posts exactly one first marker', async () => {
    const f = fixture(); f.stage();
    await f.presenter.reconcile(signal());
    await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'post', 'publish']);
    expect(row(f)).toMatchObject({ delivery: 'posted', dm_channel_id: 'D1', shows: 'open', message_ts: '1.000001' });
  });

  it('never opens for an unlinked proposal, then delivers after a late link', async () => {
    const f = fixture(); f.linked = false; f.stage();
    await f.presenter.reconcile(signal()); expect(f.calls).toEqual([]);
    f.linked = true; await f.presenter.reconcile(signal()); await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'post', 'publish']);
  });

  it('after the channel has persisted, reconciles an uncertain marker without blind reposting', async () => {
    const f = fixture(); f.stage();
    await f.presenter.reconcile(signal());
    expect(row(f)).toMatchObject({ delivery: 'posting', dm_channel_id: 'D1' });
    f.outcomes.reconcile = ['uncertain']; await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'reconcile']);
    f.advance(2_001); await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'reconcile', 'reconcile', 'publish']);
  });

  it('may retry an explicitly retry_allowed first marker without treating it as uncertain', async () => {
    const f = fixture(); f.stage(); f.outcomes.post = ['retry_allowed', 'posted'];
    await f.presenter.reconcile(signal()); await f.presenter.reconcile(signal());
    f.advance(2_001); await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'post', 'reconcile', 'publish']);
  });

  it.each(['open', 'post', 'reconcile', 'publish'] as const)('persists bounded retry state when %s throws', async (operation) => {
    const f = fixture(); f.stage();
    if (operation === 'open') f.outcomes.open = [new Error('network')];
    if (operation === 'post') f.outcomes.post = [new Error('network')];
    if (operation === 'reconcile') { await f.presenter.reconcile(signal()); f.outcomes.reconcile = [new Error('network')]; }
    if (operation === 'publish') { await f.presenter.reconcile(signal()); f.outcomes.post = ['posted']; f.outcomes.publish = [new Error('network')]; }
    await expect(f.presenter.reconcile(signal())).resolves.toBe('rendered');
    if (operation === 'post') expect(f.calls).toContain('post');
    expect(row(f)).toMatchObject({ attempts: 1 }); expect(row(f).retry_at).not.toBeNull();
  });

  it('rejects a stale exact connection target before it can call the poster', async () => {
    const f = fixture(); f.stage(); f.current = false;
    await f.presenter.reconcile(signal());
    expect(f.calls).toEqual([]); expect(row(f)).toMatchObject({ attempts: 5, delivery: 'failed' });
  });

  it('marks an oversized staged proposal unrepresentable without opening a DM', async () => {
    const f = fixture(); f.projects = Array.from({ length: 101 }, (_, n) => ({ project_id: `prj_${n}`, name: `Project ${n}` })); f.stage('apr_large');
    await f.presenter.reconcile(signal());
    expect(f.calls).toEqual([]); expect(row(f, 'apr_large')).toMatchObject({ delivery: 'unrepresentable' });
  });

  it('redraws a decided presentation and does not let 25 completed rows starve it', async () => {
    const f = fixture();
    for (let n = 0; n < 25; n++) f.db.prepare('INSERT INTO authority_approval_presentations_v1 VALUES (?,\'slack\',?,\'D1\',\'posted\',\'1.1\',\'hash\',\'approved\',0,NULL,?,?)').run(`done_${n}`, JSON.stringify(target), '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z');
    const id = f.stage('apr_decided', { status: 'publishing', decided_on: 'desktop' });
    f.db.prepare('INSERT INTO authority_approval_presentations_v1 VALUES (?,\'slack\',?,\'D1\',\'posted\',\'1.1\',\'hash\',\'open\',0,NULL,?,?)').run(id, JSON.stringify(target), '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z');
    f.db.prepare('INSERT INTO authority_approval_decisions_v1 VALUES (?,?)').run(id, 'approve');
    await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['publish']); expect(row(f, id)).toMatchObject({ shows: 'approved' });
  });
});
