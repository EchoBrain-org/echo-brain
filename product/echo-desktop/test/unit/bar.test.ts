// The ask bar's own words: "Try asking" for an empty bar (the questions you
// asked in the bar's scope, from the Ask timeline, each reopening its turn;
// then the meetings ECHO shows there, then the question for any week; at most
// three, each once) and the count toward a question's 240 characters.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, HomeView, ListItem, OpenItemView } from '../../src/shared/protocol.js';
import { COUNT_FROM, decidedIn, MAX_QUESTION, MAX_SUGGESTIONS, questionCount, suggestedQuestions, weekQuestion } from '../../src/renderer/bar.js';
import { ACCOUNT, EMPTY_SUMMARY, cover, fail, fileOf, flush, Held, ok, project, rpcFor, startStore, storeLifecycle, timelineFiles, uncover } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const apollo = project(1, 30, { name: 'Apollo' });
const answer: Answer = {
  scope: { kind: 'global' }, sources: [], outcome: 'answered', receipt: { looked_through: 0 },
  parts: [{ question: 'When do we ship?', status: 'answered', statements: [{ text: 'We ship on Friday.', citation_indexes: [], private: false }],
    blocks: [{ kind: 'text', statements: [0] }] }],
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
  can: { set_state: true, assign: true }, reach: 'not_read',
});
const meeting = (title: string, day: number): ListItem => ({
  ref: { kind: 'meeting', id: `sha256:${String(day).padStart(64, '0')}` }, title, added_at: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`, visibility: 'project',
  projects: ['Apollo'],
});
const note = (title: string, day: number): ListItem => ({
  ref: { kind: 'note', id: `ctx_${day}` }, title, added_at: `2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`, visibility: 'project', projects: ['Apollo'],
});

let home: HomeView;
let feed: ListItem[];
storeLifecycle(new Date('2026-10-19T11:00:00.000Z'));
beforeEach(() => {
  home = { send: [], items: [], waiting: 0 };
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

/** What the bar suggests, as words. */
const questions = (suggestions: readonly { question: string }[]) => suggestions.map(suggestion => suggestion.question);

describe('what an empty bar suggests', () => {
  it('puts the questions you asked first, then the meetings, then the question for any week, each once and at most three', () => {
    expect(MAX_SUGGESTIONS).toBe(3);
    const asked = (question: string, turn: string) => ({ question, turn });
    expect(suggestedQuestions([], [], 'What did we decide this week?')).toEqual([{ question: 'What did we decide this week?' }]);
    // One you asked reopens its turn; the others are asked.
    expect(suggestedQuestions([asked('When do we ship?', 't1')], ['Pilot planning'], 'What did we decide this week?'))
      .toEqual([{ question: 'When do we ship?', turn: 't1' }, { question: 'What did we decide in Pilot planning?' }, { question: 'What did we decide this week?' }]);
    // The same question twice (by case or spacing), or one a meeting would make again, shows once.
    expect(questions(suggestedQuestions([asked('what did we decide in pilot planning?', 't1'), asked('When  do we ship?', 't2')], ['Pilot planning', 'Pilot planning'],
      'When do we ship?'))).toEqual(['what did we decide in pilot planning?', 'When do we ship?']);
    expect(questions(suggestedQuestions(['One?', 'Two?', 'Three?', 'Four?'].map((question, at) => asked(question, `t${at}`)), ['Pilot planning'], 'What did we decide this week?')))
      .toEqual(['One?', 'Two?', 'Three?']);
    expect(questions(suggestedQuestions([], ['', 'Pilot planning'], 'What did we decide this week?')))
      .toEqual(['What did we decide in Pilot planning?', 'What did we decide this week?']);
  });

  it('asks about any week in the bar\'s own words for its scope, and keeps a long meeting name within the limit', () => {
    expect(weekQuestion({ kind: 'global' }, null)).toBe('What did we decide this week?');
    expect(weekQuestion({ kind: 'project', project_id: apollo.project_id }, 'Apollo')).toBe('What changed in Apollo this week?');
    const long = decidedIn('A'.repeat(300));
    expect(long.length).toBeLessThanOrEqual(MAX_QUESTION);
    expect(long).toMatch(/^What did we decide in A+…\?$/);
  });

  it('lists the questions you asked, from the timeline, by scope and newest first; Home\'s meetings follow, newest first', async () => {
    home = { ...home, send: [{ run_id: 'run_00000000-0000-4000-8000-000000000020', decision: decision('Pilot planning', '2026-10-08T10:00:00.000Z'), items: 2,
      kinds: ['ticket'], owners: ['Mina Patel'], finished_at: '2026-10-08T10:05:00.000Z' }], items: [item('Supplier review', '2026-10-12T10:00:00.000Z')] };
    const store = await startStore();
    await store.loadHome();
    await flush();
    expect(questions(store.barSuggestions())).toEqual(['What did we decide in Supplier review?', 'What did we decide in Pilot planning?', 'What did we decide this week?']);

    await store.ask('When do we ship?');
    await store.ask('Who leads the pilot?');
    await flush();
    expect(questions(store.barSuggestions())).toEqual(['Who leads the pilot?', 'When do we ship?', 'What did we decide in Supplier review?']);
    // Asked again, a question moves up rather than showing twice, and reopens its newest turn.
    await store.ask('when do we ship?');
    await flush();
    const turns = store.getState().timeline.turns;
    expect(store.barSuggestions()).toEqual([{ question: 'when do we ship?', turn: turns[2]!.id }, { question: 'Who leads the pilot?', turn: turns[1]!.id },
      { question: 'What did we decide in Supplier review?' }]);
    // Kept in the account's timeline on this computer, by the host, never in the page's storage.
    expect(timelineFiles.get(fileOf(ACCOUNT))?.map(turn => turn.text)).toEqual(['When do we ship?', 'Who leads the pilot?', 'when do we ship?']);
    expect(JSON.stringify(vi.mocked(localStorage.setItem).mock.calls)).not.toMatch(/ship|pilot/i);
  });

  it('reopens the turn of a question you asked, opened, instead of asking it again', async () => {
    const store = await startStore();
    await store.ask('When do we ship?');
    store.closeAsk();
    await store.ask('Who leads the pilot?');
    store.closeAsk();
    const [first] = store.getState().timeline.turns;
    const asked = rpc.mock.calls.filter(([method]) => method === 'ask.run').length;
    const suggestion = store.barSuggestions().find(each => each.question === 'When do we ship?')!;
    expect(suggestion.turn).toBe(first!.id);
    store.pickSuggestion(suggestion);
    await flush();
    expect(rpc.mock.calls.filter(([method]) => method === 'ask.run')).toHaveLength(asked);
    expect(store.getState().ask).toMatchObject({ opened: first!.id, focus: first!.id, asked: [] });
    // The latest is in full already: it stays so, brought into view, and is the turn the next question continues.
    const latest = store.barSuggestions().find(each => each.question === 'Who leads the pilot?')!;
    store.closeAsk();
    store.pickSuggestion(latest);
    expect(store.getState().ask).toMatchObject({ opened: latest.turn, focus: latest.turn });
    expect(store.getState().ask?.latest).toBe(latest.turn);
  });

  it('keeps a project\'s questions and meetings to its own bar, and offers them on Home\'s too, which holds every question (ADR-0049)', async () => {
    feed = [meeting('Apollo kickoff', 14), note('Pricing memo', 13), meeting('Apollo readout', 9)];
    const store = await startStore();
    await store.ask('When do we ship?');
    await flush();
    await store.openProject(apollo);
    await flush();
    expect(store.getState().barScope).toEqual({ kind: 'project', project_id: apollo.project_id });
    expect(questions(store.barSuggestions())).toEqual(['What did we decide in Apollo kickoff?', 'What did we decide in Apollo readout?', 'What changed in Apollo this week?']);
    await store.ask('What is left for launch?');
    await flush();
    expect(store.barSuggestions()[0]?.question).toBe('What is left for launch?');
    // Back in all context: Home's thread holds every question, the project's newest first.
    store.widenScope();
    expect(questions(store.barSuggestions())).toEqual(['What is left for launch?', 'When do we ship?', 'What did we decide this week?']);
  });

  it('shows only over a page: signed in, the bar empty, and no answer or sheet over it', async () => {
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

describe('the bar only asks (DSK-23)', () => {
  it('sends nothing as you type, and keeps its text over a reader, another app and a capture, and on a sidebar click, which narrows its scope', async () => {
    feed = [note('Apollo update', 14)];
    const fallback = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method, params) => method === 'open.ref' ? ok({ kind: 'note', content: { context_id: 'ctx_14', title: 'Apollo update',
      text: 'We agreed to ship.', received_at: '2026-10-14T09:00:00.000Z', audience: 'project', project_ids: [] } }) : fallback(method, params));
    const store = await startStore();
    const before = rpc.mock.calls.length;
    store.setBarText('apollo');
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    // What you type leaves the page only when you ask it.
    expect(JSON.stringify(rpc.mock.calls.slice(before))).not.toContain('apollo');
    cover(store);
    expect(store.pageCovered()).toBe(true);
    expect(store.getState().barText).toBe('apollo');
    await uncover(store);
    await flush();
    expect(store.getState().barText).toBe('apollo');
    store.openCapture();
    store.closeCompose();
    expect(store.getState().barText).toBe('apollo');
    await store.openProject(apollo);
    await flush();
    expect(store.getState().barScope).toEqual({ kind: 'project', project_id: apollo.project_id });
    expect(store.getState().barText).toBe('apollo');
    // A row read in place stays while you type over it.
    await store.openListItem(store.getState().list!.items[0]!);
    store.setBarText('apollo update');
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(store.getState().reader?.content?.title).toBe('Apollo update');
    expect(JSON.stringify(rpc.mock.calls.slice(before))).not.toContain('apollo update');
  });

  it('loses its text when a read is refused for lost access, and keeps it through an outage', async () => {
    feed = [note('Apollo update', 14)];
    let refusal = fail('unavailable', { retryable: true });
    const fallback = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method, params) => method === 'open.ref' ? refusal : fallback(method, params));
    const store = await startStore();
    await store.openProject(apollo);
    await flush();
    const row = store.getState().list!.items[0]!;
    store.setBarText('apollo');
    await store.openListItem(row);
    expect(store.getState().reader?.failure?.code).toBe('unavailable');
    expect(store.getState().barText).toBe('apollo');
    // Gone, or no longer yours: a real change of access, so what was typed under the old access goes.
    for (const code of ['not_found', 'unauthorized']) {
      refusal = fail(code);
      store.setBarText('apollo');
      await store.openListItem(row);
      await flush();
      expect(store.getState().reader?.failure?.code, code).toBe(code);
      expect(store.getState().barText, code).toBe('');
    }
  });
});
