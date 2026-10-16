// Notifications (desktop refresh and notifications v1, section 3): a change
// someone else made to a follow-up you are involved in (you sent it, own it, or
// last handed it on), and being added to a project, come as one system
// notification per change check. Your own changes, checks, meetings, reviews,
// removals and role changes only update the screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemPage } from '../../src/renderer/store.js';
import type { Account, OpenItemView } from '../../src/shared/protocol.js';
import { ME, MINA, RAFAEL, authority, followUp, id, nextCheck, owned, sent, stated, changesHandlers } from './changes-fixture.js';
import { ACCOUNT, flush, Held, ok, project, rpcFor, startStore, stubWindow } from './harness.js';

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

  it('learns again when it could not read your follow-ups, and tells only what changes after that', async () => {
    authority.items = [followUp(1)];
    const fixture = changesHandlers();
    let refuse = true;
    rpc.mockImplementation(rpcFor(new Held(), {
      ...fixture, 'runs': params => (refuse ? { ok: false, failure: { code: 'unavailable', retryable: true } } : fixture.runs!(params)),
    }, () => ({ active: [], archived: [] })));
    await startStore();
    refuse = false;
    authority.items = [followUp(1), followUp(2)];
    await nextCheck();
    expect(notices()).toEqual([]);
    authority.items = [followUp(1), followUp(2), followUp(3)];
    await nextCheck();
    expect(texts()).toEqual(['Mina handed you Action 3']);
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
  it('several in one check come as one, counted, opening Follow-ups; with a project added too, both are counted', async () => {
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
      { text: '3 follow-ups changed', target: { kind: 'follow-ups' } },
      { text: '1 follow-up changed · added to 1 project', target: { kind: 'follow-ups' } },
      { text: 'Added to 2 projects', target: { kind: 'project', project_id: project(3, 26).project_id } },
    ]);
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
    expect(notices()).toEqual([{ text: '2 follow-ups changed', target: { kind: 'follow-ups' } }]);
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

  it('opens Follow-ups for several, and the project for a project add', async () => {
    authority.active = [project(1, 20)];
    const store = await told(followUp(1), followUp(2));
    store.openNotified({ kind: 'follow-ups' });
    await flush();
    expect(store.getState().route).toEqual({ page: 'follow-ups' });
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
    store.openNotified({ kind: 'follow-ups' });
    await flush();
    expect(store.followUpShown()).toBeNull();
    authority.items = [followUp(1), followUp(2), followUp(3)];
    await nextCheck();
    store.openNotified({ kind: 'item', item_id: id(2) });
    await flush();
    expect(store.followUpShown()).toBeNull();
    // Switched: what the last account was told opens nothing.
    account = OTHER;
    await store.refreshStatus();
    await flush();
    store.openNotified({ kind: 'follow-ups' });
    await flush();
    expect(store.getState().route).toEqual({ page: 'home' });
  });

  it('leaves Capture up', async () => {
    const store = await told(followUp(1));
    store.openCapture();
    store.openNotified({ kind: 'item', item_id: id(1) });
    expect(store.followUpShown()).toBeNull();
    expect(store.getState().compose?.hidden).toBe(false);
  });
});
