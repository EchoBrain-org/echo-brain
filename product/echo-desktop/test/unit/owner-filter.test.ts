// A follow-ups list's owner line as the store keeps it (One place to look v1, F3 and F4): the filter lives in the list, so it
// survives an item page and Back, is reset when the list opens afresh, and Send and Dismiss act only on the rows it shows.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpList } from '../../src/renderer/store.js';
import type { OpenItemView } from '../../src/shared/protocol.js';
import { followUp, ME, MINA, RAFAEL } from './changes-fixture.js';
import { EMPTY_SUMMARY, fail, flush, Held, ok, rpcFor, startStore, storeLifecycle } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

/** One of your meeting's follow-ups, not sent yet, for `owner`; `match: 'approver'` when ECHO found no one (Pick owner). */
const unsent = (n: number, owner: typeof MINA, match: 'name' | 'approver' = 'name'): OpenItemView => followUp(n, {
  approver: ME, owner: { ...owner, match }, state: 'unsent', sent_at: null, state_set_at: null, state_set_by: null, send_included: null, waits_on: 'approver',
});
const RECORD = followUp(1).decision!.record_sha256;
let rows: OpenItemView[];
let sends: { items: { item_id: string; include: boolean }[] }[];

storeLifecycle();
beforeEach(() => {
  // Two for Mina, one for Rafael, and one ECHO found no owner for.
  rows = [unsent(1, MINA), unsent(2, MINA), unsent(3, RAFAEL), unsent(4, ME, 'approver')];
  sends = [];
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), {
    runs: params => {
      const request = params.request as { operation: string; states?: string[]; item_id?: string; items?: { item_id: string; include: boolean }[] };
      if (request.operation === 'items') {
        const items = rows.filter(item => !request.states || request.states.includes(item.state));
        const count = (state: OpenItemView['state']) => rows.filter(item => item.state === state).length;
        return ok({ items, next_cursor: null, stages: [], summary: { ...EMPTY_SUMMARY, unsent: count('unsent'), open: count('open'), done: count('done'), decisions: 1 } });
      }
      if (request.operation === 'item') {
        const found = rows.find(item => item.item_id === request.item_id);
        return found ? ok(found) : fail('not_found');
      }
      if (request.operation === 'send') {
        sends.push({ items: request.items! });
        rows = rows.map(item => {
          const sent = request.items!.find(entry => entry.item_id === item.item_id);
          return sent ? { ...item, state: sent.include ? 'open' : 'not_relevant', sent_at: '2026-10-14T11:00:00.000Z', state_set_at: '2026-10-14T11:00:00.000Z' } : item;
        });
        return ok({ sent: request.items!.filter(entry => entry.include).length, not_relevant: 0 });
      }
      return fail('unavailable', { retryable: true });
    },
  }, () => ({ active: [], archived: [] })));
});

type Store = Awaited<ReturnType<typeof startStore>>;
const list = (store: Store) => store.followUpShown() as FollowUpList;
const ticked = (store: Store) => Object.keys(list(store).ticks).filter(id => list(store).ticks[id]).sort();
const id = (n: number) => followUp(n).item_id;

/** Signed in, on the meeting's follow-ups, every row ticked by its first read. */
async function meeting(): Promise<Store> {
  const store = await startStore();
  await store.openFollowUps('record', RECORD, 'Pilot planning');
  await flush();
  expect(ticked(store)).toEqual([id(1), id(2), id(3), id(4)]);
  return store;
}

describe('a follow-ups list\'s owner filter', () => {
  it('unticks the rows it hides, so Send sends only the ticked rows you see', async () => {
    const store = await meeting();
    store.filterOwner(MINA.membership_id);
    expect(list(store).owner).toBe(MINA.membership_id);
    expect(ticked(store)).toEqual([id(1), id(2)]);
    await store.sendTicked(true);
    expect(sends.map(send => send.items)).toEqual([[{ item_id: id(1), include: true }, { item_id: id(2), include: true }]]);
    // Its rows went to Mina: still hers, so the filter holds.
    expect(list(store).owner).toBe(MINA.membership_id);
    expect(list(store).said).toEqual({ words: 'Sent 2 to Mina' });
  });

  it('never sends a ticked row it hides, however it came to be ticked', async () => {
    const store = await meeting();
    store.filterOwner('none');
    expect(ticked(store)).toEqual([id(4)]);
    // Ticked behind the filter's back: it does not show, so it does not go.
    store.tickFollowUp(id(3));
    await store.sendTicked(false);
    expect(sends.map(send => send.items)).toEqual([[{ item_id: id(4), include: false }]]);
  });

  it('shows everyone again when picked again or on All, ticking nothing back', async () => {
    const store = await meeting();
    store.filterOwner(RAFAEL.membership_id);
    store.filterOwner(RAFAEL.membership_id);
    expect(list(store).owner).toBeUndefined();
    expect(ticked(store)).toEqual([id(3)]);
    store.filterOwner(MINA.membership_id);
    store.filterOwner(null);
    expect(list(store).owner).toBeUndefined();
    expect(ticked(store)).toEqual([]);
  });

  it('survives a row\'s page and Back, and is reset when the list opens afresh', async () => {
    const store = await meeting();
    store.filterOwner(MINA.membership_id);
    await store.openFollowUp(id(2), rows[1]!);
    await flush();
    expect(store.followUpShown()?.kind).toBe('item');
    store.closeFollowUp();
    await flush();
    expect(list(store)).toMatchObject({ kind: 'list', owner: MINA.membership_id, opened: id(2) });
    // Opened again from where it was opened over (its meeting's line, Home's Send row): Back to it, as it was.
    await store.openFollowUps('record', RECORD, 'Pilot planning');
    expect(list(store).owner).toBe(MINA.membership_id);
    // Closed, then opened afresh: everyone's.
    store.closeFollowUp();
    await store.openFollowUps('record', RECORD, 'Pilot planning');
    await flush();
    expect(list(store).owner).toBeUndefined();
    store.filterOwner(MINA.membership_id);
    await store.openYourFollowUps();
    await flush();
    expect(list(store)).toMatchObject({ scope: 'involved' });
    expect(list(store).owner).toBeUndefined();
  });

  it('does nothing while a change is on its way', async () => {
    const store = await meeting();
    const sending = store.sendTicked(true);
    store.filterOwner(MINA.membership_id);
    expect(list(store).owner).toBeUndefined();
    await sending;
  });
});
