import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonMeetingReviewV2, PersonRunV1 } from '@echo-brain/organization-api';
import type { HomeView, OpenItemsView, OpenItemView, ToolStatus } from '../../src/shared/protocol.js';

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
/** Items reads fail (unavailable) while set. */
let failItems = false;
/** Home reads to hold until the test answers them, each with what `home` holds then. */
let holdHome = 0;
let held: (() => void)[] = [];
/** The next send waits until the test answers it; `sendFailure` makes it fail. */
let holdSend = false;
let answerSend: (() => void) | null = null;
let sendFailure: { code: string; retryable: boolean } | null = null;
/** What a sweep request answers ('fails': unavailable), the sweep run it queued, and what starting that run answers ('fails': unavailable). */
let sweepAnswer: { run_id: string } | { state: 'nothing_to_check' } | 'fails' = { state: 'nothing_to_check' };
let sweep: PersonRunV1 | null = null;
let sweepStarts: 'running' | 'busy' | 'done' | 'failed' | 'fails' = 'running';
/** What an items read answers, when a test says. */
let page: OpenItemsView | null = null;

const impactRun = (state: PersonRunV1['state'], id = '20', event = approval): PersonRunV1 => ({
  run_id: `run_00000000-0000-4000-8000-0000000000${id}`, trigger: 'approved_record', event_ref: event, state,
  error_code: state === 'failed' ? 'research_failed' : null, created_at: '2026-10-08T10:00:00.000Z', updated_at: '2026-10-08T10:05:00.000Z',
});
const sweepRun = (state: PersonRunV1['state']): PersonRunV1 => ({
  run_id: 'run_00000000-0000-4000-8000-000000000050', trigger: 'sweep', event_ref: 'sweep_00000000-0000-4000-8000-000000000050', state,
  error_code: state === 'failed' ? 'research_failed' : null, created_at: '2026-10-08T12:00:00.000Z', updated_at: '2026-10-08T12:00:00.000Z',
});
const meeting = (id: string, status: PersonMeetingReviewV2['status']): PersonMeetingReviewV2 => ({
  approval_id: `apr_${id.repeat(64)}`, title: `Meeting ${id}`, project_ids: [], status, decided_on: status === 'pending' ? null : 'desktop',
  first_line: null, action_count: 0, meeting_at: null,
});
const decision = { approval_id: approval, record_sha256: record, title: 'Pilot planning', first_line: 'Launch the pilot next week.', approved_at: '2026-10-08T10:00:00.000Z', project_ids: [] };
const person = (name: string) => ({ membership_id: `mem_00000000-0000-4000-8000-00000000000${name.length}`, name, active: true });
const item = (id: string, verdict: NonNullable<OpenItemView['check']>['verdict'] | null = null): OpenItemView => ({
  item_id: `itm_0000000${id}`, run_id: impactRun('done').run_id, kind: 'ticket', decision, relation: 'conflicts', expected: 'launch next week',
  approver: person('Mina Patel'), owner: { ...person('Fixture'), match: 'jira_account' }, waits_on: 'owner', state: 'open',
  created_at: '2026-10-08T10:05:00.000Z', sent_at: '2026-10-08T11:00:00.000Z', state_set_at: '2026-10-08T11:00:00.000Z',
  check: verdict === null ? null : { verdict, checked_at: '2026-10-08T12:00:00.000Z', checked_by: 'Mina Patel' }, can: { set_state: true, assign: true },
  reach: 'no_access',
});
const sendRow = (): HomeView['send'][number] => ({ run_id: impactRun('done').run_id, decision, items: 2, kinds: ['ticket'], owners: ['Mina Patel'], finished_at: '2026-10-08T10:05:00.000Z' });
const emptyHome = (): HomeView => ({ send: [], items: [], landed: 0, waiting: 0, last_checked_at: null, sweep_due: false });
const summary: OpenItemsView['summary'] = { unsent: 0, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 0, last_checked_at: null, by_decision: [] };
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const operations = () => rpc.mock.calls.filter(([method]) => method === 'runs').map(([, params]) => params.request.operation);
/** The runs requests sent with one operation, as sent. */
const requests = (operation: string) => rpc.mock.calls.filter(([method, params]) => method === 'runs' && params.request.operation === operation).map(([, params]) => params.request);
const project = { project_id: 'prj_11111111-1111-4111-8111-111111111111', name: 'Thermostat redesign', role: 'lead' as const, created_at: '2026-10-01T00:00:00.000Z', status: 'active' as const };

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
  failItems = false;
  holdHome = 0;
  held = [];
  holdSend = false;
  answerSend = null;
  sendFailure = null;
  sweepAnswer = { state: 'nothing_to_check' };
  sweep = null;
  sweepStarts = 'running';
  page = null;
  rpc.mockReset();
  rpc.mockImplementation(async (method: string, params: { request?: { operation: string; run_id?: string; state?: string } }) => {
    const ok = (value: unknown) => ({ ok: true, value });
    const unavailable = { ok: false, failure: { code: 'unavailable', retryable: true } };
    switch (method) {
      case 'app.status': return ok({ signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } });
      case 'projects.list': return ok({ items: [], next_cursor: null });
      case 'projects.members': return ok({ items: [], next_cursor: null });
      case 'list.page': return ok({ items: [], next_cursor: null, meetings_held: false });
      case 'open.ref': return unavailable;
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
          // Newest first: a sweep comes after the impact check.
          return ok({ runs: [...(sweep ? [{ ...sweep }] : []), ...(run ? [{ ...run }] : [])] });
        }
        if (params.request?.operation === 'home') {
          if (holdHome > 0) { holdHome -= 1; return new Promise(resolve => { held.push(() => resolve(ok(home))); }); }
          if (failNextHome) { failNextHome = false; return unavailable; }
          return ok(home);
        }
        if (params.request?.operation === 'start') {
          if (sweep && params.request.run_id === sweep.run_id) {
            if (sweepStarts === 'fails') return unavailable;
            if (sweepStarts !== 'busy') sweep = sweepRun(sweepStarts);
            return ok({ state: sweepStarts });
          }
          run = impactRun('running');
          return ok({ state: 'running' });
        }
        if (params.request?.operation === 'sweep') {
          if (sweepAnswer === 'fails') return unavailable;
          if ('run_id' in sweepAnswer) sweep = sweepRun('pending');
          return ok(sweepAnswer);
        }
        if (params.request?.operation === 'set_state') return failSetState ? unavailable : ok({ state: params.request.state });
        if (params.request?.operation === 'items') {
          if (failItems) return unavailable;
          if (page) return ok(page);
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
    await store.closeItem(opened, 'done');
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

  it('orders rows approve, send, review, update, failed, checking', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const reviews = [meeting('c', 'approved'), meeting('b', 'approved'), meeting('d', 'publishing'), meeting('e', 'approved'), meeting('a', 'pending')];
    const runs = [impactRun('running', '21', reviews[0]!.approval_id), impactRun('failed', '22', reviews[1]!.approval_id), impactRun('done', '23', reviews[3]!.approval_id)];
    const open: HomeView = { ...emptyHome(), send: [sendRow()], items: [item('1'), item('2', 'changed')] };
    const rows = needRows(reviews, runs, open, 'member');
    expect(rows.map(row => row.kind)).toEqual(['approve', 'send', 'review', 'update', 'failed', 'checking', 'checking']);
    expect(rows[2]).toMatchObject({ kind: 'review', item: { item_id: 'itm_00000002' } });
    expect(rows[5]).toMatchObject({ kind: 'checking', run: { state: 'running' } });
    // A finished check makes no row of its own: what it found comes from `home`.
    expect(rows.some(row => 'review' in row && row.review.approval_id === reviews[3]!.approval_id)).toBe(false);
  });

  it('leaves only review and run rows when the home part was never read', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const rows = needRows([meeting('a', 'pending'), meeting('b', 'approved')], [impactRun('failed', '22', meeting('b', 'approved').approval_id)], null, 'member');
    expect(rows.map(row => row.kind)).toEqual(['approve', 'failed']);
  });

  it('keeps the owner\'s changed item an Update row, flagged, and makes someone else\'s changed item a Review row (R64)', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const me = 'member';
    const own = (id: string, verdict: Parameters<typeof item>[1] = null): OpenItemView => ({ ...item(id, verdict), owner: { membership_id: me, name: 'Fixture', active: true, match: 'jira_account' } });
    const open: HomeView = { ...emptyHome(), items: [own('1'), own('2', 'changed'), item('3', 'changed'), own('4', 'still_open'), item('5')] };
    const rows = needRows([], [], open, me);
    // Changed items first, Update or Review; then the others, all Update.
    expect(rows.map(row => [row.kind, 'item' in row ? row.item.item_id : null, 'changed' in row ? row.changed : null])).toEqual([
      ['update', 'itm_00000002', true], ['review', 'itm_00000003', null], ['update', 'itm_00000001', false], ['update', 'itm_00000004', false],
      ['update', 'itm_00000005', false],
    ]);
  });

  it('takes the viewer from the account Home was read for', async () => {
    home = { ...emptyHome(), items: [item('1', 'changed'), { ...item('2', 'changed'), owner: { membership_id: 'member', name: 'Fixture', active: true, match: 'jira_account' } }] };
    granola = null;
    const store = await start();
    expect(store.getState().home?.rows.map(row => row.kind)).toEqual(['review', 'update']);
  });

  it('names an Approve row\'s meeting without writing "meeting" twice (R76)', async () => {
    const { ReviewLine } = await import('../../src/renderer/screens/home.js');
    /** The text a line renders, its parts joined. */
    const text = (node: unknown): string => {
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(text).join('');
      if (node && typeof node === 'object' && 'props' in node) return text((node as { props: { children?: unknown } }).props.children);
      return '';
    };
    const line = (title: string) => text(ReviewLine({ row: { kind: 'approve', review: { ...meeting('a', 'pending'), title, meeting_at: '2026-10-06T12:00:00.000Z' } } }));
    expect(line('Pilot planning')).toBe('Decision · Pilot planning meeting, Oct 6');
    expect(line('Approved meeting')).toBe('Decision · Approved meeting, Oct 6');
    expect(line('Weekly Meeting')).toBe('Decision · Weekly Meeting, Oct 6');
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
    await store.closeItem(store.getState().home!.open!.items[0]!, 'done');
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
    const done = store.closeItem(first, 'done');
    expect(store.getState().home?.rows.filter(row => row.kind === 'update')).toHaveLength(1);
    await done;
    expect(operations()).toContain('set_state');
    expect(store.getState().home?.rows.filter(row => row.kind === 'update')).toHaveLength(1);
    failSetState = true;
    const second = store.getState().home!.open!.items[1]!;
    const failed = store.closeItem(second, 'done');
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

describe('Sweeps from Home', () => {
  it('makes no Home row of a sweep, going or failed', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const approved = meeting('b', 'approved');
    // Even a sweep naming an approval does not stand for its impact check.
    for (const state of ['pending', 'running', 'failed'] as const) {
      expect(needRows([approved], [{ ...sweepRun(state), event_ref: approved.approval_id }], null, 'member')).toEqual([]);
    }
  });

  it('starts queued impact checks before queued sweeps, and nothing while a run goes', async () => {
    const { runToStart } = await import('../../src/renderer/store.js');
    const queued = sweepRun('pending');
    // Lists come newest first: the oldest queued impact check goes first.
    expect(runToStart([queued, impactRun('pending', '21'), impactRun('pending', '22')])?.run_id).toBe(impactRun('pending', '22').run_id);
    expect(runToStart([queued, impactRun('done')])?.run_id).toBe(queued.run_id);
    expect(runToStart([queued, impactRun('running')])).toBeUndefined();
    expect(runToStart([sweepRun('running'), impactRun('pending')])).toBeUndefined();
    expect(runToStart([impactRun('done'), impactRun('failed', '22')])).toBeUndefined();
  });

  it('asks for the due sweep of your own items after impact checks, once per Home load', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('pending');
    home = { ...emptyHome(), sweep_due: true };
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await start();
    // The impact check starts first.
    expect(requests('start')).toEqual([{ schema_version: 1, operation: 'start', run_id: run.run_id }]);
    expect(requests('sweep')).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests('sweep')).toEqual([]);
    // It ends: Home reads what it found, and only then asks for the sweep and starts it.
    run = impactRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests('sweep')).toEqual([{ schema_version: 1, operation: 'sweep', scope: 'mine' }]);
    expect(requests('start').at(-1)).toEqual({ schema_version: 1, operation: 'start', run_id: sweepRun('pending').run_id });
    expect(store.getState().home?.rows).toEqual([]);
    // Home still says a sweep is due while it runs and once it is done: this Home load asks no more.
    await vi.advanceTimersByTimeAsync(5_000);
    sweep = sweepRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests('sweep')).toHaveLength(1);
    expect(requests('start')).toHaveLength(2);
    // The next Home load may ask again.
    await store.loadHome();
    expect(requests('sweep')).toHaveLength(2);
  });

  it('reads what a sweep found once it ends, even when no list showed it going', async () => {
    granola = null;
    home = { ...emptyHome(), sweep_due: true, items: [item('1')] };
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await start();
    expect(store.getState().home?.rows.map(row => row.kind)).toEqual(['update']);
    expect(requests('sweep')).toHaveLength(1);
    // Done before the next look.
    sweep = sweepRun('done');
    home = { ...emptyHome(), items: [item('1', 'changed')], landed: 1, last_checked_at: '2026-10-08T12:05:00.000Z' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.rows.map(row => row.kind)).toEqual(['review']);
    expect(store.getState().home?.open).toMatchObject({ landed: 1, last_checked_at: '2026-10-08T12:05:00.000Z' });
    // Then Home stops looking.
    const calls = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rpc.mock.calls).toHaveLength(calls);
  });

  it('starts a sweep that went back to the queue again, waiting longer after each start that starts nothing', async () => {
    granola = null;
    home = { ...emptyHome(), sweep_due: true };
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await start();
    expect(requests('start')).toHaveLength(1);
    // Its attempt timed out: the sweep is queued again, and for a while another run goes first.
    sweep = sweepRun('pending');
    sweepStarts = 'busy';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests('start')).toHaveLength(2);
    // Each start that starts nothing waits longer: 10 s, then 20 s.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(requests('start')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests('start')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(requests('start')).toHaveLength(3);
    sweepStarts = 'running';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests('start')).toHaveLength(4);
    expect(new Set(requests('start').map(request => request.run_id))).toEqual(new Set([sweepRun('pending').run_id]));
    // It ends: what it found shows, and no other sweep was asked for.
    sweep = sweepRun('done');
    home = { ...emptyHome(), items: [item('1', 'changed')] };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.rows.map(row => row.kind)).toEqual(['review']);
    expect(requests('sweep')).toHaveLength(1);
  });

  it('asks for its due sweep, and starts it, even when the runs read of that load failed (D6)', async () => {
    granola = null;
    home = { ...emptyHome(), sweep_due: true };
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    failNextList = true;
    await start();
    // The list read failed once; the load still asks for its one sweep and starts it.
    expect(requests('sweep')).toEqual([{ schema_version: 1, operation: 'sweep', scope: 'mine' }]);
    expect(requests('start')).toEqual([{ schema_version: 1, operation: 'start', run_id: sweepRun('pending').run_id }]);
  });

  it('starts a queued run even when the read of what a check found failed (D6)', async () => {
    granola = null;
    run = impactRun('running');
    await start();
    expect(requests('start')).toEqual([]);
    // The check ends while a sweep (from Check now) waits in the queue, and the read of what the check found fails.
    run = impactRun('done');
    sweep = sweepRun('pending');
    failNextHome = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests('start')).toEqual([{ schema_version: 1, operation: 'start', run_id: sweepRun('pending').run_id }]);
  });

  it('spends the Home load\'s one sweep request only when it asks for one (D6)', async () => {
    granola = null;
    run = impactRun('pending');
    home = { ...emptyHome(), sweep_due: true };
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    await start();
    // A queued impact check starts first: no sweep is asked for yet, so the load has not spent its request.
    expect(requests('sweep')).toEqual([]);
    run = impactRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests('sweep')).toHaveLength(1);
  });

  it('stops owing a sweep once a runs list no longer holds it', async () => {
    granola = null;
    home = { ...emptyHome(), sweep_due: true };
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    await start();
    expect(requests('sweep')).toHaveLength(1);
    sweep = null;
    const homeReads = requests('home').length;
    await vi.advanceTimersByTimeAsync(5_000);
    // Read as ended: what waits on you is read again, and then Home stops looking.
    expect(requests('home')).toHaveLength(homeReads + 1);
    const calls = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rpc.mock.calls).toHaveLength(calls);
    expect(requests('sweep')).toHaveLength(1);
  });

  it.each(['fails', 'failed'] as const)('shows nothing for a sweep that %s, and soon stops looking', async how => {
    granola = null;
    home = { ...emptyHome(), sweep_due: true };
    sweepAnswer = how === 'fails' ? 'fails' : { run_id: sweepRun('pending').run_id };
    sweepStarts = 'failed';
    const store = await start();
    expect(requests('sweep')).toHaveLength(1);
    expect(store.getState().home).toMatchObject({ loading: false, failure: undefined, rows: [] });
    // A sweep that failed at once is seen ended on the next look at most; then nothing more is read.
    await vi.advanceTimersByTimeAsync(5_000);
    const calls = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rpc.mock.calls).toHaveLength(calls);
    expect(store.getState().home?.rows).toEqual([]);
  });
});

