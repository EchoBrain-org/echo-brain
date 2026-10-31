// Home altitudes in the store (Home altitude v1, One place to look v1): what each altitude reads; zooming in and out, and into
// one kind of what needs you; a project's read failing alone; Home opening at its top on every start; and nothing of one
// account's altitude surviving another's sign-in.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenItemView, ProjectSummary } from '../../src/shared/protocol.js';
import { ACCOUNT, EMPTY_SUMMARY, fail, flush, Held, keysetPage, names, numbered, ok, project, rpcFor, startStore, storeLifecycle } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const THERMAL = project(1, 30, { name: 'Thermal' });
const BATTERY = project(2, 29, { name: 'Battery pack' });
const MINA = { membership_id: 'mem_mina', name: 'Mina Patel', active: true };

/** A follow-up in `of`, owned by Mina unless overridden. */
function row(id: string, of: ProjectSummary, extra: Partial<OpenItemView> = {}): OpenItemView {
  return {
    item_id: `itm_${id}`, run_id: 'run_1', kind: 'ticket',
    decision: { approval_id: 'apr_1', record_sha256: 'sha256:1', title: 'Pilot planning', first_line: null, approved_at: '2026-10-20T10:00:00.000Z', project_ids: [of.project_id] },
    relation: 'conflicts', expected: 'launch next week', approver: MINA, owner: { ...MINA, match: 'name' }, waits_on: 'owner', state: 'open',
    created_at: '2026-10-20T10:00:00.000Z', sent_at: '2026-10-20T11:00:00.000Z', state_set_at: '2026-10-20T11:00:00.000Z', state_set_by: MINA,
    owner_set_at: null, owner_set_by: null, send_included: true, check: null, can: { set_state: true, assign: true }, reach: 'not_read', ...extra,
  };
}

let held: Held;
let lists: { active: ProjectSummary[]; archived: ProjectSummary[] };
let account: typeof ACCOUNT | { authority: string; membership_id: string; display_name: string; role: string };
/** Each project's follow-ups, as the Authority holds them. */
let rows: Record<string, OpenItemView[]>;
let failing: Set<string>;
/** Projects whose rows read answers in two pages. */
let paged: Set<string>;

type Request = { operation: string; scope?: string; id?: string; read?: string; states?: string[]; item_id?: string; cursor?: string };
const requests = () => rpc.mock.calls.filter(([name]) => name === 'runs').map(([, params]) => (params as { request: Request }).request);
const projectReads = (id?: string) => requests().filter(request => request.operation === 'items' && request.scope === 'project' && (id === undefined || request.id === id));
const live = (request: Request) => request.read === undefined;
const runsAfter = (from: number) => rpc.mock.calls.slice(from).filter(([name]) => name === 'runs')
  .map(([, params]) => params as { expect: { membership_id: string }; request: Request });
const empty = () => ok({ items: [], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] });
/** A held runs reply that answers whichever read takes it, empty: a project's follow-ups, Home's runs, or what waits on you. */
const anyRuns = () => ok({ items: [], next_cursor: null, summary: EMPTY_SUMMARY, stages: [], runs: [], send: [], landed: 0, waiting: 0, last_checked_at: null,
  sweep_due: false });

/** The Authority's follow-up reads, from `rows`, `failing` and `paged`. */
function runsHandler(params: Record<string, unknown>): unknown {
    const request = (params as { request: Request }).request;
    if (request.operation === 'item') {
      const found = Object.values(rows).flat().find(item => item.item_id === request.item_id)!;
      return ok(request.read === undefined ? { ...found, reach: 'opened' } : found);
    }
    if (request.operation !== 'items' || request.scope !== 'project') return fail('unavailable', { retryable: true });
    if (failing.has(request.id!)) return fail('unavailable', { retryable: true });
    const all = rows[request.id!] ?? [];
    const summary = { ...EMPTY_SUMMARY, open: all.filter(item => item.state === 'open').length, done: all.filter(item => item.state === 'done').length };
    if (request.read === 'counts') return ok({ items: [], next_cursor: null, summary, stages: [] });
    const items = all.filter(item => !request.states || request.states.includes(item.state));
    const page = paged.has(request.id!) && request.read === 'rows' ? (request.cursor === undefined ? items.slice(0, 1) : items.slice(1)) : items;
    const next = paged.has(request.id!) && request.read === 'rows' && request.cursor === undefined ? 'page-2' : null;
    return ok({ items: live(request) ? page.map(item => ({ ...item, reach: 'opened' })) : page, next_cursor: next, summary, stages: [] });
}

/** A rename made here from the sidebar, which the Authority's list then carries. */
function rename(of: ProjectSummary, name: string, store: Awaited<ReturnType<typeof startStore>>): void {
  store.toggleProjectSettings(of, 'sidebar');
  store.beginProjectRename();
  store.setProjectRename(name);
  store.confirmProjectSetting();
  lists = { ...lists, active: lists.active.map(each => (each.project_id === of.project_id ? { ...each, name } : each)) };
}

