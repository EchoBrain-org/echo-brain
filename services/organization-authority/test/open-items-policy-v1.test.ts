import { expect, it } from 'vitest';
import { openItemAccessV1 } from '../src/composition/open-items-policy-v1.js';

const base = { viewer: 'mem_x', approver: 'mem_ari', owner: 'mem_mina', approver_active: true, owner_active: true, reads_decision: false, leads_decision_project: false };
it.each([
  ['approver reading the decision', { viewer: 'mem_ari', reads_decision: true }, { see_row: true, set_state: true, assign: true, waits_on: 'owner', waits_on_viewer: false }],
  ['owner who cannot read the decision', { viewer: 'mem_mina' }, { see_row: true, set_state: true, assign: true, waits_on: 'owner', waits_on_viewer: true }],
  ['project member reading the decision', { reads_decision: true }, { see_row: true, set_state: false, assign: false, waits_on_viewer: false }],
  ['project lead reading the decision', { reads_decision: true, leads_decision_project: true }, { see_row: true, set_state: false, assign: true }],
  ['stranger', {}, { see_row: false, see_outside: false, set_state: false, assign: false, waits_on_viewer: false }],
  ['approver after the owner left', { viewer: 'mem_ari', reads_decision: true, owner_active: false }, { waits_on: 'approver', waits_on_viewer: true }],
  ['lead after both left', { reads_decision: true, leads_decision_project: true, owner_active: false, approver_active: false }, { waits_on: 'leads', waits_on_viewer: true }],
  ['reader who cannot open the item', { reads_decision: true, opens_item: false }, { see_row: true, see_outside: false }],
  ['reader who opened the item', { reads_decision: true, opens_item: true }, { see_outside: true }],
  // Edges the rows above leave open: rights come only with the row, and outside words only with a live open.
  ['approver who can no longer read the decision', { viewer: 'mem_ari' }, { see_row: false, see_outside: false, set_state: false, assign: false, waits_on_viewer: false }],
  ['reader when no open was tried', { reads_decision: true }, { see_outside: false }],
  ['stranger who opened the item', { opens_item: true }, { see_row: false, see_outside: false }],
  ['reader who leads no project after both left', { reads_decision: true, owner_active: false, approver_active: false }, { waits_on: 'leads', waits_on_viewer: false }],
] as const)('%s', (_name, facts, expected) => {
  expect(openItemAccessV1({ ...base, ...facts })).toMatchObject(expected);
});
