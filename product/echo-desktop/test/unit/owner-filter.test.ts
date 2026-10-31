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
      const request = params.request as {
        operation: string; states?: string[]; item_id?: string; items?: { item_id: string; include: boolean }[]; state?: OpenItemView['state']; owner_membership_id?: string;
      };
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
      if (request.operation === 'assign') {
        const to = [MINA, RAFAEL, ME].find(person => person.membership_id === request.owner_membership_id)!;
        rows = rows.map(item => (item.item_id === request.item_id ? { ...item, owner: { ...to, match: 'picked' }, owner_set_at: '2026-10-14T11:00:00.000Z', owner_set_by: ME } : item));
        return ok({});
      }
      if (request.operation === 'set_state') {
        rows = rows.map(item => (item.item_id === request.item_id ? { ...item, state: request.state!, state_set_at: '2026-10-14T11:00:00.000Z', state_set_by: ME } : item));
        return ok({});
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

  it('falls back to everyone\'s for good once none of the rows read is that owner\'s: a later read bringing one back filters nothing', async () => {
    // Yours, its Done folded: Mina, Rafael and you each hold one open.
    const open = (n: number, owner: typeof MINA) => followUp(n, { approver: ME, owner: { ...owner, match: 'name' } });
    rows = [open(1, MINA), open(2, RAFAEL), open(3, ME)];
    const store = await startStore();
    await store.openYourFollowUps();
    await flush();
    store.filterOwner(MINA.membership_id);
    // Her one row marked done on its page, then Back: the list is read again as far as it shows (its current work), so none of hers.
    await store.openFollowUp(id(1), rows[0]!);
    await flush();
    await store.setFollowUpState('done');
    store.closeFollowUp();
    await flush();
    expect(list(store).items.map(item => item.item_id)).toEqual([id(2), id(3)]);
    expect(list(store).owner).toBeUndefined();
    // Done opened: her done row is read back in, and everyone's still show, as All said they would.
    store.toggleClosedGroup('done');
    await flush();
    expect(list(store).items.map(item => item.item_id)).toEqual([id(2), id(3), id(1)]);
    expect(list(store).owner).toBeUndefined();
  });

  it('falls back to everyone\'s too when its owner\'s last row is given to someone else from the list', async () => {
    const store = await meeting();
    store.filterOwner(RAFAEL.membership_id);
    store.toggleOwnerPicker(id(3));
    await flush();
    await store.pickFollowUpOwner({ membership_id: MINA.membership_id, display_name: MINA.name });
    expect(list(store).items.find(item => item.item_id === id(3))?.owner.membership_id).toBe(MINA.membership_id);
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
