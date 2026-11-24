// Ask threads (ADR-0056, Ask threads v1), in the rules and in the store: which thread a turn belongs to, a thread's home
// and name, what an Ask carries of the other threads and of its own thread's older turns and how that is cut to fit;
// where an answer lands; the jump, "Which one?" between threads and "New question"; merging and its Undo; and the way
// out of every wait (cancel, failure, another account, a page change, closing Ask, the timeline read again).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonAnswerCitationV8 } from '@echo-brain/organization-api';
import type { Answer, AnswerSource, AnswerStatement, AppStatus, AskPrevious, AskScope, AskThread, TimelineTurn } from '../../src/shared/protocol.js';
import { MAX_REQUEST_BYTES } from '../../src/shared/protocol.js';
import {
  askCarries, earlierOf, otherThreads, ownWords, threadGroups, threadIds, threadsOf, undoable, type AskEarlierTurn, type Thread,
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
let app: AppStatus;
let active = [apollo, zephyr];
storeLifecycle(NOW);
beforeEach(() => {
  ids = 0;
  held = new Held();
  checks = items => ok({ items: items.map(() => ({ state: 'same' })) });
  script = null;
  unsaved = new Set();
  app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  active = [apollo, zephyr];
  rpc.mockReset();
  const base = rpcFor(held, {
    'app.status': () => ok(app),
    'ask.run': params => script?.(params) ?? ok(answerOf(String(params.question), params.scope as AskScope)),
    'ask.check': params => (checks ? checks(params.items as never) : fail('not_supported')),
    'ask.record': () => fail('not_found'),
    'projects.read': params => { const found = active.find(item => item.project_id === params.project_id); return found ? ok(found) : fail('not_found'); },
  }, () => ({ active, archived: [] }));
  rpc.mockImplementation(async (method: string, params: Record<string, unknown>) =>
    (method === 'timeline.put' && unsaved.has((params.turn as TimelineTurn).id) ? fail('invalid_output') : base(method, params)));
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
    const merged = turn('Asked at Home, merged in by hand', DAY, { thread: a1!.id });
    expect(threadsOf([a1!, a2!, merged])[0]!.home).toEqual(inApollo);
    // The first turn gone (the file let its oldest go): the oldest left says where it lives.
    expect(threadsOf([a2!, merged])[0]).toMatchObject({ id: a1!.id, home: inApollo });
    expect(threadsOf([merged])[0]).toMatchObject({ id: a1!.id, home: GLOBAL });
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
    // With none to send the request has no list at all.
    expect(askCarries('and the budget?', GLOBAL, null, [], [])).toEqual({ sent: [] });
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
    expect(fewer).not.toHaveProperty('threads');
    expect(fewer.sent).toEqual([]);
    expect(fewer.previous!.earlier!.map(each => each.question.slice(0, 8))).toEqual(['Older 2?', 'Older 3?', 'Older 4?']);
    expect(body(fewer)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    // Nothing older fits: the previous turn goes as it is, with no empty list beside it.
    expect(askCarries('q?', GLOBAL, previous, [older(0, 2_000_000)], []).previous).toEqual(previous);
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
    expect(undoable(moved, a1!.id, merged)).toBe(true);
    // One moved again, one gone, and a merge that moved nothing.
    expect(undoable(moved, a1!.id, [a1!, merged[1]!, { ...b2!, thread: b2!.id }])).toBe(false);
    expect(undoable(moved, a1!.id, [a1!, merged[1]!])).toBe(false);
    expect(undoable([], a1!.id, merged)).toBe(false);
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
    expect(asked()[0]).not.toHaveProperty('threads');
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
    expect(store.returnToAsk()).toBe(true);
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
    store.returnToAsk();
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
    store.returnToAsk();
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
    store.returnToAsk();
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
    expect(store.getState().ask?.clarify).toEqual({ kind: 'threads', question: 'did that change?', scope: GLOBAL, threads: [pilot[0]!.id, billing[0]!.id], merge: [] });
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
    // In Zephyr, which has no thread: nothing rides.
    vi.setSystemTime(NOW.getTime() + 60_000);
    await store.openProject(zephyr);
    await store.ask('What is blocked?');
    expect(asked()[1]).toMatchObject({ scope: inZephyr });
    expect(asked()[1]).not.toHaveProperty('threads');
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
    store.returnToAsk();
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
    expect(store.getState().ask).toMatchObject({ thread: tests[0]!.id, opened: tests[0]!.id, focus: tests[0]!.id });
    expect(byTestId(await page(store), 'opened-turn')).toHaveLength(1);
    // The question typed next continues the turn chosen.
    await store.ask('since when?');
    expect(asked()[0]).toMatchObject({ scope: inApollo, previous: { question: 'Which tests fail?' } });
  });

  it('lists the threads under the name, the open one marked, and a row jumps while Merge joins that thread to the open one', async () => {
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
    const rows = byTestId(list(), 'thread-row');
    expect(rows.map(row => text((row.props.children as unknown[])[0]))).toEqual(['When does the pilot start?', 'Who owns billing?', 'Which tests fail?']);
    expect(rows.map(row => row.props['aria-current'])).toEqual(['true', undefined, undefined]);
    // The open thread's row does nothing, and has no Merge; every other has one.
    expect(rows[0]!.props.onClick).toBeUndefined();
    expect(byTestId(list(), 'thread-merge').map(button => button.props['aria-label'])).toEqual(['Merge into this thread', 'Merge into this thread']);
    expect(byTestId(list(), 'thread-find')[0]!.props.placeholder).toBe('Find a thread');
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
  const opened = async () => {
    const store = await startStore();
    store.returnToAsk();
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

  it('merges a thread from another home by hand: its turns keep where they were asked, and the thread stays where it lives', async () => {
    const { tests, pilot } = seeded();
    const store = await opened();
    store.mergeThread(tests[0]!.id);
    await flush();
    expect(kept().find(each => each.id === tests[0]!.id)).toMatchObject({ thread: pilot[0]!.id, scope: inApollo });
    expect(store.threadShown()).toMatchObject({ id: pilot[0]!.id, home: GLOBAL });
    expect(store.mergedLine()).toBe('Merged with Which tests fail?');
  });

  it.each(['the next question', 'a jump', 'closing Ask'] as const)('offers Undo until %s, and then drops it', async (leave) => {
    const { billing, tests, pilot } = seeded();
    const store = await opened();
    store.mergeThread(billing[0]!.id);
    expect(store.mergedLine()).toBe('Merged with Who owns billing?');
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

  it('puts back a turn the file did not take, says so, and leaves Undo for what did move: the page never shows a merge the file does not hold', async () => {
    const { billing, pilot } = seeded();
    const store = await opened();
    unsaved.add(billing[1]!.id);
    store.mergeThread(billing[0]!.id);
    // Until the file answers, the page shows the merge it asked for.
    expect(store.askThread().map(each => each.text)).toContain('when is it due?');
    await flush();
    const { THREADS_NOT_SAVED } = await import('../../src/renderer/store.js');
    expect(store.getState().toast).toBe(THREADS_NOT_SAVED);
    // Memory and the file agree: the first turn moved, the second is where it was.
    const inMemory = Object.fromEntries(store.getState().timeline.turns.map(each => [each.text, each.thread]));
    expect(inMemory).toEqual(filed());
    expect(filed()).toMatchObject({ 'Who owns billing?': pilot[0]!.id, 'when is it due?': billing[0]!.id });
    expect(store.askThread().map(each => each.text)).toEqual(['Who owns billing?', 'When does the pilot start?', 'did that change?']);
    // The line tells of what moved, and Undo takes back exactly that.
    expect(store.getState().ask?.merged?.moved).toEqual([{ turn: billing[0]!.id, from: billing[0]!.id }]);
    expect(store.mergedLine()).toBe('Merged with Who owns billing?');
    unsaved.clear();
    store.undoMerge();
    await flush();
    expect(filed()).toMatchObject({ 'Who owns billing?': billing[0]!.id, 'when is it due?': billing[0]!.id });
    // Nothing moved at all: no line, and the page says why.
    unsaved = new Set(billing.map(each => each.id));
    store.mergeThread(billing[0]!.id);
    await flush();
    expect(store.mergedLine()).toBeNull();
    expect(store.getState().ask?.merged).toBeNull();
    expect(store.getState().toast).toBe(THREADS_NOT_SAVED);
    expect(store.askThread().map(each => each.text)).toEqual(['When does the pilot start?', 'did that change?']);
  });

  it('keeps a turn merged, and says so, when Undo could not save it back', async () => {
    const { billing, pilot } = seeded();
    const store = await opened();
    store.mergeThread(billing[0]!.id);
    await flush();
    unsaved.add(billing[0]!.id);
    store.undoMerge();
    await flush();
    const { THREADS_NOT_SAVED } = await import('../../src/renderer/store.js');
    expect(store.getState().toast).toBe(THREADS_NOT_SAVED);
    expect(filed()).toMatchObject({ 'Who owns billing?': pilot[0]!.id, 'when is it due?': billing[0]!.id });
    expect(Object.fromEntries(store.getState().timeline.turns.map(each => [each.text, each.thread]))).toEqual(filed());
    expect(store.mergedLine()).toBeNull();
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

  it('merges beside a jump: the threads on the subject of the one the question belongs to join it after the jump, and the line stays while it is asked there', async () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY]);
    const invoices = threadIn(GLOBAL, ['Who signs invoices?', 5 * DAY]);
    const ledger = threadIn(GLOBAL, ['Where is the ledger?', 4 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
    seed(...billing, ...invoices, ...ledger, ...pilot);
    const store = await opened();
    const release = held.hold('ask.run');
    const first = store.ask('who approves them?');
    await flush();
    release(elsewhere(asked()[0]!, [placeOf(asked()[0]!, 'Who owns billing?')], { merge: [placeOf(asked()[0]!, 'Who signs invoices?'), placeOf(asked()[0]!, 'Where is the ledger?')] }));
    const again = held.hold('ask.run');
    await flush();
    // Jumped, merged, and asking again there: the line shows while the question is on its way.
    expect(store.threadShown()?.id).toBe(billing[0]!.id);
    expect(store.getState().ask?.asking?.question).toBe('who approves them?');
    expect(store.mergedLine()).toBe('Merged 2 threads');
    expect(filed()).toMatchObject({ 'Who signs invoices?': billing[0]!.id, 'Where is the ledger?': billing[0]!.id, 'When does the pilot start?': pilot[0]!.id });
    // It continues the merged thread's latest turn, with nothing riding that could place it again.
    expect(asked()[1]).toMatchObject({ previous: { question: 'Where is the ledger?' } });
    expect(asked()[1]).not.toHaveProperty('threads');
    // Undo waits for the answer, as every thread action does while a question is on its way.
    store.undoMerge();
    await flush();
    expect(store.mergedLine()).toBe('Merged 2 threads');
    expect(filed()).toMatchObject({ 'Who signs invoices?': billing[0]!.id, 'Where is the ledger?': billing[0]!.id });
    again(ok(answerOf('who approves them?')));
    await first;
    await flush();
    expect(kept().at(-1)).toMatchObject({ text: 'who approves them?', thread: billing[0]!.id });
    expect(store.mergedLine()).toBe('Merged 2 threads');
    // The person's next question ends the offer.
    await store.ask('and since when?');
    expect(store.mergedLine()).toBeNull();
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
    expect(store.getState().ask).toMatchObject({ thread: billing[0]!.id, forQuestion: true });
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
    expect(store.getState().ask).toMatchObject({ thread: billing[0]!.id, asking: null, failed: null, clarify: null });
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
    expect(store.getState().ask).toMatchObject({ thread: billing[0]!.id, asking: null, failed: { question: 'who approves the invoices?', failure: { code: 'unavailable' } } });
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
    store.returnToAsk();
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
    expect(store.getState().ask?.thread).toBe(pilot[0]!.id);
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
    store.returnToAsk();
    await flush();
    await store.ask('who owns it?');
    await flush();
    for (const key of ['previous', 'threads']) expect(asked()[0]).not.toHaveProperty(key);
    expect(kept().at(-1)).toMatchObject({ text: 'who owns it?', thread: legacy.id });
    // Saved again for what the check found, the old turn is named with the thread it belonged to all along.
    expect(kept().find(each => each.id === legacy.id)).toMatchObject({ thread: legacy.id, unreadable: [0, 1] });
  });
});
