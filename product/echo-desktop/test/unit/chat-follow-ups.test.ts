// Follow-ups with no meeting behind them (ADR-0053): Home's Send rows list your drafts from a chat, each opening its page; a
// follow-ups list says "From a chat" where a meeting would be; and its page edits it, and sends or dismisses it on its own.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpList, ItemPage } from '../../src/renderer/store.js';
import type { OpenItemView } from '../../src/shared/protocol.js';
import { followUp, MINA } from './changes-fixture.js';
import { ACCOUNT, byTestId, click, elements, EMPTY_SUMMARY, fail, flush, Held, ok, plainHooks, render, rpcFor, startStore, storeLifecycle, text } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const me = { membership_id: ACCOUNT.membership_id, name: 'Fixture', active: true };
/** Your draft from a chat, not sent: nobody owns it yet, due Nov 20. */
const draft = (n = 1, patch: Partial<OpenItemView> = {}): OpenItemView => ({
  item_id: `itm_chat-000${n}`, run_id: null, kind: 'action', relation: 'needs_updating', expected: `Chat task ${n}`, due_on: '2026-11-20',
  approver: me, owner: { ...me, match: 'approver' }, waits_on: 'approver', state: 'unsent', created_at: `2026-11-18T1${n}:00:00.000Z`, sent_at: null,
  state_set_at: null, state_set_by: null, owner_set_at: null, owner_set_by: null, send_included: null,
  can: { set_state: false, assign: true, edit: true, send: true }, reach: 'not_read', ...patch,
});
const owned = (n = 1) => draft(n, { owner: { ...MINA, active: true, match: 'picked' } });

type Runs = { operation: string } & Record<string, unknown>;
let items: Map<string, OpenItemView>;
storeLifecycle(new Date('2026-11-18T12:00:00'));
beforeEach(() => {
  items = new Map();
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), {
    runs: params => {
      const request = params.request as Runs;
      const item = items.get(request.item_id as string);
      switch (request.operation) {
        case 'item': return item ? ok(item) : fail('not_found');
        case 'items': return ok({ items: [...items.values()], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] });
        case 'send': return ok({ sent: 1, not_relevant: 0 });
        case 'send_item': {
          const state = request.include ? 'open' : 'not_relevant';
          items.set(item!.item_id, { ...item!, state, sent_at: '2026-11-18T12:00:00.000Z', state_set_at: '2026-11-18T12:00:00.000Z', state_set_by: me,
            send_included: request.include as boolean, can: { ...item!.can, send: false } });
          return ok({ state });
        }
        case 'edit': {
          items.set(item!.item_id, { ...item!, ...(request.expected === undefined ? {} : { expected: request.expected as string }),
            ...(request.due_on === undefined ? {} : { due_on: request.due_on as string | null }) });
          return ok({ expected: items.get(item!.item_id)!.expected, due_on: items.get(item!.item_id)!.due_on });
        }
        default: return fail('unavailable', { retryable: true });
      }
    },
  }, () => ({ active: [], archived: [] })));
});

const sent = (operation: string) => rpc.mock.calls.filter(([name, params]) => name === 'runs' && (params as { request: Runs }).request.operation === operation)
  .map(([, params]) => (params as { request: Runs }).request);

describe('Home lists your drafts from a chat (ADR-0053)', () => {
  it('as Send rows in its "to send" area, each saying where it stands and opening its page; two or more are one Send line', async () => {
    const store = await startStore();
    const { Home } = await import('../../src/renderer/screens/home.js');
    const state = store.getState();
    const home = (drafts: OpenItemView[]) => ({ ...state.home!, loading: false, reading: false, reviews: [], runs: [], failure: undefined,
      open: { send: [], items: [], waiting: 0, drafts } });
    const one = { ...state, home: home([draft(1)]) };
    expect(store.homeRows(one).map(row => [row.kind, store.categoryOf(row)])).toEqual([['send', 'send']]);
    expect(store.needsCount(one)).toBe(1);
    const row = byTestId(render(Home({ state: one })), 'need-row')[0]!;
    expect(row.props['data-category']).toBe('send');
    expect(text(row)).toBe('SendChat task 1From a chat · No owner yet · Due Nov 20');
    click(row);
    await flush();
    expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id: 'itm_chat-0001' });
    // Two: one Send line, naming the newest.
    const two = { ...store.getState(), home: home([draft(2), draft(1)]), followUps: null };
    expect(text(byTestId(render(Home({ state: two })), 'need-category')[0])).toMatch(/^Send2Chat task 2and 1 more/u);
  });
});

