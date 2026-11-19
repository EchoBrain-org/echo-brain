import { expect, it } from 'vitest';
import { openItemAccessV1, openItemDecisionAccessV1, openItemSendAccessV1 } from '../src/composition/open-items-policy-v1.js';

const base = { viewer: 'mem_x', approver: 'mem_ari', owner: 'mem_mina', approver_active: true, owner_active: true, sent_to_owner: false, state: 'open', reads_decision: false, leads_decision_project: false, from_chat: false } as const;
const table = [
  ['approver reading the decision', { viewer: 'mem_ari', reads_decision: true }, { see_row: true, set_state: true, assign: true, waits_on: 'owner', waits_on_viewer: false }],
  ['owner who cannot read the decision', { viewer: 'mem_mina', sent_to_owner: true }, { see_row: true, set_state: true, assign: true, waits_on: 'owner', waits_on_viewer: true }],
  ['owner of an unsent item who cannot read the decision', { viewer: 'mem_mina' }, { see_row: false, see_outside: false, set_state: false, assign: false, waits_on_viewer: false }],
  ['project member reading the decision', { reads_decision: true }, { see_row: true, set_state: false, assign: false, waits_on_viewer: false }],
  ['project lead reading the decision', { reads_decision: true, leads_decision_project: true }, { see_row: true, set_state: false, assign: true }],
  ['stranger', {}, { see_row: false, see_outside: false, set_state: false, assign: false, waits_on_viewer: false }],
  ['approver after the owner left', { viewer: 'mem_ari', reads_decision: true, owner_active: false }, { waits_on: 'approver', waits_on_viewer: true }],
  ['lead after both left', { reads_decision: true, leads_decision_project: true, owner_active: false, approver_active: false }, { waits_on: 'leads', waits_on_viewer: true }],
  ['reader who cannot open the item', { reads_decision: true, opens_item: false }, { see_row: true, see_outside: false }],
  ['reader who opened the item', { reads_decision: true, opens_item: true }, { see_outside: true }],
  // Edges the rows above leave open: rights come only with the row, Send opens the row to the owner alone, and outside words come only with a live open.
  ['approver who sent the item but can no longer read the decision, after the owner left', { viewer: 'mem_ari', owner_active: false, sent_to_owner: true }, { see_row: false, see_outside: false, set_state: false, assign: false, waits_on: 'approver', waits_on_viewer: false }],
  ['reader when no open was tried', { reads_decision: true }, { see_outside: false }],
  ['stranger who opened the item', { opens_item: true }, { see_row: false, see_outside: false }],
  ['reader who leads no project after both left', { reads_decision: true, owner_active: false, approver_active: false }, { waits_on: 'leads', waits_on_viewer: false }],
  ['stranger on an item sent to its owner', { sent_to_owner: true }, { see_row: false, see_outside: false, set_state: false, assign: false, waits_on_viewer: false }],
  ['project lead while the owner is active', { reads_decision: true, leads_decision_project: true }, { waits_on: 'owner', waits_on_viewer: false }],
  ['owner who cannot read the decision, after opening the item', { viewer: 'mem_mina', sent_to_owner: true, opens_item: true }, { see_row: true, see_outside: true }],
  // The stage (R16): an unsent item waits on its approver to send it, and nobody sets its state before Send; a closed one waits on no one.
  // Before Send its approver alone picks its owner (F2), exactly while they may send it.
  ['approver of an unsent item', { viewer: 'mem_ari', reads_decision: true, state: 'unsent' }, { see_row: true, set_state: false, assign: true, waits_on: 'approver', waits_on_viewer: true }],
  ['approver of an unsent item who can no longer read the decision', { viewer: 'mem_ari', state: 'unsent' }, { see_row: false, set_state: false, assign: false }],
  ['owner who reads the decision, on an unsent item', { viewer: 'mem_mina', reads_decision: true, state: 'unsent' }, { see_row: true, set_state: false, assign: false, waits_on: 'approver', waits_on_viewer: false }],
  ['lead on an unsent item after the approver left', { reads_decision: true, leads_decision_project: true, approver_active: false, state: 'unsent' }, { set_state: false, assign: false, waits_on: 'leads', waits_on_viewer: true }],
  ['approver after the owner left, on an unsent item', { viewer: 'mem_ari', reads_decision: true, owner_active: false, state: 'unsent' }, { waits_on: 'approver', waits_on_viewer: true }],
  ['owner of a done item who cannot read the decision', { viewer: 'mem_mina', sent_to_owner: true, state: 'done' }, { see_row: true, set_state: true, assign: true, waits_on: 'owner', waits_on_viewer: false }],
  ['approver of a not-relevant item', { viewer: 'mem_ari', reads_decision: true, state: 'not_relevant' }, { see_row: true, set_state: true, waits_on_viewer: false }],
  ['lead of a done item after both left', { reads_decision: true, leads_decision_project: true, owner_active: false, approver_active: false, state: 'done' }, { assign: true, waits_on: 'leads', waits_on_viewer: false }],
] as const;

