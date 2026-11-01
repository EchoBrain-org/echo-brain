// The follow-ups screens as they show (follow-ups thread v1): called as functions, their hooks holding nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpList, ItemPage, State } from '../../src/renderer/store.js';
import type { OpenItemsView, OpenItemView } from '../../src/shared/protocol.js';
import { followUp, id, ME, MINA, RAFAEL, sent } from './changes-fixture.js';
import { ACCOUNT, byTestId, elements, EMPTY_SUMMARY, plainHooks, project, render, text, type Node } from './harness.js';

vi.mock('../../src/renderer/api.js', () => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));


/** Your list, its current work read to its end with no row, counted as `counts` say, its closed groups closed. */
async function notices(counts: Partial<OpenItemsView['summary']>): Promise<unknown[]> {
  const { getState } = await import('../../src/renderer/store.js');
  const { FollowUps } = await import('../../src/renderer/screens/follow-ups.js');
  const list: FollowUpList = {
    kind: 'list', seq: 1, scope: 'involved', title: null, loading: false, items: [], live: {}, reading: false, reads: [{ parts: ['active'], pages: [{ cursor: null, ids: [] }], next: null }],
    summary: { ...EMPTY_SUMMARY, ...counts }, stage: null, ticks: {}, sends: {}, check: null, expanded: {}, busy: false, said: null, picker: null, stale: false,
  };
  return elements(FollowUps({ state: getState(), list })).filter(node => node.props.class === 'notice').map(node => node.props.children);
}

describe('a follow-ups list', () => {
  it('says it has none only when it counts none, never under a closed group that holds some', async () => {
    expect(await notices({})).toEqual(['No follow-ups']);
    expect(await notices({ done: 3 })).toEqual([]);
    expect(await notices({ not_relevant: 1 })).toEqual([]);
  });
});

/** Pilot planning's list, read to its end: three not sent and ticked, one open, and (counted only) one dismissed. */
async function meeting(patch: Partial<Pick<FollowUpList, 'summary' | 'check'>> = {}): Promise<Node> {
  const { getState } = await import('../../src/renderer/store.js');
  const { FollowUps } = await import('../../src/renderer/screens/follow-ups.js');
  const unsent = [1, 2, 3].map(n => followUp(n, { state: 'unsent', sent_at: null, state_set_at: null, state_set_by: null, send_included: null }));
  const items = [...unsent, followUp(4)];
  const list: FollowUpList = {
    kind: 'list', seq: 1, scope: 'record', id: items[0]!.decision!.record_sha256, title: 'Pilot planning', loading: false, items, live: {}, reading: false,
    reads: [{ parts: ['active'], pages: [{ cursor: null, ids: items.map(item => item.item_id) }], next: null }],
    summary: { ...EMPTY_SUMMARY, unsent: 3, open: 1, not_relevant: 1, decisions: 1 }, stage: null,
    ticks: Object.fromEntries(unsent.map(item => [item.item_id, true])), sends: {}, check: null, expanded: {}, busy: false, said: null, picker: null, stale: false, ...patch,
  };
  return render(FollowUps({ state: getState(), list })) as Node;
}

