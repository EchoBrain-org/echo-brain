import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonMeetingReviewV2, PersonRunV1 } from '@echo-brain/organization-api';
import type { FollowUpList } from '../../src/renderer/store.js';
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
/** Home reads to hold until the test answers them, each with what `home` holds then. */
let holdHome = 0;
let held: (() => void)[] = [];
let sendFailure: { code: string; retryable: boolean; mutation_outcome?: 'unknown' } | null = null;
/** What a sweep request answers ('fails': unavailable), the sweep run it queued, and what starting that run answers ('fails': unavailable). */
let sweepAnswer: { run_id: string } | { state: 'nothing_to_check' } | 'fails' = { state: 'nothing_to_check' };
let sweep: PersonRunV1 | null = null;
let sweepStarts: 'running' | 'busy' | 'done' | 'failed' | 'fails' = 'running';
/** What an items read answers, when a test says. */
let page: OpenItemsView | null = null;
/** How an assign fails, when a test says; what a read of one item answers (unavailable while null). */
let assignFailure: { code: string; retryable: boolean; mutation_outcome?: 'unknown' } | null = null;
let readItem: OpenItemView | null = null;
/** set_state replies wait while set, until the test answers them in order. */
let holdSetState = false;
let answerSetState: (() => void)[] = [];
const RAFAEL = { membership_id: 'mem_00000000-0000-4000-8000-000000000088', display_name: 'Rafael Moreno' };

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
  created_at: '2026-10-08T10:05:00.000Z', sent_at: '2026-10-08T11:00:00.000Z', state_set_at: '2026-10-08T11:00:00.000Z', state_set_by: person('Mina Patel'),
  owner_set_at: null, owner_set_by: null, reached_owner: true,
  check: verdict === null ? null : { verdict, checked_at: '2026-10-08T12:00:00.000Z', checked_by: 'Mina Patel' }, can: { set_state: true, assign: true },
  reach: 'no_access',
});
/** An item of Ari's own check not sent yet: Ari ("member") approved it, so Ari may send it and pick its owner. */
const unsent = (id: string, run_id = impactRun('done').run_id): OpenItemView => ({
  ...item(id), run_id, approver: { membership_id: 'member', name: 'Fixture', active: true }, state: 'unsent', sent_at: null, state_set_at: null, state_set_by: null,
  reached_owner: false, waits_on: 'approver', can: { set_state: false, assign: true },
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
  holdHome = 0;
  held = [];
  sendFailure = null;
  sweepAnswer = { state: 'nothing_to_check' };
  sweep = null;
  sweepStarts = 'running';
  page = null;
  assignFailure = null;
  readItem = null;
  holdSetState = false;
  answerSetState = [];
  rpc.mockReset();
  rpc.mockImplementation(async (method: string, params: { project_id?: string; request?: { operation: string; run_id?: string; state?: string } }) => {
    const ok = (value: unknown) => ({ ok: true, value });
    const unavailable = { ok: false, failure: { code: 'unavailable', retryable: true } };
    switch (method) {
      case 'app.status': return ok({ signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } });
      case 'projects.list': return ok({ items: [], next_cursor: null });
      case 'projects.members': return ok({ items: [], next_cursor: null });
      case 'list.page': return ok({ items: [], next_cursor: null, meetings_held: false });
      case 'open.ref': return unavailable;
      // A project's tools line: it reads nothing.
      case 'projects.jiraRead': case 'projects.confluenceRead': return ok({ project_id: params.project_id, revision: null, mapping: null });
      case 'app.setUnresolved': return ok(null);
      case 'people.directory': return ok({ items: [RAFAEL], next_cursor: null });
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
        if (params.request?.operation === 'set_state') {
          const reply = ok({ state: params.request.state });
          return holdSetState ? new Promise(resolve => { answerSetState.push(() => resolve(reply)); }) : reply;
        }
        if (params.request?.operation === 'assign') {
          return assignFailure ? { ok: false, failure: assignFailure } : ok({ owner: { membership_id: RAFAEL.membership_id, name: RAFAEL.display_name, active: true } });
        }
        if (params.request?.operation === 'item') return readItem ? ok(readItem) : unavailable;
        if (params.request?.operation === 'items') {
          if (page) return ok(page);
          return ok({ items: [{ ...item('5'), state: 'unsent', sent_at: null, state_set_at: null, waits_on: 'approver' }], next_cursor: null, stages: [],
            summary: { unsent: 1, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 1, last_checked_at: null, by_decision: [] } });
        }
        if (params.request?.operation === 'send') {
          return sendFailure ? { ok: false, failure: sendFailure } : ok({ sent: 1, not_relevant: 0 });
        }
        if (params.request?.operation === 'view') return ok({ decided: [{ text: 'Launch the pilot next week.', citation_index: 0 }] });
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
  it.each([null, 'unavailable'] as const)('shows an owner item when Granola is %s, and its row opens its page over Home', async status => {
    granola = status;
    home = { ...emptyHome(), items: [item('1')], waiting: 2 };
    const store = await start();
    expect(store.getState().home).toMatchObject({ meetings: false, loading: false, open: { waiting: 2 }, rows: [{ kind: 'update', item: { item_id: item('1').item_id } }] });
    expect(store.needsCount()).toBe(1);
    expect(rpc.mock.calls.some(([method]) => method === 'tools.meetings')).toBe(false);
    // The row's copy shows at once, then the item is read again.
    readItem = { ...item('1'), expected: 'launch this week' };
    const opening = store.openFollowUp(item('1').item_id, store.getState().home!.open!.items[0]!);
    expect(store.followUpShown()).toMatchObject({ kind: 'item', loading: true, item: { expected: 'launch next week' } });
    await opening;
    expect(store.followUpShown()).toMatchObject({ kind: 'item', loading: false, item: { expected: 'launch this week' } });
    expect(requests('item')).toEqual([{ schema_version: 1, operation: 'item', item_id: item('1').item_id }]);
    expect(store.getState().route).toEqual({ page: 'home' });
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

  it('merges Home loads asked for while one is on its way: one set of reads, then at most one more', async () => {
    const store = await start();
    rpc.mockClear();
    holdHome = 1;
    const first = store.loadHome();
    await flush();
    // The window comes forward (resume and shown) while that load waits: both join it.
    const joined = [store.loadHome(), store.loadHome()];
    await flush();
    const loads = () => rpc.mock.calls.filter(([method]) => method === 'account.tools').length;
    expect(loads()).toBe(1);
    held.shift()!();
    await Promise.all([first, ...joined]);
    expect(loads()).toBe(2);
    expect(operations().filter(operation => operation === 'home')).toEqual(['home', 'home']);
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

  it('keeps the owner\'s changed item an Update row, first, and makes someone else\'s changed item a Review row (R64)', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const me = 'member';
    const own = (id: string, verdict: Parameters<typeof item>[1] = null): OpenItemView => ({ ...item(id, verdict), owner: { membership_id: me, name: 'Fixture', active: true, match: 'jira_account' } });
    const open: HomeView = { ...emptyHome(), items: [own('1'), own('2', 'changed'), item('3', 'changed'), own('4', 'still_open'), item('5')] };
    const rows = needRows([], [], open, me);
    // Changed items first, Update or Review; then the others, all Update.
    expect(rows.map(row => [row.kind, 'item' in row ? row.item.item_id : null])).toEqual([
      ['update', 'itm_00000002'], ['review', 'itm_00000003'], ['update', 'itm_00000001'], ['update', 'itm_00000004'], ['update', 'itm_00000005'],
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

  it('locks the choices once an approve may have arrived, and Approve sends them again as they were', async () => {
    const store = await start();
    await store.openDecision(approval);
    await flush();
    store.setDecisionShare(true);
    const reviews = () => rpc.mock.calls.filter(([method, params]) => method === 'tools.meetings' && params.request?.operation === 'review').map(([, params]) => params.request);
    rpc.mockImplementationOnce(async () => ({ ok: false, failure: { code: 'timeout', retryable: true, mutation_outcome: 'unknown' } }));
    await store.decide('approve');
    expect(store.getState().decision).toMatchObject({ busy: false, unknown: true, failure: 'This may not have been sent.' });
    store.setDecisionShare(false);
    store.setDecisionAudience('projects');
    expect(store.getState().decision).toMatchObject({ share: true, audience: 'only-me' });
    rpc.mockImplementationOnce(async () => ({ ok: true, value: { status: 'approved', decided_on: 'desktop' } }));
    await store.decide('approve');
    expect(reviews()).toHaveLength(2);
    expect(reviews()[1]).toEqual(reviews()[0]);
    expect(store.getState().toast).toBe('Approved · checking what it changes');
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
    expect(store.getState().decision?.impact).toEqual({ decided: [{ text: 'Launch the pilot next week.', citation_index: 0 }] });
    // Its follow-ups, counted by its check for the page's line.
    expect(store.getState().impactLine).toMatchObject({ scope: 'run', id: run.run_id, loading: false, summary: { unsent: 1 } });
    expect(requests('items').at(-1)).toEqual({ schema_version: 1, operation: 'items', scope: 'run', id: run.run_id, summary_only: true });
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
      expect(store.getState().decision?.impact).toEqual({ decided: [{ text: 'Launch the pilot next week.', citation_index: 0 }] });
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


describe('Follow-up lists and item pages', () => {
  /** A page of follow-ups, counted by status. */
  const listPage = (items: OpenItemView[]): OpenItemsView => ({ items, next_cursor: null, stages: [], summary: {
    ...summary, decisions: 1, unsent: items.filter(entry => entry.state === 'unsent').length, open: items.filter(entry => entry.state === 'open').length,
    done: items.filter(entry => entry.state === 'done').length, not_relevant: items.filter(entry => entry.state === 'not_relevant').length } });
  const list = (store: Awaited<ReturnType<typeof start>>) => store.followUpShown() as FollowUpList;
  const said = (store: Awaited<ReturnType<typeof start>>) => store.followUpShown()?.said;
  /** What main's quit guard was told last. */
  const told = () => rpc.mock.calls.filter(([method]) => method === 'app.setUnresolved').map(([, params]) => params).at(-1);
  const other = 'run_00000000-0000-4000-8000-000000000021';
  const rafael = { membership_id: RAFAEL.membership_id, name: RAFAEL.display_name, active: true };

  beforeEach(() => { granola = null; });

  it('ticks every Not sent row you may send on a meeting\'s first read, and none on Your follow-ups', async () => {
    page = listPage([unsent('1'), unsent('2'), { ...unsent('3'), can: { set_state: false, assign: false } }, item('4')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    expect(list(store)).toMatchObject({ kind: 'list', scope: 'record', id: record, title: 'Pilot planning', loading: false });
    expect(list(store).ticks).toEqual({ itm_00000001: true, itm_00000002: true });
    expect(requests('items')).toEqual([{ schema_version: 1, operation: 'items', scope: 'record', id: record }]);
    // Your follow-ups: a page of its own, every status, nothing ticked.
    await store.openYourFollowUps();
    expect(store.getState().route).toEqual({ page: 'follow-ups' });
    expect(list(store)).toMatchObject({ scope: 'mine', ticks: {} });
    expect(requests('items').at(-1)).toEqual({ schema_version: 1, operation: 'items', scope: 'mine' });
    // Back from it is Home.
    store.closeFollowUp();
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.followUpShown()).toBeNull();
  });

  it('sends only the ticked rows, one send per check with a command of its own, and stays on the list, read again', async () => {
    page = listPage([unsent('1'), unsent('2'), unsent('3', other)]);
    const store = await start();
    await store.openYourFollowUps();
    store.tickFollowUp('itm_00000001');
    store.tickFollowUp('itm_00000003');
    page = listPage([item('1'), unsent('2'), { ...item('3'), run_id: other }]);
    await store.sendTicked(true);
    expect(requests('send').map(request => ({ run_id: request.run_id, items: request.items }))).toEqual([
      { run_id: impactRun('done').run_id, items: [{ item_id: 'itm_00000001', include: true }] }, { run_id: other, items: [{ item_id: 'itm_00000003', include: true }] },
    ]);
    expect(new Set(requests('send').map(request => request.command_id)).size).toBe(2);
    expect(list(store)).toMatchObject({ busy: false, said: { words: 'Sent 2 to Fixture' }, ticks: {} });
    expect(list(store).items.map(entry => entry.state)).toEqual(['open', 'unsent', 'open']);
    expect(store.getState().route).toEqual({ page: 'follow-ups' });
    // Dismiss: the ticked rows, dismissed.
    store.tickFollowUp('itm_00000002');
    await store.sendTicked(false);
    expect(requests('send').at(-1)?.items).toEqual([{ item_id: 'itm_00000002', include: false }]);
    expect(said(store)).toEqual({ words: 'Dismissed 1' });
  });

  it('replays a send whose outcome is unknown with the same command, and gives any other choice a new one', async () => {
    page = listPage([unsent('1'), unsent('2')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    store.tickFollowUp('itm_00000002');
    sendFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    await store.sendTicked(true);
    expect(said(store)).toEqual({ words: 'This may not have been sent.', error: true });
    // Nothing holds quit or sign out: the list was read again, and shows what is so.
    expect(told()).toEqual({ unresolved: false });
    sendFailure = null;
    await store.sendTicked(true);
    const [first, again] = requests('send');
    expect(again).toEqual(first);
    // The rows are still not sent here, so a Dismiss of them is another choice: another command.
    await store.sendTicked(false);
    expect(requests('send')[2]?.command_id).not.toBe(first?.command_id);
  });

  it('says a send refused as a conflict changed meanwhile, keeping the account; lost access reads the account again', async () => {
    page = listPage([unsent('1')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    const statusReads = () => rpc.mock.calls.filter(([method]) => method === 'app.status').length;
    const before = statusReads();
    const reads = requests('items').length;
    sendFailure = { code: 'conflict', retryable: false };
    await store.sendTicked(true);
    expect(said(store)).toEqual({ words: 'That changed meanwhile.', error: true });
    expect(requests('items')).toHaveLength(reads + 1);
    await flush();
    expect(statusReads()).toBe(before);
    store.setBarText('launch plan');
    sendFailure = { code: 'stale_access_state', retryable: false };
    await store.sendTicked(true);
    await flush();
    expect(said(store)).toEqual({ words: 'That changed meanwhile, or your access did. Refresh and try again.', error: true });
    expect(store.getState().barText).toBe('launch plan');
    expect(statusReads()).toBe(before + 1);
  });

  it('changes an item on its page and stays there, saying what happened, and Back reads Home again', async () => {
    home = { ...emptyHome(), items: [item('1')] };
    const store = await start();
    readItem = item('1');
    await store.openFollowUp('itm_00000001', store.getState().home!.open!.items[0]!);
    readItem = { ...item('1'), state: 'done' };
    await store.setFollowUpState('done');
    expect(store.followUpShown()).toMatchObject({ kind: 'item', busy: false, loading: false, said: { words: 'Done', undo: true }, item: { state: 'done' } });
    readItem = item('1');
    await store.undoFollowUp();
    expect(requests('set_state').map(request => request.state)).toEqual(['done', 'open']);
    expect(said(store)).toEqual({ words: 'Reopened' });
    // Undo is offered once, after Mark done or a Dismiss of an open item.
    await store.undoFollowUp();
    expect(requests('set_state')).toHaveLength(2);
    const homeReads = () => operations().filter(operation => operation === 'home').length;
    const before = homeReads();
    store.closeFollowUp();
    await flush();
    expect(store.followUpShown()).toBeNull();
    expect(homeReads()).toBe(before + 1);
  });

  it('sends one follow-up from its page, opened by its id alone, and offers one dismissed before it was sent back to its owner', async () => {
    readItem = unsent('1');
    const store = await start();
    // A notification knows the item's id only: its page reads it.
    const opening = store.openFollowUp('itm_00000001');
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id: 'itm_00000001', item: null, loading: true });
    await opening;
    expect(store.followUpShown()).toMatchObject({ item: { state: 'unsent' } });
    readItem = { ...unsent('1'), state: 'not_relevant', sent_at: '2026-10-08T12:00:00.000Z', state_set_at: '2026-10-08T12:00:00.000Z', can: { set_state: true, assign: true } };
    await store.sendFollowUp(false);
    expect(requests('send')).toEqual([expect.objectContaining({ run_id: impactRun('done').run_id, items: [{ item_id: 'itm_00000001', include: false }] })]);
    // A dismissal before sending is never undone (F6).
    expect(said(store)).toEqual({ words: 'Dismissed' });
    readItem = { ...readItem, state: 'open', reached_owner: true };
    await store.setFollowUpState('open');
    expect(said(store)).toEqual({ words: 'Sent to Fixture' });
    expect(requests('set_state')).toEqual([expect.objectContaining({ item_id: 'itm_00000001', state: 'open' })]);
  });

  it('keeps a page whose change is on its way, and its next step, until the change is answered', async () => {
    readItem = item('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', item('1'));
    holdSetState = true;
    const marking = store.setFollowUpState('done');
    await flush();
    expect(store.followUpShown()).toMatchObject({ kind: 'item', busy: true });
    store.closeFollowUp();
    await store.setFollowUpState('not_relevant');
    expect(store.followUpShown()).toMatchObject({ kind: 'item', busy: true });
    expect(requests('set_state')).toHaveLength(1);
    answerSetState.shift()!();
    await marking;
    expect(store.followUpShown()).toMatchObject({ kind: 'item', busy: false, said: { words: 'Done', undo: true } });
  });

  it('reads the view under an item page again once a change was made on it, and forgets what that view said', async () => {
    page = listPage([unsent('1'), item('2')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    await store.sendTicked(false);
    expect(said(store)).toEqual({ words: 'Dismissed 1' });
    readItem = item('2');
    await store.openFollowUp('itm_00000002', item('2'));
    const reads = requests('items').length;
    await store.setFollowUpState('done');
    store.closeFollowUp();
    await flush();
    expect(requests('items')).toHaveLength(reads + 1);
    expect(store.followUpShown()).toMatchObject({ kind: 'list', said: null, stale: false });
    // Back from a page where nothing changed reads nothing again.
    await store.openFollowUp('itm_00000002', item('2'));
    store.closeFollowUp();
    await flush();
    expect(requests('items')).toHaveLength(reads + 1);
  });

  it('changes an owner at once, before Send or after, and settles an unknown outcome by reading the item', async () => {
    page = listPage([unsent('1')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    store.toggleOwnerPicker('itm_00000001');
    await flush();
    const picker = store.followUpShown()!.picker!;
    expect(picker).toMatchObject({ item_id: 'itm_00000001', loading: false, results: [RAFAEL] });
    readItem = { ...unsent('1'), owner: { ...rafael, match: 'picked' } };
    await store.pickFollowUpOwner(RAFAEL);
    expect(requests('assign')).toEqual([{ schema_version: 1, operation: 'assign', item_id: 'itm_00000001', owner_membership_id: RAFAEL.membership_id }]);
    expect(said(store)).toEqual({ words: 'Owner changed to Rafael Moreno' });
    // The row was read again in place: no read of the whole list.
    expect(list(store).items[0]?.owner.name).toBe('Rafael Moreno');
    expect(requests('items')).toHaveLength(1);
    // A reply that was lost: the item read again says whether it went.
    assignFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    for (const [owner, words] of [[unsent('1').owner, { words: 'It was not saved. Try again.', error: true }], [{ ...rafael, match: 'picked' as const }, { words: 'Owner changed to Rafael Moreno' }]] as const) {
      readItem = { ...unsent('1'), owner };
      store.toggleOwnerPicker('itm_00000001');
      await flush();
      await store.pickFollowUpOwner(RAFAEL);
      expect(said(store)).toEqual(words);
    }
    expect(told()).toEqual({ unresolved: false });
    // One that was refused says why, and reads nothing.
    assignFailure = { code: 'not_found', retryable: false };
    const items = requests('item').length;
    store.toggleOwnerPicker('itm_00000001');
    await flush();
    await store.pickFollowUpOwner(RAFAEL);
    expect(said(store)).toEqual({ words: 'This is no longer available to you.', error: true });
    expect(requests('item')).toHaveLength(items);
  });

  it('offers you first and never the owner now, unless the item only fell back to you', async () => {
    const store = await start();
    const me = { membership_id: 'member', display_name: 'Fixture' };
    const picker = { item_id: 'itm_00000001', query: '', results: [me, RAFAEL], loading: false };
    const names = (entry: OpenItemView, query = '') => store.ownerChoices({ ...picker, query }, entry, me).map(choice => `${choice.person.display_name}${choice.me ? ' (me)' : ''}`);
    expect(names(unsent('1'))).toEqual(['Fixture (me)', 'Rafael Moreno']);
    expect(names(unsent('1'), 'Raf')).toEqual(['Rafael Moreno']);
    expect(names({ ...unsent('1'), owner: { ...rafael, match: 'picked' } })).toEqual(['Fixture (me)']);
    // Pick owner: it fell back to you, its approver; picking yourself claims it.
    expect(names({ ...unsent('1'), owner: { membership_id: 'member', name: 'Fixture', active: true, match: 'approver' } })).toEqual(['Fixture (me)', 'Rafael Moreno']);
    expect(names({ ...item('1'), owner: { membership_id: 'member', name: 'Fixture', active: true, match: 'name' } })).toEqual(['Rafael Moreno']);
  });
});

describe('Check now', () => {
  const listPage = (): OpenItemsView => ({ items: [item('1')], next_cursor: null, stages: [],
    summary: { ...summary, open: 1, decisions: 1, by_decision: [{ record_sha256: record, unsent: 0, open: 1, landed: 0, unreadable: 0 }] } });
  /** A project's follow-ups, open over its page. */
  async function projectList() {
    granola = null;
    page = listPage();
    const store = await start();
    await store.openProject(project);
    await store.openFollowUps('project', project.project_id, project.name);
    return store;
  }
  const check = (store: Awaited<ReturnType<typeof start>>) => (store.followUpShown() as FollowUpList | null)?.check;

  it('says when nothing is open to check, and when the sweep could not be asked for', async () => {
    const store = await projectList();
    await store.checkNow();
    expect(requests('sweep')).toEqual([{ schema_version: 1, operation: 'sweep', scope: 'project', id: project.project_id }]);
    expect(check(store)).toBe('nothing');
    sweepAnswer = 'fails';
    await store.checkNow();
    expect(check(store)).toBe('failed');
  });

  it('checks until its sweep ends, then reads the list again', async () => {
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await projectList();
    const reads = requests('items').length;
    const checking = store.checkNow();
    await flush();
    expect(check(store)).toBe('checking');
    expect(requests('start')).toEqual([{ schema_version: 1, operation: 'start', run_id: sweepRun('pending').run_id }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(check(store)).toBe('checking');
    sweep = sweepRun('done');
    page = { ...listPage(), items: [item('1', 'landed')] };
    await vi.advanceTimersByTimeAsync(5_000);
    await checking;
    expect(check(store)).toBeNull();
    expect(requests('items')).toHaveLength(reads + 1);
    expect((store.followUpShown() as FollowUpList).items[0]?.check?.verdict).toBe('landed');
    expect(requests('sweep')).toHaveLength(1);
  });

  it('starts a queued impact check before its sweep, which waits its turn', async () => {
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await projectList();
    run = impactRun('pending');
    sweepStarts = 'busy';
    const checking = store.checkNow();
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
    expect(check(store)).toBeNull();
  });

  it('waits longer after each start that starts nothing, busy or failed', async () => {
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    sweepStarts = 'busy';
    const store = await projectList();
    const lists = () => requests('list').length;
    const before = lists();
    const checking = store.checkNow();
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
    expect(check(store)).toBeNull();
  });

  it('stops following its sweep once its list goes, leaving Home the only one to look', async () => {
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await projectList();
    void store.checkNow();
    await flush();
    expect(check(store)).toBe('checking');
    // Home: its read shows the sweep running, so Home looks again every 5 s; the list's loop reads nothing more.
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
    sweepAnswer = { run_id: sweepRun('pending').run_id };
    const store = await projectList();
    const checking = store.checkNow();
    await flush();
    expect(requests('start')).toHaveLength(1);
    sweep = sweepRun('failed');
    await vi.advanceTimersByTimeAsync(5_000);
    await checking;
    expect(check(store)).toBe('failed');
    sweepAnswer = { state: 'nothing_to_check' };
    await store.checkNow();
    expect(requests('sweep')).toHaveLength(2);
    expect(check(store)).toBe('nothing');
  });

  it('learns from a meeting\'s check whether Try again is yours, reading no runs list', async () => {
    granola = null;
    page = { ...listPage(), items: [], stages: [{ record_sha256: record, run_id: impactRun('done').run_id, state: 'done', error_code: null, mine: true }],
      summary: { ...summary, unsent: 2, decisions: 1, by_decision: [{ record_sha256: record, unsent: 2, open: 0, landed: 0, unreadable: 0 }] } };
    const store = await start();
    await store.openProject(project);
    const lists = requests('list').length;
    await store.openListItem({ ref: { kind: 'meeting', id: record }, title: 'Pilot planning', added_at: '2026-10-08T10:00:00.000Z', visibility: 'project', projects: [] });
    await flush();
    expect(store.getState().impactLine).toMatchObject({ scope: 'record', id: record, stage: { mine: true }, summary: { unsent: 2 } });
    expect(requests('list')).toHaveLength(lists);
    // The decision page counts the same meeting by its check, and finds its record from it.
    expect(store.lineRecord({ ...store.getState().impactLine!, scope: 'run', id: impactRun('done').run_id })).toBe(record);
  });
});
