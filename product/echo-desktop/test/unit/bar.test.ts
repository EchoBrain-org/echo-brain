// The ask bar's own words: "Try asking" for an empty bar (this window's
// questions in the bar's scope, then the meetings ECHO shows there, then the
// question for any week; at most three, each once) and the count toward a
// question's 240 characters.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, HomeView, ListItem, OpenItemView } from '../../src/shared/protocol.js';
import { COUNT_FROM, decidedIn, MAX_QUESTION, MAX_SUGGESTIONS, questionCount, suggestedQuestions, weekQuestion } from '../../src/renderer/bar.js';
import { ACCOUNT, EMPTY_SUMMARY, flush, Held, ok, project, rpcFor, startStore, storeLifecycle } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const apollo = project(1, 30, { name: 'Apollo' });
const answer: Answer = {
  text: 'We ship on Friday.', scope: { kind: 'global' }, sources: [], outcome: 'answered',
  parts: [{ question: 'When do we ship?', status: 'answered', statements: [{ text: 'We ship on Friday.', citation_indexes: [], private: false }] }],
};
const decision = (title: string, approved_at: string) => ({
  approval_id: `apr_${title.length.toString(16).padStart(64, '0')}`, record_sha256: `sha256:${title.length.toString(16).padStart(64, '0')}`, title,
  first_line: null, approved_at, project_ids: [],
});
const person = { membership_id: 'mem_00000000-0000-4000-8000-000000000002', name: 'Mina Patel', active: true };
const item = (title: string, approved_at: string): OpenItemView => ({
  item_id: `itm_${title.length}`, run_id: 'run_00000000-0000-4000-8000-000000000020', kind: 'ticket', decision: decision(title, approved_at), relation: 'conflicts',
  expected: 'launch next week', approver: person, owner: { ...person, match: 'jira_account' }, waits_on: 'owner', state: 'open',
  created_at: approved_at, sent_at: approved_at, state_set_at: approved_at, state_set_by: person, owner_set_at: null, owner_set_by: null, send_included: true,
  check: null, can: { set_state: true, assign: true }, reach: 'not_read',
});
const meeting = (title: string, day: number): ListItem => ({
  ref: { kind: 'meeting', id: `sha256:${String(day).padStart(64, '0')}` }, title, added_at: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`, visibility: 'project',
  projects: ['Apollo'], meeting_date: `2026-10-${String(day).padStart(2, '0')}`,
});
const note = (title: string, day: number): ListItem => ({
  ref: { kind: 'note', id: `ctx_${day}` }, title, added_at: `2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`, visibility: 'project', projects: ['Apollo'],
});

let home: HomeView;
let feed: ListItem[];
storeLifecycle(new Date('2026-10-19T11:00:00.000Z'));
beforeEach(() => {
  home = { send: [], items: [], landed: 0, waiting: 0, last_checked_at: null, sweep_due: false };
  feed = [];
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), {
    'ask.run': () => ok(answer),
    'list.page': () => ok({ items: feed, next_cursor: null, meetings_held: false }),
    'projects.read': () => ok(apollo),
    runs: params => {
      const request = params.request as { operation: string };
      return request.operation === 'home' ? ok(home) : request.operation === 'list' ? ok({ runs: [] }) : ok({ items: [], next_cursor: null, summary: EMPTY_SUMMARY, stages: [] });
    },
  }, () => ({ active: [apollo], archived: [] })));
});

describe('the count toward a question\'s limit', () => {
  it('shows nothing below 200 characters, counts from 200, and is full at 240', () => {
    expect(COUNT_FROM).toBe(200);
    expect(MAX_QUESTION).toBe(240);
    expect(questionCount('')).toBeNull();
    expect(questionCount('x'.repeat(199))).toBeNull();
    expect(questionCount('x'.repeat(200))).toEqual({ words: '200 / 240', full: false });
    expect(questionCount('x'.repeat(212))).toEqual({ words: '212 / 240', full: false });
    expect(questionCount('x'.repeat(239))).toEqual({ words: '239 / 240', full: false });
    expect(questionCount('x'.repeat(240))).toEqual({ words: '240 / 240', full: true });
  });
});

describe('what an empty bar suggests', () => {
  it('puts this window\'s questions first, then the meetings, then the question for any week, each once and at most three', () => {
    expect(MAX_SUGGESTIONS).toBe(3);
    expect(suggestedQuestions([], [], 'What did we decide this week?')).toEqual(['What did we decide this week?']);
    expect(suggestedQuestions(['When do we ship?'], ['Pilot planning'], 'What did we decide this week?'))
      .toEqual(['When do we ship?', 'What did we decide in Pilot planning?', 'What did we decide this week?']);
    // The same question twice (by case or spacing), or one a meeting would make again, shows once.
    expect(suggestedQuestions(['what did we decide in pilot planning?', 'When  do we ship?'], ['Pilot planning', 'Pilot planning'], 'When do we ship?'))
      .toEqual(['what did we decide in pilot planning?', 'When do we ship?']);
    expect(suggestedQuestions(['One?', 'Two?', 'Three?', 'Four?'], ['Pilot planning'], 'What did we decide this week?')).toEqual(['One?', 'Two?', 'Three?']);
    expect(suggestedQuestions([], ['', 'Pilot planning'], 'What did we decide this week?'))
      .toEqual(['What did we decide in Pilot planning?', 'What did we decide this week?']);
  });

  it('asks about any week in the bar\'s own words for its scope, and keeps a long meeting name within the limit', () => {
    expect(weekQuestion({ kind: 'global' }, null)).toBe('What did we decide this week?');
    expect(weekQuestion({ kind: 'project', project_id: apollo.project_id }, 'Apollo')).toBe('What changed in Apollo this week?');
    expect(weekQuestion({ kind: 'mine' }, 'Mine')).toBe('What did I add this week?');
    const long = decidedIn('A'.repeat(300));
    expect(long.length).toBeLessThanOrEqual(MAX_QUESTION);
    expect(long).toMatch(/^What did we decide in A+…\?$/);
  });

  it('remembers what was asked in this window, by scope and newest first; Home\'s meetings follow, newest first', async () => {
    home = { ...home, send: [{ run_id: 'run_00000000-0000-4000-8000-000000000020', decision: decision('Pilot planning', '2026-10-08T10:00:00.000Z'), items: 2,
      kinds: ['ticket'], owners: ['Mina Patel'], finished_at: '2026-10-08T10:05:00.000Z' }], items: [item('Supplier review', '2026-10-12T10:00:00.000Z')] };
    const store = await startStore();
    await store.loadHome();
    await flush();
    expect(store.barSuggestions()).toEqual(['What did we decide in Supplier review?', 'What did we decide in Pilot planning?', 'What did we decide this week?']);

    await store.ask('When do we ship?');
    await store.ask('Who leads the pilot?');
    await flush();
    expect(store.barSuggestions()).toEqual(['Who leads the pilot?', 'When do we ship?', 'What did we decide in Supplier review?']);
    // Asked again, a question moves up rather than showing twice.
    await store.ask('when do we ship?');
    await flush();
    expect(store.barSuggestions()).toEqual(['when do we ship?', 'Who leads the pilot?', 'What did we decide in Supplier review?']);
    // Kept in memory only: nothing of them is stored.
    expect(JSON.stringify(vi.mocked(localStorage.setItem).mock.calls)).not.toMatch(/ship|pilot/i);
  });

  it('keeps a project\'s questions and meetings to its own bar', async () => {
    feed = [meeting('Apollo kickoff', 14), note('Pricing memo', 13), meeting('Apollo readout', 9)];
    const store = await startStore();
    await store.ask('When do we ship?');
    await flush();
    await store.openProject(apollo);
    await flush();
    expect(store.getState().barScope).toEqual({ kind: 'project', project_id: apollo.project_id });
    expect(store.barSuggestions()).toEqual(['What did we decide in Apollo kickoff?', 'What did we decide in Apollo readout?', 'What changed in Apollo this week?']);
    await store.ask('What is left for launch?');
    await flush();
    expect(store.barSuggestions()[0]).toBe('What is left for launch?');
    // Back in all context, the project's question is not offered.
    store.widenScope();
    expect(store.barSuggestions()).toEqual(['When do we ship?', 'What did we decide this week?']);
  });

  it('shows only over a page where live matches could: signed in, the bar empty, and no answer or sheet over it', async () => {
    const store = await startStore();
    expect(store.getState().status?.account?.membership_id).toBe(ACCOUNT.membership_id);
    expect(store.suggestionsShown()).toBe(true);
    store.setBarText('ship');
    expect(store.suggestionsShown()).toBe(false);
    store.clearBar();
    expect(store.suggestionsShown()).toBe(true);
    await store.ask('When do we ship?');
    await flush();
    expect(store.suggestionsShown()).toBe(false);
  });

  it('asks a suggestion in the bar\'s scope, as if typed and sent', async () => {
    const store = await startStore();
    store.askSuggestion('What did we decide this week?');
    await flush();
    const asked = rpc.mock.calls.filter(([method]) => method === 'ask.run').map(([, params]) => params as { question: string; scope: unknown });
    expect(asked).toEqual([expect.objectContaining({ question: 'What did we decide this week?', scope: { kind: 'global' } })]);
    expect(store.getState().barText).toBe('');
  });
});
