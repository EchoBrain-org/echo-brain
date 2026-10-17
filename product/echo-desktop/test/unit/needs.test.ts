import { describe, expect, it } from 'vitest';
import type { OpenItemView } from '../../src/shared/protocol.js';
import {
  actionCount, activeTotal, checkWords, followUpCount, followUpsWords, homeFooter, itemGroups, itemHistory, itemKind, itemNames, itemNeeds, itemTitle, itemWhy,
  liveFacts, matchesNow, meetingSuffix, monthDay, ownerAndStatus, ownerWords, reopenLabel, saysNow, sendLabel, sentWords, shortNames, STAGES, stateCounts, titleLine, toSend,
} from '../../src/renderer/needs.js';

const person = { membership_id: 'mem_00000000-0000-4000-8000-000000000001', name: 'Mina Patel', active: true };
/** An item you opened carries what it says now; any other, why it does not (here, by default, that you can't open it). */
const item = (patch: Partial<OpenItemView> = {}): OpenItemView => ({
  item_id: 'itm_00000001', run_id: 'run_00000001', kind: 'ticket', relation: 'conflicts', expected: 'launch next week', approver: person,
  owner: { ...person, match: 'jira_account' }, waits_on: 'owner', state: 'open', created_at: '2026-10-07T10:05:00.000Z', sent_at: '2026-10-07T11:00:00.000Z',
  state_set_at: '2026-10-07T11:00:00.000Z', state_set_by: person, owner_set_at: null, owner_set_by: null, send_included: true, check: null,
  can: { set_state: true, assign: true }, reach: patch.current ? 'opened' : 'no_access', ...patch,
});
const ticket = { kind: 'ticket' as const, tool_id: 'jira', label: 'ECHO-12 · Pilot launch', permalink: 'https://example.atlassian.net/browse/ECHO-12' };
const OKAFOR = { membership_id: 'mem_00000000-0000-4000-8000-000000000003', name: 'S. Okafor', active: true };
const summary = { unsent: 0, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 0, last_checked_at: null, by_decision: [] };
const pilot = { approval_id: 'apr_1', record_sha256: 'sha256:1', title: 'Pilot planning', first_line: 'Launch the pilot next week.', approved_at: '2026-10-06T12:00:00.000Z', project_ids: [] };
/** One of the meeting's own actions: its title is its words, and it is never read live. */
const action = (patch: Partial<OpenItemView> = {}) => item({ kind: 'action', relation: 'needs_updating', expected: 'Send the revised quote', reach: 'not_read', decision: pilot, ...patch });