storeLifecycle(new Date('2026-10-30T12:00:00.000Z'));
beforeEach(() => {
  held = new Held();
  lists = { active: [THERMAL, BATTERY], archived: [] };
  account = ACCOUNT;
  rows = { [THERMAL.project_id]: [row('t1', THERMAL), row('t2', THERMAL, { state: 'done' })], [BATTERY.project_id]: [row('b1', BATTERY)] };
  failing = new Set();
  paged = new Set();
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok({ signed_in: true, account }),
    runs: runsHandler,
  }, () => lists));
});

describe('Home altitudes', () => {
  it('opens at its top, My projects with no kind open, and reads your projects there with no click', async () => {
    const store = await startStore();
    await flush(80);
    expect(store.getState().altitude).toMatchObject({ level: 'projects', category: null });
    for (const each of [THERMAL, BATTERY]) expect(projectReads(each.project_id).some(request => request.read === 'counts')).toBe(true);
  });

  it('My projects counts and reads each project’s waiting follow-ups, and never reads one live', async () => {
    const store = await startStore();
    await flush(80);
    for (const each of [THERMAL, BATTERY]) {
      const reads = projectReads(each.project_id);
      expect(reads.filter(request => request.read === 'counts')).toHaveLength(1);
      expect(reads.filter(request => request.read === 'rows').map(request => request.states)).toEqual([['unsent', 'open']]);
    }
    expect(projectReads().filter(live)).toEqual([]);
    const read = store.getState().altitude.reads[THERMAL.project_id]!;
    expect(read.counts?.done).toBe(1);
    expect(read.active.map(item => item.item_id)).toEqual(['itm_t1']);
  });

  it('a project zoom reads its done follow-ups too, then reads its waiting ones live', async () => {
    const store = await startStore();
    store.zoomTo('project', { project_id: THERMAL.project_id });
    await flush(80);
    const reads = projectReads(THERMAL.project_id);
    expect(reads.some(request => request.read === 'rows' && request.states?.join() === 'unsent,open,done')).toBe(true);
    expect(reads.filter(live).map(request => request.states)).toEqual([['unsent', 'open']]);
    const read = store.getState().altitude.reads[THERMAL.project_id]!;
    expect(read.all?.map(item => item.item_id)).toEqual(['itm_t1', 'itm_t2']);
    expect(store.getState().altitude.live['itm_t1']?.reach).toBe('opened');
  });

  it('a person zoom reads at most twenty of their waiting follow-ups live, one by one', async () => {
    rows[BATTERY.project_id] = Array.from({ length: 25 }, (_, index) => row(`b${index}`, BATTERY));
    const store = await startStore();
    store.zoomTo('person', { membership_id: MINA.membership_id, name: MINA.name });
    await flush(200);
    const one = requests().filter(request => request.operation === 'item');
    expect(one).toHaveLength(20);
    expect(one.every(live)).toBe(true);
  });

  it('zooms out from a person to their project, then to My projects, and no further', async () => {
    const store = await startStore();
    store.zoomTo('project', { project_id: THERMAL.project_id });
    store.zoomTo('person', { membership_id: MINA.membership_id, name: MINA.name });
    expect(store.zoomOut()).toBe(true);
    expect(store.getState().altitude.level).toBe('project');
    expect(store.zoomOut()).toBe(true);
    expect(store.getState().altitude.level).toBe('projects');
    expect(store.zoomOut()).toBe(false);
  });

  it('one project’s read failing leaves the others read', async () => {
    failing.add(BATTERY.project_id);
    const store = await startStore();
    store.zoomTo('projects');
    await flush(80);
    const reads = store.getState().altitude.reads;
    expect(reads[BATTERY.project_id]?.failure?.code).toBe('unavailable');
    expect(reads[THERMAL.project_id]?.failure).toBeUndefined();
    expect(reads[THERMAL.project_id]?.active).toHaveLength(1);
  });

  it('another account’s sign-in starts at the top with nothing of the last account’s, and drops its late answers', async () => {
    // Once Home's first reads are in, the last account's reads of its projects wait until the new account's own have landed,
    // then answer with a follow-up and counts of theirs.
    const late: (() => void)[] = [];
    let holding = false;
    const theirs = ok({ items: [row('late', THERMAL)], next_cursor: null, summary: { ...EMPTY_SUMMARY, open: 9 }, stages: [] });
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok({ signed_in: true, account }),
      runs: params => {
        const { expect: from, request } = params as { expect: { membership_id: string }; request: Request };
        return holding && from.membership_id === ACCOUNT.membership_id && request.scope === 'project'
          ? new Promise(resolve => late.push(() => resolve(theirs))) : runsHandler(params);
      },
    }, () => lists));
    const store = await startStore();
    await flush(80);
    holding = true;
    store.zoomTo('project', { project_id: THERMAL.project_id });
    await flush(20);
    expect(late.length).toBeGreaterThan(0);
    account = { ...ACCOUNT, membership_id: 'another-member' };
    await store.refreshStatus();
    await flush(200);
    expect(store.getState().altitude.reads[THERMAL.project_id]?.loading).toBe(false);
    late.forEach(answer => answer());
    await flush(200);
    const altitude = store.getState().altitude;
    expect(altitude.level).toBe('projects');
    expect(altitude.category).toBeNull();
    expect(altitude.project_id).toBeNull();
    const reads = Object.values(altitude.reads);
    expect(reads.flatMap(read => [...read.active, ...(read.all ?? [])]).map(item => item.item_id)).not.toContain('itm_late');
    expect(reads.map(read => read.counts?.open)).not.toContain(9);
    expect(Object.keys(altitude.live)).not.toContain('itm_late');
  });

  it('a project that left your list falls back to My projects when Home shows again', async () => {
    const store = await startStore();
    store.zoomTo('project', { project_id: THERMAL.project_id });
    lists = { active: [BATTERY], archived: [] };
    await store.loadProjects();
    store.goHome();
    await flush(80);
    expect(store.getState().altitude.level).toBe('projects');
    expect(store.getState().altitude.project_id).toBeNull();
  });

  it('opens at the top on every start, never where an earlier one was zoomed, and forgets the place an older version kept', async () => {
    const left = JSON.stringify({ account: `${ACCOUNT.authority} ${ACCOUNT.membership_id}`, level: 'project', project_id: THERMAL.project_id });
    const storage = { getItem: vi.fn((key: string) => (key === 'echo.home.altitude' ? left : null)), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    const store = await startStore();
    expect(store.getState().altitude).toMatchObject({ level: 'projects', category: null, project_id: null });
    expect(storage.removeItem).toHaveBeenCalledWith('echo.home.altitude');
    // Zooming keeps nothing for the next start.
    store.zoomTo('project', { project_id: THERMAL.project_id });
    expect(storage.setItem.mock.calls.filter(([key]) => key === 'echo.home.altitude')).toEqual([]);
    expect(storage.getItem.mock.calls.filter(([key]) => key === 'echo.home.altitude')).toEqual([]);
    // No storage at all, or storage that refuses: the top all the same.
    vi.resetModules();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: vi.fn(), removeItem: () => { throw new Error('blocked'); } });
    expect((await startStore()).getState().altitude).toMatchObject({ level: 'projects', category: null });
  });
});

