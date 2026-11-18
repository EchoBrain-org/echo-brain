// Follow-ups an Ask answer drafted (ADR-0053), in the store and under the answer: the turn keeps only their ids, each card is
// read live as its turn shows (loading, loaded, gone, could not load), and its creator picks its owner, edits its line and due
// date, sends it on its own or dismisses it; Copy answer writes its line.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, OpenItemView } from '../../src/shared/protocol.js';
import { ACCOUNT, asking as askingWith, byTestId, click, elements, fail, flush, Held, ok, plainHooks, project, rpcFor, storeLifecycle, text, type Node } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const DRAFT = 'itm_chat-0001';
const me = { membership_id: ACCOUNT.membership_id, name: 'Fixture', active: true };
const sam = { membership_id: 'mem_00000000-0000-4000-8000-000000000007', display_name: 'Sam Lee' };
/** Your draft from this chat: not sent, nobody owns it yet, due Nov 20. */
const drafted = (): OpenItemView => ({
  item_id: DRAFT, run_id: null, kind: 'action', relation: 'needs_updating', expected: 'Update the pricing page', due_on: '2026-11-20',
  approver: me, owner: { ...me, match: 'approver' }, waits_on: 'approver', state: 'unsent', created_at: '2026-11-18T10:00:00.000Z', sent_at: null,
  state_set_at: null, state_set_by: null, owner_set_at: null, owner_set_by: null, send_included: null,
  can: { set_state: false, assign: true, edit: true, send: true }, reach: 'not_read',
});
const answer: Answer = {
  scope: { kind: 'global' }, sources: [], outcome: 'answered', receipt: { looked_through: 1 }, follow_ups: [DRAFT],
  parts: [{ question: 'Give the pricing page to Sam', status: 'answered', statements: [{ text: 'Nobody picked up the pricing page update.', citation_indexes: [], private: false }],
    blocks: [{ kind: 'text', statements: [0] }] }],
};

type Runs = { operation: string } & Record<string, unknown>;
let held: Held;
/** The card as the Authority keeps it; null once it is gone for you. */
let card: OpenItemView | null;
/** What the next write answers instead of doing it. */
let refuse: ReturnType<typeof fail> | null;
let itemReads: number;
let failReads: boolean;
storeLifecycle(new Date('2026-11-18T12:00:00'));
beforeEach(() => {
  held = new Held();
  card = drafted();
  refuse = null;
  itemReads = 0;
  failReads = false;
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'people.directory': () => ok({ items: [sam], next_cursor: null }),
    'clipboard.writeText': () => ok(null),
    runs: params => {
      const request = params.request as Runs;
      switch (request.operation) {
        case 'home': return ok({ send: [], items: [], waiting: 0, drafts: card?.state === 'unsent' ? [card] : [] });
        case 'item':
          itemReads += 1;
          if (failReads) return fail('unavailable', { retryable: true });
          return card ? ok(card) : fail('not_found');
        case 'assign': {
          card = { ...card!, owner: { ...sam, name: sam.display_name, active: true, match: 'picked' }, owner_set_at: '2026-11-18T12:00:00.000Z', owner_set_by: me };
          return ok({ owner: { membership_id: sam.membership_id, name: sam.display_name, active: true } });
        }
        case 'edit': {
          if (refuse) return refuse;
          card = { ...card!, ...(request.expected === undefined ? {} : { expected: request.expected as string }), ...(request.due_on === undefined ? {} : { due_on: request.due_on as string | null }) };
          return ok({ expected: card.expected, due_on: card.due_on });
        }
        case 'send_item': {
          if (refuse) return refuse;
          const include = request.include as boolean;
          card = { ...card!, state: include ? 'open' : 'not_relevant', sent_at: '2026-11-18T12:00:00.000Z', state_set_at: '2026-11-18T12:00:00.000Z', state_set_by: me,
            send_included: include, waits_on: 'owner', can: { set_state: true, assign: true, edit: include, send: false } };
          return ok({ state: card.state });
        }
        default: return fail('unavailable', { retryable: true });
      }
    },
  }, () => ({ active: [project(1, 30, { name: 'Apollo' })], archived: [] })));
});