describe('a meeting\'s list', () => {
  it('offers Check now only for open follow-ups, and says when the check is running', async () => {
    const buttons = (tree: Node) => elements(tree).filter(node => node.type === 'button' && text(node) === 'Check now');
    expect(buttons(await meeting())).toHaveLength(1);
    expect(buttons(await meeting({ summary: EMPTY_SUMMARY }))).toHaveLength(0);
    expect(text(await meeting({ check: 'checking' }))).toContain('Checking…');
  });
  it('says under its title how far its follow-ups have come, dismissed ones left out, with a bar of the same', async () => {
    const tree = await meeting();
    const head = elements(tree).find(node => node.type === 'header')!;
    expect(text(head)).toContain('Approved Oct 14 · 1 of 4 sent · 0 done');
    // Nothing done yet: only the open share is filled, over the not sent track.
    const bar = byTestId(tree, 'follow-ups-progress')[0]!;
    expect(elements(bar.props.children).map(node => [node.props.class, (node.props.style as { width: string }).width])).toEqual([['open', '25%']]);
  });

  it('puts Send and Dismiss right under its current rows, one list of them, above the closed ones folded at the end', async () => {
    const tree = await meeting();
    const parts = [tree.props.children].flat(Infinity as 1).filter((node): node is Node => Boolean(node) && typeof node === 'object' && 'props' in (node as object));
    // One owner (you): no owner line.
    expect(parts.map(node => String(node.props['aria-label'] ?? node.props.class ?? node.type))).toEqual(['follow-ups-head', 'Follow-ups not done yet', 'follow-ups-foot', 'Dismissed']);
    expect(text(byTestId(parts, 'follow-ups-foot')[0]).startsWith('Send 3Dismiss 3')).toBe(true);
    // Each row you may send keeps its tick, just before its mark.
    const rows = byTestId(tree, 'follow-up-row');
    expect(rows.map(row => elements(row.props.children)[0]!.props.class)).toEqual(['send-box', 'send-box', 'send-box', undefined]);
  });
});

/** Now, in these tests: noon on the 14th. */
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const daysAgo = (count: number) => new Date(NOW - count * 86_400_000).toISOString();
const PROJECT = project(1, 1, { name: 'Apollo' });

/**
 * Your Follow-ups page, as K draws it: Mina's ticket open nine days (late), Rafael's page open four (needs attention), yours open
 * since this morning, one ECHO found no owner for (not sent for two days), Mina's next not sent since this morning, and
 * Rafael's done one, folded. Home last read that ECHO checked two hours ago (`homeChecked`); the list's own read, never.
 */
async function yours(patch: Partial<Pick<FollowUpList, 'owner' | 'expanded' | 'summary'>> = {}, homeChecked: string | null = daysAgo(2 / 24)): Promise<Node> {
  const { getState } = await import('../../src/renderer/store.js');
  const { FollowUps } = await import('../../src/renderer/screens/follow-ups.js');
  const decision = { ...followUp(1).decision!, project_ids: [PROJECT.project_id] };
  const sentTo = (n: number, owner: typeof MINA, days: number, extra: Partial<OpenItemView> = {}) =>
    sent(n, owner, { decision, sent_at: daysAgo(days), state_set_at: daysAgo(days), created_at: daysAgo(days), ...extra });
  const unsentFor = (n: number, owner: typeof MINA, days: number, match: 'name' | 'approver') => sent(n, owner, {
    decision, owner: { ...owner, match }, state: 'unsent', sent_at: null, state_set_at: null, state_set_by: null, send_included: null, created_at: daysAgo(days),
  });
  const items = [
    sentTo(1, MINA, 9, { kind: 'ticket' }), sentTo(2, RAFAEL, 4, { kind: 'page' }), sentTo(3, ME, 0.2), unsentFor(4, ME, 2, 'approver'), unsentFor(5, MINA, 0.5, 'name'),
    sentTo(6, RAFAEL, 6, { state: 'done' }),
  ];
  const list: FollowUpList = {
    kind: 'list', seq: 1, scope: 'involved', title: null, loading: false, items, live: {}, reading: false,
    reads: [{ parts: ['active'], pages: [{ cursor: null, ids: items.map(item => item.item_id) }], next: null }],
    summary: { ...EMPTY_SUMMARY, unsent: 2, open: 3, done: 1 }, stage: null, ticks: {}, sends: {}, check: null, expanded: {}, busy: false, said: null,
    picker: null, stale: false, ...patch,
  };
  const home = { seq: 1, loading: false, meetings: true, reviews: [], runs: [], live: {}, reading: false,
    open: { send: [], items: [], landed: 0, waiting: 2, last_checked_at: homeChecked, sweep_due: false } };
  const state = { ...getState(), status: { signed_in: true, account: ACCOUNT }, home, projects: { items: [PROJECT], next: null, loading: false } } as unknown as State;
  return render(FollowUps({ state, list })) as Node;
}