describe('the words Home and the follow-ups use', () => {
  it('names people by first name, keeping an initial or a shared first name whole', () => {
    expect(shortNames(['Mina Patel', 'Rafael Moreno', 'S. Okafor'])).toEqual(['Mina', 'Rafael', 'S. Okafor']);
    expect(shortNames(['Mina Patel', 'Mina Lee', 'Ari'])).toEqual(['Mina Patel', 'Mina Lee', 'Ari']);
  });

  it('counts what waits to be sent, and the actions a meeting holds', () => {
    expect([toSend(1), toSend(4)]).toEqual(['1 follow-up to send', '4 follow-ups to send']);
    expect([actionCount(0), actionCount(1), actionCount(2)]).toEqual([null, '1 action', '2 actions']);
    expect(titleLine('Launch the pilot next week.')).toBe('Launch the pilot next week');
  });

  it('writes a date as the canvas does; a date with no time is that day wherever you are', () => {
    expect(monthDay('2026-10-30')).toBe('Oct 30');
    expect(monthDay('2026-10-06T12:00:00.000Z')).toBe('Oct 6');
    expect(monthDay('next week')).toBeNull();
  });

  it('names a meeting\'s action by its own words, and any other item by how its live read went', () => {
    expect(itemTitle(action())).toBe('Send the revised quote');
    expect(itemTitle(action({ expected: null }))).toBe('An action');
    expect(itemTitle(item({ current: { source: ticket, says_now: 'Planned.' } }))).toBe('ECHO-12 · Pilot launch');
    expect(itemTitle(item({ reach: 'no_access' }))).toBe('A Jira ticket you can\'t open');
    // An outage or a rate limit is not lost access.
    expect(itemTitle(item({ reach: 'unavailable' }))).toBe('A Jira ticket ECHO couldn\'t read just now');
    // Not read yet (a rows-only read, before the live read fills it): what it is and its meeting, from ECHO's own fields.
    expect(itemTitle(item({ reach: 'not_read', decision: pilot }))).toBe('Jira ticket · Pilot planning');
    expect(itemTitle(item({ kind: 'page', reach: 'not_read', decision: pilot }))).toBe('Page · Pilot planning');
    expect(itemTitle(item({ reach: 'not_read' }))).toBe('Jira ticket');
    expect([itemTitle(item({ kind: 'page' })), itemTitle(item({ kind: 'slack_message', reach: 'unavailable' }))])
      .toEqual(['A page you can\'t open', 'A Slack message ECHO couldn\'t read just now']);
  });

  it('says what kind of thing an item is, named by its tool once you can open it', () => {
    expect(itemKind(action())).toBe('Meeting action');
    expect(itemKind(item())).toBe('Jira ticket');
    expect(itemKind(item({ kind: 'page' }))).toBe('Page');
    expect(itemKind(item({ kind: 'page', current: { source: { ...ticket, kind: 'page', tool_id: 'confluence' }, says_now: 'x' } }))).toBe('Confluence page');
    // A meeting you cannot read is never named: who sent it is, by first name.
    expect(itemWhy(item(), person.membership_id)).toBe('Jira ticket · sent by Mina');
    expect(itemWhy(item({ decision: pilot }), person.membership_id)).toBe('Jira ticket · Pilot planning meeting, approved Oct 6');
  });

  it('tells two items that would share a name apart by what the meeting requires of each, then by position', () => {
    const names = itemNames([
      item({ item_id: 'itm_00000001', expected: 'confirm the trace by Friday' }), item({ item_id: 'itm_00000002', expected: 'order six weeks ahead' }),
      item({ item_id: 'itm_00000003', reach: 'unavailable' }), item({ item_id: 'itm_00000004', current: { source: ticket, says_now: 'Planned.' } }),
      action({ item_id: 'itm_00000005' }), action({ item_id: 'itm_00000006' }),
    ]);
    expect(Object.fromEntries([...names].map(([id, { name }]) => [id, name]))).toEqual({
      itm_00000001: 'A Jira ticket you can\'t open → confirm the trace by Friday', itm_00000002: 'A Jira ticket you can\'t open → order six weeks ahead',
      itm_00000003: 'A Jira ticket ECHO couldn\'t read just now', itm_00000004: 'ECHO-12 · Pilot launch',
      // An action's title is already what the meeting requires: never said twice.
      itm_00000005: 'Send the revised quote (1)', itm_00000006: 'Send the revised quote (2)',
    });
    expect(itemNames([item()]).get('itm_00000001')).toEqual({ name: 'A Jira ticket you can\'t open', label: 'A Jira ticket you can\'t open' });
    // A row's title gains only its position, where nothing else on the row tells it apart.
    expect(Object.fromEntries([...itemNames([item({ item_id: 'itm_00000001', expected: 'x', decision: pilot }), item({ item_id: 'itm_00000002', expected: 'x', decision: pilot })])]
      .map(([id, { label }]) => [id, label]))).toEqual({ itm_00000001: 'A Jira ticket you can\'t open (1)', itm_00000002: 'A Jira ticket you can\'t open (2)' });
    // Where the title tells it apart, the label is the title alone.
    expect(names.get('itm_00000001')?.label).toBe('A Jira ticket you can\'t open');
  });

  it('keeps names apart by their meeting when what the meeting requires does not', () => {
    const decision = (title: string) => ({ ...pilot, title });
    expect(Object.fromEntries([...itemNames([
      item({ item_id: 'itm_00000001', expected: null, decision: decision('Pilot planning') }), item({ item_id: 'itm_00000002', expected: null, decision: decision('Kickoff review') }),
    ])].map(([id, { name }]) => [id, name]))).toEqual({ itm_00000001: 'A Jira ticket you can\'t open · from Pilot planning', itm_00000002: 'A Jira ticket you can\'t open · from Kickoff review' });
  });

  it('never writes "meeting" after a title that already ends with it (R76)', () => {
    const from = (title: string) => itemWhy(item({ decision: { ...pilot, title } }), person.membership_id);
    expect(from('Pilot planning')).toBe('Jira ticket · Pilot planning meeting, approved Oct 6');
    expect(from('Approved meeting')).toBe('Jira ticket · Approved meeting, approved Oct 6');
    expect([meetingSuffix('Pilot planning'), meetingSuffix('Approved meeting'), meetingSuffix('Team Meeting')]).toEqual([' meeting', '', '']);
  });
});

