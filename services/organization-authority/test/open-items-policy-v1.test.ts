import { expect, it } from 'vitest';
import { openItemAccessV1, openItemSendAccessV1 } from '../src/composition/open-items-policy-v1.js';

const base = { viewer: 'mem_x', approver: 'mem_ari', owner: 'mem_mina', approver_active: true, owner_active: true, sent_to_owner: false, state: 'open', reads_decision: false, leads_decision_project: false } as const;
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
  // The stage (R16): an unsent item waits on its approver to send it and nobody changes it before Send; a closed one waits on no one.
  ['approver of an unsent item', { viewer: 'mem_ari', reads_decision: true, state: 'unsent' }, { see_row: true, set_state: false, assign: false, waits_on: 'approver', waits_on_viewer: true }],
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

it('lets only a reading approver send', () => {
  expect(openItemSendAccessV1({ viewer: 'mem_ari', approver: 'mem_ari', reads_decision: true })).toEqual({ send: true });
  expect(openItemSendAccessV1({ viewer: 'mem_ari', approver: 'mem_ari', reads_decision: false })).toEqual({ send: false });
  expect(openItemSendAccessV1({ viewer: 'mem_mina', approver: 'mem_ari', reads_decision: true })).toEqual({ send: false });
});
