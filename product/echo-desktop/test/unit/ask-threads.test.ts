// Ask threads (ADR-0056, Ask threads v1), in the rules and in the store: which thread a turn belongs to, a thread's home
// and name, what an Ask carries of the other threads and of its own thread's older turns and how that is cut to fit;
// where an answer lands; the jump, "Which one?" between threads and "New question"; merging and its Undo; and the way
// out of every wait (cancel, failure, another account, a page change, closing Ask, the timeline read again).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonAnswerCitationV8 } from '@echo-brain/organization-api';
import type { Answer, AnswerSource, AnswerStatement, AppStatus, AskPrevious, AskScope, AskThread, TimelineTurn } from '../../src/shared/protocol.js';
import { MAX_REQUEST_BYTES } from '../../src/shared/protocol.js';
import {
  askCarries, earlierOf, homeTurns, mergeable, otherThreads, ownWords, sameScope, threadGroups, threadIds, threadsOf, undoable, type AskEarlierTurn, type Thread,
} from '../../src/renderer/timeline.js';
import { paragraphs } from '../fixtures/authority.js';
import {
  ACCOUNT, byTestId, click, fail, fileOf, flush, Held, numbered, ok, plainHooks, project, render, rpcFor, startStore, storeLifecycle, text, timelineFiles,
} from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
// Components are called as plain functions below.
vi.mock('preact/hooks', original => plainHooks(original));