describe('one kind of what needs you, as Home zoomed into it (One place to look v1)', () => {
  /** What waits on you, as the Authority's home read answers it: each follow-up yours to update. */
  let waits: OpenItemView[];
  const yours = (id: string, of: ProjectSummary) => row(id, of, { owner: { ...MINA, membership_id: ACCOUNT.membership_id, name: ACCOUNT.display_name, match: 'name' } });
  beforeEach(() => {
    waits = [yours('w1', THERMAL), yours('w2', BATTERY)];
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok({ signed_in: true, account }),
      runs: params => {
        const request = (params as { request: Request }).request;
        if (request.operation === 'home') return ok({ send: [], items: waits, landed: 0, waiting: 0, last_checked_at: null, sweep_due: false });
        if (request.operation === 'list') return ok({ runs: [] });
        return runsHandler(params);
      },
    }, () => lists));
  });

  it('opens one kind’s list in place of the top; zooming out, the stops or a zoom anywhere close it', async () => {
    const store = await startStore();
    await flush(80);
    expect(store.homeRows().map(each => each.kind)).toEqual(['update', 'update']);
    store.openCategory('update');
    expect(store.getState().altitude).toMatchObject({ level: 'projects', category: 'update' });
    expect(store.zoomOut()).toBe(true);
    expect(store.getState().altitude.category).toBeNull();
    expect(store.zoomOut()).toBe(false);
    store.openCategory('update');
    store.zoomTo('projects');
    expect(store.getState().altitude.category).toBeNull();
    store.openCategory('update');
    store.zoomTo('project', { project_id: THERMAL.project_id });
    expect(store.getState().altitude).toMatchObject({ level: 'project', category: null });
  });

  it('comes back from another page as it was left, but the sidebar’s Home opens the top and keeps what it read', async () => {
    const store = await startStore();
    store.zoomTo('project', { project_id: THERMAL.project_id });
    await flush(80);
    store.zoomTo('projects');
    store.openCategory('update');
    await store.openOnlyMe();
    store.goHome();
    expect(store.getState().altitude.category).toBe('update');
    await store.openOnlyMe();
    store.openHome();
    expect(store.getState().route).toEqual({ page: 'home' });
    const altitude = store.getState().altitude;
    // The project stop stays open on the project last zoomed into.
    expect(altitude).toMatchObject({ level: 'projects', category: null, project_id: THERMAL.project_id });
    expect(altitude.reads[THERMAL.project_id]?.active.map(item => item.item_id)).toEqual(['itm_t1']);
  });

  it('goes back to the top by itself once its last row is dealt with, and stays while one is left', async () => {
    const store = await startStore();
    await flush(80);
    store.openCategory('update');
    waits = waits.slice(0, 1);
    await store.loadHome();
    await flush(40);
    expect(store.getState().altitude.category).toBe('update');
    waits = [];
    await store.loadHome();
    await flush(40);
    expect(store.getState().altitude.category).toBeNull();
  });
});