describe('The item card and Your open items', () => {
  const landedItem = (id: string, set_state = true): OpenItemView => ({ ...item(id, 'landed'), can: { set_state, assign: true } });

  it('opens the item a Review row names, and closes it only on Mark updated or No change needed', async () => {
    granola = null;
    home = { ...emptyHome(), items: [item('1', 'changed'), item('2')] };
    const store = await start();
    const row = store.getState().home!.rows[0]!;
    expect(row.kind).toBe('review');
    store.openItemCard((row as { item: OpenItemView }).item);
    expect(store.itemCardShown()?.item.item_id).toBe('itm_00000001');
    expect(requests('set_state')).toEqual([]);
    store.closeCardItem('not_relevant');
    expect(store.itemCardShown()).toBeNull();
    // Its row leaves Home at once; the request follows.
    expect(store.getState().home?.rows.map(entry => entry.kind)).toEqual(['update']);
    await flush();
    expect(requests('set_state')).toEqual([{ schema_version: 1, operation: 'set_state', item_id: 'itm_00000001', state: 'not_relevant' }]);
  });

  it('closes all that match, each one you may close, and stays a status view of what is left', async () => {
    granola = null;
    home = { ...emptyHome(), landed: 3 };
    page = { items: [landedItem('1'), landedItem('2'), landedItem('3', false), item('4', 'changed'), { ...landedItem('5'), state: 'done' }], next_cursor: null, stages: [],
      summary: { ...summary, open: 4, landed: 3, changed: 1, last_checked_at: '2026-10-08T12:05:00.000Z' } };
    const store = await start();
    await store.openItemStatus('mine', undefined, null);
    // Your own items, open ones only (R51): the scope names no id.
    expect(requests('items')).toEqual([{ schema_version: 1, operation: 'items', scope: 'mine', open_only: true }]);
    expect(store.itemStatusShown()).toMatchObject({ scope: 'mine', title: null, open: 4, checked_at: '2026-10-08T12:05:00.000Z' });
    expect(store.itemStatusShown()?.items.map(entry => entry.item_id)).toEqual(['itm_00000001', 'itm_00000002', 'itm_00000003', 'itm_00000004']);
    home = { ...emptyHome(), landed: 1 };
    const homeReads = requests('home').length;
    await store.closeAllMatching();
    expect(requests('set_state')).toEqual([
      { schema_version: 1, operation: 'set_state', item_id: 'itm_00000001', state: 'done' }, { schema_version: 1, operation: 'set_state', item_id: 'itm_00000002', state: 'done' },
    ]);
    // What is left stays in view: the match you may not close, and the changed item.
    expect(store.itemStatusShown()).toMatchObject({ busy: false, open: 2, closed: true });
    expect(store.itemStatusShown()?.items.map(entry => entry.item_id)).toEqual(['itm_00000003', 'itm_00000004']);
    // Back reads Home again: it closed items.
    store.closeItemStatus();
    expect(store.itemStatusShown()).toBeNull();
    await flush();
    expect(requests('home')).toHaveLength(homeReads + 1);
    expect(store.getState().home?.open?.landed).toBe(1);
  });

  it('closes one matching item from its line', async () => {
    granola = null;
    page = { items: [landedItem('1'), landedItem('2'), item('3', 'still_open')], next_cursor: null, stages: [], summary: { ...summary, open: 3, landed: 2 } };
    const store = await start();
    await store.openItemStatus('record', record, 'Pilot planning');
    await store.closeMatching(store.itemStatusShown()!.items[1]!);
    expect(requests('set_state')).toEqual([{ schema_version: 1, operation: 'set_state', item_id: 'itm_00000002', state: 'done' }]);
    expect(store.itemStatusShown()?.items.map(entry => entry.item_id)).toEqual(['itm_00000001', 'itm_00000003']);
    expect(store.itemStatusShown()).toMatchObject({ open: 2, closed: true, busy: false });
    // Only a matching item you may close is closed from its line.
    await store.closeMatching(store.itemStatusShown()!.items[1]!);
    expect(requests('set_state')).toHaveLength(1);
  });

  it('pages open items only, with the same filter on More, and still keeps open ones only', async () => {
    granola = null;
    page = { items: [landedItem('1'), item('2', 'still_open')], next_cursor: 'cGFnZTI', stages: [], summary: { ...summary, open: 3, landed: 1, done: 60 } };
    const store = await start();
    await store.openItemStatus('project', project.project_id, project.name);
    // A closed item answered anyway is left out: the filter is the Authority's, the check stays ours.
    page = { items: [item('3'), { ...landedItem('4'), state: 'done' }], next_cursor: null, stages: [], summary: { ...summary, open: 3, landed: 1, done: 60 } };
    await store.moreItemStatus();
    expect(requests('items')).toEqual([
      { schema_version: 1, operation: 'items', scope: 'project', id: project.project_id, open_only: true },
      { schema_version: 1, operation: 'items', scope: 'project', id: project.project_id, open_only: true, cursor: 'cGFnZTI' },
    ]);
    expect(store.itemStatusShown()?.items.map(entry => entry.item_id)).toEqual(['itm_00000001', 'itm_00000002', 'itm_00000003']);
    expect(store.itemStatusShown()).toMatchObject({ open: 3, next: null });
  });

  it('says how many are open only once a read of them succeeded (D7)', async () => {
    granola = null;
    failItems = true;
    const store = await start();
    await store.openItemStatus('mine', undefined, null);
    // The first read failed: no count, so nothing reads "0 open" above the error.
    expect(store.itemStatusShown()).toMatchObject({ loading: false, open: null, failure: { code: 'unavailable' } });
    failItems = false;
    page = { items: [landedItem('1'), item('2', 'still_open')], next_cursor: 'cGFnZTI', stages: [], summary: { ...summary, open: 3, landed: 1 } };
    await store.openItemStatus('mine', undefined, null);
    expect(store.itemStatusShown()).toMatchObject({ open: 3 });
    // A failed More keeps the count the first page read.
    failItems = true;
    await store.moreItemStatus();
    expect(store.itemStatusShown()).toMatchObject({ open: 3, failure: { code: 'unavailable' } });
  });

  it('keeps an item that could not be closed, with why', async () => {
    granola = null;
    page = { items: [landedItem('1'), landedItem('2')], next_cursor: null, stages: [], summary: { ...summary, open: 2, landed: 2 } };
    const store = await start();
    await store.openItemStatus('mine', undefined, null);
    failSetState = true;
    await store.closeAllMatching();
    expect(store.itemStatusShown()).toMatchObject({ busy: false, closeFailure: 'ECHO is unavailable right now. Try again.' });
    expect(store.itemStatusShown()?.items.map(entry => entry.item_id)).toEqual(['itm_00000001', 'itm_00000002']);
  });
});

