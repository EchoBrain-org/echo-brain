// One refresh rule (desktop refresh and notifications v1, section 2): when a
// change check runs (R2), what each moved area reads again (R3), what coming
// back reads again on each page (R4), the hidden window (R6), the cover (R7),
// an older Authority (R8) and desktop.log (R9).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, ProjectSummary } from '../../src/shared/protocol.js';
import { MINA, authority, followUp, id, nextCheck, sent, stated, changesHandlers } from './changes-fixture.js';
import { ACCOUNT, flush, Held, keysetPage, ok, project, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

let account: Account;
const apollo = project(1, 20, { name: 'Apollo' });
const proposal = { snapshot_sha256: `sha256:${'a'.repeat(64)}`, suggested_projects: [], owners: [{ signal_id: 's1', action: 'Ship it', proposed: 'Mina' }],
  review: { status: 'pending' } };

const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method);
const checks = () => calls('changes.read').length;
const statusReads = () => calls('app.status').length;
const runs = (operation: string, match: (request: Record<string, unknown>) => boolean = () => true) =>
  calls('runs').filter(([, params]) => params.request.operation === operation && match(params.request)).length;
/** Home's reads of its rows. */
const homeReads = () => runs('home', request => request.read === 'rows');
const meetings = (operation: string) => calls('tools.meetings').filter(([, params]) => params.request.operation === operation).length;
const lists = (status: 'active' | 'archived') => calls('projects.list').filter(([, params]) => (params.status ?? 'active') === status).length;
const noticeTexts = () => calls('notice.show').map(([, params]) => params.text);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  stubWindow();
  authority.reset();
  authority.active = [apollo];
  account = ACCOUNT;
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), {
    ...changesHandlers(),
    'app.status': () => ok({ signed_in: true, account }),
    'account.tools': () => ok({ tools: [{ tool_id: 'granola', name: 'Granola', status: 'linked' }] }),
    'tools.meetings': params => {
      const request = params.request as { operation: string };
      if (request.operation === 'reviews') return ok({ reviews: [] });
      if (request.operation === 'review_open') return ok(proposal);
      throw new Error(`Unexpected meeting operation: ${request.operation}`);
    },
    'employees.list': () => ok({ items: [] }),
    'projects.read': params => {
      const found = [...authority.active, ...authority.archived].find(row => row.project_id === params.project_id);
      return found ? ok(found) : { ok: false, failure: { code: 'not_found', retryable: false } };
    },
  }, () => ({ active: authority.active, archived: authority.archived })));
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Past the window in which a return is the same return. */
const later = () => vi.advanceTimersByTimeAsync(2_000);

