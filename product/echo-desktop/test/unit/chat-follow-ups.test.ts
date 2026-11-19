// Follow-ups with no meeting behind them (ADR-0053): Home's Send rows list your drafts from a chat, each opening its page; a
// follow-ups list says "From a chat" where a meeting would be; and its page edits it, and sends or dismisses it on its own.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpList, ItemPage } from '../../src/renderer/store.js';
import type { OpenItemView } from '../../src/shared/protocol.js';
import { followUp, MINA, RAFAEL } from './changes-fixture.js';
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
let held: Held;
/** Per item: what another window does to it as a send reaches the Authority, which then loses its reply. */
let lost: Map<string, (item: OpenItemView) => OpenItemView>;
/** Reads of one item fail while set, as an outage would. */
let failItem: boolean;
/** Reads of a list's rows fail while set. */
let failItems: boolean;
/** Items a write makes gone for you: a send_item's reply is then lost; a set_state answers. */
let vanish: Set<string>;
storeLifecycle(new Date('2026-11-18T12:00:00'));
beforeEach(() => {
  items = new Map();
  held = new Held();
  lost = new Map();
  failItem = false;
  failItems = false;
  vanish = new Set();
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    runs: params => {
      const request = params.request as Runs;
      const item = items.get(request.item_id as string);
      switch (request.operation) {
        case 'item': return failItem ? fail('timeout', { retryable: true }) : item ? ok(item) : fail('not_found');
        case 'items': if (failItems) return fail('timeout', { retryable: true }); return ok({ items: [...items.values()], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] });
        case 'send': {
          for (const entry of request.items as { item_id: string; include: boolean }[]) {
            const row = items.get(entry.item_id)!;
            items.set(row.item_id, { ...row, state: entry.include ? 'open' : 'not_relevant', sent_at: '2026-11-18T12:00:00.000Z', state_set_at: '2026-11-18T12:00:00.000Z',
              state_set_by: me, send_included: entry.include });
          }
          return ok({ sent: 1, not_relevant: 0 });
        }
        case 'set_state': {
          if (vanish.has(item!.item_id)) { items.delete(item!.item_id); return ok({ state: request.state }); }
          items.set(item!.item_id, { ...item!, state: request.state as OpenItemView['state'], state_set_at: '2026-11-18T12:10:00.000Z', state_set_by: me });
          return ok({ state: request.state });
        }
        case 'send_item': {
          if (vanish.has(item!.item_id)) { items.delete(item!.item_id); return fail('timeout', { retryable: true, mutation_outcome: 'unknown' }); }
          const elsewhere = lost.get(item!.item_id);
          if (elsewhere) { items.set(item!.item_id, elsewhere(item!)); return fail('timeout', { retryable: true, mutation_outcome: 'unknown' }); }
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

describe('review fixes on a list and a page: a lost reply is settled by what happened', () => {
  const dismissedElsewhere = (item: OpenItemView): OpenItemView => ({ ...item, state: 'not_relevant', sent_at: '2026-11-18T12:00:00.000Z',
    state_set_at: '2026-11-18T12:00:00.000Z', send_included: false, can: { ...item.can, send: false } });

  it('on its page, a Send whose reply was lost and that another window dismissed says so, never Sent', async () => {
    const store = await startStore();
    items.set('itm_chat-0001', owned(1));
    await store.openFollowUp('itm_chat-0001', owned(1));
    await flush();
    lost.set('itm_chat-0001', dismissedElsewhere);
    await store.sendFollowUp(true);
    await flush();
    const page = store.followUpShown() as ItemPage;
    expect(sent('send_item')).toMatchObject([{ item_id: 'itm_chat-0001', include: true, owner_membership_id: MINA.membership_id }]);
    expect(page.said).toEqual({ words: 'Not sent: it was dismissed meanwhile', error: true });
    expect(page.send).toBeNull();
  });

  it('Send N says what went and what another window did meanwhile, and names the owner on every send', async () => {
    const store = await startStore();
    for (const item of [owned(1), owned(2)]) items.set(item.item_id, item);
    lost.set('itm_chat-0002', dismissedElsewhere);
    const list: FollowUpList = {
      kind: 'list', seq: 1, scope: 'involved', title: null, loading: false, items: [...items.values()], live: {}, reading: false,
      reads: [{ parts: ['active'], pages: [{ cursor: null, ids: [...items.keys()] }], next: null }], summary: { ...EMPTY_SUMMARY, unsent: 2 }, stage: null,
      ticks: { 'itm_chat-0001': true, 'itm_chat-0002': true }, sends: {}, expanded: {}, busy: false, said: null, picker: null, stale: false,
    };
    store.getState().followUps = { route: store.getState().route, views: [list], changed: false };
    // The first goes; the second's reply is lost.
    await store.sendTicked(true);
    await flush();
    expect(sent('send_item').map(request => request.owner_membership_id)).toEqual([MINA.membership_id, MINA.membership_id]);
    const said = (store.followUpShown() as FollowUpList).said!;
    expect(said.words).toBe('Sent to Mina · Not sent: it was dismissed meanwhile');
    expect(said.words).not.toMatch(/Sent 2/u);
    expect((store.followUpShown() as FollowUpList).sends).toEqual({});
  });
});

describe('second review on a list and a page', () => {
  const sentThenDismissed = (item: OpenItemView): OpenItemView => ({ ...item, state: 'not_relevant', sent_at: '2026-11-18T12:00:00.000Z',
    state_set_at: '2026-11-18T12:05:00.000Z', send_included: true, can: { ...item.can, send: false } });
  const dismissedElsewhere = (item: OpenItemView): OpenItemView => ({ ...item, state: 'not_relevant', sent_at: '2026-11-18T12:00:00.000Z',
    state_set_at: '2026-11-18T12:00:00.000Z', send_included: false, can: { ...item.can, send: false } });
  const listOf = (ticked: readonly string[]): FollowUpList => ({
    kind: 'list', seq: 1, scope: 'involved', title: null, loading: false, items: [...items.values()], live: {}, reading: false,
    reads: [{ parts: ['active'], pages: [{ cursor: null, ids: [...items.keys()] }], next: null }], summary: { ...EMPTY_SUMMARY, unsent: items.size }, stage: null,
    ticks: Object.fromEntries(ticked.map(id => [id, true])), sends: {}, expanded: {}, busy: false, said: null, picker: null, stale: false,
  });

  it('on its page, a send whose reply was lost and that its owner dismissed since says it was sent, and what happened since', async () => {
    const store = await startStore();
    items.set('itm_chat-0001', owned(1));
    await store.openFollowUp('itm_chat-0001', owned(1));
    await flush();
    lost.set('itm_chat-0001', sentThenDismissed);
    await store.sendFollowUp(true);
    await flush();
    expect((store.followUpShown() as ItemPage).said).toEqual({ words: 'Sent to Mina. It has since been dismissed' });
  });

  it('Send N counts a lost reply as sent by send_included, whatever the state since', async () => {
    const store = await startStore();
    items.set('itm_chat-0001', owned(1));
    lost.set('itm_chat-0001', sentThenDismissed);
    store.getState().followUps = { route: store.getState().route, views: [listOf(['itm_chat-0001'])], changed: false };
    await store.sendTicked(true);
    await flush();
    expect((store.followUpShown() as FollowUpList).said).toEqual({ words: 'Sent to Mina. It has since been dismissed' });
  });

  it('Send N whose every row was changed elsewhere still marks what is under it to be read again', async () => {
    const store = await startStore();
    items.set('itm_chat-0001', owned(1));
    lost.set('itm_chat-0001', dismissedElsewhere);
    store.getState().followUps = { route: store.getState().route, views: [listOf(['itm_chat-0001'])], changed: false };
    await store.sendTicked(true);
    await flush();
    expect((store.followUpShown() as FollowUpList).said).toEqual({ words: 'Not sent: it was dismissed meanwhile', error: true });
    expect(store.getState().followUps!.changed).toBe(true);
  });

  it('a page offers no action on a follow-up from a chat until its own read succeeds', async () => {
    const store = await startStore();
    const { FollowUp } = await import('../../src/renderer/screens/follow-ups.js');
    items.set('itm_chat-0001', owned(1));
    const release = held.hold('runs');
    void store.openFollowUp('itm_chat-0001', owned(1));
    await flush();
    const shown = () => render(FollowUp({ state: store.getState(), page: store.followUpShown() as ItemPage }));
    const aside = () => elements(shown()).find(node => node.type === 'aside');
    // Its cached copy shows, but nothing acts on it: no Send, Dismiss or Edit, and the owner is not a picker.
    expect(elements(aside()).filter(node => node.type === 'button').map(text)).toEqual([]);
    expect(byTestId(shown(), 'follow-up-edit')).toEqual([]);
    await store.sendFollowUp(true);
    await store.sendFollowUp(false);
    expect(await store.editFollowUp({ expected: 'Else' })).toBe(false);
    store.toggleOwnerPicker('itm_chat-0001');
    expect((store.followUpShown() as ItemPage).picker).toBeNull();
    expect(sent('send_item')).toEqual([]);
    expect(sent('edit')).toEqual([]);
    // Read: it acts again.
    release(ok(owned(1)));
    await flush();
    expect(elements(aside()).filter(node => node.type === 'button').map(text)).toEqual(['MPMina', 'Send to Mina', 'Dismiss']);
    expect(byTestId(shown(), 'follow-up-edit')).toHaveLength(1);
  });

  it('a page whose read failed offers no action on a follow-up from a chat, only Try again', async () => {
    const store = await startStore();
    const { FollowUp } = await import('../../src/renderer/screens/follow-ups.js');
    items.set('itm_chat-0001', owned(1));
    const release = held.hold('runs');
    void store.openFollowUp('itm_chat-0001', owned(1));
    await flush();
    release(fail('unavailable', { retryable: true }));
    await flush();
    const tree = render(FollowUp({ state: store.getState(), page: store.followUpShown() as ItemPage }));
    const buttons = elements(tree).filter(node => node.type === 'button').map(text);
    expect(buttons).toContain('Try again');
    for (const label of ['Send to Mina', 'Dismiss', 'Edit']) expect(buttons).not.toContain(label);
  });
});

describe('third review: meeting wording, and nothing acts from a copy not read since', () => {
  /** A meeting's follow-up not sent yet, yours to send, as Sam's (Mina's) when the page read it. */
  const meeting = (owner = MINA): OpenItemView => followUp(1, { approver: me, owner: { ...owner, match: 'name' }, state: 'unsent', sent_at: null, state_set_at: null,
    state_set_by: null, send_included: null, waits_on: 'approver', can: { set_state: false, assign: true, edit: false, send: false } });
  /** Your chat follow-up, sent to Mina and open. */
  const sentChat = (): OpenItemView => ({ ...owned(1), state: 'open', sent_at: '2026-11-18T11:00:00.000Z', state_set_at: '2026-11-18T11:00:00.000Z', state_set_by: me,
    send_included: true, waits_on: 'owner', can: { set_state: true, assign: true, edit: true, send: false } });
  async function page(item: OpenItemView) {
    const store = await startStore();
    items.set(item.item_id, item);
    await store.openFollowUp(item.item_id, item);
    await flush();
    const { FollowUp } = await import('../../src/renderer/screens/follow-ups.js');
    return { store, shown: () => render(FollowUp({ state: store.getState(), page: store.followUpShown() as ItemPage })) };
  }

  it('a meeting\'s send, which names no owner, words its confirmation from the read again, on its page and in Send N', async () => {
    const { store } = await page(meeting(MINA));
    // Handed to Rafael after the page read it, before Send.
    items.set(followUp(1).item_id, meeting(RAFAEL));
    await store.sendFollowUp(true);
    await flush();
    expect(sent('send')[0]!).not.toHaveProperty('owner_membership_id');
    expect((store.followUpShown() as ItemPage).said).toEqual({ words: 'Sent to Rafael' });

    const listed = await startStore();
    items.clear();
    items.set(followUp(1).item_id, meeting(RAFAEL));
    const list: FollowUpList = {
      kind: 'list', seq: 1, scope: 'involved', title: null, loading: false, items: [meeting(MINA)], live: {}, reading: false,
      reads: [{ parts: ['active'], pages: [{ cursor: null, ids: [followUp(1).item_id] }], next: null }], summary: { ...EMPTY_SUMMARY, unsent: 1 }, stage: null,
      ticks: { [followUp(1).item_id]: true }, sends: {}, expanded: {}, busy: false, said: null, picker: null, stale: false,
    };
    listed.getState().followUps = { route: listed.getState().route, views: [list], changed: false };
    await listed.sendTicked(true);
    await flush();
    expect((listed.followUpShown() as FollowUpList).said).toEqual({ words: 'Sent to Rafael' });
  });

  it('closes an open owner picker when a read of a follow-up from a chat fails', async () => {
    const { store } = await page(owned(1));
    store.toggleOwnerPicker('itm_chat-0001');
    await flush();
    expect((store.followUpShown() as ItemPage).picker).not.toBeNull();
    failItem = true;
    store.retryFollowUp();
    await flush();
    expect((store.followUpShown() as ItemPage).failure).toBeDefined();
    expect((store.followUpShown() as ItemPage).picker).toBeNull();
  });

  it('offers Undo on a follow-up from a chat only after a successful read', async () => {
    const { store, shown } = await page(sentChat());
    failItem = true;
    await store.setFollowUpState('not_relevant');
    await flush();
    expect((store.followUpShown() as ItemPage).said).toMatchObject({ words: 'Dismissed' });
    expect(elements(shown()).filter(node => node.type === 'button').map(text)).not.toContain('Undo');
    const before = sent('set_state').length;
    await store.undoFollowUp();
    await flush();
    expect(sent('set_state')).toHaveLength(before);
  });

  it('an edit that went but whose read again failed says so, with Try again', async () => {
    const { store, shown } = await page(owned(1));
    failItem = true;
    expect(await store.editFollowUp({ expected: 'Chat task 1, revised' })).toBe(true);
    await flush();
    const now = store.followUpShown() as ItemPage;
    expect(now.said).toEqual({ words: 'Saved' });
    expect(now.failure).toMatchObject({ code: 'timeout' });
    expect(elements(shown()).filter(node => node.type === 'button').map(text)).toContain('Try again');
    failItem = false;
    store.retryFollowUp();
    await flush();
    expect(byTestId(shown(), 'follow-up-edit')).toHaveLength(1);
  });
});

describe('last review: a meeting send not read again names no one, and a gone chat follow-up offers only the way back', () => {
  const meeting = (owner = MINA): OpenItemView => followUp(1, { approver: me, owner: { ...owner, match: 'name' }, state: 'unsent', sent_at: null, state_set_at: null,
    state_set_by: null, send_included: null, waits_on: 'approver', can: { set_state: false, assign: true, edit: false, send: false } });
  const sentChat = (): OpenItemView => ({ ...owned(1), state: 'open', sent_at: '2026-11-18T11:00:00.000Z', state_set_at: '2026-11-18T11:00:00.000Z', state_set_by: me,
    send_included: true, waits_on: 'owner', can: { set_state: true, assign: true, edit: true, send: false } });
  async function page(item: OpenItemView, kept = true) {
    const store = await startStore();
    if (kept) items.set(item.item_id, item);
    await store.openFollowUp(item.item_id, item);
    await flush();
    const { FollowUp } = await import('../../src/renderer/screens/follow-ups.js');
    const shown = () => render(FollowUp({ state: store.getState(), page: store.followUpShown() as ItemPage }));
    return { store, shown, buttons: () => elements(shown()).filter(node => node.type === 'button').map(text) };
  }
  const goneWords = 'You no longer see this follow-up';

  it('a confirmed meeting send whose read again failed says Sent, naming no one, on its page and in Send N', async () => {
    const { store } = await page(meeting(MINA));
    items.set(followUp(1).item_id, meeting(RAFAEL));
    failItem = true;
    await store.sendFollowUp(true);
    await flush();
    expect((store.followUpShown() as ItemPage).said).toEqual({ words: 'Sent' });

    const listed = await startStore();
    items.clear();
    items.set(followUp(1).item_id, meeting(RAFAEL));
    failItem = true;
    failItems = true;
    const list: FollowUpList = {
      kind: 'list', seq: 1, scope: 'involved', title: null, loading: false, items: [meeting(MINA)], live: {}, reading: false,
      reads: [{ parts: ['active'], pages: [{ cursor: null, ids: [followUp(1).item_id] }], next: null }], summary: { ...EMPTY_SUMMARY, unsent: 1 }, stage: null,
      ticks: { [followUp(1).item_id]: true }, sends: {}, expanded: {}, busy: false, said: null, picker: null, stale: false,
    };
    listed.getState().followUps = { route: listed.getState().route, views: [list], changed: false };
    await listed.sendTicked(true);
    await flush();
    expect((listed.followUpShown() as FollowUpList).said).toEqual({ words: 'Sent' });
  });

  it('a chat follow-up whose send reply was lost and that is gone says so, and offers only Back', async () => {
    const { store, shown, buttons } = await page(owned(1));
    vanish.add('itm_chat-0001');
    await store.sendFollowUp(true);
    await flush();
    expect((store.followUpShown() as ItemPage).gone).toBe(true);
    expect(text(shown())).toContain(goneWords);
    expect(buttons()).toEqual(['Back']);
  });

  it('a chat follow-up gone after a confirmed Mark done offers no Undo, only Back', async () => {
    const { store, shown, buttons } = await page(sentChat());
    vanish.add('itm_chat-0001');
    await store.setFollowUpState('done');
    await flush();
    expect((store.followUpShown() as ItemPage).gone).toBe(true);
    expect(text(shown())).toContain(goneWords);
    expect(buttons()).toEqual(['Back']);
  });

  it('a chat follow-up page whose read says it is gone says so, with no Try again', async () => {
    const { store, shown, buttons } = await page(owned(1), false);
    expect((store.followUpShown() as ItemPage).gone).toBe(true);
    expect(text(shown())).toContain(goneWords);
    expect(buttons()).toEqual(['Back']);
  });
});

describe('final round: gone clears on a good read, a meeting send never names the remembered owner, and not_found is gone for any page', () => {
  const meeting = (owner = MINA): OpenItemView => followUp(1, { approver: me, owner: { ...owner, match: 'name' }, state: 'unsent', sent_at: null, state_set_at: null,
    state_set_by: null, send_included: null, waits_on: 'approver', can: { set_state: false, assign: true, edit: false, send: false } });
  async function page(item: OpenItemView | null, id = item?.item_id ?? 'itm_chat-0001', kept = true) {
    const store = await startStore();
    if (kept && item) items.set(item.item_id, item);
    await store.openFollowUp(id, item);
    await flush();
    const { FollowUp } = await import('../../src/renderer/screens/follow-ups.js');
    const shown = () => render(FollowUp({ state: store.getState(), page: store.followUpShown() as ItemPage }));
    return { store, shown, buttons: () => elements(shown()).filter(node => node.type === 'button').map(text) };
  }
  const goneWords = 'You no longer see this follow-up';

  it('a gone chat follow-up read again successfully shows the card and its actions again', async () => {
    const { store, shown, buttons } = await page(owned(1), 'itm_chat-0001', false);
    expect((store.followUpShown() as ItemPage).gone).toBe(true);
    // Assigned back to you: its notification reads the open page again.
    items.set('itm_chat-0001', owned(1));
    store.retryFollowUp();
    await flush();
    const now = store.followUpShown() as ItemPage;
    expect(now.gone).toBeFalsy();
    expect(now.failure).toBeUndefined();
    expect(text(shown())).not.toContain(goneWords);
    expect(buttons()).toContain('Send to Mina');
  });

  it('a meeting send never shows the remembered owner, not even for a moment, read again or not', async () => {
    for (const [reads, last] of [[false, 'Sent'], [true, 'Sent to Rafael']] as const) {
      items.clear();
      const { store } = await page(meeting(MINA));
      items.set(followUp(1).item_id, meeting(RAFAEL));
      failItem = !reads;
      const seen: string[] = [];
      const stop = store.subscribe(() => { const view = store.followUpShown(); if (view?.kind === 'item' && view.said) seen.push(view.said.words); });
      await store.sendFollowUp(true);
      await flush();
      stop();
      failItem = false;
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter(words => words.includes('Mina'))).toEqual([]);
      expect(seen.at(-1)).toBe(last);
    }
  });

  it('a follow-up opened by its id alone that does not exist for you is gone, with only Back', async () => {
    const { store, shown, buttons } = await page(null, 'itm_chat-0009');
    expect((store.followUpShown() as ItemPage).gone).toBe(true);
    expect(text(shown())).toContain(goneWords);
    expect(buttons()).toEqual(['Back']);
  });

  it('a meeting follow-up that does not exist for you is gone too (it used to offer Try again); any other failure still does', async () => {
    const { store, shown, buttons } = await page(meeting(MINA), followUp(1).item_id, false);
    expect((store.followUpShown() as ItemPage).gone).toBe(true);
    expect(text(shown())).toContain(goneWords);
    expect(buttons()).toEqual(['Back']);
    failItem = true;
    const other = await page(meeting(MINA));
    expect((other.store.followUpShown() as ItemPage).gone).toBeFalsy();
    expect(other.buttons()).toContain('Try again');
  });
});
