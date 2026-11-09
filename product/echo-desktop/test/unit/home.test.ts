import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonMeetingReviewV2, PersonRunV1 } from '@echo-brain/organization-api';
import type { FollowUpList, ItemPage } from '../../src/renderer/store.js';
import { ACCOUNT, byTestId, cover, digest, elements, EMPTY_SUMMARY, fail, flush, hide, ok, plainHooks, render, show, startStore as start, storeLifecycle, text, uncover } from './harness.js';
import type { HomeView, OpenItemsView, OpenItemView, ToolStatus } from '../../src/shared/protocol.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

/** The proposal, and the one record its approval wrote: a check is keyed by its record's own approval id. */
const approval = 'apr_' + 'a'.repeat(64);
const recordApproval = 'apr_' + 'f'.repeat(64);
const record = 'sha256:' + '1'.repeat(64);
const RAFAEL = { membership_id: 'mem_00000000-0000-4000-8000-000000000088', display_name: 'Rafael Moreno' };

const impactRun = (state: PersonRunV1['state'], id = '20', event = recordApproval): PersonRunV1 => ({
  run_id: `run_00000000-0000-4000-8000-0000000000${id}`, trigger: 'approved_record', event_ref: event, state,
  error_code: state === 'failed' ? 'research_failed' : null, created_at: '2026-10-08T10:00:00.000Z', updated_at: '2026-10-08T10:05:00.000Z',
});
/** A sweep, as an older Authority may still list one: the desktop starts none and makes no row of one. */
const sweepRun = (state: PersonRunV1['state']): PersonRunV1 => ({
  run_id: 'run_00000000-0000-4000-8000-000000000050', trigger: 'sweep', event_ref: 'sweep_00000000-0000-4000-8000-000000000050', state,
  error_code: state === 'failed' ? 'research_failed' : null, created_at: '2026-10-08T12:00:00.000Z', updated_at: '2026-10-08T12:00:00.000Z',
});
/** A meeting's review; approved, its one record. */
const meeting = (id: string, status: PersonMeetingReviewV2['status']): PersonMeetingReviewV2 => ({
  approval_id: `apr_${id.repeat(64)}`, title: `Meeting ${id}`, project_ids: [], status, decided_on: status === 'pending' ? null : 'desktop',
  first_line: null, action_count: 0, meeting_at: null, all_day: false, records: status === 'approved' ? [{ approval_id: `apr_${'f'.repeat(32)}${id.repeat(32)}`, project_ids: [] }] : [],
});
/** The approved record an item came from: its approval id is the record's own. */
const decision = { approval_id: recordApproval, record_sha256: record, title: 'Pilot planning', first_line: 'Launch the pilot next week.', approved_at: '2026-10-08T10:00:00.000Z', project_ids: [] };
/** A proposal's decision and action as review_open gives them. */
const reviewItems = [
  { signal_id: 'dec-1', kind: 'decision' as const, text: 'Launch the pilot next week.', subject: null, status: 'decided' as const, due_at: null, quotes: [], owner: null, owner_editable: false },
  { signal_id: 'act-1', kind: 'action' as const, text: 'Send the revised quote', subject: null, status: null, due_at: null, quotes: [], owner: 'Rafael Moreno', owner_editable: true },
];
const person = (name: string) => ({ membership_id: `mem_00000000-0000-4000-8000-00000000000${name.length}`, name, active: true });
const item = (id: string): OpenItemView => ({
  item_id: `itm_0000000${id}`, run_id: impactRun('done').run_id, kind: 'ticket', decision, relation: 'conflicts', expected: 'launch next week',
  approver: person('Mina Patel'), owner: { ...person('Fixture'), match: 'jira_account' }, waits_on: 'owner', state: 'open',
  created_at: '2026-10-08T10:05:00.000Z', sent_at: '2026-10-08T11:00:00.000Z', state_set_at: '2026-10-08T11:00:00.000Z', state_set_by: person('Mina Patel'),
  owner_set_at: null, owner_set_by: null, send_included: true, check: null, can: { set_state: true, assign: true }, reach: 'no_access',
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
/** Home as a rows-only read answers it: no row read live. */
const rowsOf = (view: HomeView): HomeView => ({ ...view, items: view.items.map(rowOnly) });
const ticket = { kind: 'ticket' as const, tool_id: 'jira', label: 'ECHO-12 · Pilot launch', permalink: 'https://example.atlassian.net/browse/ECHO-12' };
/** An item ECHO opened for you just now: what it says now comes with it. */
const opened = (id: string, extra: Partial<OpenItemView> = {}): OpenItemView => ({ ...item(id), reach: 'opened', current: { source: ticket, says_now: `Says ${id}` }, ...extra });
/**
 * The runs requests sent, but for reads of Home's rows (Home's own, each before its live read) and the change check's reads
 * of the open follow-ups you are involved in (freshness.test.ts).
 */
const notificationScan = (request: { operation?: string; scope?: string; read?: string; states?: readonly string[]; changed_since?: string }) => request.operation === 'items'
  && (request.scope === 'mine' || request.scope === 'involved') && request.read === 'rows' && (request.states?.join() === 'open' || request.changed_since !== undefined);
/** A check-in, which the change check sends after each check that reached the Authority (DSK-1). */
const isCheckIn = (method: string, params: { request?: { operation?: string } | null }) => method === 'runs' && params.request?.operation === 'next';
/** Every request but the change check's and its check-ins, which go on at the server's pace whatever Home does (desktop refresh v1). */
const polls = () => rpc.mock.calls.filter(([method, params]) => method !== 'changes.read' && method !== 'projects.activity' && !isCheckIn(method, params));
const homeCalls = () => rpc.mock.calls.filter(([method, params]) => method === 'runs' && !(params.request.operation === 'home' && params.request.read === 'rows') && !notificationScan(params.request)
  && !isCheckIn(method, params));
/** The check-ins sent, by the account each was for. */
const checkIns = () => rpc.mock.calls.filter(([method, params]) => isCheckIn(method, params)).map(([, params]) => params.expect.membership_id as string);
/** The runs operations sent, in order, as sent. */
const runsSent = () => rpc.mock.calls.filter(([method]) => method === 'runs').map(([, params]) => params.request.operation as string);
/** Reads of what waits on you: each Home read starts with its rows. */
const rowsReads = () => rpc.mock.calls.filter(([method, params]) => method === 'runs' && params.request.operation === 'home' && params.request.read === 'rows').length;
const operations = () => homeCalls().map(([, params]) => params.request.operation);
/** The runs requests sent with one operation, as sent. */
const requests = (operation: string) => homeCalls().filter(([, params]) => params.request.operation === operation).map(([, params]) => params.request);
const project = { project_id: 'prj_11111111-1111-4111-8111-111111111111', name: 'Thermostat redesign', role: 'lead' as const, created_at: '2026-10-01T00:00:00.000Z', status: 'active' as const };

type Store = Awaited<ReturnType<typeof start>>;
type Failure = { code: string; retryable: boolean; mutation_outcome?: 'unknown' };
/**
 * The replies a test holds back (`held`): live reads (Home's, a list's, an item's), Home's rows reads, a list's rows reads, the
 * tools read, sends and set_states; runs lists and check-ins.
 */
type Hold = 'live' | 'rows' | 'listRows' | 'reviews' | 'send' | 'setState' | 'list' | 'next';

/** What the fake Authority holds and how it answers, as each test starts: a test changes `fx` to say otherwise. */
const fresh = () => ({
  review: { approval_id: approval, title: 'Private meeting', project_ids: [], status: 'pending', decided_on: null, first_line: null, action_count: 0, meeting_at: null,
    all_day: false, records: [] } as PersonMeetingReviewV2,
  run: null as PersonRunV1 | null,
  /** The checks of the review's further records, listed after its first record's. */
  more: [] as PersonRunV1[],
  home: emptyHome(),
  granola: 'linked' as ToolStatus | null,
  failNextList: false,
  failNextReviews: false,
  /** The reviews list names the review; one older than the newest it holds it does not. */
  listed: true,
  /** The review cannot be opened while set. */
  failOpen: false,
  failLists: false,
  /** Home's next read of its rows fails (and so nothing of it is read live). */
  failNextHome: false,
  /** Home's next live read fails, its rows read. */
  failNextLive: false,
  /** Live items reads to fail next (not rows only, not counts only). */
  failLiveItems: 0,
  /** The reviews read fails while set. */
  failReviews: false,
  sendFailure: null as Failure | null,
  /** A send of this run fails as `sendFailure` says; any other run's goes. Null: every send fails so. */
  sendFailsFor: null as string | null,
  /** Rows an items read pages at a time (null: all at once), and items reads to fail next. */
  pageSize: null as number | null,
  failItems: 0,
  /** How a set_state fails, when a test says; a read of one item answers not_found while set. */
  setStateFailure: null as Failure | null,
  itemGone: false,
  /** The signed-in account; nobody once signed out. */
  member: 'member',
  signedIn: true,
  /**
   * Moves of the change check's areas a test makes: each moves that area's fingerprint. The Authority folds your own checks'
   * states into the reviews (DSK-1): a test moves them as a check starts, fails or ends.
   */
  moved: { follow_ups: 0, reviews: 0 },
  /** What an items read answers, when a test says. */
  page: null as OpenItemsView | null,
  /** How an assign fails, when a test says; what a read of one item answers (unavailable while null). */
  assignFailure: null as Failure | null,
  readItem: null as OpenItemView | null,
  /** The kinds of reply held back while set, and the replies held, oldest first. */
  hold: { live: false, rows: false, listRows: false, reviews: false, send: false, setState: false, list: false, next: false } as Record<Hold, boolean>,
  waiting: { live: [], rows: [], listRows: [], reviews: [], send: [], setState: [], list: [], next: [] } as Record<Hold, (() => void)[]>,
});
let fx = fresh();

/**
 * A reply, or, while the test holds its kind, one that waits until `release`. `answer` makes it when it goes: Home's reads and
 * the reviews read answer what the test holds then; the other kinds are made when asked, and handed in made.
 */
function held(kind: Hold, answer: () => unknown): unknown {
  return fx.hold[kind] ? new Promise(resolve => { fx.waiting[kind].push(() => resolve(answer())); }) : answer();
}
/** The oldest reply held of this kind goes. */
const release = (kind: Hold) => fx.waiting[kind].shift()!();

/** The Authority, as the host hands its answers to the renderer: what `fx` holds. */
async function authority(method: string, params: { project_id?: string; request?: { operation: string; run_id?: string; item_id?: string; state?: string;
  read?: 'rows' | 'counts'; states?: readonly string[]; cursor?: string; scope?: string; id?: string } }) {
  const unavailable = fail('unavailable', { retryable: true });
  switch (method) {
    case 'app.status': return ok(fx.signedIn ? { signed_in: true, account: { ...ACCOUNT, membership_id: fx.member } } : { signed_in: false, account: null });
    case 'account.signOut': fx.signedIn = false; return ok({ signed_in: false, account: null, client_version: 'test' });
    case 'projects.list': return ok({ items: [], next_cursor: null });
    case 'projects.members': return ok({ items: [], next_cursor: null });
    case 'list.page': return ok({ items: [], next_cursor: null, meetings_held: false });
    case 'open.ref': return unavailable;
    // A project's tools line: it reads nothing.
    case 'projects.jiraRead': case 'projects.confluenceRead': return ok({ project_id: params.project_id, revision: null, mapping: null });
    case 'app.setUnresolved': case 'notice.show': case 'log.changes': return ok(null);
    // The timeline is empty, there are no project arrivals, and the source check is unavailable.
    case 'timeline.read': return ok({ turns: [] });
    case 'projects.activity': return ok({ items: [] });
    case 'ask.check': return fail('not_supported');
    // The change check: nothing moves unless a test says.
    case 'changes.read': return ok({ kind: 'echo-person-changes-v1', check_again_after_seconds: 60,
      areas: { projects: digest('projects'), follow_ups: digest(`f${fx.moved.follow_ups}`), reviews: digest(`r${fx.moved.reviews}`) } });
    case 'people.directory': return ok({ items: [RAFAEL], next_cursor: null });
    case 'account.tools': return ok({ tools: fx.granola === null ? [] : [{ tool_id: 'granola', status: fx.granola }] });
    case 'reviews': {
      // Approved, the review names its one record unless the test says otherwise.
      const review = { ...fx.review, records: fx.review.status === 'approved' && fx.review.records.length === 0 ? [{ approval_id: recordApproval, project_ids: fx.review.project_ids }] : fx.review.records };
      if (params.request?.operation === 'reviews') {
        if (fx.failReviews) return fail('transport_failed', { retryable: true });
        if (fx.failNextReviews) { fx.failNextReviews = false; return unavailable; }
        return held('reviews', () => ok({ reviews: fx.listed ? [review] : [] }));
      }
      const decided = review.status !== 'pending' && review.status !== 'superseded';
      if (params.request?.operation === 'review_open') return fx.failOpen ? unavailable : ok({ review, snapshot_sha256: 'snapshot', participants: [], reasons: [],
        suggested_projects: [], records: review.records,
        items: reviewItems.map(entry => ({ ...entry, owner_editable: !decided && entry.owner_editable, project_ids: decided ? review.records[0]?.project_ids ?? null : [] })) });
      break;
    }
    case 'runs':
      if (params.request?.operation === 'list') {
        if (fx.failLists) return unavailable;
        if (fx.failNextList) { fx.failNextList = false; return unavailable; }
        // Held, it answers the runs as they were when it was asked.
        const listed = ok({ runs: [...(fx.run ? [{ ...fx.run }] : []), ...fx.more.map(entry => ({ ...entry }))] });
        return held('list', () => listed);
      }
      if (params.request?.operation === 'home') {
        // Its rows, answered with what `fx.home` holds when the test lets them go; and its live read.
        if (params.request.read === 'rows') {
          if (fx.failNextHome) { fx.failNextHome = false; return unavailable; }
          return held('rows', () => ok(rowsOf(fx.home)));
        }
        if (fx.failNextLive) { fx.failNextLive = false; return unavailable; }
        return held('live', () => ok(fx.home));
      }
      // A check-in (DSK-1), as the Authority answers it: the oldest queued check starts (lists come newest first), unless
      // another runs; with none queued, idle. Held, the check is still queued until the check-in lands.
      if (params.request?.operation === 'next') {
        return held('next', () => {
          const checks = [...(fx.run ? [fx.run] : []), ...fx.more];
          const oldest = [...checks].reverse().find(entry => entry.state === 'pending');
          if (!oldest) return ok({ state: 'idle' });
          if (checks.some(entry => entry.state === 'running')) return ok({ state: 'busy' });
          if (oldest === fx.run) fx.run = { ...oldest, state: 'running' };
          else fx.more = fx.more.map(entry => (entry === oldest ? { ...entry, state: 'running' as const } : entry));
          return ok({ state: 'running' });
        });
      }
      // Try again on a failed check: queued again.
      if (params.request?.operation === 'retry') {
        const failed = [fx.run, ...fx.more].find(entry => entry?.run_id === params.request?.run_id && entry?.state === 'failed');
        if (!failed) return fail('not_found');
        Object.assign(failed, { state: 'pending', error_code: null });
        return ok({ state: 'pending' });
      }
      if (params.request?.operation === 'set_state') {
        if (fx.setStateFailure) return { ok: false, failure: fx.setStateFailure };
        const reply = ok({ state: params.request.state });
        return held('setState', () => reply);
      }
      if (params.request?.operation === 'assign') {
        return fx.assignFailure ? { ok: false, failure: fx.assignFailure } : ok({ owner: { membership_id: RAFAEL.membership_id, name: RAFAEL.display_name, active: true } });
      }
      // One item: the one the test says, else the row a list read holds now; read rows only, nothing of it read live.
      if (params.request?.operation === 'item') {
        if (fx.itemGone) return fail('not_found');
        if (fx.failItems > 0) { fx.failItems -= 1; return unavailable; }
        const found = fx.readItem?.item_id === params.request.item_id ? fx.readItem : fx.page?.items.find(entry => entry.item_id === params.request?.item_id);
        const answer = found ? ok(params.request.read === 'rows' ? rowOnly(found) : found) : unavailable;
        return params.request.read === undefined ? held('live', () => answer) : answer;
      }
      if (params.request?.operation === 'items') {
        // Notification discovery is independent of the foreground list's injected failures.
        if (notificationScan(params.request)) return itemsAnswer(params.request);
        if (fx.failItems > 0) { fx.failItems -= 1; return unavailable; }
        if (fx.failLiveItems > 0 && params.request.read === undefined) { fx.failLiveItems -= 1; return unavailable; }
        // A read held answers what the page held when it was asked.
        const answer = itemsAnswer(params.request);
        if (params.request.read === 'rows') return held('listRows', () => answer);
        return params.request.read === undefined ? held('live', () => answer) : answer;
      }
      if (params.request?.operation === 'send') {
        const reply = fx.sendFailure && (fx.sendFailsFor === null || fx.sendFailsFor === params.request.run_id) ? { ok: false, failure: fx.sendFailure } : ok({ sent: 1, not_relevant: 0 });
        return held('send', () => reply);
      }
  }
  throw new Error(`Unexpected request: ${method} ${params.request?.operation ?? ''}`);
}

/**
 * An items read, as the test's page holds it: counts only, or the items in the states asked for, a page at a time. A check's
 * rows (scope run) are its rows, with the one item read now (`readItem`) in place of its row, and without it once it is gone.
 * Rows only: nothing read live, so no row says what it says now.
 */
function itemsAnswer(request: { states?: readonly string[]; cursor?: string; read?: 'rows' | 'counts'; scope?: string; id?: string }) {
  const answer: OpenItemsView = fx.page ?? { items: [{ ...item('5'), state: 'unsent', sent_at: null, state_set_at: null, waits_on: 'approver' }], next_cursor: null, stages: [],
    summary: { ...EMPTY_SUMMARY, unsent: 1, decisions: 1 } };
  const { states, cursor, read, scope, id } = request;
  const scoped = scope !== 'run' ? answer.items
    : [...answer.items.filter(entry => entry.item_id !== fx.readItem?.item_id), ...(fx.readItem ? [fx.readItem] : [])]
      .filter(entry => entry.run_id === id && !(fx.itemGone && entry.item_id === fx.readItem?.item_id));
  const listed = (read === 'counts' ? [] : states ? scoped.filter(entry => states.includes(entry.state)) : scoped)
    .map(entry => (read === 'rows' ? rowOnly(entry) : entry));
  const from = cursor === undefined ? 0 : Number(cursor.slice(1));
  const size = fx.pageSize ?? Math.max(listed.length, 1);
  return ok({ ...answer, items: listed.slice(from, from + size), next_cursor: from + size < listed.length ? `c${from + size}` : null });
}

storeLifecycle();
beforeEach(() => {
  fx = fresh();
  rpc.mockReset();
  rpc.mockImplementation(authority);
});

/** Signed in, on a meeting's follow-ups. */
async function meetingList() {
  const store = await start();
  await store.openFollowUps('record', record, 'Pilot planning');
  return store;
}

/** Nothing more is read for two minutes but the change check, which goes on at the server's pace. */
async function expectQuiet() {
  const calls = polls().length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(polls()).toHaveLength(calls);
}

/** Signed in, with your approved meeting's impact check running. */
async function checking() {
  fx.review = { ...fx.review, status: 'approved', decided_on: 'desktop' };
  fx.run = impactRun('running');
  return start();
}

describe('Home rows', () => {
  it.each([null, 'unavailable'] as const)('shows an owner item when Granola is %s, and its row opens its page over Home', async status => {
    fx.granola = status;
    fx.listed = false;
    fx.home = { ...emptyHome(), items: [item('1')], waiting: 2 };
    const store = await start();
    expect(store.getState().home).toMatchObject({ loading: false, open: { waiting: 2 } });
    expect(store.homeRows()).toMatchObject([{ kind: 'update', item: { item_id: item('1').item_id } }]);
    expect(store.needsCount()).toBe(1);
    expect(rpc.mock.calls.some(([method]) => method === 'reviews')).toBe(true);
    // The row's copy shows at once, then the item is read again.
    fx.readItem = { ...item('1'), expected: 'launch this week' };
    const row = store.homeRows()[0]!;
    const opening = store.openFollowUp(item('1').item_id, 'item' in row ? row.item : null);
    expect(store.followUpShown()).toMatchObject({ kind: 'item', loading: true, item: { expected: 'launch next week' } });
    await opening;
    expect(store.followUpShown()).toMatchObject({ kind: 'item', loading: false, item: { expected: 'launch this week' } });
    expect(store.getState().route).toEqual({ page: 'home' });
  });

  it('keeps open items and meeting reviews when Granola becomes unavailable', async () => {
    fx.home = { ...emptyHome(), items: [item('1')] };
    const store = await start();
    expect(store.homeRows().map(row => row.kind)).toEqual(['approve', 'update']);
    fx.granola = 'unavailable';
    rpc.mockClear();
    await store.loadHome();
    expect(store.homeRows().map(row => row.kind)).toEqual(['approve', 'update']);
    expect(rpc.mock.calls.some(([method]) => method === 'reviews')).toBe(true);
    expect(operations()).toContain('home');
  });

  it('merges Home loads asked for while one is on its way: one set of reads, then at most one more', async () => {
    const store = await start();
    rpc.mockClear();
    fx.hold.rows = true;
    const first = store.loadHome();
    await flush();
    // The window comes forward (resume and shown) while that load waits: both join it.
    const joined = [store.loadHome(), store.loadHome()];
    await flush();
    const loads = () => rpc.mock.calls.filter(([method, params]) => method === 'reviews' && params.request.operation === 'reviews').length;
    expect(loads()).toBe(1);
    fx.hold.rows = false;
    release('rows');
    await Promise.all([first, ...joined]);
    expect(loads()).toBe(2);
    expect(operations().filter(operation => operation === 'home')).toEqual(['home', 'home']);
  });

  it('orders rows approve, retry, send, update, checking', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const reviews = [meeting('c', 'approved'), meeting('b', 'approved'), meeting('d', 'publishing'), meeting('e', 'approved'), meeting('a', 'pending')];
    const runs = [impactRun('running', '21', reviews[0]!.records[0]!.approval_id), impactRun('failed', '22', reviews[1]!.records[0]!.approval_id),
      impactRun('done', '23', reviews[3]!.records[0]!.approval_id)];
    const open: HomeView = { ...emptyHome(), send: [sendRow()], items: [item('1'), item('2')] };
    const rows = needRows(reviews, runs, open);
    // A check that did not finish needs you: right after the decisions to approve, never at the bottom of a long Home.
    expect(rows.map(row => row.kind)).toEqual(['approve', 'failed', 'send', 'update', 'update', 'checking', 'checking']);
    expect(rows[1]).toMatchObject({ kind: 'failed', review: { approval_id: reviews[1]!.approval_id } });
    const { ReviewLine } = await import('../../src/renderer/screens/home.js');
    expect(text(render(ReviewLine({ row: rows[1] as Parameters<typeof ReviewLine>[0]['row'] })))).toBe('Approved · the check did not finish');
    expect(rows[5]).toMatchObject({ kind: 'checking', run: { state: 'running' } });
    // A finished check makes no row of its own: what it found comes from `home`.
    expect(rows.some(row => 'review' in row && row.review.approval_id === reviews[3]!.approval_id)).toBe(false);
  });

  it('leaves only review and run rows when the home part was never read', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const rows = needRows([meeting('a', 'pending'), meeting('b', 'approved')], [impactRun('failed', '22', meeting('b', 'approved').records[0]!.approval_id)], null);
    expect(rows.map(row => row.kind)).toEqual(['approve', 'failed']);
  });

  it('makes no Home row of a sweep an older Authority may still list, going or failed', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const approved = meeting('b', 'approved');
    // Even a sweep naming an approval does not stand for its impact check.
    for (const state of ['pending', 'running', 'failed'] as const) {
      expect(needRows([approved], [{ ...sweepRun(state), event_ref: approved.records[0]!.approval_id }], null)).toEqual([]);
    }
  });

  it('matches a meeting\'s checks through its records: one row, failed when any check did not finish, else checking while any goes', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const records = [{ approval_id: 'apr_' + '1'.repeat(64), project_ids: ['prj_11111111-1111-4111-8111-111111111111'] }, { approval_id: 'apr_' + '2'.repeat(64), project_ids: [] }];
    const approved: PersonMeetingReviewV2 = { ...meeting('b', 'approved'), records };
    const runs = (first: PersonRunV1['state'], second: PersonRunV1['state']) => [impactRun(first, '31', records[0]!.approval_id), impactRun(second, '32', records[1]!.approval_id)];
    expect(needRows([approved], runs('done', 'failed'), null)).toMatchObject([{ kind: 'failed', run: { run_id: impactRun('failed', '32').run_id } }]);
    expect(needRows([approved], runs('running', 'done'), null)).toMatchObject([{ kind: 'checking', run: { run_id: impactRun('running', '31').run_id } }]);
    expect(needRows([approved], runs('done', 'done'), null)).toEqual([]);
    // A check keyed by the proposal's own id is no record's: it makes no row.
    expect(needRows([approved], [impactRun('failed', '33', approved.approval_id)], null)).toEqual([]);
    // Publishing, before its records are written: checking, with no run yet.
    expect(needRows([{ ...meeting('d', 'publishing') }], [], null)).toMatchObject([{ kind: 'checking', review: { status: 'publishing' } }]);
  });

  it('makes every item that waits on you an Update row, in the order Home read them, whatever check an older Authority still sends', async () => {
    const { needRows } = await import('../../src/renderer/store.js');
    const checked = (id: string, verdict: 'changed' | 'landed'): OpenItemView => ({ ...item(id), check: { verdict, checked_at: '2026-10-08T12:00:00.000Z', checked_by: 'Mina Patel' } });
    const open: HomeView = { ...emptyHome(), items: [item('1'), checked('2', 'changed'), item('3'), checked('4', 'landed')] };
    expect(needRows([], [], open).map(row => [row.kind, 'item' in row ? row.item.item_id : null])).toEqual([
      ['update', 'itm_00000001'], ['update', 'itm_00000002'], ['update', 'itm_00000003'], ['update', 'itm_00000004'],
    ]);
  });

  it('groups rows by what they ask of you: Approve, Retry, Send, Update, then Checking, each newest first', async () => {
    const { categoryOf, homeCategories, needAt } = await import('../../src/renderer/store.js');
    type Row = Parameters<typeof categoryOf>[0];
    const approve = (id: string, meeting_at: string | null): Row => ({ kind: 'approve', review: { ...meeting(id, 'pending'), meeting_at } });
    const send = (id: string, finished_at: string): Row => ({ kind: 'send', send: { ...sendRow(), run_id: `run_${id}`, finished_at } });
    const update = (id: string, moved: Partial<OpenItemView>): Row => ({ kind: 'update', item: { ...item(id), ...moved } });
    const rows: Row[] = [
      approve('a', '2026-10-06T12:00:00.000Z'), approve('e', null),
      { kind: 'failed', review: meeting('b', 'approved'), run: impactRun('failed', '22') },
      send('old', '2026-10-07T10:00:00.000Z'), send('new', '2026-10-08T10:00:00.000Z'),
      update('3', { state_set_at: '2026-10-09T09:00:00.000Z' }), update('1', {}), update('5', { owner_set_at: '2026-10-12T09:00:00.000Z' }),
      { kind: 'checking', review: meeting('d', 'publishing') },
    ];
    expect(rows.map(categoryOf)).toEqual(['approve', 'approve', 'retry', 'send', 'send', 'update', 'update', 'update', 'checking']);
    const categories = homeCategories(rows);
    expect(categories.map(each => [each.category, each.rows.length])).toEqual([['approve', 2], ['retry', 1], ['send', 2], ['update', 3], ['checking', 1]]);
    // Meetings keep the reviews' order, the newest first; a meeting's age is when it met, and it has none when the tool did not say.
    expect(categories[0]!.rows).toEqual(rows.slice(0, 2));
    expect(categories[0]!.rows.map(needAt)).toEqual(['2026-10-06T12:00:00.000Z', null]);
    // The others, newest first by when they last moved: a Send when its check finished, a follow-up when it was sent, handed on or set.
    expect(categories[2]!.rows.map(row => 'send' in row && row.send.run_id)).toEqual(['run_new', 'run_old']);
    expect(categories[3]!.rows.map(row => 'item' in row && row.item.item_id)).toEqual(['itm_00000005', 'itm_00000003', 'itm_00000001']);
    expect(categories[3]!.rows.map(needAt)).toEqual(['2026-10-12T09:00:00.000Z', '2026-10-09T09:00:00.000Z', '2026-10-08T11:00:00.000Z']);
    // A check's age is its run's last move; a kind with no rows is no category.
    expect(needAt(rows[2]!)).toBe(impactRun('failed', '22').updated_at);
    expect(homeCategories(rows.slice(5, 8)).map(each => each.category)).toEqual(['update']);
  });

  it('names an Approve row\'s meeting and its day', async () => {
    const { ReviewLine } = await import('../../src/renderer/screens/home.js');
    const row = { kind: 'approve' as const, review: { ...meeting('a', 'pending'), title: 'Pilot planning', meeting_at: '2026-10-06T12:00:00.000Z' } };
    expect(text(render(ReviewLine({ row })))).toBe('Decision · Pilot planning meeting, Oct 6');
  });

  it('names a whole day by its UTC date, the same day in any time zone', async () => {
    const { ReviewLine } = await import('../../src/renderer/screens/home.js');
    // An all-day event can be represented at noon or midnight UTC: either is Oct 21, from UTC-12 to UTC+14.
    for (const meeting_at of ['2026-10-21T12:00:00.000Z', '2026-10-21T00:00:00.000Z']) {
      const row = { kind: 'approve' as const, review: { ...meeting('a', 'pending'), title: 'Supplier sync', meeting_at, all_day: true } };
      expect(text(render(ReviewLine({ row })))).toBe('Decision · Supplier sync meeting, Oct 21');
    }
  });

  it('opens a row\'s second line with where and when: the first project Home knows, "+N" for more, then the time', async () => {
    const { Where } = await import('../../src/renderer/screens/home.js');
    const supplier = { ...project, project_id: 'prj_22222222-2222-4222-8222-222222222222', name: 'Supplier review' };
    const state = { projects: { items: [supplier, project] }, archivedProjects: { items: [] } } as unknown as Parameters<typeof Where>[0]['state'];
    const fiveAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const tree = render(Where({ state, at: fiveAgo, projects: [supplier.project_id, project.project_id, 'prj_33333333-3333-4333-8333-333333333333'] }));
    const part = (name: string) => elements(tree).find(node => node.props.class === name);
    // Its mark and name, "+1" for the other project Home knows (one it does not know is left out), all of them in its tooltip.
    expect(text(part('need-dot'))).toBe('S');
    expect([text(part('need-where-name')), text(part('need-where-more'))]).toEqual(['Supplier review', '+1']);
    expect(part('need-where')!.props.title).toBe('Supplier review, Thermostat redesign');
    expect(text(part('need-when'))).toBe('5m');
    expect(text(tree)).toMatch(/ · 5m · $/);
    // A follow-up's row has no time: its project, then the row's own words.
    expect(text(render(Where({ state, projects: [project.project_id] })))).toBe('TThermostat redesign · ');
    // No project Home knows: it starts with the time; with neither, there is nothing to open the line.
    expect(text(render(Where({ state, at: fiveAgo, projects: ['prj_33333333-3333-4333-8333-333333333333'] })))).toBe('5m · ');
    expect(Where({ state, projects: [] })).toBeNull();
  });
});

