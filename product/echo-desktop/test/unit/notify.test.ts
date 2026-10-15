// Notify the owner (follow-ups thread v1, F8): a quiet check of Home's rows
// every five minutes while signed in, and one notification for what newly
// waits on you.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemPage } from '../../src/renderer/store.js';
import type { Account, HomeView, OpenItemView } from '../../src/shared/protocol.js';
import { ACCOUNT, fail, flush, Held, ok, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const FIVE_MINUTES = 5 * 60_000;
const OTHER: Account = { ...ACCOUNT, membership_id: 'other', display_name: 'Other' };
const ME = { membership_id: ACCOUNT.membership_id, name: ACCOUNT.display_name, active: true };
const MINA = { membership_id: 'mem_00000000-0000-4000-8000-000000000011', name: 'Mina Patel', active: true };
const RAFAEL = { membership_id: 'mem_00000000-0000-4000-8000-000000000012', name: 'Rafael Moreno', active: true };
const decision = {
  approval_id: 'apr_' + 'a'.repeat(64), record_sha256: 'sha256:' + '1'.repeat(64), title: 'Pilot planning', first_line: null,
  approved_at: '2026-10-14T09:00:00.000Z', project_ids: [],
};
const id = (n: number) => `itm_00000000-0000-4000-8000-00000000000${n}`;

/** A meeting's action Mina approved and sent to you ("member"), n minutes past ten: the higher n, the later sent. */
function followUp(n: number, extra: Partial<OpenItemView> = {}): OpenItemView {
  const sent = `2026-10-14T10:${String(n).padStart(2, '0')}:00.000Z`;
  return {
    item_id: id(n), run_id: 'run_00000000-0000-4000-8000-000000000001', kind: 'action', decision, relation: 'needs_updating', expected: `Action ${n}`,
    approver: MINA, owner: { ...ME, match: 'name' }, waits_on: 'owner', state: 'open', created_at: '2026-10-14T09:05:00.000Z',
    sent_at: sent, state_set_at: sent, state_set_by: MINA, owner_set_at: null, owner_set_by: null,
    send_included: true, check: null, can: { set_state: true, assign: true }, reach: 'not_read', ...extra,
  };
}

let account: Account | null;
/** What Home's rows hold now. */
let items: OpenItemView[];
let quietFails: boolean;
/** While set, the quiet check's next read waits until the test releases it, answering what Home held when it was asked. */
let holdQuiet: boolean;
let released: (() => void)[];

const homeOf = (rows: readonly OpenItemView[]): HomeView => ({ send: [], items: rows, landed: 0, waiting: 0, last_checked_at: null, sweep_due: false });
/** Reads of Home's rows: the quiet check's, and Home's own, each of which also tells the quiet check what is there. */
const quietReads = () => rpc.mock.calls.filter(([method, params]) => method === 'runs' && params.request.operation === 'home' && params.request.read === 'rows')
  .map(([, params]) => params);
const notices = () => rpc.mock.calls.filter(([method]) => method === 'notify.followUps').map(([, params]) => params);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  stubWindow();
  account = ACCOUNT;
  items = [];
  quietFails = false;
  holdQuiet = false;
  released = [];
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), {
    'app.status': () => ok(account ? { signed_in: true, account } : { signed_in: false, account: null }),
    'notify.followUps': () => ok(null),
    'runs': params => {
      const request = params.request as { operation: string; read?: 'rows'; item_id?: string };
      if (request.operation === 'home' && request.read === 'rows') {
        if (quietFails) return fail('unavailable', { retryable: true });
        if (!holdQuiet) return ok(homeOf(items));
        const answer = ok(homeOf(items));
        return new Promise(resolve => { released.push(() => resolve(answer)); });
      }
      if (request.operation === 'home') return ok(homeOf(items));
      if (request.operation === 'list') return ok({ runs: [] });
      if (request.operation === 'item') return ok(items.find(item => item.item_id === request.item_id) ?? followUp(9));
      if (request.operation === 'items') {
        return ok({ items: [], next_cursor: null, stages: [],
          summary: { unsent: 0, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 0, last_checked_at: null, by_decision: [] } });
      }
      throw new Error(`Unexpected runs operation: ${request.operation}`);
    },
  }, () => ({ active: [], archived: [] })));
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The next quiet check, five minutes on. */
async function nextCheck(): Promise<void> {
  await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
  await flush();
}