describe('when a check runs (R2)', () => {
  it('at sign-in, learning; then at the pace the server sets, kept within 15 s and an hour', async () => {
    authority.seconds = 15;
    await startStore();
    expect(checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(checks()).toBe(1);
    await nextCheck(0.001);
    expect(checks()).toBe(2);
    authority.seconds = 3600;
    await nextCheck(15);
    expect(checks()).toBe(3);
    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(checks()).toBe(3);
    await nextCheck(1);
    expect(checks()).toBe(4);
    // Faster than the contract allows: never more often than every 15 s.
    authority.seconds = 1;
    await nextCheck(3600);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(checks()).toBe(5);
    await nextCheck(1);
    expect(checks()).toBe(6);
  });

  it('after a failed check, later and later, up to five minutes', async () => {
    await startStore();
    authority.changes = 'fails';
    const at: number[] = [];
    for (let second = 1; second <= 1500; second += 1) {
      const before = checks();
      await vi.advanceTimersByTimeAsync(1_000);
      if (checks() > before) at.push(second);
    }
    // 60 s, then 120, 240, 300 and 300 after each failure.
    expect(at).toEqual([60, 180, 420, 720, 1020, 1320]);
    authority.changes = 'ok';
    await nextCheck(300);
    const settled = checks();
    await nextCheck(60);
    expect(checks()).toBe(settled + 1);
  });

  it('after a failed check, never sooner than the pace the server last set', async () => {
    authority.seconds = 600;
    await startStore();
    authority.changes = 'fails';
    await nextCheck(600);
    expect(checks()).toBe(2);
    // Doubling would say 1,200 s, capped at five minutes; the server asked for ten, so ten it is.
    await vi.advanceTimersByTimeAsync(599_000);
    expect(checks()).toBe(2);
    await nextCheck(1);
    expect(checks()).toBe(3);
  });

  it('coming back on macOS: after another app was in front, with the account read again', async () => {
    const store = await startStore();
    store.conceal();
    await store.resume();
    expect(checks()).toBe(2);
    expect(statusReads()).toBe(2);
  });

  it('coming back on Linux, and the window shown: no departure needs to be recorded, and a return within two seconds is the same one', async () => {
    const store = await startStore();
    await store.resume();
    expect([checks(), statusReads()]).toEqual([2, 2]);
    await store.windowShown();
    await store.resume();
    expect([checks(), statusReads()]).toEqual([2, 2]);
    await later();
    await store.windowShown();
    expect([checks(), statusReads()]).toEqual([3, 3]);
  });

  it('opening a page: at most once in ten seconds', async () => {
    const store = await startStore();
    await store.openMine();
    expect(checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await store.openProject(apollo);
    store.goHome();
    await store.openYourFollowUps();
    store.openTools();
    await flush();
    expect(checks()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await store.openDecision('apr_1');
    await flush();
    expect(checks()).toBe(3);
  });

  it('the machine waking', async () => {
    const store = await startStore();
    store.systemWoke();
    await flush();
    expect(checks()).toBe(2);
  });

  it('stops at sign-out, and starts over for another account', async () => {
    const store = await startStore();
    rpc.mockImplementation(rpcFor(new Held(), { ...changesHandlers(), 'app.status': () => ok({ signed_in: false, account: null }) },
      () => ({ active: authority.active, archived: authority.archived })));
    await store.refreshStatus();
    await nextCheck(600);
    expect(checks()).toBe(1);
    rpc.mockImplementation(rpcFor(new Held(), { ...changesHandlers(), 'app.status': () => ok({ signed_in: true, account: { ...ACCOUNT, membership_id: 'other' } }) },
      () => ({ active: authority.active, archived: authority.archived })));
    await store.refreshStatus();
    await flush();
    expect(calls('changes.read').at(-1)?.[1]).toEqual({ expect: { authority: ACCOUNT.authority, membership_id: 'other' } });
  });
});

describe('what a moved area reads again (R3)', () => {
  it('projects: both sidebar lists, then the open project\'s header from its row, logging the area by name only', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    const before = [lists('active'), lists('archived')];
    authority.active = [{ ...apollo, name: 'Apollo, renamed', role: 'member' }];
    await nextCheck();
    // Each list: the sidebar's page, and the full read that tells which projects you were added to.
    expect([lists('active') - before[0]!, lists('archived') - before[1]!]).toEqual([2, 2]);
    expect(store.getState().route).toMatchObject({ page: 'project', project: { name: 'Apollo, renamed', role: 'member', status: 'active' } });
    expect(calls('log.changes').map(([, params]) => params)).toEqual([{ moved: ['projects'] }]);
    // Archived elsewhere: it moves to Archived, and the page says so.
    authority.active = [];
    authority.archived = [{ ...apollo, name: 'Apollo, renamed', role: 'member', status: 'archived' }];
    await nextCheck();
    expect(store.getState().route).toMatchObject({ page: 'project', project: { status: 'archived' } });
    expect(noticeTexts()).toEqual([]);
  });

  it('projects: an open project you no longer have goes Home, saying so', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    authority.active = [];
    await nextCheck();
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.getState().toast).toBe('You no longer have access to Apollo');
    expect(store.getState().projects.items).toEqual([]);
  });

  it('projects: an open project behind More is read on its own, and stays while it is yours', async () => {
    // Twenty newer than Apollo: the two pages shown end before it, so it is opened from elsewhere (Home, a notification).
    const many: ProjectSummary[] = Array.from({ length: 20 }, (_, index) => project(index + 2, 29, { created_at: `2026-09-29T${String(23 - index).padStart(2, '0')}:00:00.000Z` }));
    authority.active = [...many, apollo];
    const store = await startStore();
    await store.loadProjects(true);
    expect(store.getState().projects).toMatchObject({ next: expect.any(String) });
    await store.openProject(apollo);
    authority.active = [project(40, 30), ...authority.active];
    await nextCheck();
    expect(calls('projects.read').at(-1)?.[1]).toMatchObject({ project_id: apollo.project_id });
    expect(store.getState().route).toMatchObject({ page: 'project', project: { name: 'Apollo' } });
    authority.active = authority.active.filter(row => row.project_id !== apollo.project_id).concat(project(42, 1));
    await nextCheck();
    expect(store.getState().route).toEqual({ page: 'home' });
  });

  it('follow-ups: Home\'s rows, but not live again, and no other page', async () => {
    const store = await startStore();
    const rows = homeReads();
    const live = runs('home', request => request.read === undefined);
    authority.items = [followUp(1)];
    await nextCheck();
    expect(homeReads()).toBe(rows + 1);
    expect(store.homeRows().map(row => row.kind)).toEqual(['update']);
    expect(calls('list.page')).toHaveLength(0);
    expect(runs('home', request => request.read === undefined)).toBeLessThanOrEqual(live + 1);
  });

  it('follow-ups: the Follow-ups list as far as it showed, and an item page, rows only', async () => {
    const store = await startStore();
    await store.openYourFollowUps();
    const listRows = () => runs('items', request => request.scope === 'mine' && request.read === 'rows');
    const before = listRows();
    authority.items = [followUp(1)];
    await nextCheck();
    expect(listRows()).toBe(before + 1);
    expect(store.followUpShown()).toMatchObject({ kind: 'list', items: [{ item_id: id(1) }] });
    await store.openFollowUp(id(1));
    const items = () => runs('item', request => request.read === 'rows');
    const read = items();
    authority.items = [stated(followUp(1), 'open', MINA, 50)];
    await nextCheck();
    expect(items()).toBe(read + 1);
    // The list under it is read again when it shows.
    store.closeFollowUp();
    await flush();
    expect(listRows()).toBe(before + 2);
  });

  it('follow-ups: a project\'s follow-ups line', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    const lines = () => runs('items', request => request.scope === 'project' && request.read === 'counts');
    const before = lines();
    authority.items = [followUp(1)];
    await nextCheck();
    expect(lines()).toBe(before + 1);
    expect(calls('list.page')).toHaveLength(1);
  });

  it('follow-ups: a meeting\'s line on its decision page', async () => {
    const store = await startStore();
    const run = { run_id: 'run_00000000-0000-4000-8000-000000000020', trigger: 'approved_record' as const, event_ref: 'apr_1', state: 'done' as const,
      error_code: null, created_at: '2026-10-14T09:00:00.000Z', updated_at: '2026-10-14T09:05:00.000Z' };
    await store.openDecision('apr_1', run);
    await flush();
    const lines = () => runs('items', request => request.scope === 'run' && request.read === 'counts');
    const before = lines();
    authority.items = [sent(1, MINA)];
    await nextCheck();
    expect(lines()).toBe(before + 1);
  });

  it('reviews: Home, and the decision page, keeping the choices made on it', async () => {
    const store = await startStore();
    const reviews = meetings('reviews');
    authority.reviews = ['apr_1:pending'];
    await nextCheck();
    expect(meetings('reviews')).toBe(reviews + 1);
    await store.openDecision('apr_1');
    await flush();
    store.setDecisionShare(true);
    const opened = meetings('review_open');
    authority.reviews = [];
    await nextCheck();
    expect(meetings('review_open')).toBe(opened + 1);
    expect(store.getState().decision).toMatchObject({ share: true, open: { snapshot_sha256: proposal.snapshot_sha256 } });
  });
});