describe('your Follow-ups page (One place to look v1, K)', () => {
  beforeEach(() => { vi.useFakeTimers({ now: NOW }); });
  afterEach(() => { vi.useRealTimers(); });

  const ownerButtons = (tree: Node) => byTestId(tree, 'follow-ups-owner');
  const row = (tree: Node, n: number) => byTestId(tree, 'follow-up-row').find(node => node.props['data-item'] === id(n))!;
  const part = (node: Node, cls: string) => elements(node).find(entry => String(entry.props.class ?? '').split(' ').includes(cls));

  it('has no page heading but for a screen reader, and says faintly under the list when ECHO last checked', async () => {
    const tree = await yours();
    const head = elements(tree).find(node => node.type === 'header')!;
    expect(head.props.class).toBe('follow-ups-head sr-only');
    expect(text(head)).toBe('Follow-ups');
    expect(text(byTestId(tree, 'follow-ups-checked'))).toBe('ECHO checked 2 h ago');
  });

  it('says when ECHO last checked from the list\'s own read too, which is newer than Home\'s once a check finished off Home', async () => {
    const summary = { ...EMPTY_SUMMARY, unsent: 2, open: 3, done: 1, last_checked_at: daysAgo(5 / 1440) };
    expect(text(byTestId(await yours({ summary }), 'follow-ups-checked'))).toBe('ECHO checked 5 min ago');
    // Home not read yet, or never told of a check: the list's own read still says it.
    expect(text(byTestId(await yours({ summary }, null), 'follow-ups-checked'))).toBe('ECHO checked 5 min ago');
    // Neither read knows of one: nothing is said.
    expect(byTestId(await yours({}, null), 'follow-ups-checked')).toEqual([]);
    // Home read since the list was (a decision page opened over it): Home's newer time.
    expect(text(byTestId(await yours({ summary: { ...summary, last_checked_at: daysAgo(3) } }), 'follow-ups-checked'))).toBe('ECHO checked 2 h ago');
  });

  it('shows who owns what: All, then a face per owner counted by what they hold open, needing attention first, then No owner', async () => {
    const buttons = ownerButtons(await yours());
    expect(buttons.map(button => button.props['aria-label'])).toEqual(['All owners', 'Mina Patel, 1 open', 'Rafael Moreno, 1 open', 'You, 1 open', 'No owner, 1']);
    expect(buttons.map(button => button.props['aria-pressed'])).toEqual([true, false, false, false, false]);
    expect(buttons.map(button => text(button))).toEqual(['All', 'MP1', 'RM1', 'F1', '1']);
    // All's name starts with the word it shows, so saying "click All" finds it.
    expect(String(buttons[0]!.props['aria-label'])).toMatch(/^All\b/);
  });

  it('gives each owner one hover over its whole button, its face too: who ("You" for you), what they hold open, and what a click does', async () => {
    const buttons = ownerButtons(await yours());
    expect(buttons.map(button => button.props.title)).toEqual([
      'Show every follow-up', 'Mina Patel · 1 open now · show only theirs', 'Rafael Moreno · 1 open now · show only theirs', 'You · 1 open now · show only yours',
      'No owner yet · 1 · show only those',
    ]);
    // Nothing in a button has a hover of its own, which would show in place of the button's.
    expect(buttons.flatMap(button => elements(button.props.children).filter(node => node.props.title !== undefined).map(node => node.props.title))).toEqual([]);
  });

  it('lists current work as one list, what needs attention first, longest waiting first, and folds Done at the end', async () => {
    const tree = await yours();
    const current = elements(tree).find(node => node.props['aria-label'] === 'Follow-ups not done yet')!;
    expect(byTestId(current, 'follow-up-row').map(node => node.props['data-item'])).toEqual([1, 2, 4, 5, 3].map(id));
    const fold = elements(tree).find(node => node.props['aria-label'] === 'Done')!;
    const head = elements(fold).find(node => node.type === 'button')!;
    expect([head.props['aria-label'], head.props['aria-expanded'], byTestId(fold, 'follow-up-row').length]).toEqual(['Done · 1', false, 0]);
  });

  it('draws each row as K does: its state mark, title, owner, project tile and age, with the long words on hover', async () => {
    const tree = await yours();
    const mark = (n: number) => { const found = part(row(tree, n), 'follow-up-state')!; return [found.props['data-mark'], found.props['data-tone'], found.props['aria-label']]; };
    expect(mark(1)).toEqual(['open', 'late', 'Open · waiting 9 days · over a week']);
    expect(mark(2)).toEqual(['open', 'signal', 'Open · waiting 4 days · needs attention']);
    expect(mark(3)).toEqual(['open', 'quiet', 'Open · waiting under a day']);
    expect(mark(4)).toEqual(['unsent', 'signal', 'Not sent yet · no owner · needs attention']);
    expect(mark(5)).toEqual(['unsent', 'quiet', 'Not sent yet']);
    // Owner: face and first name ("You" for you), dimmed while not sent; Pick owner while nobody owns it.
    expect(text(part(row(tree, 1), 'follow-up-owner'))).toBe('MPMina');
    expect(text(part(row(tree, 3), 'follow-up-owner'))).toBe('FYou');
    expect(part(row(tree, 5), 'follow-up-owner')!.props.class).toBe('follow-up-owner later');
    const pick = elements(row(tree, 4)).find(node => node.type === 'button' && String(node.props['aria-label']).startsWith('Pick owner: '))!;
    expect(text(pick)).toBe('Pick owner');
    // The project's tile, named on hover; the age in days.
    expect([part(row(tree, 1), 'follow-up-tile')!.props.title, text(part(row(tree, 1), 'follow-up-tile'))]).toEqual(['Apollo', 'A']);
    expect([text(part(row(tree, 1), 'follow-up-age')), part(row(tree, 1), 'follow-up-age')!.props.title]).toEqual(['9d', 'Waiting 9 days']);
    expect(row(tree, 1).props.title).toBe('Jira ticket · from Pilot planning · Sent to Mina 9 days ago');
    // What it is, a faint mark beside its title, for a document only.
    expect(part(row(tree, 2), 'follow-up-kind')!.props.title).toBe('Page');
    expect(part(row(tree, 3), 'follow-up-kind')).toBeUndefined();
    // A tick only where you may send: your two not sent, none ticked until you tick it.
    const ticks = byTestId(tree, 'follow-up-row').flatMap(node => elements(node).filter(entry => entry.props.class === 'send-box').map(box => [node.props['data-item'], box.props.checked]));
    expect(ticks).toEqual([[id(4), false], [id(5), false]]);
  });

  it('shows only one owner\'s rows under a filter, open and closed, with their face pressed and no count on what it folds', async () => {
    const tree = await yours({ owner: RAFAEL.membership_id, expanded: { done: true } });
    expect(byTestId(tree, 'follow-up-row').map(node => node.props['data-item'])).toEqual([2, 6].map(id));
    expect(ownerButtons(tree).map(button => button.props['aria-pressed'])).toEqual([false, false, true, false, false]);
    expect(elements(tree).find(node => node.props['aria-expanded'] === true)!.props['aria-label']).toBe('Done');
    // An owner with no row left: everyone's again.
    const gone = await yours({ owner: 'mem_gone' });
    expect(byTestId(gone, 'follow-up-row')).toHaveLength(5);
    expect(ownerButtons(gone)[0]!.props['aria-pressed']).toBe(true);
  });
});

describe('a follow-up\'s page', () => {
  it('offers a retry after opening a known row whose detail read failed', async () => {
    const { getState } = await import('../../src/renderer/store.js');
    const { FollowUp } = await import('../../src/renderer/screens/follow-ups.js');
    const item = followUp(1, { kind: 'ticket' });
    // readItem keeps the row and records an unavailable live part on a transient read failure.
    const page: ItemPage = {
      kind: 'item', seq: 1, item_id: item.item_id, item, live: { [item.item_id]: { reach: 'unavailable' } },
      loading: false, send: null, busy: false, said: null, picker: null, stale: false,
    };
    expect(elements(FollowUp({ state: getState(), page })).some(node => node.type === 'button' && node.props.children === 'Try again')).toBe(true);
  });
});