describe('one status vocabulary (F7)', () => {
  it('names each status, and counts by status, leaving out what is zero', () => {
    expect(STAGES).toEqual({ unsent: 'Not sent', open: 'Open', done: 'Done', not_relevant: 'Dismissed' });
    expect(stateCounts({ unsent: 4, open: 1, done: 2, not_relevant: 1 })).toBe('1 open · 4 not sent · 2 done · 1 dismissed');
    expect(stateCounts({ unsent: 2, open: 0, done: 0, not_relevant: 0 })).toBe('2 not sent');
    expect(stateCounts({ unsent: 0, open: 0, done: 0, not_relevant: 0 })).toBe('');
  });

  it('says a follow-up an answer cites as its owner and status: "Mina · Open", "You · Done" (ADR-0040)', () => {
    expect(ownerAndStatus(item(), 'mem_someone-else')).toBe('Mina · Open');
    expect(ownerAndStatus(item({ state: 'done' }), person.membership_id)).toBe('You · Done');
    expect(ownerAndStatus(item({ owner: { ...OKAFOR, match: 'name' }, state: 'not_relevant' }), null)).toBe('S. Okafor · Dismissed');
    expect(ownerWords(item(), undefined)).toBe('Mina');
  });

  it('totals not sent and open as follow-ups, never as "open", whatever the last check found', () => {
    expect(activeTotal({ unsent: 2, open: 3 })).toBe(5);
    expect([followUpCount(activeTotal({ unsent: 1, open: 3 })), followUpCount(1)]).toEqual(['4 follow-ups', '1 follow-up']);
    // A project's line says its follow-ups as a meeting's does.
    expect(stateCounts({ ...summary, unsent: 3, open: 1 })).toBe('1 open · 3 not sent');
  });

  it('says a meeting\'s follow-ups by status, and with none how its check stands', () => {
    const stage = { record_sha256: 'sha256:1', run_id: 'run_00000001', mine: true };
    // Canvas 9.6: a landed or unreadable item is still open; nothing is "handled" or "couldn't read".
    expect(followUpsWords({ ...summary, open: 3, landed: 1, unreadable: 1, unsent: 4 }, { ...stage, state: 'done', error_code: null })).toBe('3 open · 4 not sent');
    expect(followUpsWords({ ...summary, done: 1, not_relevant: 1 }, { ...stage, state: 'done', error_code: null })).toBe('1 done · 1 dismissed');
    expect(followUpsWords(summary, null)).toBe('Not checked yet');
    expect(followUpsWords(summary, { ...stage, state: 'pending', error_code: null })).toBe('Not checked yet');
    expect(followUpsWords(summary, { ...stage, state: 'running', error_code: null })).toBe('Checking…');
    expect(followUpsWords(summary, { ...stage, state: 'failed', error_code: 'research_failed' })).toBe('Check failed');
    expect(followUpsWords(summary, { ...stage, state: 'done', error_code: null })).toBe('None');
  });

  it('groups a list by status, in order, the meeting\'s actions first, then the oldest first', () => {
    const items = [
      item({ item_id: 'itm_00000001', state: 'done' }), item({ item_id: 'itm_00000002', state: 'unsent', created_at: '2026-10-07T10:06:00.000Z' }),
      action({ item_id: 'itm_00000003', state: 'unsent', created_at: '2026-10-07T10:07:00.000Z' }), item({ item_id: 'itm_00000004', state: 'unsent' }),
      item({ item_id: 'itm_00000005', state: 'not_relevant' }), action({ item_id: 'itm_00000006', state: 'open' }),
    ];
    expect(itemGroups(items).map(group => [group.state, group.items.map(entry => entry.item_id)])).toEqual([
      ['unsent', ['itm_00000003', 'itm_00000004', 'itm_00000002']], ['open', ['itm_00000006']], ['done', ['itm_00000001']], ['not_relevant', ['itm_00000005']],
    ]);
    // Empty groups are left out.
    expect(itemGroups([item()]).map(group => group.state)).toEqual(['open']);
  });
});

