// A follow-up Ask cites or names (ADR-0040), in the store and on the page:
// it opens in Ask's side panel with its title, owner, status and latest check
// while Ask keeps running; once the answer came, Open goes to its item page;
// and its source row says "owner · status", with no kind label.
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, AnswerSource, AskReceipt, Expect, OpenItemView } from '../../src/shared/protocol.js';
import { ACCOUNT, fail, flush, Held, ok, project, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
// Components are called as plain functions below: hooks keep their first value and run no effect.
vi.mock('preact/hooks', async original => ({
  ...await original<typeof import('preact/hooks')>(),
  useRef: (value: unknown = null) => ({ current: value }), useEffect: () => undefined, useLayoutEffect: () => undefined,
  useState: (value: unknown) => [typeof value === 'function' ? (value as () => unknown)() : value, () => undefined],
  useCallback: (fn: unknown) => fn, useMemo: (make: () => unknown) => make(),
}));

const EXPECT: Expect = { authority: ACCOUNT.authority, membership_id: ACCOUNT.membership_id };
const ITEM = 'itm_launch-1';
const followUp: AnswerSource = { kind: 'follow_up', label: 'Ship the launch checklist', item_id: ITEM };
const mina = { membership_id: 'mem_00000000-0000-4000-8000-000000000011', name: 'Mina Patel', active: true };
/** The follow-up's row, as `runs item` reads it rows only. */
const row = (owner = mina): OpenItemView => ({
  item_id: ITEM, run_id: 'run_00000001', kind: 'ticket', expected: 'Ship the launch checklist', relation: 'needs_updating',
  approver: mina, owner: { ...owner, match: 'name' }, waits_on: 'owner', state: 'open',
  created_at: '2026-10-14T09:00:00.000Z', sent_at: '2026-10-14T10:00:00.000Z', state_set_at: '2026-10-14T10:00:00.000Z',
  state_set_by: mina, owner_set_at: null, owner_set_by: null, send_included: true,
  check: { verdict: 'still_open', checked_at: '2026-10-16T09:00:00.000Z', checked_by: 'Mina Patel' }, can: { set_state: true, assign: true }, reach: 'not_read',
});
const receipt: AskReceipt = { looked_through: 1, elapsed_ms: 31_000, rows: [{ type: 'searched', sources: [{ kind: 'follow_ups' }], found: 1 }, { type: 'read', items: [followUp] }] };
const answer: Answer = {
  text: 'The launch checklist is still open.', scope: { kind: 'global' }, sources: [followUp], outcome: 'answered', receipt,
  parts: [{ question: 'What are my open tasks?', status: 'answered', statements: [{ text: 'The launch checklist is still open.', citation_indexes: [0], private: false }] }],
};

let held: Held;
let reads: (() => unknown)[];
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: new Date('2026-10-16T11:00:00.000Z') });
  stubWindow();
  held = new Held();
  reads = [];
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    runs: params => (params.request as { operation: string }).operation === 'item' ? (reads.shift() ?? (() => ok(row())))() : fail('unavailable', { retryable: true }),
  }, () => ({ active: [project(1, 30, { name: 'Apollo' })], archived: [] })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const itemReads = () => rpc.mock.calls.filter(([name, params]) => name === 'runs' && (params as { request: { operation: string } }).request.operation === 'item')
  .map(([, params]) => params as Record<string, unknown>);

