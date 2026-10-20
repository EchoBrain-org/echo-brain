import Database from 'better-sqlite3';
import { coreRuntimeIdentityV1, observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackApprovalPresenterV1, createTargetBoundSlackApprovalPosterV1, type ApprovalProposalViewV1 } from '../../src/private-approval/slack-approval-presenter-v1.js';

const databases: Database.Database[] = [];
const signal = () => new AbortController().signal;
const target = { connection_id: 'con_1', external_identity_link_id: 'lnk_1', external_identity_link_contract_sha256: `sha256:${'a'.repeat(64)}`, slack_workspace_id: 'T1', slack_subject_id: 'U1', api_app_id: 'A1' };
afterEach(() => databases.splice(0).forEach(db => db.close()));

type Outcome = 'opened' | 'retry_allowed' | 'posted' | 'uncertain' | 'done' | Error;
function proposal(approval_id: string): ApprovalProposalViewV1 {
  return { approval_id, reviewer: { organization_id: 'org_1', principal_id: 'prn_1', membership_id: 'mem_1' }, reviewer_active: true, title: 'Roadmap', status: 'pending' as const, decided_on: null,
    project_ids: [], snapshot_sha256: `sha256:${'b'.repeat(64)}`, snapshot_json: JSON.stringify({ approved_payload: { brief: { meeting: { title: 'Roadmap' }, decisions: [], actions: [{ text: 'Send draft', evidence: [{ block_id: 'blk_1' }] }], rationales: [] } } }) };
}
function fixture(overrides: Partial<Parameters<typeof createSlackApprovalPresenterV1>[0]> = {}) {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE authority_live_approval_outbox_v2(approval_id TEXT PRIMARY KEY,state TEXT,updated_at TEXT);
    CREATE TABLE authority_approval_decisions_v1(approval_id TEXT PRIMARY KEY,action TEXT);
    CREATE TABLE authority_approval_presentations_v1(approval_id TEXT,surface TEXT,target_json TEXT,dm_channel_id TEXT,delivery TEXT,marker_state TEXT,marker_started_at TEXT,message_ts TEXT,card_sha256 TEXT,shows TEXT,attempts INTEGER,retry_at TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(approval_id,surface));`);
  const calls: string[] = [], outcomes: Record<string, Outcome[]> = { open: ['opened'], post: ['posted'], reconcile: ['posted'], publish: ['done'] };
  const views = new Map<string, ReturnType<typeof proposal>>();
  let projects: { project_id: string; name: string }[] = [];
  let linked = true, current = true, clock = new Date('2026-10-07T00:00:00.000Z');
  let afterOpen: (() => void) | undefined;
  const unlinkedPrincipals = new Set<string>();
  const reconcileInputs: { post_started_at: string }[] = [];
  const next = (name: string): Outcome => outcomes[name]?.shift() ?? (name === 'open' ? 'opened' : name === 'publish' ? 'done' : 'posted');
  const take = (name: string) => { calls.push(name); const result = next(name); if (result instanceof Error) throw result; return result; };
  const presenter = createSlackApprovalPresenterV1({ database: db,
    core: { proposal: id => views.get(id), ownerProposals: () => [] },
    target: reviewer => linked && !unlinkedPrincipals.has(reviewer.principal_id) ? target : null, targetCurrent: () => current, projects: () => projects, now: () => clock,
    poster: () => ({
      async openDirectMessage() { const x = take('open'); afterOpen?.(); return x === 'opened' ? { kind: 'opened' as const, channel_id: 'D1', user_id: 'U1' } : { kind: 'retry_allowed' as const }; },
      async postMarker() { const x = take('post'); return x === 'posted' ? { kind: 'posted' as const, provider_message_ts: '1.000001' } : { kind: x as 'retry_allowed' | 'uncertain' }; },
      async reconcileMarker(input) { reconcileInputs.push(input); const x = take('reconcile'); return x === 'posted' ? { kind: 'posted' as const, provider_message_ts: '1.000001' } : { kind: x as 'retry_allowed' | 'uncertain' }; },
      async publish() { const x = take('publish'); return x === 'done' ? { kind: 'done' as const } : { kind: 'uncertain' as const }; },
    }), ...overrides });
  const stage = (id = 'apr_live', patch: Partial<ReturnType<typeof proposal>> = {}) => {
    views.set(id, { ...proposal(id), ...patch });
    db.prepare('INSERT INTO authority_live_approval_outbox_v2 VALUES (?,?,?)').run(id, 'staged', clock.toISOString());
    return id;
  };
  return { db, calls, outcomes, reconcileInputs, presenter, stage, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, unlink: (principalId: string) => { unlinkedPrincipals.add(principalId); }, set proposal(value: ApprovalProposalViewV1) { views.set(value.approval_id, value); }, set afterOpen(value: (() => void) | undefined) { afterOpen = value; }, set projects(value: { project_id: string; name: string }[]) { projects = value; }, set linked(value: boolean) { linked = value; }, set current(value: boolean) { current = value; } };
}
function markInFlight(f: ReturnType<typeof fixture>) { f.db.prepare("UPDATE authority_approval_presentations_v1 SET marker_state='in_flight',marker_started_at='2026-10-07T00:00:00.000Z' WHERE approval_id='apr_live'").run(); }
function row(f: ReturnType<typeof fixture>, id = 'apr_live') { return f.db.prepare('SELECT * FROM authority_approval_presentations_v1 WHERE approval_id=?').get(id) as { delivery: string; attempts: number; retry_at: string | null; dm_channel_id: string | null; shows: string; message_ts: string | null }; }
/**
 * The presenter over real target-bound posters, a new one for every step as the composition root builds them, and a
 * fake Slack that answers U0A's first `times` opens with 429 and this Retry-After, then everything as asked. apr_a is
 * U0A's approval and apr_b U0B's. Date must be faked.
 */
function rateLimitedSlack(retryAfter: string, times = 1) {
  const requests: string[] = [];
  let limited = times;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const method = new URL(String(url)).pathname.split('/').at(-1)!;
    const body = JSON.parse(String(init?.body)) as { users?: string; channel?: string; ts?: string };
    requests.push(`${method}:${body.users ?? body.channel}`);
    if (method !== 'conversations.open') return new Response(JSON.stringify({ ok: true, channel: body.channel, ts: body.ts ?? '1.000001' }));
    if (body.users === 'U0A' && limited > 0) { limited -= 1; return new Response('', { status: 429, headers: { 'retry-after': retryAfter } }); }
    return new Response(JSON.stringify({ ok: true, channel: { id: `D${body.users!.slice(1)}`, is_im: true, user: body.users } }), { headers: { 'x-oauth-scopes': 'im:write' } });
  };
  const f = fixture({
    now: () => new Date(),
    target: reviewer => ({ ...target, slack_subject_id: reviewer.principal_id === 'prn_2' ? 'U0B' : 'U0A' }),
    poster: bound => createTargetBoundSlackApprovalPosterV1({ target: bound,
      activeConnection: () => ({ connection: { connection_id: 'con_1', provider_tenant_id: 'T1', provider_app_id: 'A1' }, state_sha256: `sha256:${'c'.repeat(64)}` }) as never,
      targetCurrent: () => true, botToken: { async botToken() { return 'xoxb-test'; } } as never,
      needsReinstall: () => false, markNeedsReinstall: () => undefined, fetchImpl }),
  });
  f.stage('apr_a'); f.stage('apr_b', { reviewer: { organization_id: 'org_1', principal_id: 'prn_2', membership_id: 'mem_2' } });
  return { f, opens: () => requests.filter(request => request === 'conversations.open:U0A').length };
}

describe('Slack approval presenter V1', () => {
  it('distinguishes a posted marker from a delivered card, links retries, and emits nothing on idle polls', async () => {
    const f = fixture(), id = f.stage(), events: CoreRuntimeObservationV1[] = [];
    const check = () => observeCoreRuntimeV1('worker_execution', () => f.presenter.reconcile(signal()), { observer: event => { events.push(event); } });
    f.outcomes.publish = ['uncertain', 'done'];
    await check(); await check();
    const finished = () => events.filter(event => event.phase === 'approval_delivery' && event.event !== 'started');
    expect(finished()).toMatchObject([
      { delivery_step: 'open_dm', result: 'completed' }, { delivery_step: 'post_marker', result: 'completed' },
      { delivery_step: 'publish_card', result: 'uncertain' }, { result: 'retry_pending' },
    ]);
    const before = finished().length; await check(); expect(finished()).toHaveLength(before);
    f.advance(2_001); await check();
    expect(finished().at(-1)).toMatchObject({ delivery_step: 'publish_card', result: 'done', approval_id: coreRuntimeIdentityV1('approval', id), approval_surface: 'slack', attempt: 2 });
    expect(finished().every(event => event.approval_id === coreRuntimeIdentityV1('approval', id))).toBe(true);
    const after = finished().length; await check(); expect(finished()).toHaveLength(after);
    const serialized = JSON.stringify(events);
    for (const privateText of [id, 'Roadmap', 'Send draft', 'D1', 'con_1', '1.000001']) expect(serialized).not.toContain(privateText);
  });

  it('refuses a token selected across an active-connection switch before Slack receives a request', async () => {
    const connection = (connection_id: string) => ({ connection: { connection_id, provider_tenant_id: 'T1', provider_app_id: 'A1' }, state_sha256: `sha256:${connection_id.padEnd(64, 'x')}` });
    let active = connection('con_1');
    const providerCalls = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
    const poster = createTargetBoundSlackApprovalPosterV1({ target,
      activeConnection: () => active as never,
      targetCurrent: candidate => active.connection.connection_id === candidate.connection_id,
      botToken: { async botToken(selected: { connection: { connection_id: string } }) { expect(selected.connection.connection_id).toBe('con_1'); active = connection('con_2'); return 'token'; } } as never,
      needsReinstall: () => false, markNeedsReinstall: () => undefined,
    });
    try {
      await expect(poster.openDirectMessage('U1')).resolves.toEqual({ kind: 'retry_allowed' });
      expect(providerCalls).not.toHaveBeenCalled();
    } finally { providerCalls.mockRestore(); }
  });

  it('waits out Slack Retry-After before that target\'s next step while another target delivers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.parse('2026-10-07T00:00:00.000Z');
      vi.setSystemTime(start);
      const { f, opens } = rateLimitedSlack('30');
      await f.presenter.reconcile(signal()); await f.presenter.reconcile(signal());
      expect(row(f, 'apr_a')).toMatchObject({ delivery: 'opening', attempts: 1, retry_at: new Date(start + 30_000).toISOString() });
      // The other target is unaffected: its card is delivered at once.
      expect(row(f, 'apr_b')).toMatchObject({ delivery: 'posted', shows: 'open', attempts: 0, dm_channel_id: 'D0B' });
      // The presenter's own backoff alone would have retried after 2 s.
      for (const at of [2_001, 16_001, 29_999]) { vi.setSystemTime(start + at); await f.presenter.reconcile(signal()); }
      expect(opens()).toBe(1);
      vi.setSystemTime(start + 30_000);
      await f.presenter.reconcile(signal()); await f.presenter.reconcile(signal());
      expect(opens()).toBe(2);
      expect(row(f, 'apr_a')).toMatchObject({ delivery: 'posted', shows: 'open', attempts: 1, dm_channel_id: 'D0A' });
    } finally { vi.useRealTimers(); }
  });

  it.each(['86400', '1e15'])('waits at most 15 minutes for a Retry-After of %s seconds, so a card Slack keeps limiting still fails after five tries', async (retryAfter) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.parse('2026-10-07T00:00:00.000Z');
      const { f, opens } = rateLimitedSlack(retryAfter, Infinity);
      for (let attempt = 1; attempt <= 5; attempt++) {
        vi.setSystemTime(start + (attempt - 1) * 15 * 60_000);
        await f.presenter.reconcile(signal());
        expect(opens()).toBe(attempt);
        expect(row(f, 'apr_a')).toMatchObject(attempt < 5
          ? { delivery: 'opening', attempts: attempt, retry_at: new Date(start + attempt * 15 * 60_000).toISOString() }
          : { delivery: 'failed', attempts: 5, retry_at: null });
      }
    } finally { vi.useRealTimers(); }
  });

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

  it.each(['while opening the DM', 'during channel reservation'] as const)('does not post a first marker when desktop decides %s', async (when) => {
    const f = fixture(); const id = f.stage();
    const decide = () => { f.proposal = { ...proposal(id), status: 'publishing', decided_on: 'desktop' }; };
    if (when === 'while opening the DM') f.afterOpen = decide;
    await f.presenter.reconcile(signal());
    if (when === 'during channel reservation') decide();
    await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open']);
    expect(row(f)).toMatchObject({ delivery: 'unrepresentable', dm_channel_id: 'D1', message_ts: null });
  });

  it('after the channel has persisted, reconciles an uncertain marker without blind reposting', async () => {
    const f = fixture(); f.stage();
    await f.presenter.reconcile(signal());
    expect(row(f)).toMatchObject({ delivery: 'posting', dm_channel_id: 'D1' });
    markInFlight(f);
    f.outcomes.reconcile = ['uncertain']; await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'reconcile']);
    f.advance(2_001); await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'reconcile', 'reconcile', 'publish']);
  });

  it('may retry an explicitly retry_allowed first marker without treating it as uncertain', async () => {
    const f = fixture(); f.stage(); f.outcomes.post = ['retry_allowed', 'posted'];
    await f.presenter.reconcile(signal()); await f.presenter.reconcile(signal());
    f.advance(2_001); await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'post', 'post', 'publish']);
  });

  it('uses the durable marker start time after a delayed marker crash', async () => {
    const f = fixture(); f.stage();
    await f.presenter.reconcile(signal());
    f.advance(20 * 60_000); f.outcomes.post = ['uncertain'];
    await f.presenter.reconcile(signal());
    f.advance(2_001); f.outcomes.reconcile = ['posted'];
    await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'post', 'reconcile', 'publish']);
    expect(f.reconcileInputs).toMatchObject([{ post_started_at: '2026-10-07T00:20:00.000Z', reconciliation_started_at: '2026-10-07T00:20:02.001Z' }]);
  });

  it('does not re-authorize posting after an uncertain recovery', async () => {
    const f = fixture(); f.stage();
    await f.presenter.reconcile(signal());
    markInFlight(f);
    f.outcomes.reconcile = ['uncertain', 'uncertain'];
    await f.presenter.reconcile(signal());
    f.advance(2_001); await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'reconcile', 'reconcile']);
    expect(row(f)).toMatchObject({ delivery: 'posting' });
  });

  it('scans past unlinked proposals to claim a later linked reviewer', async () => {
    const f = fixture();
    for (let index = 0; index < 25; index++) {
      const principal_id = `unlinked_${index}`;
      f.unlink(principal_id); f.stage(`apr_unlinked_${index}`, { reviewer: { organization_id: 'org_1', principal_id, membership_id: `mem_${index}` } });
    }
    f.stage('apr_linked');
    await f.presenter.reconcile(signal()); await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['open', 'post', 'publish']);
  });

  it('selects ready work behind 25 retry-deferred rows', async () => {
    const f = fixture();
    for (let index = 0; index < 25; index++) {
      const approvalId = `apr_wait_${index}`;
      f.db.prepare('INSERT INTO authority_live_approval_outbox_v2 VALUES (?,?,?)').run(approvalId, 'staged', '2026-10-06T00:00:00.000Z');
      f.db.prepare("INSERT INTO authority_approval_presentations_v1 VALUES (?,'slack',?,'D1','posting','not_started',NULL,NULL,NULL,'open',1,'2026-10-07T01:00:00.000Z','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z')").run(approvalId, JSON.stringify(target));
    }
    const ready = f.stage();
    f.db.prepare("INSERT INTO authority_approval_presentations_v1 VALUES (?,'slack',?,'D1','posted',NULL,NULL,'1.000001',NULL,'open',0,NULL,'2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z')").run(ready, JSON.stringify(target));
    await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['publish']);
  });

  it.each(['open', 'post', 'reconcile', 'publish'] as const)('persists bounded retry state when %s throws', async (operation) => {
    const f = fixture(); f.stage();
    if (operation === 'open') f.outcomes.open = [new Error('network')];
    if (operation === 'post') { await f.presenter.reconcile(signal()); f.outcomes.post = [new Error('network')]; }
    if (operation === 'reconcile') { await f.presenter.reconcile(signal()); markInFlight(f); f.outcomes.reconcile = [new Error('network')]; }
    if (operation === 'publish') { await f.presenter.reconcile(signal()); f.outcomes.post = ['posted']; f.outcomes.publish = [new Error('network')]; }
    await expect(f.presenter.reconcile(signal())).resolves.toBe(operation === 'open' ? 'rendered' : 'uncertain');
    if (operation === 'post') expect(f.calls).toContain('post');
    expect(row(f)).toMatchObject({ attempts: 1 }); expect(row(f).retry_at).not.toBeNull();
  });

  it('caps repeated terminal redraw failures while retaining the known message timestamp', async () => {
    const f = fixture(); f.stage(); f.outcomes.publish = Array.from({ length: 5 }, () => new Error('network'));
    await f.presenter.reconcile(signal());
    for (let attempt = 0; attempt < 5; attempt++) {
      await f.presenter.reconcile(signal());
      if (attempt < 4) f.advance(60_001);
    }
    expect(row(f)).toMatchObject({ delivery: 'failed', attempts: 5, message_ts: '1.000001', retry_at: null });
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

  it('keeps any card-build failure on its own row while other rows still deliver', async () => {
    const f = fixture(); f.stage('apr_bad', { snapshot_json: '{}' }); f.stage('apr_late'); f.stage('apr_good');
    await f.presenter.reconcile(signal());
    f.proposal = { ...proposal('apr_late'), snapshot_json: '{}' };
    await f.presenter.reconcile(signal());
    expect(row(f, 'apr_bad')).toMatchObject({ delivery: 'unrepresentable' });
    expect(row(f, 'apr_late')).toMatchObject({ delivery: 'posted', card_sha256: null, attempts: 1 });
    expect(row(f, 'apr_good')).toMatchObject({ delivery: 'posted', shows: 'open', attempts: 0 });
  });

  it('redraws a decided presentation and does not let 25 completed rows starve it', async () => {
    const f = fixture();
    for (let n = 0; n < 25; n++) f.db.prepare('INSERT INTO authority_approval_presentations_v1 VALUES (?,\'slack\',?,\'D1\',\'posted\',NULL,NULL,\'1.1\',\'hash\',\'approved\',0,NULL,?,?)').run(`done_${n}`, JSON.stringify(target), '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z');
    const id = f.stage('apr_decided', { status: 'publishing', decided_on: 'desktop' });
    f.db.prepare('INSERT INTO authority_approval_presentations_v1 VALUES (?,\'slack\',?,\'D1\',\'posted\',NULL,NULL,\'1.1\',\'hash\',\'open\',0,NULL,?,?)').run(id, JSON.stringify(target), '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z');
    f.db.prepare('INSERT INTO authority_approval_decisions_v1 VALUES (?,?)').run(id, 'approve');
    await f.presenter.reconcile(signal());
    expect(f.calls).toEqual(['publish']); expect(row(f, id)).toMatchObject({ shows: 'approved' });
  });
});
