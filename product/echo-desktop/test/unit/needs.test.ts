import { describe, expect, it } from 'vitest';
import type { OpenItemView } from '../../src/shared/protocol.js';
import {
  actionCount, checkedAgo, footerWords, impactWords, itemChange, itemCount, itemFrom, itemKind, itemNames, itemParts, itemTitle, landedGroups, landedNote, markable,
  monthDay, nameList, needUpdating, projectWords, shortNames, titleLine,
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
    const run = { record_sha256: 'sha256:1', run_id: 'run_00000001', mine: true };
    expect(impactWords({ ...summary, open: 2, unsent: 1 }, { ...run, state: 'done', error_code: null })).toBe('2 open · 1 not sent');
    expect(impactWords({ ...summary, unsent: 2 }, { ...run, state: 'done', error_code: null })).toBe('2 not sent');
    expect(impactWords(summary, null)).toBe('Not checked yet');
    expect(impactWords(summary, { ...run, state: 'pending', error_code: null })).toBe('Not checked yet');
    expect(impactWords(summary, { ...run, state: 'running', error_code: null })).toBe('Checking…');
    expect(impactWords(summary, { ...run, state: 'failed', error_code: 'research_failed' })).toBe('Check failed');
    expect(impactWords(summary, { ...run, state: 'done', error_code: null })).toBe('Nothing to change');
    expect(projectWords(summary)).toBeNull();
    expect(projectWords({ ...summary, unsent: 2, open: 2, by_decision: [{ record_sha256: 'sha256:1', unsent: 2, open: 0 }, { record_sha256: 'sha256:2', unsent: 0, open: 2 },
      { record_sha256: 'sha256:3', unsent: 0, open: 0 }] })).toEqual({ count: '4 open items', from: 'from 2 decisions', checked: null });
    expect(projectWords({ ...summary, open: 1, by_decision: [{ record_sha256: 'sha256:1', unsent: 0, open: 1 }] }))
      .toEqual({ count: '1 open item', from: 'from 1 decision', checked: null });
  });
});

