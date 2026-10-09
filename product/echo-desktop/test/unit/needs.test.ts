import { describe, expect, it } from 'vitest';
import type { OpenItemView } from '../../src/shared/protocol.js';
import {
  actionCount, impactWords, itemChange, itemFrom, itemKind, itemNames, itemParts, itemTitle, monthDay, nameList, needUpdating, projectWords, shortNames, titleLine,
} from '../../src/renderer/needs.js';

const person = { membership_id: 'mem_00000000-0000-4000-8000-000000000001', name: 'Mina Patel', active: true };
/** An item you opened carries what it says now; any other, why it does not (here, by default, that you can't open it). */
const item = (patch: Partial<OpenItemView> = {}): OpenItemView => ({
  item_id: 'itm_00000001', run_id: 'run_00000001', kind: 'ticket', relation: 'conflicts', expected: 'launch next week', approver: person,
  owner: { ...person, match: 'jira_account' }, waits_on: 'owner', state: 'open', created_at: '2026-10-07T10:05:00.000Z', sent_at: '2026-10-07T11:00:00.000Z',
  state_set_at: '2026-10-07T11:00:00.000Z', check: null, can: { set_state: true, assign: true }, reach: patch.current ? 'opened' : 'no_access', ...patch,
});
const ticket = { kind: 'ticket' as const, tool_id: 'jira', label: 'ECHO-12 · Pilot launch', permalink: 'https://example.atlassian.net/browse/ECHO-12' };
const summary = { unsent: 0, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 0, last_checked_at: null, by_decision: [] };

