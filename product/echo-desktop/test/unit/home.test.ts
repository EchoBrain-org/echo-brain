import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonMeetingReviewV2, PersonRunV1 } from '@echo-brain/organization-api';
import type { FollowUpList, ItemPage } from '../../src/renderer/store.js';
import { cover, show, uncover } from './harness.js';
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
/** Home's next read of its rows fails (and so nothing of it is read live). */
let failNextHome = false;
/** Home's next live read fails, its rows read. */
let failNextLive = false;
/** Live reads (Home's, a list's, an item's) wait while set, until the test answers them, each with what the test held when asked; so do Home's rows reads. */
let holdLive = false;
let answerLive: (() => void)[] = [];
let holdRows = false;
let answerRows: (() => void)[] = [];
/** A list's rows reads (items, rows only) wait while set, until the test answers them, each with what the page held when asked. */
let holdListRows = false;
let answerListRows: (() => void)[] = [];
/** Live items reads to fail next (not rows only, not counts only). */
let failLiveItems = 0;
/** The tools read waits while set, until the test answers it; or fails, while `failTools`. */
let holdTools = false;
let failTools = false;
let answerTools: (() => void)[] = [];
let sendFailure: { code: string; retryable: boolean; mutation_outcome?: 'unknown' } | null = null;
/** A send of this run fails as `sendFailure` says; any other run's goes. Null: every send fails so. */
let sendFailsFor: string | null = null;
/** Send replies wait while set, until the test answers them in order. */
let holdSend = false;
let answerSend: (() => void)[] = [];
/** Rows an items read pages at a time (null: all at once), and items reads to fail next. */
let pageSize: number | null = null;
let failItems = 0;
/** How a set_state fails, when a test says; a read of one item answers not_found while set. */
let setStateFailure: { code: string; retryable: boolean; mutation_outcome?: 'unknown' } | null = null;
let itemGone = false;
/** The signed-in account. */
let member = 'member';
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
  owner_set_at: null, owner_set_by: null, send_included: true,
  check: verdict === null ? null : { verdict, checked_at: '2026-10-08T12:00:00.000Z', checked_by: 'Mina Patel' }, can: { set_state: true, assign: true },
  reach: 'no_access',
});
/** An item of Ari's own check not sent yet: Ari ("member") approved it, so Ari may send it and pick its owner. */
const unsent = (id: string, run_id = impactRun('done').run_id): OpenItemView => ({
  ...item(id), run_id, approver: { membership_id: 'member', name: 'Fixture', active: true }, state: 'unsent', sent_at: null, state_set_at: null, state_set_by: null,
  send_included: null, waits_on: 'approver', can: { set_state: false, assign: true },
});
const sendRow = (): HomeView['send'][number] => ({ run_id: impactRun('done').run_id, decision, items: 2, kinds: ['ticket'], owners: ['Mina Patel'], finished_at: '2026-10-08T10:05:00.000Z' });
const emptyHome = (): HomeView => ({ send: [], items: [], landed: 0, waiting: 0, last_checked_at: null, sweep_due: false });
/** A row as a rows-only read answers it: nothing read live. */
const rowOnly = (entry: OpenItemView): OpenItemView => {
  const { current: _current, ...rest } = entry;
  return { ...rest, reach: 'not_read' };
};
/** Home as a rows-only read answers it: no row read live, and never a sweep due. */
const rowsOf = (view: HomeView): HomeView => ({ ...view, items: view.items.map(rowOnly), sweep_due: false });
const ticket = { kind: 'ticket' as const, tool_id: 'jira', label: 'ECHO-12 · Pilot launch', permalink: 'https://example.atlassian.net/browse/ECHO-12' };
/** An item ECHO opened for you just now: what it says now comes with it. */
const opened = (id: string, extra: Partial<OpenItemView> = {}): OpenItemView => ({ ...item(id), reach: 'opened', current: { source: ticket, says_now: `Says ${id}` }, ...extra });
const summary: OpenItemsView['summary'] = { unsent: 0, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 0, last_checked_at: null, by_decision: [] };
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
/**
 * The runs requests sent, but for reads of Home's rows (Home's own, each before its live read) and the change check's reads
 * of the open follow-ups you are involved in (freshness.test.ts).
 */
const notificationScan = (request: { operation?: string; scope?: string; read?: string; states?: readonly string[]; changed_since?: string }) => request.operation === 'items'
  && (request.scope === 'mine' || request.scope === 'involved') && request.read === 'rows' && (request.states?.join() === 'open' || request.changed_since !== undefined);
/** Every request but the change check's, which goes on at the server's pace whatever Home does (desktop refresh v1). */
const polls = () => rpc.mock.calls.filter(([method]) => method !== 'changes.read');
const homeCalls = () => rpc.mock.calls.filter(([method, params]) => method === 'runs' && !(params.request.operation === 'home' && params.request.read === 'rows') && !notificationScan(params.request));
/** Reads of what waits on you: each Home read starts with its rows. */
const rowsReads = () => rpc.mock.calls.filter(([method, params]) => method === 'runs' && params.request.operation === 'home' && params.request.read === 'rows').length;
const operations = () => homeCalls().map(([, params]) => params.request.operation);
/** The runs requests sent with one operation, as sent. */
const requests = (operation: string) => homeCalls().filter(([, params]) => params.request.operation === operation).map(([, params]) => params.request);
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
  failNextLive = false;
  holdLive = false;
  answerLive = [];
  holdRows = false;
  answerRows = [];
  holdListRows = false;
  answerListRows = [];
  holdTools = false;
  failTools = false;
  answerTools = [];
  failLiveItems = 0;
  sendFailure = null;
  sendFailsFor = null;
  holdSend = false;
  answerSend = [];
  pageSize = null;
  failItems = 0;
  setStateFailure = null;
  itemGone = false;
  member = 'member';
  sweepAnswer = { state: 'nothing_to_check' };
  sweep = null;
  sweepStarts = 'running';
  page = null;
  assignFailure = null;
  readItem = null;
  holdSetState = false;
  answerSetState = [];
  rpc.mockReset();
  rpc.mockImplementation(async (method: string, params: { project_id?: string; request?: { operation: string; run_id?: string; item_id?: string; state?: string; read?: 'rows' | 'counts';
    states?: readonly string[]; cursor?: string; scope?: string; id?: string } }) => {
    const ok = (value: unknown) => ({ ok: true, value });
    const unavailable = { ok: false, failure: { code: 'unavailable', retryable: true } };
    switch (method) {
      case 'app.status': return ok({ signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: member, display_name: 'Fixture', role: 'employee' } });
      case 'projects.list': return ok({ items: [], next_cursor: null });
      case 'projects.members': return ok({ items: [], next_cursor: null });
      case 'list.page': return ok({ items: [], next_cursor: null, meetings_held: false });
      case 'open.ref': return unavailable;
      // A project's tools line: it reads nothing.
      case 'projects.jiraRead': case 'projects.confluenceRead': return ok({ project_id: params.project_id, revision: null, mapping: null });
      case 'app.setUnresolved': case 'notice.show': case 'log.changes': return ok(null);
      // The change check: nothing moves unless a test says.
      case 'changes.read': return ok({ kind: 'echo-person-changes-v1', check_again_after_seconds: 60,
        areas: { projects: `sha256:${'0'.repeat(64)}`, follow_ups: `sha256:${'1'.repeat(64)}`, reviews: `sha256:${'2'.repeat(64)}` } });
      case 'people.directory': return ok({ items: [RAFAEL], next_cursor: null });
      case 'account.tools': {
        if (failTools) return { ok: false, failure: { code: 'transport_failed', retryable: true } };
        const tools = () => ok({ tools: granola === null ? [] : [{ tool_id: 'granola', status: granola }] });
        return holdTools ? new Promise(resolve => { answerTools.push(() => resolve(tools())); }) : tools();
      }
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
          // Its rows, answered with what `home` holds when the test lets them go; and its live read.
          if (params.request.read === 'rows') {
            if (failNextHome) { failNextHome = false; return unavailable; }
            return holdRows ? new Promise(resolve => { answerRows.push(() => resolve(ok(rowsOf(home)))); }) : ok(rowsOf(home));
          }
          if (failNextLive) { failNextLive = false; return unavailable; }
          if (holdLive) return new Promise(resolve => { answerLive.push(() => resolve(ok(home))); });
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
          if (setStateFailure) return { ok: false, failure: setStateFailure };
          const reply = ok({ state: params.request.state });
          return holdSetState ? new Promise(resolve => { answerSetState.push(() => resolve(reply)); }) : reply;
        }
        if (params.request?.operation === 'assign') {
          return assignFailure ? { ok: false, failure: assignFailure } : ok({ owner: { membership_id: RAFAEL.membership_id, name: RAFAEL.display_name, active: true } });
        }
        // One item: the one the test says, else the row a list read holds now; read rows only, nothing of it read live.
        if (params.request?.operation === 'item') {
          if (itemGone) return { ok: false, failure: { code: 'not_found', retryable: false } };
          if (failItems > 0) { failItems -= 1; return unavailable; }
          const found = readItem?.item_id === params.request.item_id ? readItem : page?.items.find(entry => entry.item_id === params.request?.item_id);
          const answer = found ? ok(params.request.read === 'rows' ? rowOnly(found) : found) : unavailable;
          return holdLive && params.request.read === undefined ? new Promise(resolve => { answerLive.push(() => resolve(answer)); }) : answer;
        }
        if (params.request?.operation === 'items') {
          // Notification discovery is independent of the foreground list's injected failures.
          if (notificationScan(params.request)) return itemsAnswer(params.request);
          if (failItems > 0) { failItems -= 1; return unavailable; }
          if (failLiveItems > 0 && params.request.read === undefined) { failLiveItems -= 1; return unavailable; }
          if (params.request.read === 'rows' && holdListRows) {
            const answer = itemsAnswer(params.request);
            return new Promise(resolve => { answerListRows.push(() => resolve(answer)); });
          }
          // A live read held answers what the page held when it was asked.
          if (params.request.read === undefined && holdLive) {
            const answer = itemsAnswer(params.request);
            return new Promise(resolve => { answerLive.push(() => resolve(answer)); });
          }
          return itemsAnswer(params.request);
        }
        if (params.request?.operation === 'send') {
          const reply = sendFailure && (sendFailsFor === null || sendFailsFor === params.request.run_id) ? { ok: false, failure: sendFailure } : ok({ sent: 1, not_relevant: 0 });
          return holdSend ? new Promise(resolve => { answerSend.push(() => resolve(reply)); }) : reply;
        }
    }
    throw new Error(`Unexpected request: ${method} ${params.request?.operation ?? ''}`);
  });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * An items read, as the test's page holds it: counts only, or the items in the states asked for, a page at a time. A check's
 * rows (scope run) are its rows, with the one item read now (`readItem`) in place of its row, and without it once it is gone.
 * Rows only: nothing read live, so no row says what it says now.
 */
