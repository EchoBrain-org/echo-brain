import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonMeetingReviewV2, PersonRunV1 } from '@echo-brain/organization-api';
import type { HomeView, OpenItemView, ToolStatus } from '../../src/shared/protocol.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const approval = 'apr_' + 'a'.repeat(64);
const record = 'sha256:' + '1'.repeat(64);
let review: PersonMeetingReviewV2;
let run: PersonRunV1 | null;
let home: HomeView;
let granola: ToolStatus | null = 'linked';
let failNextList = false;
let failNextReviews = false;
let failLists = false;
let failNextHome = false;
let failSetState = false;
/** Home reads to hold until the test answers them, each with what `home` holds then. */
let holdHome = 0;
let held: (() => void)[] = [];
/** The next send waits until the test answers it; `sendFailure` makes it fail. */
let holdSend = false;
let answerSend: (() => void) | null = null;
let sendFailure: { code: string; retryable: boolean } | null = null;

const impactRun = (state: PersonRunV1['state'], id = '20', event = approval): PersonRunV1 => ({
  run_id: `run_00000000-0000-4000-8000-0000000000${id}`, trigger: 'approved_record', event_ref: event, state,
  error_code: state === 'failed' ? 'research_failed' : null, created_at: '2026-10-08T10:00:00.000Z', updated_at: '2026-10-08T10:05:00.000Z',
});
const meeting = (id: string, status: PersonMeetingReviewV2['status']): PersonMeetingReviewV2 => ({
  approval_id: `apr_${id.repeat(64)}`, title: `Meeting ${id}`, project_ids: [], status, decided_on: status === 'pending' ? null : 'desktop',
  first_line: null, action_count: 0, meeting_at: null,
});
const decision = { approval_id: approval, record_sha256: record, title: 'Pilot planning', first_line: 'Launch the pilot next week.', approved_at: '2026-10-08T10:00:00.000Z', project_ids: [] };
const person = (name: string) => ({ membership_id: `mem_00000000-0000-4000-8000-00000000000${name.length}`, name, active: true });
const item = (id: string, verdict: 'changed' | null = null): OpenItemView => ({
  item_id: `itm_0000000${id}`, run_id: impactRun('done').run_id, kind: 'ticket', decision, relation: 'conflicts', expected: 'launch next week',
  approver: person('Mina Patel'), owner: { ...person('Fixture'), match: 'jira_account' }, waits_on: 'owner', state: 'open',
  created_at: '2026-10-08T10:05:00.000Z', sent_at: '2026-10-08T11:00:00.000Z', state_set_at: '2026-10-08T11:00:00.000Z',
  check: verdict === null ? null : { verdict, checked_at: '2026-10-08T12:00:00.000Z', checked_by: 'Mina Patel' }, can: { set_state: true, assign: true },
  reach: 'no_access',
});
const sendRow = (): HomeView['send'][number] => ({ run_id: impactRun('done').run_id, decision, items: 2, kinds: ['ticket'], owners: ['Mina Patel'], finished_at: '2026-10-08T10:05:00.000Z' });
const emptyHome = (): HomeView => ({ send: [], items: [], landed: 0, waiting: 0, last_checked_at: null, sweep_due: false });
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const operations = () => rpc.mock.calls.filter(([method]) => method === 'runs').map(([, params]) => params.request.operation);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  review = { approval_id: approval, title: 'Private meeting', project_ids: [], status: 'pending', decided_on: null, first_line: null, action_count: 0, meeting_at: null };
  run = null;
  home = emptyHome();
  granola = 'linked';
  failNextList = false;
  failNextReviews = false;
  failLists = false;
  failNextHome = false;
  failSetState = false;
  holdHome = 0;
  held = [];
  holdSend = false;
  answerSend = null;
  sendFailure = null;
  rpc.mockReset();
  rpc.mockImplementation(async (method: string, params: { request?: { operation: string } }) => {
    const ok = (value: unknown) => ({ ok: true, value });
    const unavailable = { ok: false, failure: { code: 'unavailable', retryable: true } };
    switch (method) {
      case 'app.status': return ok({ signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } });
      case 'projects.list': return ok({ items: [], next_cursor: null });
      case 'app.setUnresolved': return ok(null);
      case 'account.tools': return ok({ tools: granola === null ? [] : [{ tool_id: 'granola', status: granola }] });
      case 'tools.meetings':
        if (params.request?.operation === 'reviews') {
          if (failNextReviews) { failNextReviews = false; return unavailable; }
          return ok({ reviews: [{ ...review }] });
        }
        if (params.request?.operation === 'review_open') return ok({ review: { ...review }, content: 'Private proposal text', suggested_projects: [], owners: [], snapshot_sha256: 'snapshot' });
        break;
      case 'runs':
        if (params.request?.operation === 'list') {
          if (failLists) return unavailable;
          if (failNextList) { failNextList = false; return unavailable; }
          return ok({ runs: run ? [{ ...run }] : [] });
        }
        if (params.request?.operation === 'home') {
          if (holdHome > 0) { holdHome -= 1; return new Promise(resolve => { held.push(() => resolve(ok(home))); }); }
          if (failNextHome) { failNextHome = false; return unavailable; }
          return ok(home);
        }
        if (params.request?.operation === 'start') { run = impactRun('running'); return ok({ state: 'running' }); }
        if (params.request?.operation === 'set_state') return failSetState ? unavailable : ok({ state: 'done' });
        if (params.request?.operation === 'items') {
          return ok({ items: [{ ...item('5'), state: 'unsent', sent_at: null, state_set_at: null, waits_on: 'approver' }], next_cursor: null, stages: [],
            summary: { unsent: 1, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 1, last_checked_at: null, by_decision: [] } });
        }
        if (params.request?.operation === 'send') {
          const answer = () => (sendFailure ? { ok: false, failure: sendFailure } : ok({ sent: 1, not_relevant: 0 }));
          if (holdSend) { holdSend = false; return new Promise(resolve => { answerSend = () => resolve(answer()); }); }
          return answer();
        }
        if (params.request?.operation === 'view') return ok({ status: 'assessed', decided: [], affected: [], unconfirmed: [], people: [], sources: [], hidden: 0, checked_at: '2026-10-08T10:05:00.000Z' });
    }
    throw new Error(`Unexpected request: ${method} ${params.request?.operation ?? ''}`);
  });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function start() {
  const store = await import('../../src/renderer/store.js');
  await store.refreshStatus();
  await flush();
  return store;
}