type Node = VNode<Record<string, unknown>>;
/** A component tree as it would show: function components called, so only elements remain. */
function render(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(render);
  if (!value || typeof value !== 'object' || !('props' in value)) return value;
  const node = value as Node;
  if (typeof node.type === 'function') return render((node.type as (props: Record<string, unknown>) => unknown)(node.props));
  return { ...node, props: { ...node.props, children: render(node.props.children) } };
}
function elements(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...elements(node.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object' || !('props' in value)) return '';
  return text((value as Node).props.children);
}
const byTestId = (tree: unknown, id: string) => elements(tree).filter(node => node.props['data-testid'] === id);

/** A question on its way, its reply held; and the page's pane and thread as they show now. */
async function asking() {
  const store = await startStore();
  const screens = await import('../../src/renderer/screens/ask.js');
  const release = held.hold('ask.run');
  void store.ask('What are my open tasks?');
  await flush();
  const cancel_id = rpc.mock.calls.filter(([name]) => name === 'ask.run').at(-1)![1].cancel_id as string;
  return {
    store, release,
    step: (items: readonly AnswerSource[]) => store.askProgress({ cancel_id, expect: EXPECT, step: { type: 'read', items } }),
    pane: () => render(screens.SourcePane({ state: store.getState() })),
    thread: () => render(screens.AskView({ state: store.getState() })),
  };
}

describe('a follow-up opens beside Ask (ADR-0040)', () => {
  it('shows its title, owner, status and latest check while Ask runs, with no Open until the answer, then opens its item page', async () => {
    const { store, release, step, pane } = await asking();
    step([followUp]);
    store.openNamed([followUp]);
    await flush();
    // Its row, read as Home reads it, rows only.
    expect(itemReads()).toEqual([{ expect: EXPECT, request: { schema_version: 1, operation: 'item', item_id: ITEM, read: 'rows' } }]);
    const shown = pane();
    expect(text(byTestId(shown, 'source-pane'))).toContain('Follow-up');
    expect(text(byTestId(shown, 'follow-up').flatMap(node => elements(node).filter(child => child.type === 'h2')))).toBe('Ship the launch checklist');
    expect(text(byTestId(shown, 'follow-up-owner'))).toBe('Mina');
    expect(text(byTestId(shown, 'follow-up-status'))).toBe('Open');
    expect(text(byTestId(shown, 'follow-up-check'))).toBe('Checked 2 h ago · not updated yet');
    // Leaving Ask would cancel it: no Open, and Open does nothing.
    expect(byTestId(shown, 'source-open')).toEqual([]);
    store.openFullPage();
    expect(store.getState().ask?.asking).not.toBeNull();
    expect(rpc.mock.calls.some(([name]) => name === 'ask.cancel')).toBe(false);

    // The answer cites it: the pane stays on it, with what it read, and Open shows.
    vi.advanceTimersByTime(3_000);
    release(ok(answer));
    await flush();
    expect(store.paneTarget()?.sources).toEqual([followUp]);
    expect(byTestId(pane(), 'source-open')).toHaveLength(1);
    store.openFullPage();
    await flush();
    // Its item page, with the row the pane read, read again; Ask is gone and was never cancelled.
    expect(store.getState().ask).toBeNull();
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id: ITEM, item: { item_id: ITEM, state: 'open' } });
    expect(itemReads().length).toBeGreaterThanOrEqual(3);
    expect(rpc.mock.calls.some(([name]) => name === 'ask.cancel')).toBe(false);
  });

  it.each([
    { owner: mina, words: 'Mina · Open' },
    { owner: { ...mina, membership_id: ACCOUNT.membership_id, name: 'Fixture Person' }, words: 'You · Open' },
  ])('shows "$words" on a cited follow-up\'s source row, with no kind label', async ({ owner, words }) => {
    reads = [() => ok(row(owner))];
    const { store, release, thread } = await asking();
    release(ok({ ...answer, receipt: undefined }));
    await flush();
    // Read in the background once the answer came, for the row's qualifier.
    expect(store.getState().sources?.followUps[ITEM]).toMatchObject({ loading: false, value: { item_id: ITEM } });
    const [source] = byTestId(thread(), 'source-row');
    expect(text(source)).toBe(`1Ship the launch checklist${words}`);
    expect(text(source)).not.toMatch(/follow-up/iu);
  });

  it('says why a follow-up could not be read, and reads it again on Try again', async () => {
    // The background read for its row fails, and so does the pane's read when its source is chosen.
    reads = [() => fail('unavailable', { retryable: true }), () => fail('unavailable', { retryable: true })];
    const { store, release, pane, thread } = await asking();
    release(ok({ ...answer, receipt: undefined }));
    await flush();
    // A row whose follow-up was not read says nothing more than its title.
    expect(text(byTestId(thread(), 'source-row'))).toBe('1Ship the launch checklist');
    store.chooseSource(0);
    await flush();
    expect(byTestId(pane(), 'source-error')).toHaveLength(1);
    expect(byTestId(pane(), 'follow-up')).toEqual([]);
    store.retryRecord();
    await flush();
    expect(text(byTestId(pane(), 'follow-up-status'))).toBe('Open');
    expect(itemReads()).toHaveLength(3);
  });
});