describe('what coming back reads again, on each page (R4)', () => {
  it('Home: its rows, read live again', async () => {
    const store = await startStore();
    const before = homeReads();
    await store.resume();
    await flush();
    expect(homeReads()).toBe(before + 1);
  });

  it('a project: its feed\'s first page, its members and its line', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    const before = [calls('list.page').length, calls('projects.members').length, runs('items', request => request.scope === 'project')];
    await store.resume();
    await flush();
    expect([calls('list.page').length, calls('projects.members').length, runs('items', request => request.scope === 'project')])
      .toEqual(before.map(count => count + 1));
  });

  it('Mine, Tools, and People & invites', async () => {
    account = { ...ACCOUNT, role: 'owner' };
    const store = await startStore();
    await store.openMine();
    let before = calls('list.page').length;
    await store.resume();
    await flush();
    expect(calls('list.page').length).toBe(before + 1);
    await later();
    store.openTools();
    await flush();
    before = calls('account.tools').length;
    await store.windowShown();
    await flush();
    expect(calls('account.tools').length).toBe(before + 1);
    await later();
    store.openOrganization();
    await flush();
    before = calls('employees.list').length;
    await store.resume();
    await flush();
    expect(calls('employees.list').length).toBe(before + 1);
  });

  it('the Follow-ups list or an item page', async () => {
    authority.items = [followUp(1)];
    const store = await startStore();
    await store.openYourFollowUps();
    const listRows = () => runs('items', request => request.scope === 'mine' && request.read === 'rows');
    const before = listRows();
    await store.resume();
    await flush();
    expect(listRows()).toBe(before + 1);
    await store.openFollowUp(id(1));
    const read = runs('item');
    await later();
    await store.windowShown();
    await flush();
    expect(runs('item')).toBeGreaterThan(read);
  });
});