describe('ECHO\'s re-reads, kept underneath', () => {
  const now = Date.parse('2026-10-08T15:00:00.000Z');
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const checked = (verdict: NonNullable<OpenItemView['check']>['verdict']) => ({ verdict, checked_at: ago(120), checked_by: 'Mina Patel' });

  it('says when a check ran as the canvas does', () => {
    const checkedAgo = (iso: string, at: number) => homeFooter({ waiting: 0, last_checked_at: iso }, at)!.replace('ECHO checked ', '');
    expect([checkedAgo(ago(0), now), checkedAgo(ago(0.5), now), checkedAgo(new Date(now + 30_000).toISOString(), now)]).toEqual(['just now', 'just now', 'just now']);
    expect([checkedAgo(ago(1), now), checkedAgo(ago(59), now)]).toEqual(['1 min ago', '59 min ago']);
    expect([checkedAgo(ago(60), now), checkedAgo(ago(120), now), checkedAgo(ago(359), now)]).toEqual(['1 h ago', '2 h ago', '5 h ago']);
    // Six hours or more: the day, in this computer's time zone.
    const local = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();
    expect(checkedAgo(new Date(local(8, 9)).toISOString(), local(8, 18))).toBe('today');
    expect(checkedAgo(new Date(local(7, 9)).toISOString(), local(8, 18))).toBe('yesterday');
    expect(checkedAgo(new Date(local(6, 9)).toISOString(), local(8, 18))).toBe('Oct 6');
  });

  it('says on an item page what the last check found, in one faint line naming no one', () => {
    expect(checkWords(checked('changed'), now)).toBe('Checked 2 h ago · changed, still doesn\'t match');
    expect(checkWords(checked('still_open'), now)).toBe('Checked 2 h ago · not updated yet');
    expect(checkWords(checked('landed'), now)).toBe('Checked 2 h ago · matches now');
    expect(checkWords(checked('unreadable'), now)).toBe('Checked 2 h ago · couldn\'t read it');
    expect(checkWords(null, now)).toBeNull();
    // A list row says only a match.
    expect([matchesNow(item({ check: checked('landed') })), matchesNow(item({ check: checked('changed') })), matchesNow(item())]).toEqual(['matches now', null, null]);
  });

  it('sums up under Home\'s rows what waits on others and when ECHO checked, never what matches', () => {
    expect(homeFooter({ waiting: 1, last_checked_at: ago(120) }, now)).toBe('1 waiting on others · ECHO checked 2 h ago');
    expect(homeFooter({ waiting: 2, last_checked_at: null }, now)).toBe('2 waiting on others');
    expect(homeFooter({ waiting: 0, last_checked_at: ago(120) }, now)).toBe('ECHO checked 2 h ago');
    expect(homeFooter({ waiting: 0, last_checked_at: null }, now)).toBeNull();
  });
});