describe('Home rows', () => {
  it.each([null, 'unavailable'] as const)('shows and closes an owner item when Granola is %s', async status => {
    granola = status;
    home = { ...emptyHome(), items: [item('1')], waiting: 2 };
    const store = await start();
    expect(store.getState().home).toMatchObject({ meetings: false, loading: false, open: { waiting: 2 }, rows: [{ kind: 'update', item: { item_id: item('1').item_id } }] });
    expect(store.needsCount()).toBe(1);
    expect(rpc.mock.calls.some(([method]) => method === 'tools.meetings')).toBe(false);
    const opened = store.getState().home!.open!.items[0]!;
    home = { ...emptyHome(), waiting: 2 };
    await store.markDone(opened);
    expect(operations()).toContain('set_state');
    expect(store.getState().home?.rows).toEqual([]);
  });

  it('keeps open items when Granola becomes unavailable and stops reading meeting reviews', async () => {
    home = { ...emptyHome(), items: [item('1')] };
    const store = await start();
    expect(store.getState().home?.rows.map(row => row.kind)).toEqual(['approve', 'update']);
    granola = 'unavailable';
    rpc.mockClear();
    await store.loadHome();
    expect(store.getState().home?.rows.map(row => row.kind)).toEqual(['update']);
    expect(rpc.mock.calls.some(([method]) => method === 'tools.meetings')).toBe(false);
    expect(operations()).toContain('home');
  });

  it('orders rows approve, send, check, update, failed, checking', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const reviews = [meeting('c', 'approved'), meeting('b', 'approved'), meeting('d', 'publishing'), meeting('e', 'approved'), meeting('a', 'pending')];
    const runs = [impactRun('running', '21', reviews[0]!.approval_id), impactRun('failed', '22', reviews[1]!.approval_id), impactRun('done', '23', reviews[3]!.approval_id)];
    const open: HomeView = { ...emptyHome(), send: [sendRow()], items: [item('1'), item('2', 'changed')] };
    const rows = needRows(reviews, runs, open);
    expect(rows.map(row => row.kind)).toEqual(['approve', 'send', 'check', 'update', 'failed', 'checking', 'checking']);
    expect(rows[2]).toMatchObject({ kind: 'check', item: { item_id: 'itm_00000002' } });
    expect(rows[5]).toMatchObject({ kind: 'checking', run: { state: 'running' } });
    // A finished check makes no row of its own: what it found comes from `home`.
    expect(rows.some(row => 'review' in row && row.review.approval_id === reviews[3]!.approval_id)).toBe(false);
  });

  it('leaves only review and run rows when the home part was never read', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const rows = needRows([meeting('a', 'pending'), meeting('b', 'approved')], [impactRun('failed', '22', meeting('b', 'approved').approval_id)], null);
    expect(rows.map(row => row.kind)).toEqual(['approve', 'failed']);
  });

  it('names who Send tells: a pick, else the owner, never you, each once', async () => {
    const { sendRecipients } = await import('../../src/renderer/store.js');
    const me = 'mem_00000000-0000-4000-8000-000000000003';
    const mine = (id: string): OpenItemView => ({ ...item(id), owner: { membership_id: me, name: 'Ari', active: true, match: 'approver' } });
    const send = { run_id: 'run_00000020', seq: 1, loading: false, items: [item('1'), mine('2'), item('3')], ticks: { itm_00000001: true, itm_00000002: true, itm_00000003: true },
      picks: {}, command: 'c', busy: false, picker: null };
    expect(sendRecipients(send, me)).toEqual(['Fixture']);
    expect(sendRecipients({ ...send, picks: { itm_00000002: { membership_id: 'mem_00000000-0000-4000-8000-000000000009', display_name: 'Rafael Moreno' } } }, me))
      .toEqual(['Fixture', 'Rafael Moreno']);
    // Unticked items go to no one; with only your own ticked, Send keeps them on your Home.
    expect(sendRecipients({ ...send, ticks: { itm_00000002: true } }, me)).toEqual([]);
  });

  it('polls only while something is in flight, and backs off after failed reads', async () => {
    const { runPollDelay } = await import('../../src/renderer/store.js');
    const running = [impactRun('running')];
    const timeout = { code: 'timeout', retryable: true };
    expect(runPollDelay({ runs: running, publishing: false, failures: 0 })).toBe(5_000);
    expect(runPollDelay({ runs: [impactRun('pending')], publishing: false, failures: 0 })).toBe(5_000);
    expect(runPollDelay({ runs: [], publishing: true, failures: 0 })).toBe(5_000);
    expect(runPollDelay({ runs: [], publishing: false, failures: 0 })).toBeNull();
    expect(runPollDelay({ runs: [impactRun('done'), impactRun('failed', '22')], publishing: false, failures: 0 })).toBeNull();
    // A model-less Authority answers unavailable for good: with nothing in flight it is not asked again.
    expect(runPollDelay({ runs: [], publishing: false, failures: 1, lastFailure: { code: 'unavailable', retryable: true } })).toBeNull();
    expect([1, 2, 4, 9].map(failures => runPollDelay({ runs: running, publishing: false, failures, lastFailure: timeout }))).toEqual([10_000, 20_000, 60_000, 60_000]);
    // What a finished check found, still unread, keeps Home looking as a check in flight does, even through unavailable reads.
    const unavailable = { code: 'unavailable', retryable: true };
    expect(runPollDelay({ runs: [impactRun('done')], publishing: false, failures: 0, owed: true })).toBe(5_000);
    expect([1, 2, 4].map(failures => runPollDelay({ runs: [impactRun('done')], publishing: false, failures, lastFailure: unavailable, owed: true })))
      .toEqual([10_000, 20_000, 60_000]);
  });
});