describe('a hidden window (R6) and the cover (R7)', () => {
  it('checks and notifies while hidden, and reads what shows once, when it shows again', async () => {
    const store = await startStore();
    store.windowHidden();
    const before = homeReads();
    authority.items = [followUp(1)];
    await nextCheck();
    authority.items = [followUp(1), followUp(2)];
    await nextCheck();
    expect(noticeTexts()).toEqual(['Mina handed you Action 1', 'Mina handed you Action 2']);
    expect(homeReads()).toBe(before);
    await store.windowShown();
    await flush();
    expect(homeReads()).toBe(before + 1);
  });

  it('stays hidden when ECHO comes back in front with its window still in the tray', async () => {
    const store = await startStore();
    store.windowHidden();
    const before = homeReads();
    await store.resume();
    await flush();
    expect(checks()).toBe(2);
    expect(homeReads()).toBe(before);
    await later();
    await store.windowShown();
    await flush();
    expect(homeReads()).toBe(before + 1);
  });

  it('on screen again without coming forward (macOS: no longer covered by other windows), reads what waited, and is not a return', async () => {
    const store = await startStore();
    // Covered by other windows, then another app in front; back by ⌘-Tab: the app is active, but its window still covered.
    store.windowHidden();
    store.conceal();
    const before = homeReads();
    authority.items = [followUp(1)];
    await nextCheck();
    await store.resume();
    await flush();
    expect(homeReads()).toBe(before);
    const [checked, statuses] = [checks(), statusReads()];
    store.windowVisible();
    await flush();
    expect(homeReads()).toBe(before + 1);
    expect([checks(), statusReads()]).toEqual([checked, statuses]);
    // Visible with nothing waiting reads nothing.
    store.windowVisible();
    await flush();
    expect(homeReads()).toBe(before + 1);
  });

  it('with another app in front, checks run (a wake among them) and what shows waits for the cover to go', async () => {
    const store = await startStore();
    store.conceal();
    const before = homeReads();
    authority.items = [sent(1, MINA)];
    store.systemWoke();
    await flush();
    expect(checks()).toBe(2);
    expect(homeReads()).toBe(before);
    // Shown while covered: the account and a check, but the page waits; uncovered right after, it is read once.
    await store.windowShown();
    await flush();
    expect(homeReads()).toBe(before);
    await store.resume();
    await flush();
    expect(homeReads()).toBe(before + 1);
    expect(store.getState().concealed).toBe(false);
  });
});