const runs = (operation: string) => rpc.mock.calls.filter(([name, params]) => name === 'runs' && (params as { request: Runs }).request.operation === operation)
  .map(([, params]) => (params as { request: Runs }).request);

/** Ask asked and answered with one draft; the page's thread as it shows now. */
async function answered() {
  const asked = await askingWith(rpc, held, 'Nobody picked up the pricing page update. Give it to Sam, due Friday.');
  asked.release(ok(answer));
  await flush();
  return asked;
}

const cardOf = (tree: unknown): Node => byTestId(tree, 'ask-follow-up')[0]!;

describe('an answer that drafted a follow-up (ADR-0053)', () => {
  it('keeps only the draft\'s id on its turn, shows it under the answer while it is read, then as a follow-ups row', async () => {
    const { store, thread } = await answered();
    expect(store.getState().timeline.turns.at(-1)!.answer.follow_ups).toEqual([DRAFT]);
    expect(JSON.stringify(store.getState().timeline.turns)).not.toContain('Update the pricing page');
    // Before its read: loading.
    expect(cardOf(thread()).props['data-status']).toBe('loading');
    await store.readAskCards([DRAFT]);
    const shown = cardOf(thread());
    expect(shown.props['data-status']).toBe('loaded');
    expect(text(byTestId(shown, 'ask-follow-up-title'))).toBe('Update the pricing page');
    expect(text(byTestId(shown, 'ask-follow-up-line'))).toBe('From this chat · No owner yet · Due Nov 20');
    // Nobody owns it: Pick owner, Edit and Dismiss, and no Send. ECHO asks nothing in words.
    expect(text(shown)).toContain('Pick owner');
    expect(byTestId(shown, 'ask-follow-up-send')).toEqual([]);
    expect(byTestId(shown, 'ask-follow-up-edit')).toHaveLength(1);
    expect(byTestId(shown, 'ask-follow-up-dismiss')).toHaveLength(1);
    expect(runs('item')).toEqual([{ schema_version: 1, operation: 'item', item_id: DRAFT, read: 'rows' }]);
  });

  it('says when it is gone for you, and when it could not be read, with Try again', async () => {
    const { store, thread } = await answered();
    failReads = true;
    await store.readAskCards([DRAFT]);
    const failed = cardOf(thread());
    expect(failed.props['data-status']).toBe('failed');
    expect(text(failed)).toContain('Couldn\'t load this follow-up');
    failReads = false;
    click(elements(failed).find(node => node.type === 'button' && text(node) === 'Try again'));
    await flush();
    expect(cardOf(thread()).props['data-status']).toBe('loaded');
    card = null;
    await store.readAskCards([DRAFT]);
    expect(cardOf(thread()).props['data-status']).toBe('gone');
    expect(text(cardOf(thread()))).toBe('You no longer see this follow-up');
  });

  it('picks its owner, edits its line and date, then sends it on its own: it reads as sent, and Home is read again', async () => {
    const { store, thread } = await answered();
    await store.readAskCards([DRAFT]);
    store.toggleOwnerPicker(DRAFT);
    await flush();
    expect(store.getState().askCards.picker).toMatchObject({ item_id: DRAFT, results: [sam] });
    expect(byTestId(thread(), 'owner-picker')).toHaveLength(1);
    await store.pickFollowUpOwner({ membership_id: sam.membership_id, display_name: sam.display_name });
    await flush();
    expect(runs('assign')).toEqual([{ schema_version: 1, operation: 'assign', item_id: DRAFT, owner_membership_id: sam.membership_id }]);
    expect(text(byTestId(thread(), 'ask-follow-up-said'))).toBe('Owner changed to Sam');
    expect(text(byTestId(thread(), 'ask-follow-up-send'))).toBe('Send to Sam');

    // Only what changed is sent.
    expect(await store.editAskCard(DRAFT, { expected: '  Update the pricing page for the new tiers ', due_on: '2026-11-21' })).toBe(true);
    expect(await store.editAskCard(DRAFT, { expected: 'Update the pricing page for the new tiers', due_on: '2026-11-21' })).toBe(true);
    expect(runs('edit')).toEqual([{ schema_version: 1, operation: 'edit', item_id: DRAFT, expected: 'Update the pricing page for the new tiers', due_on: '2026-11-21' }]);
    expect(text(byTestId(thread(), 'ask-follow-up-title'))).toBe('Update the pricing page for the new tiers');
    expect(text(byTestId(thread(), 'ask-follow-up-line'))).toBe('From this chat · For Sam · Due Nov 21');
    expect(text(byTestId(thread(), 'ask-follow-up-said'))).toBe('Saved');

    const homes = runs('home').length;
    click(byTestId(thread(), 'ask-follow-up-send')[0]);
    await flush();
    const [send] = runs('send_item');
    expect(send).toMatchObject({ schema_version: 1, operation: 'send_item', item_id: DRAFT, include: true });
    expect(send).not.toHaveProperty('owner_membership_id');
    const shown = cardOf(thread());
    expect(shown.props['data-state']).toBe('open');
    expect(text(byTestId(shown, 'ask-follow-up-line'))).toBe('From this chat · Sent to Sam · Due Nov 21');
    expect(text(byTestId(shown, 'ask-follow-up-said'))).toBe('Sent to Sam');
    expect(byTestId(shown, 'ask-follow-up-send')).toEqual([]);
    expect(runs('home').length).toBeGreaterThan(homes);
  });

  it('replays a send whose outcome was unknown under the same command, and a new click after it went under a new one', async () => {
    const { store } = await answered();
    await store.readAskCards([DRAFT]);
    card = { ...card!, owner: { ...sam, name: sam.display_name, active: true, match: 'picked' } };
    await store.readAskCards([DRAFT]);
    refuse = fail('timeout', { retryable: true, mutation_outcome: 'unknown' });
    await store.sendAskCard(DRAFT, true);
    await flush();
    // Read again still not sent: it did not go, and says so.
    expect(store.getState().askCards.cards[DRAFT]!.said).toEqual({ words: 'Not sent. Try again.', error: true });
    refuse = null;
    await store.sendAskCard(DRAFT, true);
    await flush();
    const [first, again] = runs('send_item');
    expect(again!.command_id).toBe(first!.command_id);
    expect(store.getState().askCards.cards[DRAFT]!.item!.state).toBe('open');
  });

  it('dismisses it on its own, even with no owner', async () => {
    const { store, thread } = await answered();
    await store.readAskCards([DRAFT]);
    click(byTestId(thread(), 'ask-follow-up-dismiss')[0]);
    await flush();
    expect(runs('send_item')).toMatchObject([{ operation: 'send_item', item_id: DRAFT, include: false }]);
    const shown = cardOf(thread());
    expect(shown.props['data-state']).toBe('not_relevant');
    expect(text(byTestId(shown, 'ask-follow-up-line'))).toBe('From this chat · Dismissed');
    expect(text(byTestId(shown, 'ask-follow-up-said'))).toBe('Dismissed');
  });

  it('writes each draft\'s line into Copy answer, never one dismissed', async () => {
    const { store } = await answered();
    await store.readAskCards([DRAFT]);
    const id = store.getState().timeline.turns.at(-1)!.id;
    expect(await store.copyAnswer(id)).toBe(true);
    const copied = () => (rpc.mock.calls.filter(([name]) => name === 'clipboard.writeText').at(-1)![1] as { text: string }).text;
    expect(copied()).toContain('**Follow-ups**\n\n- Update the pricing page');
    await store.sendAskCard(DRAFT, false);
    await flush();
    await store.copyAnswer(id);
    expect(copied()).not.toContain('Follow-ups');
  });
});