describe('Home decisions and impact checks', () => {
  it('says when the meeting was already approved, or rejected, in Slack', async () => {
    const store = await start();
    for (const [decision, status] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
      await store.openDecision(approval);
      await flush();
      rpc.mockImplementationOnce(async () => ok({ status, decided_on: 'slack' }));
      await store.decide(decision);
      expect(store.getState().toast).toBe(`Already ${status} in Slack`);
      expect(store.getState().route).toEqual({ page: 'home' });
    }
  });
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
    store.setDecisionRoute('act-1', null);
    const reviews = () => rpc.mock.calls.filter(([method, params]) => method === 'reviews' && params.request?.operation === 'review').map(([, params]) => params.request);
    rpc.mockImplementationOnce(async () => fail('timeout', { retryable: true, mutation_outcome: 'unknown' }));
    await store.decide('approve');
    expect(store.getState().decision).toMatchObject({ busy: false, unknown: true, failure: 'This may not have been sent.' });
    store.setDecisionRoute('act-1', store.ONLY_ME);
    store.setDecisionRoutes({ projects: [project.project_id], private: false });
    store.setDecisionOwner('act-1', 'Someone else');
    expect(store.getState().decision).toMatchObject({ routes: { 'dec-1': store.ONLY_ME, 'act-1': null }, owners: { 'act-1': 'Rafael Moreno' } });
    rpc.mockImplementationOnce(async () => ok({ status: 'approved', decided_on: 'desktop' }));
    await store.decide('approve');
    expect(reviews()).toHaveLength(2);
    expect(reviews()[1]).toEqual(reviews()[0]);
    // Every item in order with where it goes; no owner for the action not kept.
    expect(reviews()[0]).toMatchObject({ action: 'approve', routes: [{ signal_id: 'dec-1', project_ids: [] }, { signal_id: 'act-1', project_ids: null }], owners: [] });
    expect(store.getState().toast).toBe('Approved · checking what it changes');
  });

  it('starts each item at the review\'s destination, and sends every item\'s route and the owners of kept actions', async () => {
    const store = await start();
    await store.openDecision(approval);
    await flush();
    expect(store.getState().decision).toMatchObject({ routes: { 'dec-1': store.ONLY_ME, 'act-1': store.ONLY_ME }, owners: { 'act-1': 'Rafael Moreno' } });
    const to = (...projects: string[]) => ({ projects, private: false });
    // One item to a project, then another ticked on and off: unticking its last project leaves it Only me.
    store.tickDecisionRoute('dec-1', project.project_id);
    store.tickDecisionRoute('act-1', project.project_id);
    store.tickDecisionRoute('act-1', project.project_id);
    expect(store.getState().decision?.routes).toEqual({ 'dec-1': to(project.project_id), 'act-1': store.ONLY_ME });
    // All items: every kept item at once; Don't keep keeps none, and then a destination goes to every item.
    store.setDecisionRoutes(null);
    expect(store.keptItems(store.getState().decision!)).toEqual([]);
    store.tickDecisionRoutes(project.project_id);
    expect(store.getState().decision?.routes).toEqual({ 'dec-1': to(project.project_id), 'act-1': to(project.project_id) });
    store.setDecisionRoute('dec-1', null);
    store.setDecisionRoutes(store.ONLY_ME);
    expect(store.getState().decision?.routes).toEqual({ 'dec-1': null, 'act-1': store.ONLY_ME });
    // No more than 20 projects in all.
    const many = Array.from({ length: 21 }, (_, index) => `prj_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    store.setDecisionRoute('act-1', to(...many.slice(0, 20)));
    store.setDecisionRoute('dec-1', to(...many.slice(20)));
    expect(store.getState().decision?.routes).toEqual({ 'dec-1': null, 'act-1': to(...many.slice(0, 20)) });
    store.setDecisionOwner('act-1', ' R. Moreno ');
    rpc.mockImplementationOnce(async () => ok({ status: 'publishing', decided_on: 'desktop' }));
    await store.decide('approve');
    const sent = rpc.mock.calls.filter(([method, params]) => method === 'reviews' && params.request?.operation === 'review').map(([, params]) => params.request);
    expect(sent).toEqual([expect.objectContaining({ action: 'approve', routes: [{ signal_id: 'dec-1', project_ids: null }, { signal_id: 'act-1', project_ids: many.slice(0, 20) }],
      owners: [{ signal_id: 'act-1', owner: 'R. Moreno' }] })]);
  });

  it('ticks a project on every kept item from All items while they differ, each keeping its others, and unticks one they all have', async () => {
    const store = await start();
    await store.openDecision(approval);
    await flush();
    const [therm, echo, supplier] = ['prj_11111111-1111-4111-8111-111111111111', 'prj_22222222-2222-4222-8222-222222222222', 'prj_44444444-4444-4444-8444-444444444444'];
    const routes = () => store.getState().decision?.routes;
    const to = (...projects: string[]) => ({ projects, private: false });
    store.setDecisionRoute('dec-1', to(echo, therm));
    store.setDecisionRoute('act-1', to(therm));
    // SUPPLIER goes on both, and neither loses what it had.
    store.tickDecisionRoutes(supplier);
    expect(routes()).toEqual({ 'dec-1': to(therm, echo, supplier), 'act-1': to(therm, supplier) });
    // ECHO, on one of them, goes on the other too; on both, it comes off both.
    store.tickDecisionRoutes(echo);
    expect(routes()).toEqual({ 'dec-1': to(therm, echo, supplier), 'act-1': to(therm, echo, supplier) });
    store.tickDecisionRoutes(echo);
    expect(routes()).toEqual({ 'dec-1': to(therm, supplier), 'act-1': to(therm, supplier) });
    // An item not kept stays so; a kept one left with no project is Only me.
    store.setDecisionRoute('act-1', null);
    store.tickDecisionRoutes(therm);
    store.tickDecisionRoutes(supplier);
    expect(routes()).toEqual({ 'dec-1': store.ONLY_ME, 'act-1': null });
    // At most 20 projects in all: a 21st goes on no item, and one the meeting names already goes on every kept item.
    const many = Array.from({ length: 21 }, (_, index) => `prj_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    store.setDecisionRoute('dec-1', to(...many.slice(0, 19)));
    store.setDecisionRoute('act-1', to(...many.slice(19, 20)));
    store.tickDecisionRoutes(many[20]!);
    expect(routes()).toEqual({ 'dec-1': to(...many.slice(0, 19)), 'act-1': to(...many.slice(19, 20)) });
    store.tickDecisionRoutes(many[19]!);
    expect(routes()).toEqual({ 'dec-1': to(...many.slice(0, 20)), 'act-1': to(...many.slice(19, 20)) });
  });

  it('keeps an item for you alone in its projects with the Only me lock, which stays pressed while they stay ticked, and sends it as private', async () => {
    const store = await start();
    await store.openDecision(approval);
    await flush();
    const [therm, echo] = ['prj_11111111-1111-4111-8111-111111111111', 'prj_22222222-2222-4222-8222-222222222222'];
    const routes = () => store.getState().decision?.routes;
    const to = (...projects: string[]) => ({ projects, private: false }), mine = (...projects: string[]) => ({ projects, private: true });
    // A project chosen from Only me starts unlocked, as Capture's does; the lock then stays while projects stay ticked.
    store.tickDecisionRoute('dec-1', therm);
    expect(routes()?.['dec-1']).toEqual(to(therm));
    store.lockDecisionRoute('dec-1');
    store.tickDecisionRoute('dec-1', echo);
    expect(routes()?.['dec-1']).toEqual(mine(therm, echo));
    store.tickDecisionRoute('dec-1', echo);
    expect(routes()?.['dec-1']).toEqual(mine(therm));
    // The lock turns off again; on an item in no project it is Only me, and unticking the last project leaves Only me.
    store.lockDecisionRoute('dec-1');
    expect(routes()?.['dec-1']).toEqual(to(therm));
    store.lockDecisionRoute('dec-1');
    store.lockDecisionRoute('act-1');
    expect(routes()).toEqual({ 'dec-1': mine(therm), 'act-1': store.ONLY_ME });
    // All items: the lock turns on or off every kept item filed in a project, and leaves Only me as it is.
    store.lockDecisionRoutes();
    expect(routes()).toEqual({ 'dec-1': to(therm), 'act-1': store.ONLY_ME });
    store.lockDecisionRoutes();
    expect(routes()).toEqual({ 'dec-1': mine(therm), 'act-1': store.ONLY_ME });
    // An item in no project beside one kept for you alone in THERM: a project ticked from All items keeps each item's own
    // lock, so the item in no project is shared there; the one every item has comes off each.
    store.tickDecisionRoutes(echo);
    expect(routes()).toEqual({ 'dec-1': mine(therm, echo), 'act-1': to(echo) });
    store.tickDecisionRoutes(echo);
    expect(routes()).toEqual({ 'dec-1': mine(therm), 'act-1': store.ONLY_ME });
    // Every item in no project: a project ticked from All items shares them, as from one item's place menu.
    store.setDecisionRoutes(store.ONLY_ME);
    store.tickDecisionRoutes(therm);
    expect(routes()).toEqual({ 'dec-1': to(therm), 'act-1': to(therm) });
    // Every item kept for you alone in a project: a project ticked keeps them so.
    store.setDecisionRoutes(mine(therm));
    store.tickDecisionRoutes(echo);
    expect(routes()).toEqual({ 'dec-1': mine(therm, echo), 'act-1': mine(therm, echo) });
    // The same projects shared and kept for you alone are two destinations, and All items sets one for both.
    store.setDecisionRoute('dec-1', mine(therm));
    store.setDecisionRoute('act-1', to(therm));
    expect(routes()).toEqual({ 'dec-1': mine(therm), 'act-1': to(therm) });
    store.setDecisionRoutes(mine(therm));
    expect(routes()).toEqual({ 'dec-1': mine(therm), 'act-1': mine(therm) });
    store.setDecisionRoute('act-1', to(therm));
    rpc.mockImplementationOnce(async () => ok({ status: 'publishing', decided_on: 'desktop' }));
    await store.decide('approve');
    const sent = rpc.mock.calls.filter(([method, params]) => method === 'reviews' && params.request?.operation === 'review').map(([, params]) => params.request);
    expect(sent).toEqual([expect.objectContaining({ action: 'approve', routes: [{ signal_id: 'dec-1', project_ids: [therm], private: true }, { signal_id: 'act-1', project_ids: [therm] }] })]);
  });

  it('leaves every item as it is from either lock when none is filed in a project: the lock never moves an item', async () => {
    const store = await start();
    await store.openDecision(approval);
    await flush();
    store.setDecisionRoutes(null);
    store.lockDecisionRoutes();
    store.lockDecisionRoute('dec-1');
    expect(store.getState().decision?.routes).toEqual({ 'dec-1': null, 'act-1': null });
    store.setDecisionRoutes(store.ONLY_ME);
    store.lockDecisionRoutes();
    store.lockDecisionRoute('act-1');
    expect(store.getState().decision?.routes).toEqual({ 'dec-1': store.ONLY_ME, 'act-1': store.ONLY_ME });
  });

  it('keeps a publishing approval visible, and shows its check start, then what it found, as the change check sees the reviews move', async () => {
    fx.review = { ...fx.review, status: 'publishing', decided_on: 'desktop' };
    const store = await start();
    expect(store.homeRows()).toMatchObject([{ kind: 'checking', review: { status: 'publishing' } }]);
    expect(store.needsCount()).toBe(0);
    const { ReviewLine } = await import('../../src/renderer/screens/home.js');
    const row = store.homeRows()[0] as Parameters<typeof ReviewLine>[0]['row'];
    expect(text(render(ReviewLine({ row })))).toBe('Approved · publishing to ECHO');
    // Published, its check queued: the reviews move. The next change check checks in, so the Authority starts the check, and
    // Home reads it going.
    fx.review = { ...fx.review, status: 'approved' };
    fx.run = impactRun('pending');
    fx.moved.reviews = 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkIns()).toEqual(['member', 'member']);
    expect(store.homeRows()).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
    // It ends, and the reviews move again: the next change check reads what it found.
    fx.run = impactRun('done');
    fx.home = { ...emptyHome(), send: [sendRow()] };
    fx.moved.reviews = 2;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.homeRows()).toMatchObject([{ kind: 'send', send: { run_id: fx.run.run_id } }]);
    expect(store.needsCount()).toBe(1);
    // Home never starts a check itself, and reads nothing more until something moves.
    expect(requests('start')).toEqual([]);
    await expectQuiet();
  });

  it('refreshes an open decision when its check finishes while the app is hidden', async () => {
    const store = await checking();
    await store.openDecision(approval, fx.run);
    cover(store);
    await vi.advanceTimersByTimeAsync(5_000);
    fx.run = impactRun('done');
    uncover(store);
    await flush();
    expect(store.getState().decision?.runs[0]?.state).toBe('done');
    // Its follow-ups, counted by its check for the record's line; its card is never asked for.
    expect(operations()).not.toContain('view');
    expect(store.getState().decision?.lines[fx.run.run_id]).toMatchObject({ summary: { unsent: 1 } });
    expect(requests('items').at(-1)).toEqual({ schema_version: 1, operation: 'items', scope: 'run', id: fx.run.run_id, read: 'counts' });
  });

  it('keeps the rows a failed home read had, and shows no error for it', async () => {
    fx.home = { ...emptyHome(), items: [item('1')], waiting: 1 };
    const store = await start();
    expect(store.homeRows().map(row => row.kind)).toEqual(['approve', 'update']);
    fx.failNextHome = true;
    await store.loadHome();
    expect(store.homeRows().map(row => row.kind)).toEqual(['approve', 'update']);
    expect(store.getState().home?.open?.waiting).toBe(1);
    expect(store.getState().home?.failure).toBeUndefined();
  });

  it('keeps an initial runs-list failure silent and recovers when Home is read again', async () => {
    fx.failNextList = true;
    const store = await checking();
    expect(store.getState().home).toMatchObject({ loading: false, failure: undefined });
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.mock.calls).toHaveLength(requests);
    await store.loadHome();
    expect(store.getState().home?.failure).toBeUndefined();
    expect(store.homeRows()).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
  });

  it('resumes a failed Home on a return, with what its check found meanwhile', async () => {
    const store = await checking();
    fx.run = impactRun('done');
    fx.home = { ...emptyHome(), send: [sendRow()] };
    fx.failNextHome = true;
    fx.failNextReviews = true;
    await store.loadHome();
    expect(store.getState().home?.failure).toMatchObject({ code: 'unavailable' });
    expect(store.homeRows()).toHaveLength(0);
    cover(store);
    await vi.advanceTimersByTimeAsync(60_000);
    uncover(store);
    await flush();
    expect(store.getState().home?.failure).toBeUndefined();
    expect(store.homeRows()).toMatchObject([{ kind: 'send', send: { run_id: fx.run.run_id } }]);
  });

  it('keeps Home\'s and an open decision\'s checks through returns whose runs read fails, and reads them again when the reviews move', async () => {
    const store = await checking();
    await store.openDecision(approval, fx.run);
    for (let back = 0; back < 2; back += 1) {
      cover(store);
      fx.failNextList = true;
      uncover(store);
      await flush();
      expect(store.homeRows()).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
      expect(store.getState().home?.failure).toBeUndefined();
      expect(store.getState().decision?.runs[0]?.state).toBe('running');
    }
    // The check ends, and the reviews move: the next change check reads Home, and so the decision's checks, again.
    fx.run = impactRun('done');
    fx.home = { ...emptyHome(), send: [sendRow()] };
    fx.moved.reviews = 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getState().home?.failure).toBeUndefined();
    expect(store.homeRows()).toMatchObject([{ kind: 'send', send: { run_id: fx.run.run_id } }]);
    expect(store.getState().decision?.runs[0]?.state).toBe('done');
    expect(store.getState().decision?.lines[fx.run.run_id]).toBeDefined();
  });

  it('asks for a change check at once on Approve, though the decision page checked just before: it checks in (DSK-1)', async () => {
    const store = await start();
    await vi.advanceTimersByTimeAsync(10_000);
    await store.openDecision(approval);
    await flush();
    const checks = () => rpc.mock.calls.filter(([method]) => method === 'changes.read').length;
    const [checked, checkedIn] = [checks(), checkIns().length];
    // Back on Home within ten seconds of that check, a page opened alone would not ask for another.
    rpc.mockImplementationOnce(async () => ok({ status: 'publishing', decided_on: 'desktop' }));
    await store.decide('approve');
    await flush();
    expect(store.getState().route).toEqual({ page: 'home' });
    expect([checks(), checkIns().length]).toEqual([checked + 1, checkedIn + 1]);
    // A rejection asks for none.
    await vi.advanceTimersByTimeAsync(10_000);
    await store.openDecision(approval);
    await flush();
    const before = checks();
    rpc.mockImplementationOnce(async () => ok({ status: 'rejected', decided_on: 'desktop' }));
    await store.decide('reject');
    await flush();
    expect(checks()).toBe(before);
    expect(requests('start')).toEqual([]);
  });
});