describe('Home decisions and impact checks', () => {
  it('covers meeting rows and a private decision when another app is in front', async () => {
    const store = await start();
    store.conceal();
    expect(store.pageCovered()).toBe(true);
    store.resume();
    await flush();
    await store.openDecision(approval);
    store.conceal();
    expect(store.pageCovered()).toBe(true);
  });

  it('keeps a publishing approval visible and shows what its check found once it finishes', async () => {
    review = { ...review, status: 'publishing', decided_on: 'desktop' };
    const store = await start();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'checking', review: { status: 'publishing' } }]);
    expect(store.needsCount()).toBe(0);
    review = { ...review, status: 'approved' };
    run = impactRun('pending');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(operations()).toContain('start');
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'send', send: { run_id: run.run_id } }]);
    expect(store.needsCount()).toBe(1);
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.mock.calls).toHaveLength(requests);
  });

  it('resumes a check after spending a polling interval in another app', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    store.conceal();
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.mock.calls).toHaveLength(requests);
    store.resume();
    await flush();
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'send' }]);
  });

  it('refreshes an open decision when its check finishes while the app is hidden', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    await store.openDecision(approval, run);
    store.conceal();
    await vi.advanceTimersByTimeAsync(5_000);
    run = impactRun('done');
    store.resume();
    await flush();
    expect(store.getState().decision?.run?.state).toBe('done');
    expect(store.getState().decision?.impact).toMatchObject({ status: 'assessed' });
  });

  it('keeps polling, more slowly, after a temporary runs-list failure', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    failNextList = true;
    await vi.advanceTimersByTimeAsync(5_000);
    // The failed read kept the run it had: still checking.
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'checking' }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'send' }]);
  });

  it('reads what waits on you on a poll only once a check ends, since that read opens each item live', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    const homeReads = () => operations().filter(operation => operation === 'home').length;
    expect(homeReads()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(operations().filter(operation => operation === 'list')).toHaveLength(2);
    expect(homeReads()).toBe(1);
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(homeReads()).toBe(2);
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'send' }]);
  });

  it('keeps an item closed with Done off Home through polls that do not read it again', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    home = { ...emptyHome(), items: [item('1')] };
    const store = await start();
    await store.markDone(store.getState().home!.open!.items[0]!);
    expect(store.getState().home?.rows.map(row => row.kind)).toEqual(['checking']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(operations().filter(operation => operation === 'list')).toHaveLength(2);
    expect(store.getState().home?.rows.map(row => row.kind)).toEqual(['checking']);
    // A read of what waits on you, begun after Done was answered, decides from then on.
    home = emptyHome();
    run = impactRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.rows).toEqual([]);
    expect(store.getState().home?.closing).toEqual({});
  });

  it('reads what a finished check found again, more slowly, until that read succeeds', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    const homeReads = () => operations().filter(operation => operation === 'home').length;
    expect(homeReads()).toBe(1);
    // The check ends, and the read of what it found fails on that poll.
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    failNextHome = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(homeReads()).toBe(2);
    expect(store.getState().home?.rows).toEqual([]);
    // Home keeps looking, from 10 s, until the read succeeds; then it stops.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(homeReads()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(homeReads()).toBe(3);
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'send' }]);
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rpc.mock.calls).toHaveLength(requests);
  });

  it('keeps a sent check off Home until a read begun after the send says otherwise', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    const store = await start();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'send' }]);
    await store.openSend(run.run_id);
    expect(store.getState().send?.items).toHaveLength(1);
    // Sent: Home is read again, and that read fails; the kept part still has the Send row.
    failNextHome = true;
    await store.sendToOwners();
    await flush();
    expect(operations()).toContain('send');
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.getState().home?.rows).toEqual([]);
    // A later read, begun after the send was answered, decides.
    home = emptyHome();
    await store.loadHome();
    expect(store.getState().home?.rows).toEqual([]);
    expect(store.getState().home?.sent).toEqual({});
  });

  it('reads what waits on you again on the next poll after that read failed', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    failNextHome = true;
    const store = await start();
    expect(store.getState().home?.open).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(operations().filter(operation => operation === 'home')).toHaveLength(2);
    expect(store.getState().home?.open).toEqual(emptyHome());
  });

  it('never polls an Authority whose runs are unavailable when nothing is in flight', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    failLists = true;
    const store = await start();
    expect(store.getState().home?.failure).toBeUndefined();
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rpc.mock.calls).toHaveLength(requests);
  });

  it('keeps the rows a failed home read had, and shows no error for it', async () => {
    home = { ...emptyHome(), items: [item('1')], waiting: 1 };
    const store = await start();
    expect(store.getState().home?.rows.map(row => row.kind)).toEqual(['approve', 'update']);
    failNextHome = true;
    await store.loadHome();
    expect(store.getState().home?.rows.map(row => row.kind)).toEqual(['approve', 'update']);
    expect(store.getState().home?.open?.waiting).toBe(1);
    expect(store.getState().home?.failure).toBeUndefined();
  });

  it('takes an item off Home at once on Done, and brings it back with a line when Done fails', async () => {
    home = { ...emptyHome(), items: [item('1'), item('2')] };
    const store = await start();
    const first = store.getState().home!.open!.items[0]!;
    const done = store.markDone(first);
    expect(store.getState().home?.rows.filter(row => row.kind === 'update')).toHaveLength(1);
    await done;
    expect(operations()).toContain('set_state');
    expect(store.getState().home?.rows.filter(row => row.kind === 'update')).toHaveLength(1);
    failSetState = true;
    const second = store.getState().home!.open!.items[1]!;
    const failed = store.markDone(second);
    expect(store.getState().home?.rows.filter(row => row.kind === 'update')).toHaveLength(0);
    await failed;
    expect(store.getState().home?.rows.filter(row => row.kind === 'update')).toMatchObject([{ item: { item_id: second.item_id } }]);
    expect(store.getState().home?.closeFailures[second.item_id]).toBe('ECHO is unavailable right now. Try again.');
  });

  it('keeps owing what a finished check found until a read that is still Home\'s brings it', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    // The check ends, and the poll's read of what it found is slow.
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    holdHome = 1;
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(held).toHaveLength(1);
    // Meanwhile Home is read again, and that read of what the check found fails.
    failNextHome = true;
    await store.loadHome();
    expect(store.getState().home?.rows).toEqual([]);
    // The slow read answers now. It is no longer Home's read: it shows nothing, and settles nothing Home still owes.
    held.shift()!();
    await flush();
    expect(store.getState().home?.rows).toEqual([]);
    // So Home keeps looking, and its next read brings the Send row.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'send', send: { run_id: run.run_id } }]);
  });

  it('keeps a sent check off Home when the send is answered after its card was left', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    const store = await start();
    await store.openSend(run.run_id);
    holdSend = true;
    const sending = store.sendToOwners();
    await flush();
    // Home, before the send is answered: what it reads still has the Send row.
    store.goHome();
    await flush();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'send' }]);
    answerSend!();
    await sending;
    await flush();
    expect(store.getState().home?.sent).toHaveProperty(run.run_id);
    expect(store.getState().home?.rows).toEqual([]);
  });

  it('offers no Details while Tell the owners? is sending', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    const store = await start();
    await store.openSend(run.run_id);
    holdSend = true;
    const sending = store.sendToOwners();
    await flush();
    expect(store.getState().send?.busy).toBe(true);
    // Leaving for Details now would bring the card back stuck on Sending.
    store.sendDetails();
    await flush();
    expect(store.getState().route).toEqual({ page: 'send', run_id: run.run_id });
    answerSend!();
    await sending;
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.getState().toast).toBe('Sent');
  });

  it('says the items changed when a send is refused as a conflict, and reads the account again only when access was lost', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    const store = await start();
    await store.openSend(run.run_id);
    const statusReads = () => rpc.mock.calls.filter(([method]) => method === 'app.status').length;
    const before = statusReads();
    sendFailure = { code: 'conflict', retryable: false };
    await store.sendToOwners();
    expect(store.getState().send).toMatchObject({ busy: false, failure: 'These items changed meanwhile. Open them again from Home.' });
    expect(store.getState().route).toEqual({ page: 'send', run_id: run.run_id });
    await flush();
    expect(statusReads()).toBe(before);
    // Lost access is another matter: the account is read again.
    sendFailure = { code: 'stale_access_state', retryable: false };
    await store.sendToOwners();
    await flush();
    expect(store.getState().send?.failure).not.toBe('These items changed meanwhile. Open them again from Home.');
    expect(statusReads()).toBe(before + 1);
  });

  it('keeps an initial runs-list failure silent and recovers when Home is read again', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    failNextList = true;
    const store = await start();
    expect(store.getState().home).toMatchObject({ loading: false, failure: undefined });
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.mock.calls).toHaveLength(requests);
    await store.loadHome();
    expect(store.getState().home?.failure).toBeUndefined();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
  });

  it.each([false, true])('resumes a failed Home while work is outstanding, result owed: %s', async owed => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    if (owed) {
      run = impactRun('done');
      home = { ...emptyHome(), send: [sendRow()] };
      failNextHome = true;
    }
    failNextReviews = true;
    await store.loadHome();
    expect(store.getState().home?.failure).toMatchObject({ code: 'unavailable' });
    if (owed) expect(store.getState().home?.rows).toHaveLength(0);
    store.conceal();
    await vi.advanceTimersByTimeAsync(60_000);
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    store.resume();
    await flush();
    expect(store.getState().home?.failure).toBeUndefined();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'send', send: { run_id: run.run_id } }]);
  });

  it.each([false, true])('preserves and retries a failed resume with an open decision: %s', async (openCard) => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    if (openCard) await store.openDecision(approval, run);
    store.conceal();
    failNextList = true;
    store.resume();
    await flush();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
    expect(store.getState().home?.failure).toBeUndefined();
    if (openCard) expect(store.getState().decision?.run?.state).toBe('running');
    // A second focus change must not strand the retry after stopping its timer.
    store.conceal();
    failNextList = true;
    store.resume();
    await flush();
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.getState().home?.failure).toBeUndefined();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'send', send: { run_id: run.run_id } }]);
    if (openCard) {
      expect(store.getState().decision?.run?.state).toBe('done');
      expect(store.getState().decision?.impact).toMatchObject({ status: 'assessed' });
    }
  });
});