function itemsAnswer(request: { states?: readonly string[]; cursor?: string; read?: 'rows' | 'counts'; scope?: string; id?: string }) {
  const answer: OpenItemsView = page ?? { items: [{ ...item('5'), state: 'unsent', sent_at: null, state_set_at: null, waits_on: 'approver' }], next_cursor: null, stages: [],
    summary: { unsent: 1, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 1, last_checked_at: null, by_decision: [] } };
  const { states, cursor, read, scope, id } = request;
  const scoped = scope !== 'run' ? answer.items
    : [...answer.items.filter(entry => entry.item_id !== readItem?.item_id), ...(readItem ? [readItem] : [])]
      .filter(entry => entry.run_id === id && !(itemGone && entry.item_id === readItem?.item_id));
  const listed = (read === 'counts' ? [] : states ? scoped.filter(entry => states.includes(entry.state)) : scoped)
    .map(entry => (read === 'rows' ? (({ current: _current, ...rest }) => ({ ...rest, reach: 'not_read' as const }))(entry) : entry));
  const from = cursor === undefined ? 0 : Number(cursor.slice(1));
  const size = pageSize ?? Math.max(listed.length, 1);
  return { ok: true, value: { ...answer, items: listed.slice(from, from + size), next_cursor: from + size < listed.length ? `c${from + size}` : null } };
}

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
    expect(store.getState().home).toMatchObject({ meetings: false, loading: false, open: { waiting: 2 } });
    expect(store.homeRows()).toMatchObject([{ kind: 'update', item: { item_id: item('1').item_id } }]);
    expect(store.needsCount()).toBe(1);
    expect(rpc.mock.calls.some(([method]) => method === 'tools.meetings')).toBe(false);
    // The row's copy shows at once, then the item is read again.
    readItem = { ...item('1'), expected: 'launch this week' };
    const row = store.homeRows()[0]!;
    const opening = store.openFollowUp(item('1').item_id, 'item' in row ? row.item : null);
    expect(store.followUpShown()).toMatchObject({ kind: 'item', loading: true, item: { expected: 'launch next week' } });
    await opening;
    expect(store.followUpShown()).toMatchObject({ kind: 'item', loading: false, item: { expected: 'launch this week' } });
    // What Home read live of it came with it: it is read again rows only.
    expect(requests('item')).toEqual([{ schema_version: 1, operation: 'item', item_id: item('1').item_id, read: 'rows' }]);
    expect(store.getState().route).toEqual({ page: 'home' });
  });

  it('keeps open items when Granola becomes unavailable and stops reading meeting reviews', async () => {
    home = { ...emptyHome(), items: [item('1')] };
    const store = await start();
    expect(store.homeRows().map(row => row.kind)).toEqual(['approve', 'update']);
    granola = 'unavailable';
    rpc.mockClear();
    await store.loadHome();
    expect(store.homeRows().map(row => row.kind)).toEqual(['update']);
    expect(rpc.mock.calls.some(([method]) => method === 'tools.meetings')).toBe(false);
    expect(operations()).toContain('home');
  });

  it('merges Home loads asked for while one is on its way: one set of reads, then at most one more', async () => {
    const store = await start();
    rpc.mockClear();
    holdRows = true;
    const first = store.loadHome();
    await flush();
    // The window comes forward (resume and shown) while that load waits: both join it.
    const joined = [store.loadHome(), store.loadHome()];
    await flush();
    const loads = () => rpc.mock.calls.filter(([method]) => method === 'account.tools').length;
    expect(loads()).toBe(1);
    holdRows = false;
    answerRows.shift()!();
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
    expect(store.homeRows().map(row => row.kind)).toEqual(['review', 'update']);
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
    cover(store);
    expect(store.pageCovered()).toBe(true);
    uncover(store);
    await flush();
    await store.openDecision(approval);
    cover(store);
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
    expect(store.homeRows()).toMatchObject([{ kind: 'checking', review: { status: 'publishing' } }]);
    expect(store.needsCount()).toBe(0);
    review = { ...review, status: 'approved' };
    run = impactRun('pending');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(operations()).toContain('start');
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.homeRows()).toMatchObject([{ kind: 'send', send: { run_id: run.run_id } }]);
    expect(store.needsCount()).toBe(1);
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.mock.calls).toHaveLength(requests);
  });

  it('resumes a check after spending a polling interval in another app', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    cover(store);
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.mock.calls).toHaveLength(requests);
    uncover(store);
    await flush();
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.homeRows()).toMatchObject([{ kind: 'send' }]);
  });

  it('refreshes an open decision when its check finishes while the app is hidden', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    await store.openDecision(approval, run);
    cover(store);
    await vi.advanceTimersByTimeAsync(5_000);
    run = impactRun('done');
    uncover(store);
    await flush();
    expect(store.getState().decision?.run?.state).toBe('done');
    // Its follow-ups, counted by its check for the page's line; its card is never asked for.
    expect(operations()).not.toContain('view');
    expect(store.getState().impactLine).toMatchObject({ scope: 'run', id: run.run_id, loading: false, summary: { unsent: 1 } });
    expect(requests('items').at(-1)).toEqual({ schema_version: 1, operation: 'items', scope: 'run', id: run.run_id, read: 'counts' });
  });

  it('keeps polling, more slowly, after a temporary runs-list failure', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    failNextList = true;
    await vi.advanceTimersByTimeAsync(5_000);
    // The failed read kept the run it had: still checking.
    expect(store.homeRows()).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.homeRows()).toMatchObject([{ kind: 'checking' }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.homeRows()).toMatchObject([{ kind: 'send' }]);
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
    expect(store.homeRows()).toMatchObject([{ kind: 'send' }]);
  });

  it('reads what a finished check found again, more slowly, until that read succeeds', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    const homeReads = rowsReads;
    expect(homeReads()).toBe(1);
    // The check ends, and the read of what it found fails on that poll.
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    failNextHome = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(homeReads()).toBe(2);
    expect(store.homeRows()).toEqual([]);
    // Home keeps looking, from 10 s, until the read succeeds; then it stops.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(homeReads()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(homeReads()).toBe(3);
    expect(store.homeRows()).toMatchObject([{ kind: 'send' }]);
    const requests = polls().length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(polls()).toHaveLength(requests);
  });

  it('reads what waits on you again on the next poll after that read failed', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    failNextHome = true;
    const store = await start();
    expect(store.getState().home?.open).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rowsReads()).toBe(2);
    expect(store.getState().home?.open).toEqual(emptyHome());
  });

  it('never polls an Authority whose runs are unavailable when nothing is in flight', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    failLists = true;
    const store = await start();
    expect(store.getState().home?.failure).toBeUndefined();
    const requests = polls().length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(polls()).toHaveLength(requests);
  });

  it('keeps the rows a failed home read had, and shows no error for it', async () => {
    home = { ...emptyHome(), items: [item('1')], waiting: 1 };
    const store = await start();
    expect(store.homeRows().map(row => row.kind)).toEqual(['approve', 'update']);
    failNextHome = true;
    await store.loadHome();
    expect(store.homeRows().map(row => row.kind)).toEqual(['approve', 'update']);
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
    holdRows = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(answerRows).toHaveLength(1);
    // Meanwhile Home is read again, and that read of what the check found fails.
    holdRows = false;
    failNextHome = true;
    await store.loadHome();
    expect(store.homeRows()).toEqual([]);
    // The slow read answers now. It is no longer Home's read: it shows nothing, and settles nothing Home still owes.
    answerRows.shift()!();
    await flush();
    expect(store.homeRows()).toEqual([]);
    // So Home keeps looking, and its next read brings the Send row.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.homeRows()).toMatchObject([{ kind: 'send', send: { run_id: run.run_id } }]);
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
    expect(store.homeRows()).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
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
    if (owed) expect(store.homeRows()).toHaveLength(0);
    cover(store);
    await vi.advanceTimersByTimeAsync(60_000);
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    uncover(store);
    await flush();
    expect(store.getState().home?.failure).toBeUndefined();
    expect(store.homeRows()).toMatchObject([{ kind: 'send', send: { run_id: run.run_id } }]);
  });

  it.each([false, true])('preserves and retries a failed resume with an open decision: %s', async (openCard) => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    if (openCard) await store.openDecision(approval, run);
    cover(store);
    failNextList = true;
    uncover(store);
    await flush();
    expect(store.homeRows()).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
    expect(store.getState().home?.failure).toBeUndefined();
    if (openCard) expect(store.getState().decision?.run?.state).toBe('running');
    // A second focus change must not strand the retry after stopping its timer.
    cover(store);
    failNextList = true;
    uncover(store);
    await flush();
    run = impactRun('done');
    home = { ...emptyHome(), send: [sendRow()] };
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.getState().home?.failure).toBeUndefined();
    expect(store.homeRows()).toMatchObject([{ kind: 'send', send: { run_id: run.run_id } }]);
    if (openCard) {
      expect(store.getState().decision?.run?.state).toBe('done');
      expect(store.getState().impactLine).toMatchObject({ scope: 'run', id: run.run_id });
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
    expect(store.homeRows()).toEqual([]);
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
    expect(store.homeRows().map(row => row.kind)).toEqual(['update']);
    expect(requests('sweep')).toHaveLength(1);
    // Done before the next look.
    sweep = sweepRun('done');
    home = { ...emptyHome(), items: [item('1', 'changed')], landed: 1, last_checked_at: '2026-10-08T12:05:00.000Z' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.homeRows().map(row => row.kind)).toEqual(['review']);
    expect(store.getState().home?.open).toMatchObject({ landed: 1, last_checked_at: '2026-10-08T12:05:00.000Z' });
    // Then Home stops looking.
    const calls = polls().length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(polls()).toHaveLength(calls);
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
    expect(store.homeRows().map(row => row.kind)).toEqual(['review']);
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
    const calls = polls().length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(polls()).toHaveLength(calls);
    expect(requests('sweep')).toHaveLength(1);
  });

  it.each(['fails', 'failed'] as const)('shows nothing for a sweep that %s, and soon stops looking', async how => {
    granola = null;
    home = { ...emptyHome(), sweep_due: true };
    sweepAnswer = how === 'fails' ? 'fails' : { run_id: sweepRun('pending').run_id };
    sweepStarts = 'failed';
    const store = await start();
    expect(requests('sweep')).toHaveLength(1);
    expect(store.getState().home).toMatchObject({ loading: false, failure: undefined });
    expect(store.homeRows()).toEqual([]);
    // A sweep that failed at once is seen ended on the next look at most; then nothing more is read.
    await vi.advanceTimersByTimeAsync(5_000);
    const calls = polls().length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(polls()).toHaveLength(calls);
    expect(store.homeRows()).toEqual([]);
  });
});