describe('Home item rows and the item page', () => {
  const ari = { membership_id: 'mem_00000000-0000-4000-8000-000000000002', name: 'Ari', active: true };
  const mina = person;
  const page = { kind: 'page' as const, tool_id: 'confluence', label: 'Thermostat PRD · Pilot scope', permalink: 'https://example.atlassian.net/wiki/pages/12345' };
  /** Ari's own page, from Ari's own meeting: the founder's example. */
  const own = item({ kind: 'page', relation: 'needs_updating', expected: 'pilot starts next week', approver: ari, owner: { ...ari, match: 'approver' }, decision: pilot,
    current: { source: page, says_now: 'starts after freeze' }, check: { verdict: 'changed', checked_at: '2026-10-08T12:00:00.000Z', checked_by: 'Mina Patel' } });
  /** ECHO-12, sent by Ari to Mina. */
  const theirs = item({ approver: ari, owner: { ...mina, match: 'jira_account' }, decision: pilot, current: { source: ticket, says_now: 'Planned.', assignee: 'Mina Patel', due_at: '2026-10-30' } });

  it('says on a document\'s second line what it says now and what the meeting needs, and nothing for an action', () => {
    expect(itemNeeds(own)).toBe('Says "starts after freeze" → decision needs: pilot starts next week');
    expect(itemNeeds(theirs)).toBe('Due Oct 30 → decision needs: launch next week');
    expect(itemNeeds(item())).toBe('Decision needs: launch next week');
    expect(itemNeeds(item({ expected: null }))).toBeNull();
    expect(itemNeeds(action())).toBeNull();
  });

  it('says on the muted line what an item is, its meeting, and whose it is, never what a check found', () => {
    expect(itemWhy(own, ari.membership_id, null)).toBe('Confluence page · Pilot planning meeting, approved Oct 6');
    expect(itemWhy(theirs, ari.membership_id, null)).toBe('Jira ticket · Pilot planning meeting, approved Oct 6 · Mina\'s to update');
    expect(itemWhy(action({ owner: { ...ari, match: 'name' } }), ari.membership_id, null)).toBe('Meeting action · Pilot planning meeting, approved Oct 6');
    expect(itemWhy(item({ approver: mina, owner: { ...ari, match: 'picked' } }), ari.membership_id, null)).toBe('Jira ticket · sent by Mina');
    expect(itemWhy(item({ owner: { ...OKAFOR, match: 'name' } }), ari.membership_id)).toBe('Jira ticket · sent by Mina · S. Okafor\'s to update');
  });

  it('shows on the item page what an item says now, else why it is not shown, and its tool\'s facts in one line', () => {
    expect(saysNow(theirs)).toBe('“Planned.”');
    expect(saysNow(own)).toBe('“starts after freeze”');
    expect(liveFacts(theirs)).toBe('Due Oct 30 · Mina Patel');
    expect(liveFacts(item({ current: { source: ticket, says_now: 'x', status: 'In Progress', due_at: '2026-10-30', assignee: 'Mina Patel' } }))).toBe('In Progress · Due Oct 30 · Mina Patel');
    expect(liveFacts(item({ current: { source: ticket, says_now: 'x', status: 'Blocked' } }))).toBe('Blocked');
    expect([liveFacts(own), liveFacts(item())]).toEqual([null, null]);
    expect(saysNow(item())).toBe('You can\'t open it');
    expect(saysNow(item({ reach: 'unavailable' }))).toBe('ECHO couldn\'t read it just now');
    expect(saysNow(item({ reach: 'not_read' }))).toBe('Not read');
  });

  it('labels the send button by whose the item is', () => {
    expect(sendLabel(theirs, ari.membership_id)).toBe('Send to Mina');
    expect(sendLabel(own, ari.membership_id)).toBe('Keep it myself');
  });

  it('says what a Send did, on a list or a page, counting only past one', () => {
    const rafael = { membership_id: 'mem_00000000-0000-4000-8000-000000000009', name: 'Rafael Moreno' };
    // By first name, as the buttons name them.
    expect(sentWords([mina], ari.membership_id)).toBe('Sent to Mina');
    expect(sentWords([mina, mina], ari.membership_id)).toBe('Sent 2 to Mina');
    expect(sentWords([mina, rafael, ari], ari.membership_id)).toBe('Sent 2 · 1 kept for you');
    expect(sentWords([mina, ari], ari.membership_id)).toBe('Sent to Mina · 1 kept for you');
    expect(sentWords([ari], ari.membership_id)).toBe('Kept for you');
    expect(sentWords([ari, ari], ari.membership_id)).toBe('Kept 2 for you');
    expect([sentWords([mina], ari.membership_id, false), sentWords([mina, ari], ari.membership_id, false)]).toEqual(['Dismissed', 'Dismissed 2']);
  });
});

