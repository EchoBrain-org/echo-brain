import type { VNode } from 'preact';
import { expect, it, vi } from 'vitest';
import type { ItemPage } from '../../src/renderer/store.js';
import type { OpenItemView } from '../../src/shared/protocol.js';

vi.mock('../../src/renderer/api.js', () => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('preact/hooks', async original => ({
  ...await original<typeof import('preact/hooks')>(),
  useRef: (value: unknown = null) => ({ current: value }), useEffect: () => undefined,
  useLayoutEffect: () => undefined, useMemo: (make: () => unknown) => make(),
}));

function descendants(value: unknown): VNode<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as VNode<Record<string, unknown>>;
  return [node, ...descendants(node.props.children)];
}

it('offers a retry after opening a known row whose detail read failed', async () => {
  const { getState } = await import('../../src/renderer/store.js');
  const { FollowUp } = await import('../../src/renderer/screens/follow-ups.js');
  const person = { membership_id: 'mem_00000000-0000-4000-8000-000000000011', name: 'Mina', active: true };
  const item: OpenItemView = {
    item_id: 'itm_00000001', run_id: 'run_00000001', kind: 'ticket', expected: 'Update the checklist', relation: 'needs_updating',
    approver: person, owner: { ...person, match: 'name' }, waits_on: 'owner', state: 'open',
    created_at: '2026-10-14T09:00:00.000Z', sent_at: '2026-10-14T10:00:00.000Z', state_set_at: '2026-10-14T10:00:00.000Z',
    state_set_by: person, owner_set_at: null, owner_set_by: null, send_included: true, check: null,
    can: { set_state: true, assign: true }, reach: 'not_read',
  };
  // readItem keeps the row and records an unavailable live part on a transient read failure.
  const page: ItemPage = {
    kind: 'item', seq: 1, item_id: item.item_id, item, live: { [item.item_id]: { reach: 'unavailable' } },
    loading: false, send: null, busy: false, said: null, picker: null, stale: false,
  };
  const buttons = descendants(FollowUp({ state: getState(), page })).filter(node => node.type === 'button');
  expect(buttons.some(node => node.props.children === 'Try again')).toBe(true);
});