describe('the quiet check', () => {
  it('learns what waits on you at sign-in from Home\'s own read, then tells each new follow-up once', async () => {
    items = [followUp(1)];
    await startStore();
    // One read of Home's rows at sign-in: Home's, which the quiet check learns from.
    expect(quietReads()).toEqual([{ expect: { authority: ACCOUNT.authority, membership_id: ACCOUNT.membership_id }, request: { schema_version: 1, operation: 'home', read: 'rows' } }]);
    expect(notices()).toEqual([]);
    items = [followUp(1), followUp(2, { expected: 'Update the pricing page' })];
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1);
    expect(quietReads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(quietReads()).toHaveLength(2);
    expect(notices()).toEqual([{ item_ids: [id(2)], from: 'Mina', title: 'Update the pricing page' }]);
    // Seen once, told once.
    await nextCheck();
    expect(quietReads()).toHaveLength(3);
    expect(notices()).toHaveLength(1);
  });

  it('tells a new follow-up that comes first among twenty, and never again one that left the twenty and came back', async () => {
    // Home answers twenty, the newest waiting first: the quiet check sees each new one however many older ones wait.
    const twenty = Array.from({ length: 20 }, (_, at) => followUp(at + 1));
    items = twenty;
    await startStore();
    items = [followUp(21, { expected: 'Book the lab' }), ...twenty.slice(0, 19)];
    await nextCheck();
    expect(notices()).toEqual([{ item_ids: [id(21)], from: 'Mina', title: 'Book the lab' }]);
    // The new one closed: the twentieth is back among them, seen before, and not told.
    items = twenty;
    await nextCheck();
    expect(notices()).toHaveLength(1);
  });

  it('counts several new follow-ups in one notification', async () => {
    await startStore();
    items = [followUp(1), followUp(2), followUp(3)];
    await nextCheck();
    expect(notices()).toEqual([{ item_ids: [id(1), id(2), id(3)] }]);
  });

  it('names a document follow-up as its row does: what it is and its meeting, or what it is when you cannot read the meeting', async () => {
    await startStore();
    items = [followUp(1, { kind: 'ticket', expected: 'launch next week' })];
    await nextCheck();
    items = [...items, followUp(2, { kind: 'ticket', decision: undefined })];
    await nextCheck();
    expect(notices()).toEqual([{ item_ids: [id(1)], from: 'Mina', title: 'Jira ticket · Pilot planning' }, { item_ids: [id(2)], from: 'Mina', title: 'Jira ticket' }]);
  });

  it('tells of one given to you since, by who gave it, but not one you made yours yourself, nor one not open or not yours', async () => {
    // Rafael's, which you see because you approved it; and one of yours, done.
    items = [followUp(1, { approver: ME, state_set_by: ME, owner: { ...RAFAEL, match: 'name' } }), followUp(2, { state: 'done' })];
    await startStore();
    items = [
      // Rafael gives it to you.
      followUp(1, { approver: ME, state_set_by: ME, owner_set_at: '2026-10-14T11:00:00.000Z', owner_set_by: RAFAEL }),
      followUp(2, { state: 'done' }),
      // Keep it myself, on your own meeting's action.
      followUp(3, { approver: ME, state_set_by: ME, owner: { ...ME, match: 'approver' } }),
      // Still Mina's to do.
      followUp(4, { owner: { ...MINA, match: 'name' } }),
    ];
    await nextCheck();
    expect(notices()).toEqual([{ item_ids: [id(1)], from: 'Rafael', title: 'Action 1' }]);
    // Reopened to you by Mina: it waits on you again, and was never seen waiting.
    items = [...items.slice(0, 1), followUp(2, { state_set_at: '2026-10-14T12:00:00.000Z' }), ...items.slice(2)];
    await nextCheck();
    expect(notices()).toHaveLength(2);
    expect(notices()[1]).toEqual({ item_ids: [id(2)], from: 'Mina', title: 'Action 2' });
  });

  it('tells again of one reopened to you, or handed back to you', async () => {
    await startStore();
    items = [followUp(1)];
    await nextCheck();
    // Done, then reopened by Mina: it waits on you again.
    items = [followUp(1, { state_set_at: '2026-10-14T12:00:00.000Z' })];
    await nextCheck();
    // Handed to Rafael, and back to you by him.
    items = [followUp(1, { state_set_at: '2026-10-14T12:00:00.000Z', owner_set_at: '2026-10-14T13:00:00.000Z', owner_set_by: RAFAEL })];
    await nextCheck();
    expect(notices().map(notice => notice.from)).toEqual(['Mina', 'Mina', 'Rafael']);
  });

  it('does not tell of an item whose page is open now, and counts it seen', async () => {
    const store = await startStore();
    items = [followUp(2)];
    await store.openFollowUp(id(2));
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id: id(2) });
    await nextCheck();
    expect(notices()).toEqual([]);
    store.closeFollowUp();
    await nextCheck();
    expect(notices()).toEqual([]);
  });

  it('only learns, again, on the first check that succeeds', async () => {
    quietFails = true;
    items = [followUp(1)];
    await startStore();
    quietFails = false;
    await nextCheck();
    expect(quietReads()).toHaveLength(2);
    expect(notices()).toEqual([]);
    items = [followUp(1), followUp(2)];
    await nextCheck();
    expect(notices()).toEqual([{ item_ids: [id(2)], from: 'Mina', title: 'Action 2' }]);
  });

  it('goes on whatever the page and with another app in front, starting nothing and leaving Home as it shows', async () => {
    const store = await startStore();
    store.conceal();
    const home = store.getState().home;
    const before = rpc.mock.calls.length;
    items = [followUp(1)];
    await nextCheck();
    expect(rpc.mock.calls.slice(before).map(([method, params]) => [method, params.request?.operation])).toEqual([['runs', 'home'], ['notify.followUps', undefined]]);
    expect(store.getState().home).toBe(home);
    store.resume();
    await flush();
    await store.openYourFollowUps();
    items = [...items, followUp(2)];
    await nextCheck();
    expect(store.getState().route).toEqual({ page: 'follow-ups' });
    expect(notices()).toHaveLength(2);
  });

  it('stops on sign-out, and learns again at sign-in', async () => {
    const store = await startStore();
    account = null;
    await store.refreshStatus();
    await flush();
    items = [followUp(1)];
    await nextCheck();
    await nextCheck();
    expect(quietReads()).toHaveLength(1);
    account = ACCOUNT;
    await store.refreshStatus();
    await flush();
    expect(quietReads()).toHaveLength(2);
    expect(notices()).toEqual([]);
    items = [followUp(1), followUp(2)];
    await nextCheck();
    expect(notices()).toEqual([{ item_ids: [id(2)], from: 'Mina', title: 'Action 2' }]);
  });

  it('drops a reply for an account no longer signed in, and the next account learns its own', async () => {
    const store = await startStore();
    holdQuiet = true;
    items = [followUp(1)];
    await nextCheck();
    expect(released).toHaveLength(1);
    // Switched to another account while that read was on its way.
    holdQuiet = false;
    account = OTHER;
    await store.refreshStatus();
    await flush();
    expect(quietReads().at(-1)).toMatchObject({ expect: { membership_id: 'other' } });
    released[0]!();
    await flush();
    expect(notices()).toEqual([]);
    // The other account never saw the first account's item: its notification opens nothing.
    store.openNotified(id(1));
    expect(store.followUpShown()).toBeNull();
    // Five minutes from the switch, not from the dropped read: one check per turn.
    await nextCheck();
    expect(quietReads()).toHaveLength(4);
  });
});