describe('Home altitudes, reading only what each step needs', () => {
  it('a zoom reads only what is new: the project zoomed into, and nothing on the way back out', async () => {
    const store = await startStore();
    store.zoomTo('projects');
    await flush(80);
    let from = rpc.mock.calls.length;
    store.zoomTo('project', { project_id: THERMAL.project_id });
    await flush(80);
    expect(runsAfter(from).every(call => call.request.id === THERMAL.project_id)).toBe(true);
    expect(runsAfter(from).length).toBeGreaterThan(0);
    from = rpc.mock.calls.length;
    store.zoomOut();
    await flush(80);
    expect(runsAfter(from)).toEqual([]);
  });

  it('a fresh read (Home shown, a return) reads every project again, and the person’s follow-ups live again', async () => {
    const store = await startStore();
    store.zoomTo('person', { membership_id: MINA.membership_id, name: MINA.name });
    await flush(120);
    const from = rpc.mock.calls.length;
    await store.loadAltitude();
    await flush(120);
    const again = runsAfter(from);
    for (const each of [THERMAL, BATTERY]) expect(again.some(call => call.request.id === each.project_id && call.request.read === 'counts')).toBe(true);
    expect(again.filter(call => call.request.operation === 'item').map(call => call.request.item_id).sort()).toEqual(['itm_b1', 'itm_t1']);
  });

  it('after another account signs in, the last account’s load sends nothing more', async () => {
    lists = { active: numbered(6), archived: [] };
    // Every read of the last account's projects waits until after the switch, then answers with a follow-up of theirs.
    const late: (() => void)[] = [];
    const theirs = ok({ items: [row('late', lists.active[0]!)], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] });
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok({ signed_in: true, account }),
      runs: params => {
        const { expect: from, request } = params as { expect: { membership_id: string }; request: Request };
        return from.membership_id === ACCOUNT.membership_id && request.scope === 'project' ? new Promise(resolve => late.push(() => resolve(theirs))) : runsHandler(params);
      },
    }, () => lists));
    const store = await startStore();
    await flush(20);
    expect(projectReads().length).toBeGreaterThan(0);
    account = { ...ACCOUNT, membership_id: 'another-member' };
    await store.refreshStatus();
    const from = rpc.mock.calls.length;
    late.forEach(answer => answer());
    await flush(200);
    expect(runsAfter(from).filter(call => call.request.scope === 'project' && call.expect.membership_id === ACCOUNT.membership_id)).toEqual([]);
    // What Home reads now is the new account's own: none of the last account's late answers lands.
    expect(Object.values(store.getState().altitude.reads).flatMap(read => read.active).map(item => item.item_id)).not.toContain('itm_late');
  });

  it('falls back to My projects as soon as the project it is zoomed on leaves your list', async () => {
    const store = await startStore();
    store.zoomTo('project', { project_id: THERMAL.project_id });
    await flush(80);
    lists = { active: [BATTERY], archived: [] };
    await store.loadProjects();
    await flush(40);
    expect(store.getState().altitude.level).toBe('projects');
  });

  it('covers every page of your projects, and zooms on a project past the sidebar’s first page', async () => {
    lists = { active: numbered(12), archived: [] };
    const twelfth = lists.active[11]!;
    const store = await startStore();
    store.zoomTo('project', { project_id: twelfth.project_id });
    await flush(200);
    expect(store.getState().altitude.level).toBe('project');
    expect(store.getState().altitude.project_id).toBe(twelfth.project_id);
    expect(new Set(projectReads().filter(request => request.read === 'counts').map(request => request.id)).size).toBe(12);
  });

  it('reads live only the person’s follow-ups in projects still on your list', async () => {
    const store = await startStore();
    store.zoomTo('projects');
    await flush(80);
    lists = { active: [THERMAL], archived: [] };
    await store.loadProjects();
    const from = rpc.mock.calls.length;
    store.zoomTo('person', { membership_id: MINA.membership_id, name: MINA.name });
    await flush(120);
    expect(runsAfter(from).filter(call => call.request.operation === 'item').map(call => call.request.item_id)).toEqual(['itm_t1']);
  });

  it('keeps your projects in list order until the first reads settle, or a second and a half', async () => {
    // Home's first reads, its projects' among them, wait.
    const releases = Array.from({ length: 10 }, () => held.hold('runs'));
    const store = await startStore();
    await flush(40);
    expect(store.getState().altitude.settled).toBe(false);
    vi.advanceTimersByTime(1_500);
    expect(store.getState().altitude.settled).toBe(true);
    releases.forEach(release => release(anyRuns()));
  });

  it('a project read no longer zoomed on drops its done follow-ups', async () => {
    const store = await startStore();
    store.zoomTo('project', { project_id: THERMAL.project_id });
    await flush(80);
    expect(store.getState().altitude.reads[THERMAL.project_id]?.all).not.toBeNull();
    store.zoomTo('projects');
    await store.loadAltitude();
    await flush(80);
    expect(store.getState().altitude.reads[THERMAL.project_id]?.all).toBeNull();
  });
});