describe('Follow-up lists and item pages', () => {
  /** A page of follow-ups, counted by status. */
  const listPage = (items: OpenItemView[]): OpenItemsView => ({ items, next_cursor: null, stages: [], summary: {
    ...summary, decisions: 1, unsent: items.filter(entry => entry.state === 'unsent').length, open: items.filter(entry => entry.state === 'open').length,
    done: items.filter(entry => entry.state === 'done').length, not_relevant: items.filter(entry => entry.state === 'not_relevant').length } });
  const list = (store: Awaited<ReturnType<typeof start>>) => store.followUpShown() as FollowUpList;
  const said = (store: Awaited<ReturnType<typeof start>>) => (store.followUpShown() as FollowUpList | ItemPage | null)?.said;
  /** What main's quit guard was told last. */
  const told = () => rpc.mock.calls.filter(([method]) => method === 'app.setUnresolved').map(([, params]) => params).at(-1);
  const other = 'run_00000000-0000-4000-8000-000000000021';
  const rafael = { membership_id: RAFAEL.membership_id, name: RAFAEL.display_name, active: true };

  beforeEach(() => { granola = null; });

  it('ticks every Not sent row you may send on a meeting\'s first read, and none on the Follow-ups page', async () => {
    page = listPage([unsent('1'), unsent('2'), { ...unsent('3'), can: { set_state: false, assign: false } }, item('4')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    expect(list(store)).toMatchObject({ kind: 'list', scope: 'record', id: record, title: 'Pilot planning', loading: false });
    expect(list(store).ticks).toEqual({ itm_00000001: true, itm_00000002: true });
    // Every group of a meeting's list shows: one read of them all, rows only, then one live read of them all.
    const all = ['unsent', 'open', 'done', 'not_relevant'];
    expect(requests('items')).toEqual([{ schema_version: 1, operation: 'items', scope: 'record', id: record, states: all, read: 'rows' },
      { schema_version: 1, operation: 'items', scope: 'record', id: record, states: all }]);
    // The Follow-ups page: yours, its closed groups closed, nothing ticked.
    await store.openYourFollowUps();
    expect(store.getState().route).toEqual({ page: 'follow-ups' });
    expect(list(store)).toMatchObject({ scope: 'involved', ticks: {} });
    expect(requests('items').slice(-2)).toEqual([{ schema_version: 1, operation: 'items', scope: 'involved', states: ['unsent', 'open'], read: 'rows' },
      { schema_version: 1, operation: 'items', scope: 'involved', states: ['unsent', 'open'] }]);
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
    expect(said(store)).toEqual({ words: 'Dismissed' });
  });

  it('replays a send whose outcome is unknown with the same command, and gives any other choice a new one', async () => {
    page = listPage([unsent('1'), unsent('2')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    store.tickFollowUp('itm_00000002');
    sendFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    await store.sendTicked(true);
    // Its row, read again, is still not sent: it did not go, and Send again replays it.
    expect(said(store)).toEqual({ words: 'Not sent. Try again.', error: true });
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
    // The list read again rows only, as far as it showed: a change reads nothing live.
    expect(requests('items').slice(reads).map(request => request.read)).toEqual(['rows']);
    expect(requests('item')).toEqual([]);
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
    const before = rowsReads();
    store.closeFollowUp();
    await flush();
    expect(store.followUpShown()).toBeNull();
    expect(rowsReads()).toBe(before + 1);
  });

  it('sends one follow-up from its page, opened by its id alone, and offers one dismissed before it was sent back to its owner', async () => {
    readItem = unsent('1');
    const store = await start();
    // A notification knows the item's id only: its page reads it.
    const opening = store.openFollowUp('itm_00000001');
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id: 'itm_00000001', item: null, loading: true });
    await opening;
    expect(store.followUpShown()).toMatchObject({ item: { state: 'unsent' } });
    readItem = { ...unsent('1'), state: 'not_relevant', sent_at: '2026-10-08T12:00:00.000Z', state_set_at: '2026-10-08T12:00:00.000Z', send_included: false, can: { set_state: true, assign: true } };
    await store.sendFollowUp(false);
    expect(requests('send')).toEqual([expect.objectContaining({ run_id: impactRun('done').run_id, items: [{ item_id: 'itm_00000001', include: false }] })]);
    // A dismissal before sending is never undone (F6).
    expect(said(store)).toEqual({ words: 'Dismissed' });
    readItem = { ...readItem, state: 'open', send_included: false };
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
    expect(said(store)).toEqual({ words: 'Dismissed' });
    readItem = item('2');
    await store.openFollowUp('itm_00000002', item('2'));
    const reads = requests('items').length;
    await store.setFollowUpState('done');
    // The item read again on its own, rows only.
    expect(requests('item').at(-1)).toEqual({ schema_version: 1, operation: 'item', item_id: 'itm_00000002', read: 'rows' });
    store.closeFollowUp();
    await flush();
    // Back on the list, it is read again as far as it showed, rows only.
    expect(requests('items').slice(reads).map(request => `${request.scope} ${request.read === 'rows' ? 'rows' : 'live'}`)).toEqual(['record rows']);
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
    const picker = (store.followUpShown() as FollowUpList).picker!;
    expect(picker).toMatchObject({ item_id: 'itm_00000001', loading: false, results: [RAFAEL] });
    const opened = requests('items').length;
    page = listPage([{ ...unsent('1'), owner: { ...rafael, match: 'picked' } }]);
    await store.pickFollowUpOwner(RAFAEL);
    expect(requests('assign')).toEqual([{ schema_version: 1, operation: 'assign', item_id: 'itm_00000001', owner_membership_id: RAFAEL.membership_id }]);
    // By first name, as the chips say.
    expect(said(store)).toEqual({ words: 'Owner changed to Rafael' });
    // The row read again on its own, rows only, and the list's counts: it moves in place, and nothing is read live.
    expect(list(store).items[0]?.owner.name).toBe('Rafael Moreno');
    expect(requests('items').slice(opened).map(request => request.read)).toEqual(['counts']);
    expect(requests('item')).toEqual([{ schema_version: 1, operation: 'item', item_id: 'itm_00000001', read: 'rows' }]);
    // A reply that was lost: the row read again says whether it went.
    assignFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    for (const [owner, words] of [[unsent('1').owner, { words: 'It was not saved. Try again.', error: true }], [{ ...rafael, match: 'picked' as const }, { words: 'Owner changed to Rafael' }]] as const) {
      page = listPage([{ ...unsent('1'), owner }]);
      store.toggleOwnerPicker('itm_00000001');
      await flush();
      await store.pickFollowUpOwner(RAFAEL);
      expect(said(store)).toEqual(words);
    }
    expect(told()).toEqual({ unresolved: false });
    // One that was refused says why, and its row is read again to show what is so now.
    assignFailure = { code: 'not_found', retryable: false };
    const reads = rpc.mock.calls.filter(([method]) => method === 'runs').length;
    store.toggleOwnerPicker('itm_00000001');
    await flush();
    await store.pickFollowUpOwner(RAFAEL);
    expect(said(store)).toEqual({ words: 'This is no longer available to you.', error: true });
    expect(requests('assign')).toHaveLength(4);
    expect(rpc.mock.calls.filter(([method]) => method === 'runs').slice(reads).map(([, params]) => params.request.operation)).toEqual(['assign', 'item', 'items']);
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

describe('Follow-up lists: current work first, results in place', () => {
  const listPage = (items: OpenItemView[]): OpenItemsView => ({ items, next_cursor: null,
    stages: [{ record_sha256: record, run_id: impactRun('done').run_id, state: 'done', error_code: null, mine: true }], summary: {
      ...summary, decisions: 1, unsent: items.filter(entry => entry.state === 'unsent').length, open: items.filter(entry => entry.state === 'open').length,
      done: items.filter(entry => entry.state === 'done').length, not_relevant: items.filter(entry => entry.state === 'not_relevant').length } });
  const list = (store: Awaited<ReturnType<typeof start>>) => store.followUpShown() as FollowUpList;
  const said = (store: Awaited<ReturnType<typeof start>>) => (store.followUpShown() as FollowUpList | ItemPage | null)?.said;
  const ids = (store: Awaited<ReturnType<typeof start>>) => list(store).items.map(entry => entry.item_id.slice(-1));
  /** The list's reads: rows only, or live (" live"), by states and cursor; never a line's counts or a check's rows. */
  const reads = () => requests('items').filter(request => request.read !== 'counts' && request.scope !== 'run')
    .map(request => `${(request.states as string[]).join('+')}${request.cursor ? ` ${request.cursor}` : ''}${request.read === 'rows' ? '' : ' live'}`);
  const done = (id: string): OpenItemView => ({ ...item(id), state: 'done', state_set_at: '2026-10-08T12:00:00.000Z' });
  const other = 'run_00000000-0000-4000-8000-000000000021';

  beforeEach(() => { granola = null; });

  it('reads current work first, each closed group once it opens, each with its own More, and Try again repeats the read that failed', async () => {
    // Three closed rows older than all current work: a read of every status would show only them on its first page.
    page = listPage([done('1'), done('2'), done('3'), unsent('4'), item('5'), item('6')]);
    pageSize = 2;
    const store = await start();
    await store.openFollowUps('project', project.project_id, project.name);
    expect(ids(store)).toEqual(['4', '5']);
    expect(list(store)).toMatchObject({ summary: { unsent: 1, open: 2, done: 3 } });
    expect(store.moreAfter(list(store))).toEqual(['active']);
    await store.moreFollowUps('active');
    expect(ids(store)).toEqual(['4', '5', '6']);
    expect(store.moreAfter(list(store))).toEqual([]);
    // Done opened: its first page, then its own More.
    store.toggleClosedGroup('done');
    await flush();
    expect(ids(store)).toEqual(['4', '5', '6', '1', '2']);
    expect(store.moreAfter(list(store))).toEqual(['done']);
    failItems = 1;
    await store.moreFollowUps('done');
    expect(list(store).failed).toMatchObject({ read: 'done', failure: { code: 'unavailable' } });
    expect(ids(store)).toEqual(['4', '5', '6', '1', '2']);
    await store.retryFollowUps();
    expect(ids(store)).toEqual(['4', '5', '6', '1', '2', '3']);
    expect(store.moreAfter(list(store))).toEqual([]);
    expect(list(store).failed).toBeUndefined();
    // Each page read rows only, then that page read live: the failed page, once read, too.
    expect(reads()).toEqual(['unsent+open', 'unsent+open live', 'unsent+open c2', 'unsent+open c2 live', 'done', 'done live', 'done c2', 'done c2', 'done c2 live']);
  });

  it('tries the first read again when it failed, and reads again as far as each part showed', async () => {
    page = listPage([done('1'), done('2'), unsent('3'), item('4'), item('5')]);
    pageSize = 2;
    failItems = 1;
    const store = await start();
    await store.openFollowUps('project', project.project_id, project.name);
    expect(list(store)).toMatchObject({ failed: { read: 'first' }, items: [] });
    await store.retryFollowUps();
    await store.moreFollowUps('active');
    store.toggleClosedGroup('done');
    await flush();
    expect(ids(store)).toEqual(['3', '4', '5', '1', '2']);
    // A change made on a row's page: Back reads each part again, as far as it showed.
    readItem = item('4');
    await store.openFollowUp('itm_00000004', item('4'));
    await store.setFollowUpState('done');
    const before = reads().length;
    store.closeFollowUp();
    await flush();
    expect(reads().slice(before)).toEqual(['unsent+open', 'unsent+open c2', 'done']);
    expect(ids(store)).toEqual(['3', '4', '5', '1', '2']);
    // A read again that fails keeps what showed, and Try again reads it again.
    await store.openFollowUp('itm_00000004', item('4'));
    await store.setFollowUpState('done');
    failItems = 1;
    store.closeFollowUp();
    await flush();
    expect(list(store).failed).toMatchObject({ read: 'again' });
    expect(ids(store)).toEqual(['3', '4', '5', '1', '2']);
  });

  it('settles a send whose outcome was unknown by the rows read again: one that went says so and replays no more', async () => {
    page = listPage([unsent('1'), unsent('2')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    store.tickFollowUp('itm_00000002');
    sendFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    // It went: the row, read again in place, is open.
    page = listPage([item('1'), unsent('2')]);
    await store.sendTicked(true);
    expect(said(store)).toEqual({ words: 'Sent to Fixture' });
    expect(list(store).sends).toEqual({});
    expect(list(store).items.find(entry => entry.item_id === 'itm_00000001')?.state).toBe('open');
    // Read again in place: the list's rows, rows only, which settle it; no item read on its own, nothing read live.
    expect(requests('item')).toEqual([]);
    expect(requests('items').at(-1)?.read).toBe('rows');
  });

  it('stops sending once the list closes, and says what went and what did not when only some did', async () => {
    page = listPage([unsent('1'), unsent('2', other)]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    // The second check's send fails: the first went.
    sendFailure = { code: 'unavailable', retryable: true };
    sendFailsFor = other;
    page = listPage([item('1'), unsent('2', other)]);
    await store.sendTicked(true);
    expect(said(store)).toEqual({ words: 'Sent to Fixture · 1 not sent, try again', error: true });
    expect(list(store).ticks).toEqual({ itm_00000002: true });
    // Closed while its first send is on its way: nothing more is sent.
    sendFailure = null;
    page = listPage([unsent('1'), unsent('2', other)]);
    await store.openFollowUps('record', 'sha256:' + '2'.repeat(64), 'Kickoff review');
    const sends = requests('send').length;
    holdSend = true;
    const sending = store.sendTicked(true);
    await flush();
    store.goHome();
    answerSend.shift()!();
    await sending;
    expect(requests('send')).toHaveLength(sends + 1);
  });

  it('stops sending once the account changes', async () => {
    page = listPage([unsent('1'), unsent('2', other)]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    holdSend = true;
    const sending = store.sendTicked(true);
    await flush();
    member = 'someone-else';
    await store.refreshStatus();
    answerSend.shift()!();
    await sending;
    expect(requests('send')).toHaveLength(1);
  });

  it('goes back to a meeting\'s list already open under its item page, keeping its ticks, instead of opening it again', async () => {
    page = listPage([unsent('1'), unsent('2')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    store.tickFollowUp('itm_00000002');
    readItem = unsent('1');
    await store.openFollowUp('itm_00000001', unsent('1'));
    expect(list(store)).toBeTruthy();
    const before = requests('items').length;
    await store.openFollowUps('record', record, 'Pilot planning');
    expect(store.getState().followUps?.views).toHaveLength(1);
    expect(list(store)).toMatchObject({ kind: 'list', opened: 'itm_00000001', ticks: { itm_00000001: true } });
    expect(requests('items')).toHaveLength(before);
  });

  it('opens a meeting\'s decision over its list, and its follow-ups line goes back to the list', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    page = listPage([unsent('1')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    await store.openListDecision();
    expect(store.followUpShown()).toMatchObject({ kind: 'decision' });
    expect(store.getState().decision).toMatchObject({ approval_id: approval, loading: false, run: { state: 'done' } });
    // Its follow-ups line counts them by its check, as the decision's own page does.
    expect(store.getState().impactLine).toMatchObject({ scope: 'run', id: impactRun('done').run_id, summary: { unsent: 1 } });
    expect(operations()).not.toContain('view');
    // Its follow-ups line: Back to the list, not a list of its own.
    await store.openFollowUps('record', record, 'Pilot planning');
    expect(store.getState().followUps?.views.map(view => view.kind)).toEqual(['list']);
    expect(store.getState().decision).toBeNull();
    // Opened from the decision's own page, its list's "Approved" goes back to that page.
    run = impactRun('done');
    await store.openDecision(approval, run);
    await store.openFollowUps('record', record, 'Pilot planning');
    await store.openListDecision();
    expect(store.followUpShown()).toBeNull();
    expect(store.getState().route).toEqual({ page: 'decision' });
  });

  it('settles an unknown send or change of state on an item page by reading it again', async () => {
    readItem = unsent('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', unsent('1'));
    sendFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    // Not landed: it may not have been sent, and Send again replays it.
    await store.sendFollowUp(true);
    expect(said(store)).toEqual({ words: 'Not sent. Try again.', error: true });
    const page = () => store.followUpShown() as ItemPage;
    expect(page().send).not.toBeNull();
    // Landed: said as sent, and nothing is kept to replay.
    readItem = { ...item('1'), approver: unsent('1').approver };
    await store.sendFollowUp(true);
    expect(requests('send')[1]?.command_id).toBe(requests('send')[0]?.command_id);
    expect(said(store)).toEqual({ words: 'Sent to Fixture' });
    expect(page().send).toBeNull();
    setStateFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    await store.setFollowUpState('done');
    expect(said(store)).toEqual({ words: 'It was not saved. Try again.', error: true });
    readItem = { ...readItem, state: 'done' };
    await store.setFollowUpState('done');
    expect(said(store)).toEqual({ words: 'Done', undo: true });
  });

  it('offers Try again on an item page whose first read failed', async () => {
    const store = await start();
    await store.openFollowUp('itm_00000001');
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item: null, failure: { code: 'unavailable' } });
    readItem = item('1');
    store.retryFollowUp();
    await flush();
    expect(store.followUpShown()).toMatchObject({ item: { item_id: 'itm_00000001' } });
  });

  it('says so when you gave an item away and no longer see it: the page offers Back, the list\'s row goes with a word in its foot', async () => {
    readItem = item('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', item('1'));
    store.toggleOwnerPicker('itm_00000001');
    await flush();
    itemGone = true;
    await store.pickFollowUpOwner(RAFAEL);
    expect(store.followUpShown()).toMatchObject({ kind: 'item', gone: true, said: { words: 'Owner changed to Rafael' } });
    store.closeFollowUp();
    itemGone = false;
    page = listPage([item('2'), item('3')]);
    await store.openFollowUps('record', record, 'Pilot planning');
    store.toggleOwnerPicker('itm_00000002');
    await flush();
    // Given away, it leaves what you see: read again, it is not found, and its row goes.
    page = listPage([item('3')]);
    itemGone = true;
    await store.pickFollowUpOwner(RAFAEL);
    expect(said(store)).toEqual({ words: 'Owner changed to Rafael · You no longer see it' });
    expect(ids(store)).toEqual(['3']);
    expect(requests('items').at(-1)).toMatchObject({ scope: 'record', id: record, read: 'counts' });
  });

  it('clears what Check now said when the list is read again, and keeps a project\'s line through a failed read', async () => {
    page = listPage([item('1')]);
    const store = await start();
    await store.openProject(project);
    expect(store.getState().projectLine).toMatchObject({ summary: { open: 1 } });
    await store.openFollowUps('project', project.project_id, project.name);
    await store.checkNow();
    expect(list(store).check).toBe('nothing');
    readItem = item('1');
    await store.openFollowUp('itm_00000001', item('1'));
    await store.setFollowUpState('done');
    store.closeFollowUp();
    await flush();
    expect(list(store).check).toBeNull();
    // Back on the project, its line is read again; that read fails, and the line keeps what it said.
    store.closeFollowUp();
    failItems = 1;
    await flush();
    expect(store.getState().projectLine).toMatchObject({ loading: false, summary: { open: 1 } });
  });

  it('counts a meeting\'s follow-ups by its record again once its decision, opened from its list over the meeting, closes', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    page = listPage([unsent('1')]);
    const store = await start();
    await store.openProject(project);
    await store.openListItem({ ref: { kind: 'meeting', id: record }, title: 'Pilot planning', added_at: '2026-10-08T10:00:00.000Z', visibility: 'project', projects: [] });
    await flush();
    await store.openFollowUps('record', record, 'Pilot planning');
    await store.openListDecision();
    expect(store.getState().impactLine).toMatchObject({ scope: 'run', id: impactRun('done').run_id });
    // Back to the list, then to the meeting: its line is the meeting's again, by its record, with its check.
    store.closeFollowUp();
    await flush();
    store.closeFollowUp();
    await flush();
    expect(store.followUpShown()).toBeNull();
    expect(store.getState().reader?.ref).toEqual({ kind: 'meeting', id: record });
    expect(store.getState().impactLine).toMatchObject({ scope: 'record', id: record, loading: false, summary: { unsent: 1 }, stage: { mine: true } });
  });

  it('settles a Dismiss whose outcome was unknown on a list whose Dismissed group is closed, reading on its own each row it no longer shows', async () => {
    page = listPage([unsent('1'), unsent('2')]);
    const store = await start();
    await store.openFollowUps('project', project.project_id, project.name);
    store.tickFollowUp('itm_00000001');
    sendFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    // It went: the row left current work for Dismissed, closed and never read.
    page = listPage([{ ...unsent('1'), state: 'not_relevant', send_included: false, sent_at: '2026-10-08T12:00:00.000Z', state_set_at: '2026-10-08T12:00:00.000Z' },
      unsent('2')]);
    await store.sendTicked(false);
    expect(said(store)).toEqual({ words: 'Dismissed' });
    expect(list(store).sends).toEqual({});
    expect(ids(store)).toEqual(['2']);
    expect(requests('item')).toEqual([{ schema_version: 1, operation: 'item', item_id: 'itm_00000001', read: 'rows' }]);
  });

  it('keeps a row on your list once you hand on an item you only owned (you last handed it on), as a meeting\'s list does; drops one someone else handed on meanwhile', async () => {
    const rafael = { membership_id: RAFAEL.membership_id, name: RAFAEL.display_name, active: true };
    const me = { membership_id: 'member', name: 'Fixture', active: true };
    const yours = (id: string): OpenItemView => ({ ...item(id), owner: { ...me, match: 'jira_account' } });
    const given = { ...yours('1'), owner: { ...rafael, match: 'reassigned' as const }, owner_set_at: '2026-10-08T13:00:00.000Z', owner_set_by: me };
    page = listPage([yours('1'), yours('2')]);
    const store = await start();
    await store.openYourFollowUps();
    for (const scope of ['involved', 'record'] as const) {
      if (scope === 'record') {
        page = listPage([yours('1'), yours('2')]);
        await store.openFollowUps('record', record, 'Pilot planning');
      }
      store.toggleOwnerPicker('itm_00000001');
      await flush();
      page = listPage([given, yours('2')]);
      await store.pickFollowUpOwner(RAFAEL);
      expect(said(store)).toEqual({ words: 'Owner changed to Rafael' });
      expect(ids(store)).toEqual(['1', '2']);
    }
    // On your list, read again after your change: Mina had handed it on from Rafael meanwhile, so it is no longer yours to see there.
    store.closeFollowUp();
    await flush();
    store.toggleOwnerPicker('itm_00000002');
    await flush();
    const mina = { membership_id: 'mem_00000000-0000-4000-8000-000000000077', name: 'Mina Patel', active: true };
    page = listPage([given, { ...yours('2'), owner: { ...mina, match: 'reassigned' as const }, owner_set_at: '2026-10-08T14:00:00.000Z', owner_set_by: mina }]);
    await store.pickFollowUpOwner(RAFAEL);
    expect(ids(store)).toEqual(['1']);
  });

  it('keeps the check of a decision opened from its list when a runs list read since does not hold it', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    page = listPage([unsent('1')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    await store.openListDecision();
    expect(store.getState().decision).toMatchObject({ run: { run_id: impactRun('done').run_id, state: 'done' } });
    // Home is read again under them: its runs list holds only the newest checks, not this one.
    const lists = requests('list').length;
    await show(store);
    await flush();
    expect(requests('list').length).toBeGreaterThan(lists);
    expect(store.getState().decision).toMatchObject({ run: { run_id: impactRun('done').run_id, state: 'done' } });
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
    // The list read again, as far as it showed, rows only.
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

describe('Rows first, then what each says now', () => {
  const listPage = (items: OpenItemView[]): OpenItemsView => ({ items, next_cursor: null, stages: [], summary: {
    ...summary, decisions: 1, unsent: items.filter(entry => entry.state === 'unsent').length, open: items.filter(entry => entry.state === 'open').length,
    done: items.filter(entry => entry.state === 'done').length, not_relevant: items.filter(entry => entry.state === 'not_relevant').length } });
  type Store = Awaited<ReturnType<typeof start>>;
  const list = (store: Store) => store.followUpShown() as FollowUpList;
  const shownPage = (store: Store) => store.followUpShown() as ItemPage;
  /** A list's rows as they show: each its row, with what its live reads brought. */
  const shown = (store: Store) => list(store).items.map(entry => store.shownItem(entry, list(store).live));
  /** An item page's item as it shows. */
  const pageItem = (store: Store) => store.shownItem(shownPage(store).item!, shownPage(store).live);
  /** Home's items as they show. */
  const homeItems = (store: Store) => store.homeRows().flatMap(row => ('item' in row ? [row.item] : []));
  const reads = () => requests('items').filter(request => request.read !== 'counts' && request.scope !== 'run')
    .map(request => `${(request.states as string[]).join('+')}${request.cursor ? ` ${request.cursor}` : ''}${request.read === 'rows' ? '' : ' live'}`);
  const closedAs = (state: 'done' | 'not_relevant') => (id: string): OpenItemView => opened(id, { state, state_set_at: '2026-10-08T12:00:00.000Z' });
  const unsentOpened = (id: string): OpenItemView => ({ ...unsent(id), reach: 'opened', current: { source: ticket, says_now: `Says ${id}` } });

  beforeEach(() => { granola = null; });

  it('shows a row with what a live read brought of it, every other field as its rows were last read', async () => {
    const { shownItem } = await import('../../src/renderer/store.js');
    const row = rowOnly({ ...item('1'), state: 'done', owner: { ...RAFAEL, name: RAFAEL.display_name, active: true, match: 'reassigned' } });
    expect(shownItem(row, { itm_00000001: { reach: 'opened', current: opened('1').current } })).toEqual({ ...row, reach: 'opened', current: opened('1').current });
    expect(shownItem(row, { itm_00000001: { reach: 'no_access' } })).toEqual({ ...row, reach: 'no_access' });
    // Never read live: as read.
    expect(shownItem(row, { itm_00000002: { reach: 'unavailable' } })).toEqual(row);
  });

  it('shows Home\'s rows at once from their rows read, then fills what each says now from the live read, which alone says a sweep is due', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    home = { ...emptyHome(), items: [opened('1'), { ...item('2'), kind: 'action', expected: 'Send the revised quote', reach: 'not_read' }], waiting: 1, sweep_due: true };
    holdLive = true;
    const store = await start();
    // The live read still on its way: the rows show, by ECHO's own fields, and Home is loaded; only the live part waits.
    expect(store.getState().home).toMatchObject({ loading: false, reading: true, open: { waiting: 1 } });
    expect(store.homeRows().map(row => ('item' in row ? [row.kind, row.item.item_id, row.item.reach] : [row.kind]))).toEqual([
      ['update', 'itm_00000001', 'not_read'], ['update', 'itm_00000002', 'not_read'],
    ]);
    expect(homeItems(store)[0]).not.toHaveProperty('current');
    expect(store.awaitingLive(homeItems(store)[0]!)).toBe(true);
    // A meeting's action is never read live: it has nothing to wait for.
    expect(store.awaitingLive(homeItems(store)[1]!)).toBe(false);
    expect(requests('sweep')).toEqual([]);
    answerLive.shift()!();
    await flush();
    expect(store.getState().home).toMatchObject({ reading: false });
    expect(homeItems(store)[0]).toMatchObject({ reach: 'opened', current: { says_now: 'Says 1' } });
    // The live read says a sweep is due: Home asks for it once it answered.
    expect(requests('sweep')).toHaveLength(1);
  });

  it('keeps Home\'s rows when its live read fails, saying ECHO couldn\'t read them just now, and shows no error', async () => {
    home = { ...emptyHome(), items: [opened('1')] };
    failNextLive = true;
    const store = await start();
    expect(store.getState().home).toMatchObject({ loading: false, reading: false, failure: undefined });
    expect(homeItems(store)[0]).toMatchObject({ item_id: 'itm_00000001', reach: 'unavailable' });
    // Read again, the live read answers: what it says now fills in.
    await store.loadHome();
    expect(homeItems(store)[0]).toMatchObject({ reach: 'opened', current: { says_now: 'Says 1' } });
  });

  it('reads Home live only while it shows: rows only under follow-ups, and back on it after a change only the rows new to it', async () => {
    home = { ...emptyHome(), items: [opened('1')] };
    const store = await start();
    const live = () => homeCalls().filter(([, params]) => params.request.read === undefined && ['home', 'item'].includes(params.request.operation)).length;
    const before = live();
    // A follow-up's page covers Home, and the window comes forward: Home's rows are read again, rows only.
    readItem = opened('1');
    await store.openFollowUp('itm_00000001', homeItems(store)[0]!);
    home = { ...emptyHome(), items: [opened('1'), opened('2')] };
    const rows = rowsReads();
    await show(store);
    await flush();
    expect(rowsReads()).toBe(rows + 1);
    expect(live()).toBe(before);
    // A change on the page, then Back: Home's rows read again, and only the new one read live, on its own.
    await store.setFollowUpState('done');
    page = listPage([opened('2')]);
    store.closeFollowUp();
    await flush();
    expect(live()).toBe(before + 1);
    expect(requests('item').at(-1)).toEqual({ schema_version: 1, operation: 'item', item_id: 'itm_00000002' });
    expect(homeItems(store).map(entry => entry.reach)).toEqual(['opened', 'opened']);
  });

  it('reads the tools beside Home\'s other reads: only the meeting reviews wait on them', async () => {
    granola = 'linked';
    home = { ...emptyHome(), items: [opened('1')] };
    holdTools = true;
    const store = await start();
    // Runs and what waits on you were read without waiting for the tools; the reviews were not read yet.
    expect(operations()).toEqual(expect.arrayContaining(['list', 'home']));
    expect(rpc.mock.calls.some(([method]) => method === 'tools.meetings')).toBe(false);
    expect(store.homeRows().map(row => row.kind)).toEqual(['update']);
    answerTools.shift()!();
    await flush();
    expect(store.homeRows().map(row => row.kind)).toEqual(['approve', 'update']);
    expect(store.getState().home).toMatchObject({ meetings: true, loading: false });
  });

  it('fails a load whose tools cannot be read, as before, keeping what else it read and starting no run until Try again', async () => {
    granola = 'linked';
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('pending');
    home = { ...emptyHome(), items: [opened('1')] };
    failTools = true;
    const store = await start();
    expect(store.getState().home).toMatchObject({ loading: false, reading: false, failure: { code: 'transport_failed' } });
    expect(store.homeRows().map(row => row.kind)).toEqual(['update']);
    expect(requests('start')).toEqual([]);
    const calls = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rpc.mock.calls.slice(calls).filter(([method, params]) => method === 'runs' && params.request.read !== 'rows')).toEqual([]);
    // Try again: the tools answer, and the queued check starts.
    failTools = false;
    await store.loadHome();
    expect(store.getState().home?.failure).toBeUndefined();
    expect(requests('start')).toHaveLength(1);
  });

  it('shows a list\'s rows at once, read rows only, then reads live only the rows that show, and says which are on their way', async () => {
    page = listPage([unsentOpened('1'), opened('2'), { ...unsent('3'), kind: 'action', expected: 'Book the lab', reach: 'not_read' }]);
    const store = await start();
    holdLive = true;
    const opening = store.openFollowUps('record', record, 'Pilot planning');
    await flush();
    expect(list(store)).toMatchObject({ loading: false, reading: true });
    expect(shown(store).map(entry => entry.reach)).toEqual(['not_read', 'not_read', 'not_read']);
    expect(shown(store).map(entry => list(store).reading && store.awaitingLive(entry))).toEqual([true, true, false]);
    expect(reads()).toEqual(['unsent+open+done+not_relevant', 'unsent+open+done+not_relevant live']);
    answerLive.shift()!();
    await opening;
    expect(shown(store).map(entry => entry.reach)).toEqual(['opened', 'opened', 'not_read']);
    expect(list(store).reading).toBe(false);
  });

  it('leaves a list\'s rows saying ECHO couldn\'t read them just now when their live read fails, with no error for the list', async () => {
    page = listPage([opened('1'), { ...item('2'), kind: 'action', expected: 'Book the lab', reach: 'not_read' }]);
    const store = await start();
    failLiveItems = 1;
    await store.openFollowUps('record', record, 'Pilot planning');
    expect(list(store)).toMatchObject({ loading: false, reading: false });
    expect(list(store).failed).toBeUndefined();
    expect(shown(store).map(entry => entry.reach)).toEqual(['unavailable', 'not_read']);
    // Opened again, it is read live again.
    const live = reads().filter(entry => entry.endsWith(' live')).length;
    store.closeFollowUp();
    await store.openFollowUps('record', record, 'Pilot planning');
    expect(reads().filter(entry => entry.endsWith(' live'))).toHaveLength(live + 1);
    expect(shown(store).map(entry => entry.reach)).toEqual(['opened', 'not_read']);
  });

  it('starts yours and a project\'s closed groups closed, reading their rows only once opened; a meeting\'s open, read with the rest', async () => {
    page = listPage([opened('1'), closedAs('done')('2'), closedAs('not_relevant')('3')]);
    const store = await start();
    await store.openYourFollowUps();
    // Current work only, rows only and then live.
    expect(reads()).toEqual(['unsent+open', 'unsent+open live']);
    expect(list(store).expanded).toEqual({});
    expect(shown(store).map(entry => entry.reach)).toEqual(['opened']);
    // Done opened: its rows read, rows only and then live, Done alone.
    store.toggleClosedGroup('done');
    await flush();
    expect(list(store).expanded).toEqual({ done: true });
    expect(reads().slice(2)).toEqual(['done', 'done live']);
    expect(shown(store).map(entry => entry.reach)).toEqual(['opened', 'opened']);
    // Closed and opened again, it reads nothing more; Dismissed opened reads its own.
    store.toggleClosedGroup('done');
    store.toggleClosedGroup('done');
    store.toggleClosedGroup('not_relevant');
    await flush();
    expect(reads().slice(2)).toEqual(['done', 'done live', 'not_relevant', 'not_relevant live']);
    expect(list(store).expanded).toEqual({ done: true, not_relevant: true });
    // A meeting's list shows its closed rows, and reads them with its current work: one read rows only, one live.
    await store.openFollowUps('record', record, 'Pilot planning');
    expect(list(store).expanded).toEqual({ done: true, not_relevant: true });
    expect(reads().slice(6)).toEqual(['unsent+open+done+not_relevant', 'unsent+open+done+not_relevant live']);
    // Its groups close too.
    store.toggleClosedGroup('done');
    expect(list(store).expanded).toEqual({ not_relevant: true });
  });

  it('keeps what a list read live through a change, and never lets a slower live read undo the change', async () => {
    page = listPage([unsentOpened('1'), unsentOpened('2')]);
    const store = await start();
    holdLive = true;
    const opening = store.openFollowUps('record', record, 'Pilot planning');
    await flush();
    // The live read is still on its way when Send goes (the first row only), and answers what the page held before it.
    store.tickFollowUp('itm_00000002');
    page = listPage([{ ...opened('1'), approver: unsent('1').approver }, unsentOpened('2')]);
    holdLive = false;
    await store.sendTicked(true);
    expect(shown(store).map(entry => [entry.state, entry.reach])).toEqual([['open', 'not_read'], ['unsent', 'not_read']]);
    answerLive.shift()!();
    await opening;
    // What it says now fills in; what Send did stays.
    expect(shown(store).map(entry => [entry.state, entry.reach])).toEqual([['open', 'opened'], ['unsent', 'opened']]);
    // Another change, read again rows only: each keeps what it read live, and nothing is read live again.
    const live = reads().filter(entry => entry.endsWith(' live')).length;
    page = listPage([{ ...opened('1'), approver: unsent('1').approver }, { ...unsentOpened('2'), state: 'not_relevant', send_included: false }]);
    store.tickFollowUp('itm_00000002');
    await store.sendTicked(false);
    expect(shown(store).map(entry => [entry.state, entry.reach])).toEqual([['open', 'opened'], ['not_relevant', 'opened']]);
    expect(reads().filter(entry => entry.endsWith(' live'))).toHaveLength(live);
  });

  it('shows an item page\'s row at once while it is read live, then reads it again rows only after a change, keeping what it read live', async () => {
    readItem = opened('1');
    const store = await start();
    holdLive = true;
    const opening = store.openFollowUp('itm_00000001', rowOnly(opened('1')));
    await flush();
    expect(shownPage(store)).toMatchObject({ kind: 'item', loading: true });
    expect(pageItem(store).reach).toBe('not_read');
    answerLive.shift()!();
    await opening;
    expect(shownPage(store).loading).toBe(false);
    expect(pageItem(store)).toMatchObject({ reach: 'opened', current: { says_now: 'Says 1' } });
    holdLive = false;
    readItem = { ...opened('1'), state: 'done', state_set_at: '2026-10-09T12:00:00.000Z' };
    await store.setFollowUpState('done');
    // Its rows, then it live, then, after the change, its rows again: the item is done, and still says what it said.
    expect(requests('item').map(request => request.read)).toEqual(['rows', undefined, 'rows']);
    expect(requests('items')).toEqual([]);
    expect(shownPage(store)).toMatchObject({ busy: false, said: { words: 'Done', undo: true } });
    expect(pageItem(store)).toMatchObject({ state: 'done', state_set_at: '2026-10-09T12:00:00.000Z', reach: 'opened', current: { says_now: 'Says 1' } });
  });

  it('opens a page with what its view read live of its item, reading it again rows only; a meeting\'s action is never read live', async () => {
    readItem = opened('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', opened('1'));
    readItem = { ...item('2'), kind: 'action', expected: 'Book the lab', reach: 'not_read' };
    await store.openFollowUp('itm_00000002', rowOnly(readItem));
    expect(requests('item').map(request => request.read)).toEqual(['rows', 'rows']);
    expect(pageItem(store)).toMatchObject({ reach: 'not_read' });
  });

  it('shows what the Authority answered on an item page when the read after the change fails', async () => {
    readItem = opened('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', opened('1'));
    failItems = 1;
    await store.setFollowUpState('done');
    expect(shownPage(store)).toMatchObject({ busy: false, said: { words: 'Done', undo: true } });
    expect(pageItem(store)).toMatchObject({ state: 'done', reach: 'opened' });
    expect(shownPage(store).failure).toBeUndefined();
  });

  it('keeps an item page\'s row when its read fails for an outage, saying ECHO couldn\'t read it just now', async () => {
    readItem = null;
    const store = await start();
    await store.openFollowUp('itm_00000001', rowOnly(opened('1')));
    expect(shownPage(store).loading).toBe(false);
    expect(pageItem(store).reach).toBe('unavailable');
    expect(shownPage(store).failure).toMatchObject({ code: 'unavailable' });
  });

  it('keeps cached details but exposes a failed row refresh for retry', async () => {
    readItem = null;
    const store = await start();
    await store.openFollowUp('itm_00000001', opened('1'));
    expect(pageItem(store)).toMatchObject({ reach: 'opened', current: { says_now: 'Says 1' } });
    expect(shownPage(store).failure).toMatchObject({ code: 'unavailable' });
    readItem = opened('1');
    store.retryFollowUp();
    await flush();
    expect(shownPage(store).failure).toBeUndefined();
    expect(requests('item').map(request => request.read)).toEqual(['rows', 'rows']);
  });

  it('reads live an item opened from a row whose live read failed, and Try again on its page reads it live again', async () => {
    page = listPage([opened('1')]);
    readItem = opened('1');
    const store = await start();
    failLiveItems = 1;
    await store.openYourFollowUps();
    expect(shown(store)[0]?.reach).toBe('unavailable');
    await store.openFollowUp('itm_00000001', shown(store)[0]!);
    expect(requests('item').map(request => request.read)).toEqual(['rows', undefined]);
    expect(pageItem(store)).toMatchObject({ reach: 'opened', current: { says_now: 'Says 1' } });
    // A page whose read failed for an outage: Try again reads it, rows only and then live.
    failItems = 1;
    await store.openFollowUp('itm_00000002', rowOnly(opened('2')));
    expect(pageItem(store).reach).toBe('unavailable');
    readItem = opened('2');
    const before = requests('item').length;
    store.retryFollowUp();
    await flush();
    expect(requests('item').slice(before).map(request => request.read)).toEqual(['rows', undefined]);
    expect(pageItem(store)).toMatchObject({ reach: 'opened', current: { says_now: 'Says 2' } });
  });

  it('reads a closed group opened while another\'s first read is on its way, once that read answers', async () => {
    page = listPage([opened('1'), closedAs('done')('2'), closedAs('not_relevant')('3')]);
    const store = await start();
    await store.openYourFollowUps();
    store.toggleClosedGroup('done');
    store.toggleClosedGroup('not_relevant');
    for (let turn = 0; turn < 5; turn += 1) await flush();
    expect(list(store).expanded).toEqual({ done: true, not_relevant: true });
    expect(list(store).items.map(entry => entry.item_id)).toEqual(['itm_00000001', 'itm_00000002', 'itm_00000003']);
    expect(reads().slice(2)).toEqual(['done', 'not_relevant', 'done live', 'not_relevant live']);
    expect(shown(store).map(entry => entry.reach)).toEqual(['opened', 'opened', 'opened']);
  });

  it('stops saying Home is read live once a later load has nothing to read live', async () => {
    const action: OpenItemView = { ...item('1'), kind: 'action', expected: 'Book the lab', reach: 'not_read' };
    home = { ...emptyHome(), items: [action] };
    holdLive = true;
    const store = await start();
    expect(store.getState().home).toMatchObject({ reading: true });
    // A change on its page, then Back: Home is read again, and nothing in it waits for a live read.
    readItem = action;
    await store.openFollowUp(action.item_id, action);
    readItem = { ...action, state: 'done' };
    await store.setFollowUpState('done');
    home = emptyHome();
    store.closeFollowUp();
    await flush();
    expect(store.getState().home).toMatchObject({ loading: false, reading: false });
    // The first load's live read answers late: it is no longer Home's, and changes nothing.
    answerLive.shift()!();
    await flush();
    expect(store.getState().home).toMatchObject({ reading: false });
  });

  it('goes on reading a list live once it shows again, after another app in front stopped it under an item page', async () => {
    page = listPage([opened('1')]);
    readItem = opened('1');
    const store = await start();
    holdListRows = true;
    const opening = store.openYourFollowUps();
    await flush();
    // A row's page opens over the list while its rows read is on its way; then another app comes in front.
    await store.openFollowUp('itm_00000001', opened('1'));
    cover(store);
    holdListRows = false;
    answerListRows.shift()!();
    await opening;
    expect(reads()).toEqual(['unsent+open']);
    uncover(store);
    await flush();
    expect(reads()).toEqual(['unsent+open']);
    // Back on the list: ECHO came back meanwhile, so its rows are read again, then what they show is read live.
    store.closeFollowUp();
    await flush();
    expect(reads()).toEqual(['unsent+open', 'unsent+open', 'unsent+open live']);
    expect(shown(store).map(entry => entry.reach)).toEqual(['opened']);
  });

  it('says what a Send did at once, while rows new to the list are still read live', async () => {
    page = listPage([unsentOpened('1')]);
    const store = await start();
    await store.openFollowUps('record', record, 'Pilot planning');
    page = listPage([{ ...opened('1'), approver: unsent('1').approver }, opened('2')]);
    holdLive = true;
    const sending = store.sendTicked(true);
    for (let turn = 0; turn < 5; turn += 1) await flush();
    expect(list(store)).toMatchObject({ busy: false, reading: true, said: { words: 'Sent to Fixture' } });
    expect(shown(store).map(entry => [entry.state, entry.reach])).toEqual([['open', 'opened'], ['open', 'not_read']]);
    answerLive.shift()!();
    await sending;
    await flush();
    expect(list(store).reading).toBe(false);
    expect(shown(store).map(entry => entry.reach)).toEqual(['opened', 'opened']);
  });
});
