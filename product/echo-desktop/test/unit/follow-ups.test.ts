// The follow-ups screens as they show (follow-ups thread v1): called as functions, their hooks holding nothing.
import { describe, expect, it, vi } from 'vitest';
import type { FollowUpList, ItemPage } from '../../src/renderer/store.js';
import type { OpenItemsView } from '../../src/shared/protocol.js';
import { followUp } from './changes-fixture.js';
import { byTestId, elements, plainHooks, render, text, type Node } from './harness.js';

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

/** Pilot planning's list, read to its end: three not sent and ticked, one open, and (counted only) one dismissed. */
async function meeting(): Promise<Node> {
  const { getState } = await import('../../src/renderer/store.js');
  const { FollowUps } = await import('../../src/renderer/screens/follow-ups.js');
  const unsent = [1, 2, 3].map(n => followUp(n, { state: 'unsent', sent_at: null, state_set_at: null, state_set_by: null, send_included: null }));
  const items = [...unsent, followUp(4)];
  const list: FollowUpList = {
    kind: 'list', seq: 1, scope: 'record', id: items[0]!.decision!.record_sha256, title: 'Pilot planning', loading: false, items, live: {}, reading: false,
    reads: [{ parts: ['active'], pages: [{ cursor: null, ids: items.map(item => item.item_id) }], next: null }],
    summary: { ...counted, unsent: 3, open: 1, not_relevant: 1, decisions: 1 }, stage: null,
    ticks: Object.fromEntries(unsent.map(item => [item.item_id, true])), sends: {}, check: null, expanded: {}, busy: false, said: null, picker: null, stale: false,
  };
  return render(FollowUps({ state: getState(), list })) as Node;
}

describe('a meeting\'s list', () => {
  it('says under its title how far its follow-ups have come, dismissed ones left out, with a bar of the same', async () => {
    const tree = await meeting();
    const head = elements(tree).find(node => node.type === 'header')!;
    expect(text(head)).toContain('Approved Oct 14 · 1 of 4 sent · 0 done');
    // Nothing done yet: only the open share is filled, over the not sent track.
    const bar = byTestId(tree, 'follow-ups-progress')[0]!;
    expect(elements(bar.props.children).map(node => [node.props.class, (node.props.style as { width: string }).width])).toEqual([['open', '25%']]);
  });

  it('puts Send and Dismiss right under the Not sent rows they act on, above the open and closed ones', async () => {
    const parts = [(await meeting()).props.children].flat(Infinity as 1).filter((node): node is Node => Boolean(node) && typeof node === 'object' && 'props' in (node as object));
    expect(parts.map(node => String(node.props['aria-label'] ?? node.props.class ?? node.type))).toEqual(['follow-ups-head', 'Not sent', 'follow-ups-foot', 'Open', 'Dismissed']);
    expect(text(byTestId(parts, 'follow-ups-foot')[0]).startsWith('Send 3Dismiss 3')).toBe(true);
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