describe('Home altitudes, when loads are cut short or the list is long', () => {
  it('a zoom that cuts a sweep short still reads the projects it left half read', async () => {
    lists = { active: numbered(6), archived: [] };
    // Home's first reads, its first projects' among them, wait: a quick click on a project cuts that sweep short.
    const releases = Array.from({ length: 12 }, () => held.hold('runs'));
    const store = await startStore();
    await flush(20);
    const loading = () => lists.active.map(each => store.getState().altitude.reads[each.project_id]?.loading ?? 'unread');
    expect(loading()).toContain(true);
    store.zoomTo('project', { project_id: lists.active[5]!.project_id });
    await flush(20);
    releases.forEach(release => release(anyRuns()));
    await flush(300);
    expect(loading()).toEqual(Array(6).fill(false));
  });

  it('a load cut short reads no further page', async () => {
    paged.add(THERMAL.project_id);
    rows[THERMAL.project_id] = [row('t1', THERMAL), row('t3', THERMAL)];
    // The last account's first reads of its projects wait until after the switch, then answer that a second page follows.
    const late: (() => void)[] = [];
    const page = ok({ items: [row('t1', THERMAL)], next_cursor: 'page-2', summary: EMPTY_SUMMARY, stages: [] });
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok({ signed_in: true, account }),
      runs: params => {
        const { expect: from, request } = params as { expect: { membership_id: string }; request: Request };
        return from.membership_id === ACCOUNT.membership_id && request.scope === 'project' ? new Promise(resolve => late.push(() => resolve(page))) : runsHandler(params);
      },
    }, () => lists));
    const store = await startStore();
    await flush(20);
    expect(projectReads(THERMAL.project_id).length).toBeGreaterThan(0);
    account = { ...ACCOUNT, membership_id: 'another-member' };
    await store.refreshStatus();
    const from = rpc.mock.calls.length;
    late.forEach(answer => answer());
    await flush(200);
    expect(runsAfter(from).filter(call => call.request.scope === 'project' && call.request.cursor === 'page-2' && call.expect.membership_id === ACCOUNT.membership_id))
      .toEqual([]);
  });

  it('a project that joins your list while a load is on its way is read', async () => {
    const store = await startStore();
    await flush(80);
    // Home's first reads are in; a zoom's reads (counts, waiting rows, every row) wait, so its load is on its way, not fresh.
    const releases = Array.from({ length: 3 }, () => held.hold('runs'));
    store.zoomTo('project', { project_id: THERMAL.project_id });
    await flush(20);
    expect(store.getState().altitude.reads[THERMAL.project_id]?.loading).toBe(true);
    const added = project(9, 20, { name: 'Late' });
    lists = { active: [THERMAL, BATTERY, added], archived: [] };
    await store.loadProjects();
    releases.forEach(release => release(anyRuns()));
    await flush(200);
    expect(projectReads(added.project_id).some(request => request.read === 'counts')).toBe(true);
    const reads = store.getState().altitude.reads;
    expect([THERMAL, added].map(each => reads[each.project_id]?.loading)).toEqual([false, false]);
  });

  it('with more projects than the sidebar’s first page, a project leaving the list sends Home back at once', async () => {
    lists = { active: numbered(12), archived: [] };
    const twelfth = lists.active[11]!;
    const store = await startStore();
    store.zoomTo('project', { project_id: twelfth.project_id });
    await flush(200);
    lists = { active: numbered(11), archived: [] };
    await store.loadProjects();
    await flush(200);
    expect(store.getState().altitude.level).toBe('projects');
  });

  it('says when it could not read every page of your projects', async () => {
    lists = { active: numbered(12), archived: [] };
    let calls = 0;
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok({ signed_in: true, account }),
      // The sidebar's own read of every page succeeds; Home's read of them, later, fails on the second page.
      'projects.list': params => {
        const cursor = (params as { cursor?: string }).cursor;
        if (cursor && (calls += 1) > 1) return fail('unavailable', { retryable: true });
        return ok(cursor ? { items: lists.active.slice(10), next_cursor: null } : { items: lists.active.slice(0, 10), next_cursor: 'more' });
      },
      runs: params => ((params as { request: Request }).request.operation === 'items' ? empty() : fail('unavailable', { retryable: true })),
    }, () => lists));
    const store = await startStore();
    store.zoomTo('projects');
    await flush(200);
    expect(store.getState().altitude.listFailure?.code).toBe('unavailable');
  });

  it('waits for your projects before it settles, so nothing jumps on first open', async () => {
    const release = held.hold('projects.list');
    const store = await startStore();
    store.zoomTo('projects');
    await flush(40);
    vi.advanceTimersByTime(2_000);
    expect(store.getState().altitude.settled).toBe(false);
    release(ok({ items: [THERMAL, BATTERY], next_cursor: null }));
    await flush(200);
    expect(store.getState().altitude.settled).toBe(true);
  });

  it('reads at most twenty of a person’s follow-ups live, however often Home zooms on them', async () => {
    rows[BATTERY.project_id] = Array.from({ length: 25 }, (_, index) => row(`b${index}`, BATTERY));
    const store = await startStore();
    store.zoomTo('person', { membership_id: MINA.membership_id, name: MINA.name });
    await flush(200);
    store.zoomTo('projects');
    await flush(80);
    store.zoomTo('person');
    await flush(200);
    expect(new Set(requests().filter(request => request.operation === 'item').map(request => request.item_id)).size).toBe(20);
  });
});