describe('the words Home and Tell the owners? use', () => {
  it('names people by first name, keeping an initial or a shared first name whole', () => {
    expect(shortNames(['Mina Patel', 'Rafael Moreno', 'S. Okafor'])).toEqual(['Mina', 'Rafael', 'S. Okafor']);
    expect(shortNames(['Mina Patel', 'Mina Lee', 'Ari'])).toEqual(['Mina Patel', 'Mina Lee', 'Ari']);
    expect([nameList(['Mina']), nameList(['Mina', 'Rafael']), nameList(['Mina', 'Rafael', 'S. Okafor'])])
      .toEqual(['Mina', 'Mina and Rafael', 'Mina, Rafael and S. Okafor']);
  });

  it('counts what a check found by its kind', () => {
    expect(needUpdating(2, ['ticket'])).toBe('2 tickets need updating');
    expect(needUpdating(1, ['ticket'])).toBe('1 ticket needs updating');
    expect(needUpdating(3, ['page'])).toBe('3 pages need updating');
    expect(needUpdating(2, ['ticket', 'page'])).toBe('2 items need updating');
    expect([actionCount(0), actionCount(1), actionCount(2)]).toEqual([null, '1 action', '2 actions']);
    expect(titleLine('Launch the pilot next week.')).toBe('Launch the pilot next week');
  });

  it('writes a date as the canvas does; a date with no time is that day wherever you are', () => {
    expect(monthDay('2026-10-30')).toBe('Oct 30');
    expect(monthDay('2026-10-06T12:00:00.000Z')).toBe('Oct 6');
    expect(monthDay('next week')).toBeNull();
  });

  it('shows an item as you can open it now, and only what the decision requires when you cannot', () => {
    const opened = item({ current: { source: ticket, says_now: 'Planned for the end of the month.', status: 'In Progress', due_at: '2026-10-30' } });
    expect(itemParts(opened)).toEqual({ title: 'ECHO-12 · Pilot launch', change: '· due Oct 30 → launch next week' });
    expect(itemChange(opened)).toBe('due Oct 30 → launch next week');
    expect(itemParts(item({ current: { source: ticket, says_now: 'Planned.', status: 'In Progress' } })).change).toBe('· In Progress → launch next week');
    expect(itemParts(item({ kind: 'page', current: { source: { ...ticket, kind: 'page', tool_id: 'confluence' }, says_now: 'starts after freeze' } })).change)
      .toBe('· says "starts after freeze" → launch next week');
    expect(itemParts(item())).toEqual({ title: 'A Jira ticket you can\'t open', change: '→ launch next week' });
    expect(itemParts(item({ expected: null }))).toEqual({ title: 'A Jira ticket you can\'t open', change: '' });
    expect(itemKind(item())).toBe('Jira ticket');
    expect(itemKind(item({ kind: 'page' }))).toBe('Page');
    expect(itemKind(item({ kind: 'page', current: { source: { ...ticket, kind: 'page', tool_id: 'confluence' }, says_now: 'x' } }))).toBe('Confluence page');
    // A decision you cannot read is never named: who sent it is.
    expect(itemFrom(item())).toBe('Mina Patel');
    expect(itemFrom(item({ decision: { approval_id: 'apr_1', record_sha256: 'sha256:1', title: 'Pilot planning', first_line: null, approved_at: '2026-10-07T10:00:00.000Z', project_ids: [] } })))
      .toBe('Pilot planning');
  });

  it('names an item by how its live read went: opened, refused, an outage, or not read', () => {
    expect(itemTitle(item({ current: { source: ticket, says_now: 'Planned.' } }))).toBe('ECHO-12 · Pilot launch');
    expect(itemTitle(item({ reach: 'no_access' }))).toBe('A Jira ticket you can\'t open');
    // An outage or a rate limit is not lost access.
    expect(itemTitle(item({ reach: 'unavailable' }))).toBe('A Jira ticket ECHO couldn\'t read just now');
    expect(itemTitle(item({ reach: 'not_read' }))).toBe('A Jira ticket');
    expect([itemTitle(item({ kind: 'page' })), itemTitle(item({ kind: 'page', reach: 'unavailable' })), itemTitle(item({ kind: 'page', reach: 'not_read' }))])
      .toEqual(['A page you can\'t open', 'A page ECHO couldn\'t read just now', 'A page']);
    expect([itemTitle(item({ kind: 'slack_message' })), itemTitle(item({ kind: 'slack_message', reach: 'unavailable' })), itemTitle(item({ kind: 'slack_message', reach: 'not_read' }))])
      .toEqual(['A Slack message you can\'t open', 'A Slack message ECHO couldn\'t read just now', 'A Slack message']);
    expect(itemParts(item({ reach: 'unavailable' }))).toEqual({ title: 'A Jira ticket ECHO couldn\'t read just now', change: '→ launch next week' });
  });

  it('tells two items that would share a name apart by what the decision requires of each', () => {
    const names = itemNames([
      item({ item_id: 'itm_00000001', expected: 'confirm the trace by Friday' }), item({ item_id: 'itm_00000002', expected: 'order six weeks ahead' }),
      item({ item_id: 'itm_00000003', reach: 'unavailable' }), item({ item_id: 'itm_00000004', current: { source: ticket, says_now: 'Planned.' } }),
    ]);
    expect(Object.fromEntries(names)).toEqual({
      itm_00000001: 'A Jira ticket you can\'t open → confirm the trace by Friday', itm_00000002: 'A Jira ticket you can\'t open → order six weeks ahead',
      itm_00000003: 'A Jira ticket ECHO couldn\'t read just now', itm_00000004: 'ECHO-12 · Pilot launch',
    });
    // One such item keeps its plain name.
    expect(itemNames([item()]).get('itm_00000001')).toBe('A Jira ticket you can\'t open');
  });

  it('says what a decision changed, and what a project has open', () => {
    const run = { record_sha256: 'sha256:1', run_id: 'run_00000001' };
    expect(impactWords({ ...summary, open: 2, unsent: 1 }, { ...run, state: 'done', error_code: null })).toBe('2 open · 1 not sent');
    expect(impactWords({ ...summary, unsent: 2 }, { ...run, state: 'done', error_code: null })).toBe('2 not sent');
    expect(impactWords(summary, null)).toBe('Not checked yet');
    expect(impactWords(summary, { ...run, state: 'pending', error_code: null })).toBe('Not checked yet');
    expect(impactWords(summary, { ...run, state: 'running', error_code: null })).toBe('Checking…');
    expect(impactWords(summary, { ...run, state: 'failed', error_code: 'research_failed' })).toBe('Check failed');
    expect(impactWords(summary, { ...run, state: 'done', error_code: null })).toBe('Nothing to change');
    expect(projectWords(summary)).toBeNull();
    expect(projectWords({ ...summary, unsent: 2, open: 2, by_decision: [{ record_sha256: 'sha256:1', unsent: 2, open: 0 }, { record_sha256: 'sha256:2', unsent: 0, open: 2 },
      { record_sha256: 'sha256:3', unsent: 0, open: 0 }] })).toEqual({ count: '4 open items', from: 'from 2 decisions' });
    expect(projectWords({ ...summary, open: 1, by_decision: [{ record_sha256: 'sha256:1', unsent: 0, open: 1 }] })).toEqual({ count: '1 open item', from: 'from 1 decision' });
  });
});