describe('a follow-ups list with a follow-up from a chat', () => {
  it('says "From a chat" on its row, ticks it only once someone owns it, and sends it on its own beside a meeting\'s', async () => {
    const store = await startStore();
    const { FollowUps } = await import('../../src/renderer/screens/follow-ups.js');
    const meeting = followUp(1, { approver: me, state: 'unsent', sent_at: null, state_set_at: null, state_set_by: null, send_included: null,
      can: { set_state: false, assign: true, edit: false, send: false } });
    for (const item of [meeting, draft(1), owned(2)]) items.set(item.item_id, item);
    const list: FollowUpList = {
      kind: 'list', seq: 1, scope: 'involved', title: null, loading: false, items: [...items.values()], live: {}, reading: false,
      reads: [{ parts: ['active'], pages: [{ cursor: null, ids: [...items.keys()] }], next: null }], summary: { ...EMPTY_SUMMARY, unsent: 3 }, stage: null,
      ticks: {}, sends: {}, expanded: {}, busy: false, said: null, picker: null, stale: false,
    };
    const rows = byTestId(render(FollowUps({ state: store.getState(), list })), 'follow-up-row');
    const row = (id: string) => rows.find(entry => entry.props['data-item'] === id)!;
    expect(byTestId(row('itm_chat-0001'), 'follow-up-from').map(text)).toEqual(['From a chat']);
    expect(byTestId(row(meeting.item_id), 'follow-up-from')).toEqual([]);
    expect(row('itm_chat-0001').props.title).toBe('Follow-up · From a chat · No owner yet · Due Nov 20');
    // No owner: no tick; owned: a tick, as a meeting's.
    const box = (id: string) => elements(row(id)).filter(node => node.props.class === 'send-box');
    expect([box('itm_chat-0001').length, box('itm_chat-0002').length, box(meeting.item_id).length]).toEqual([0, 1, 1]);
    expect(store.sendable(draft(1))).toBe(false);
    expect(store.dismissable(draft(1))).toBe(true);

    // Ticked and sent: the meeting's in its check's send, the chat's on its own.
    store.getState().followUps = { route: store.getState().route, views: [{ ...list, ticks: { [meeting.item_id]: true, 'itm_chat-0002': true } }], changed: false };
    await store.sendTicked(true);
    await flush();
    expect(sent('send')).toMatchObject([{ run_id: meeting.run_id, items: [{ item_id: meeting.item_id, include: true }] }]);
    expect(sent('send_item')).toMatchObject([{ item_id: 'itm_chat-0002', include: true }]);
  });
});

describe('a follow-up from a chat on its page', () => {
  async function page(item: OpenItemView) {
    const store = await startStore();
    items.set(item.item_id, item);
    await store.openFollowUp(item.item_id, item);
    await flush();
    const { FollowUp } = await import('../../src/renderer/screens/follow-ups.js');
    return { store, shown: () => render(FollowUp({ state: store.getState(), page: store.followUpShown() as ItemPage })) };
  }

  it('says it came from a chat, when it is due and Edit; with no owner, only Dismiss, and the reason', async () => {
    const { shown } = await page(draft(1));
    const tree = shown();
    expect(text(elements(tree).find(node => node.props.class === 'card-meta'))).toBe('Follow-up · From a chat · Due Nov 20');
    expect(byTestId(tree, 'follow-up-edit').map(text)).toEqual(['Edit']);
    expect(text(byTestId(tree, 'follow-up-history'))).toContain('From a chat by you');
    const buttons = elements(elements(tree).find(node => node.type === 'aside')).filter(node => node.type === 'button').map(text);
    expect(buttons).toEqual(['Pick owner', 'Dismiss']);
    expect(text(elements(tree).find(node => node.type === 'aside'))).toContain('Pick an owner to send it');
  });

  it('edits its line and date, then sends it on its own', async () => {
    const { store, shown } = await page(owned(1));
    expect(await store.editFollowUp({ expected: 'Chat task 1, revised', due_on: null })).toBe(true);
    expect(sent('edit')).toEqual([{ schema_version: 1, operation: 'edit', item_id: 'itm_chat-0001', expected: 'Chat task 1, revised', due_on: null }]);
    expect(text(byTestId(shown(), 'follow-up-said'))).toBe('Saved');
    // No due date any more: none is said.
    expect(text(elements(shown()).find(node => node.props.class === 'card-meta'))).toBe('Follow-up · From a chat');
    await store.sendFollowUp(true);
    await flush();
    expect(sent('send_item')).toMatchObject([{ operation: 'send_item', item_id: 'itm_chat-0001', include: true }]);
    expect(sent('send')).toEqual([]);
    expect((store.followUpShown() as ItemPage).item!.state).toBe('open');
    expect(text(byTestId(shown(), 'follow-up-said'))).toBe('Sent to Mina');
  });

  it('dismisses one nobody owns yet', async () => {
    const { store } = await page(draft(1));
    await store.sendFollowUp(true);
    expect(sent('send_item')).toEqual([]);
    await store.sendFollowUp(false);
    await flush();
    expect(sent('send_item')).toMatchObject([{ item_id: 'itm_chat-0001', include: false }]);
    expect((store.followUpShown() as ItemPage).item!.state).toBe('not_relevant');
  });
});