describe('Home altitudes when your projects change', () => {
  it('leaving the project Home is zoomed on sends Home to My projects', async () => {
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok({ signed_in: true, account }),
      'projects.leave': () => ok({}),
      runs: params => ((params as { request: Request }).request.operation === 'items'
        ? empty() : fail('unavailable', { retryable: true })),
    }, () => lists));
    const store = await startStore();
    store.zoomTo('project', { project_id: THERMAL.project_id });
    await flush(80);
    store.toggleProjectSettings(THERMAL, 'sidebar');
    store.askProjectSetting('leave');
    store.confirmProjectSetting();
    await flush(80);
    const altitude = store.getState().altitude;
    expect(altitude.level).toBe('projects');
    expect(altitude.project_id).toBeNull();
    expect(altitude.reads[THERMAL.project_id]).toBeUndefined();
  });

  it('a change to a long list made while Home is out of sight is seen when Home shows again', async () => {
    lists = { active: numbered(12), archived: [] };
    const store = await startStore();
    await flush(200);
    await store.openOnlyMe();
    const joined = project(13, 10, { name: 'Joined later' });
    lists = { active: [...numbered(12), joined], archived: [] };
    await store.loadProjects();
    await flush(80);
    store.goHome();
    await flush(200);
    expect(store.altitudeProjects().map(each => each.project_id)).toContain(joined.project_id);
  });

  it('stops saying it could not read every page once your projects fit the sidebar', async () => {
    lists = { active: numbered(12), archived: [] };
    let calls = 0;
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok({ signed_in: true, account }),
      'projects.list': params => {
        const cursor = (params as { cursor?: string }).cursor;
        if (cursor && (calls += 1) > 1) return fail('unavailable', { retryable: true });
        if (lists.active.length <= 10) return ok({ items: lists.active, next_cursor: null });
        return ok(cursor ? { items: lists.active.slice(10), next_cursor: null } : { items: lists.active.slice(0, 10), next_cursor: 'more' });
      },
      runs: params => ((params as { request: Request }).request.operation === 'items'
        ? empty() : fail('unavailable', { retryable: true })),
    }, () => lists));
    const store = await startStore();
    store.zoomTo('projects');
    await flush(200);
    expect(store.getState().altitude.listFailure).not.toBeNull();
    lists = { active: numbered(5), archived: [] };
    await store.loadProjects();
    await flush(80);
    expect(store.getState().altitude.listFailure).toBeNull();
  });
});

