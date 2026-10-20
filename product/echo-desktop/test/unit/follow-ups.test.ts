// The follow-ups screens as they show (follow-ups thread v1): called as functions, their hooks holding nothing.
import { describe, expect, it, vi } from 'vitest';
import type { FollowUpList, ItemPage } from '../../src/renderer/store.js';
import type { OpenItemsView } from '../../src/shared/protocol.js';
import { followUp } from './changes-fixture.js';
import { elements, plainHooks } from './harness.js';

vi.mock('../../src/renderer/api.js', () => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const counted: OpenItemsView['summary'] = { unsent: 0, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 0, last_checked_at: null, by_decision: [] };

/** Your list, its current work read to its end with no row, counted as `counts` say, its closed groups closed. */
async function notices(counts: Partial<OpenItemsView['summary']>): Promise<unknown[]> {
  const { getState } = await import('../../src/renderer/store.js');
  const { FollowUps } = await import('../../src/renderer/screens/follow-ups.js');
  const list: FollowUpList = {
    kind: 'list', seq: 1, scope: 'involved', title: null, loading: false, items: [], live: {}, reading: false, reads: [{ parts: ['active'], pages: [{ cursor: null, ids: [] }], next: null }],
    summary: { ...counted, ...counts }, stage: null, ticks: {}, sends: {}, check: null, expanded: {}, busy: false, said: null, picker: null, stale: false,
  };
  return elements(FollowUps({ state: getState(), list })).filter(node => node.props.class === 'notice').map(node => node.props.children);
}

describe('a follow-ups list', () => {
  it('says it has none only when it counts none, never under a closed group that holds some', async () => {
    expect(await notices({})).toEqual(['No follow-ups']);
    expect(await notices({ done: 3 })).toEqual([]);
    expect(await notices({ not_relevant: 1 })).toEqual([]);
  });
});

describe('a follow-up\'s page', () => {
  it('offers a retry after opening a known row whose detail read failed', async () => {
    const { getState } = await import('../../src/renderer/store.js');
    const { FollowUp } = await import('../../src/renderer/screens/follow-ups.js');
    const item = followUp(1, { kind: 'ticket' });
    // readItem keeps the row and records an unavailable live part on a transient read failure.
    const page: ItemPage = {
      kind: 'item', seq: 1, item_id: item.item_id, item, live: { [item.item_id]: { reach: 'unavailable' } },
      loading: false, send: null, busy: false, said: null, picker: null, stale: false,
    };
    expect(elements(FollowUp({ state: getState(), page })).some(node => node.type === 'button' && node.props.children === 'Try again')).toBe(true);
  });
});