describe('a follow-up\'s history (F4)', () => {
  const ari = { membership_id: 'mem_00000000-0000-4000-8000-000000000002', name: 'Ari', active: true };
  const rafael = { membership_id: 'mem_00000000-0000-4000-8000-000000000009', name: 'Rafael Moreno', active: true };
  const words = (entry: OpenItemView, me = ari.membership_id) => itemHistory(entry, me).map(event => `${event.at.slice(11, 16)} ${event.words}`);
  const unsent = { state: 'unsent' as const, sent_at: null, state_set_at: null, state_set_by: null, send_included: null, approver: ari };

  it('is found, then nothing more, while not sent', () => {
    expect(words(item(unsent))).toEqual(['10:05 Found']);
    expect(words(action(unsent))).toEqual(['10:05 From the meeting']);
  });

  it('says who sent it to whom, and who closed it, naming the viewer "you"', () => {
    const sent = { approver: ari, owner: { ...person, match: 'jira_account' as const }, state_set_by: ari };
    expect(words(item(sent))).toEqual(['10:05 Found', '11:00 Sent to Mina Patel by you']);
    expect(words(item({ ...sent, state: 'done', state_set_at: '2026-10-07T12:00:00.000Z', state_set_by: person })))
      .toEqual(['10:05 Found', '11:00 Sent to Mina Patel by you', '12:00 Done by Mina Patel']);
    expect(words(item({ ...sent, state: 'not_relevant', state_set_at: '2026-10-07T12:00:00.000Z' }))).toEqual(['10:05 Found', '11:00 Sent to Mina Patel by you', '12:00 Dismissed by you']);
    expect(words(item({ ...sent, state: 'open', state_set_at: '2026-10-07T12:00:00.000Z', state_set_by: person })))
      .toEqual(['10:05 Found', '11:00 Sent to Mina Patel by you', '12:00 Reopened by Mina Patel']);
    // Its owner sees themselves as "you".
    expect(words(item(sent), person.membership_id)).toEqual(['10:05 Found', '11:00 Sent to you by Ari']);
  });

  it('says a follow-up dismissed before it was sent was dismissed, not sent, by its approver', () => {
    expect(words(item({ approver: ari, state: 'not_relevant', send_included: false, state_set_by: ari }))).toEqual(['10:05 Found', '11:00 Dismissed by you']);
    expect(words(item({ approver: person, state: 'not_relevant', send_included: false, state_set_by: person }))).toEqual(['10:05 Found', '11:00 Dismissed by Mina Patel']);
  });

  it('says one Send dismissed and opened since went to its owner then; any other opened again was reopened', () => {
    const dismissed = { approver: ari, owner: { ...person, match: 'name' as const }, send_included: false, state_set_at: '2026-10-07T12:00:00.000Z', state_set_by: ari };
    expect(words(item({ ...dismissed, state: 'open' }))).toEqual(['10:05 Found', '11:00 Dismissed by you', '12:00 Sent to Mina Patel by you']);
    // Its owner sees it sent to them.
    expect(words(item({ ...dismissed, state: 'open' }), person.membership_id)).toEqual(['10:05 Found', '11:00 Dismissed by Ari', '12:00 Sent to you by Ari']);
    // Its owner changed since it went: the owner it went to is not named.
    expect(words(item({ ...dismissed, state: 'open', owner: { ...rafael, match: 'reassigned' }, owner_set_at: '2026-10-07T13:00:00.000Z', owner_set_by: person })))
      .toEqual(['10:05 Found', '11:00 Dismissed by you', '12:00 Sent by you', '13:00 Owner set to Rafael Moreno by Mina Patel']);
    // Closed again since: only the last change of its status shows.
    expect(words(item({ ...dismissed, state: 'done', state_set_by: person }))).toEqual(['10:05 Found', '11:00 Dismissed by you', '12:00 Done by Mina Patel']);
    expect(words(item({ ...dismissed, state: 'not_relevant' }))).toEqual(['10:05 Found', '11:00 Dismissed by you', '12:00 Dismissed by you']);
    // One Send included, dismissed and opened again since, was reopened.
    expect(words(item({ ...dismissed, send_included: true, state: 'open', state_set_by: person })))
      .toEqual(['10:05 Found', '11:00 Sent to Mina Patel by you', '12:00 Reopened by Mina Patel']);
  });

  it('offers to send a closed follow-up only when Send dismissed it and nothing opened it since; any other reopens', () => {
    const dismissed = item({ approver: ari, owner: { ...person, match: 'name' }, state: 'not_relevant', send_included: false, state_set_by: ari });
    expect(reopenLabel(dismissed, ari.membership_id)).toBe('Send to Mina');
    // Yours: it reopens, to you.
    expect(reopenLabel(dismissed, person.membership_id)).toBe('Reopen');
    // Opened and dismissed again since, sent and dismissed later, or done: Reopen.
    expect(reopenLabel(item({ ...dismissed, state_set_at: '2026-10-07T12:00:00.000Z' }), ari.membership_id)).toBe('Reopen');
    expect(reopenLabel(item({ ...dismissed, send_included: true, state_set_at: '2026-10-07T12:00:00.000Z' }), ari.membership_id)).toBe('Reopen');
    expect(reopenLabel(item({ ...dismissed, send_included: true, state: 'done', state_set_at: '2026-10-07T12:00:00.000Z' }), ari.membership_id)).toBe('Reopen');
  });

  it('names the owner a send went to only while no one changed the owner since', () => {
    const picked = { ...unsent, owner: { ...rafael, match: 'picked' as const }, owner_set_at: '2026-10-07T10:30:00.000Z', owner_set_by: ari };
    expect(words(item(picked))).toEqual(['10:05 Found', '10:30 Owner set to Rafael Moreno by you']);
    expect(words(item({ ...picked, state: 'open', sent_at: '2026-10-07T11:00:00.000Z', state_set_at: '2026-10-07T11:00:00.000Z', state_set_by: ari, send_included: true })))
      .toEqual(['10:05 Found', '10:30 Owner set to Rafael Moreno by you', '11:00 Sent to Rafael Moreno by you']);
    const reassigned = item({ approver: ari, state_set_by: ari, owner: { ...rafael, match: 'reassigned' }, owner_set_at: '2026-10-07T12:00:00.000Z', owner_set_by: person });
    expect(words(reassigned)).toEqual(['10:05 Found', '11:00 Sent by you', '12:00 Owner set to Rafael Moreno by Mina Patel']);
  });
});