describe('Home altitudes keep their copy of a long list while they read it again', () => {
  it('coming back Home zoomed on a project past the first page keeps it on screen while every page is read again, even if that read fails', async () => {
    lists = { active: numbered(12), archived: [] };
    const twelfth = lists.active[11]!;
    const store = await startStore();
    store.zoomTo('project', { project_id: twelfth.project_id });
    await flush(200);
    await store.openProject(lists.active[0]!);
    await store.loadProjects();
    await flush(80);
    const release = held.hold('projects.list');
    store.goHome();
    await flush(40);
    expect(store.altitudeProjects().map(each => each.project_id)).toContain(twelfth.project_id);
    release(fail('unavailable', { retryable: true }));
    await flush(120);
    expect(store.altitudeProjects().map(each => each.project_id)).toContain(twelfth.project_id);
    expect(store.getState().altitude.listFailure?.code).toBe('unavailable');
  });

  it('a project restored while Home shows My projects is read', async () => {
    const OLD = project(5, 25, { name: 'Old', status: 'archived' });
    lists = { active: [THERMAL, BATTERY], archived: [OLD] };
    rpc.mockImplementation(rpcFor(held, { 'app.status': () => ok({ signed_in: true, account }), runs: runsHandler, 'projects.archive': () => ok({}) }, () => lists));
    const store = await startStore();
    store.zoomTo('projects');
    await flush(80);
    store.toggleProjectSettings(OLD, 'sidebar');
    store.askProjectSetting('unarchive');
    store.confirmProjectSetting();
    await flush(120);
    expect(projectReads(OLD.project_id).some(request => request.read === 'counts')).toBe(true);
  });

  it('a project renamed or made out of Home’s sight is in its copy by its name now, so Only me’s tiles still find it', async () => {
    lists = { active: numbered(12), archived: [] };
    const first = lists.active[0]!;
    const made = project(13, 30, { name: 'Made here' });
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok({ signed_in: true, account }), runs: runsHandler,
      'projects.rename': params => ok({ request_id: params.request_id, project_id: params.project_id, operation: 'rename' }),
      'projects.create': () => ok({ project_id: made.project_id }),
      'projects.read': () => ok(made),
    }, () => lists));
    const store = await startStore();
    await flush(200);
    expect(store.getState().altitude.list).not.toBeNull();
    await store.openOnlyMe();
    rename(first, 'Renamed', store);
    await flush(80);
    store.openNewProject();
    await flush();
    store.setNewProjectName('Made here');
    await store.createProject();
    lists = { active: [made, ...lists.active], archived: [] };
    await flush(80);
    await store.openOnlyMe();
    await flush(80);
    const shown = names(store.altitudeProjects());
    expect(shown).toContain('Renamed');
    expect(shown).not.toContain(first.name);
    expect(shown).toContain('Made here');
  });

  describe('out of Home’s sight, its copy takes the rows the sidebar just read, so Only me’s tiles find a project renamed elsewhere', () => {
    const FIRST = numbered(12)[0]!;
    const TWELFTH = numbered(12)[11]!;
    /** Renamed on another machine. */
    const renamed = (of: ProjectSummary, name: string) => {
      lists = { ...lists, active: lists.active.map(each => (each.project_id === of.project_id ? { ...each, name } : each)) };
    };

    beforeEach(() => {
      lists = { active: numbered(12), archived: [] };
      rpc.mockImplementation(rpcFor(held, {
        'app.status': () => ok({ signed_in: true, account }), runs: runsHandler,
        'projects.rename': params => ok({ request_id: params.request_id, project_id: params.project_id, operation: 'rename' }),
      }, () => lists));
    });

    it('the sidebar’s first page read again, then the change check reading every page', async () => {
      const store = await startStore();
      await flush(200);
      expect(store.getState().altitude.list).not.toBeNull();
      await store.openOnlyMe();
      renamed(FIRST, 'Renamed elsewhere');
      await store.loadProjects();
      await flush(80);
      expect(names(store.altitudeProjects())).toContain('Renamed elsewhere');
      expect(names(store.altitudeProjects())).not.toContain(FIRST.name);
      // Past the sidebar's first page: the change check reads every page.
      renamed(TWELFTH, 'Also renamed elsewhere');
      await vi.advanceTimersByTimeAsync(61_000);
      await flush(200);
      expect(names(store.altitudeProjects())).toContain('Also renamed elsewhere');
      expect(names(store.altitudeProjects())).not.toContain(TWELFTH.name);
      // Home still reads every page again when it shows.
      expect(store.getState().altitude.listStale).toBe(true);
    });

    it('but not a row the sidebar had before Home read its copy, nor a page read before a rename made here', async () => {
      // Three pages: More leaves one for the sidebar to read, so Home's copy still counts.
      lists = { active: numbered(25), archived: [] };
      const store = await startStore();
      await flush(200);
      renamed(FIRST, 'Renamed elsewhere');
      // Home shown reads every page: its copy has the new name, while the sidebar still shows the old one.
      store.goHome();
      await flush(200);
      await store.openOnlyMe();
      await store.loadProjects(true);
      expect(store.getState().projects.next).not.toBeNull();
      await flush(80);
      expect(names(store.altitudeProjects())).toContain('Renamed elsewhere');
      const release = held.hold('projects.list');
      void store.loadProjects();
      await flush(20);
      const second = lists.active[1]!;
      store.toggleProjectSettings(second, 'sidebar');
      store.beginProjectRename();
      store.setProjectRename('Renamed here');
      store.confirmProjectSetting();
      await flush(80);
      release(ok(keysetPage(lists.active, undefined)));
      await flush(80);
      expect(names(store.altitudeProjects())).toContain('Renamed here');
      expect(names(store.altitudeProjects())).not.toContain(second.name);
    });
  });

  it('a read of every page on its way when you leave a project does not bring it back', async () => {
    lists = { active: numbered(12), archived: [] };
    const third = lists.active[2]!;
    rpc.mockImplementation(rpcFor(held, { 'app.status': () => ok({ signed_in: true, account }), runs: runsHandler, 'projects.leave': () => ok({}) }, () => lists));
    const store = await startStore();
    store.zoomTo('projects');
    await flush(200);
    const release = held.hold('projects.list');
    void store.loadAltitude();
    await flush(20);
    store.toggleProjectSettings(third, 'sidebar');
    store.askProjectSetting('leave');
    store.confirmProjectSetting();
    lists = { active: lists.active.filter(each => each !== third), archived: [] };
    await flush(40);
    release(ok({ items: numbered(12).slice(0, 10), next_cursor: 'more' }));
    await flush(200);
    expect(store.altitudeProjects().map(each => each.project_id)).not.toContain(third.project_id);
  });
});

