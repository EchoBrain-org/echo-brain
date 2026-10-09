import { describe, expect, it } from 'vitest';
import type { OpenItemView } from '../../src/shared/protocol.js';
import {
  actionCount, approvedMeeting, byStatus, checkedAgo, checkLine, closable, homeFooter, impactWords, itemChange, itemHeadline, itemKind, itemLabels, itemNames, itemNeeds, itemNow, itemParts,
  itemTitle, itemWhose, itemWhy, meetingSuffix, monthDay, nameList, needUpdating, openCount, projectWords, shortNames, STATUS, statusGroups, statusOf, statusSubline, titleLine, whereFrom,
} from '../../src/renderer/needs.js';

const person = { membership_id: 'mem_00000000-0000-4000-8000-000000000001', name: 'Mina Patel', active: true };
/** An item you opened carries what it says now; any other, why it does not (here, by default, that you can't open it). */
const item = (patch: Partial<OpenItemView> = {}): OpenItemView => ({
  item_id: 'itm_00000001', run_id: 'run_00000001', kind: 'ticket', relation: 'conflicts', expected: 'launch next week', approver: person,
  owner: { ...person, match: 'jira_account' }, waits_on: 'owner', state: 'open', created_at: '2026-10-07T10:05:00.000Z', sent_at: '2026-10-07T11:00:00.000Z',
  state_set_at: '2026-10-07T11:00:00.000Z', check: null, can: { set_state: true, assign: true }, reach: patch.current ? 'opened' : 'no_access', ...patch,
});
const ticket = { kind: 'ticket' as const, tool_id: 'jira', label: 'ECHO-12 · Pilot launch', permalink: 'https://example.atlassian.net/browse/ECHO-12' };
const OKAFOR = { membership_id: 'mem_00000000-0000-4000-8000-000000000003', name: 'S. Okafor', active: true };
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
    // A decision you cannot read is never named: who sent it is, by first name.
    expect(whereFrom(item())).toBe('sent by Mina');
    // Every decision an open item comes from is an approved meeting, named as the Approve row names one.
    expect(whereFrom(item({ decision: { approval_id: 'apr_1', record_sha256: 'sha256:1', title: 'Pilot planning', first_line: null, approved_at: '2026-10-06T12:00:00.000Z', project_ids: [] } })))
      .toBe('Pilot planning meeting, approved Oct 6');
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
    const counted = { landed: 0, unreadable: 0 };
    expect(projectWords({ ...summary, unsent: 2, open: 2, by_decision: [{ record_sha256: 'sha256:1', unsent: 2, open: 0, ...counted },
      { record_sha256: 'sha256:2', unsent: 0, open: 2, ...counted }, { record_sha256: 'sha256:3', unsent: 0, open: 0, ...counted }] }))
      .toEqual({ count: '4 open items', from: 'from 2 decisions', checked: null });
    expect(projectWords({ ...summary, open: 1, by_decision: [{ record_sha256: 'sha256:1', unsent: 0, open: 1, ...counted }] }))
      .toEqual({ count: '1 open item', from: 'from 1 decision', checked: null });
  });

  it('counts a decision\'s open items on its row as its Impact line does, and the project line as the sum of its rows', () => {
    // Canvas 9.7: Pilot planning's three sent items are one still open, one landed and one ECHO could not read; Kickoff review's three are open.
    const pilot = { record_sha256: 'sha256:1', unsent: 0, open: 3, landed: 1, unreadable: 1 };
    const kickoff = { record_sha256: 'sha256:2', unsent: 0, open: 3, landed: 0, unreadable: 0 };
    expect([openCount(pilot), openCount(kickoff)]).toEqual([1, 3]);
    expect(projectWords({ ...summary, open: 6, landed: 1, unreadable: 1, by_decision: [pilot, kickoff] }))
      .toEqual({ count: '4 open items', from: 'from 2 decisions', checked: null });
    // Items not sent yet are open too.
    expect(openCount({ ...pilot, unsent: 2 })).toBe(3);
    // A decision whose open items all landed or went unread has none open: its row and the line leave it out.
    const handled = { ...pilot, open: 2 };
    expect(openCount(handled)).toBe(0);
    expect(projectWords({ ...summary, open: 5, landed: 1, unreadable: 1, by_decision: [handled, kickoff] }))
      .toEqual({ count: '3 open items', from: 'from 1 decision', checked: null });
    // R72: everything left matched or could not be read; the line stays, counting what is not closed (Part 1's words).
    expect(projectWords({ ...summary, open: 2, landed: 1, unreadable: 1, by_decision: [handled] })).toEqual({ count: '2 open items', from: 'from 1 decision', checked: null });
    expect(projectWords({ ...summary, unsent: 1, open: 1, landed: 1, by_decision: [{ ...handled, unsent: 1, open: 1, unreadable: 0 }] }))
      .toEqual({ count: '1 open item', from: 'from 1 decision', checked: null });
    // Nothing unsent or open: no line.
    expect(projectWords({ ...summary, done: 3, by_decision: [{ ...pilot, open: 0, landed: 0, unreadable: 0 }] })).toBeNull();
  });

  it('takes the project line\'s total from the scope\'s summary, not from its 100 newest decisions', () => {
    // The Authority lists at most 100 decisions; the summary counts the whole project.
    const listed = Array.from({ length: 100 }, (_, index) => ({ record_sha256: `sha256:${index}`, unsent: 0, open: 1, landed: 0, unreadable: 0 }));
    expect(projectWords({ ...summary, unsent: 20, open: 140, landed: 5, unreadable: 5, decisions: 160, by_decision: listed }))
      .toEqual({ count: '150 open items', from: 'from 100 decisions', checked: null });
    // An open decision past the listed ones still counts in the total; "from" counts the listed ones.
    expect(projectWords({ ...summary, open: 1, decisions: 101, by_decision: [{ record_sha256: 'sha256:1', unsent: 0, open: 0, landed: 0, unreadable: 0 }] }))
      .toEqual({ count: '1 open item', from: '', checked: null });
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
  });

  it('sums up Home\'s own items under the rows, leaving out what is zero (R69)', () => {
    expect(homeFooter({ landed: 2, waiting: 1, last_checked_at: ago(120) }, now)).toBe('2 match their decision now · 1 waiting on others · ECHO checked 2 h ago');
    expect(homeFooter({ landed: 0, waiting: 1, last_checked_at: ago(120) }, now)).toBe('1 waiting on others · ECHO checked 2 h ago');
    expect(homeFooter({ landed: 1, waiting: 0, last_checked_at: null }, now)).toBe('1 matches its decision now');
    expect(homeFooter({ landed: 0, waiting: 2, last_checked_at: null }, now)).toBe('2 waiting on others');
    expect(homeFooter({ landed: 0, waiting: 0, last_checked_at: ago(120) }, now)).toBe('ECHO checked 2 h ago');
    expect(homeFooter({ landed: 0, waiting: 0, last_checked_at: null }, now)).toBeNull();
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
    expect(projectWords({ ...summary, open: 4, last_checked_at: ago(120), by_decision: [{ record_sha256: 'sha256:1', unsent: 0, open: 4, landed: 0, unreadable: 0 }] }, now))
      .toEqual({ count: '4 open items', from: 'from 1 decision', checked: 'checked 2 h ago' });
  });

  it('says what each open item\'s last check found, as a status (R68)', () => {
    const landed = item({ item_id: 'itm_00000001', current: opened, check: checked('landed') });
    const still = item({ item_id: 'itm_00000002', current: opened, check: checked('still_open') });
    const changed = item({ item_id: 'itm_00000003', check: checked('changed') });
    const unchecked = item({ item_id: 'itm_00000004', current: opened });
    const refused = item({ item_id: 'itm_00000005', check: checked('unreadable') });
    const outage = item({ item_id: 'itm_00000006', reach: 'unavailable', check: checked('unreadable') });
    const closed = item({ item_id: 'itm_00000007', state: 'done', check: checked('landed') });
    expect([landed, still, changed, refused, unchecked].map(entry => STATUS[statusOf(entry)]))
      .toEqual(['Matches now', 'Not updated yet', 'Changed, still doesn\'t match', 'ECHO couldn\'t read it', 'Not checked yet']);
    // Matches first, then not updated or changed, then couldn't read or not checked; each part keeps its order; closed items are left out.
    expect(byStatus([unchecked, refused, changed, landed, closed, still, outage]).map(entry => entry.item_id))
      .toEqual(['itm_00000001', 'itm_00000003', 'itm_00000002', 'itm_00000004', 'itm_00000005', 'itm_00000006']);
    // No status says "landed".
    for (const words of Object.values(STATUS)) expect(words.toLowerCase()).not.toContain('land');
  });

  it('closes only the matching items you may close', () => {
    const landed = (id: string, set_state = true) => item({ item_id: id, check: checked('landed'), can: { set_state, assign: true } });
    const items = [landed('itm_00000001'), landed('itm_00000002'), landed('itm_00000003', false), item({ item_id: 'itm_00000004', check: checked('changed') }),
      { ...landed('itm_00000005'), state: 'done' as const }];
    expect(closable(items).map(entry => entry.item_id)).toEqual(['itm_00000001', 'itm_00000002']);
  });

  it('heads Your open items with how many are open and when ECHO checked', () => {
    expect(statusSubline(3, ago(120), now)).toBe('3 open · ECHO checked 2 h ago');
    expect(statusSubline(1, null, now)).toBe('1 open');
    // Before any read succeeded there is no count to give (D7).
    expect(statusSubline(null, null, now)).toBeNull();
  });

  it('groups your own items by decision only when they come from more than one', () => {
    const decision = (title: string, record: string) => ({ approval_id: 'apr_1', record_sha256: record, title, first_line: null, approved_at: '2026-10-06T12:00:00.000Z', project_ids: [] });
    const pilot = decision('Pilot planning', 'sha256:1');
    const kickoff = decision('Kickoff review', 'sha256:2');
    const items = [
      item({ item_id: 'itm_00000001', decision: pilot }), item({ item_id: 'itm_00000002', decision: kickoff, check: checked('landed') }),
      item({ item_id: 'itm_00000003' }), item({ item_id: 'itm_00000004', decision: pilot, check: checked('landed') }),
    ];
    // Your own items from two decisions and one you cannot read: a small header each, its items by status.
    expect(statusGroups(items, 'mine').map(group => ({ header: group.header, items: group.items.map(entry => entry.item_id) }))).toEqual([
      { header: 'Pilot planning meeting, approved Oct 6', items: ['itm_00000004', 'itm_00000001'] },
      { header: 'Kickoff review meeting, approved Oct 6', items: ['itm_00000002'] },
      { header: 'Sent by Mina Patel', items: ['itm_00000003'] },
    ]);
    // One decision, or a decision's or a project's items: one list, no header.
    expect(statusGroups([items[0]!, items[3]!], 'mine').map(group => group.header)).toEqual([null]);
    expect(statusGroups(items, 'project').map(group => ({ header: group.header, items: group.items.map(entry => entry.item_id) })))
      .toEqual([{ header: null, items: ['itm_00000002', 'itm_00000004', 'itm_00000001', 'itm_00000003'] }]);
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

describe('Home item rows and the item card (R63–R67)', () => {
  const now = Date.parse('2026-10-08T15:00:00.000Z');
  const ari = { membership_id: 'mem_00000000-0000-4000-8000-000000000002', name: 'Ari', active: true };
  const mina = { membership_id: 'mem_00000000-0000-4000-8000-000000000001', name: 'Mina Patel', active: true };
  const pilot = { approval_id: 'apr_1', record_sha256: 'sha256:1', title: 'Pilot planning', first_line: 'Launch the pilot next week.', approved_at: '2026-10-06T12:00:00.000Z', project_ids: [] };
  const page = { kind: 'page' as const, tool_id: 'confluence', label: 'Thermostat PRD · Pilot scope', permalink: 'https://example.atlassian.net/wiki/pages/12345' };
  const changed = { verdict: 'changed' as const, checked_at: new Date(now - 2 * 3_600_000).toISOString(), checked_by: 'Mina Patel' };
  /** Ari's own page, from Ari's own decision: the founder's example. */
  const own = item({ kind: 'page', relation: 'needs_updating', expected: 'pilot starts next week', approver: ari, owner: { ...ari, match: 'approver' }, decision: pilot,
    current: { source: page, says_now: 'starts after freeze' }, check: changed });
  /** ECHO-12, sent by Ari to Mina. */
  const theirs = item({ approver: ari, owner: { ...mina, match: 'jira_account' }, decision: pilot, current: { source: ticket, says_now: 'Planned.', assignee: 'Mina Patel', due_at: '2026-10-30' },
    check: changed });

  it('titles a row by whether the item matches the decision', () => {
    expect(itemHeadline(own, 'Thermostat PRD · Pilot scope')).toBe('Thermostat PRD · Pilot scope doesn\'t match the decision yet');
    expect(itemHeadline(item({ relation: 'conflicts' }), 'ECHO-12 · Pilot launch')).toBe('ECHO-12 · Pilot launch doesn\'t match the decision yet');
    // Not assessed: no relation, no expected phrase.
    expect(itemHeadline(item({ relation: null, expected: null }), 'A Jira ticket')).toBe('A Jira ticket may need updating');
  });

  it('says what the item says now and what the decision needs, leaving out what is missing', () => {
    expect(itemNeeds(own)).toBe('Says "starts after freeze" → decision needs: pilot starts next week');
    expect(itemNeeds(theirs)).toBe('Due Oct 30 → decision needs: launch next week');
    // No live details unless the item was opened.
    expect(itemNeeds(item())).toBe('Decision needs: launch next week');
    expect(itemNeeds(item({ reach: 'unavailable' }))).toBe('Decision needs: launch next week');
    expect(itemNeeds({ ...own, expected: null })).toBe('Says "starts after freeze"');
    expect(itemNeeds(item({ expected: null }))).toBeNull();
  });

  it('says what an item is, where it came from and why it is back (the founder\'s example)', () => {
    expect(itemWhy(own, ari.membership_id, null)).toBe('Confluence page · Pilot planning meeting, approved Oct 6 · changed since you got it, still doesn\'t match');
    // Review: the approver looks at someone else's item.
    expect(itemWhy(theirs, ari.membership_id, null)).toBe('Jira ticket · Pilot planning meeting, approved Oct 6 · Mina\'s to update · changed since you sent it');
    // The owner's item before any change: what it is and where it came from.
    expect(itemWhy({ ...own, check: null }, ari.membership_id, null)).toBe('Confluence page · Pilot planning meeting, approved Oct 6');
    // A decision the owner cannot read: who sent it, by first name.
    expect(itemWhy(item({ approver: mina, owner: { ...ari, match: 'picked' } }), ari.membership_id, null)).toBe('Jira ticket · sent by Mina');
    // An item that fell back to you (its owner left) is still named as its owner's, never "you own".
    const left = item({ approver: ari, owner: { ...mina, active: false, match: 'jira_account' }, decision: pilot, waits_on: 'approver' });
    expect(itemWhy(left, ari.membership_id, null)).toBe('Jira ticket · Pilot planning meeting, approved Oct 6 · Mina\'s to update');
    // A project lead the item fell back to did not send it.
    expect(itemWhy(theirs, 'mem_00000000-0000-4000-8000-000000000009', null))
      .toBe('Jira ticket · Pilot planning meeting, approved Oct 6 · Mina\'s to update · changed since it was sent');
  });

  it('never writes "meeting" after a title that already ends with it (R76)', () => {
    const at = '2026-10-06T12:00:00.000Z';
    expect(approvedMeeting({ title: 'Pilot planning', approved_at: at })).toBe('Pilot planning meeting, approved Oct 6');
    expect(approvedMeeting({ title: 'Approved meeting', approved_at: at })).toBe('Approved meeting, approved Oct 6');
    expect(approvedMeeting({ title: 'Weekly sync MEETING', approved_at: at }, ' · ')).toBe('Weekly sync MEETING · approved Oct 6');
    expect([meetingSuffix('Pilot planning'), meetingSuffix('Approved meeting'), meetingSuffix('Team Meeting')]).toEqual([' meeting', '', '']);
    // Home rows and Your open items' headers take the same words.
    const untitled = { ...pilot, title: 'Approved meeting' };
    expect(itemWhy({ ...own, decision: untitled }, ari.membership_id, null)).toContain('Confluence page · Approved meeting, approved Oct 6');
    expect(statusGroups([{ ...own, decision: untitled }, item({ item_id: 'itm_00000009' })], 'mine').map(group => group.header))
      .toEqual(['Approved meeting, approved Oct 6', 'Sent by Mina Patel']);
  });

  it('labels alike items by position only where nothing else on the row tells them apart', () => {
    const alike = [
      item({ item_id: 'itm_00000001', expected: 'parts ordered for next week', decision: pilot }), item({ item_id: 'itm_00000002', expected: 'parts ordered for next week', decision: pilot }),
      item({ item_id: 'itm_00000003', expected: 'order six weeks ahead' }), item({ item_id: 'itm_00000004', current: { source: ticket, says_now: 'Planned.' } }),
    ];
    expect(Object.fromEntries(itemLabels(alike))).toEqual({
      itm_00000001: 'A Jira ticket you can\'t open (1)', itm_00000002: 'A Jira ticket you can\'t open (2)', itm_00000003: 'A Jira ticket you can\'t open',
      itm_00000004: 'ECHO-12 · Pilot launch',
    });
  });

  it('shows on the item card what the item says now, else why it is not shown', () => {
    expect(itemNow(own)).toBe('Says "starts after freeze"');
    expect(itemNow(theirs)).toBe('Due Oct 30');
    expect(itemNow(item())).toBe('A Jira ticket you can\'t open');
    expect(itemNow(item({ reach: 'unavailable' }))).toBe('A Jira ticket ECHO couldn\'t read just now');
  });

  it('heads the item card with whose it is, and says what ECHO\'s check found without naming anyone', () => {
    expect(itemWhose(own, ari.membership_id)).toBe('yours to update');
    expect(itemWhose(theirs, ari.membership_id)).toBe('Mina\'s to update');
    expect(itemWhose(item({ owner: { ...OKAFOR, match: 'name' } }), ari.membership_id)).toBe('S. Okafor\'s to update');
    const at = (verdict: 'landed' | 'still_open' | 'changed' | 'unreadable') => ({ verdict, checked_at: new Date(now - 2 * 3_600_000).toISOString(), checked_by: 'Mina Patel' });
    expect(checkLine(at('changed'), now)).toBe('ECHO checked 2 h ago: it changed since it was sent, but still doesn\'t match.');
    expect(checkLine(at('still_open'), now)).toBe('ECHO checked 2 h ago: not updated yet.');
    expect(checkLine(at('landed'), now)).toBe('ECHO checked 2 h ago: it matches the decision now.');
    expect(checkLine(at('unreadable'), now)).toBe('ECHO checked 2 h ago but couldn\'t read it.');
    expect(checkLine(null, now)).toBeNull();
    for (const verdict of ['landed', 'still_open', 'changed', 'unreadable'] as const) expect(checkLine(at(verdict), now)).not.toContain('Mina');
  });
});
