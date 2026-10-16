// Notifications (desktop refresh and notifications v1, section 3): a change
// someone else made to a follow-up you are involved in (you sent it, own it, or
// last handed it on), and being added to a project, come as one system
// notification per change check. Your own changes, checks, meetings, reviews,
// removals and role changes only update the screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpList, ItemPage } from '../../src/renderer/store.js';
import type { Account, OpenItemView } from '../../src/shared/protocol.js';
import { ME, MINA, RAFAEL, authority, followUp, id, nextCheck, owned, sent, stated, changesHandlers } from './changes-fixture.js';
import { ACCOUNT, flush, Held, keysetPage, ok, project, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const OTHER: Account = { ...ACCOUNT, membership_id: 'other', display_name: 'Other' };
let account: Account | null;
/** While set, the next change check waits until the test answers it, with what the Authority holds then. */
let holdChanges = false;
let answers: (() => void)[] = [];

const notices = () => rpc.mock.calls.filter(([method]) => method === 'notice.show').map(([, params]) => params);
const texts = () => notices().map(notice => notice.text);
/** Reads of the open follow-ups you are involved in: the check's, never Home's. */
const followed = () => rpc.mock.calls.filter(([method, params]) => method === 'runs' && params.request.operation === 'items' && params.request.read === 'rows'
  && params.request.states?.join() === 'open');

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  stubWindow();
  authority.reset();
  account = ACCOUNT;
  holdChanges = false;
  answers = [];
  rpc.mockReset();
  const fixture = changesHandlers();
  rpc.mockImplementation(rpcFor(new Held(), {
    ...fixture,
    'app.status': () => ok(account ? { signed_in: true, account } : { signed_in: false, account: null }),
    'changes.read': params => {
      if (!holdChanges) return fixture['changes.read']!(params);
      return new Promise(resolve => { answers.push(() => resolve(fixture['changes.read']!(params))); });
    },
  }, () => ({ active: authority.active, archived: authority.archived })));
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Signed in with `items` already there: the first check learns them. */
async function signedIn(items: OpenItemView[] = []) {
  authority.items = items;
  return startStore();
}

describe('the first check after sign-in', () => {
  it('only learns: what already involves you tells nothing, and nothing changed tells nothing', async () => {
    await signedIn([followUp(1), sent(2, MINA)]);
    expect(followed().map(([, params]) => params.request)).toEqual([{ schema_version: 1, operation: 'items', scope: 'involved', states: ['open'], read: 'rows' }]);
    await nextCheck();
    expect(notices()).toEqual([]);
    // A check whose follow-ups did not move reads none of them again.
    expect(followed()).toHaveLength(1);
  });

  it('when it could not read your follow-ups, reads them again at every check, moved or not, and learns only from a read', async () => {
    authority.items = [followUp(1)];
    const fixture = changesHandlers();
    let refuse = true;
    rpc.mockImplementation(rpcFor(new Held(), {
      ...fixture, 'runs': params => (refuse ? { ok: false, failure: { code: 'unavailable', retryable: true } } : fixture.runs!(params)),
    }, () => ({ active: [], archived: [] })));
    await startStore();
    // Still refused: nothing learned, so nothing is lost either.
    await nextCheck();
    expect(followed()).toHaveLength(2);
    refuse = false;
    // Nothing moved, yet the follow-ups are read, and only now learned.
    await nextCheck();
    expect(followed()).toHaveLength(3);
    expect(notices()).toEqual([]);
    // The very next change is told.
    authority.items = [followUp(1), followUp(2)];
    await nextCheck();
    expect(texts()).toEqual(['Mina handed you Action 2']);
    await nextCheck();
    expect(followed()).toHaveLength(4);
  });
});

describe('what notifies (N2)', () => {
  it('a first Send to you, by who sent it, and once', async () => {
    await signedIn();
    authority.items = [followUp(2, { expected: 'Update the pricing page' })];
    await nextCheck();
    expect(notices()).toEqual([{ text: 'Mina handed you Update the pricing page', target: { kind: 'item', item_id: id(2) } }]);
    await nextCheck();
    expect(notices()).toHaveLength(1);
  });

  it('one handed to you by someone else, by who handed it', async () => {
    const item = sent(1, RAFAEL);
    await signedIn([item]);
    authority.items = [owned(item, ME, RAFAEL, 30)];
    await nextCheck();
    expect(texts()).toEqual(['Rafael handed you Action 1']);
  });

  it.each([['done', 'Mina marked Action 1 done'], ['not_relevant', 'Mina marked Action 1 not relevant']] as const)(
    'one you sent, marked %s by its owner: told to you as its sender', async (state, text) => {
      const item = sent(1, MINA);
      await signedIn([item]);
      authority.items = [stated(item, state, MINA, 30)];
      await nextCheck();
      expect(notices()).toEqual([{ text, target: { kind: 'item', item_id: id(1) } }]);
    });

  it('one reopened, to its owner, and to its sender', async () => {
    const yours = stated(followUp(1), 'done', ME, 20);
    const theirs = stated(sent(2, MINA), 'done', MINA, 20);
    await signedIn([yours]);
    authority.items = [stated(yours, 'open', MINA, 30)];
    await nextCheck();
    authority.items = [...authority.items, theirs];
    await nextCheck();
    authority.items = [authority.items[0]!, stated(theirs, 'open', MINA, 40)];
    await nextCheck();
    expect(texts()).toEqual(['Mina reopened Action 1', 'Mina reopened Action 2']);
  });

  it('one you sent, handed on by its owner to someone else', async () => {
    const item = sent(1, MINA);
    await signedIn([item]);
    authority.items = [owned(item, RAFAEL, MINA, 30)];
    await nextCheck();
    expect(texts()).toEqual(['Mina handed Action 1 to Rafael']);
  });

  it('one you last handed on, handed on again: it leaves what involves you, and is read by its id to say so', async () => {
    // Rafael sent it to you; you handed it to Mina.
    const item = owned(followUp(1, { approver: RAFAEL, state_set_by: RAFAEL }), MINA, ME, 20);
    await signedIn([item]);
    authority.items = [owned(item, RAFAEL, MINA, 30)];
    await nextCheck();
    expect(texts()).toEqual(['Mina handed Action 1 to Rafael']);
    expect(rpc.mock.calls.filter(([method, params]) => method === 'runs' && params.request.operation === 'item').map(([, params]) => params.request))
      .toEqual([{ schema_version: 1, operation: 'item', item_id: id(1), read: 'rows' }]);
  });

  it('a project you were added to, by name, opening it', async () => {
    authority.active = [project(1, 20)];
    await signedIn();
    const comet = project(2, 25, { name: 'Comet', role: 'member' });
    authority.active = [comet, project(1, 20)];
    await nextCheck();
    expect(notices()).toEqual([{ text: 'You were added to Comet', target: { kind: 'project', project_id: comet.project_id } }]);
  });

  it('a project you were added to that sorts past the sidebar\'s pages, once, opening it though no sidebar row has it', async () => {
    authority.active = Array.from({ length: 15 }, (_, index) => project(index + 2, 28 - index));
    const store = await signedIn();
    expect(store.getState().projects.items).toHaveLength(10);
    // The oldest project there is: past every page the sidebar shows.
    const oldest = project(40, 1, { name: 'Oldest', role: 'member' });
    authority.active = [...authority.active, oldest];
    await nextCheck();
    expect(notices()).toEqual([{ text: 'You were added to Oldest', target: { kind: 'project', project_id: oldest.project_id } }]);
    expect(store.getState().projects.items.map(row => row.name)).not.toContain('Oldest');
    // Another move tells nothing new.
    authority.active = authority.active.map(row => (row.name === 'Project 2' ? { ...row, name: 'Project 2, renamed' } : row));
    await nextCheck();
    expect(notices()).toHaveLength(1);
    store.openNotified({ kind: 'project', project_id: oldest.project_id });
    await flush();
    expect(store.getState().route).toMatchObject({ page: 'project', project: { name: 'Oldest' } });
  });

  it('a project you lead, made before the newest you had, on the Authority\'s clock: someone else made you its lead', async () => {
    // Your newest project was made at 10:00; Ana made hers at 09:00 and added you as its lead at 14:00.
    authority.active = [project(1, 20, { created_at: '2026-09-20T10:00:00.000Z' })];
    await signedIn();
    const anas = project(2, 20, { name: 'Ana\'s', role: 'lead', created_at: '2026-09-20T09:00:00.000Z' });
    authority.active = [...authority.active, anas];
    await nextCheck();
    expect(texts()).toEqual(['You were added to Ana\'s']);
  });

  it('a project you lead that was made before the last check: someone else made you its lead', async () => {
    await signedIn();
    authority.active = [project(1, 10, { name: 'Old', role: 'lead' })];
    await nextCheck();
    expect(texts()).toEqual(['You were added to Old']);
  });

  it('names a document follow-up as its row does, and cuts a long title to one line of 200 characters', async () => {
    await signedIn();
    authority.items = [followUp(1, { kind: 'ticket', expected: 'launch next week' }), followUp(2, { kind: 'ticket', decision: undefined })];
    await nextCheck();
    authority.items = [];
    await nextCheck();
    authority.items = [followUp(3, { expected: `Line one\nline two ${'x'.repeat(300)}` })];
    await nextCheck();
    expect(texts()[0]).toBe('2 follow-ups changed');
    const long = texts()[1]!;
    expect(long).toMatch(/^Mina handed you Line one line two x+…$/);
    expect([...long.slice('Mina handed you '.length)]).toHaveLength(200);
  });
});

describe('a follow-up that leaves your open ones (P3)', () => {
  it('is read by its id again at the next check when that read failed, and told then', async () => {
    const item = sent(1, MINA);
    await signedIn([item]);
    const fixture = changesHandlers();
    let refuse = true;
    rpc.mockImplementation(rpcFor(new Held(), {
      ...fixture,
      'runs': params => ((params.request as { operation: string }).operation === 'item' && refuse
        ? { ok: false, failure: { code: 'unavailable', retryable: true } } : fixture.runs!(params)),
    }, () => ({ active: authority.active, archived: authority.archived })));
    authority.items = [stated(item, 'done', MINA, 30)];
    await nextCheck();
    expect(notices()).toEqual([]);
    refuse = false;
    // Nothing moved since: it is read again all the same.
    await nextCheck();
    expect(texts()).toEqual(['Mina marked Action 1 done']);
    await nextCheck();
    expect(notices()).toHaveLength(1);
  });

  it('is read twenty a check: the rest wait for the next', async () => {
    const items = Array.from({ length: 22 }, (_, index) => sent(index + 1, MINA));
    await signedIn(items);
    authority.items = items.map(item => stated(item, 'done', MINA, 40));
    await nextCheck();
    await nextCheck();
    expect(texts()).toEqual(['20 follow-ups changed', '2 follow-ups changed']);
  });

  it('one new to your open ones whose change is older than the newest the last read saw is not news', async () => {
    await signedIn([followUp(5)]);
    // Sent to you at 10:01, long before 10:05: it only came into view.
    authority.items = [followUp(5), followUp(1)];
    await nextCheck();
    expect(notices()).toEqual([]);
    authority.items = [followUp(5), followUp(1), followUp(9)];
    await nextCheck();
    expect(texts()).toEqual(['Mina handed you Action 9']);
  });
});

describe('what never notifies (N3)', () => {
  it('your own changes, from any device: a Send, a handoff, a done, a reopen', async () => {
    const item = sent(1, MINA);
    await signedIn([item, followUp(2)]);
    authority.items = [owned(item, RAFAEL, ME, 30), stated(followUp(2), 'done', ME, 31)];
    await nextCheck();
    authority.items = [owned(item, RAFAEL, ME, 30), stated(followUp(2), 'open', ME, 32), sent(3, RAFAEL, { state_set_by: ME })];
    await nextCheck();
    expect(notices()).toEqual([]);
  });

  it('a check, and other activity: items that do not involve you, and one you only own taken back by its sender', async () => {
    const item = followUp(1);
    await signedIn([item]);
    authority.items = [{ ...item, check: { verdict: 'landed', checked_at: '2026-10-14T12:00:00.000Z', checked_by: 'Mina Patel' } },
      followUp(2, { approver: MINA, owner: { ...RAFAEL, match: 'name' } })];
    await nextCheck();
    authority.items = [owned(item, RAFAEL, MINA, 30)];
    await nextCheck();
    expect(notices()).toEqual([]);
  });

  it('meetings and reviews, removal from a project, and a role changed', async () => {
    authority.active = [project(1, 20), project(2, 19)];
    await signedIn();
    authority.reviews = ['apr_1:pending'];
    authority.active = [{ ...project(1, 20), role: 'member' }];
    await nextCheck();
    expect(notices()).toEqual([]);
  });

  it('a project made on this desktop, or one you lead made since the last check (yours, made elsewhere)', async () => {
    authority.active = [project(1, 20)];
    const store = await startStore();
    const made = project(2, 21, { name: 'Made here', created_at: new Date().toISOString() });
    const elsewhere = project(3, 22, { name: 'Made elsewhere', created_at: new Date(Date.now() + 1000).toISOString() });
    rpc.mockImplementation(rpcFor(new Held(), {
      ...changesHandlers(),
      'projects.create': () => ok({ project_id: made.project_id }),
      'projects.read': () => ok(made),
    }, () => ({ active: authority.active, archived: authority.archived })));
    store.openNewProject();
    store.setNewProjectName('Made here');
    authority.active = [made, project(1, 20)];
    await store.createProject();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    authority.active = [elsewhere, made, project(1, 20)];
    await nextCheck();
    expect(notices()).toEqual([]);
    expect(store.getState().projects.items.map(row => row.name)).toEqual(['Made elsewhere', 'Made here', 'Project 1']);
  });

  it('retries a failed full read of your projects at the next check, the fingerprint unchanged, and tells the add then (review B)', async () => {
    authority.active = Array.from({ length: 15 }, (_, index) => project(index + 2, 28 - index));
    let refuseMore = false;
    rpc.mockImplementation(rpcFor(new Held(), {
      ...changesHandlers(),
      'app.status': () => ok({ signed_in: true, account: ACCOUNT }),
      'projects.list': params => (refuseMore && params.cursor ? { ok: false, failure: { code: 'unavailable', retryable: true } }
        : ok(keysetPage(params.status === 'archived' ? authority.archived : authority.active, params.cursor))),
    }, () => ({ active: authority.active, archived: authority.archived })));
    await startStore();
    authority.active = [...authority.active, project(40, 1, { name: 'Oldest invited project', role: 'member' })];
    // The sidebar's own page reads; the full read's second page fails.
    refuseMore = true;
    await nextCheck();
    expect(notices()).toEqual([]);
    refuseMore = false;
    await nextCheck();
    await nextCheck(300);
    expect(texts()).toEqual(['You were added to Oldest invited project']);
  });

  it('the first check learns every page of your projects, active and archived, without a word', async () => {
    authority.active = Array.from({ length: 25 }, (_, index) => project(index + 2, 28 - index));
    authority.archived = [project(50, 2, { status: 'archived' })];
    await signedIn();
    const reads = rpc.mock.calls.filter(([method]) => method === 'projects.list').map(([, params]) => `${params.status}${params.cursor ? ' more' : ''}`);
    // The sidebar's first page of each, then all three active pages and the archived one.
    expect(reads.sort()).toEqual(['active', 'active', 'active more', 'active more', 'archived', 'archived']);
    await nextCheck();
    expect(notices()).toEqual([]);
  });

  it('a full read of your projects that fails part-way tells nothing, and the next move tells it', async () => {
    authority.active = Array.from({ length: 15 }, (_, index) => project(index + 2, 28 - index));
    let refuseMore = false;
    const fixture = changesHandlers();
    rpc.mockImplementation(rpcFor(new Held(), {
      ...fixture,
      'app.status': () => ok({ signed_in: true, account: ACCOUNT }),
      'projects.list': params => (refuseMore && params.cursor ? { ok: false, failure: { code: 'unavailable', retryable: true } }
        : ok(keysetPage(params.status === 'archived' ? authority.archived : authority.active, params.cursor))),
    }, () => ({ active: authority.active, archived: authority.archived })));
    await startStore();
    const oldest = project(40, 1, { name: 'Oldest', role: 'member' });
    authority.active = [...authority.active, oldest];
    refuseMore = true;
    await nextCheck();
    expect(notices()).toEqual([]);
    refuseMore = false;
    authority.active = [project(41, 29, { name: 'Newest', role: 'member' }), ...authority.active];
    await nextCheck();
    expect(notices()).toEqual([{ text: 'Added to 2 projects', target: { kind: 'project', project_id: project(41, 29).project_id } }]);
  });

  it('a project that was behind More all along, now in the pages shown', async () => {
    authority.active = Array.from({ length: 11 }, (_, index) => project(index + 1, 28 - index));
    const store = await signedIn();
    expect(store.getState().projects.items).toHaveLength(10);
    // The newest leaves: the eleventh moves into the first page.
    authority.active = authority.active.slice(1);
    await nextCheck();
    expect(store.getState().projects.items.map(row => row.name)).toContain('Project 11');
    expect(notices()).toEqual([]);
  });
});

describe('noise (N4)', () => {
  it('several in one check come as one, counted, opening exactly those; with a project added too, both are counted', async () => {
    authority.active = [project(1, 20)];
    await signedIn([sent(1, MINA)]);
    authority.items = [stated(sent(1, MINA), 'done', MINA, 30), followUp(2), followUp(3)];
    await nextCheck();
    authority.items = [...authority.items, followUp(4)];
    authority.active = [project(2, 25, { name: 'Comet', role: 'member' }), project(1, 20)];
    await nextCheck();
    authority.active = [project(3, 26, { role: 'member' }), project(4, 26, { role: 'member' }), ...authority.active];
    await nextCheck();
    expect(notices()).toEqual([
      { text: '3 follow-ups changed', target: { kind: 'items', item_ids: [id(2), id(3), id(1)] } },
      // One follow-up beside a project add opens its own page.
      { text: '1 follow-up changed · added to 1 project', target: { kind: 'item', item_id: id(4) } },
      { text: 'Added to 2 projects', target: { kind: 'project', project_id: project(3, 26).project_id } },
    ]);
  });

  it('notifies of an item whose page is open while the window is hidden or covered: you are not looking at it', async () => {
    const store = await signedIn([followUp(1)]);
    await store.openFollowUp(id(1));
    store.windowHidden();
    authority.items = [stated(followUp(1), 'open', MINA, 40)];
    await nextCheck();
    await store.windowShown();
    await vi.advanceTimersByTimeAsync(2_000);
    store.conceal();
    authority.items = [stated(followUp(1), 'open', MINA, 45)];
    await nextCheck();
    expect(texts()).toEqual(['Mina reopened Action 1', 'Mina reopened Action 1']);
  });

  it('does not notify of an item whose page is open, but reads that page again', async () => {
    const store = await signedIn([followUp(1)]);
    await store.openFollowUp(id(1));
    const reads = () => rpc.mock.calls.filter(([method, params]) => method === 'runs' && params.request.operation === 'item').length;
    const before = reads();
    authority.items = [stated(followUp(1), 'open', MINA, 40)];
    await nextCheck();
    expect(notices()).toEqual([]);
    expect(reads()).toBeGreaterThan(before);
    expect((store.followUpShown() as ItemPage).item?.state_set_at).toBe(authority.items[0]!.state_set_at);
  });

  it('after a wake, what changed while asleep notifies, in one summary', async () => {
    const store = await signedIn([sent(1, MINA)]);
    authority.items = [stated(sent(1, MINA), 'done', MINA, 30), followUp(2)];
    store.systemWoke();
    await flush();
    expect(notices()).toEqual([{ text: '2 follow-ups changed', target: { kind: 'items', item_ids: [id(2), id(1)] } }]);
  });

  it('stops on sign-out, and learns again at sign-in', async () => {
    const store = await signedIn();
    account = null;
    await store.refreshStatus();
    await flush();
    authority.items = [followUp(1)];
    await nextCheck();
    expect(rpc.mock.calls.filter(([method]) => method === 'changes.read')).toHaveLength(1);
    account = ACCOUNT;
    await store.refreshStatus();
    await flush();
    await nextCheck();
    expect(notices()).toEqual([]);
    authority.items = [followUp(1), followUp(2)];
    await nextCheck();
    expect(texts()).toEqual(['Mina handed you Action 2']);
  });

  it('drops a check answered for an account no longer signed in; the next account learns its own', async () => {
    const store = await signedIn();
    holdChanges = true;
    authority.items = [followUp(1)];
    await nextCheck();
    expect(answers).toHaveLength(1);
    holdChanges = false;
    account = OTHER;
    await store.refreshStatus();
    await flush();
    answers[0]!();
    await flush();
    expect(notices()).toEqual([]);
    expect(rpc.mock.calls.filter(([method]) => method === 'changes.read').at(-1)?.[1]).toMatchObject({ expect: { membership_id: 'other' } });
  });
});

describe('an older Authority (R8)', () => {
  it('scans what you sent or own every five minutes, learning first, then telling what someone else did', async () => {
    authority.changes = 'not_supported';
    await signedIn([sent(1, MINA)]);
    expect(followed().map(([, params]) => params.request.scope)).toEqual(['mine']);
    authority.items = [stated(sent(1, MINA), 'done', MINA, 30)];
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(followed()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(texts()).toEqual(['Mina marked Action 1 done']);
    // The change check is not asked again until the next start.
    expect(rpc.mock.calls.filter(([method]) => method === 'changes.read')).toHaveLength(1);
  });

  it('reads what you sent or own when the Authority refuses `involved`', async () => {
    authority.noInvolved = true;
    await signedIn([followUp(1)]);
    authority.items = [followUp(1), followUp(2)];
    await nextCheck();
    expect(followed().map(([, params]) => params.request.scope)).toEqual(['involved', 'mine', 'mine']);
    expect(texts()).toEqual(['Mina handed you Action 2']);
  });
});

describe('a notification clicked (N6)', () => {
  /** Signed in with nothing involving you; then `items` arrive and the next check tells of them. */
  async function told(...items: OpenItemView[]) {
    const store = await signedIn();
    authority.items = items;
    await nextCheck();
    return store;
  }

  it('opens the item page over the page on screen, with another app in front, and only once', async () => {
    const store = await told(followUp(1));
    store.conceal();
    store.openNotified({ kind: 'item', item_id: id(1) });
    await flush();
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id: id(1), item: { item_id: id(1) } });
    expect(store.getState().route).toEqual({ page: 'home' });
    store.openNotified({ kind: 'item', item_id: id(1) });
    await flush();
    expect(store.followUpsShown()?.views).toHaveLength(1);
  });

  it('shows the row the check read at once, while the page reads it again', async () => {
    const store = await told(followUp(1, { kind: 'ticket', expected: 'launch next week' }));
    let answer: (() => void) | undefined;
    const runs = rpc.getMockImplementation()!;
    rpc.mockImplementation((method: string, params: { request?: { operation?: string } }) => (method === 'runs' && params.request?.operation === 'item'
      ? new Promise(resolve => { answer = () => resolve(ok({ ...authority.items[0]!, reach: 'no_access' })); }) : runs(method, params)));
    store.openNotified({ kind: 'item', item_id: id(1) });
    await flush();
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id: id(1), loading: true, item: { item_id: id(1), expected: 'launch next week' } });
    answer!();
    await flush();
    expect((store.followUpShown() as ItemPage).item?.item_id).toBe(id(1));
  });

  it('opens exactly the follow-ups a summary counted, as you may see them now, and the project for a project add', async () => {
    authority.active = [project(1, 20)];
    const store = await told(followUp(1), followUp(2));
    expect(texts()).toEqual(['2 follow-ups changed']);
    // Another follow-up came meanwhile, and one counted is no longer yours to see: the list holds the counted ones you see.
    authority.items = [followUp(1), followUp(3)];
    store.openNotified({ kind: 'items', item_ids: [id(1), id(2)] });
    await flush();
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.followUpShown()).toMatchObject({ kind: 'list', scope: 'told', title: 'Changed follow-ups', loading: false });
    expect((store.followUpShown() as FollowUpList).items.map(item => item.item_id)).toEqual([id(1)]);
    // Read by their ids, rows only: never a scope's list.
    expect(rpc.mock.calls.filter(([method, params]) => method === 'runs' && params.request.operation === 'item').map(([, params]) => params.request.item_id))
      .toEqual([id(1), id(2)]);
    store.closeFollowUp();
    // The check that tells of those changes, then a project add on its own.
    await nextCheck();
    const comet = project(2, 25, { name: 'Comet', role: 'member' });
    authority.active = [comet, project(1, 20)];
    await nextCheck();
    store.openNotified({ kind: 'project', project_id: comet.project_id });
    await flush();
    expect(store.getState().route).toMatchObject({ page: 'project', project: { name: 'Comet' } });
  });

  it('opens nothing this account was never told of: learned at sign-in, counted among several, or told another account', async () => {
    authority.items = [followUp(1)];
    const store = await startStore();
    store.openNotified({ kind: 'item', item_id: id(1) });
    store.openNotified({ kind: 'items', item_ids: [id(1), id(2)] });
    await flush();
    expect(store.followUpShown()).toBeNull();
    authority.items = [followUp(1), followUp(2), followUp(3)];
    await nextCheck();
    // Told as two, together: neither opens alone, nor with another.
    store.openNotified({ kind: 'item', item_id: id(2) });
    store.openNotified({ kind: 'items', item_ids: [id(1), id(2), id(3)] });
    await flush();
    expect(store.followUpShown()).toBeNull();
    // Switched: what the last account was told opens nothing.
    account = OTHER;
    await store.refreshStatus();
    await flush();
    store.openNotified({ kind: 'items', item_ids: [id(2), id(3)] });
    await flush();
    expect(store.followUpShown()).toBeNull();
  });

  it('leaves Capture up', async () => {
    const store = await told(followUp(1));
    store.openCapture();
    store.openNotified({ kind: 'item', item_id: id(1) });
    expect(store.followUpShown()).toBeNull();
    expect(store.getState().compose?.hidden).toBe(false);
  });
});