const NOW = new Date('2026-10-25T15:00:00.000Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const GLOBAL = { kind: 'global' } as const;
const apollo = project(1, 30, { name: 'Apollo' });
const zephyr = project(2, 29, { name: 'Zephyr' });
const inApollo = { kind: 'project' as const, project_id: apollo.project_id };
const inZephyr = { kind: 'project' as const, project_id: zephyr.project_id };
const sha = (text: string) => `sha256:${[...text].map(character => character.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64)}` as const;

/** A ticket as an answer cites it. */
function ticket(key: string, id: string): AnswerSource {
  const permalink = `https://example.atlassian.net/browse/${key}`;
  const citation = { kind: 'ticket', tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: id, permalink, text_sha256: sha(key) } as const;
  const cited: PersonAnswerCitationV8 = { citation, kind: 'ticket', label: `${key} · Sensor drift`, visibility: 'only_me' };
  return { kind: 'ticket', tool_id: 'jira', label: `${key} · Sensor drift`, permalink, private: true, cited };
}
const said = (words: string, citation_indexes: number[]): AnswerStatement => ({ text: words, citation_indexes, private: true });

/** An answer in `scope` of two sentences: one citing THERM-482, one citing THERM-490. */
function answerOf(question: string, scope: AskScope = GLOBAL, extra: Partial<Answer> = {}): Answer {
  const statements = [said(`THERM-482 answers "${question}".`, [0]), said(`THERM-490 adds to "${question}".`, [1])];
  return { scope, sources: [ticket('THERM-482', '20482'), ticket('THERM-490', '20490')], outcome: 'answered', receipt: { looked_through: 0 },
    parts: [{ question, status: 'answered', statements, blocks: paragraphs(statements) }], ...extra };
}

let ids = 0;
/** A turn the person typed, asked `ago` before NOW, as a desktop with threads saves one. */
function turn(question: string, ago: number, extra: Partial<TimelineTurn> = {}): TimelineTurn {
  ids += 1;
  const id = `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
  const scope = extra.scope ?? GLOBAL;
  return { id, asked_at: new Date(NOW.getTime() - ago).toISOString(), text: question, question, scope, answer: answerOf(question, scope), citations_complete: true,
    typed: question, follows: null, thread: id, ...extra };
}

/** A thread living in `home`: its questions with how long ago each was asked, each following the one before. */
function threadIn(home: AskScope, ...asked: readonly (readonly [string, number])[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  for (const [question, ago] of asked) {
    const first = turns[0]?.id;
    turns.push(turn(question, ago, { scope: home, follows: turns.at(-1)?.id ?? null, ...(first === undefined ? {} : { thread: first }) }));
  }
  return turns;
}

/** The timeline as the rules read it: its threads, by the first question typed in each. */
const named = (turns: readonly TimelineTurn[]) => Object.fromEntries(threadsOf(turns).map(thread => [thread.name, thread]));

let held: Held;
let checks: ((items: readonly { asked_at: string; citation: { kind: string; ticket_id?: string } }[]) => unknown) | null;
/** What `ask.run` answers, by the request: null for a plain answer. */
let script: ((params: Record<string, unknown>) => unknown) | null;
/** The turns a `timeline.put` fails for, by id. */
let unsaved: Set<string>;
/** The turns a `timeline.put` is taken for by the file and never answered, by id. */
let unknown: Set<string>;
/** Whether the timeline's file cannot be read. */
let unread: boolean;
let app: AppStatus;
let active = [apollo, zephyr];
/** The person's archived projects: read by id like any other. */
let archived: (typeof apollo)[] = [];
storeLifecycle(NOW);
beforeEach(() => {
  ids = 0;
  held = new Held();
  checks = items => ok({ items: items.map(() => ({ state: 'same' })) });
  script = null;
  unsaved = new Set();
  unknown = new Set();
  unread = false;
  app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  active = [apollo, zephyr];
  archived = [];
  rpc.mockReset();
  const base = rpcFor(held, {
    'app.status': () => ok(app),
    'ask.run': params => script?.(params) ?? ok(answerOf(String(params.question), params.scope as AskScope)),
    'ask.check': params => (checks ? checks(params.items as never) : fail('not_supported')),
    'ask.record': () => fail('not_found'),
    'projects.read': params => { const found = [...active, ...archived].find(item => item.project_id === params.project_id); return found ? ok(found) : fail('not_found'); },
  }, () => ({ active, archived }));
  rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'timeline.read' && unread) return fail('unavailable', { retryable: true });
    if (method !== 'timeline.put') return base(method, params);
    const { id } = params.turn as TimelineTurn;
    if (unsaved.has(id)) return fail('invalid_output');
    const reply = await base(method, params);
    if (unknown.has(id)) throw new Error('the reply was lost');
    return reply;
  });
});

const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params as Record<string, unknown>);
const asked = () => calls('ask.run');
const seed = (...turns: TimelineTurn[]) => { timelineFiles.set(fileOf(ACCOUNT), turns); };
const kept = () => timelineFiles.get(fileOf(ACCOUNT)) ?? [];
/** Each kept turn's thread, by what was typed for it. */
const filed = () => Object.fromEntries(kept().map(each => [each.text, each.thread]));
type Store = Awaited<ReturnType<typeof startStore>>;
async function page(store: Store) {
  const screens = await import('../../src/renderer/screens/ask.js');
  return render(screens.AskView({ state: store.getState() }));
}
const questions = async (store: Store) => byTestId(await page(store), 'question').map(text);
/** A clarify answer naming the threads at `places` of those sent, as the host hands one to the page. */
const elsewhere = (params: Record<string, unknown>, places: readonly number[], extra: Partial<Answer> = {}) => ok({ scope: params.scope, sources: [], parts: [], outcome: 'clarify',
  receipt: { looked_through: 0 }, question: String(params.question), thread: { kind: 'other', threads: places }, ...extra });
/** Where, among the threads a request sent, the one whose first typed question is `name` is. */
const placeOf = (params: Record<string, unknown>, name: string) => (params.threads as AskThread[]).findIndex(thread => thread.questions[0] === name);

describe('which thread a turn belongs to, and what a thread is (R8)', () => {
  it('groups turns by the thread they name, in the order the threads were started, each with its turns oldest first', () => {
    const [a1, a2] = threadIn(GLOBAL, ['When does Apollo launch?', 3 * DAY], ['did that change?', DAY]);
    const [b1] = threadIn(GLOBAL, ['Who owns billing?', 2 * DAY]);
    const threads = threadsOf([a1!, b1!, a2!]);
    expect(threads.map(thread => [thread.id, thread.turns.map(each => each.id), thread.asked_at])).toEqual([[a1!.id, [a1!.id, a2!.id], a2!.asked_at], [b1!.id, [b1!.id], b1!.asked_at]]);
  });

  it('puts a turn saved before threads in the thread of the turn it followed or asked again, while that one is kept and was asked in the same place', () => {
    const old = (question: string, ago: number, extra: Partial<TimelineTurn> = {}) => {
      const { thread: _thread, ...rest } = turn(question, ago, extra);
      return rest;
    };
    const first = old('What is open?', 5 * DAY);
    const next = old('who owns it?', 4 * DAY, { follows: first.id });
    const third = old('and when?', 3 * DAY, { follows: next.id });
    // Asked again before `follows` was kept: only `again_of` says what it came from.
    const { follows: _follows, ...again } = old('What is open?', 2 * DAY, { again_of: first.id });
    // Followed a turn asked in another place (Ask everywhere), one no longer kept, and nothing: each starts its own.
    const everywhere = old('What is open?', 2 * DAY, { follows: old('In the project?', 6 * DAY, { scope: inApollo }).id });
    const elsewhere = old('What is left in Apollo?', DAY, { scope: inApollo, follows: third.id });
    const orphan = old('and then?', DAY, { follows: '00000000-0000-4000-8000-00000000ffff' });
    const alone = old('Something else?', HOUR);
    const ids = threadIds([first, next, third, again, everywhere, elsewhere, orphan, alone]);
    expect([first, next, third, again].map(each => ids.get(each.id))).toEqual(Array(4).fill(first.id));
    for (const each of [everywhere, elsewhere, orphan, alone]) expect(ids.get(each.id)).toBe(each.id);
    // A turn saved since names its thread, and an older turn that followed it goes where it says.
    const labelled = turn('Named?', 5 * DAY, { thread: alone.id });
    const after = old('after it?', DAY, { follows: labelled.id });
    expect(threadIds([labelled, after, alone]).get(after.id)).toBe(alone.id);
    // Two old turns that name each other end where they do, and nothing loops.
    const [one, two] = [old('One?', DAY), old('Two?', DAY)];
    expect([...threadIds([{ ...one, follows: two.id }, { ...two, follows: one.id }]).values()]).toHaveLength(2);
  });

  it('gives a thread the home of its first turn, or of its oldest once that one is gone, wherever its other turns were asked', () => {
    const [a1, a2] = threadIn(inApollo, ['What is left in Apollo?', 3 * DAY], ['and who owns it?', 2 * DAY]);
    // No desktop saves one so (R9); a file can still hold it.
    const stray = turn('Asked at Home, kept in Apollo\'s thread', DAY, { thread: a1!.id });
    expect(threadsOf([a1!, a2!, stray])[0]!.home).toEqual(inApollo);
    // The first turn gone (the file let its oldest go): the oldest left says where it lives.
    expect(threadsOf([a2!, stray])[0]).toMatchObject({ id: a1!.id, home: inApollo });
    expect(threadsOf([stray])[0]).toMatchObject({ id: a1!.id, home: GLOBAL });
  });

  it('lets a question build on a thread only where the thread lives, and only on its turns asked there (R9)', () => {
    const [a1, a2] = threadIn(inApollo, ['What is left in Apollo?', 3 * DAY], ['and who owns it?', 2 * DAY]);
    const stray = turn('Asked at Home, kept in Apollo\'s thread', DAY, { thread: a1!.id });
    const [thread] = threadsOf([a1!, a2!, stray]);
    expect(homeTurns(thread, inApollo).map(each => each.id)).toEqual([a1!.id, a2!.id]);
    // Anywhere else, and with no thread, there is nothing to build on.
    for (const scope of [GLOBAL, inZephyr]) expect(homeTurns(thread, scope)).toEqual([]);
    expect(homeTurns(undefined, GLOBAL)).toEqual([]);
    // What is sent of the thread is what was typed in its home: the stray turn's words never ride into Apollo's requests.
    expect(thread!.questions).toEqual(['What is left in Apollo?', 'and who owns it?']);
  });

  it('lets a thread merge only into another that lives where it does (R9)', () => {
    const { 'What is left in Apollo?': left, 'Which tests fail?': tests, 'Who owns billing?': billing, 'What is blocked?': blocked } = named([
      ...threadIn(inApollo, ['What is left in Apollo?', 3 * DAY]), ...threadIn(inApollo, ['Which tests fail?', 2 * DAY]),
      ...threadIn(GLOBAL, ['Who owns billing?', DAY]), ...threadIn(inZephyr, ['What is blocked?', HOUR])]);
    expect(mergeable(tests!, left)).toBe(true);
    for (const other of [billing!, blocked!]) {
      expect(mergeable(other, left)).toBe(false);
      expect(mergeable(left!, other)).toBe(false);
    }
    // Never into itself, and never with no thread open.
    expect(mergeable(left!, left)).toBe(false);
    expect(mergeable(tests!, undefined)).toBe(false);
  });

  it('names a thread by the first question typed in it, never by a question a model wrote (R2)', () => {
    const first = turn('what is open?', 5 * DAY);
    // A follow-up: the person typed "who owns it?", and the answer answered a question the resolver wrote.
    const followUp = turn('Who owns THERM-482?', 4 * DAY, { text: 'who owns it?', typed: 'who owns it?', follows: first.id, thread: first.id });
    // A choice of "Which one?": what was asked was the model's, kept as its text; what the person typed is kept beside it.
    const choice = turn('What are the details on THERM-490?', 3 * DAY, { text: 'What are the details on THERM-490?', typed: 'what about that one?', follows: followUp.id, thread: first.id });
    // Ask again of the follow-up asks the model's question; it keeps the words typed for the turn it asked again.
    const again = turn('Who owns THERM-482?', 2 * DAY, { text: 'Who owns THERM-482?', typed: 'who owns it?', follows: followUp.id, again_of: followUp.id, thread: first.id });
    expect([first, followUp, choice, again].map(ownWords)).toEqual(['what is open?', 'who owns it?', 'what about that one?', 'who owns it?']);
    const [thread] = threadsOf([first, followUp, choice, again]);
    expect(thread!.name).toBe('what is open?');
    // Each question the thread shows once: the follow-up was asked again, and the newer stands for it.
    expect(thread!.questions).toEqual(['what is open?', 'what about that one?', 'who owns it?']);
    expect(JSON.stringify([thread!.name, thread!.questions])).not.toMatch(/THERM-4/u);
    // A thread whose first turn is a follow-up's answer is still named by what was typed.
    expect(threadsOf([{ ...followUp, thread: followUp.id }])[0]).toMatchObject({ name: 'who owns it?', questions: ['who owns it?'] });
  });

  it('never takes the text of a turn that does not say it followed nothing as the person\'s words: such a thread is named by its heading and sends nothing', () => {
    // Saved before the typed words and what a turn followed were kept: its text may be a choice of "Which one?".
    const { typed: _typed, follows: _follows, ...legacy } = turn('What are the details on THERM-490?', 5 * DAY);
    expect(ownWords(legacy)).toBeUndefined();
    expect(threadsOf([legacy])[0]).toMatchObject({ name: 'What are the details on THERM-490?', questions: [] });
    expect(otherThreads(threadsOf([legacy]), GLOBAL, null)).toEqual([]);
    // Known to have followed nothing, and not an Ask again, its text is what was typed.
    expect(ownWords({ ...legacy, follows: null })).toBe('What are the details on THERM-490?');
    expect(ownWords({ ...legacy, follows: null, again_of: legacy.id })).toBeUndefined();
    expect(ownWords({ ...legacy, follows: legacy.id })).toBeUndefined();
    // Once a question is typed in that thread it has words to send: those, and still not the old text.
    const next = turn('and who owns it?', DAY, { follows: legacy.id, thread: legacy.id });
    expect(threadsOf([legacy, next])[0]).toMatchObject({ name: 'and who owns it?', questions: ['and who owns it?'] });
  });
});

describe('what an Ask carries of the threads (R3, R6, R7)', () => {
  const timeline = () => {
    const home = threadIn(GLOBAL, ['When does the pilot start?', 6 * DAY], ['did that change?', 2 * DAY]);
    const billing = threadIn(GLOBAL, ['Who owns billing?', 5 * DAY]);
    const launch = threadIn(inApollo, ['What is left in Apollo?', 4 * DAY], ['and who owns it?', DAY]);
    const tests = threadIn(inApollo, ['Which tests fail?', 3 * DAY]);
    const other = threadIn(inZephyr, ['What is Zephyr waiting on?', HOUR]);
    return [...home, ...billing, ...launch, ...tests, ...other];
  };
  const names = (threads: readonly Thread[]) => threads.map(thread => thread.name);

  it('carries every other thread in all context, only the project\'s own in a project, most recently asked first, and never the one continued', () => {
    const turns = timeline();
    const threads = threadsOf(turns);
    const by = named(turns);
    expect(names(otherThreads(threads, GLOBAL, by['When does the pilot start?']!.id))).toEqual(['What is Zephyr waiting on?', 'What is left in Apollo?', 'Which tests fail?', 'Who owns billing?']);
    // Asked from a page it continues none: every thread is a candidate.
    expect(names(otherThreads(threads, GLOBAL, null))).toEqual(['What is Zephyr waiting on?', 'What is left in Apollo?', 'When does the pilot start?', 'Which tests fail?', 'Who owns billing?']);
    // A project Ask: nothing from outside the project rides on it.
    expect(names(otherThreads(threads, inApollo, null))).toEqual(['What is left in Apollo?', 'Which tests fail?']);
    expect(names(otherThreads(threads, inApollo, by['What is left in Apollo?']!.id))).toEqual(['Which tests fail?']);
    expect(otherThreads(threads, inZephyr, by['What is Zephyr waiting on?']!.id)).toEqual([]);
  });

  it('sends each thread as the questions typed in it, oldest first, and when it was last asked in, and nothing else', () => {
    const turns = timeline();
    const { threads, sent } = askCarries('and the budget?', GLOBAL, null, [], otherThreads(threadsOf(turns), GLOBAL, null).slice(1, 3));
    expect(threads).toEqual([
      { questions: ['What is left in Apollo?', 'and who owns it?'], asked_at: turns[4]!.asked_at },
      { questions: ['When does the pilot start?', 'did that change?'], asked_at: turns[1]!.asked_at },
    ]);
    expect(sent).toEqual([turns[3]!.id, turns[0]!.id]);
    // A question to be placed carries the list even when it is empty, so its answer can still say it starts a thread; one
    // that is not to be placed carries none at all.
    expect(askCarries('and the budget?', GLOBAL, null, [], [])).toEqual({ threads: [], sent: [] });
    expect(askCarries('and the budget?', GLOBAL, null, [], null)).toEqual({ sent: [] });
  });

  it('carries the thread\'s older turns by the person\'s own words, each sentence only when every source it cites was found readable', () => {
    const [first, second, third] = threadIn(GLOBAL, ['what is open?', 3 * DAY], ['who owns it?', 2 * DAY], ['and when?', DAY]);
    const resolved = { ...second!, question: 'Who owns THERM-482?' };
    const all = { 0: 'same', 1: 'same' } as const;
    const thread = [first!, resolved, third!];
    const carried = (found: Parameters<typeof earlierOf>[2], before = third!) => earlierOf(thread, before, found);
    // Before the turn continued, oldest first, each with when it was asked.
    expect(carried({ [first!.id]: all, [second!.id]: all }).map(each => [each.question, each.asked_at, each.statements.length, each.citations.length]))
      .toEqual([['what is open?', first!.asked_at, 2, 2], ['who owns it?', second!.asked_at, 2, 2]]);
    // Never the question a model wrote for it.
    expect(JSON.stringify(carried({ [first!.id]: all, [second!.id]: all }).map(each => each.question))).not.toContain('THERM-482');
    // A sentence whose source is not known readable stays behind, with its citation; the others go, renumbered.
    const [partly] = carried({ [first!.id]: { 0: 'unreadable', 1: 'same' } });
    expect(partly).toEqual({ question: 'what is open?', asked_at: first!.asked_at, statements: [{ text: 'THERM-490 adds to "what is open?".', citation_indexes: [0] }],
      citations: [first!.answer.sources[1]!.cited] });
    expect(JSON.stringify(carried({ [first!.id]: { 0: 'unknown', 1: 'same' } })[0])).not.toContain('THERM-482');
    // Nothing known of a turn, or no check at all: its question only.
    expect(carried({ [first!.id]: all })[1]).toEqual({ question: 'who owns it?', asked_at: second!.asked_at, statements: [], citations: [] });
    expect(carried(null).map(each => each.statements)).toEqual([[], []]);
    // A turn an older desktop saved may rest on a row it no longer cites: its question only, whatever a check says.
    const { citations_complete: _mark, ...unmarked } = first!;
    expect(earlierOf([unmarked, resolved, third!], third!, { [first!.id]: all })[0]!.statements).toEqual([]);
    // A turn with no words of the person's is left out; the turn continued and those after it are never older turns.
    const { typed: _typed, follows: _follows, ...legacy } = first!;
    expect(earlierOf([legacy, resolved, third!], third!, null).map(each => each.question)).toEqual(['who owns it?']);
    expect(carried(null, resolved).map(each => each.question)).toEqual(['what is open?']);
    expect(carried(null, first!)).toEqual([]);
  });

  it('leaves out the least recently asked threads first, then the oldest older turns, when the request would pass its body\'s bound, with no count of its own', () => {
    const previous: AskPrevious = { purpose: 'follow_up', question: 'and when?', asked_at: NOW.toISOString(), statements: [], citations: [] };
    const older = (at: number, size: number): AskEarlierTurn => ({ question: `Older ${at}? ${'x'.repeat(size)}`, asked_at: NOW.toISOString(), statements: [], citations: [] });
    const other = (at: number, size: number): Thread => ({ id: `thread-${at}`, turns: [], home: GLOBAL, name: `Thread ${at}?`, questions: [`Thread ${at}? ${'y'.repeat(size)}`],
      asked_at: new Date(NOW.getTime() - at * HOUR).toISOString() });
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const body = (carries: ReturnType<typeof askCarries>) => bytes({ schema_version: 3, question: 'q?', ...(carries.previous ? { previous: carries.previous } : {}),
      ...(carries.threads ? { threads: carries.threads } : {}) });
    // Hundreds of threads and turns that fit all go: nothing counts them.
    const many = askCarries('q?', GLOBAL, previous, Array.from({ length: 300 }, (_, at) => older(at, 10)), Array.from({ length: 400 }, (_, at) => other(at, 10)));
    expect([many.previous!.earlier, many.threads, many.sent].map(list => list!.length)).toEqual([300, 400, 400]);
    // Ten threads of 200 KB and three older turns of 100 KB: threads go from the end until the rest fits; every turn stays.
    const turns = [older(0, 100_000), older(1, 100_000), older(2, 100_000)];
    const cut = askCarries('q?', GLOBAL, previous, turns, Array.from({ length: 10 }, (_, at) => other(at, 200_000)));
    expect(cut.sent).toEqual(['thread-0', 'thread-1', 'thread-2']);
    expect(cut.threads!.map(thread => thread.questions[0]!.slice(0, 9))).toEqual(['Thread 0?', 'Thread 1?', 'Thread 2?']);
    expect(cut.previous!.earlier).toEqual(turns);
    expect(body(cut)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    // Older turns alone past the bound: every thread is gone before a turn is, and turns go from the oldest.
    const long = Array.from({ length: 5 }, (_, at) => older(at, 300_000));
    const fewer = askCarries('q?', GLOBAL, previous, long, [other(0, 10)]);
    // The list still goes, empty: the question is still one to be placed.
    expect(fewer.threads).toEqual([]);
    expect(fewer.sent).toEqual([]);
    expect(fewer.previous!.earlier!.map(each => each.question.slice(0, 8))).toEqual(['Older 2?', 'Older 3?', 'Older 4?']);
    expect(body(fewer)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    // Nothing older fits: the previous turn goes as it is, with no empty list of older turns in it.
    expect(askCarries('q?', GLOBAL, previous, [older(0, 2_000_000)], null)).toEqual({ previous, sent: [] });
    // With no previous turn there is nothing an older turn could ride on.
    expect(askCarries('q?', GLOBAL, null, turns, [other(0, 10)])).toEqual({ threads: [{ questions: other(0, 10).questions, asked_at: other(0, 10).asked_at }], sent: ['thread-0'] });
  });

  it('lists every thread by home, the open thread\'s first, then no project, then projects by the one asked in most recently, and finds by any question typed', () => {
    const turns = timeline();
    const threads = threadsOf(turns);
    const by = named(turns);
    const shown = (open: Thread | undefined, find = '') => threadGroups(threads, open, find).map(group => [group.home.kind === 'project' ? group.home.project_id : null, names(group.threads)]);
    expect(shown(by['Which tests fail?'])).toEqual([
      [apollo.project_id, ['What is left in Apollo?', 'Which tests fail?']],
      [null, ['When does the pilot start?', 'Who owns billing?']],
      [zephyr.project_id, ['What is Zephyr waiting on?']],
    ]);
    // With no thread open, or one with no project: no project first, then the projects, Zephyr's asked in last.
    for (const open of [undefined, by['Who owns billing?']]) {
      expect(shown(open).map(([home]) => home)).toEqual([null, zephyr.project_id, apollo.project_id]);
    }
    // Find: any question typed in a thread, in any case; a group with no match is not listed.
    expect(shown(undefined, '  WHO OWNS ')).toEqual([[null, ['Who owns billing?']], [apollo.project_id, ['What is left in Apollo?']]]);
    expect(shown(undefined, 'nothing like it')).toEqual([]);
  });

  it('says Undo still holds only while every turn the merge moved is still kept in the thread it was merged into', () => {
    const [a1] = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
    const [b1, b2] = threadIn(GLOBAL, ['Who owns billing?', 2 * DAY], ['and when?', DAY]);
    const moved = [{ turn: b1!.id, from: b1!.id }, { turn: b2!.id, from: b1!.id }];
    const merged = [a1!, { ...b1!, thread: a1!.id }, { ...b2!, thread: a1!.id }];
    expect(undoable(moved, a1!.id, threadIds(merged))).toBe(true);
    // One moved again, one gone, and a merge that moved nothing.
    expect(undoable(moved, a1!.id, threadIds([a1!, merged[1]!, { ...b2!, thread: b2!.id }]))).toBe(false);
    expect(undoable(moved, a1!.id, threadIds([a1!, merged[1]!]))).toBe(false);
    expect(undoable([], a1!.id, threadIds(merged))).toBe(false);
  });
});

describe('where a question goes and where its answer lands (ADR-0056)', () => {
  /** Two threads with no project, Apollo's the one asked in last, and one in Apollo. */
  const seeded = () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY], ['when is it due?', 5 * DAY]);
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY], ['did that change?', 2 * DAY], ['who decided?', DAY]);
    seed(...billing, ...tests, ...pilot);
    return { billing, tests, pilot };
  };

  it('asked from a page, carries no earlier turn, only the person\'s threads, and its answer starts a thread, which Ask then shows', async () => {
    const { billing, tests, pilot } = seeded();
    const store = await startStore();
    await store.ask('What is new this week?');
    await flush();
    expect(asked()[0]).not.toHaveProperty('previous');
    expect(asked()[0]!.threads).toEqual([
      { questions: ['When does the pilot start?', 'did that change?', 'who decided?'], asked_at: pilot[2]!.asked_at },
      { questions: ['Which tests fail?'], asked_at: tests[0]!.asked_at },
      { questions: ['Who owns billing?', 'when is it due?'], asked_at: billing[1]!.asked_at },
    ]);
    const saved = kept().at(-1)!;
    expect(saved).toMatchObject({ text: 'What is new this week?', thread: saved.id, follows: null });
    expect(store.threadShown()).toMatchObject({ id: saved.id, name: 'What is new this week?', home: GLOBAL });
    expect(await questions(store)).toEqual(['What is new this week?']);
    expect(byTestId(await page(store), 'timeline-row')).toEqual([]);
    expect(text(byTestId(await page(store), 'thread-name')[0])).toBe('What is new this week?');
  });

  it('shows no thread name with nothing asked yet, and "New thread" while a first question of a new thread is on its way', async () => {
    const store = await startStore();
    const release = held.hold('ask.run');
    void store.ask('First ever?');
    await flush();
    expect(asked()[0]!.threads).toEqual([]);
    expect(byTestId(await page(store), 'thread-name')).toEqual([]);
    release(ok(answerOf('First ever?')));
    await flush();
    expect(text(byTestId(await page(store), 'thread-name')[0])).toBe('First ever?');
    // From a page again: no thread is open while the question is on its way.
    store.closeAsk();
    const next = held.hold('ask.run');
    void store.ask('Another subject?');
    await flush();
    expect(store.threadShown()).toBeUndefined();
    expect(text(byTestId(await page(store), 'thread-name')[0])).toBe('New thread');
    expect(await questions(store)).toEqual(['Another subject?']);
    next(ok(answerOf('Another subject?')));
    await flush();
    expect(text(byTestId(await page(store), 'thread-name')[0])).toBe('Another subject?');
  });

  it('with Ask open on a thread, continues it: the previous turn, the thread\'s older turns from one fresh check, and the other threads; the answer is saved in it', async () => {
    const { billing, tests, pilot } = seeded();
    const store = await startStore();
    expect(await store.openThread(pilot[0]!.id)).toBe(true);
    await flush();
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
    const checked = calls('ask.check').length;
    await store.ask('and the budget?');
    await flush();
    const sent = asked()[0]!;
    const previous = sent.previous as AskPrevious;
    expect(previous).toMatchObject({ purpose: 'follow_up', question: 'who decided?', asked_at: pilot[2]!.asked_at });
    expect(previous.statements).toHaveLength(2);
    expect(previous.earlier!.map(each => [each.question, each.asked_at, each.statements.length])).toEqual([
      ['When does the pilot start?', pilot[0]!.asked_at, 2], ['did that change?', pilot[1]!.asked_at, 2]]);
    // The open thread is the previous turn's: it is not among the others.
    expect(sent.threads).toEqual([
      { questions: ['Which tests fail?'], asked_at: tests[0]!.asked_at }, { questions: ['Who owns billing?', 'when is it due?'], asked_at: billing[1]!.asked_at }]);
    // One check, made for this question, covers the turn it continues and every older turn it carries.
    expect(calls('ask.check')).toHaveLength(checked + 1);
    expect(new Set((calls('ask.check').at(-1)!.items as { asked_at: string }[]).map(item => item.asked_at))).toEqual(new Set(pilot.map(each => each.asked_at)));
    expect(kept().at(-1)).toMatchObject({ text: 'and the budget?', thread: pilot[0]!.id, follows: pilot[2]!.id });
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
    expect(await questions(store)).toEqual(['who decided?', 'and the budget?']);
  });

  it('carries no sentence of an older turn whose source the fresh check did not find readable (R6)', async () => {
    const { pilot } = seeded();
    // THERM-482 is no longer the person's to read, in the pilot thread's first turn only.
    checks = items => ok({ items: items.map(item => ({ state: item.asked_at === pilot[0]!.asked_at && item.citation.ticket_id === '20482' ? 'unreadable' : 'same' })) });
    const store = await startStore();
    await store.openThread(pilot[0]!.id);
    await flush();
    await store.ask('and the budget?');
    const { earlier } = asked()[0]!.previous as AskPrevious;
    expect(earlier![0]!.statements.map(statement => statement.text)).toEqual(['THERM-490 adds to "When does the pilot start?".']);
    expect(JSON.stringify(earlier![0])).not.toContain('THERM-482');
    expect(earlier![1]!.statements).toHaveLength(2);
    // The check fails: every turn goes by its question alone.
    checks = () => fail('unavailable', { retryable: true });
    await store.ask('and the owner?');
    const failed = asked()[1]!.previous as AskPrevious;
    expect([failed.statements, ...failed.earlier!.map(each => each.statements)]).toEqual([[], [], [], []]);
    expect(failed.earlier!.map(each => each.question)).toEqual(['When does the pilot start?', 'did that change?', 'who decided?']);
  });

  it('starts a thread when the answer says the subject is new, and shows that one', async () => {
    const { pilot } = seeded();
    script = params => (params.question === 'What is the lunch order?' ? ok({ ...answerOf(String(params.question)), thread: { kind: 'new' } }) : null);
    const store = await startStore();
    await store.openThread(pilot[0]!.id);
    await flush();
    await store.ask('What is the lunch order?');
    await flush();
    const saved = kept().at(-1)!;
    expect(saved).toMatchObject({ text: 'What is the lunch order?', thread: saved.id });
    expect(saved.answer).not.toHaveProperty('thread');
    expect(store.threadShown()).toMatchObject({ id: saved.id, name: 'What is the lunch order?' });
    expect(await questions(store)).toEqual(['What is the lunch order?']);
    // The thread it was typed in is as it was, and the next question continues the new one.
    expect(filed()['who decided?']).toBe(pilot[0]!.id);
    await store.ask('and for Friday?');
    expect(asked()[1]!.previous).toMatchObject({ question: 'What is the lunch order?' });
    expect(kept().at(-1)!.thread).toBe(saved.id);
  });

  it('jumps without asking when the question belongs to one other thread that lives where it was asked, and asks the same words there with no thread riding', async () => {
    const { billing, pilot } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Who owns billing?')]) : null);
    const store = await startStore();
    await store.openThread(pilot[0]!.id);
    await flush();
    const route = store.getState().route;
    await store.ask('who approves the invoices?');
    await flush();
    expect(asked()).toHaveLength(2);
    expect(asked()[0]).toMatchObject({ question: 'who approves the invoices?', previous: { question: 'who decided?' } });
    expect(asked()[0]!.threads).toBeDefined();
    // Asked again in the thread it belongs to: a plain follow-up of that thread, which nothing can place elsewhere.
    expect(asked()[1]).toMatchObject({ question: 'who approves the invoices?', scope: GLOBAL, previous: { purpose: 'follow_up', question: 'when is it due?' } });
    expect(asked()[1]).not.toHaveProperty('threads');
    expect((asked()[1]!.previous as AskPrevious).earlier!.map(each => each.question)).toEqual(['Who owns billing?']);
    expect(store.threadShown()?.id).toBe(billing[0]!.id);
    expect(store.getState().route).toBe(route);
    expect(kept().at(-1)).toMatchObject({ text: 'who approves the invoices?', typed: 'who approves the invoices?', thread: billing[0]!.id, follows: billing[1]!.id });
    expect(kept()).toHaveLength(7);
    expect(await questions(store)).toEqual(['when is it due?', 'who approves the invoices?']);
    // The thread it was typed in keeps its turns.
    expect(pilot.map(each => filed()[each.text])).toEqual(Array(3).fill(pilot[0]!.id));
  });

  it('asks "Which one?" when the question could belong to several threads, and a pick jumps there and asks the typed words in it', async () => {
    const { billing, pilot } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'When does the pilot start?'), placeOf(params, 'Who owns billing?')]) : null);
    const store = await startStore();
    await store.ask('did that change?');
    await flush();
    // Nothing is guessed (R4): nothing more is asked, and nothing is kept.
    expect(asked()).toHaveLength(1);
    expect(kept()).toHaveLength(6);
    expect(store.getState().ask?.clarify).toEqual({ kind: 'threads', question: 'did that change?', scope: GLOBAL, thread: null, threads: [pilot[0]!.id, billing[0]!.id], merge: [] });
    const clarify = byTestId(await page(store), 'clarify')[0]!;
    expect(text(clarify)).toContain('Which one?');
    expect(byTestId(clarify, 'choice').map(text)).toEqual(['When does the pilot start?', 'Who owns billing?', 'New question']);
    expect(byTestId(clarify, 'choice-project')).toEqual([]);
    click(byTestId(clarify, 'choice')[1]);
    await flush();
    expect(store.threadShown()?.id).toBe(billing[0]!.id);
    expect(asked()[1]).toMatchObject({ question: 'did that change?', scope: GLOBAL, previous: { purpose: 'follow_up', question: 'when is it due?' } });
    expect(asked()[1]).not.toHaveProperty('threads');
    expect(store.getState().ask?.clarify).toBeNull();
    expect(kept().at(-1)).toMatchObject({ text: 'did that change?', thread: billing[0]!.id });
  });

  it('never moves to a thread in another home on its own (R5): one in a project asks first, names the project, and a pick opens the project\'s page and asks there', async () => {
    const { tests } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Which tests fail?')]) : null);
    const store = await startStore();
    await store.ask('are they fixed?');
    await flush();
    expect(asked()).toHaveLength(1);
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.threadShown()).toBeUndefined();
    const clarify = byTestId(await page(store), 'clarify')[0]!;
    expect(byTestId(clarify, 'choice').map(choice => text(byTestId(choice, 'choice-project')))).toEqual(['Apollo', '']);
    expect(store.clarifyThreads()).toEqual([{ id: tests[0]!.id, name: 'Which tests fail?', project: 'Apollo' }]);
    click(byTestId(clarify, 'choice')[0]);
    await flush();
    expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: apollo.project_id } });
    expect(store.getState().barScope).toEqual(inApollo);
    expect(store.chipName()).toBe('Apollo');
    expect(store.threadShown()?.id).toBe(tests[0]!.id);
    // Asked visibly in that home: the project's scope, as a follow-up of its thread.
    expect(asked()[1]).toMatchObject({ question: 'are they fixed?', scope: inApollo, previous: { purpose: 'follow_up', question: 'Which tests fail?' } });
    expect(asked()[1]).not.toHaveProperty('threads');
    expect(kept().at(-1)).toMatchObject({ text: 'are they fixed?', scope: inApollo, thread: tests[0]!.id });
  });

  it.each([
    ['one the person is no longer in', () => { active = [zephyr]; }],
    ['archived', () => { active = [zephyr]; archived = [{ ...apollo, status: 'archived' }]; }],
    ['archived, on a page of projects the sidebar has not read', () => { active = numbered(12).map(each => ({ ...each, project_id: each.project_id.replace('prj_0', 'prj_9') })); archived = [{ ...apollo, status: 'archived' }]; }],
    ['gone, with projects the sidebar has not read', () => { active = numbered(12).map(each => ({ ...each, project_id: each.project_id.replace('prj_0', 'prj_9') })); }],
  ] as const)('asks nothing in a thread whose project is %s: the pick moves nothing and says so, and the other buttons and "New question" stay (R9)', async (_why, lose) => {
    const { tests } = seeded();
    lose();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Which tests fail?'), placeOf(params, 'Who owns billing?')]) : null);
    const store = await startStore();
    await store.ask('are they fixed?');
    await flush();
    expect(store.clarifyThreads().map(each => each.name)).toEqual(['Which tests fail?', 'Who owns billing?']);
    const before = store.getState().ask!.seq;
    await store.chooseThread(tests[0]!.id);
    await flush();
    // Nothing was asked, the person is where they were, and "Which one?" still waits, without that thread.
    expect(asked()).toHaveLength(1);
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.getState().barScope).toEqual(GLOBAL);
    expect(store.getState().ask).toMatchObject({ seq: before, thread: null, asking: null });
    const { THREAD_OUT_OF_REACH } = await import('../../src/renderer/store.js');
    expect(store.getState().toast).toBe(THREAD_OUT_OF_REACH);
    const clarify = byTestId(await page(store), 'clarify')[0]!;
    expect(byTestId(clarify, 'choice').map(text)).toEqual(['Who owns billing?', 'New question']);
    // A second click on what is no longer offered does nothing.
    await store.chooseThread(tests[0]!.id);
    expect(asked()).toHaveLength(1);
    // "New question" asks the words where they were typed, and nothing joins Apollo's thread.
    click(byTestId(clarify, 'choice').at(-1));
    await flush();
    expect(asked()[1]).toMatchObject({ question: 'are they fixed?', scope: GLOBAL });
    for (const key of ['previous', 'threads']) expect(asked()[1]).not.toHaveProperty(key);
    expect(kept().at(-1)).toMatchObject({ text: 'are they fixed?', scope: GLOBAL, thread: kept().at(-1)!.id });
    expect(kept().filter(each => each.thread === tests[0]!.id).map(each => each.text)).toEqual(['Which tests fail?']);
  });

  it('keeps the thread\'s button when its project could not be read: the page says why, nothing is asked, and the pick can be made again', async () => {
    const { tests } = seeded();
    // Apollo is the person's oldest project: on a page of them the sidebar has not read.
    active = [...numbered(12).map(each => ({ ...each, project_id: each.project_id.replace('prj_0', 'prj_9') })), { ...apollo, created_at: '2026-08-01T00:00:00.000Z' }];
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Which tests fail?'), placeOf(params, 'Who owns billing?')]) : null);
    const store = await startStore();
    expect(store.getState().projects.items.map(each => each.project_id)).not.toContain(apollo.project_id);
    await store.ask('are they fixed?');
    await flush();
    const reading = held.hold('projects.read');
    const pick = store.chooseThread(tests[0]!.id);
    reading(fail('unavailable', { retryable: true }));
    await pick;
    expect(asked()).toHaveLength(1);
    expect(store.getState().toast).toBe('ECHO is unavailable right now. Try again.');
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.clarifyThreads().map(each => each.name)).toEqual(['Which tests fail?', 'Who owns billing?']);
    // Read this time, the project opens and the words are asked in it.
    await store.chooseThread(tests[0]!.id);
    await flush();
    expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: apollo.project_id } });
    expect(asked()[1]).toMatchObject({ question: 'are they fixed?', scope: inApollo, previous: { question: 'Which tests fail?' } });
  });

  it('"New question" asks the typed words where they were typed with nothing carried, and its answer starts a thread there', async () => {
    const { tests } = seeded();
    seed(...kept(), ...threadIn(inApollo, ['What is left in Apollo?', HOUR]));
    // Asked from Apollo's page: its two threads ride, and the answer says the question could belong to either.
    script = params => (params.threads ? elsewhere(params, [0, 1]) : null);
    const store = await startStore();
    await store.openProject(apollo);
    await store.ask('did that change?');
    await flush();
    expect(asked()[0]).toMatchObject({ scope: inApollo });
    expect(store.clarifyThreads().map(each => each.name)).toEqual(['What is left in Apollo?', 'Which tests fail?']);
    const clarify = byTestId(await page(store), 'clarify')[0]!;
    expect(text(byTestId(clarify, 'choice').at(-1))).toBe('New question');
    click(byTestId(clarify, 'choice').at(-1));
    await flush();
    expect(asked()[1]).toMatchObject({ question: 'did that change?', scope: inApollo });
    for (const key of ['previous', 'threads']) expect(asked()[1]).not.toHaveProperty(key);
    const saved = kept().at(-1)!;
    expect(saved).toMatchObject({ text: 'did that change?', thread: saved.id, follows: null, scope: inApollo });
    expect(store.threadShown()).toMatchObject({ id: saved.id, home: inApollo });
    expect(store.getState().ask?.clarify).toBeNull();
    expect(filed()['Which tests fail?']).toBe(tests[0]!.id);
  });

  it('sends a project Ask only that project\'s threads, and an Ask in all context every thread (R3)', async () => {
    const { tests } = seeded();
    const store = await startStore();
    await store.openProject(apollo);
    await store.ask('What shipped?');
    expect(asked()[0]).toMatchObject({ scope: inApollo, threads: [{ questions: ['Which tests fail?'], asked_at: tests[0]!.asked_at }] });
    expect(JSON.stringify(asked()[0]!.threads)).not.toMatch(/pilot|billing/u);
    // In Zephyr, which has no thread: the list goes empty, and nothing of another place is in it.
    vi.setSystemTime(NOW.getTime() + 60_000);
    await store.openProject(zephyr);
    await store.ask('What is blocked?');
    expect(asked()[1]).toMatchObject({ scope: inZephyr });
    expect(asked()[1]!.threads).toEqual([]);
    store.goHome();
    await store.ask('What is new?');
    expect((asked()[2]!.threads as AskThread[]).map(thread => thread.questions[0])).toEqual(
      ['What is blocked?', 'What shipped?', 'When does the pilot start?', 'Which tests fail?', 'Who owns billing?']);
  });

  it('never sends a question a model wrote in a thread, nor names a thread by one, whatever its turns kept (R2)', async () => {
    const first = turn('what is open?', 5 * DAY);
    const followUp = turn('Who owns THERM-482?', 4 * DAY, { text: 'who owns it?', typed: 'who owns it?', follows: first.id, thread: first.id });
    const choice = turn('What are the details on THERM-490?', 3 * DAY, { text: 'What are the details on THERM-490?', typed: 'what about that one?', follows: followUp.id, thread: first.id });
    const { typed: _typed, follows: _follows, thread: _thread, ...legacy } = turn('What changed on THERM-555?', 2 * DAY);
    seed(first, followUp, choice, legacy);
    const store = await startStore();
    await store.ask('Something new?');
    expect(asked()[0]!.threads).toEqual([{ questions: ['what is open?', 'who owns it?', 'what about that one?'], asked_at: choice.asked_at }]);
    expect(JSON.stringify(asked()[0]!.threads)).not.toMatch(/THERM/u);
    expect(store.threads().map(thread => thread.name)).toEqual(['what is open?', 'What changed on THERM-555?', 'Something new?']);
    // A follow-up in that thread carries its older turns by what was typed, never by what the resolver wrote.
    await store.openThread(first.id);
    await store.ask('and since then?');
    const previous = asked()[1]!.previous as AskPrevious;
    expect(previous.earlier!.map(each => each.question)).toEqual(['what is open?', 'who owns it?']);
  });

  it('keeps Ask again in its turn\'s thread, with no thread and no older turn riding', async () => {
    const { pilot } = seeded();
    const store = await startStore();
    store.returnToAsk();
    await flush();
    store.toggleTurn(pilot[0]!.id);
    store.askAgain(pilot[0]!.id);
    await flush();
    expect(asked()[0]).toMatchObject({ question: 'When does the pilot start?', previous: { purpose: 'ask_again', question: 'When does the pilot start?' } });
    expect(asked()[0]).not.toHaveProperty('threads');
    expect(asked()[0]!.previous).not.toHaveProperty('earlier');
    expect(kept().at(-1)).toMatchObject({ again_of: pilot[0]!.id, thread: pilot[0]!.id });
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
  });

  it('asks a choice of "Which one?" between things as before: the chosen full question, with the same earlier turn alone, in the open thread', async () => {
    const { pilot } = seeded();
    const choices = [{ label: 'THERM-482 · Sensor drift', question: 'Who owns THERM-482?' }, { label: 'THERM-490 · DVT retest', question: 'Who owns THERM-490?' }];
    script = params => (params.question === 'who owns that ticket?'
      ? ok({ scope: GLOBAL, sources: [], parts: [], outcome: 'clarify', receipt: { looked_through: 0 }, question: 'who owns that ticket?', choices }) : null);
    const store = await startStore();
    await store.openThread(pilot[0]!.id);
    await flush();
    await store.ask('who owns that ticket?');
    await flush();
    expect(store.getState().ask?.clarify).toMatchObject({ kind: 'choices', choices, follows: pilot[2]!.id, typed: 'who owns that ticket?' });
    store.chooseClarified(choices[1]!);
    await flush();
    // The choice is what is asked, not the typed words again.
    expect(asked()[1]).toMatchObject({ question: 'Who owns THERM-490?', previous: { purpose: 'follow_up', question: 'who decided?' } });
    for (const key of ['threads']) expect(asked()[1]).not.toHaveProperty(key);
    expect(asked()[1]!.previous).not.toHaveProperty('earlier');
    expect(kept().at(-1)).toMatchObject({ text: 'Who owns THERM-490?', typed: 'who owns that ticket?', thread: pilot[0]!.id });
  });

  it('asks outside a project\'s thread once × widens the bar: the thread stays on the page, and the question continues none', async () => {
    const { tests } = seeded();
    const store = await startStore();
    await store.openProject(apollo);
    store.returnToAsk();
    await flush();
    // The thread asked in most recently is the pilot's, at Home; Apollo's opens from the list.
    await store.openThread(tests[0]!.id);
    expect(store.getState().barScope).toEqual(inApollo);
    store.widenScope();
    expect(store.threadShown()?.id).toBe(tests[0]!.id);
    await store.ask('and across everything?');
    await flush();
    const sent = asked().at(-1)!;
    expect(sent).toMatchObject({ scope: GLOBAL });
    expect(sent).not.toHaveProperty('previous');
    // The thread on the page is one it could belong to, like every other.
    expect((sent.threads as AskThread[]).map(thread => thread.questions[0])).toContain('Which tests fail?');
    const saved = kept().at(-1)!;
    expect(saved).toMatchObject({ scope: GLOBAL, thread: saved.id });
    expect(store.threadShown()).toMatchObject({ id: saved.id, home: GLOBAL });
    expect(filed()['Which tests fail?']).toBe(tests[0]!.id);
  });
});

describe('being in a thread, or only shown it (What a person sees, 5)', () => {
  const seeded = () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY], ['when is it due?', 5 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY], ['who decided that?', 2 * DAY]);
    seed(...billing, ...pilot);
    return { billing, pilot };
  };
  const open = (store: Store) => store.getState().ask?.thread;

  it('back in Ask from the sidebar, a bare question carries no earlier turn and every thread, the one shown included, and shows alone until it is placed', async () => {
    const { billing, pilot } = seeded();
    const store = await startStore();
    expect(store.returnToAsk()).toBe(true);
    await flush();
    // Ask shows the thread asked in last. The person has neither picked it nor asked in it: they are not in it.
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: false });
    expect(await questions(store)).toEqual(['who decided that?']);
    const release = held.hold('ask.run');
    void store.ask('did that change?');
    await flush();
    const sent = asked()[0]!;
    expect(sent).not.toHaveProperty('previous');
    expect(sent.threads).toEqual([
      { questions: ['When does the pilot start?', 'who decided that?'], asked_at: pilot[1]!.asked_at },
      { questions: ['Who owns billing?', 'when is it due?'], asked_at: billing[1]!.asked_at },
    ]);
    // On its way it shows alone, under "New thread": where it belongs is not known yet.
    expect(store.threadShown()).toBeUndefined();
    expect(await questions(store)).toEqual(['did that change?']);
    expect(byTestId(await page(store), 'timeline-row')).toEqual([]);
    expect(text(byTestId(await page(store), 'thread-name')[0])).toBe('New thread');
    // It could be either: "Which one?", still alone, the thread that was showing among the buttons.
    release(elsewhere(sent, [0, 1]));
    await flush();
    expect(store.getState().ask?.clarify).toMatchObject({ kind: 'threads', thread: null, threads: [pilot[0]!.id, billing[0]!.id] });
    expect(byTestId(await page(store), 'choice').map(text)).toEqual(['When does the pilot start?', 'Who owns billing?', 'New question']);
    expect(await questions(store)).toEqual(['did that change?']);
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: false });
    // Picked, the person is in it: the words are asked there, and the same words typed next continue it.
    await store.chooseThread(pilot[0]!.id);
    await flush();
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: true });
    expect(asked()[1]).toMatchObject({ question: 'did that change?', previous: { purpose: 'follow_up', question: 'who decided that?' } });
    expect(asked()[1]).not.toHaveProperty('threads');
    await store.ask('and since when?');
    expect(asked()[2]).toMatchObject({ question: 'and since when?', previous: { purpose: 'follow_up', question: 'did that change?' } });
    // In a thread only the other threads ride: never the one it continues.
    expect(asked()[2]!.threads).toEqual([{ questions: ['Who owns billing?', 'when is it due?'], asked_at: billing[1]!.asked_at }]);
    expect(kept().slice(-2).map(each => each.thread)).toEqual([pilot[0]!.id, pilot[0]!.id]);
  });

  it('jumps to the thread that was showing when the answer names it alone: the person is then in it, and the question is asked there', async () => {
    const { pilot } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'When does the pilot start?')]) : null);
    const store = await startStore();
    store.returnToAsk();
    await flush();
    await store.ask('did that change?');
    await flush();
    expect(asked()).toHaveLength(2);
    expect(asked()[0]).not.toHaveProperty('previous');
    expect((asked()[0]!.threads as AskThread[]).map(thread => thread.questions[0])).toEqual(['When does the pilot start?', 'Who owns billing?']);
    expect(asked()[1]).toMatchObject({ question: 'did that change?', previous: { purpose: 'follow_up', question: 'who decided that?' } });
    expect(asked()[1]).not.toHaveProperty('threads');
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: true });
    expect(kept().at(-1)).toMatchObject({ text: 'did that change?', thread: pilot[0]!.id, follows: pilot[1]!.id });
    expect(await questions(store)).toEqual(['who decided that?', 'did that change?']);
  });

  it('goes back to the thread Ask showed when a question typed before the person is in it is cancelled, and shows one that failed alone', async () => {
    const { pilot } = seeded();
    const store = await startStore();
    store.returnToAsk();
    await flush();
    held.hold('ask.run');
    void store.ask('did that change?');
    await flush();
    expect(store.threadShown()).toBeUndefined();
    store.cancelAsk();
    // Ask was open before the question: it stays, on the thread it showed, and the person is still not in it.
    expect(store.getState().ask).toMatchObject({ thread: { id: pilot[0]!.id, entered: false }, asking: null });
    expect(await questions(store)).toEqual(['who decided that?']);
    // One that failed belongs to no thread either: it shows alone, and Try again asks it the same way.
    const failing = held.hold('ask.run');
    void store.ask('did that change?');
    await flush();
    failing(fail('unavailable', { retryable: true }));
    await flush();
    expect(store.getState().ask?.failed).toMatchObject({ question: 'did that change?', thread: null });
    expect(store.threadShown()).toBeUndefined();
    expect(byTestId(await page(store), 'timeline-row')).toEqual([]);
    store.retryAsk();
    await flush();
    expect(asked().at(-1)).not.toHaveProperty('previous');
    expect((asked().at(-1)!.threads as AskThread[]).map(thread => thread.questions[0])).toEqual(['When does the pilot start?', 'Who owns billing?']);
    // Its answer starts a thread, which the person, having asked in it, is in.
    const saved = kept().at(-1)!;
    expect(saved.thread).toBe(saved.id);
    expect(open(store)).toEqual({ id: saved.id, entered: true });
  });

  it('puts the person in a thread by each way of picking it, and never by the sidebar\'s Ask, a merge or the bar\'s ×', async () => {
    const { billing, pilot } = seeded();
    const store = await startStore();
    const back = async () => { store.closeAsk(); store.returnToAsk(); await flush(); expect(open(store)).toEqual({ id: pilot[0]!.id, entered: false }); };
    store.returnToAsk();
    await flush();
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: false });
    // One of its earlier questions, from its line; folding the line again leaves them in it.
    store.toggleTurn(pilot[0]!.id);
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: true });
    store.toggleTurn(pilot[0]!.id);
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: true });
    // Since Ask opened: closed and opened again from the sidebar, they are not.
    await back();
    // Ask again, even one cancelled.
    held.hold('ask.run');
    store.askAgain(pilot[1]!.id);
    await flush();
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: true });
    store.cancelAsk();
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: true });
    await back();
    // Its own row in the list, when it is the thread shown; refused, like every row, while a question is on its way.
    const onItsWay = held.hold('ask.run');
    void store.ask('Something else?');
    await flush();
    store.enterThread();
    expect(store.getState().ask?.thread).toEqual({ id: pilot[0]!.id, entered: false });
    store.cancelAsk();
    onItsWay(fail('unavailable', { retryable: true }));
    await flush();
    store.enterThread();
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: true });
    await back();
    // Another thread's row in the list.
    await store.openThread(billing[0]!.id);
    expect(open(store)).toEqual({ id: billing[0]!.id, entered: true });
    // A suggestion of one of its questions.
    store.closeAsk();
    store.pickSuggestion({ question: 'Who owns billing?', turn: billing[0]!.id });
    await flush();
    expect(open(store)).toEqual({ id: billing[0]!.id, entered: true });
    await back();
    // Neither a merge into the thread shown nor widening the bar is picking it.
    store.mergeThread(billing[0]!.id);
    store.widenScope();
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: false });
    await flush();
    // Asking in it is: the answer to a question placed there lands there.
    script = params => (params.threads ? elsewhere(params, [0]) : null);
    await store.ask('and the budget?');
    await flush();
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: true });
  });

  it('sends an empty list from a person\'s only thread, so an answer can say the subject is new and start a second', async () => {
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
    seed(...pilot);
    script = params => (params.question === 'What is for lunch?' ? ok({ ...answerOf(String(params.question)), question: String(params.question), thread: { kind: 'new' } }) : null);
    const store = await startStore();
    await store.openThread(pilot[0]!.id);
    await flush();
    // In it, a question continues it, and with no other thread the list still goes, empty.
    await store.ask('who decided that?');
    expect(asked()[0]).toMatchObject({ previous: { purpose: 'follow_up', question: 'When does the pilot start?' }, threads: [] });
    expect(kept().at(-1)!.thread).toBe(pilot[0]!.id);
    expect(store.threads()).toHaveLength(1);
    // A new subject, typed in that thread: the answer says so, and it starts a second thread.
    await store.ask('What is for lunch?');
    await flush();
    expect(asked()[1]).toMatchObject({ previous: { purpose: 'follow_up', question: 'who decided that?' }, threads: [] });
    const saved = kept().at(-1)!;
    expect(saved).toMatchObject({ text: 'What is for lunch?', thread: saved.id });
    expect(store.threads().map(thread => thread.name)).toEqual(['When does the pilot start?', 'What is for lunch?']);
    expect(open(store)).toEqual({ id: saved.id, entered: true });
    // What is never placed carries no list at all: Ask again, and the questions asked again after a pick.
    store.askAgain(saved.id);
    await flush();
    expect(asked()[2]).toMatchObject({ previous: { purpose: 'ask_again' } });
    expect(asked()[2]).not.toHaveProperty('threads');
  });
});

describe('opening a thread: the sidebar\'s Ask, a suggestion, the list', () => {
  it('opens the thread asked in most recently from the sidebar, and a suggestion\'s thread at its turn, moving to its place', async () => {
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY], ['and who fixes them?', 3 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(...tests, ...pilot);
    const store = await startStore();
    expect(store.returnToAsk()).toBe(true);
    await flush();
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
    store.closeAsk();
    // Home suggests every question asked; picking Apollo's opens its thread on Apollo's page, at that turn.
    expect(store.barSuggestions().filter(each => each.turn !== undefined).map(each => each.question)).toEqual(['When does the pilot start?', 'and who fixes them?', 'Which tests fail?']);
    store.pickSuggestion({ question: 'Which tests fail?', turn: tests[0]!.id });
    await flush();
    expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: apollo.project_id } });
    expect(store.chipName()).toBe('Apollo');
    expect(store.getState().ask).toMatchObject({ thread: { id: tests[0]!.id, entered: true }, opened: tests[0]!.id, focus: tests[0]!.id });
    expect(byTestId(await page(store), 'opened-turn')).toHaveLength(1);
    // The question typed next continues the turn chosen.
    await store.ask('since when?');
    expect(asked()[0]).toMatchObject({ scope: inApollo, previous: { question: 'Which tests fail?' } });
  });

  it('lists the threads under the name, the open one marked, and a row jumps while Merge, only on a row of the open thread\'s home, joins that thread to it', async () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY]);
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(...billing, ...tests, ...pilot);
    const store = await startStore();
    store.returnToAsk();
    await flush();
    // A row's click also puts the caret back in the bar, which this page does not have.
    vi.stubGlobal('document', { getElementById: () => null, activeElement: null });
    const screens = await import('../../src/renderer/screens/ask.js');
    const list = () => render(screens.ThreadList({ state: store.getState(), onDone: () => undefined }));
    expect(byTestId(list(), 'thread-group').map(text)).toEqual(['No project', 'Apollo']);
    // A dialog the name opens: the name says so, and names it as what it controls only while it is there.
    const dialog = byTestId(list(), 'thread-list')[0]!;
    expect([dialog.props.role, dialog.props['aria-label']]).toEqual(['dialog', 'Threads']);
    const name = byTestId(await page(store), 'thread-name')[0]!;
    expect([name.props['aria-haspopup'], name.props['aria-expanded'], name.props['aria-controls']]).toEqual(['dialog', false, undefined]);
    const rows = byTestId(list(), 'thread-row');
    expect(rows.map(row => text((row.props.children as unknown[])[0]))).toEqual(['When does the pilot start?', 'Who owns billing?', 'Which tests fail?']);
    expect(rows.map(row => row.props['aria-current'])).toEqual(['true', undefined, undefined]);
    // The open thread's own row picks that thread: shown by the sidebar's Ask the person was not in it, and now is, with
    // nothing else of Ask changed. A second pick changes nothing at all.
    const shown = store.getState().ask!;
    expect(shown.thread).toEqual({ id: pilot[0]!.id, entered: false });
    click(rows[0]);
    expect(store.getState().ask).toEqual({ ...shown, thread: { id: pilot[0]!.id, entered: true } });
    const entered = store.getState().ask;
    click(byTestId(list(), 'thread-row')[0]);
    expect(store.getState().ask).toBe(entered);
    // It has no Merge; every other row of its home has one, and Apollo's none (R9).
    const merges = byTestId(list(), 'thread-merge');
    expect(merges.map(button => button.props['aria-label'])).toEqual(['Merge into this thread']);
    expect(byTestId(list(), 'thread-find')[0]!.props.placeholder).toBe('Find a thread');
    // The one Merge is billing's: the other thread with no project.
    click(merges[0]);
    await flush();
    expect(filed()).toMatchObject({ 'Who owns billing?': pilot[0]!.id, 'Which tests fail?': tests[0]!.id });
    store.undoMerge();
    await flush();
    // A row jumps, moving to the thread's place.
    click(rows[2]);
    await flush();
    expect(store.threadShown()?.id).toBe(tests[0]!.id);
    expect(store.getState().route).toMatchObject({ page: 'project' });
    // With no thread open there is no Merge.
    store.closeAsk();
    const release = held.hold('ask.run');
    void store.ask('Another subject?');
    await flush();
    expect(byTestId(list(), 'thread-merge')).toEqual([]);
    // While a question is on its way every row is still, and its Merge too.
    expect(byTestId(list(), 'thread-row').map(row => row.props.disabled)).toEqual([true, true, true]);
    release(ok(answerOf('Another subject?', inApollo)));
    await flush();
  });

  it('puts the thread\'s own page under Ask on a jump, whatever the bar asks: Home for a thread with no project, even from a project\'s page with its bar widened', async () => {
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY]);
    const blocked = threadIn(inZephyr, ['What is blocked?', 3 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(...tests, ...blocked, ...pilot);
    const store = await startStore();
    await store.openProject(apollo);
    await store.openThread(tests[0]!.id);
    store.widenScope();
    expect(store.getState().barScope).toEqual(GLOBAL);
    // The bar asks all context already, and Apollo's page is still not where the pilot's thread lives.
    expect(await store.openThread(pilot[0]!.id)).toBe(true);
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
    // So with the sidebar's Ask, which opens the thread asked in last.
    await store.openProject(apollo);
    store.widenScope();
    store.returnToAsk();
    await flush();
    expect(store.getState().route).toEqual({ page: 'home' });
    // On its own project's page a thread stays there, and a widened bar narrows back.
    await store.openProject(apollo);
    store.widenScope();
    const route = store.getState().route;
    await store.openThread(tests[0]!.id);
    expect(store.getState().route).toBe(route);
    expect(store.getState().barScope).toEqual(inApollo);
    // Another project's thread opens that project, however the bar was widened.
    store.widenScope();
    await store.openThread(blocked[0]!.id);
    expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: zephyr.project_id } });
    expect(store.getState().barScope).toEqual(inZephyr);
    // A page that is no project's stays under a thread with no project.
    store.openTools();
    const tools = store.getState().route;
    await store.openThread(pilot[0]!.id);
    expect(store.getState().route).toBe(tools);
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
  });

  it('reads a project the sidebar has not loaded before it jumps, and drops the jump when Ask moved on meanwhile', async () => {
    active = numbered(12);
    const later = active[11]!;
    const far = threadIn({ kind: 'project', project_id: later.project_id }, ['What is left there?', 3 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    const billing = threadIn(GLOBAL, ['Who owns billing?', DAY]);
    seed(...far, ...pilot, ...billing);
    const store = await startStore();
    store.returnToAsk();
    await flush();
    expect(store.threadShown()?.id).toBe(billing[0]!.id);
    // The read is on its way when the person picks another thread: the later jump stands, and the earlier is dropped.
    const reading = held.hold('projects.read');
    const jump = store.openThread(far[0]!.id);
    await store.openThread(pilot[0]!.id);
    reading(ok(later));
    expect(await jump).toBe(false);
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
    expect(store.getState().route).toEqual({ page: 'home' });
    // Closed meanwhile: it does not open Ask again.
    const again = held.hold('projects.read');
    const second = store.openThread(far[0]!.id);
    store.closeAsk();
    again(ok(later));
    expect(await second).toBe(false);
    expect(store.getState().ask).toBeNull();
    // Started with Ask closed (the sidebar's Ask, a suggestion), and the person opened another page meanwhile: the jump
    // does not take them from it, whether that page is another project, or Home opened again.
    for (const leave of [() => void store.openProject(active[0]!), () => store.goHome(), () => store.openTools()]) {
      const reading = held.hold('projects.read');
      const third = store.openThread(far[0]!.id);
      leave();
      const route = store.getState().route;
      reading(ok(later));
      expect(await third).toBe(false);
      expect(store.getState().ask).toBeNull();
      expect(store.getState().route).toBe(route);
    }
    store.goHome();
    // Left alone, it reads the project and moves there.
    store.returnToAsk();
    await flush();
    expect(await store.openThread(far[0]!.id)).toBe(true);
    expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: later.project_id } });
    expect(store.threadShown()?.id).toBe(far[0]!.id);
    // A thread that is gone opens nothing.
    expect(await store.openThread('00000000-0000-4000-8000-00000000ffff')).toBe(false);
  });
});

describe('merging threads, and Undo', () => {
  const seeded = () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY], ['when is it due?', 4 * DAY]);
    const tests = threadIn(inApollo, ['Which tests fail?', 5 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY], ['did that change?', 2 * DAY]);
    seed(billing[0]!, tests[0]!, billing[1]!, ...pilot);
    return { billing, tests, pilot };
  };
  /** Ask on the thread asked in most recently, picked from the list: the person is in it. */
  const opened = async () => {
    const store = await startStore();
    await store.openThread(store.getState().timeline.turns.at(-1)!.thread!);
    await flush();
    return store;
  };

  it('saves every turn of the merged thread with the open thread\'s id, shows them in time order with one line, and Undo saves them back', async () => {
    const { billing, pilot } = seeded();
    const store = await opened();
    const puts = calls('timeline.put').length;
    store.mergeThread(billing[0]!.id);
    await flush();
    expect(calls('timeline.put')).toHaveLength(puts + 2);
    expect(filed()).toMatchObject({ 'Who owns billing?': pilot[0]!.id, 'when is it due?': pilot[0]!.id, 'When does the pilot start?': pilot[0]!.id });
    // Nothing else of a turn changes, and the Apollo thread is untouched.
    expect(kept().find(each => each.id === billing[1]!.id)).toEqual({ ...billing[1]!, thread: pilot[0]!.id });
    expect(filed()['Which tests fail?']).not.toBe(pilot[0]!.id);
    // The open thread keeps its id, its name and its home; the merged turns join it in time order.
    expect(store.threads().map(thread => thread.name)).toEqual(['When does the pilot start?', 'Which tests fail?']);
    expect(store.threadShown()).toMatchObject({ id: pilot[0]!.id, name: 'When does the pilot start?', home: GLOBAL });
    expect(store.askThread().map(each => each.text)).toEqual(['Who owns billing?', 'when is it due?', 'When does the pilot start?', 'did that change?']);
    const line = byTestId(await page(store), 'thread-merged')[0]!;
    expect(line.props.role).toBe('status');
    expect(text(line)).toBe('Merged with Who owns billing?Undo');
    click(byTestId(line, 'thread-undo')[0]);
    await flush();
    expect(filed()).toMatchObject({ 'Who owns billing?': billing[0]!.id, 'when is it due?': billing[0]!.id, 'When does the pilot start?': pilot[0]!.id });
    expect(store.askThread().map(each => each.text)).toEqual(['When does the pilot start?', 'did that change?']);
    expect(byTestId(await page(store), 'thread-merged')).toEqual([]);
    expect(store.getState().ask?.merged).toBeNull();
  });

  it('never merges across homes, by hand or on an answer\'s word (R9): the thread of another home stays where it is, with no line and nothing saved', async () => {
    const { tests, pilot } = seeded();
    const store = await opened();
    const puts = calls('timeline.put').length;
    store.mergeThread(tests[0]!.id);
    await flush();
    expect(calls('timeline.put')).toHaveLength(puts);
    expect(filed()['Which tests fail?']).toBe(tests[0]!.id);
    expect(store.mergedLine()).toBeNull();
    expect(store.getState().ask?.merged).toBeNull();
    // The other way round, from Apollo's thread on Apollo's page: neither thread with no project merges into it.
    await store.openThread(tests[0]!.id);
    await flush();
    store.mergeThread(pilot[0]!.id);
    await flush();
    expect(calls('timeline.put')).toHaveLength(puts);
    expect(store.threads().map(thread => [thread.name, thread.home])).toEqual([['Who owns billing?', GLOBAL], ['Which tests fail?', inApollo], ['When does the pilot start?', GLOBAL]]);
  });

  it.each(['the next question', 'a jump', 'closing Ask'] as const)('offers Undo until %s, and then drops it', async (leave) => {
    const { billing, tests, pilot } = seeded();
    const store = await opened();
    store.mergeThread(billing[0]!.id);
    expect(store.mergedLine()).toBe('Merged with Who owns billing?');
    await flush();
    if (leave === 'the next question') await store.ask('and the budget?');
    if (leave === 'a jump') { await store.openThread(tests[0]!.id); await store.openThread(pilot[0]!.id); }
    if (leave === 'closing Ask') { store.closeAsk(); store.returnToAsk(); }
    await flush();
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
    expect(store.mergedLine()).toBeNull();
    expect(store.getState().ask?.merged).toBeNull();
    // Undo then takes nothing back: the turns stay merged.
    store.undoMerge();
    await flush();
    expect(filed()['Who owns billing?']).toBe(pilot[0]!.id);
  });

  it('drops Undo, and applies nothing, once a turn it moved is gone: the timeline read again without it', async () => {
    const { billing, pilot } = seeded();
    const store = await opened();
    store.mergeThread(billing[0]!.id);
    await flush();
    // Signed out: nothing of the timeline is in memory, so the line goes, and Undo moves nothing.
    app = { signed_in: false, account: null, client_version: 'test' };
    await store.refreshStatus();
    expect(store.mergedLine()).toBeNull();
    const puts = calls('timeline.put').length;
    store.undoMerge();
    await flush();
    expect(calls('timeline.put')).toHaveLength(puts);
    expect(store.getState().ask?.merged ?? null).toBeNull();
    expect(filed()['Who owns billing?']).toBe(pilot[0]!.id);
  });

  /** Each turn's thread as the page holds it, by what was typed for it: to compare with the file's (filed). */
  const shown = (store: Store) => Object.fromEntries(store.getState().timeline.turns.map(each => [each.text, each.thread]));
  const reads = () => calls('timeline.read').length;

  it('reads the file again when a save of the merge did not go through, and shows what it holds: no line, no Undo, and the page says so', async () => {
    const { billing, pilot } = seeded();
    const store = await opened();
    const { THREADS_NOT_SAVED } = await import('../../src/renderer/store.js');
    unsaved.add(billing[1]!.id);
    const read = reads();
    store.mergeThread(billing[0]!.id);
    // Until the saves settle the page shows the merge it asked for, and the timeline is moving.
    expect(store.askThread().map(each => each.text)).toContain('when is it due?');
    expect(store.getState().timeline.moving).toBe(true);
    await flush();
    expect(reads()).toBe(read + 1);
    expect(store.getState().toast).toBe(THREADS_NOT_SAVED);
    expect(store.getState().timeline.moving).toBe(false);
    // The page and the file agree: the first turn moved, the second is where it was.
    expect(shown(store)).toEqual(filed());
    expect(filed()).toMatchObject({ 'Who owns billing?': pilot[0]!.id, 'when is it due?': billing[0]!.id });
    expect(store.askThread().map(each => each.text)).toEqual(['Who owns billing?', 'When does the pilot start?', 'did that change?']);
    // A merge that did not all go through is not one Undo can take back: the line is gone, and Undo moves nothing.
    expect(store.getState().ask?.merged).toBeNull();
    expect(byTestId(await page(store), 'thread-merged')).toEqual([]);
    const puts = calls('timeline.put').length;
    store.undoMerge();
    await flush();
    expect(calls('timeline.put')).toHaveLength(puts);
    // Nothing moved at all: the same.
    unsaved = new Set(billing.map(each => each.id));
    store.mergeThread(billing[0]!.id);
    await flush();
    expect(store.getState().ask?.merged).toBeNull();
    expect(store.getState().toast).toBe(THREADS_NOT_SAVED);
    expect(shown(store)).toEqual(filed());
    expect(filed()['when is it due?']).toBe(billing[0]!.id);
  });

  it('shows what the file holds when a save never answered: a turn the file took stays moved, with no Undo', async () => {
    const { billing, pilot } = seeded();
    const store = await opened();
    // The file took the turn, and the reply was lost on its way back.
    unknown.add(billing[1]!.id);
    store.mergeThread(billing[0]!.id);
    await flush();
    const { THREADS_NOT_SAVED } = await import('../../src/renderer/store.js');
    expect(store.getState().toast).toBe(THREADS_NOT_SAVED);
    expect(filed()).toMatchObject({ 'Who owns billing?': pilot[0]!.id, 'when is it due?': pilot[0]!.id });
    expect(shown(store)).toEqual(filed());
    expect(store.askThread().map(each => each.text)).toEqual(['Who owns billing?', 'when is it due?', 'When does the pilot start?', 'did that change?']);
    expect(store.getState().ask?.merged).toBeNull();
    expect(store.getState().timeline.moving).toBe(false);
  });

  it('reads the file again when Undo could not save a turn back, and shows it still merged', async () => {
    const { billing, pilot } = seeded();
    const store = await opened();
    store.mergeThread(billing[0]!.id);
    await flush();
    unsaved.add(billing[0]!.id);
    const read = reads();
    store.undoMerge();
    await flush();
    const { THREADS_NOT_SAVED } = await import('../../src/renderer/store.js');
    expect(reads()).toBe(read + 1);
    expect(store.getState().toast).toBe(THREADS_NOT_SAVED);
    expect(filed()).toMatchObject({ 'Who owns billing?': pilot[0]!.id, 'when is it due?': billing[0]!.id });
    expect(shown(store)).toEqual(filed());
    expect(store.mergedLine()).toBeNull();
    expect(store.getState().timeline.moving).toBe(false);
  });

  it('puts back what was not saved when the file cannot be read again either, so the page says no more than it knows', async () => {
    const { billing, pilot } = seeded();
    const store = await opened();
    const { THREADS_NOT_SAVED } = await import('../../src/renderer/store.js');
    unsaved.add(billing[1]!.id);
    unread = true;
    store.mergeThread(billing[0]!.id);
    await flush();
    expect(store.getState().toast).toBe(THREADS_NOT_SAVED);
    expect(shown(store)).toMatchObject({ 'Who owns billing?': pilot[0]!.id, 'when is it due?': billing[0]!.id });
    expect(shown(store)).toEqual(filed());
    expect(store.getState().ask?.merged).toBeNull();
    // The move is over all the same: Ask is not left busy.
    expect(store.getState().timeline.moving).toBe(false);
    unread = false;
    await store.ask('and the budget?');
    expect(asked()).toHaveLength(1);
  });

  it('moves one thing at a time: until a merge or its Undo has settled, no other merge, Undo, jump or question starts, and the page offers none', async () => {
    const { billing, tests, pilot } = seeded();
    seed(...kept(), ...threadIn(GLOBAL, ['Where is the ledger?', HOUR]));
    const ledger = kept().at(-1)!;
    const store = await startStore();
    await store.openThread(pilot[0]!.id);
    await flush();
    const screens = await import('../../src/renderer/screens/ask.js');
    vi.stubGlobal('document', { getElementById: () => null, activeElement: null });
    const list = () => render(screens.ThreadList({ state: store.getState(), onDone: () => undefined }));
    const saves = [held.hold('timeline.put'), held.hold('timeline.put')];
    store.mergeThread(billing[0]!.id);
    await flush();
    const before = store.getState();
    expect(before.timeline.moving).toBe(true);
    expect(store.askBusy()).toBe(true);
    // Everything that asks, jumps, merges or undoes is refused, and nothing changes.
    store.mergeThread(ledger.id);
    store.undoMerge();
    expect(await store.openThread(tests[0]!.id)).toBe(false);
    store.returnToAsk();
    await store.ask('and the budget?');
    store.askAgain(pilot[0]!.id);
    store.setBarText('and the budget?');
    store.submitBar();
    await flush();
    expect(store.getState().barText).toBe('and the budget?');
    expect({ ...store.getState(), barText: '' }).toEqual({ ...before, barText: '' });
    expect(asked()).toEqual([]);
    expect(calls('timeline.put')).toHaveLength(2);
    // The page offers none of it: the rows and their Merge, Undo, and the bar's Ask are still.
    expect(byTestId(list(), 'thread-row').filter(row => row.props['aria-current'] !== 'true').map(row => row.props.disabled)).toEqual([true, true]);
    expect(byTestId(list(), 'thread-merge').map(button => button.props.disabled)).toEqual([true]);
    expect(byTestId(await page(store), 'thread-undo')[0]!.props.disabled).toBe(true);
    // Settled, each goes through again.
    for (const save of saves) save(ok({}));
    await flush();
    expect(store.getState().timeline.moving).toBe(false);
    expect(store.askBusy()).toBe(false);
    expect(byTestId(await page(store), 'thread-undo')[0]!.props.disabled).toBe(false);
    store.submitBar();
    await flush();
    expect(store.getState().barText).toBe('');
    expect(asked()).toHaveLength(1);
    expect(kept().at(-1)).toMatchObject({ text: 'and the budget?', thread: pilot[0]!.id });
  });

  it('ends a move with the timeline: signed out while its saves are on their way, their replies say nothing and Ask is not left busy', async () => {
    const { billing } = seeded();
    const store = await opened();
    const saves = [held.hold('timeline.put'), held.hold('timeline.put')];
    store.mergeThread(billing[0]!.id);
    await flush();
    expect(store.getState().timeline.moving).toBe(true);
    app = { signed_in: false, account: null, client_version: 'test' };
    await store.refreshStatus();
    expect(store.getState().timeline).toEqual({ turns: [], checks: {}, moving: false });
    const read = reads();
    for (const save of saves) save(fail('signed_out'));
    await flush();
    expect(store.getState().toast).toBeNull();
    expect(reads()).toBe(read);
    expect(store.getState().timeline.moving).toBe(false);
  });

  it('lets go of the merged line whenever the timeline is read again: its Undo was of the turns as they were', async () => {
    const { billing, pilot } = seeded();
    const store = await opened();
    store.mergeThread(billing[0]!.id);
    await flush();
    expect(store.mergedLine()).toBe('Merged with Who owns billing?');
    // Signed out and in again as the same person, Ask still open behind the sign-in page.
    app = { signed_in: false, account: null, client_version: 'test' };
    await store.refreshStatus();
    app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
    await store.refreshStatus();
    await flush();
    expect(store.getState().timeline.turns).toHaveLength(5);
    expect(store.getState().ask?.merged ?? null).toBeNull();
    expect(filed()['Who owns billing?']).toBe(pilot[0]!.id);
  });

  it('merges on its own the threads an answer says are on the open thread\'s subject, in the same home only, with the same line and Undo', async () => {
    const { billing, tests, pilot } = seeded();
    script = params => (params.threads ? ok({ ...answerOf(String(params.question)), merge: [placeOf(params, 'Who owns billing?'), placeOf(params, 'Which tests fail?')] }) : null);
    const store = await opened();
    await store.ask('and the budget?');
    await flush();
    // The answer is saved in the open thread first; then the thread with no project joins it. Apollo's never does (R5).
    expect(filed()).toMatchObject({ 'and the budget?': pilot[0]!.id, 'Who owns billing?': pilot[0]!.id, 'when is it due?': pilot[0]!.id, 'Which tests fail?': tests[0]!.id });
    expect(kept().at(-1)!.answer).not.toHaveProperty('merge');
    expect(store.mergedLine()).toBe('Merged with Who owns billing?');
    store.undoMerge();
    await flush();
    expect(filed()).toMatchObject({ 'and the budget?': pilot[0]!.id, 'Who owns billing?': billing[0]!.id, 'when is it due?': billing[0]!.id });
  });

  describe('beside a jump', () => {
    /** Four threads with no project, Ask on the pilot's; a question the answer sends to billing's, naming two more on its subject. */
    const sent = async () => {
      const billing = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY]);
      const invoices = threadIn(GLOBAL, ['Who signs invoices?', 5 * DAY]);
      const ledger = threadIn(GLOBAL, ['Where is the ledger?', 4 * DAY]);
      const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
      seed(...billing, ...invoices, ...ledger, ...pilot);
      const store = await opened();
      const release = held.hold('ask.run');
      const first = store.ask('who approves them?');
      await flush();
      const again = held.hold('ask.run');
      release(elsewhere(asked()[0]!, [placeOf(asked()[0]!, 'Who owns billing?')], { merge: [placeOf(asked()[0]!, 'Who signs invoices?'), placeOf(asked()[0]!, 'Where is the ledger?')] }));
      await flush();
      return { store, first, again, billing, invoices, ledger, pilot };
    };
    /** Whether every kept turn that followed one is in the thread of the turn it followed. */
    const followsHold = () => {
      const ids = threadIds(kept());
      return kept().every(each => each.follows == null || ids.get(each.follows) === ids.get(each.id));
    };

    it('joins the threads on the subject once the answer has landed, never before: the words asked again continue the thread\'s own latest turn', async () => {
      const { store, first, again, billing, invoices, ledger, pilot } = await sent();
      // Jumped, and asking again there. Nothing has moved yet, and no line offers an Undo.
      expect(store.threadShown()?.id).toBe(billing[0]!.id);
      expect(store.getState().ask?.asking).toMatchObject({ question: 'who approves them?', thread: billing[0]!.id });
      expect(store.mergedLine()).toBeNull();
      expect(filed()).toMatchObject({ 'Who signs invoices?': invoices[0]!.id, 'Where is the ledger?': ledger[0]!.id });
      // It continues billing's own turn, though the ledger's is newer, with nothing riding that could place it again.
      expect(asked()[1]).toMatchObject({ previous: { question: 'Who owns billing?' } });
      expect(asked()[1]).not.toHaveProperty('threads');
      again(ok(answerOf('who approves them?')));
      await first;
      await flush();
      expect(kept().at(-1)).toMatchObject({ text: 'who approves them?', thread: billing[0]!.id, follows: billing[0]!.id });
      expect(store.mergedLine()).toBe('Merged 2 threads');
      expect(filed()).toMatchObject({ 'Who signs invoices?': billing[0]!.id, 'Where is the ledger?': billing[0]!.id, 'When does the pilot start?': pilot[0]!.id });
      expect(followsHold()).toBe(true);
      // Undo takes the two threads back out, and the answer still follows a turn of its own thread.
      store.undoMerge();
      await flush();
      expect(filed()).toMatchObject({ 'Who signs invoices?': invoices[0]!.id, 'Where is the ledger?': ledger[0]!.id, 'who approves them?': billing[0]!.id });
      expect(store.askThread().map(each => each.text)).toEqual(['Who owns billing?', 'who approves them?']);
      expect(followsHold()).toBe(true);
      // The next question continues the answer, in billing's thread.
      await store.ask('and since when?');
      expect(asked().at(-1)).toMatchObject({ previous: { question: 'who approves them?' } });
      expect(kept().at(-1)).toMatchObject({ thread: billing[0]!.id });
    });

    it('moves nothing when the words asked again fail: there is nothing to undo, Try again asks them the same way, and the threads join when that answer lands', async () => {
      const { store, first, again, billing, invoices, ledger } = await sent();
      again(fail('unavailable', { retryable: true }));
      await first;
      await flush();
      expect(store.getState().ask).toMatchObject({ thread: { id: billing[0]!.id, entered: true }, merged: null, failed: { question: 'who approves them?', thread: billing[0]!.id } });
      const puts = calls('timeline.put').length;
      store.undoMerge();
      await flush();
      expect(calls('timeline.put')).toHaveLength(puts);
      expect(store.getState().ask?.failed).not.toBeNull();
      expect(filed()).toMatchObject({ 'Who signs invoices?': invoices[0]!.id, 'Where is the ledger?': ledger[0]!.id });
      store.retryAsk();
      await flush();
      expect(asked()[2]).toMatchObject({ question: 'who approves them?', previous: { question: 'Who owns billing?' } });
      expect(asked()[2]).not.toHaveProperty('threads');
      expect(kept().at(-1)).toMatchObject({ text: 'who approves them?', thread: billing[0]!.id, follows: billing[0]!.id });
      expect(store.mergedLine()).toBe('Merged 2 threads');
      store.undoMerge();
      await flush();
      expect(filed()).toMatchObject({ 'Who signs invoices?': invoices[0]!.id, 'Where is the ledger?': ledger[0]!.id, 'who approves them?': billing[0]!.id });
      expect(followsHold()).toBe(true);
    });

    it('moves nothing when the words asked again are cancelled', async () => {
      const { store, again, billing, invoices, ledger } = await sent();
      store.cancelAsk();
      again(ok(answerOf('who approves them?')));
      await flush();
      expect(kept()).toHaveLength(4);
      expect(store.mergedLine()).toBeNull();
      expect(filed()).toMatchObject({ 'Who signs invoices?': invoices[0]!.id, 'Where is the ledger?': ledger[0]!.id });
      expect(store.threadShown()?.id).toBe(billing[0]!.id);
    });

    it('joins them after a pick of "Which one?" too, once the picked thread\'s answer lands, and only those that live where it does', async () => {
      const billing = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY]);
      const tests = threadIn(inApollo, ['Which tests fail?', 5 * DAY]);
      const flaky = threadIn(inApollo, ['Which tests are flaky?', 4 * DAY]);
      seed(...billing, ...tests, ...flaky);
      // One thread named, in another home, so the page asks (R5); two more are said to be on its subject.
      script = params => (params.threads
        ? elsewhere(params, [placeOf(params, 'Which tests fail?')], { merge: [placeOf(params, 'Which tests are flaky?'), placeOf(params, 'Who owns billing?')] }) : null);
      const store = await startStore();
      await store.ask('are they fixed?');
      await flush();
      expect(store.getState().ask?.clarify).toMatchObject({ kind: 'threads', threads: [tests[0]!.id], merge: [flaky[0]!.id, billing[0]!.id] });
      const release = held.hold('ask.run');
      const pick = store.chooseThread(tests[0]!.id);
      await flush();
      // Jumped to Apollo and asking there, continuing the picked thread's own turn: nothing has moved yet.
      expect(asked()[1]).toMatchObject({ scope: inApollo, previous: { question: 'Which tests fail?' } });
      expect(filed()['Which tests are flaky?']).toBe(flaky[0]!.id);
      expect(store.mergedLine()).toBeNull();
      release(ok(answerOf('are they fixed?', inApollo)));
      await pick;
      await flush();
      expect(kept().at(-1)).toMatchObject({ text: 'are they fixed?', scope: inApollo, thread: tests[0]!.id, follows: tests[0]!.id });
      // Apollo's other thread joined; the one with no project lives elsewhere, and stays (R9).
      expect(store.mergedLine()).toBe('Merged with Which tests are flaky?');
      expect(filed()).toMatchObject({ 'Which tests are flaky?': tests[0]!.id, 'Who owns billing?': billing[0]!.id });
    });
  });
});

describe('a question a model wrote goes only while every turn that could have informed it is readable', () => {
  /** What only the other thread's source says: a name no one typed. */
  const NAME = 'Mina Park';
  /** The other thread: one turn, whose answer names Mina Park from ORION-7, a ticket the pilot's thread never cited. */
  const orion = () => {
    const question = 'Who leads the other team?';
    const statements = [said(`${NAME} leads it.`, [0])];
    return turn(question, 6 * DAY, { answer: { scope: GLOBAL, sources: [ticket('ORION-7', '30007')], outcome: 'answered', parts: [{ question, status: 'answered', statements, blocks: paragraphs(statements) }] } });
  };
  /** Access to ORION-7 is gone; everything else reads the same. */
  const orionGone = () => { checks = items => ok({ items: items.map(item => ({ state: item.citation.ticket_id === '30007' ? 'unreadable' : 'same' })) }); };
  /** The pilot's thread with the other merged into it, and a follow-up answered there whose full question the resolver wrote with the name. */
  const merged = async () => {
    const other = orion();
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
    seed(other, ...pilot);
    const store = await startStore();
    await store.openThread(pilot[0]!.id);
    store.mergeThread(other.id);
    await flush();
    const rewrite = `Who signs off the pilot that ${NAME} leads?`;
    script = params => (params.question === 'and who signs it off?' ? ok({ ...answerOf(String(params.question)), question: rewrite }) : null);
    await store.ask('and who signs it off?');
    await flush();
    // It followed the pilot's own turn: the merged turn is not one it followed, only one asked before it in its thread.
    const followUp = kept().at(-1)!;
    expect(followUp).toMatchObject({ typed: 'and who signs it off?', question: rewrite, follows: pilot[0]!.id, thread: pilot[0]!.id });
    expect((asked()[0]!.previous as AskPrevious).earlier!.map(each => each.question)).toEqual(['Who leads the other team?']);
    return { store, other, pilot, followUp, rewrite };
  };

  it('sends the earlier question a model wrote only while the merged turn it may have drawn on is still readable; once it is not, the typed words go and nothing of that turn', async () => {
    const { store, followUp, rewrite } = await merged();
    // Access to the other thread's source goes. The rewrite carries what that source said, so the next follow-up names
    // the turn it continues by the words typed for it, and the turn that lost its source rides with no sentence.
    orionGone();
    await store.ask('and where?');
    expect(JSON.stringify(asked()[1])).not.toContain(NAME);
    const previous = asked()[1]!.previous as AskPrevious;
    expect(previous).toMatchObject({ purpose: 'follow_up', question: 'and who signs it off?' });
    expect(previous.statements).toHaveLength(2);
    expect(previous.earlier!.map(each => [each.question, each.statements.length])).toEqual([['Who leads the other team?', 0], ['When does the pilot start?', 2]]);
    // Readable again, a follow-up of that same turn names its question in full, as before.
    checks = items => ok({ items: items.map(() => ({ state: 'same' })) });
    store.toggleTurn(followUp.id);
    await store.ask('and by when?');
    expect(asked()[2]!.previous).toMatchObject({ purpose: 'follow_up', question: rewrite });
    expect((asked()[2]!.previous as AskPrevious).earlier!.map(each => each.statements.length)).toEqual([1, 2]);
  });

  it('holds for Ask again, and for a choice of "Which one?", which is asked only while the turn it was offered for passes the same check', async () => {
    const { store, followUp } = await merged();
    orionGone();
    // Ask again of the turn whose question was rewritten: its typed words are asked, and name it.
    store.askAgain(followUp.id);
    await flush();
    expect(asked()[1]).toMatchObject({ question: 'and who signs it off?', previous: { purpose: 'ask_again', question: 'and who signs it off?' } });
    expect(JSON.stringify(asked()[1])).not.toContain(NAME);
    // A follow-up that could mean several things: the choices are a model's, written with the thread before it.
    const choices = [{ label: NAME, question: `What does ${NAME} still have to approve?` }, { label: 'The sponsor', question: 'What does the sponsor still have to approve?' }];
    script = params => (params.question === 'what is left for them?'
      ? ok({ scope: GLOBAL, sources: [], parts: [], outcome: 'clarify', receipt: { looked_through: 0 }, question: 'what is left for them?', choices }) : null);
    await store.ask('what is left for them?');
    await flush();
    expect(store.getState().ask?.clarify).toMatchObject({ kind: 'choices', typed: 'what is left for them?' });
    store.chooseClarified(choices[0]!);
    await flush();
    // The person's own follow-up is asked again instead of the choice.
    expect(asked().at(-1)).toMatchObject({ question: 'what is left for them?' });
    expect(JSON.stringify(asked().at(-1))).not.toContain(NAME);
    // Readable again, a choice is asked as its full question.
    checks = items => ok({ items: items.map(() => ({ state: 'same' })) });
    store.chooseClarified(choices[1]!);
    await flush();
    expect(asked().at(-1)).toMatchObject({ question: 'What does the sponsor still have to approve?' });
  });

  it('counts the turns before a turn it followed in another thread: an answer that started a thread was still written with the thread it was asked in', async () => {
    const other = orion();
    const pilot = turn('When does the pilot start?', 3 * DAY);
    // The other thread's turn was merged into the pilot's: it is before the pilot's own turn, and not a turn that one followed.
    seed({ ...other, thread: pilot.id }, pilot);
    const rewrite = `What does ${NAME} want for lunch?`;
    script = params => (params.question === 'and for lunch?' ? ok({ ...answerOf(String(params.question)), question: rewrite, thread: { kind: 'new' } }) : null);
    const store = await startStore();
    await store.openThread(pilot.id);
    await flush();
    await store.ask('and for lunch?');
    await flush();
    const lunch = kept().at(-1)!;
    expect(lunch).toMatchObject({ question: rewrite, follows: pilot.id, thread: lunch.id });
    orionGone();
    await store.ask('and tomorrow?');
    expect(asked()[1]!.previous).toMatchObject({ purpose: 'follow_up', question: 'and for lunch?' });
    expect(JSON.stringify(asked()[1])).not.toContain(NAME);
  });
});

describe('every turn of a thread was asked in its home (R9)', () => {
  /** The turns kept in a thread that lives somewhere other than where they were asked, in memory and in the file. */
  const strays = (store: Store) => [store.getState().timeline.turns, kept()].map(turns =>
    threadsOf(turns).flatMap(thread => thread.turns.filter(each => !sameScope(each.scope, thread.home)).map(each => each.text)));
  /** A question Apollo had nothing on: the one kind of turn Ask everywhere is offered on. */
  const notFound: Partial<TimelineTurn> = { scope: inApollo, answer: { scope: inApollo, sources: [], parts: [], outcome: 'not_found' } };

  it('holds through a question, a pick, a jump, Ask again, Ask everywhere, a merge and its Undo', async () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY], ['when is it due?', 5 * DAY]);
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY]);
    const budget = turn('Is there a budget?', 3 * DAY, notFound);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(...billing, ...tests, budget, ...pilot);
    const store = await startStore();
    // A jump to Apollo's thread, then the bar widened: the question is asked everywhere, so it joins no thread of Apollo's.
    await store.openThread(tests[0]!.id);
    store.widenScope();
    await store.ask('and across everything?');
    await flush();
    expect(kept().at(-1)).toMatchObject({ scope: GLOBAL, follows: null, thread: kept().at(-1)!.id });
    expect(strays(store)).toEqual([[], []]);
    // A pick of "Which one?" at Home: the words are asked again in Apollo, where the thread lives, and land in it.
    script = params => (params.question === 'are they fixed?' && params.threads ? elsewhere(params, [placeOf(params, 'Which tests fail?')]) : null);
    store.goHome();
    await store.ask('are they fixed?');
    await flush();
    await store.chooseThread(tests[0]!.id);
    await flush();
    expect(kept().at(-1)).toMatchObject({ text: 'are they fixed?', scope: inApollo, thread: tests[0]!.id });
    expect(strays(store)).toEqual([[], []]);
    // Ask again asks where its turn was asked, whatever the bar asks; Ask everywhere starts a thread with no project.
    store.goHome();
    store.askAgain(billing[1]!.id);
    await flush();
    expect(kept().at(-1)).toMatchObject({ again_of: billing[1]!.id, scope: GLOBAL, thread: billing[0]!.id });
    await store.openThread(budget.id);
    store.askEverywhere(budget.id);
    await flush();
    expect(kept().at(-1)).toMatchObject({ text: 'Is there a budget?', scope: GLOBAL, thread: kept().at(-1)!.id });
    expect(strays(store)).toEqual([[], []]);
    // A merge, by hand and on an answer's word, and its Undo: only threads of one home ever join.
    await store.openThread(pilot[0]!.id);
    for (const other of [billing[0]!, tests[0]!, budget]) store.mergeThread(other.id);
    await flush();
    expect(filed()).toMatchObject({ 'Who owns billing?': pilot[0]!.id, 'Which tests fail?': tests[0]!.id });
    expect(kept().find(each => each.id === budget.id)!.thread).toBe(budget.id);
    expect(strays(store)).toEqual([[], []]);
    store.undoMerge();
    await flush();
    expect(filed()['Who owns billing?']).toBe(billing[0]!.id);
    script = params => (params.threads ? ok({ ...answerOf(String(params.question)), merge: (params.threads as AskThread[]).map((_, place) => place) }) : null);
    await store.ask('and the budget?');
    await flush();
    // Every thread was named: those with no project joined, Apollo's two did not.
    expect(store.threads().map(thread => [thread.name, thread.home, thread.turns.length])).toEqual([
      ['When does the pilot start?', GLOBAL, 7], ['Which tests fail?', inApollo, 2], ['Is there a budget?', inApollo, 1]]);
    expect(strays(store)).toEqual([[], []]);
    store.undoMerge();
    await flush();
    expect(strays(store)).toEqual([[], []]);
  });

  it('builds nothing on a turn a file keeps in a thread of another home: a follow-up continues the thread\'s own latest, and Ask again of that turn starts a thread where it was asked', async () => {
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY], ['and who fixes them?', 3 * DAY]);
    // Asked with no project, and kept in Apollo's thread: no desktop saves one so, and a file may still hold it.
    const stray = turn('What did the board decide?', DAY, { thread: tests[0]!.id, follows: tests[1]!.id });
    seed(...tests, stray);
    const store = await startStore();
    await store.openThread(tests[0]!.id);
    await flush();
    expect(store.getState().barScope).toEqual(inApollo);
    await store.ask('since when?');
    await flush();
    // The stray turn is the thread's newest, and nothing of it goes into Apollo's request.
    const previous = asked()[0]!.previous as AskPrevious;
    expect(previous).toMatchObject({ purpose: 'follow_up', question: 'and who fixes them?' });
    expect(previous.earlier!.map(each => each.question)).toEqual(['Which tests fail?']);
    expect(JSON.stringify(asked()[0])).not.toContain('board');
    expect(kept().at(-1)).toMatchObject({ text: 'since when?', scope: inApollo, thread: tests[0]!.id, follows: tests[1]!.id });
    // Ask again of it asks with no project, carrying the turn itself, and its answer starts a thread there.
    store.askAgain(stray.id);
    await flush();
    expect(asked()[1]).toMatchObject({ scope: GLOBAL, previous: { purpose: 'ask_again', question: 'What did the board decide?' } });
    const again = kept().at(-1)!;
    expect(again).toMatchObject({ again_of: stray.id, scope: GLOBAL, thread: again.id });
    expect(store.threadShown()).toMatchObject({ id: again.id, home: GLOBAL });
    // Only the turn the file came with is out of place.
    expect(strays(store)).toEqual([['What did the board decide?'], ['What did the board decide?']]);
  });
});

describe('the way out of every wait', () => {
  const seeded = () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY], ['when is it due?', 5 * DAY]);
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY], ['did that change?', 2 * DAY]);
    seed(...billing, ...tests, ...pilot);
    return { billing, tests, pilot };
  };
  /** The first Ask says the question belongs to billing's thread; the Ask it is asked again with is held. */
  const jumping = async (store: Store, from: 'page' | 'thread') => {
    if (from === 'thread') { store.returnToAsk(); await flush(); }
    const first = held.hold('ask.run');
    void store.ask('who approves the invoices?');
    await flush();
    const again = held.hold('ask.run');
    first(elsewhere(asked().at(-1)!, [placeOf(asked().at(-1)!, 'Who owns billing?')]));
    await flush();
    return again;
  };

  it('cancels the question asked again after a jump: Ask opened for it closes, and one open before stays on the thread it moved to; a late answer is dropped', async () => {
    const { billing } = seeded();
    const store = await startStore();
    let late = await jumping(store, 'page');
    expect(store.getState().ask).toMatchObject({ thread: { id: billing[0]!.id, entered: true }, forQuestion: true });
    expect(store.getState().ask?.asking?.question).toBe('who approves the invoices?');
    store.cancelAsk();
    expect(store.getState().ask).toBeNull();
    expect(calls('ask.cancel')).toHaveLength(1);
    late(ok(answerOf('who approves the invoices?')));
    await flush();
    expect(kept()).toHaveLength(5);
    // With Ask open before: it stays, on the thread it jumped to, with nothing on its way and nothing kept.
    late = await jumping(store, 'thread');
    store.cancelAsk();
    expect(store.getState().ask).toMatchObject({ thread: { id: billing[0]!.id, entered: true }, asking: null, failed: null, clarify: null });
    late(ok(answerOf('who approves the invoices?')));
    await flush();
    expect(kept()).toHaveLength(5);
    expect(await questions(store)).toEqual(['when is it due?']);
    // The next question typed there is that thread's, asked as any other.
    await store.ask('and next quarter?');
    expect(asked().at(-1)).toMatchObject({ previous: { question: 'when is it due?' } });
    expect(asked().at(-1)!.threads).toBeDefined();
  });

  it('shows a failure of the question asked again after a jump, and Try again asks it the same way: in that thread, with no thread riding', async () => {
    const { billing } = seeded();
    const store = await startStore();
    const again = await jumping(store, 'thread');
    again(fail('unavailable', { retryable: true }));
    await flush();
    expect(store.getState().ask).toMatchObject({ thread: { id: billing[0]!.id, entered: true }, asking: null, failed: { question: 'who approves the invoices?', failure: { code: 'unavailable' } } });
    expect(byTestId(await page(store), 'ask-retry')).toHaveLength(1);
    store.retryAsk();
    await flush();
    expect(asked().at(-1)).toMatchObject({ question: 'who approves the invoices?', previous: { question: 'when is it due?' } });
    expect(asked().at(-1)).not.toHaveProperty('threads');
    expect(kept().at(-1)).toMatchObject({ text: 'who approves the invoices?', thread: billing[0]!.id });
    expect(store.getState().ask?.failed).toBeNull();
  });

  it('refuses a jump, a merge and Undo while a question is on its way, so an answer always lands in the thread that shows', async () => {
    const { billing, pilot } = seeded();
    const store = await startStore();
    await store.openThread(pilot[0]!.id);
    await flush();
    store.mergeThread(billing[0]!.id);
    await flush();
    const release = held.hold('ask.run');
    void store.ask('and the budget?');
    await flush();
    const before = store.getState().ask;
    expect(await store.openThread(billing[0]!.id)).toBe(false);
    store.mergeThread(billing[0]!.id);
    store.undoMerge();
    void store.chooseThread(billing[0]!.id);
    store.askNewQuestion();
    expect(store.getState().ask).toBe(before);
    expect(asked()).toHaveLength(1);
    release(ok(answerOf('and the budget?')));
    await flush();
    expect(kept().at(-1)).toMatchObject({ text: 'and the budget?', thread: pilot[0]!.id });
  });

  it('drops an answer once Ask is closed or the page changes, and keeps nothing of it', async () => {
    seeded();
    const store = await startStore();
    for (const leave of [() => store.closeAsk(), () => { void store.openProject(apollo); }, () => store.goHome()]) {
      store.returnToAsk();
      await flush();
      const release = held.hold('ask.run');
      void store.ask('and the budget?');
      await flush();
      leave();
      release(ok(answerOf('and the budget?')));
      await flush();
      expect(store.getState().ask).toBeNull();
      expect(kept()).toHaveLength(5);
    }
    // The same for a question that belongs elsewhere: closed meanwhile, nothing jumps and nothing is asked again.
    store.goHome();
    const first = held.hold('ask.run');
    void store.ask('who approves the invoices?');
    await flush();
    const sent = asked().length;
    store.closeAsk();
    first(elsewhere(asked().at(-1)!, [0]));
    await flush();
    expect(store.getState().ask).toBeNull();
    expect(asked()).toHaveLength(sent);
  });

  it('keeps nothing of an answer for an account that signed out or changed meanwhile, and leaves no question on its way', async () => {
    seeded();
    const store = await startStore();
    store.returnToAsk();
    await flush();
    let release = held.hold('ask.run');
    void store.ask('and the budget?');
    await flush();
    // The session ended: Ask stays behind the sign-in page for the same person, but the answer is nobody's to keep.
    app = { signed_in: false, account: null, client_version: 'test' };
    await store.refreshStatus();
    const puts = calls('timeline.put').length;
    release(ok(answerOf('and the budget?')));
    await flush();
    expect(calls('timeline.put')).toHaveLength(puts);
    expect(store.getState().ask?.asking ?? null).toBeNull();
    expect(kept()).toHaveLength(5);
    // Another account signs in: nothing of the last one's Ask stays, and its late answer lands nowhere.
    app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
    await store.refreshStatus();
    await flush();
    store.returnToAsk();
    await flush();
    release = held.hold('ask.run');
    void store.ask('and the owner?');
    await flush();
    const other = { ...ACCOUNT, membership_id: 'another-member' };
    app = { signed_in: true, account: other, client_version: 'test' };
    await store.refreshStatus();
    await flush();
    release(elsewhere(asked().at(-1)!, [0]));
    await flush();
    expect(store.getState().ask).toBeNull();
    expect(store.getState().timeline.turns).toEqual([]);
    expect(timelineFiles.get(fileOf(other)) ?? []).toEqual([]);
    expect(kept()).toHaveLength(5);
  });

  it('offers no button for a thread "Which one?" named that has since been merged away, and picking it does nothing', async () => {
    const { billing, pilot } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'When does the pilot start?'), placeOf(params, 'Who owns billing?')]) : null);
    const store = await startStore();
    await store.ask('did that change?');
    await flush();
    expect(store.clarifyThreads().map(each => each.name)).toEqual(['When does the pilot start?', 'Who owns billing?']);
    // Billing's turns join the pilot's thread (as a merge elsewhere would leave the file): billing is no longer a thread.
    timelineFiles.set(fileOf(ACCOUNT), kept().map(each => (each.thread === billing[0]!.id ? { ...each, thread: pilot[0]!.id } : each)));
    app = { signed_in: false, account: null, client_version: 'test' };
    await store.refreshStatus();
    app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
    await store.refreshStatus();
    await flush();
    expect(store.clarifyThreads().map(each => each.name)).toEqual(['When does the pilot start?']);
    expect(byTestId(await page(store), 'choice').map(text)).toEqual(['When does the pilot start?', 'New question']);
    const sent = asked().length;
    await store.chooseThread(billing[0]!.id);
    await flush();
    expect(asked()).toHaveLength(sent);
    expect(store.getState().ask?.clarify).not.toBeNull();
    // The thread still there, and "New question", both still work.
    await store.chooseThread(pilot[0]!.id);
    await flush();
    expect(asked().at(-1)).toMatchObject({ question: 'did that change?', previous: { question: 'did that change?' } });
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
  });

  it('shows no thread once the open one is gone from the timeline read again, and a question typed then starts one', async () => {
    const { pilot } = seeded();
    const store = await startStore();
    store.returnToAsk();
    await flush();
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
    // The file comes back without that thread.
    timelineFiles.set(fileOf(ACCOUNT), kept().filter(each => each.thread !== pilot[0]!.id));
    app = { signed_in: false, account: null, client_version: 'test' };
    await store.refreshStatus();
    app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
    await store.refreshStatus();
    await flush();
    expect(store.getState().ask?.thread).toEqual({ id: pilot[0]!.id, entered: false });
    expect(store.threadShown()).toBeUndefined();
    expect(store.askThread()).toEqual([]);
    expect(text(byTestId(await page(store), 'thread-name')[0])).toBe('New thread');
    await store.ask('and the budget?');
    await flush();
    expect(asked().at(-1)).not.toHaveProperty('previous');
    const saved = kept().at(-1)!;
    expect(saved.thread).toBe(saved.id);
    expect(store.threadShown()?.id).toBe(saved.id);
  });

  it('asks without the threads when nothing of the turn a follow-up continues may go, so it stays in the thread it was typed in', async () => {
    // A turn saved before the person's typed words were kept, one of whose sources is gone: no earlier turn may go.
    const { typed: _typed, follows: _follows, thread: _thread, ...legacy } = turn('What changed on THERM-555?', 2 * DAY);
    const other = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY]);
    seed(...other, legacy);
    checks = items => ok({ items: items.map(() => ({ state: 'unreadable' })) });
    const store = await startStore();
    await store.openThread(legacy.id);
    await flush();
    await store.ask('who owns it?');
    await flush();
    for (const key of ['previous', 'threads']) expect(asked()[0]).not.toHaveProperty(key);
    expect(kept().at(-1)).toMatchObject({ text: 'who owns it?', thread: legacy.id });
    // Saved again for what the check found, the old turn is named with the thread it belonged to all along.
    expect(kept().find(each => each.id === legacy.id)).toMatchObject({ thread: legacy.id, unreadable: [0, 1] });
  });
});