describe('Home altitudes drop a read of every page that a change overtook', () => {
  it('a read of every page still on its way when your projects change out of sight does not land', async () => {
    lists = { active: numbered(12), archived: [] };
    const store = await startStore();
    await flush(200);
    const release = held.hold('projects.list');
    void store.loadAltitude();
    await flush(20);
    await store.openOnlyMe();
    lists = { active: [...numbered(12), project(13, 10, { name: 'Joined later' })], archived: [] };
    await store.loadProjects();
    await flush(40);
    release(ok({ items: numbered(12).slice(0, 10), next_cursor: 'more' }));
    await flush(200);
    // Home keeps the copy it had, to read again when it shows: the read the change overtook never replaced it.
    expect(store.getState().altitude.listStale).toBe(true);
  });

  describe('a change made here that overtakes it has every page read again, so what that read carried still lands', () => {
    /** You were added to an old project: it sorts onto the second page. */
    const JOINED = project(13, 5, { name: 'Joined', role: 'member' });
    const OLD = project(14, 4, { name: 'Old', status: 'archived' });
    const MADE = project(15, 30, { name: 'Made here' });
    /** The next second page of your active projects read waits until it is released. */
    let holding: boolean;
    let release: (() => void) | null;

    beforeEach(() => {
      lists = { active: numbered(12), archived: [OLD] };
      holding = false;
      release = null;
      rpc.mockImplementation(rpcFor(held, {
        'app.status': () => ok({ signed_in: true, account }), runs: runsHandler,
        'projects.rename': params => ok({ request_id: params.request_id, project_id: params.project_id, operation: 'rename' }),
        'projects.archive': () => ok({}),
        'projects.create': () => ok({ project_id: MADE.project_id }),
        'projects.read': () => ok(MADE),
        'projects.list': params => {
          const page = ok(keysetPage(params.status === 'archived' ? lists.archived : lists.active, params.cursor));
          if (!holding || params.status === 'archived' || params.cursor === undefined) return page;
          holding = false;
          return new Promise(resolve => { release = () => resolve(page); });
        },
      }, () => lists));
    });

    it('a rename on Home while Home reads every page again', async () => {
      const store = await startStore();
      await flush(200);
      expect(store.getState().altitude.list).not.toBeNull();
      lists = { ...lists, active: [...numbered(12), JOINED] };
      holding = true;
      await store.loadProjects();
      await flush(40);
      expect(release).not.toBeNull();
      rename(lists.active[0]!, 'Renamed', store);
      await flush(80);
      release!();
      await flush(300);
      const shown = names(store.altitudeProjects());
      expect(shown).toContain('Renamed');
      expect(shown).not.toContain('Project 1');
      expect(shown).toContain('Joined');
      expect(projectReads(JOINED.project_id).some(request => request.read === 'counts')).toBe(true);
    });

    it('a rename while Home, just shown, reads every page', async () => {
      const store = await startStore();
      await flush(200);
      await store.openOnlyMe();
      lists = { ...lists, active: [...numbered(12), JOINED] };
      holding = true;
      store.goHome();
      await flush(40);
      expect(release).not.toBeNull();
      rename(lists.active[0]!, 'Renamed', store);
      await flush(80);
      release!();
      await flush(300);
      const shown = names(store.altitudeProjects());
      expect(shown).toContain('Renamed');
      expect(shown).toContain('Joined');
      expect(projectReads(JOINED.project_id).some(request => request.read === 'counts')).toBe(true);
    });

    it('a restore on Home while Home reads every page again', async () => {
      const store = await startStore();
      await flush(200);
      lists = { ...lists, active: [...numbered(12), JOINED] };
      holding = true;
      await store.loadProjects();
      await flush(40);
      expect(release).not.toBeNull();
      store.toggleProjectSettings(OLD, 'sidebar');
      store.askProjectSetting('unarchive');
      store.confirmProjectSetting();
      lists = { active: [...lists.active, { ...OLD, status: 'active' }], archived: [] };
      await flush(80);
      release!();
      await flush(300);
      const shown = names(store.altitudeProjects());
      expect(shown).toContain('Old');
      expect(shown).toContain('Joined');
      expect(projectReads(JOINED.project_id).some(request => request.read === 'counts')).toBe(true);
    });

    it('an archive on Home while Home reads every page again', async () => {
      const store = await startStore();
      await flush(200);
      const third = lists.active[2]!;
      lists = { ...lists, active: [...numbered(12), JOINED] };
      holding = true;
      await store.loadProjects();
      await flush(40);
      expect(release).not.toBeNull();
      store.toggleProjectSettings(third, 'sidebar');
      store.askProjectSetting('archive');
      store.confirmProjectSetting();
      lists = { active: lists.active.filter(each => each.project_id !== third.project_id), archived: [...lists.archived, { ...third, status: 'archived' }] };
      await flush(80);
      release!();
      await flush(300);
      const shown = names(store.altitudeProjects());
      expect(shown).not.toContain(third.name);
      expect(shown).toContain('Joined');
      expect(projectReads(JOINED.project_id).some(request => request.read === 'counts')).toBe(true);
    });

    it('a project made here while a read of every page is on its way out of Home’s sight', async () => {
      const store = await startStore();
      await flush(200);
      lists = { ...lists, active: [...numbered(12), JOINED] };
      holding = true;
      void store.loadAltitude();
      await flush(40);
      expect(release).not.toBeNull();
      await store.openOnlyMe();
      store.openNewProject();
      await flush();
      store.setNewProjectName('Made here');
      await store.createProject();
      lists = { ...lists, active: [MADE, ...lists.active] };
      await flush(80);
      release!();
      await flush(300);
      expect(names(store.altitudeProjects())).toContain('Made here');
      // Home reads every page again when it shows: the read the project overtook carried a project you joined.
      expect(store.getState().altitude.listStale).toBe(true);
    });
  });
});