describe('Checks keep moving (one place to look v1; DSK-1)', () => {
  /** Another meeting's check, of a record of its own, queued behind Pilot planning's. */
  const further = (state: PersonRunV1['state']) => impactRun(state, '21', 'apr_' + 'e'.repeat(64));
  /** Home's own reads: the meeting reviews and what waits on you. */
  const homeReads = () => rpc.mock.calls.filter(([method, params]) => (method === 'reviews' && params.request?.operation === 'reviews') || (method === 'runs' && params.request.operation === 'home')).length;

  it('starts no check from Home: however often it loads it reads the runs list, and only each change check checks in', async () => {
    fx.review = { ...fx.review, status: 'approved', decided_on: 'desktop' };
    fx.run = impactRun('pending');
    fx.more = [further('pending')];
    const store = await start();
    // Sign-in's change check checked in once: the Authority started the oldest.
    expect(checkIns()).toEqual(['member']);
    expect(fx.more).toMatchObject([{ state: 'running' }]);
    const lists = requests('list').length;
    await store.loadHome();
    await show(store);
    await flush();
    store.goHome();
    await flush();
    // Three more loads: each read the runs list; only the return's change check checked in.
    expect(requests('list').length).toBeGreaterThanOrEqual(lists + 3);
    expect(checkIns()).toEqual(['member', 'member']);
    expect(requests('start')).toEqual([]);
    expect(store.homeRows()).toMatchObject([{ kind: 'checking', run: { run_id: impactRun('pending').run_id, state: 'pending' } }]);
  });

  it.each([
    ['on another page', (store: Store) => store.openProject(project), (store: Store) => { store.goHome(); return flush(); }],
    ['while another app is in front', (store: Store) => { cover(store); return flush(); }, uncover],
    ['while the window is closed to the tray', (store: Store) => { hide(store); return flush(); }, show],
  ] as const)('keeps checks moving %s: each change check checks in, and Home reads nothing until it shows, then what they found', async (_, away, back) => {
    const store = await checking();
    await away(store);
    const home = homeReads();
    const checkedIn = checkIns().length;
    // The check ends with another meeting's queued behind it, and the reviews move: the next change check checks in, and the
    // Authority starts that one.
    fx.run = impactRun('done');
    fx.more = [further('pending')];
    fx.home = { ...emptyHome(), send: [sendRow()] };
    fx.moved.reviews = 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkIns()).toHaveLength(checkedIn + 1);
    expect(fx.more).toMatchObject([{ state: 'running' }]);
    // Home is neither read nor changed meanwhile: it still shows the check as it last read it.
    expect(homeReads()).toBe(home);
    expect(store.homeRows()).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
    // Back: Home reads what the check found.
    await back(store);
    await flush();
    expect(homeReads()).toBeGreaterThan(home);
    expect(store.homeRows()).toMatchObject([{ kind: 'send', send: { run_id: fx.run.run_id } }]);
    expect(requests('start')).toEqual([]);
  });
});