describe('what ECHO saw when it checked again', () => {
  const now = Date.parse('2026-10-08T15:00:00.000Z');
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const checked = (verdict: NonNullable<OpenItemView['check']>['verdict']) => ({ verdict, checked_at: ago(120), checked_by: 'Mina Patel' });
  const opened = { source: ticket, says_now: 'Planned for the end of the month.', due_at: '2026-10-30' };

  it('says when a check ran as the canvas does', () => {
    expect([checkedAgo(ago(0), now), checkedAgo(ago(0.5), now), checkedAgo(new Date(now + 30_000).toISOString(), now)]).toEqual(['just now', 'just now', 'just now']);
    expect([checkedAgo(ago(1), now), checkedAgo(ago(59), now)]).toEqual(['1 min ago', '59 min ago']);
    expect([checkedAgo(ago(60), now), checkedAgo(ago(120), now), checkedAgo(ago(359), now)]).toEqual(['1 h ago', '2 h ago', '5 h ago']);
    // Six hours or more: the day, in this computer's time zone.
    const local = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();
    expect(checkedAgo(new Date(local(8, 9)).toISOString(), local(8, 18))).toBe('today');
    expect(checkedAgo(new Date(local(7, 9)).toISOString(), local(8, 18))).toBe('yesterday');
    expect(checkedAgo(new Date(local(6, 9)).toISOString(), local(8, 18))).toBe('Oct 6');
    expect([itemCount(1), itemCount(3)]).toEqual(['1 item', '3 items']);
  });

  it('sums up Home\'s own items under the rows, leaving out what is zero', () => {
    expect(footerWords({ landed: 2, waiting: 1, last_checked_at: ago(120) }, now)).toBe('2 landed since yesterday · 1 with others · checked 2 h ago');
    expect(footerWords({ landed: 0, waiting: 1, last_checked_at: ago(120) }, now)).toBe('1 with others · checked 2 h ago');
    expect(footerWords({ landed: 1, waiting: 0, last_checked_at: null }, now)).toBe('1 landed since yesterday');
    expect(footerWords({ landed: 0, waiting: 2, last_checked_at: null }, now)).toBe('2 with others');
    expect(footerWords({ landed: 0, waiting: 0, last_checked_at: null }, now)).toBeNull();
  });

  it('adds up a decision\'s sent items on its Impact line', () => {
    const done = { record_sha256: 'sha256:1', run_id: 'run_00000001', mine: true, state: 'done' as const, error_code: null };
    // Canvas 9.6: three items, one still open, one landed, one ECHO could not read.
    expect(impactWords({ ...summary, open: 3, landed: 1, unreadable: 1, last_checked_at: ago(0) }, done, now)).toBe('1 open · 1 handled · 1 couldn\'t read · checked just now');
    // Handled: closed by a click, or landed and not closed yet.
    expect(impactWords({ ...summary, open: 1, landed: 1, done: 1, not_relevant: 1, last_checked_at: ago(120) }, done, now)).toBe('3 handled · checked 2 h ago');
    expect(impactWords({ ...summary, open: 2, unsent: 1, changed: 1, last_checked_at: ago(120) }, done, now)).toBe('2 open · 1 not sent · checked 2 h ago');
    expect(impactWords({ ...summary, open: 1, unreadable: 1 }, done, now)).toBe('1 couldn\'t read');
  });

  it('says when a project\'s items were last checked', () => {
    expect(projectWords({ ...summary, open: 4, last_checked_at: ago(120), by_decision: [{ record_sha256: 'sha256:1', unsent: 0, open: 4 }] }, now))
      .toEqual({ count: '4 open items', from: 'from 1 decision', checked: 'checked 2 h ago' });
  });

  it('groups a scope\'s open items by their last check for Did it land?', () => {
    const landed = item({ item_id: 'itm_00000001', current: opened, check: checked('landed') });
    const still = item({ item_id: 'itm_00000002', current: opened, check: checked('still_open') });
    const changed = item({ item_id: 'itm_00000003', check: checked('changed') });
    const unchecked = item({ item_id: 'itm_00000004', current: opened });
    const refused = item({ item_id: 'itm_00000005', check: checked('unreadable') });
    const outage = item({ item_id: 'itm_00000006', reach: 'unavailable', check: checked('unreadable') });
    const closed = item({ item_id: 'itm_00000007', state: 'done', check: checked('landed') });
    const groups = landedGroups([landed, still, changed, unchecked, refused, outage, closed]);
    expect([groups.landed, groups.open, groups.unreadable].map(group => group.map(entry => entry.item_id)))
      .toEqual([['itm_00000001'], ['itm_00000002', 'itm_00000003', 'itm_00000004'], ['itm_00000005', 'itm_00000006']]);
    expect([landed, still, changed, unchecked, refused, outage].map(landedNote)).toEqual([
      '· due Oct 30', '· due Oct 30', '— not what was decided', '· due Oct 30 · not checked yet', '· you don\'t have access', '· ECHO could not read it',
    ]);
  });

  it('marks done only the ticked landed items you may close', () => {
    const landed = (id: string, set_state = true) => item({ item_id: id, check: checked('landed'), can: { set_state, assign: true } });
    const items = [landed('itm_00000001'), landed('itm_00000002'), landed('itm_00000003', false), item({ item_id: 'itm_00000004', check: checked('changed') })];
    expect(markable(items, {}).map(entry => entry.item_id)).toEqual(['itm_00000001', 'itm_00000002']);
    expect(markable(items, { itm_00000002: true }).map(entry => entry.item_id)).toEqual(['itm_00000001']);
  });

  it('names one decision\'s alike items by position, and a line never says twice what the decision requires', () => {
    const decision = { approval_id: 'apr_1', record_sha256: 'sha256:1', title: 'Pilot planning', first_line: null, approved_at: '2026-10-07T10:00:00.000Z', project_ids: [] };
    // Tell the owners?: one run's items, all of one decision, so the decision tells none apart.
    const items = [
      item({ item_id: 'itm_00000001', kind: 'page', expected: 'parts ordered for next week', decision }),
      item({ item_id: 'itm_00000002', kind: 'page', expected: 'parts ordered for next week', decision }),
      item({ item_id: 'itm_00000003', reach: 'unavailable', expected: null, decision }), item({ item_id: 'itm_00000004', reach: 'unavailable', expected: null, decision }),
    ];
    const names = itemNames(items);
    expect(Object.fromEntries(names)).toEqual({
      itm_00000001: 'A page you can\'t open → parts ordered for next week (1)', itm_00000002: 'A page you can\'t open → parts ordered for next week (2)',
      itm_00000003: 'A Jira ticket ECHO couldn\'t read just now (1)', itm_00000004: 'A Jira ticket ECHO couldn\'t read just now (2)',
    });
    expect(itemParts(items[0]!, names.get('itm_00000001'))).toEqual({ title: 'A page you can\'t open → parts ordered for next week (1)', change: '' });
    expect(itemParts(items[2]!, names.get('itm_00000003'))).toEqual({ title: 'A Jira ticket ECHO couldn\'t read just now (1)', change: '' });
    // An item you opened keeps what it says now.
    const opened = item({ current: { source: ticket, says_now: 'Planned.', due_at: '2026-10-30' } });
    expect(itemParts(opened, 'ECHO-12 · Pilot launch → launch next week')).toEqual({ title: 'ECHO-12 · Pilot launch → launch next week', change: '· due Oct 30' });
  });

  it('keeps names apart when what the decision requires does not', () => {
    const decision = (title: string) => ({ approval_id: 'apr_1', record_sha256: 'sha256:1', title, first_line: null, approved_at: '2026-10-07T10:00:00.000Z', project_ids: [] });
    const names = itemNames([
      item({ item_id: 'itm_00000001', expected: null, decision: decision('Pilot planning') }), item({ item_id: 'itm_00000002', expected: null, decision: decision('Kickoff review') }),
      item({ item_id: 'itm_00000003', expected: 'order six weeks ahead' }), item({ item_id: 'itm_00000004', expected: 'order six weeks ahead' }),
    ]);
    expect(Object.fromEntries(names)).toEqual({
      itm_00000001: 'A Jira ticket you can\'t open · from Pilot planning', itm_00000002: 'A Jira ticket you can\'t open · from Kickoff review',
      // No decision you can read: where each is among those alike.
      itm_00000003: 'A Jira ticket you can\'t open → order six weeks ahead (1)', itm_00000004: 'A Jira ticket you can\'t open → order six weeks ahead (2)',
    });
  });
});