describe('the sidebar, and projects you were added to (P2-3)', () => {
  it('a sidebar whose load failed is read again on a return though nothing moved, and the projects are learned then', async () => {
    let refuse = true;
    rpc.mockImplementation(rpcFor(new Held(), {
      ...changesHandlers(),
      'app.status': () => ok({ signed_in: true, account }),
      'projects.list': params => (refuse ? { ok: false, failure: { code: 'unavailable', retryable: true } }
        : ok(keysetPage(params.status === 'archived' ? authority.archived : authority.active, params.cursor))),
    }, () => ({ active: authority.active, archived: authority.archived })));
    const store = await startStore();
    expect(store.getState().projects).toMatchObject({ items: [], failure: { code: 'unavailable' } });
    refuse = false;
    await store.resume();
    await flush();
    expect(store.getState().projects.items.map(row => row.name)).toEqual(['Apollo']);
    expect(store.getState().projects.failure).toBeUndefined();
    // Learned on that check, not told: Apollo was yours before.
    expect(noticeTexts()).toEqual([]);
    const comet = project(2, 25, { name: 'Comet', role: 'member' });
    authority.active = [comet, apollo];
    await nextCheck();
    expect(noticeTexts()).toEqual(['You were added to Comet']);
  });

  it('a sidebar read outside the check (a return whose check failed) never hides an add from the next check', async () => {
    const store = await startStore();
    authority.changes = 'fails';
    const comet = project(2, 25, { name: 'Comet', role: 'member' });
    authority.active = [comet, apollo];
    await store.resume();
    await flush();
    expect(store.getState().projects.items.map(row => row.name)).toEqual(['Comet', 'Apollo']);
    expect(noticeTexts()).toEqual([]);
    authority.changes = 'ok';
    await nextCheck(120);
    expect(noticeTexts()).toEqual(['You were added to Comet']);
  });

  it('archiving or restoring a project past the loaded pages is never an add', async () => {
    authority.active = Array.from({ length: 15 }, (_, index) => project(index + 2, 28 - index));
    const store = await startStore();
    expect(store.getState().projects.items).toHaveLength(10);
    const last = authority.active.at(-1)!;
    authority.active = authority.active.slice(0, -1);
    authority.archived = [{ ...last, status: 'archived' }];
    await nextCheck();
    authority.active = [...authority.active, last];
    authority.archived = [];
    await nextCheck();
    expect(noticeTexts()).toEqual([]);
  });
});

describe('an older Authority (R8)', () => {
  it('logs once that it has no change check, reads the sidebar on each return, and checks no more on navigation', async () => {
    authority.changes = 'not_supported';
    const store = await startStore();
    expect(calls('log.changes').map(([, params]) => params)).toEqual([{ unsupported: true }]);
    const before = lists('active');
    await store.resume();
    await flush();
    expect(lists('active')).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(10_000);
    await store.openMine();
    await later();
    await store.windowShown();
    await flush();
    expect(checks()).toBe(1);
    expect(lists('active')).toBe(before + 2);
    expect(calls('log.changes')).toHaveLength(1);
  });

  it('a check that fails on a return reads the sidebar instead', async () => {
    const store = await startStore();
    authority.changes = 'fails';
    authority.active = [project(9, 29, { name: 'New' }), apollo];
    await store.resume();
    await flush();
    expect(store.getState().projects.items.map(row => row.name)).toEqual(['New', 'Apollo']);
    // No notification: without a check, nothing says what moved.
    expect(noticeTexts()).toEqual([]);
  });
});