it.each(table)('%s', (_name, facts, expected) => {
  expect(openItemAccessV1({ ...base, ...facts })).toMatchObject(expected);
});

// The decision part (title, first line, approval time, projects) goes to its readers only: an owner who cannot read it sees who sent the item instead.
it('shows the decision part exactly to those who read the decision', () => {
  for (const [name, facts] of table) {
    const all = { ...base, ...facts };
    expect(openItemAccessV1(all).see_decision, name).toBe(all.reads_decision);
  }
});

// A decision's stage and counts, and every row's decision part, are one decision made in one place.
it('decides who sees a decision once, for a record and for each of its rows', () => {
  expect(openItemDecisionAccessV1({ reads_decision: true })).toEqual({ see_decision: true });
  expect(openItemDecisionAccessV1({ reads_decision: false })).toEqual({ see_decision: false });
  for (const [name, facts] of table) {
    const all = { ...base, ...facts };
    expect(openItemAccessV1(all).see_decision, name).toBe(openItemDecisionAccessV1({ reads_decision: all.reads_decision }).see_decision);
  }
});

// A follow-up from a run is never edited or sent alone, whoever asks.
it('never lets anyone edit or send alone an item from a run', () => {
  for (const [name, facts] of table) expect(openItemAccessV1({ ...base, ...facts }), name).toMatchObject({ edit: false, send: false });
});

// A follow-up from a chat (ADR-0053): Ari created it, Mina owns it. Its creator always sees it; its owner once it reached them;
// nobody else ever does, a project lead or a decision reader included. It has no decision and no project.
const chat = { ...base, from_chat: true, reads_decision: false, leads_decision_project: false } as const;
const chatTable = [
  ['creator of an unsent follow-up', { viewer: 'mem_ari', state: 'unsent' },
    { see_row: true, see_decision: false, set_state: false, assign: true, edit: true, send: true, waits_on: 'approver', waits_on_viewer: true }],
  ['owner of an unsent follow-up', { viewer: 'mem_mina', state: 'unsent' },
    { see_row: false, see_outside: false, set_state: false, assign: false, edit: false, send: false, waits_on_viewer: false }],
  ['stranger on an unsent follow-up', { state: 'unsent' }, { see_row: false, set_state: false, assign: false, edit: false, send: false }],
  ['creator of a sent follow-up', { viewer: 'mem_ari', sent_to_owner: true },
    { see_row: true, set_state: true, assign: true, edit: true, send: false, waits_on: 'owner', waits_on_viewer: false }],
  ['owner of a sent follow-up', { viewer: 'mem_mina', sent_to_owner: true },
    { see_row: true, see_decision: false, set_state: true, assign: true, edit: false, send: false, waits_on: 'owner', waits_on_viewer: true }],
  ['stranger on a sent follow-up', { sent_to_owner: true }, { see_row: false, set_state: false, assign: false, edit: false, send: false, waits_on_viewer: false }],
  ['stranger who would read a decision and leads a project', { sent_to_owner: true, reads_decision: true, leads_decision_project: true },
    { see_row: false, see_decision: false, assign: false }],
  ['owner who opened the item it is about', { viewer: 'mem_mina', sent_to_owner: true, opens_item: true }, { see_row: true, see_outside: true }],
  ['creator of a done follow-up', { viewer: 'mem_ari', sent_to_owner: true, state: 'done' },
    { see_row: true, set_state: true, assign: true, edit: false, send: false, waits_on_viewer: false }],
  ['owner of a done follow-up', { viewer: 'mem_mina', sent_to_owner: true, state: 'done' }, { see_row: true, set_state: true, edit: false }],
  ['creator of a dismissed follow-up', { viewer: 'mem_ari', state: 'not_relevant' }, { see_row: true, set_state: false, assign: false, edit: false, send: false, waits_on_viewer: false }],
  ['owner of a dismissed follow-up', { viewer: 'mem_mina', state: 'not_relevant' }, { see_row: false, set_state: false, assign: false }],
  // A dismissed draft never reached its owner, whatever its state says later: it stays its creator's, and final.
  ['owner of a dismissed follow-up marked done', { viewer: 'mem_mina', state: 'done' }, { see_row: false, see_outside: false, set_state: false, assign: false, waits_on_viewer: false }],
  ['creator of a dismissed follow-up marked done', { viewer: 'mem_ari', state: 'done' }, { see_row: true, set_state: false, assign: false, edit: false, send: false }],
  ['creator of a dismissed follow-up reopened', { viewer: 'mem_ari', state: 'open' }, { see_row: true, set_state: false, assign: false, edit: false, send: false, waits_on_viewer: false }],
  ['creator after the owner left', { viewer: 'mem_ari', sent_to_owner: true, owner_active: false }, { waits_on: 'approver', waits_on_viewer: true }],
  ['anyone after both left', { sent_to_owner: true, owner_active: false, approver_active: false, leads_decision_project: true }, { see_row: false, waits_on: 'leads', waits_on_viewer: false }],
] as const;