describe('Follow-up lists and item pages', () => {
  /** A page of follow-ups, counted by status. */
  const listPage = (items: OpenItemView[]): OpenItemsView => ({ items, next_cursor: null, stages: [], summary: {
    ...EMPTY_SUMMARY, decisions: 1, unsent: items.filter(entry => entry.state === 'unsent').length, open: items.filter(entry => entry.state === 'open').length,
    done: items.filter(entry => entry.state === 'done').length, not_relevant: items.filter(entry => entry.state === 'not_relevant').length } });
  const list = (store: Store) => store.followUpShown() as FollowUpList;
  const said = (store: Store) => (store.followUpShown() as FollowUpList | ItemPage | null)?.said;
  /** What main's quit guard was told last. */
  const told = () => rpc.mock.calls.filter(([method]) => method === 'app.setUnresolved').map(([, params]) => params).at(-1);
  const other = 'run_00000000-0000-4000-8000-000000000021';
  const rafael = { membership_id: RAFAEL.membership_id, name: RAFAEL.display_name, active: true };

  beforeEach(() => { fx.listed = false; });

  it('ticks every Not sent row you may send on a meeting\'s first read', async () => {
    fx.page = listPage([unsent('1'), unsent('2'), { ...unsent('3'), can: { set_state: false, assign: false } }, item('4')]);
    const store = await meetingList();
    expect(list(store)).toMatchObject({ kind: 'list', scope: 'record', id: record, title: 'Pilot planning', loading: false });
    expect(list(store).ticks).toEqual({ itm_00000001: true, itm_00000002: true });
    // Back from it is Home.
    store.closeFollowUp();
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.followUpShown()).toBeNull();
  });

  it('sends only the ticked rows, one send per check with a command of its own, and stays on the list, read again', async () => {
    fx.page = listPage([unsent('1'), unsent('2'), unsent('3', other)]);
    const store = await start();
    await store.openYourFollowUps();
    store.tickFollowUp('itm_00000001');
    store.tickFollowUp('itm_00000003');
    fx.page = listPage([item('1'), unsent('2'), { ...item('3'), run_id: other }]);
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

  it('settles a send whose outcome is unknown by the rows read again: one that did not go replays its command, one that went says so and replays no more', async () => {
    fx.page = listPage([unsent('1'), unsent('2')]);
    const store = await meetingList();
    store.tickFollowUp('itm_00000002');
    fx.sendFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    await store.sendTicked(true);
    // Its row, read again, is still not sent: it did not go, and Send again replays it.
    expect(said(store)).toEqual({ words: 'Not sent. Try again.', error: true });
    // Nothing holds quit or sign out: the list was read again, and shows what is so.
    expect(told()).toEqual({ unresolved: false });
    // Its outcome unknown again, it went: the row, read again in place, is open.
    fx.page = listPage([item('1'), unsent('2')]);
    await store.sendTicked(true);
    const [first, again] = requests('send');
    expect(again).toEqual(first);
    expect(said(store)).toEqual({ words: 'Sent to Fixture' });
    expect(list(store).sends).toEqual({});
    expect(list(store).items.find(entry => entry.item_id === 'itm_00000001')?.state).toBe('open');
    // Read again in place: the list's rows, rows only, which settle it; no item read on its own, nothing read live.
    expect(requests('item')).toEqual([]);
    expect(requests('items').at(-1)?.read).toBe('rows');
    // Any other choice is another command.
    store.tickFollowUp('itm_00000002');
    await store.sendTicked(false);
    expect(requests('send')[2]?.command_id).not.toBe(first?.command_id);
  });

  it('says a send refused as a conflict changed meanwhile, keeping the account; lost access reads the account again', async () => {
    fx.page = listPage([unsent('1')]);
    const store = await meetingList();
    const statusReads = () => rpc.mock.calls.filter(([method]) => method === 'app.status').length;
    const before = statusReads();
    const reads = requests('items').length;
    fx.sendFailure = { code: 'conflict', retryable: false };
    await store.sendTicked(true);
    expect(said(store)).toEqual({ words: 'That changed meanwhile.', error: true });
    // The list read again rows only, as far as it showed: a change reads nothing live.
    expect(requests('items').slice(reads).map(request => request.read)).toEqual(['rows']);
    expect(requests('item')).toEqual([]);
    await flush();
    expect(statusReads()).toBe(before);
    store.setBarText('launch plan');
    fx.sendFailure = { code: 'stale_access_state', retryable: false };
    await store.sendTicked(true);
    await flush();
    expect(said(store)).toEqual({ words: 'That changed meanwhile, or your access did. Refresh and try again.', error: true });
    expect(store.getState().barText).toBe('launch plan');
    expect(statusReads()).toBe(before + 1);
  });

  it('changes an item on its page and stays there, saying what happened, and Back reads Home again', async () => {
    fx.home = { ...emptyHome(), items: [item('1')] };
    const store = await start();
    fx.readItem = item('1');
    await store.openFollowUp('itm_00000001', store.getState().home!.open!.items[0]!);
    fx.readItem = { ...item('1'), state: 'done' };
    await store.setFollowUpState('done');
    expect(store.followUpShown()).toMatchObject({ kind: 'item', busy: false, loading: false, said: { words: 'Done', undo: true }, item: { state: 'done' } });
    fx.readItem = item('1');
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
    fx.readItem = unsent('1');
    const store = await start();
    // A notification knows the item's id only: its page reads it.
    const opening = store.openFollowUp('itm_00000001');
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id: 'itm_00000001', item: null, loading: true });
    await opening;
    expect(store.followUpShown()).toMatchObject({ item: { state: 'unsent' } });
    fx.readItem = { ...unsent('1'), state: 'not_relevant', sent_at: '2026-10-08T12:00:00.000Z', state_set_at: '2026-10-08T12:00:00.000Z', send_included: false, can: { set_state: true, assign: true } };
    await store.sendFollowUp(false);
    expect(requests('send')).toEqual([expect.objectContaining({ run_id: impactRun('done').run_id, items: [{ item_id: 'itm_00000001', include: false }] })]);
    // A dismissal before sending is never undone (F6).
    expect(said(store)).toEqual({ words: 'Dismissed' });
    fx.readItem = { ...fx.readItem, state: 'open', send_included: false };
    await store.setFollowUpState('open');
    expect(said(store)).toEqual({ words: 'Sent to Fixture' });
    expect(requests('set_state')).toEqual([expect.objectContaining({ item_id: 'itm_00000001', state: 'open' })]);
  });

  it('keeps a page whose change is on its way, and its next step, until the change is answered', async () => {
    fx.readItem = item('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', item('1'));
    fx.hold.setState = true;
    const marking = store.setFollowUpState('done');
    await flush();
    expect(store.followUpShown()).toMatchObject({ kind: 'item', busy: true });
    store.closeFollowUp();
    await store.setFollowUpState('not_relevant');
    expect(store.followUpShown()).toMatchObject({ kind: 'item', busy: true });
    expect(requests('set_state')).toHaveLength(1);
    release('setState');
    await marking;
    expect(store.followUpShown()).toMatchObject({ kind: 'item', busy: false, said: { words: 'Done', undo: true } });
  });

  it('reads the view under an item page again once a change was made on it, and forgets what that view said', async () => {
    fx.page = listPage([unsent('1'), item('2')]);
    const store = await meetingList();
    await store.sendTicked(false);
    expect(said(store)).toEqual({ words: 'Dismissed' });
    fx.readItem = item('2');
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
    fx.page = listPage([unsent('1')]);
    const store = await meetingList();
    store.toggleOwnerPicker('itm_00000001');
    await flush();
    const picker = (store.followUpShown() as FollowUpList).picker!;
    expect(picker).toMatchObject({ item_id: 'itm_00000001', loading: false, results: [RAFAEL] });
    const opened = requests('items').length;
    fx.page = listPage([{ ...unsent('1'), owner: { ...rafael, match: 'picked' } }]);
    await store.pickFollowUpOwner(RAFAEL);
    expect(requests('assign')).toEqual([{ schema_version: 1, operation: 'assign', item_id: 'itm_00000001', owner_membership_id: RAFAEL.membership_id }]);
    // By first name, as the chips say.
    expect(said(store)).toEqual({ words: 'Owner changed to Rafael' });
    // The row read again on its own, rows only, and the list's counts: it moves in place, and nothing is read live.
    expect(list(store).items[0]?.owner.name).toBe('Rafael Moreno');
    expect(requests('items').slice(opened).map(request => request.read)).toEqual(['counts']);
    expect(requests('item')).toEqual([{ schema_version: 1, operation: 'item', item_id: 'itm_00000001', read: 'rows' }]);
    // A reply that was lost: the row read again says whether it went.
    fx.assignFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    for (const [owner, words] of [[unsent('1').owner, { words: 'It was not saved. Try again.', error: true }], [{ ...rafael, match: 'picked' as const }, { words: 'Owner changed to Rafael' }]] as const) {
      fx.page = listPage([{ ...unsent('1'), owner }]);
      store.toggleOwnerPicker('itm_00000001');
      await flush();
      await store.pickFollowUpOwner(RAFAEL);
      expect(said(store)).toEqual(words);
    }
    expect(told()).toEqual({ unresolved: false });
    // One that was refused says why, and its row is read again to show what is so now.
    fx.assignFailure = { code: 'not_found', retryable: false };
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
      ...EMPTY_SUMMARY, decisions: 1, unsent: items.filter(entry => entry.state === 'unsent').length, open: items.filter(entry => entry.state === 'open').length,
      done: items.filter(entry => entry.state === 'done').length, not_relevant: items.filter(entry => entry.state === 'not_relevant').length } });
  const list = (store: Store) => store.followUpShown() as FollowUpList;
  const said = (store: Store) => (store.followUpShown() as FollowUpList | ItemPage | null)?.said;
  const ids = (store: Store) => list(store).items.map(entry => entry.item_id.slice(-1));
  /** The list's reads: rows only, or live (" live"), by states and cursor; never a line's counts or a check's rows. */
  const reads = () => requests('items').filter(request => request.read !== 'counts' && request.scope !== 'run')
    .map(request => `${(request.states as string[]).join('+')}${request.cursor ? ` ${request.cursor}` : ''}${request.read === 'rows' ? '' : ' live'}`);
  const done = (id: string): OpenItemView => ({ ...item(id), state: 'done', state_set_at: '2026-10-08T12:00:00.000Z' });
  const other = 'run_00000000-0000-4000-8000-000000000021';

  beforeEach(() => { fx.listed = false; });

  it('reads current work first, each closed group once it opens, each with its own More, and Try again repeats the read that failed', async () => {
    // Three closed rows older than all current work: a read of every status would show only them on its first page.
    fx.page = listPage([done('1'), done('2'), done('3'), unsent('4'), item('5'), item('6')]);
    fx.pageSize = 2;
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
    fx.failItems = 1;
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
    fx.page = listPage([done('1'), done('2'), unsent('3'), item('4'), item('5')]);
    fx.pageSize = 2;
    fx.failItems = 1;
    const store = await start();
    await store.openFollowUps('project', project.project_id, project.name);
    expect(list(store)).toMatchObject({ failed: { read: 'first' }, items: [] });
    await store.retryFollowUps();
    await store.moreFollowUps('active');
    store.toggleClosedGroup('done');
    await flush();
    expect(ids(store)).toEqual(['3', '4', '5', '1', '2']);
    // A change made on a row's page: Back reads each part again, as far as it showed.
    fx.readItem = item('4');
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
    fx.failItems = 1;
    store.closeFollowUp();
    await flush();
    expect(list(store).failed).toMatchObject({ read: 'again' });
    expect(ids(store)).toEqual(['3', '4', '5', '1', '2']);
  });

  it('says what went and what did not when only some sends did', async () => {
    fx.page = listPage([unsent('1'), unsent('2', other)]);
    const store = await meetingList();
    // The second check's send fails: the first went.
    fx.sendFailure = { code: 'unavailable', retryable: true };
    fx.sendFailsFor = other;
    fx.page = listPage([item('1'), unsent('2', other)]);
    await store.sendTicked(true);
    expect(said(store)).toEqual({ words: 'Sent to Fixture · 1 not sent, try again', error: true });
    expect(list(store).ticks).toEqual({ itm_00000002: true });
  });

  it.each([
    ['the list closes', (store: Store) => store.goHome()],
    ['the account changes', (store: Store) => { fx.member = 'someone-else'; return store.refreshStatus(); }],
  ] as const)('stops sending once %s while its first send is on its way', async (_, interrupt) => {
    fx.page = listPage([unsent('1'), unsent('2', other)]);
    const store = await meetingList();
    fx.hold.send = true;
    const sending = store.sendTicked(true);
    await flush();
    await interrupt(store);
    release('send');
    await sending;
    expect(requests('send')).toHaveLength(1);
  });

  it('goes back to a meeting\'s list already open under its item page, keeping its ticks, instead of opening it again', async () => {
    fx.page = listPage([unsent('1'), unsent('2')]);
    const store = await meetingList();
    store.tickFollowUp('itm_00000002');
    fx.readItem = unsent('1');
    await store.openFollowUp('itm_00000001', unsent('1'));
    expect(list(store)).toBeTruthy();
    const before = requests('items').length;
    await store.openFollowUps('record', record, 'Pilot planning');
    expect(store.getState().followUps?.views).toHaveLength(1);
    expect(list(store)).toMatchObject({ kind: 'list', opened: 'itm_00000001', ticks: { itm_00000001: true } });
    expect(requests('items')).toHaveLength(before);
  });

  it('opens a meeting\'s decision over its list, and its follow-ups line goes back to the list', async () => {
    fx.review = { ...fx.review, status: 'approved', decided_on: 'desktop' };
    fx.page = listPage([unsent('1')]);
    const store = await meetingList();
    await store.openListDecision();
    expect(store.followUpShown()).toMatchObject({ kind: 'decision' });
    // The list is one record's; the page is its proposal's, found through the reviews' records.
    expect(store.getState().decision).toMatchObject({ approval_id: approval, loading: false, runs: [{ state: 'done', event_ref: recordApproval }] });
    // Its record's follow-ups line counts them by its check, as the decision's own page does.
    expect(store.getState().decision?.lines[impactRun('done').run_id]).toMatchObject({ summary: { unsent: 1 } });
    expect(operations()).not.toContain('view');
    // Its follow-ups line: Back to the list, not a list of its own.
    await store.openFollowUps('record', record, 'Pilot planning');
    expect(store.getState().followUps?.views.map(view => view.kind)).toEqual(['list']);
    expect(store.getState().decision).toBeNull();
    // Opened from the decision's own page, its list's "Approved" goes back to that page.
    fx.run = impactRun('done');
    await store.openDecision(approval, fx.run);
    await store.openFollowUps('record', record, 'Pilot planning');
    await store.openListDecision();
    expect(store.followUpShown()).toBeNull();
    expect(store.getState().route).toEqual({ page: 'decision' });
  });

  it('settles an unknown send or change of state on an item page by reading it again', async () => {
    fx.readItem = unsent('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', unsent('1'));
    fx.sendFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    // Not landed: it may not have been sent, and Send again replays it.
    await store.sendFollowUp(true);
    expect(said(store)).toEqual({ words: 'Not sent. Try again.', error: true });
    const page = () => store.followUpShown() as ItemPage;
    expect(page().send).not.toBeNull();
    // Landed: said as sent, and nothing is kept to replay.
    fx.readItem = { ...item('1'), approver: unsent('1').approver };
    await store.sendFollowUp(true);
    expect(requests('send')[1]?.command_id).toBe(requests('send')[0]?.command_id);
    expect(said(store)).toEqual({ words: 'Sent to Fixture' });
    expect(page().send).toBeNull();
    fx.setStateFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    await store.setFollowUpState('done');
    expect(said(store)).toEqual({ words: 'It was not saved. Try again.', error: true });
    fx.readItem = { ...fx.readItem, state: 'done' };
    await store.setFollowUpState('done');
    expect(said(store)).toEqual({ words: 'Done', undo: true });
  });

  it('says so when you gave an item away and no longer see it: the page offers Back, the list\'s row goes with a word in its foot', async () => {
    fx.readItem = item('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', item('1'));
    store.toggleOwnerPicker('itm_00000001');
    await flush();
    fx.itemGone = true;
    await store.pickFollowUpOwner(RAFAEL);
    expect(store.followUpShown()).toMatchObject({ kind: 'item', gone: true, said: { words: 'Owner changed to Rafael' } });
    store.closeFollowUp();
    fx.itemGone = false;
    fx.page = listPage([item('2'), item('3')]);
    await store.openFollowUps('record', record, 'Pilot planning');
    store.toggleOwnerPicker('itm_00000002');
    await flush();
    // Given away, it leaves what you see: read again, it is not found, and its row goes.
    fx.page = listPage([item('3')]);
    fx.itemGone = true;
    await store.pickFollowUpOwner(RAFAEL);
    expect(said(store)).toEqual({ words: 'Owner changed to Rafael · You no longer see it' });
    expect(ids(store)).toEqual(['3']);
    expect(requests('items').at(-1)).toMatchObject({ scope: 'record', id: record, read: 'counts' });
  });

  it('keeps a project\'s line through a failed read', async () => {
    fx.page = listPage([item('1')]);
    const store = await start();
    await store.openProject(project);
    expect(store.getState().projectLine).toMatchObject({ summary: { open: 1 } });
    await store.openFollowUps('project', project.project_id, project.name);
    fx.readItem = item('1');
    await store.openFollowUp('itm_00000001', item('1'));
    await store.setFollowUpState('done');
    store.closeFollowUp();
    await flush();
    // Back on the project, its line is read again; that read fails, and the line keeps what it said.
    store.closeFollowUp();
    fx.failItems = 1;
    await flush();
    expect(store.getState().projectLine).toMatchObject({ loading: false, summary: { open: 1 } });
  });

  it('counts a meeting\'s follow-ups by its record again once its decision, opened from its list over the meeting, closes', async () => {
    fx.review = { ...fx.review, status: 'approved', decided_on: 'desktop' };
    fx.page = listPage([unsent('1')]);
    const store = await start();
    await store.openProject(project);
    await store.openListItem({ ref: { kind: 'meeting', id: record }, title: 'Pilot planning', added_at: '2026-10-08T10:00:00.000Z', visibility: 'project', projects: [] });
    await flush();
    await store.openFollowUps('record', record, 'Pilot planning');
    await store.openListDecision();
    expect(store.getState().decision?.lines[impactRun('done').run_id]).toBeDefined();
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
    fx.page = listPage([unsent('1'), unsent('2')]);
    const store = await start();
    await store.openFollowUps('project', project.project_id, project.name);
    store.tickFollowUp('itm_00000001');
    fx.sendFailure = { code: 'timeout', retryable: true, mutation_outcome: 'unknown' };
    // It went: the row left current work for Dismissed, closed and never read.
    fx.page = listPage([{ ...unsent('1'), state: 'not_relevant', send_included: false, sent_at: '2026-10-08T12:00:00.000Z', state_set_at: '2026-10-08T12:00:00.000Z' },
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
    fx.page = listPage([yours('1'), yours('2')]);
    const store = await start();
    await store.openYourFollowUps();
    for (const scope of ['involved', 'record'] as const) {
      if (scope === 'record') {
        fx.page = listPage([yours('1'), yours('2')]);
        await store.openFollowUps('record', record, 'Pilot planning');
      }
      store.toggleOwnerPicker('itm_00000001');
      await flush();
      fx.page = listPage([given, yours('2')]);
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
    fx.page = listPage([given, { ...yours('2'), owner: { ...mina, match: 'reassigned' as const }, owner_set_at: '2026-10-08T14:00:00.000Z', owner_set_by: mina }]);
    await store.pickFollowUpOwner(RAFAEL);
    expect(ids(store)).toEqual(['1']);
  });

  /** The ids each review_open asked for, in order. */
  const opens = () => rpc.mock.calls.filter(([method, params]) => method === 'reviews' && params.request?.operation === 'review_open')
    .map(([, params]) => params.request.approval_id);

  it('opens a decision from its list by the record\'s own id, past the newest reviews, and says so when it cannot be read', async () => {
    fx.review = { ...fx.review, status: 'approved', decided_on: 'desktop' };
    fx.listed = false;
    fx.page = listPage([unsent('1')]);
    const store = await meetingList();
    rpc.mockClear();
    await store.openListDecision();
    // The Authority answers the record's proposal: the page holds the proposal's own id, and no reviews list was needed.
    expect(opens()).toEqual([recordApproval]);
    expect(store.followUpShown()).toMatchObject({ kind: 'decision' });
    expect(store.getState().decision).toMatchObject({ approval_id: approval, loading: false, open: { review: { approval_id: approval } } });
    expect(rpc.mock.calls.some(([method, params]) => method === 'reviews' && params.request?.operation === 'reviews')).toBe(false);
    // Back on the list, opened again while the review cannot be read: the page says why, rather than nothing happening.
    store.closeFollowUp();
    await flush();
    fx.failOpen = true;
    await store.openListDecision();
    expect(store.followUpShown()).toMatchObject({ kind: 'decision' });
    expect(store.getState().decision).toMatchObject({ loading: false, open: null, failure: 'ECHO is unavailable right now. Try again.' });
  });

  it('reads each destination\'s check as it stands when another destination\'s list opens the decision away from Home, and again on Try again', async () => {
    // Two destinations, each a record with its own check. Home last saw the first one running.
    const second = 'apr_' + 'e'.repeat(64);
    const secondRecord = 'sha256:' + '2'.repeat(64);
    const secondRun = impactRun('done', '21', second);
    const firstRun = impactRun('running').run_id;
    fx.review = { ...fx.review, status: 'approved', decided_on: 'desktop',
      records: [{ approval_id: recordApproval, project_ids: [] }, { approval_id: second, project_ids: [project.project_id] }] };
    fx.run = impactRun('running');
    const store = await start();
    expect(store.getState().home?.runs).toEqual([expect.objectContaining({ run_id: firstRun, state: 'running' })]);
    // On the project, away from Home, the first check finished and the second ran: Home's own runs are not read there.
    await store.openProject(project);
    fx.run = impactRun('done');
    fx.more = [secondRun];
    fx.page = { items: [{ ...unsent('1', secondRun.run_id), decision: { ...decision, approval_id: second, record_sha256: secondRecord } }], next_cursor: null,
      stages: [{ record_sha256: secondRecord, run_id: secondRun.run_id, state: 'done', error_code: null, mine: true }], summary: { ...EMPTY_SUMMARY, unsent: 1, decisions: 1 } };
    await store.openFollowUps('record', secondRecord, 'Pilot planning');
    await store.openListDecision();
    await flush();
    expect(store.getState().decision).toMatchObject({ approval_id: approval, runs: [{ run_id: firstRun, state: 'done' }, { run_id: secondRun.run_id, state: 'done' }] });
    expect(Object.keys(store.getState().decision!.lines).sort()).toEqual([firstRun, secondRun.run_id]);
    expect(opens()).toEqual([second]);
    // ECHO comes back after the first check failed on a rerun: read again, the decision says so.
    fx.run = impactRun('failed');
    await show(store);
    await flush();
    expect(store.getState().decision?.runs[0]).toMatchObject({ run_id: firstRun, state: 'failed' });
    // Try again: queued again, then a check-in, so the Authority starts it; the decision reads it once more at once.
    const before = runsSent().length;
    await store.retryImpact(firstRun);
    await flush();
    expect(requests('retry')).toEqual([{ schema_version: 1, operation: 'retry', run_id: firstRun }]);
    expect(runsSent().slice(before)).toEqual(['retry', 'next', 'list']);
    expect(store.getState().decision?.runs[0]).toMatchObject({ run_id: firstRun, state: 'running' });
    expect(requests('start')).toEqual([]);
  });

  it('keeps the check of a decision opened from its list when a runs list read since does not hold it', async () => {
    fx.review = { ...fx.review, status: 'approved', decided_on: 'desktop' };
    fx.page = listPage([unsent('1')]);
    const store = await meetingList();
    await store.openListDecision();
    expect(store.getState().decision).toMatchObject({ runs: [{ run_id: impactRun('done').run_id, state: 'done' }] });
    // Home is read again under them: its runs list holds only the newest checks, not this one.
    const lists = requests('list').length;
    await show(store);
    await flush();
    expect(requests('list').length).toBeGreaterThan(lists);
    expect(store.getState().decision).toMatchObject({ runs: [{ run_id: impactRun('done').run_id, state: 'done' }] });
  });
});

describe('A meeting\'s follow-ups line', () => {
  it('learns from a meeting\'s check whether Try again is yours, reading no runs list', async () => {
    fx.listed = false;
    fx.page = { items: [], next_cursor: null, stages: [{ record_sha256: record, run_id: impactRun('done').run_id, state: 'done', error_code: null, mine: true }],
      summary: { ...EMPTY_SUMMARY, unsent: 2, decisions: 1, by_decision: [{ record_sha256: record, unsent: 2, open: 0, landed: 0, unreadable: 0 }] } };
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

  /** Signed in, on a project, reading the meeting whose line says your check is at `state`, as its counts read says. */
  async function meetingLine(state: PersonRunV1['state']) {
    fx.listed = false;
    fx.run = impactRun(state);
    const stage = { record_sha256: record, run_id: fx.run.run_id, state, error_code: fx.run.error_code, mine: true };
    fx.page = { items: [], next_cursor: null, stages: [stage], summary: { ...EMPTY_SUMMARY, decisions: 1 } };
    const store = await start();
    await store.openProject(project);
    await store.openListItem({ ref: { kind: 'meeting', id: record }, title: 'Pilot planning', added_at: '2026-10-08T10:00:00.000Z', visibility: 'project', projects: [] });
    await flush();
    expect(store.getState().impactLine).toMatchObject({ scope: 'record', id: record, stage: { state } });
    return { store, stage };
  }

  it('reads its check\'s stage again when the reviews move, as they do when the check starts, fails or ends (DSK-1)', async () => {
    const { store, stage } = await meetingLine('running');
    // The check failed, and found no follow-ups: only the reviews move.
    fx.page = { ...fx.page!, stages: [{ ...stage, state: 'failed', error_code: 'research_failed' }] };
    fx.moved.reviews = 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getState().impactLine).toMatchObject({ loading: false, stage: { state: 'failed', error_code: 'research_failed' } });
  });

  it('tries your failed check again from its line: queued again, then a check-in, then the line read again (DSK-1)', async () => {
    const { store, stage } = await meetingLine('failed');
    const before = runsSent().length;
    fx.page = { ...fx.page!, stages: [{ ...stage, state: 'running', error_code: null }] };
    await store.retryLineCheck();
    expect(requests('retry')).toEqual([{ schema_version: 1, operation: 'retry', run_id: stage.run_id }]);
    expect(runsSent().slice(before)).toEqual(['retry', 'next', 'items']);
    // The check-in started it, and the line says so.
    expect(fx.run).toMatchObject({ state: 'running' });
    expect(store.getState().impactLine).toMatchObject({ busy: false, loading: false, stage: { state: 'running' } });
    expect(requests('start')).toEqual([]);
    // Once going, it offers Try again no more: a second click sends nothing.
    await store.retryLineCheck();
    expect(runsSent().slice(before)).toEqual(['retry', 'next', 'items']);
  });
});

describe('Rows first, then what each says now', () => {
  const listPage = (items: OpenItemView[]): OpenItemsView => ({ items, next_cursor: null, stages: [], summary: {
    ...EMPTY_SUMMARY, decisions: 1, unsent: items.filter(entry => entry.state === 'unsent').length, open: items.filter(entry => entry.state === 'open').length,
    done: items.filter(entry => entry.state === 'done').length, not_relevant: items.filter(entry => entry.state === 'not_relevant').length } });
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

  beforeEach(() => { fx.listed = false; });

  it('shows a row with what a live read brought of it, every other field as its rows were last read', async () => {
    const { shownItem } = await import('../../src/renderer/store.js');
    const row = rowOnly({ ...item('1'), state: 'done', owner: { ...RAFAEL, name: RAFAEL.display_name, active: true, match: 'reassigned' } });
    expect(shownItem(row, { itm_00000001: { reach: 'opened', current: opened('1').current } })).toEqual({ ...row, reach: 'opened', current: opened('1').current });
    expect(shownItem(row, { itm_00000001: { reach: 'no_access' } })).toEqual({ ...row, reach: 'no_access' });
    // Never read live: as read.
    expect(shownItem(row, { itm_00000002: { reach: 'unavailable' } })).toEqual(row);
  });

  it('shows Home\'s rows at once from their rows read, then fills what each says now from the live read', async () => {
    fx.review = { ...fx.review, status: 'approved', decided_on: 'desktop' };
    // An older Authority may still say a sweep is due: Home reads it as nothing.
    fx.home = { ...emptyHome(), items: [opened('1'), { ...item('2'), kind: 'action', expected: 'Send the revised quote', reach: 'not_read' }], waiting: 1, sweep_due: true };
    fx.hold.live = true;
    const store = await start();
    // The live read still on its way: the rows show, by ECHO's own fields, and Home is loaded; only the live part waits.
    expect(store.getState().home).toMatchObject({ loading: false, reading: true, open: { waiting: 1 } });
    // It went by itself once the rows were read: nothing else has to wait on it for it to go.
    expect(requests('home')).toEqual([{ schema_version: 1, operation: 'home' }]);
    expect(store.homeRows().map(row => ('item' in row ? [row.kind, row.item.item_id, row.item.reach] : [row.kind]))).toEqual([
      ['update', 'itm_00000001', 'not_read'], ['update', 'itm_00000002', 'not_read'],
    ]);
    expect(homeItems(store)[0]).not.toHaveProperty('current');
    expect(store.awaitingLive(homeItems(store)[0]!)).toBe(true);
    // A meeting's action is never read live: it has nothing to wait for.
    expect(store.awaitingLive(homeItems(store)[1]!)).toBe(false);
    release('live');
    await flush();
    expect(store.getState().home).toMatchObject({ reading: false });
    expect(homeItems(store)[0]).toMatchObject({ reach: 'opened', current: { says_now: 'Says 1' } });
    expect(operations()).not.toContain('sweep');
  });

  it('keeps Home\'s rows when its live read fails, saying ECHO couldn\'t read them just now, and shows no error', async () => {
    fx.home = { ...emptyHome(), items: [opened('1')] };
    fx.failNextLive = true;
    const store = await start();
    expect(store.getState().home).toMatchObject({ loading: false, reading: false, failure: undefined });
    expect(homeItems(store)[0]).toMatchObject({ item_id: 'itm_00000001', reach: 'unavailable' });
    // Read again, the live read answers: what it says now fills in.
    await store.loadHome();
    expect(homeItems(store)[0]).toMatchObject({ reach: 'opened', current: { says_now: 'Says 1' } });
  });

  it('reads Home live only while it shows: rows only under follow-ups, and back on it after a change only the rows new to it', async () => {
    fx.home = { ...emptyHome(), items: [opened('1')] };
    const store = await start();
    const live = () => homeCalls().filter(([, params]) => params.request.read === undefined && ['home', 'item'].includes(params.request.operation)).length;
    const before = live();
    // A follow-up's page covers Home, and the window comes forward: Home's rows are read again, rows only.
    fx.readItem = opened('1');
    await store.openFollowUp('itm_00000001', homeItems(store)[0]!);
    fx.home = { ...emptyHome(), items: [opened('1'), opened('2')] };
    const rows = rowsReads();
    await show(store);
    await flush();
    expect(rowsReads()).toBe(rows + 1);
    expect(live()).toBe(before);
    // A change on the page, then Back: Home's rows read again, and only the new one read live, on its own.
    await store.setFollowUpState('done');
    fx.page = listPage([opened('2')]);
    store.closeFollowUp();
    await flush();
    expect(live()).toBe(before + 1);
    expect(requests('item').at(-1)).toEqual({ schema_version: 1, operation: 'item', item_id: 'itm_00000002' });
    expect(homeItems(store).map(entry => entry.reach)).toEqual(['opened', 'opened']);
  });

  it('reads reviews beside Home\'s other reads, so slow approvals do not hold up open items', async () => {
    fx.listed = true;
    fx.home = { ...emptyHome(), items: [opened('1')] };
    fx.hold.reviews = true;
    const store = await start();
    // Runs and what waits on you appear while the reviews request is still in flight.
    expect(operations()).toEqual(expect.arrayContaining(['list', 'home']));
    expect(rpc.mock.calls.some(([method]) => method === 'reviews')).toBe(true);
    expect(store.homeRows().map(row => row.kind)).toEqual(['update']);
    release('reviews');
    await flush();
    expect(store.homeRows().map(row => row.kind)).toEqual(['approve', 'update']);
    expect(store.getState().home).toMatchObject({ loading: false });
  });

  it.each(['reviews', 'list'] as const)('keeps initial loading after empty follow-ups arrive while %s are pending', async pending => {
    fx.listed = pending === 'reviews';
    fx.home = emptyHome();
    fx.hold[pending] = true;
    const store = await start();
    const { Home } = await import('../../src/renderer/screens/home.js');
    expect(store.getState().home).toMatchObject({ loading: true, open: emptyHome(), reviews: [] });
    expect(store.homeRows()).toEqual([]);
    const shownBefore = text(byTestId(render(Home({ state: store.getState() })), 'home-clear')[0]);
    fx.hold[pending] = false;
    release(pending);
    await flush();
    expect(store.getState().home?.loading).toBe(false);
    expect(store.homeRows().map(row => row.kind)).toEqual(pending === 'reviews' ? ['approve'] : []);
    expect(shownBefore).toBe('Loading what needs you…');
  });

  it.each(['member', 'another'])('keeps completed empty Home during refresh, but resets it after sign-out (%s)', async member => {
    fx.listed = false;
    fx.home = emptyHome();
    rpc.mockImplementation((method, params) => method === 'projects.list'
      ? ok({ items: params.status === 'archived' ? [] : [project], next_cursor: null }) : authority(method, params));
    const store = await start();
    const { Home } = await import('../../src/renderer/screens/home.js');
    const line = () => text(byTestId(render(Home({ state: store.getState() })), 'home-clear')[0]);
    expect(line()).toBe('Nothing needs you');
    fx.hold.reviews = true;
    const refreshing = store.loadHome();
    await flush();
    expect(store.getState().home?.loading).toBe(true);
    expect(line()).toBe('Nothing needs you');
    fx.hold.reviews = false;
    release('reviews');
    await refreshing;

    store.accountCommand('signout');
    await store.signOut();
    expect(store.getState().home).toBeNull();
    fx.hold.reviews = true;
    fx.signedIn = true;
    fx.member = member;
    await store.refreshStatus();
    await flush();
    const firstLine = line();
    fx.hold.reviews = false;
    release('reviews');
    await flush();
    expect(firstLine).toBe('Loading what needs you…');
    expect(line()).toBe('Nothing needs you');
  });

  it('fails a load whose reviews cannot be read, as before, keeping what else it read; the change check still checks in', async () => {
    fx.granola = 'linked';
    fx.review = { ...fx.review, status: 'approved', decided_on: 'desktop' };
    fx.run = impactRun('pending');
    fx.home = { ...emptyHome(), items: [opened('1')] };
    fx.failReviews = true;
    const store = await start();
    expect(store.getState().home).toMatchObject({ loading: false, reading: false, failure: { code: 'transport_failed' } });
    expect(store.homeRows().map(row => row.kind)).toEqual(['update']);
    const calls = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    // Home reads nothing more by itself meanwhile. Whatever it could read, each change check checks in, as the Authority
    // starts a queued check whether or not the reviews could be read here (DSK-1).
    expect(rpc.mock.calls.slice(calls).filter(([method, params]) => method === 'runs' && params.request.read !== 'rows')
      .map(([, params]) => params.request.operation)).toEqual(['next', 'next']);
    // Try again: the reviews answer.
    fx.failReviews = false;
    await store.loadHome();
    expect(store.getState().home?.failure).toBeUndefined();
    expect(requests('start')).toEqual([]);
  });

  it('shows a list\'s rows at once, read rows only, then reads live only the rows that show, and says which are on their way', async () => {
    fx.page = listPage([unsentOpened('1'), opened('2'), { ...unsent('3'), kind: 'action', expected: 'Book the lab', reach: 'not_read' }]);
    const store = await start();
    fx.hold.live = true;
    const opening = store.openFollowUps('record', record, 'Pilot planning');
    await flush();
    expect(list(store)).toMatchObject({ loading: false, reading: true });
    expect(shown(store).map(entry => entry.reach)).toEqual(['not_read', 'not_read', 'not_read']);
    expect(shown(store).map(entry => list(store).reading && store.awaitingLive(entry))).toEqual([true, true, false]);
    expect(reads()).toEqual(['unsent+open+done+not_relevant', 'unsent+open+done+not_relevant live']);
    release('live');
    await opening;
    expect(shown(store).map(entry => entry.reach)).toEqual(['opened', 'opened', 'not_read']);
    expect(list(store).reading).toBe(false);
  });

  it('leaves a list\'s rows saying ECHO couldn\'t read them just now when their live read fails, with no error for the list', async () => {
    fx.page = listPage([opened('1'), { ...item('2'), kind: 'action', expected: 'Book the lab', reach: 'not_read' }]);
    const store = await start();
    fx.failLiveItems = 1;
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
    fx.page = listPage([opened('1'), closedAs('done')('2'), closedAs('not_relevant')('3')]);
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
    fx.page = listPage([unsentOpened('1'), unsentOpened('2')]);
    const store = await start();
    fx.hold.live = true;
    const opening = store.openFollowUps('record', record, 'Pilot planning');
    await flush();
    // The live read is still on its way when Send goes (the first row only), and answers what the page held before it.
    store.tickFollowUp('itm_00000002');
    fx.page = listPage([{ ...opened('1'), approver: unsent('1').approver }, unsentOpened('2')]);
    fx.hold.live = false;
    await store.sendTicked(true);
    expect(shown(store).map(entry => [entry.state, entry.reach])).toEqual([['open', 'not_read'], ['unsent', 'not_read']]);
    release('live');
    await opening;
    // What it says now fills in; what Send did stays.
    expect(shown(store).map(entry => [entry.state, entry.reach])).toEqual([['open', 'opened'], ['unsent', 'opened']]);
    // Another change, read again rows only: each keeps what it read live, and nothing is read live again.
    const live = reads().filter(entry => entry.endsWith(' live')).length;
    fx.page = listPage([{ ...opened('1'), approver: unsent('1').approver }, { ...unsentOpened('2'), state: 'not_relevant', send_included: false }]);
    store.tickFollowUp('itm_00000002');
    await store.sendTicked(false);
    expect(shown(store).map(entry => [entry.state, entry.reach])).toEqual([['open', 'opened'], ['not_relevant', 'opened']]);
    expect(reads().filter(entry => entry.endsWith(' live'))).toHaveLength(live);
  });

  it('shows an item page\'s row at once while it is read live, then reads it again rows only after a change, keeping what it read live', async () => {
    fx.readItem = opened('1');
    const store = await start();
    fx.hold.live = true;
    const opening = store.openFollowUp('itm_00000001', rowOnly(opened('1')));
    await flush();
    expect(shownPage(store)).toMatchObject({ kind: 'item', loading: true });
    expect(pageItem(store).reach).toBe('not_read');
    release('live');
    await opening;
    expect(shownPage(store).loading).toBe(false);
    expect(pageItem(store)).toMatchObject({ reach: 'opened', current: { says_now: 'Says 1' } });
    fx.hold.live = false;
    fx.readItem = { ...opened('1'), state: 'done', state_set_at: '2026-10-09T12:00:00.000Z' };
    await store.setFollowUpState('done');
    // Its rows, then it live, then, after the change, its rows again: the item is done, and still says what it said.
    expect(requests('item').map(request => request.read)).toEqual(['rows', undefined, 'rows']);
    expect(requests('items')).toEqual([]);
    expect(shownPage(store)).toMatchObject({ busy: false, said: { words: 'Done', undo: true } });
    expect(pageItem(store)).toMatchObject({ state: 'done', state_set_at: '2026-10-09T12:00:00.000Z', reach: 'opened', current: { says_now: 'Says 1' } });
  });

  it('opens a page with what its view read live of its item, reading it again rows only; a meeting\'s action is never read live', async () => {
    fx.readItem = opened('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', opened('1'));
    fx.readItem = { ...item('2'), kind: 'action', expected: 'Book the lab', reach: 'not_read' };
    await store.openFollowUp('itm_00000002', rowOnly(fx.readItem));
    expect(requests('item').map(request => request.read)).toEqual(['rows', 'rows']);
    expect(pageItem(store)).toMatchObject({ reach: 'not_read' });
  });

  it('shows what the Authority answered on an item page when the read after the change fails', async () => {
    fx.readItem = opened('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', opened('1'));
    fx.failItems = 1;
    await store.setFollowUpState('done');
    expect(shownPage(store)).toMatchObject({ busy: false, said: { words: 'Done', undo: true } });
    expect(pageItem(store)).toMatchObject({ state: 'done', reach: 'opened' });
    expect(shownPage(store).failure).toBeUndefined();
  });

  it.each([
    // Opened by its id alone (a notification), or from its row: read rows only, read live, or whose live read failed. It is read
    // rows only, then live unless its row was read live. A read that fails for an outage keeps what the page showed: its row,
    // saying ECHO couldn't read it just now unless it was read live.
    ['its id alone', null, ['rows', undefined], null],
    ['a row read rows only', rowOnly(opened('1')), ['rows', undefined], 'unavailable'],
    ['a row whose live read failed', { ...rowOnly(opened('1')), reach: 'unavailable' }, ['rows', undefined], 'unavailable'],
    ['a row read live', opened('1'), ['rows'], 'opened'],
  ] as const)('reads an item page opened from %s; when that read fails, it keeps what it showed, and Try again reads it again', async (_, row, reads, kept) => {
    fx.readItem = opened('1');
    const store = await start();
    await store.openFollowUp('itm_00000001', row);
    expect(requests('item').map(request => request.read)).toEqual(reads);
    expect(pageItem(store)).toMatchObject({ reach: 'opened', current: { says_now: 'Says 1' } });
    store.closeFollowUp();
    fx.failItems = 1;
    await store.openFollowUp('itm_00000001', row);
    expect(shownPage(store)).toMatchObject({ loading: false, failure: { code: 'unavailable' } });
    expect(shownPage(store).item === null ? null : pageItem(store).reach).toBe(kept);
    const before = requests('item').length;
    store.retryFollowUp();
    await flush();
    expect(requests('item').slice(before).map(request => request.read)).toEqual(reads);
    expect(shownPage(store).failure).toBeUndefined();
    expect(pageItem(store)).toMatchObject({ reach: 'opened', current: { says_now: 'Says 1' } });
  });

  it('reads a closed group opened while another\'s first read is on its way, once that read answers', async () => {
    fx.page = listPage([opened('1'), closedAs('done')('2'), closedAs('not_relevant')('3')]);
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
    fx.home = { ...emptyHome(), items: [action] };
    fx.hold.live = true;
    const store = await start();
    expect(store.getState().home).toMatchObject({ reading: true });
    // A change on its page, then Back: Home is read again, and nothing in it waits for a live read.
    fx.readItem = action;
    await store.openFollowUp(action.item_id, action);
    fx.readItem = { ...action, state: 'done' };
    await store.setFollowUpState('done');
    fx.home = emptyHome();
    store.closeFollowUp();
    await flush();
    expect(store.getState().home).toMatchObject({ loading: false, reading: false });
    // The first load's live read answers late: it is no longer Home's, and changes nothing.
    release('live');
    await flush();
    expect(store.getState().home).toMatchObject({ reading: false });
  });

  it('goes on reading a list live once it shows again, after another app in front stopped it under an item page', async () => {
    fx.page = listPage([opened('1')]);
    fx.readItem = opened('1');
    const store = await start();
    fx.hold.listRows = true;
    const opening = store.openYourFollowUps();
    await flush();
    // A row's page opens over the list while its rows read is on its way; then another app comes in front.
    await store.openFollowUp('itm_00000001', opened('1'));
    cover(store);
    fx.hold.listRows = false;
    release('listRows');
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
    fx.page = listPage([unsentOpened('1')]);
    const store = await meetingList();
    fx.page = listPage([{ ...opened('1'), approver: unsent('1').approver }, opened('2')]);
    fx.hold.live = true;
    const sending = store.sendTicked(true);
    for (let turn = 0; turn < 5; turn += 1) await flush();
    expect(list(store)).toMatchObject({ busy: false, reading: true, said: { words: 'Sent to Fixture' } });
    expect(shown(store).map(entry => [entry.state, entry.reach])).toEqual([['open', 'opened'], ['open', 'not_read']]);
    release('live');
    await sending;
    await flush();
    expect(list(store).reading).toBe(false);
    expect(shown(store).map(entry => entry.reach)).toEqual(['opened', 'opened']);
  });
});
