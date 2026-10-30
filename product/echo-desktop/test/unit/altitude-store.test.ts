// Home altitudes in the store (Home altitude v1): what each altitude reads, and when it reads nothing; zooming in and out; a
// project's read failing alone; and nothing of one account's altitude surviving another's sign-in.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenItemView, ProjectSummary } from '../../src/shared/protocol.js';
import { ACCOUNT, EMPTY_SUMMARY, fail, flush, Held, numbered, ok, project, rpcFor, startStore, storeLifecycle } from './harness.js';

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
  it('reads nothing of your projects while Home shows Me', async () => {
    const store = await startStore();
    expect(store.getState().altitude.level).toBe('me');
    expect(projectReads()).toEqual([]);
  });

  it('My projects counts and reads each project’s waiting follow-ups, and never reads one live', async () => {
    const store = await startStore();
    store.zoomTo('projects');
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
    store.zoomTo('me');
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

  it('another account’s sign-in starts at Me with nothing of the last account’s, and drops its late answers', async () => {
    const store = await startStore();
    const release = held.hold('runs');
    store.zoomTo('project', { project_id: THERMAL.project_id });
    account = { ...ACCOUNT, membership_id: 'another-member' };
    await store.refreshStatus();
    await flush();
    release(ok({ items: [row('late', THERMAL)], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] }));
    await flush(80);
    const altitude = store.getState().altitude;
    expect(altitude.level).toBe('me');
    expect(altitude.project_id).toBeNull();
    expect(Object.values(altitude.reads).flatMap(read => read.active)).toEqual([]);
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

  it('starts at the altitude this account left Home at on this computer, and at Me for another account or none', async () => {
    const kept = (account: string) => ({ getItem: (key: string) => (key === 'echo.home.altitude' ? JSON.stringify({ account, level: 'projects' }) : null), setItem: vi.fn() });
    vi.stubGlobal('localStorage', kept(`${ACCOUNT.authority} ${ACCOUNT.membership_id}`));
    const store = await startStore();
    expect(store.getState().altitude.level).toBe('projects');
    vi.resetModules();
    vi.stubGlobal('localStorage', kept(`${ACCOUNT.authority} someone-else`));
    expect((await startStore()).getState().altitude.level).toBe('me');
    vi.resetModules();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: vi.fn() });
    const again = await startStore();
    expect(again.getState().altitude.level).toBe('me');
  });
});

describe('Home altitudes, reading only what each step needs', () => {
  const runsAfter = (from: number) => rpc.mock.calls.slice(from).filter(([name]) => name === 'runs')
    .map(([, params]) => params as { expect: { membership_id: string }; request: Request });

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
    const store = await startStore();
    const releases = Array.from({ length: 8 }, () => held.hold('runs'));
    store.zoomTo('projects');
    await flush(20);
    account = { ...ACCOUNT, membership_id: 'another-member' };
    await store.refreshStatus();
    const from = rpc.mock.calls.length;
    releases.forEach(release => release(ok({ items: [], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] })));
    await flush(200);
    expect(runsAfter(from).filter(call => call.expect.membership_id === ACCOUNT.membership_id)).toEqual([]);
    expect(Object.keys(store.getState().altitude.reads)).toEqual([]);
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

  it('covers every page of your projects, and keeps a remembered project past the sidebar’s first page', async () => {
    lists = { active: numbered(12), archived: [] };
    const twelfth = lists.active[11]!;
    vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'echo.home.altitude'
      ? JSON.stringify({ account: `${ACCOUNT.authority} ${ACCOUNT.membership_id}`, level: 'project', project_id: twelfth.project_id }) : null), setItem: vi.fn() });
    const store = await startStore();
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
    const store = await startStore();
    const release = held.hold('runs');
    store.zoomTo('projects');
    await flush(40);
    expect(store.getState().altitude.settled).toBe(false);
    vi.advanceTimersByTime(1_500);
    expect(store.getState().altitude.settled).toBe(true);
    release(ok({ items: [], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] }));
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
  const runsAfter = (from: number) => rpc.mock.calls.slice(from).filter(([name]) => name === 'runs')
    .map(([, params]) => params as { expect: { membership_id: string }; request: Request });
  const empty = () => ok({ items: [], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] });

  it('a zoom that cuts a sweep short still reads the projects it left half read', async () => {
    lists = { active: numbered(6), archived: [] };
    const store = await startStore();
    const releases = Array.from({ length: 8 }, () => held.hold('runs'));
    store.zoomTo('projects');
    await flush(20);
    store.zoomTo('project', { project_id: lists.active[5]!.project_id });
    await flush(20);
    releases.forEach(release => release(empty()));
    await flush(300);
    const reads = store.getState().altitude.reads;
    expect(lists.active.map(each => reads[each.project_id]?.loading ?? 'unread')).toEqual(Array(6).fill(false));
  });

  it('a load cut short reads no further page', async () => {
    paged.add(THERMAL.project_id);
    rows[THERMAL.project_id] = [row('t1', THERMAL), row('t3', THERMAL)];
    const store = await startStore();
    const releases = Array.from({ length: 4 }, () => held.hold('runs'));
    store.zoomTo('projects');
    await flush(20);
    account = { ...ACCOUNT, membership_id: 'another-member' };
    await store.refreshStatus();
    const from = rpc.mock.calls.length;
    releases.forEach(release => release(ok({ items: [row('t1', THERMAL)], next_cursor: 'page-2', summary: EMPTY_SUMMARY, stages: [] })));
    await flush(200);
    expect(runsAfter(from).filter(call => call.request.cursor === 'page-2' && call.expect.membership_id === ACCOUNT.membership_id)).toEqual([]);
  });

  it('a project that joins your list while a sweep is on its way is read', async () => {
    const store = await startStore();
    const release = held.hold('runs');
    store.zoomTo('projects');
    await flush(20);
    const added = project(9, 20, { name: 'Late' });
    lists = { active: [THERMAL, BATTERY, added], archived: [] };
    await store.loadProjects();
    release(empty());
    await flush(200);
    expect(projectReads(added.project_id).some(request => request.read === 'counts')).toBe(true);
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
        ? ok({ items: [], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] }) : fail('unavailable', { retryable: true })),
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

  it('a change to a long list made while Home sits at Me is seen on the next zoom', async () => {
    lists = { active: numbered(12), archived: [] };
    const store = await startStore();
    store.zoomTo('projects');
    await flush(200);
    store.zoomTo('me');
    const joined = project(13, 10, { name: 'Joined later' });
    lists = { active: [...numbered(12), joined], archived: [] };
    await store.loadProjects();
    await flush(80);
    store.zoomTo('projects');
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
        ? ok({ items: [], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] }) : fail('unavailable', { retryable: true })),
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
    const release = held.hold('projects.list');
    store.zoomTo('projects');
    await flush(20);
    store.zoomTo('me');
    lists = { active: [...numbered(12), project(13, 10, { name: 'Joined later' })], archived: [] };
    await store.loadProjects();
    await flush(40);
    release(ok({ items: numbered(12).slice(0, 10), next_cursor: 'more' }));
    await flush(200);
    expect(store.getState().altitude.list).toBeNull();
  });
});