describe('a notification clicked', () => {
  /** Signed in with nothing waiting; then `waiting` is sent to you, and the next check tells of it. */
  async function told(waiting: OpenItemView) {
    const store = await startStore();
    items = [waiting];
    await nextCheck();
    return store;
  }

  it('opens the item page over the page on screen, with another app in front', async () => {
    const store = await told(followUp(1));
    store.conceal();
    store.openNotified(id(1));
    await flush();
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id: id(1), item: { item_id: id(1) } });
    expect(store.getState().route).toEqual({ page: 'home' });
    // Clicked again: the page shows, read again, never twice.
    store.openNotified(id(1));
    await flush();
    expect(store.followUpsShown()?.views).toHaveLength(1);
  });

  it('shows the row its check read at once, while the page reads it live', async () => {
    const store = await told(followUp(1, { kind: 'ticket', expected: 'launch next week' }));
    // The live read of the item waits: the row the quiet check read shows meanwhile.
    let answer: (() => void) | undefined;
    const runs = rpc.getMockImplementation()!;
    rpc.mockImplementation((method: string, params: { request?: { operation?: string; read?: string } }) => (method === 'runs' && params.request?.operation === 'item'
      && params.request.read === undefined ? new Promise(resolve => { answer = () => resolve(ok({ ...items[0]!, reach: 'no_access' })); }) : runs(method, params)));
    store.openNotified(id(1));
    await flush();
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id: id(1), loading: true, item: { item_id: id(1), reach: 'not_read', expected: 'launch next week' } });
    answer!();
    await flush();
    const page = store.followUpShown() as ItemPage;
    expect(page.loading).toBe(false);
    expect(store.shownItem(page.item!, page.live).reach).toBe('no_access');
  });

  it('opens the Follow-ups page for several', async () => {
    const store = await startStore();
    store.openNotified(undefined);
    await flush();
    expect(store.getState().route).toEqual({ page: 'follow-ups' });
    expect(store.followUpShown()).toMatchObject({ kind: 'list', scope: 'mine' });
  });

  it('opens nothing for a follow-up seen waiting but never told', async () => {
    // Learned at sign-in, so never told: a notification for it (one from before, or for another turn) opens nothing.
    items = [followUp(1)];
    const store = await startStore();
    store.openNotified(id(1));
    await flush();
    expect(store.followUpShown()).toBeNull();
    // Told among several, one notification for them all: it opens the Follow-ups page, never one of them by its id.
    items = [followUp(1), followUp(2), followUp(3)];
    await nextCheck();
    expect(notices()).toEqual([{ item_ids: [id(2), id(3)] }]);
    store.openNotified(id(2));
    await flush();
    expect(store.followUpShown()).toBeNull();
  });

  it('opens nothing this account never saw wait on it, and leaves Capture up', async () => {
    items = [followUp(1)];
    const store = await startStore();
    store.openNotified(id(5));
    expect(store.followUpShown()).toBeNull();
    store.openCapture();
    store.openNotified(id(1));
    store.openNotified(undefined);
    expect(store.followUpShown()).toBeNull();
    expect(store.getState().route).toEqual({ page: 'home' });
  });
});

describe('what a notification says', () => {
  it('cuts a long line to what main takes, and keeps it one line', async () => {
    const { followUpsNotice } = await import('../../src/renderer/store.js');
    const long = followUp(1, { expected: `Line one\nline two ${'x'.repeat(300)}` });
    const notice = followUpsNotice([long])!;
    expect([...notice.title!]).toHaveLength(200);
    expect(notice.title).toMatch(/^Line one line two x+…$/);
    expect(followUpsNotice([])).toBeNull();
    expect(followUpsNotice([followUp(1), followUp(1)])).toEqual({ item_ids: [id(1)], from: 'Mina', title: 'Action 1' });
  });
});