describe('Check now', () => {
  const linePage = (): OpenItemsView => ({ items: [], next_cursor: null, stages: [],
    summary: { ...summary, open: 3, landed: 1, unreadable: 1, decisions: 1, by_decision: [{ record_sha256: record, unsent: 0, open: 3, landed: 1, unreadable: 1 }] } });

  it('says when nothing is open to check, and when the sweep could not be asked for', async () => {
    granola = null;
    page = linePage();
    const store = await start();
    await store.openProject(project);
    expect(store.getState().projectLine).toMatchObject({ summary: { open: 3 }, check: null });
    await store.checkNow('projectLine', project.name);
    expect(requests('sweep')).toEqual([{ schema_version: 1, operation: 'sweep', scope: 'project', id: project.project_id }]);
    expect(store.getState().projectLine?.check).toBe('nothing');
    sweepAnswer = 'fails';
    await store.checkNow('projectLine', project.name);
    expect(store.getState().projectLine?.check).toBe('failed');
  });

  it('checks until its sweep ends, then opens Your open items for that scope', async () => {
    granola = null;
    page = linePage();
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await start();
    await store.openProject(project);
    const checking = store.checkNow('projectLine', project.name);
    await flush();
    expect(store.getState().projectLine?.check).toBe('checking');
    expect(requests('start')).toEqual([{ schema_version: 1, operation: 'start', run_id: sweepRun('pending').run_id }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().projectLine?.check).toBe('checking');
    expect(store.itemStatusShown()).toBeNull();
    sweep = sweepRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    await checking;
    expect(store.itemStatusShown()).toMatchObject({ scope: 'project', id: project.project_id, title: project.name });
    // The line was read again, ready for another check.
    expect(store.getState().projectLine?.check).toBeNull();
    expect(requests('sweep')).toHaveLength(1);
  });

  it('starts a queued impact check before its sweep, which waits its turn', async () => {
    granola = null;
    page = linePage();
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await start();
    await store.openProject(project);
    run = impactRun('pending');
    sweepStarts = 'busy';
    const checking = store.checkNow('projectLine', project.name);
    // Busy: the next look, 10 s on, starts the impact check first.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests('start').map(request => request.run_id)).toEqual([sweepRun('pending').run_id, run.run_id]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests('start')).toHaveLength(2);
    run = impactRun('done');
    sweepStarts = 'running';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests('start').map(request => request.run_id)).toEqual([sweepRun('pending').run_id, run.run_id, sweepRun('pending').run_id]);
    sweep = sweepRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    await checking;
    expect(store.itemStatusShown()).toMatchObject({ scope: 'project', id: project.project_id });
  });

  it('waits longer after each start that starts nothing, busy or failed', async () => {
    granola = null;
    page = linePage();
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    sweepStarts = 'busy';
    const store = await start();
    await store.openProject(project);
    const lists = () => requests('list').length;
    const before = lists();
    const checking = store.checkNow('projectLine', project.name);
    await flush();
    expect(requests('start')).toHaveLength(1);
    // Busy: the next look is 10 s away.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(lists()).toBe(before);
    await vi.advanceTimersByTimeAsync(1_000);
    expect([lists(), requests('start').length]).toEqual([before + 1, 2]);
    // Busy again, then a start that fails: 20 s, then 40 s.
    sweepStarts = 'fails';
    await vi.advanceTimersByTimeAsync(19_000);
    expect(lists()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect([lists(), requests('start').length]).toEqual([before + 2, 3]);
    await vi.advanceTimersByTimeAsync(39_000);
    expect(lists()).toBe(before + 2);
    sweepStarts = 'running';
    await vi.advanceTimersByTimeAsync(1_000);
    expect([lists(), requests('start').length]).toEqual([before + 3, 4]);
    // Started: back to the usual pace, and it ends.
    sweep = sweepRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    await checking;
    expect(store.itemStatusShown()).toMatchObject({ scope: 'project', id: project.project_id });
  });

  it('stops following its sweep once its page goes, leaving Home the only one to look', async () => {
    granola = null;
    page = linePage();
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await start();
    await store.openProject(project);
    void store.checkNow('projectLine', project.name);
    await flush();
    expect(store.getState().projectLine?.check).toBe('checking');
    // Home: its read shows the sweep running, so Home looks again every 5 s; the line's loop reads nothing more.
    store.goHome();
    await flush();
    const lists = requests('list').length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests('list')).toHaveLength(lists + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests('list')).toHaveLength(lists + 2);
    expect(requests('start')).toHaveLength(1);
  });

  it('says the check failed when its sweep fails, and Try again asks for another', async () => {
    granola = null;
    page = linePage();
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await start();
    await store.openProject(project);
    const checking = store.checkNow('projectLine', project.name);
    await flush();
    expect(requests('start')).toHaveLength(1);
    sweep = sweepRun('failed');
    await vi.advanceTimersByTimeAsync(5_000);
    await checking;
    expect(store.getState().projectLine?.check).toBe('failed');
    expect(store.itemStatusShown()).toBeNull();
    sweepAnswer = { state: 'nothing_to_check' };
    await store.checkNow('projectLine', project.name);
    expect(requests('sweep')).toHaveLength(2);
    expect(store.getState().projectLine?.check).toBe('nothing');
  });

  it('learns from the decision\'s check whether Send and Try again are yours, reading no runs list', async () => {
    granola = null;
    page = { ...linePage(), stages: [{ record_sha256: record, run_id: impactRun('done').run_id, state: 'done', error_code: null, mine: true }],
      summary: { ...summary, unsent: 2, decisions: 1, by_decision: [{ record_sha256: record, unsent: 2, open: 0, landed: 0, unreadable: 0 }] } };
    const store = await start();
    await store.openProject(project);
    const lists = requests('list').length;
    await store.openListItem({ ref: { kind: 'meeting', id: record }, title: 'Pilot planning', added_at: '2026-10-08T10:00:00.000Z', visibility: 'project', projects: [] });
    await flush();
    expect(store.getState().impactLine).toMatchObject({ scope: 'record', id: record, stage: { mine: true }, summary: { unsent: 2 } });
    expect(requests('list')).toHaveLength(lists);
  });
});
