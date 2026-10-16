// A follow-ups list as it shows (follow-ups thread v1): called as a function, its hooks holding nothing.
import type { VNode } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import type { FollowUpList } from '../../src/renderer/store.js';
import type { OpenItemsView } from '../../src/shared/protocol.js';

vi.mock('../../src/renderer/api.js', () => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('preact/hooks', async original => ({
  ...await original<typeof import('preact/hooks')>(),
  useRef: (value: unknown = null) => ({ current: value }), useEffect: () => undefined, useLayoutEffect: () => undefined, useMemo: (make: () => unknown) => make(),
}));

function descendants(value: unknown): VNode<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as VNode<Record<string, unknown>>;
  return [node, ...descendants(node.props.children)];
}

const counted: OpenItemsView['summary'] = { unsent: 0, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 0, last_checked_at: null, by_decision: [] };

/** Your list, its current work read to its end with no row, counted as `counts` say, its closed groups closed. */
async function notices(counts: Partial<OpenItemsView['summary']>): Promise<unknown[]> {
  const { getState } = await import('../../src/renderer/store.js');
  const { FollowUps } = await import('../../src/renderer/screens/follow-ups.js');
  const list: FollowUpList = {
    kind: 'list', seq: 1, scope: 'involved', title: null, loading: false, items: [], live: {}, reading: false, reads: [{ parts: ['active'], pages: [{ cursor: null, ids: [] }], next: null }],
    summary: { ...counted, ...counts }, stage: null, ticks: {}, sends: {}, check: null, expanded: {}, busy: false, said: null, picker: null, stale: false,
  };
  return descendants(FollowUps({ state: getState(), list })).filter(node => node.props.class === 'notice').map(node => node.props.children);
}

describe('a follow-ups list', () => {
  it('says it has none only when it counts none, never under a closed group that holds some', async () => {
    expect(await notices({})).toEqual(['No follow-ups']);
    expect(await notices({ done: 3 })).toEqual([]);
    expect(await notices({ not_relevant: 1 })).toEqual([]);
  });
});