it.each(chatTable)('follow-up from a chat: %s', (_name, facts, expected) => {
  expect(openItemAccessV1({ ...chat, ...facts })).toMatchObject(expected);
});

// Every role on a follow-up from a chat in every stage, in full: what each may see and do, and whom it waits on.
const STAGES = {
  unsent: { state: 'unsent', sent_to_owner: false },
  sent: { state: 'open', sent_to_owner: true },
  'sent, then done': { state: 'done', sent_to_owner: true },
  'sent, then not relevant': { state: 'not_relevant', sent_to_owner: true },
  dismissed: { state: 'not_relevant', sent_to_owner: false },
  'dismissed, then done': { state: 'done', sent_to_owner: false },
  'dismissed, then open': { state: 'open', sent_to_owner: false },
} as const;
const none = { see_row: false, see_decision: false, see_outside: false, set_state: false, assign: false, edit: false, send: false, waits_on_viewer: false } as const;
const creatorOnlySees = { ...none, see_row: true } as const;
const sentAndClosed = { ...none, see_row: true, set_state: true, assign: true } as const;
const chatMatrix: readonly (readonly [keyof typeof STAGES, 'creator' | 'owner' | 'stranger', Record<string, unknown>])[] = [
  ['unsent', 'creator', { ...none, see_row: true, assign: true, edit: true, send: true, waits_on: 'approver', waits_on_viewer: true }],
  ['unsent', 'owner', { ...none, waits_on: 'approver' }],
  ['unsent', 'stranger', { ...none, waits_on: 'approver' }],
  ['sent', 'creator', { ...none, see_row: true, set_state: true, assign: true, edit: true, waits_on: 'owner' }],
  ['sent', 'owner', { ...none, see_row: true, set_state: true, assign: true, waits_on: 'owner', waits_on_viewer: true }],
  ['sent', 'stranger', { ...none, waits_on: 'owner' }],
  ['sent, then done', 'creator', { ...sentAndClosed, waits_on: 'owner' }],
  ['sent, then done', 'owner', { ...sentAndClosed, waits_on: 'owner' }],
  ['sent, then done', 'stranger', { ...none, waits_on: 'owner' }],
  ['sent, then not relevant', 'creator', { ...sentAndClosed, waits_on: 'owner' }],
  ['sent, then not relevant', 'owner', { ...sentAndClosed, waits_on: 'owner' }],
  ['sent, then not relevant', 'stranger', { ...none, waits_on: 'owner' }],
  ['dismissed', 'creator', { ...creatorOnlySees, waits_on: 'owner' }],
  ['dismissed', 'owner', { ...none, waits_on: 'owner' }],
  ['dismissed', 'stranger', { ...none, waits_on: 'owner' }],
  ['dismissed, then done', 'creator', { ...creatorOnlySees, waits_on: 'owner' }],
  ['dismissed, then done', 'owner', { ...none, waits_on: 'owner' }],
  ['dismissed, then done', 'stranger', { ...none, waits_on: 'owner' }],
  ['dismissed, then open', 'creator', { ...creatorOnlySees, waits_on: 'owner' }],
  ['dismissed, then open', 'owner', { ...none, waits_on: 'owner' }],
  ['dismissed, then open', 'stranger', { ...none, waits_on: 'owner' }],
];
const VIEWERS = { creator: 'mem_ari', owner: 'mem_mina', stranger: 'mem_x' } as const;

it.each(chatMatrix)('follow-up from a chat, %s, as its %s', (stage, role, expected) => {
  const access = openItemAccessV1({ ...chat, ...STAGES[stage], viewer: VIEWERS[role] });
  expect(Object.fromEntries(Object.keys(expected).map(key => [key, access[key as keyof typeof access]]))).toEqual(expected);
  // A decision reader or a project lead is never told more about it than a stranger is.
  if (role === 'stranger') {
    expect(openItemAccessV1({ ...chat, ...STAGES[stage], viewer: VIEWERS[role], reads_decision: true, leads_decision_project: true, opens_item: true }))
      .toMatchObject({ see_row: false, see_decision: false, see_outside: false, set_state: false, assign: false, edit: false, send: false, waits_on_viewer: false });
  }
});

it('lets only a reading approver send', () => {
  expect(openItemSendAccessV1({ viewer: 'mem_ari', approver: 'mem_ari', reads_decision: true })).toEqual({ send: true });
  expect(openItemSendAccessV1({ viewer: 'mem_ari', approver: 'mem_ari', reads_decision: false })).toEqual({ send: false });
  expect(openItemSendAccessV1({ viewer: 'mem_mina', approver: 'mem_ari', reads_decision: true })).toEqual({ send: false });
});
