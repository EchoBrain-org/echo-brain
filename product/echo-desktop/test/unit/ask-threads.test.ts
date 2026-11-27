// Ask threads (ADR-0056) and the conversations they make (ADR-0057), in the rules and in the store: which thread a turn
// belongs to, a thread's home and name, a conversation (chain) and its label, what an Ask carries of the other
// conversations and of its own older turns and how that is cut to fit; where an answer lands, a joined thread never
// changing, "Which one?" and "New question"; what ECHO just did and its Undo; links; the door; and the way out of every
// wait (cancel, failure, another account, a page change, closing Ask, the timeline read again).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonAnswerCitationV8 } from '@echo-brain/organization-api';
import type { Answer, AnswerSource, AnswerStatement, AppStatus, AskPrevious, AskScope, AskThread, PendingTurn, TimelineTurn } from '../../src/shared/protocol.js';
import { MAX_REQUEST_BYTES, THREAD_ACTIVE_MS } from '../../src/shared/protocol.js';
import {
  askCarries, chainsOf, continuedThread, doorChains, earlierOf, homeTurns, labelOf, otherChains, ownWords, sameScope, threadActive, threadIds, threadsOf,
  type AskEarlierTurn, type Chain, type Thread,
} from '../../src/renderer/timeline.js';
import { paragraphs } from '../fixtures/authority.js';
import {
  ACCOUNT, byTestId, click, elements, fail, fileOf, flush, Held, numbered, ok, plainHooks, project, render, rpcFor, startStore, storeLifecycle, text,
  timelineFiles,
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
    typed: question, follows: null, thread: id, carried: [], ...extra };
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
  app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  active = [apollo, zephyr];
  archived = [];
  rpc.mockReset();
  const base = rpcFor(held, {
    'app.status': () => ok(app),
    'ask.run': params => script?.(params) ?? answered(params),
    'ask.check': params => (checks ? checks(params.items as never) : fail('not_supported')),
    'ask.record': () => fail('not_found'),
    'open.ref': () => fail('not_found'),
    'projects.read': params => { const found = [...active, ...archived].find(item => item.project_id === params.project_id); return found ? ok(found) : fail('not_found'); },
  }, () => ({ active, archived }));
  rpc.mockImplementation(base);
});

const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params as Record<string, unknown>);
const asked = () => calls('ask.run');
const seed = (...turns: TimelineTurn[]) => { timelineFiles.set(fileOf(ACCOUNT), turns); };
const kept = () => timelineFiles.get(fileOf(ACCOUNT)) ?? [];
/** Each kept turn's thread, by what was typed for it. */
type Store = Awaited<ReturnType<typeof startStore>>;
const screens = () => import('../../src/renderer/screens/ask.js');
async function page(store: Store) {
  return render((await screens()).AskView({ state: store.getState() }));
}
const questions = async (store: Store) => byTestId(await page(store), 'question').map(text);
/** Ask on the thread `id`, by default the one asked in most recently, picked from the door: the person is in it. */
async function opened(id?: string) {
  const store = await startStore();
  await store.openThread(id ?? store.getState().timeline.turns.at(-1)!.thread!);
  await flush();
  return store;
}
/** Signed out and in again as the same person, Ask open behind the sign-in page: the timeline is read again, as a restart reads it. */
async function readAgain(store: Store) {
  app = { signed_in: false, account: null, client_version: 'test' };
  await store.refreshStatus();
  app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  await store.refreshStatus();
  await flush();
}
/**
 * The answer the Authority gives a request, as the host hands it to the page (T2): it names the question whenever the
 * request carried `previous` or `threads`, and says a question that carried threads and no previous turn is a new
 * subject. `extra` says more, or otherwise.
 */
const answered = (params: Record<string, unknown>, extra: Partial<Answer> = {}) => ok({
  ...answerOf(String(params.question), params.scope as AskScope),
  ...(params.previous !== undefined || params.threads !== undefined ? { question: String(params.question) } : {}),
  ...(params.threads !== undefined && params.previous === undefined ? { thread: { kind: 'new' } } : {}), ...extra,
});
/** A clarify answer naming the threads at `places` of those sent, as the host hands one to the page. */
const elsewhere = (params: Record<string, unknown>, places: readonly number[], extra: Partial<Answer> = {}) => ok({ scope: params.scope, sources: [], parts: [], outcome: 'clarify',
  receipt: { looked_through: 0 }, question: String(params.question), thread: { kind: 'other', threads: places }, ...extra });
/** Where, among the conversations a request sent, the one whose first typed question is `name` is. */
const placeOf = (params: Record<string, unknown>, name: string) => (params.threads as AskThread[]).findIndex(thread => thread.questions[0] === name);

describe('which thread a turn belongs to, and what a thread is (R8, R9, R2)', () => {
  it('groups turns by the thread they name, each oldest first; a turn saved before threads goes with the turn it followed or asked again while that is kept and was asked in the same place (R8); a thread lives where its first, or oldest kept, turn was asked', () => {
    const [a1, a2] = threadIn(GLOBAL, ['When does Apollo launch?', 3 * DAY], ['did that change?', DAY]);
    const [b1] = threadIn(GLOBAL, ['Who owns billing?', 2 * DAY]);
    expect(threadsOf([a1!, b1!, a2!]).map(thread => [thread.id, thread.turns.map(each => each.id), thread.asked_at])).toEqual([[a1!.id, [a1!.id, a2!.id], a2!.asked_at], [b1!.id, [b1!.id], b1!.asked_at]]);
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
    // Its home is its first turn's place, wherever its other turns were asked; the first gone, its oldest kept turn's.
    const [p1, p2] = threadIn(inApollo, ['What is left in Apollo?', 3 * DAY], ['and who owns it?', 2 * DAY]);
    // No desktop saves one so (R9); a file can still hold it.
    const stray = turn('Asked at Home, kept in Apollo\'s thread', DAY, { thread: p1!.id });
    expect(threadsOf([p1!, p2!, stray])[0]!.home).toEqual(inApollo);
    expect(threadsOf([p2!, stray])[0]).toMatchObject({ id: p1!.id, home: inApollo });
    expect(threadsOf([stray])[0]).toMatchObject({ id: p1!.id, home: GLOBAL });
  });

  it('lets a question build on a thread only where it lives and only on its turns asked there (R9)', () => {
    const [a1, a2] = threadIn(inApollo, ['What is left in Apollo?', 3 * DAY], ['and who owns it?', 2 * DAY]);
    const stray = turn('Asked at Home, kept in Apollo\'s thread', DAY, { thread: a1!.id });
    const [thread] = threadsOf([a1!, a2!, stray]);
    expect(homeTurns(thread, inApollo).map(each => each.id)).toEqual([a1!.id, a2!.id]);
    // Anywhere else, and with no thread, there is nothing to build on.
    for (const scope of [GLOBAL, inZephyr]) expect(homeTurns(thread, scope)).toEqual([]);
    expect(homeTurns(undefined, GLOBAL)).toEqual([]);
    // What is sent of the conversation is what was typed in its home: the stray turn's words never ride into Apollo's requests.
    expect(chainsOf([a1!, a2!, stray])[0]!.questions).toEqual(['What is left in Apollo?', 'and who owns it?']);
  });


  it('names a thread, and sends of it, only the person\'s own words: never a question a model wrote, nor the text of a turn not known to have followed nothing (R2)', () => {
    const first = turn('what is open?', 5 * DAY);
    // A follow-up: the person typed "who owns it?", and the answer answered a question the resolver wrote.
    const followUp = turn('Who owns THERM-482?', 4 * DAY, { text: 'who owns it?', typed: 'who owns it?', follows: first.id, thread: first.id });
    // A choice of "Which one?": what was asked was the model's, kept as its text; what the person typed is kept beside it.
    const choice = turn('What are the details on THERM-490?', 3 * DAY, { text: 'What are the details on THERM-490?', typed: 'what about that one?', follows: followUp.id, thread: first.id });
    // Ask again of the follow-up asks the model's question; it keeps the words typed for the turn it asked again.
    const again = turn('Who owns THERM-482?', 2 * DAY, { text: 'Who owns THERM-482?', typed: 'who owns it?', follows: followUp.id, again_of: followUp.id, thread: first.id });
    expect([first, followUp, choice, again].map(ownWords)).toEqual(['what is open?', 'who owns it?', 'what about that one?', 'who owns it?']);
    const [thread] = threadsOf([first, followUp, choice, again]);
    expect([thread!.name, thread!.own]).toEqual(['what is open?', 'what is open?']);
    // Each question the conversation shows once: the follow-up was asked again, and the newer stands for it.
    const [chain] = chainsOf([first, followUp, choice, again]);
    expect(chain!.questions).toEqual(['what is open?', 'what about that one?', 'who owns it?']);
    expect(JSON.stringify([thread!.name, chain!.own, chain!.label, chain!.questions])).not.toMatch(/THERM-4/u);
    // A thread whose first turn is a follow-up's answer is still named by what was typed.
    expect(threadsOf([{ ...followUp, thread: followUp.id }])[0]).toMatchObject({ name: 'who owns it?', own: 'who owns it?' });
    expect(chainsOf([{ ...followUp, thread: followUp.id }])[0]).toMatchObject({ label: 'who owns it?', questions: ['who owns it?'] });
    // Saved before the typed words and what a turn followed were kept, a turn's text may be a choice of "Which one?": such
    // a thread is named, on this device only, by its heading, and sends nothing.
    const { typed: _typed, follows: _follows, ...legacy } = turn('What are the details on THERM-490?', 5 * DAY);
    expect(ownWords(legacy)).toBeUndefined();
    expect(threadsOf([legacy])[0]).toMatchObject({ name: 'What are the details on THERM-490?' });
    expect(chainsOf([legacy])[0]).toMatchObject({ label: 'What are the details on THERM-490?', questions: [] });
    // Nothing of it is the person's own words, so nothing names it outside the door.
    expect([threadsOf([legacy])[0]!.own, chainsOf([legacy])[0]!.own]).toEqual([undefined, undefined]);
    expect(otherChains(chainsOf([legacy]), GLOBAL, null)).toEqual([]);
    // Behind the door, on this device only, it is listed by that heading (R2's one exception).
    expect(doorChains(chainsOf([legacy]), 'THERM-490').map(chain => chain.label)).toEqual(['What are the details on THERM-490?']);
    // Known to have followed nothing, and not an Ask again, its text is what was typed.
    expect(ownWords({ ...legacy, follows: null })).toBe('What are the details on THERM-490?');
    expect(ownWords({ ...legacy, follows: null, again_of: legacy.id })).toBeUndefined();
    expect(ownWords({ ...legacy, follows: legacy.id })).toBeUndefined();
    // Once a question is typed in that thread it has words to send: those, and still not the old text.
    const next = turn('and who owns it?', DAY, { follows: legacy.id, thread: legacy.id });
    expect(threadsOf([legacy, next])[0]).toMatchObject({ name: 'and who owns it?', own: 'and who owns it?' });
    expect(chainsOf([legacy, next])[0]).toMatchObject({ own: 'and who owns it?', label: 'and who owns it?', questions: ['and who owns it?'] });
  });
});

describe('what an Ask carries of the conversations (R3, R6, R7, R14)', () => {
  const timeline = () => {
    const home = threadIn(GLOBAL, ['When does the pilot start?', 6 * DAY], ['did that change?', 2 * DAY]);
    const billing = threadIn(GLOBAL, ['Who owns billing?', 5 * DAY]);
    const launch = threadIn(inApollo, ['What is left in Apollo?', 4 * DAY], ['and who owns it?', DAY]);
    const tests = threadIn(inApollo, ['Which tests fail?', 3 * DAY]);
    const other = threadIn(inZephyr, ['What is Zephyr waiting on?', HOUR]);
    return [...home, ...billing, ...launch, ...tests, ...other];
  };
  const names = (chains: readonly Chain[]) => chains.map(chain => chain.label);

  it('carries every other conversation in all context, only the project\'s own in a project, most recently asked first, and never the one continued', () => {
    const turns = timeline();
    const threads = chainsOf(turns);
    const by = named(turns);
    expect(names(otherChains(threads, GLOBAL, by['When does the pilot start?']!.id))).toEqual(['Who owns billing?']);
    // Asked from a page it continues none: every thread is a candidate.
    expect(names(otherChains(threads, GLOBAL, null))).toEqual(['When does the pilot start?', 'Who owns billing?']);
    // A project Ask: nothing from outside the project rides on it.
    expect(names(otherChains(threads, inApollo, null))).toEqual(['What is left in Apollo?', 'Which tests fail?']);
    expect(names(otherChains(threads, inApollo, by['What is left in Apollo?']!.id))).toEqual(['Which tests fail?']);
    expect(otherChains(threads, inZephyr, by['What is Zephyr waiting on?']!.id)).toEqual([]);
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
    // Continuing a turn that asked an older one again, or asked its question again where it was asked: that older turn
    // folds away behind it, as the thread shows it.
    const again = turn('what is open?', HOUR, { follows: first!.id, again_of: first!.id, thread: first!.id });
    const repeat = turn('what is open?', HOUR, { follows: third!.id, thread: first!.id });
    for (const latest of [again, repeat]) expect(earlierOf([...thread, latest], latest, null).map(each => each.question)).toEqual(['who owns it?', 'and when?']);
  });

  it('sends each conversation as its typed questions and when it was last asked in, and its label only when it has one that may go, then leaves out the least recently asked threads first, then the oldest older turns, when the body would pass its bound, with no count of its own (R7)', () => {
    const turns = timeline();
    const { threads, sent } = askCarries('and the budget?', GLOBAL, null, [], otherChains(chainsOf(turns), GLOBAL, null));
    expect(threads).toEqual([
      { questions: ['When does the pilot start?', 'did that change?'], asked_at: turns[1]!.asked_at },
      { questions: ['Who owns billing?'], asked_at: turns[2]!.asked_at },
    ]);
    expect(sent).toEqual([turns[0]!.id, turns[2]!.id]);
    // A question to be placed carries the list even when it is empty, so its answer can still say it starts a thread; one
    // that is not to be placed carries none at all.
    expect(askCarries('and the budget?', GLOBAL, null, [], [])).toEqual({ threads: [], sent: [] });
    expect(askCarries('and the budget?', GLOBAL, null, [], null)).toEqual({ sent: [] });
    const previous: AskPrevious = { purpose: 'follow_up', question: 'and when?', asked_at: NOW.toISOString(), statements: [], citations: [] };
    const older = (at: number, size: number): AskEarlierTurn => ({ question: `Older ${at}? ${'x'.repeat(size)}`, asked_at: NOW.toISOString(), statements: [], citations: [] });
    const other = (at: number, size: number): Chain => {
      const thread: Thread = { id: `thread-${at}`, turns: [], home: GLOBAL, name: `Thread ${at}?`, asked_at: new Date(NOW.getTime() - at * HOUR).toISOString() };
      return { ...thread, threads: [thread], newest: thread, label: thread.name, questions: [`Thread ${at}? ${'y'.repeat(size)}`] };
    };
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const body = (carries: ReturnType<typeof askCarries>) => bytes({ schema_version: 3, question: 'q?', ...(carries.previous ? { previous: carries.previous } : {}),
      ...(carries.threads ? { threads: carries.threads } : {}) });
    // Hundreds of threads and turns that fit all go: nothing counts them.
    const many = askCarries('q?', GLOBAL, previous, Array.from({ length: 300 }, (_, at) => older(at, 10)), Array.from({ length: 400 }, (_, at) => other(at, 10)));
    expect([many.previous!.earlier, many.threads, many.sent].map(list => list!.length)).toEqual([300, 400, 400]);
    // Ten threads of 200 KB and three older turns of 100 KB: threads go from the end until the rest fits; every turn stays.
    const fitting = [older(0, 100_000), older(1, 100_000), older(2, 100_000)];
    const cut = askCarries('q?', GLOBAL, previous, fitting, Array.from({ length: 10 }, (_, at) => other(at, 200_000)));
    expect(cut.sent).toEqual(['thread-0', 'thread-1', 'thread-2']);
    expect(cut.threads!.map(thread => thread.questions[0]!.slice(0, 9))).toEqual(['Thread 0?', 'Thread 1?', 'Thread 2?']);
    expect(cut.previous!.earlier).toEqual(fitting);
    expect(body(cut)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    // Older turns alone past the bound: every thread is gone before a turn is, and turns go from the oldest. The list still
    // goes, empty: the question is still one to be placed.
    const fewer = askCarries('q?', GLOBAL, previous, Array.from({ length: 5 }, (_, at) => older(at, 300_000)), [other(0, 10)]);
    expect([fewer.threads, fewer.sent]).toEqual([[], []]);
    expect(fewer.previous!.earlier!.map(each => each.question.slice(0, 8))).toEqual(['Older 2?', 'Older 3?', 'Older 4?']);
    expect(body(fewer)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    // Nothing older fits: the previous turn goes as it is, with no empty list of older turns in it.
    expect(askCarries('q?', GLOBAL, previous, [older(0, 2_000_000)], null)).toEqual({ previous, sent: [] });
    // With no previous turn there is nothing an older turn could ride on.
    expect(askCarries('q?', GLOBAL, null, fitting, [other(0, 10)])).toEqual({ threads: [{ questions: other(0, 10).questions, asked_at: other(0, 10).asked_at }], sent: ['thread-0'] });
    // A conversation with a label that may go sends it; one with none, or one that failed (no `sent`), sends nothing more.
    expect(askCarries('q?', GLOBAL, null, [], [{ ...other(0, 10), label: 'Thread 0', sent: 'Thread 0' }, { ...other(1, 10), label: 'Thread 1' }]).threads)
      .toEqual([{ questions: other(0, 10).questions, asked_at: other(0, 10).asked_at, label: 'Thread 0' }, { questions: other(1, 10).questions, asked_at: other(1, 10).asked_at }]);
  });

  it('lists every conversation behind the door, the one asked in most recently first, and finds by its label or any question typed in it', () => {
    const turns = timeline();
    const chains = chainsOf(turns);
    expect(names(doorChains(chains, ''))).toEqual(['What is Zephyr waiting on?', 'What is left in Apollo?', 'When does the pilot start?', 'Which tests fail?', 'Who owns billing?']);
    // Any question typed in it, in any case.
    expect(names(doorChains(chains, '  WHO OWNS '))).toEqual(['What is left in Apollo?', 'Who owns billing?']);
    expect(doorChains(chains, 'nothing like it')).toEqual([]);
    // Its label, matched as a typed question is.
    const labelled = turns.map(each => (each.text === 'and who owns it?' ? { ...each, label: 'Apollo: left, owns' } : each));
    expect(names(doorChains(chainsOf(labelled), 'apollo: left'))).toEqual(['Apollo: left, owns']);
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


  it('shows only the chat and the bar: nothing names or lists threads, and a person\'s first question carries an empty list and starts a thread Ask shows', async () => {
    const store = await startStore();
    const release = held.hold('ask.run');
    void store.ask('First ever?');
    await flush();
    expect(asked()[0]).toEqual(expect.objectContaining({ question: 'First ever?', threads: [] }));
    expect(asked()[0]).not.toHaveProperty('previous');
    const quiet = ['door', 'continues-note', 'moved-note', 'placed-undo'];
    for (const id of quiet) expect(byTestId(await page(store), id)).toEqual([]);
    release(answered(asked()[0]!));
    await flush();
    expect(store.threadShown()).toMatchObject({ name: 'First ever?' });
    expect(await questions(store)).toEqual(['First ever?']);
    for (const id of quiet) expect(byTestId(await page(store), id)).toEqual([]);
  });


  it('continues the thread a person is in: the previous turn, its older turns from one fresh check, each sentence only when its sources were found readable, and the other threads; the answer is saved in it (R6)', async () => {
    const { billing, pilot } = seeded();
    // THERM-482 is no longer the person's to read, in the pilot thread's first turn only.
    checks = items => ok({ items: items.map(item => ({ state: item.asked_at === pilot[0]!.asked_at && item.citation.ticket_id === '20482' ? 'unreadable' : 'same' })) });
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
      ['When does the pilot start?', pilot[0]!.asked_at, 1], ['did that change?', pilot[1]!.asked_at, 2]]);
    expect(previous.earlier![0]!.statements.map(statement => statement.text)).toEqual(['THERM-490 adds to "When does the pilot start?".']);
    expect(JSON.stringify(previous.earlier![0])).not.toContain('THERM-482');
    // The open thread is the previous turn's: it is not among the others.
    expect(sent.threads).toEqual([
      { questions: ['Who owns billing?', 'when is it due?'], asked_at: billing[1]!.asked_at }]);
    // One check, made for this question, covers the turn it continues and every older turn it carries.
    expect(calls('ask.check')).toHaveLength(checked + 1);
    expect(new Set((calls('ask.check').at(-1)!.items as { asked_at: string }[]).map(item => item.asked_at))).toEqual(new Set(pilot.map(each => each.asked_at)));
    expect(kept().at(-1)).toMatchObject({ text: 'and the budget?', thread: pilot[0]!.id, follows: pilot[2]!.id });
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
    expect(await questions(store)).toEqual(['who decided?', 'and the budget?']);
    // The check fails: every turn goes by its question alone.
    checks = () => fail('unavailable', { retryable: true });
    await store.ask('and the owner?');
    const failed = asked()[1]!.previous as AskPrevious;
    expect([failed.statements, ...failed.earlier!.map(each => each.statements)]).toEqual([[], [], [], []]);
    expect(failed.earlier!.map(each => each.question)).toEqual(['When does the pilot start?', 'did that change?', 'who decided?']);
  });

  it('keeps Ask again in its turn\'s thread, with no thread and no older turn riding; a follow-up of it carries the turn it asked again only as it', async () => {
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
    const again = kept().at(-1)!;
    expect(again).toMatchObject({ again_of: pilot[0]!.id, thread: pilot[0]!.id });
    expect(store.threadShown()?.id).toBe(pilot[0]!.id);
    // The turn asked again folds away behind it, as the thread shows it: its question rides once, as the turn continued.
    await store.ask('and who signs off?');
    await flush();
    expect(asked()[1]).toMatchObject({ previous: { purpose: 'follow_up', question: 'When does the pilot start?' } });
    expect((asked()[1]!.previous as AskPrevious).earlier!.map(each => each.question)).toEqual(['did that change?', 'who decided?']);
    expect(kept().at(-1)).toMatchObject({ follows: again.id, carried: [again.id, pilot[1]!.id, pilot[2]!.id] });
  });

  it('asks a choice of "Which one?" between things as before: the chosen full question, with the same earlier turn alone, in the open thread', async () => {
    const { pilot } = seeded();
    const choices = [{ label: 'THERM-482 · Sensor drift', question: 'Who owns THERM-482?' }, { label: 'THERM-490 · DVT retest', question: 'Who owns THERM-490?' }];
    script = params => (params.question === 'who owns that ticket?'
      ? ok({ scope: GLOBAL, sources: [], parts: [], outcome: 'clarify', receipt: { looked_through: 0 }, question: 'who owns that ticket?', choices }) : null);
    const store = await startStore();
    await store.openThread(pilot[0]!.id, pilot[2]!.id);
    await store.ask('who owns that ticket?');
    await flush();
    expect(store.getState().ask?.clarify).toMatchObject({ kind: 'choices', choices, how: { follows: pilot[2]!.id, question: 'who owns that ticket?' } });
    store.chooseClarified(choices[1]!);
    await flush();
    // The choice is what is asked, not the typed words again.
    expect(asked()[1]).toMatchObject({ question: 'Who owns THERM-490?', previous: { purpose: 'follow_up', question: 'who decided?' } });
    expect(asked()[1]).not.toHaveProperty('threads');
    expect(asked()[1]!.previous).not.toHaveProperty('earlier');
    expect(kept().at(-1)).toMatchObject({ text: 'who owns that ticket?', typed: 'who owns that ticket?', thread: pilot[0]!.id });
  });

});

describe('opening a thread: the sidebar\'s Ask, a suggestion, the door', () => {
  it('opens the thread asked in most recently from the sidebar, and a suggestion\'s thread at its turn, moving to its place', async () => {
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY], ['and who fixes them?', 3 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(...tests, ...pilot);
    const store = await startStore();
    expect(await store.returnToAsk()).toBe(true);
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

  describe('a jump that reads its project first', () => {
    /** Two threads in a project the sidebar has not loaded (the person's twelfth), and two with no project. */
    const seeded = () => {
      active = numbered(12);
      const later = active[11]!;
      const there = { kind: 'project', project_id: later.project_id } as const;
      const [far] = threadIn(there, ['What is left there?', 4 * DAY]);
      const [near] = threadIn(there, ['Who reviews it there?', 3 * DAY]);
      const [pilot] = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
      const [billing] = threadIn(GLOBAL, ['Who owns billing?', DAY]);
      seed(far!, near!, pilot!, billing!);
      return { later, far: far!, near: near!, pilot: pilot!, billing: billing! };
    };
    type Seeded = ReturnType<typeof seeded>;
    type Step = (store: Store, threads: Seeded) => unknown;
    const note = { ref: { kind: 'note', id: 'note-1' }, title: 'A note', added_at: NOW.toISOString(), visibility: 'only-me', projects: [] } as const;
    /** Where the person is: what a jump that opens nothing leaves as it was. */
    const where = (store: Store) => ({ route: store.getState().route, ask: store.getState().ask, reader: store.getState().reader });

    it.each<[string, Step, Step]>([
      // [what comes while the read is on its way, Ask before the jump, what comes]
      ['the thread Ask shows, picked from its own row', store => store.returnToAsk(), (store, { billing }) => store.openThread(billing.id)],
      ['another thread\'s row', store => store.returnToAsk(), (store, { pilot }) => store.openThread(pilot.id)],
      ['Ask closed', store => store.returnToAsk(), store => store.closeAsk()],
      ['another project\'s page, Ask closed', () => undefined, store => store.openProject(active[0]!)],
      ['Home opened again, Ask closed', () => undefined, store => store.goHome()],
      ['Tools, Ask closed', () => undefined, store => store.openTools()],
      ['a question asked and answered', () => undefined, store => store.ask('Something new?')],
      ['a note opened over a project\'s page', store => store.openProject(active[0]!), store => store.openListItem(note)],
      ['"New question" behind the door', store => store.returnToAsk(), store => store.newQuestion()],
      ['a zoom of Home, Ask closed', () => undefined, store => store.zoomTo('project', { project_id: active[0]!.project_id, name: active[0]!.name })],
      // Signed out and in as the same person, the file read again says the thread lives at Home now.
      ['the timeline read again, the thread living elsewhere', () => undefined, async (store, { far }) => {
        timelineFiles.set(fileOf(ACCOUNT), kept().map(each => (each.id === far.id ? { ...each, scope: GLOBAL } : each)));
        await readAgain(store);
      }],
    ])('drops a jump still reading its project when %s comes meanwhile: it opens nothing and moves no page', async (_name, before, meanwhile) => {
      const threads = seeded();
      const store = await startStore();
      await before(store, threads);
      await flush();
      const reading = held.hold('projects.read');
      const jump = store.openThread(threads.far.id);
      await meanwhile(store, threads);
      await flush();
      const was = where(store);
      reading(ok(threads.later));
      expect(await jump).toBe(false);
      await flush();
      expect(where(store)).toEqual(was);
    });

    it('goes on with nothing in the way, though a read of your projects lets go of one Home only remembered: it reads the project and moves there', async () => {
      const { later, far } = seeded();
      const store = await startStore();
      // Zoomed into the first project and out again: Home remembers it for its stop.
      store.zoomTo('project', { project_id: active[0]!.project_id });
      store.zoomOut();
      await flush();
      const reading = held.hold('projects.read');
      const jump = store.openThread(far.id);
      // That project leaves your list, and a read of it lets go of it: Home still shows My projects.
      active = active.slice(1);
      await store.loadProjects();
      await flush();
      expect(store.getState().altitude).toMatchObject({ level: 'projects', category: null, project_id: null });
      reading(ok(later));
      expect(await jump).toBe(true);
      expect(calls('projects.read')).toEqual([expect.objectContaining({ project_id: later.project_id })]);
      expect(store.threadShown()?.id).toBe(far.id);
      expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: later.project_id } });
      // A thread that is gone opens nothing.
      expect(await store.openThread('00000000-0000-4000-8000-00000000ffff')).toBe(false);
    });
  });
});

describe('a question a model wrote goes only while every turn that could have informed it is readable (R10)', () => {
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
  /**
   * The pilot's thread, continuing the other (R13): one conversation (R14). A follow-up answered there, whose full
   * question the resolver wrote with the name.
   */
  const chained = async () => {
    const other = orion();
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]).map(each => ({ ...each, continues: [other.id] }));
    seed(other, ...pilot);
    const store = await startStore();
    await store.openThread(pilot[0]!.id);
    await flush();
    const rewrite = `Who signs off the pilot that ${NAME} leads?`;
    script = params => (params.question === 'and who signs it off?' ? answered(params, { question: rewrite }) : null);
    await store.ask('and who signs it off?');
    await flush();
    // It followed the pilot's own turn: the other's is not one it followed, only one asked before it in its conversation.
    const followUp = kept().at(-1)!;
    expect(followUp).toMatchObject({ typed: 'and who signs it off?', question: rewrite, follows: pilot[0]!.id, thread: pilot[0]!.id });
    expect((asked()[0]!.previous as AskPrevious).earlier!.map(each => each.question)).toEqual(['Who leads the other team?']);
    return { store, other, pilot, followUp, rewrite };
  };

  it('sends the earlier question a model wrote only while the older part\'s turn it may have drawn on is still readable; once it is not, the typed words go and nothing of that turn', async () => {
    const { store, followUp, rewrite } = await chained();
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
    const { store, followUp } = await chained();
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
    expect(store.getState().ask?.clarify).toMatchObject({ kind: 'choices', how: { question: 'what is left for them?' } });
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

  it('follows what a question was written from all the way back: a turn carried by a turn its request carried counts, though that request never carried it', async () => {
    const teams = turn('Which teams are there?', 7 * DAY);
    const other = orion();
    // It followed a turn that still reads, and carried the other thread's turn only as an older turn; the pilot's
    // follow-up carried this one, and neither of those.
    const between = turn('What does that team own?', 5 * DAY, { follows: teams.id, thread: teams.id, carried: [teams.id, other.id] });
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
    const rewrite = `Who signs off the pilot that ${NAME} leads?`;
    const followUp = turn(rewrite, 2 * DAY, { text: 'and who signs it off?', typed: 'and who signs it off?', follows: pilot[0]!.id, thread: pilot[0]!.id,
      answer: answerOf('and who signs it off?'), carried: [pilot[0]!.id, between.id] });
    seed(teams, other, between, ...pilot, followUp);
    const store = await startStore();
    orionGone();
    store.askAgain(followUp.id);
    await flush();
    expect(asked()[0]).toMatchObject({ question: 'and who signs it off?', previous: { purpose: 'ask_again', question: 'and who signs it off?' } });
    expect(JSON.stringify(asked()[0])).not.toContain(NAME);
    // Readable again all the way back, its full question goes.
    checks = items => ok({ items: items.map(() => ({ state: 'same' })) });
    store.askAgain(followUp.id);
    await flush();
    expect(asked()[1]).toMatchObject({ question: rewrite, previous: { purpose: 'ask_again', question: rewrite } });
  });

  it.each<[string, (rewritten: TimelineTurn, first: TimelineTurn) => TimelineTurn[], number | null]>([
    // [the record, the timeline holding the turn `rewritten`, how many turns one check asks about when its full question goes (null: it does not)]
    ['names itself as the turn it followed', rewritten => [{ ...rewritten, follows: rewritten.id, carried: [] }], null],
    ['names itself among the turns it carried', (rewritten, first) => [first, { ...rewritten, carried: [first.id, rewritten.id] }], null],
    ['follows a turn that follows it back', (rewritten, first) => [{ ...first, follows: rewritten.id }, { ...rewritten, carried: [] }], null],
    // A file can keep a turn before the one it followed (a save that failed and was made later): that is no loop.
    ['is kept before the turn it followed', (rewritten, first) => [rewritten, first], 2],
    ['shares a turn with another it carried, each reached once', (rewritten, first) => {
      const [left, right] = ['and the budget?', 'and the owner?'].map((question, at) => turn(question, (5 - at) * DAY, { follows: first.id, thread: first.id, carried: [first.id] }));
      return [first, left!, right!, { ...rewritten, follows: left!.id, carried: [left!.id, right!.id] }];
    }, 4],
  ])('takes a history that comes back on itself as no history, and one that only meets again as whole: a turn that %s', async (_how, timeline, checked) => {
    const first = turn('When does the pilot start?', 6 * DAY);
    const rewrite = 'Who signs off the pilot for the launch?';
    const rewritten = turn(rewrite, 2 * DAY, { text: 'and who signs it off?', typed: 'and who signs it off?', follows: first.id, thread: first.id,
      answer: answerOf('and who signs it off?'), carried: [first.id] });
    seed(...timeline(rewritten, first));
    const store = await startStore();
    store.askAgain(rewritten.id);
    await flush();
    const sent = checked === null ? 'and who signs it off?' : rewrite;
    expect(asked()[0]).toMatchObject({ question: sent, previous: { purpose: 'ask_again', question: sent } });
    // Whole, the check made before asking asks about each turn it was written from once, two sources a turn; otherwise only about its own.
    expect(calls('ask.check')[0]!.items).toHaveLength((checked ?? 1) * 2);
  });

  it('sends no question a model wrote once a turn its request carried is no longer kept, though every turn there reads', async () => {
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
    const rewrite = 'Who signs off the pilot for the launch?';
    const said2 = (missing: boolean) => turn(rewrite, 2 * DAY, {
      text: 'and who signs it off?', typed: 'and who signs it off?', follows: pilot[0]!.id, thread: pilot[0]!.id, answer: answerOf('and who signs it off?'),
      carried: missing ? [pilot[0]!.id, '00000000-0000-4000-8000-00000000ffff'] : [pilot[0]!.id] });
    const [gone, here] = [said2(true), said2(false)];
    seed(...pilot, gone, here);
    const store = await startStore();
    store.askAgain(gone.id);
    await flush();
    expect(asked()[0]).toMatchObject({ question: 'and who signs it off?', previous: { purpose: 'ask_again', question: 'and who signs it off?' } });
    // All it carried still kept and readable, its full question goes.
    store.askAgain(here.id);
    await flush();
    expect(asked()[1]).toMatchObject({ question: rewrite, previous: { purpose: 'ask_again', question: rewrite } });
  });

  it('takes the turns a turn saved before threads followed as all it carried, whatever else its thread holds, and keeps it so when it is saved again', async () => {
    const other = orion();
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
    const rewrite = 'When does the pilot start after the slip?';
    // Saved before threads (no thread, no record of what it carried): it followed the pilot's first turn, and no more
    // rode then.
    const { thread: _thread, carried: _carried, ...legacy } = turn(rewrite, 2 * DAY, { text: 'and now?', typed: 'and now?', follows: pilot[0]!.id, answer: answerOf('and now?') });
    // The other turn sits in the same thread, before it, and is no longer readable: never a turn the legacy one carried.
    seed({ ...other, thread: pilot[0]!.id }, ...pilot, legacy);
    orionGone();
    // Its second source was found unreadable once, and now reads again: saved again, it is named with its thread for the first time.
    timelineFiles.set(fileOf(ACCOUNT), kept().map(each => (each.id === legacy.id ? { ...each, unreadable: [1] } : each)));
    const store = await startStore();
    store.askAgain(legacy.id);
    await flush();
    expect(asked()[0]).toMatchObject({ question: rewrite, previous: { purpose: 'ask_again', question: rewrite } });
    // Named now, it is marked as carrying no more than its chain, in the file and on the page: its question still goes.
    expect(kept().find(each => each.id === legacy.id)).toMatchObject({ thread: pilot[0]!.id, carried: [] });
    expect(kept().find(each => each.id === legacy.id)).not.toHaveProperty('unreadable');
    store.askAgain(legacy.id);
    await flush();
    expect(asked()[1]).toMatchObject({ question: rewrite });
  });

  it('sends no question a model wrote along a turn that names its thread but recorded nothing of what it carried: a build before that record saved it', async () => {
    const other = orion();
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
    const rewrite = `Who signs off the pilot that ${NAME} leads?`;
    // Saved by a build of threads that kept no record: it may well have carried the other turn, now in its thread.
    const { carried: _carried, ...unknown } = turn(rewrite, 2 * DAY, { text: 'and who signs it off?', typed: 'and who signs it off?', follows: pilot[0]!.id,
      thread: pilot[0]!.id, answer: answerOf('and who signs it off?') });
    seed({ ...other, thread: pilot[0]!.id }, ...pilot, unknown);
    const store = await startStore();
    // Every source reads: the typed words go all the same, for Ask again, for a follow-up of it, and for a choice offered there.
    store.askAgain(unknown.id);
    await flush();
    expect(asked()[0]).toMatchObject({ question: 'and who signs it off?', previous: { purpose: 'ask_again', question: 'and who signs it off?' } });
    const choices = [{ label: NAME, question: `What does ${NAME} still have to approve?` }, { label: 'The sponsor', question: 'What does the sponsor still have to approve?' }];
    script = params => (params.question === 'and what is left?' ? ok({ scope: GLOBAL, sources: [], parts: [], outcome: 'clarify', receipt: { looked_through: 0 },
      question: 'and what is left?', choices }) : null);
    store.toggleTurn(unknown.id);
    await store.ask('and what is left?');
    await flush();
    expect(asked()[1]).toMatchObject({ previous: { purpose: 'follow_up', question: 'and who signs it off?' } });
    store.chooseClarified(choices[0]!);
    await flush();
    expect(asked()[2]).toMatchObject({ question: 'and what is left?', previous: { question: 'and who signs it off?' } });
    // No question a model wrote along it went, its own rewrite and the choice that names the other team's lead alike.
    expect(asked().flatMap(each => [each.question, (each.previous as AskPrevious | undefined)?.question]).join()).not.toContain(NAME);
  });

  it('checks a long thread in one check of every turn the question could have drawn on, the earliest included', async () => {
    const asked300 = threadIn(GLOBAL, ...Array.from({ length: 300 }, (_, at) => [`question ${at}?`, (300 - at) * HOUR] as const));
    // The last turn's full question is the resolver's.
    const last = { ...asked300.at(-1)!, question: 'Resolved: question 299, about THERM-482?' };
    seed(...asked300.slice(0, -1), last);
    // Only the first turn's ticket is no longer readable.
    checks = items => ok({ items: items.map(item => ({ state: item.asked_at === asked300[0]!.asked_at && item.citation.ticket_id === '20482' ? 'unreadable' : 'same' })) });
    const store = await opened(asked300[0]!.id);
    store.askAgain(last.id);
    await flush();
    expect(asked()[0]).toMatchObject({ question: 'question 299?', previous: { purpose: 'ask_again', question: 'question 299?' } });
    expect(JSON.stringify(asked()[0])).not.toContain('Resolved');
    // Every turn once: both sources of each of the 300.
    expect(calls('ask.check').at(-1)!.items).toHaveLength(600);
  });

  it('counts the turns before a turn it followed in another thread: an answer that started a thread was still written with the thread it was asked in', async () => {
    const other = orion();
    const pilot = turn('When does the pilot start?', 3 * DAY);
    // The other thread's turn is kept in the pilot's thread, as a file may hold it: before the pilot's own turn, and not a turn that one followed.
    seed({ ...other, thread: pilot.id }, pilot);
    const rewrite = `What does ${NAME} want for lunch?`;
    script = params => (params.question === 'and for lunch?' ? answered(params, { question: rewrite, thread: { kind: 'new' } }) : null);
    const store = await opened(pilot.id);
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

  it('builds nothing on a turn a file keeps in a thread of another home: a follow-up continues the thread\'s own latest, and Ask again of that turn starts a thread where it was asked', async () => {
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY], ['and who fixes them?', 3 * DAY]);
    // Asked with no project, and kept in Apollo's thread: no desktop saves one so, and a file may still hold it.
    const stray = turn('What did the board decide?', DAY, { thread: tests[0]!.id, follows: tests[1]!.id });
    seed(...tests, stray);
    const store = await opened(tests[0]!.id);
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
  const other = { ...ACCOUNT, membership_id: 'another-member' };
  it.each([
    ['Ask is closed', 'answer', (store: Store) => store.closeAsk()],
    ['Ask is closed, the question belonging elsewhere', 'elsewhere', (store: Store) => store.closeAsk()],
    ['a project\'s page opens', 'answer', (store: Store) => { void store.openProject(apollo); }],
    ['Home opens', 'answer', (store: Store) => store.goHome()],
    // The session ended: Ask stays behind the sign-in page for the same person, but the answer is nobody's to keep.
    ['the person signs out', 'answer', async (store: Store) => { app = { signed_in: false, account: null, client_version: 'test' }; await store.refreshStatus(); }],
    // Nothing of the last account's Ask stays, and its late answer lands nowhere.
    ['another account signs in, the question belonging elsewhere', 'elsewhere', async (store: Store) => { app = { ...app, account: other }; await store.refreshStatus(); }],
  ] as const)('keeps nothing of an answer once %s meanwhile: no turn, no jump, no question asked again, nothing left on its way', async (name, reply, leave) => {
    seeded();
    const store = await startStore();
    store.returnToAsk();
    await flush();
    const release = held.hold('ask.run');
    void store.ask('and the budget?');
    await flush();
    const [sent, puts] = [asked().length, calls('timeline.put').length];
    await leave(store);
    await flush();
    release(reply === 'answer' ? answered(asked().at(-1)!) : elsewhere(asked().at(-1)!, [0]));
    await flush();
    expect([asked().length, calls('timeline.put').length, kept().length]).toEqual([sent, puts, 6]);
    expect(store.getState().ask?.asking ?? null).toBeNull();
    if (name !== 'the person signs out') expect(store.getState().ask).toBeNull();
    if (name.startsWith('another account')) expect([store.getState().timeline.turns, timelineFiles.get(fileOf(other)) ?? []]).toEqual([[], []]);
  });

  it('stops a question on its way, or still being prepared, when the timeline is forgotten: read again for the same person, nothing is asked from turns that were let go, and a late answer lands nowhere', async () => {
    const { pilot } = seeded();
    const store = await opened(pilot[0]!.id);
    // Being prepared: the check of what it carries is still out.
    const check = held.hold('ask.check');
    void store.ask('and by how long?');
    await flush();
    expect(store.getState().ask?.asking).toMatchObject({ question: 'and by how long?' });
    await readAgain(store);
    expect(store.getState().ask?.asking).toBeNull();
    check(ok({ items: [] }));
    await flush();
    expect(asked()).toEqual([]);
    // On its way: its answer comes back after the timeline was read again.
    const cancelled = calls('ask.cancel').length;
    const land = held.hold('ask.run');
    void store.ask('and by how long?');
    await flush();
    expect(asked()).toHaveLength(1);
    await readAgain(store);
    expect([store.getState().ask?.asking, calls('ask.cancel').length]).toEqual([null, cancelled + 1]);
    land(answered(asked()[0]!));
    await flush();
    expect(kept().filter(row => row.answer)).toHaveLength(5);
    expect(kept().filter(row => !row.answer)).toHaveLength(2);
    expect(store.getState().timeline.turns).toHaveLength(5);
  });

  it('drops a pick still reading its project, and an Ask again still checking with Ask closed, when the timeline is forgotten: nothing is asked and the page stays', async () => {
    const { tests, pilot } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Which tests fail?'), placeOf(params, 'Who owns billing?')]) : null);
    const store = await startStore();
    await store.ask('are they fixed?');
    await flush();
    const reading = held.hold('projects.read');
    const pick = store.chooseThread(tests[0]!.id);
    await readAgain(store);
    reading(ok(apollo));
    await pick;
    await flush();
    expect([asked().length, store.getState().route.page]).toEqual([1, 'home']);
    store.closeAsk();
    const check = held.hold('ask.check');
    store.askAgain(pilot[1]!.id);
    await flush();
    await readAgain(store);
    check(ok({ items: [{ state: 'same' }, { state: 'same' }] }));
    await flush();
    expect([asked().length, store.getState().ask]).toEqual([1, null]);
  });
  it('asks without the threads when nothing of the turn a follow-up continues may go, so it stays in the thread it was typed in', async () => {
    // A turn saved before the person's typed words were kept, one of whose sources is gone: no earlier turn may go.
    const { typed: _typed, follows: _follows, thread: _thread, ...legacy } = turn('What changed on THERM-555?', 2 * DAY);
    const other = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY]);
    seed(...other, legacy);
    checks = items => ok({ items: items.map(() => ({ state: 'unreadable' })) });
    const store = await opened(legacy.id);
    await store.ask('who owns it?');
    await flush();
    for (const key of ['previous', 'threads']) expect(asked()[0]).not.toHaveProperty(key);
    expect(kept().at(-1)).toMatchObject({ text: 'who owns it?', thread: legacy.id });
    // Saved again for what the check found, the old turn is named with the thread it belonged to all along.
    expect(kept().find(each => each.id === legacy.id)).toMatchObject({ thread: legacy.id, unreadable: [0, 1] });
  });

  it('starts the first enabled question with the loaded context and forgets its failed follow-up with that account', async () => {
    const { pilot } = seeded();
    const reading = held.hold('timeline.read');
    const store = await startStore();
    expect(store.getState().timeline.loading).toBe(true);
    await store.ask('Before this account is ready');
    expect(asked()).toHaveLength(0);
    expect(calls('timeline.put')).toHaveLength(0);
    reading(ok({ turns: kept() }));
    await flush();
    expect(store.getState().timeline.loading).toBe(false);
    await store.ask('What is new this week?');
    expect(asked()).toHaveLength(1);
    expect(kept().at(-1)).toMatchObject({ follows: pilot.at(-1)!.id, thread: pilot[0]!.id });
    const failing = held.hold('ask.run');
    void store.ask('and since when?');
    await flush();
    failing(fail('unavailable', { retryable: true }));
    await flush();
    expect(store.getState().timeline.turns).toHaveLength(6);
    expect(store.getState().ask?.failed).toMatchObject({ question: 'and since when?', thread: pilot[0]!.id });
    await readAgain(store);
    expect(store.getState().ask?.failed).toBeNull();
  });

  it('keeps Ask closed until the current account’s own read returns after a switch', async () => {
    seeded();
    const firstRead = held.hold('timeline.read');
    const store = await startStore();
    const secondRead = held.hold('timeline.read');
    app = { ...app, account: other };
    await store.refreshStatus();
    firstRead(ok({ turns: kept() }));
    await flush();
    expect(store.getState().timeline).toMatchObject({ loading: true, entries: [] });
    await store.ask('Before the new account is ready');
    expect(asked()).toHaveLength(0);
    secondRead(ok({ turns: [] }));
    await flush();
    expect(store.getState().timeline.loading).toBe(false);
    await store.ask('A new question');
    expect(asked()).toHaveLength(1);
    expect(asked()[0]).not.toHaveProperty('previous');
    expect(timelineFiles.get(fileOf(other))).toHaveLength(1);
  });
});


describe('conversations: a thread and every thread it continues (ADR-0057, R2, R11, R14)', () => {
  it('keeps a thread active for 7 days after its newest turn: a millisecond short of them it is, at exactly 7 days it is joined (R11)', () => {
    const [thread] = threadsOf(threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY], ['did that change?', DAY]));
    const newest = Date.parse(thread!.asked_at);
    expect(threadActive(thread!, newest + THREAD_ACTIVE_MS - 1)).toBe(true);
    expect(threadActive(thread!, newest + THREAD_ACTIVE_MS)).toBe(false);
    // Each new turn starts the 7 days again: the newest turn counts, not the first.
    expect(threadActive(thread!, Date.parse(thread!.turns[0]!.asked_at) + THREAD_ACTIVE_MS)).toBe(true);
  });

  it('joins threads through `continues` into one conversation: its turns oldest first, its typed questions each once, its newest thread the one a question goes on from; a name in another home, its own or one not kept joins nothing', () => {
    const start = threadIn(GLOBAL, ['When does the pilot start?', 10 * DAY], ['who owns it?', 10 * DAY - HOUR]);
    const delay = threadIn(GLOBAL, ['Is the pilot delayed?', 8 * DAY]);
    const tests = threadIn(inApollo, ['Which tests fail?', 2 * DAY]);
    const billing = threadIn(GLOBAL, ['Who owns billing?', 3 * DAY]).map(each => ({ ...each, continues: [tests[0]!.id, each.id, '00000000-0000-4000-8000-00000000ffff'] }));
    const moved = threadIn(GLOBAL, ['did the pilot date move?', DAY]).map(each => ({ ...each, continues: [start[0]!.id, delay[0]!.id] }));
    const chains = chainsOf([...start, ...delay, ...billing, ...tests, ...moved]);
    expect(chains.map(chain => [chain.id, chain.threads.map(thread => thread.id)])).toEqual([
      [moved[0]!.id, [start[0]!.id, delay[0]!.id, moved[0]!.id]], [billing[0]!.id, [billing[0]!.id]], [tests[0]!.id, [tests[0]!.id]]]);
    const [pilot] = chains;
    expect(pilot).toMatchObject({ newest: { id: moved[0]!.id }, label: 'did the pilot date move?', asked_at: moved[0]!.asked_at,
      questions: ['When does the pilot start?', 'who owns it?', 'Is the pilot delayed?', 'did the pilot date move?'] });
    expect(pilot!.turns.map(each => each.id)).toEqual([...start, ...delay, ...moved].map(each => each.id));
    // The "Continues" line opens the thread its own first turn names first (R13): the joined thread it continues, never
    // one a later turn linked (R16), one in another home, or one not kept.
    const all = pilot!.threads;
    expect(continuedThread(pilot!.newest, all)?.id).toBe(start[0]!.id);
    expect(continuedThread(all[0]!, all)).toBeUndefined();
    const linkedLater = threadIn(GLOBAL, ['Who audits it?', 2 * DAY], ['and how often?', DAY]).map((each, at) => (at === 1 ? { ...each, continues: [start[0]!.id] } : each));
    expect(continuedThread(threadsOf(linkedLater)[0]!, [...all, ...threadsOf(linkedLater)])).toBeUndefined();
    expect(continuedThread(threadsOf(billing)[0]!, [...threadsOf(billing), ...threadsOf(tests)])).toBeUndefined();
  });

  it('labels a conversation only by the person\'s own words: the newest label on its turns every word of which they typed there, else its newest thread\'s name; one that fails is passed over, never repaired (R2)', () => {
    const typed = ['When does the pilot start?', 'who owns it?'];
    expect(labelOf([{ label: 'pilot: start, owns' }], typed)).toBe('pilot: start, owns');
    expect(labelOf([{ label: 'Pilot: START' }], typed)).toBe('Pilot: START');
    // Words as typed ("owns" does not allow "owner"), one line of at most 80 characters.
    for (const label of ['pilot: owner', 'pilot: budget', ' pilot', 'pilot\nstart', 'pilot '.repeat(20).trim()]) expect(labelOf([{ label }], typed)).toBeUndefined();
    expect(labelOf([{ label: 'pilot: start' }, { label: 'pilot: owns' }, { label: 'pilot: budget' }, {}], typed)).toBe('pilot: owns');
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY], ['who owns it?', DAY]);
    const labelled = (label: string) => chainsOf([pilot[0]!, { ...pilot[1]!, label }])[0]!;
    expect(labelled('pilot: start, owns')).toMatchObject({ label: 'pilot: start, owns', sent: 'pilot: start, owns' });
    expect(labelled('pilot: budget')).toMatchObject({ label: 'When does the pilot start?' });
    expect(labelled('pilot: budget')).not.toHaveProperty('sent');
    // Words typed in any part of the conversation count, and the name it falls back to is its newest thread's.
    const later = threadIn(GLOBAL, ['and the budget?', HOUR]).map(each => ({ ...each, continues: [pilot[0]!.id] }));
    expect(chainsOf([...pilot, { ...later[0]!, label: 'pilot: start, budget' }])[0]).toMatchObject({ label: 'pilot: start, budget', sent: 'pilot: start, budget' });
    expect(chainsOf([...pilot, ...later])[0]).toMatchObject({ label: 'and the budget?' });
  });
});

describe('labels on the desktop (R2)', () => {
  it('keeps a label that came back on its turn only when every word of it was typed in that conversation, and sends the conversation\'s label with the next follow-up', async () => {
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(...pilot);
    let label = 'pilot: start, owner';
    script = params => (params.previous ? answered(params, { label }) : null);
    const store = await opened(pilot[0]!.id);
    await store.ask('who owns it?');
    await flush();
    expect(kept().at(-1)).not.toHaveProperty('label');
    label = 'pilot: start, owns';
    await store.ask('who owns it now?');
    await flush();
    expect(kept().at(-1)).toMatchObject({ label: 'pilot: start, owns' });
    expect(store.chains()[0]).toMatchObject({ label: 'pilot: start, owns' });
    await store.ask('and when?');
    expect(asked().at(-1)!.previous).toMatchObject({ purpose: 'follow_up', label: 'pilot: start, owns' });
  });

});

describe('ECHO joins conversations by linking, never by moving (R16)', () => {
  const seeded = () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 5 * DAY], ['when is it due?', 4 * DAY]);
    const ledger = threadIn(GLOBAL, ['Where is the ledger?', 3 * DAY]);
    const tests = threadIn(inApollo, ['Which tests fail?', 3 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY], ['did that change?', DAY]);
    seed(...billing, ...ledger, ...tests, ...pilot);
    return { billing, ledger, tests, pilot };
  };
  const apart = (store: Store) => store.chains().map(chain => chain.threads.map(thread => thread.id));

  it('names, in the same save as the turn, the newest thread of each conversation an ordinary answer merges, in the home it was asked in; no other turn changes, and nothing shows', async () => {
    const { billing, ledger, tests, pilot } = seeded();
    script = params => (params.threads ? answered(params, { merge: ['Who owns billing?', 'Which tests fail?'].map(name => placeOf(params, name)) }) : null);
    const store = await opened(pilot[0]!.id);
    const before = structuredClone(kept());
    const puts = calls('timeline.put').length;
    await store.ask('who approves the invoices?');
    await flush();
    const landed = kept().at(-1)!;
    expect(landed).toMatchObject({ thread: pilot[0]!.id, continues: [billing[0]!.id] });
    expect(calls('timeline.put').slice(puts).map(put => (put.turn as TimelineTurn).id)).toEqual([landed.id, landed.id]);
    expect(kept().slice(0, -1)).toEqual(before);
    expect(apart(store)).toEqual([[billing[0]!.id, pilot[0]!.id], [ledger[0]!.id], [tests[0]!.id]]);
    // Billing's was last asked in before the pilot's thread started: a link still adds no line, and offers no Undo.
    expect(byTestId(await page(store), 'continues-note')).toHaveLength(0);
  });

});

describe('the door: the title opens every conversation (ADR-0057)', () => {
  const seeded = () => {
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY]);
    const billing = threadIn(GLOBAL, ['Who owns billing?', 3 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY], ['who owns it?', DAY]).map((each, at) => (at === 1 ? { ...each, label: 'pilot: start, owns' } : each));
    seed(...tests, ...billing, ...pilot);
    return { tests, billing, pilot };
  };
  const title = async (store: Store) => byTestId(render((await screens()).AskTitle({ state: store.getState() })), 'ask-title')[0]!;
  const door = async (store: Store) => render((await screens()).Door({ state: store.getState() }));
  /** The up arrow in the bar's field. */
  const up = async (store: Store) => {
    const field = byTestId(render((await screens()).Bar({ state: store.getState() })), 'ask-field')[0]!;
    (field.props.onKeyDown as (event: unknown) => void)({ key: 'ArrowUp', preventDefault: vi.fn(), stopPropagation: vi.fn() });
  };

  it('shows nothing of itself until opened: from the title "Ask", or from the up arrow in the empty bar while Ask is open', async () => {
    seeded();
    const store = await startStore();
    store.returnToAsk();
    await flush();
    expect(store.getState().ask?.door).toBe(false);
    expect(byTestId(await page(store), 'door')).toEqual([]);
    expect([text(await title(store)), (await title(store)).props['aria-expanded']]).toEqual(['Ask', false]);
    click(await title(store));
    expect([store.getState().ask?.door, (await title(store)).props['aria-expanded']]).toEqual([true, true]);
    click(await title(store));
    expect(store.getState().ask?.door).toBe(false);
    store.setBarText('who');
    await up(store);
    expect(store.getState().ask?.door).toBe(false);
    store.setBarText('');
    await up(store);
    expect(store.getState().ask?.door).toBe(true);
    store.closeAsk();
    await up(store);
    expect(store.getState().ask).toBeNull();
  });

  it('closes when Capture comes up over it, and does not open under it, so its Return never picks a conversation behind a sheet', async () => {
    seeded();
    const store = await startStore();
    store.returnToAsk();
    await flush();
    store.openDoor();
    expect(store.getState().ask?.door).toBe(true);
    store.openCapture();
    expect(store.getState().ask?.door).toBe(false);
    store.openDoor();
    expect(store.getState().ask?.door).toBe(false);
    store.closeCompose();
    store.openDoor();
    expect(store.getState().ask?.door).toBe(true);
  });

  it('lists "New question" first, then one row per conversation, newest first, by its label, with a project\'s name only for one living in another project; Find matches a label or any typed question', async () => {
    seeded();
    const store = await startStore();
    store.returnToAsk();
    await flush();
    store.openDoor();
    const tree = await door(store);
    expect(byTestId(tree, 'door-find')).toHaveLength(1);
    expect(elements(tree).filter(node => ['door-new', 'door-row'].includes(String(node.props['data-testid']))).map(node => node.props['data-testid']))
      .toEqual(['door-new', 'door-row', 'door-row', 'door-row']);
    expect(text(byTestId(tree, 'door-new')[0])).toBe('New question');
    expect(store.doorRows(store.getState(), '').map(row => [row.label, row.project, row.current])).toEqual([
      ['pilot: start, owns', null, true], ['Who owns billing?', null, false], ['Which tests fail?', 'Apollo', false]]);
    expect(byTestId(tree, 'door-row').map(row => text(byTestId(row, 'door-project')))).toEqual(['', '', 'Apollo']);
    expect(store.doorRows(store.getState(), 'START, OWNS').map(row => row.label)).toEqual(['pilot: start, owns']);
    expect(store.doorRows(store.getState(), 'who owns').map(row => row.label)).toEqual(['pilot: start, owns', 'Who owns billing?']);
  });

  it('jumps to the conversation a row picks, to its project when it lives in one, and closes', async () => {
    const { tests } = seeded();
    const store = await startStore();
    store.returnToAsk();
    await flush();
    store.openDoor();
    click(byTestId(await door(store), 'door-row')[2]);
    await flush();
    expect(store.threadShown()?.id).toBe(tests[0]!.id);
    expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: apollo.project_id } });
    expect(store.getState().ask).toMatchObject({ door: false, thread: { id: tests[0]!.id, entered: true } });
  });

  it('"New question" keeps the transcript and starts the next question without an earlier topic', async () => {
    const { pilot } = seeded();
    const store = await opened(pilot[0]!.id);
    store.openDoor();
    click(byTestId(await door(store), 'door-new')[0]);
    expect(store.getState().ask).toMatchObject({ fresh: true, door: false, thread: null });
    expect(await questions(store)).toEqual(['who owns it?']);
    expect(byTestId(await page(store), 'door')).toHaveLength(0);
    await store.ask('who owns it?');
    await flush();
    for (const key of ['previous', 'threads']) expect(asked().at(-1)).not.toHaveProperty(key);
    const saved = kept().at(-1)!;
    expect(saved).toMatchObject({ thread: saved.id, follows: null });
    expect(store.getState().ask?.fresh).toBe(false);
    // The chat it started goes on as any.
    await store.ask('and since when?');
    expect(asked().at(-1)).toMatchObject({ previous: { question: 'who owns it?' } });
    store.newQuestion();
    await store.openThread(pilot[0]!.id);
    expect(store.getState().ask?.fresh).toBe(false);
    store.newQuestion();
    store.closeAsk();
    store.returnToAsk();
    await flush();
    expect(store.getState().ask?.fresh).toBe(false);
  });
});

describe('one Ask transcript per scope', () => {
  it('preserves the restored prompt and composer draft until the returning account’s history arrives', async () => {
    const store = await startStore();
    script = params => ok({ scope: GLOBAL, outcome: 'clarify', parts: [], sources: [], receipt: { looked_through: 0 },
      question: params.question, choices: [{ label: 'June launch', question: 'Did the June launch ship?' }] });
    await store.ask('Did it ship?');
    const original = kept().at(-1)!;
    app = { signed_in: false, account: null, client_version: 'test' };
    await store.refreshStatus();
    store.setBarText('The June launch.');
    const read = held.hold('timeline.read');
    app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
    await store.refreshStatus();
    store.submitBar();
    store.setBarText('Late input');
    store.pickSuggestion({ question: 'Late suggestion' });
    expect(store.getState().barText).toBe('The June launch.');
    expect(asked()).toHaveLength(1);
    read(ok({ turns: [original] }));
    await flush();
    script = null;
    store.submitBar();
    await flush();
    expect(asked()[1]?.question).toBe('Did it ship?\nThe June launch.');
    expect(kept()).toEqual([expect.objectContaining({ id: original.id, clarification: 'The June launch.' })]);
  });

  it('starts a new Home suggestion after leaving a clarification', async () => {
    const april = turn('April launch?', DAY);
    seed(april);
    const store = await startStore();
    script = params => ok({ scope: GLOBAL, outcome: 'clarify', parts: [], sources: [], receipt: { looked_through: 0 },
      question: params.question, choices: [{ label: 'April', question: 'Did April ship?' }] });
    await store.ask('Did it ship?');
    const pending = kept().at(-1)!;
    store.closeAsk();
    script = null;
    store.pickSuggestion({ question: 'Who is on call?' });
    await flush();
    expect(asked()[1]?.question).toBe('Who is on call?');
    expect(kept().at(-2)).toMatchObject({ id: pending.id, needs_clarification: true });
    expect(kept().at(-1)!.id).not.toBe(pending.id);
  });

  it('restores the global prompt when widening a project conversation during the account read', async () => {
    const store = await startStore();
    script = params => ok({ scope: GLOBAL, outcome: 'clarify', parts: [], sources: [], receipt: { looked_through: 0 },
      question: params.question, choices: [{ label: 'June', question: 'Did June ship?' }] });
    await store.ask('Did it ship?');
    const original = kept()[0]!;
    script = null;
    store.openProject(apollo);
    await store.ask('Who owns Apollo?', inApollo);
    const history = [...kept()];
    app = { signed_in: false, account: null, client_version: 'test' };
    await store.refreshStatus();
    const read = held.hold('timeline.read');
    app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
    await store.refreshStatus();
    store.widenScope();
    expect(store.getState().barScope).toEqual(inApollo);
    expect(asked()).toHaveLength(2);
    read(ok({ turns: history }));
    await flush();
    store.widenScope();
    await store.ask('June.');
    expect(asked()[2]).toMatchObject({ question: 'Did it ship?\nJune.', scope: GLOBAL });
    expect(kept()).toHaveLength(2);
    expect(kept()[0]).toMatchObject({ id: original.id, clarification: 'June.' });
  });

  it('writes the original question before research and resumes it at the same position after a restart', async () => {
    const store = await startStore();
    const write = held.hold('timeline.put');
    const running = held.hold('ask.run');
    const first = store.ask('Did it ship?');
    await flush();
    const row = store.getState().timeline.entries[0]!;
    expect(row).toMatchObject({ text: 'Did it ship?', follows: null });
    expect(asked()).toHaveLength(0);
    expect(store.getState().timeline.turns).toHaveLength(0);
    write(ok({}));
    await flush();
    expect(asked()).toHaveLength(1);
    store.cancelAsk();
    running(answered(asked()[0]!));
    await first;
    // Restore the successful pending write the held RPC acknowledged.
    await rpc('timeline.put', { expect: ACCOUNT, turn: row });
    await store.ask('Did it ship?');
    expect(asked()[1]).not.toHaveProperty('previous');
    await readAgain(store);
    await store.returnToAsk();
    expect(asked()).toHaveLength(2);
    store.retryPending(row.id);
    await flush();
    const rows = store.getState().timeline.entries;
    expect(rows.map(each => each.text)).toEqual(['Did it ship?', 'Did it ship?']);
    expect(rows[0]).toMatchObject({ id: row.id, asked_at: row.asked_at, answer: { outcome: 'answered' } });
    expect(rows[1]!.id).not.toBe(row.id);
  });

  it('selects a named older topic silently without changing the displayed history or including project questions', async () => {
    const billing = threadIn(GLOBAL, ['Billing rollout?', 5 * DAY])[0]!;
    const march = threadIn(GLOBAL, ['March pilot?', 2 * DAY])[0]!;
    const projectOnly = threadIn(inApollo, ['Private Apollo question?', DAY])[0]!;
    seed(billing, march, projectOnly);
    const store = await startStore();
    const words = 'Back to billing, did it ship?';
    script = params => params.threads ? elsewhere(params, [placeOf(params, billing.text)]) : answered(params);
    await store.ask(words);
    expect(asked()).toHaveLength(2);
    expect(asked()[0]).toMatchObject({ previous: { question: march.question }, threads: [{ questions: [billing.text] }] });
    expect(asked()[1]).toMatchObject({ question: words, previous: { question: billing.question, candidate: true } });
    expect(JSON.stringify(asked())).not.toContain('Private Apollo');
    expect(store.entriesInScope(GLOBAL).map(row => row.text)).toEqual([billing.text, march.text, words]);
    expect(store.entriesInScope(inApollo).map(row => row.text)).toEqual([projectOnly.text]);
    expect(new Set(calls('timeline.put').map(call => (call.turn as TimelineTurn).id))).toEqual(new Set([kept().at(-1)!.id]));
    const shown = await page(store);
    for (const label of ['clarify', 'moved-note', 'continues-note', 'door']) expect(byTestId(shown, label)).toHaveLength(0);
  });

  it('offers both plausible conversations in place and completes the pending question only once after a choice', async () => {
    const one = threadIn(GLOBAL, ['March release?', 3 * DAY])[0]!;
    const two = threadIn(GLOBAL, ['June release?', 2 * DAY])[0]!;
    const latest = threadIn(GLOBAL, ['Pricing?', DAY])[0]!;
    seed(one, two, latest);
    const store = await startStore();
    script = params => params.threads ? elsewhere(params, [placeOf(params, one.text), placeOf(params, two.text)]) : answered(params);
    await store.ask('Did the release ship?');
    const pending = kept().at(-1)!;
    expect(pending).toMatchObject({ needs_clarification: true });
    expect(pending).not.toHaveProperty('answer');
    expect(store.clarifyThreads().map(t => t.id)).toEqual([one.id, two.id]);
    await store.chooseThread(one.id);
    expect(asked()[1]).toMatchObject({ previous: { question: one.question } });
    expect(asked()[1]).not.toHaveProperty('threads');
    expect(kept().at(-1)).toMatchObject({ id: pending.id, thread: one.id, answer: { outcome: 'answered' } });
    expect(kept()).toHaveLength(4);
  });

  it('places a standalone quick reply in the topic it names and keeps only the user’s words as typed history', async () => {
    const billing = threadIn(GLOBAL, ['March billing rollout?', 2 * DAY])[0]!;
    const pricing = threadIn(GLOBAL, ['March pricing rollout?', DAY])[0]!;
    seed(billing, pricing);
    const store = await startStore();
    const words = 'Did the March rollout ship?';
    const choices = [{ label: 'Pricing', question: 'Did the March pricing rollout ship?' }, { label: 'Billing', question: 'Did the March billing rollout ship?' }];
    script = params => params.question === words
      ? ok({ scope: GLOBAL, outcome: 'clarify', parts: [], sources: [], receipt: { looked_through: 0 }, choices })
      : params.threads ? elsewhere(params, [placeOf(params, billing.text)]) : answered(params);
    await store.ask(words);
    const pending = kept().at(-1)!;
    store.chooseClarified(choices[1]!);
    await flush();
    expect(asked()[1]).toMatchObject({ question: choices[1]!.question, previous: { question: pricing.question }, threads: [{ questions: [billing.text] }] });
    expect(asked()[2]).toMatchObject({ question: choices[1]!.question, previous: { question: billing.question } });
    expect(asked()[2]).not.toHaveProperty('threads');
    expect(kept().at(-1)).toMatchObject({ id: pending.id, follows: billing.id, thread: billing.id, text: words, typed: words, carried: [pricing.id, billing.id] });
  });

  it.each([
    ['manual', 'offer revoked'], ['manual', 'destination revoked'], ['automatic', 'offer revoked'],
    ['automatic', 'destination revoked'], ['manual', 'no destination sources'],
  ])('keeps the %s destination for a clicked choice with %s', async (selection, access) => {
    const other = turn('Another release?', 3 * DAY);
    const destination = turn('Billing release?', 2 * DAY, access === 'no destination sources'
      ? { answer: answerOf('Billing release?', GLOBAL, { sources: [], parts: [], outcome: 'not_found' }) } : {});
    const sourceQuestion = 'Which tickets remain?';
    const statements = [said('ORION-7 remains open.', [0])];
    const source = turn(sourceQuestion, DAY, { answer: answerOf(sourceQuestion, GLOBAL, { sources: [ticket('ORION-7', '30007')],
      parts: [{ question: sourceQuestion, status: 'answered', statements, blocks: paragraphs(statements) }] }) });
    seed(other, destination, source);
    const store = await startStore();
    const typed = 'Who owns it?';
    const choice = { label: 'ORION-7', question: 'Who owns ORION-7?' };
    const automatic = selection === 'automatic';
    const offerRevoked = access === 'offer revoked';
    const gone = offerRevoked ? source : destination;
    script = params => {
      if (params.question === typed && params.threads) return ok({ scope: GLOBAL, outcome: 'clarify', parts: [], sources: [], receipt: { looked_through: 0 }, choices: [choice] });
      if (params.threads) {
        checks = items => ok({ items: items.map(item => ({ state: item.asked_at === gone.asked_at ? 'unreadable' : 'same' })) });
        return elsewhere(params, (automatic ? [destination] : [destination, other]).map(topic => placeOf(params, topic.text)));
      }
      return answered(params);
    };
    await store.ask(typed);
    const row = kept().at(-1)!;
    store.chooseClarified(choice);
    await flush();
    if (!automatic) await store.chooseThread(destination.id);
    const request = asked()[2]!;
    expect(request.question).toBe(offerRevoked ? typed : choice.question);
    expect(request.previous).toMatchObject({ question: destination.question });
    expect((request.previous as AskPrevious).candidate).toBe(automatic ? true : undefined);
    expect(request).not.toHaveProperty('threads');
    if (offerRevoked) {
      expect(JSON.stringify(request)).not.toContain('ORION-7');
      const saved = calls('timeline.put').map(call => call.turn as PendingTurn).filter(turn => turn.id === row.id && !('answer' in turn)).at(-1);
      expect(saved).toMatchObject({ text: typed, follows: destination.id, fixed: true });
      expect(saved?.candidate).toBe(automatic ? true : undefined);
    } else expect(request.previous).toMatchObject({ statements: [], citations: [] });
    expect(kept().at(-1)).toMatchObject({ id: row.id, thread: destination.id, follows: destination.id, typed, text: typed,
      carried: offerRevoked ? [destination.id] : [source.id, destination.id] });
  });

  it.each([['manual', 'readable'], ['automatic', 'readable'], ['manual', 'revoked']])(
    'adds typed detail to the live %s Billing question while the ticket is %s', async (selection, access) => {
      const billing = turn('Who owns billing?', 3 * DAY), payments = turn('Who owns payments?', 2 * DAY);
      const pricing = turn('Who owns pricing?', DAY, { answer: answerOf('Who owns pricing?', GLOBAL,
        { sources: [ticket('ORION-7', '30007')], parts: [{ question: 'Who owns pricing?', status: 'answered', statements: [said('ORION-7 is open.', [0])] }] }) });
      seed(billing, payments, pricing);
      const store = await startStore();
      const typed = 'Who owns it?', detail = 'The team, please.';
      const chosen = { label: 'ORION-7', question: 'Who owns ORION-7?' };
      const prompt = (choices: typeof chosen[]) => ok({ scope: GLOBAL, outcome: 'clarify', parts: [], sources: [], receipt: { looked_through: 0 }, choices });
      const automatic = selection === 'automatic';
      script = params => params.question === typed ? prompt([chosen]) : params.threads
        ? elsewhere(params, (automatic ? [billing] : [billing, payments]).map(topic => placeOf(params, topic.text)))
        : prompt([{ label: 'Person', question: 'Which person owns the ticket?' }, { label: 'Team', question: 'Which team owns the ticket?' }]);
      await store.ask(typed);
      const row = kept().at(-1)!;
      store.chooseClarified(chosen);
      await flush();
      if (!automatic) await store.chooseThread(billing.id);
      if (access === 'revoked') checks = items => ok({ items: items.map(item => ({ state: item.asked_at === pricing.asked_at ? 'unreadable' : 'same' })) });
      script = params => answered(params);
      const check = held.hold('ask.check');
      const answering = store.ask(detail);
      await flush();
      const own = typed + '\n' + detail;
      const research = (access === 'revoked' ? typed : chosen.question) + '\n' + detail;
      expect(kept().at(-1)).toMatchObject({ id: row.id, text: typed, clarification: detail, follows: billing.id });
      expect(JSON.stringify(kept().at(-1))).not.toContain(chosen.label);
      const items = calls('ask.check').at(-1)!.items as { asked_at: string; citation: { kind: string } }[];
      check(checks!(items));
      await answering;
      expect(asked()[3]).toMatchObject({ question: research, previous: { question: billing.text } });
      expect((asked()[3]!.previous as AskPrevious).candidate).toBe(automatic ? true : undefined);
      if (!automatic) expect(asked()[3]).not.toHaveProperty('threads');
      if (access === 'revoked') expect(JSON.stringify(asked()[3])).not.toContain(chosen.label);
      expect(kept().at(-1)).toMatchObject({ id: row.id, text: typed, typed: own, clarification: detail, question: research, follows: billing.id });
    },
  );

  it.each(['readable', 'revoked'])('asks a selected ticket as a new subject when its source is %s', async access => {
    const revoked = access === 'revoked';
    const april = threadIn(GLOBAL, ['April billing rollout?', 3 * DAY])[0]!;
    const june = threadIn(GLOBAL, ['June billing rollout?', 2 * DAY])[0]!;
    const latest = threadIn(GLOBAL, ['Which tickets remain?', DAY])[0]!;
    seed(april, june, latest);
    const store = await startStore();
    const typed = 'Did it ship?';
    const ticket = { label: 'THERM-490', question: 'Did THERM-490 ship?' };
    script = params => params.question === typed
      ? ok({ scope: GLOBAL, outcome: 'clarify', parts: [], sources: [], receipt: { looked_through: 0 }, choices: [ticket] })
      : elsewhere(params, [placeOf(params, april.text), placeOf(params, june.text)]);
    await store.ask(typed);
    const row = kept().at(-1)!;
    store.chooseClarified(ticket);
    await flush();
    expect(store.clarifyThreads().map(topic => topic.id)).toEqual([april.id, june.id]);
    if (revoked) checks = items => ok({ items: items.map(() => ({ state: 'unreadable' })) });
    script = params => answered(params);
    const before = calls('ask.check').length;
    store.askNewQuestion();
    await flush();
    expect(calls('ask.check').slice(before).flatMap(call => call.items)).toContainEqual(expect.objectContaining({ asked_at: latest.asked_at }));
    expect(asked()).toHaveLength(3);
    expect(asked()[2]!.question).toBe(revoked ? typed : ticket.question);
    expect(asked()[2]).not.toHaveProperty('previous');
    expect(asked()[2]).not.toHaveProperty('threads');
    expect(kept().at(-1)).toMatchObject({ id: row.id, thread: row.id, follows: null, text: typed, typed, carried: revoked ? [] : [latest.id] });
  });

  it('regenerates an interrupted ticket choice with current access and the original candidate context after restart', async () => {
    const old = threadIn(GLOBAL, ['Which tickets remain?', 8 * DAY])[0]!;
    seed(old);
    const store = await startStore();
    const words = 'Did it ship?';
    const choices = [{ label: 'THERM-482', question: 'Did THERM-482 ship?' }, { label: 'THERM-490', question: 'Did THERM-490 ship?' }];
    script = () => ok({ scope: GLOBAL, outcome: 'clarify', parts: [], sources: [], receipt: { looked_through: 0 }, choices });
    await store.ask(words);
    const pending = kept().at(-1)!;
    const finish = held.hold('ask.run');
    store.chooseClarified(choices[1]!);
    await flush();
    expect(asked()[1]).toMatchObject({ question: choices[1]!.question });
    expect(asked()[1]).not.toHaveProperty('threads');
    expect(kept().at(-1)).toEqual(pending);
    store.cancelAsk();
    finish(answered(asked()[1]!));
    await flush();
    await readAgain(store);
    await store.returnToAsk();
    checks = items => ok({ items: items.map(() => ({ state: 'unreadable' })) });
    script = params => answered(params);
    store.retryPending(pending.id);
    await flush();
    expect(asked()[2]).toMatchObject({ question: words, previous: { question: old.question, candidate: true, citations: [], statements: [] } });
    expect(JSON.stringify(asked()[2])).not.toContain('THERM-490');
    expect(kept().at(-1)).toMatchObject({ id: pending.id, text: words, typed: words });
  });

  it('distinguishes an old implicit subject from a turn the person explicitly opened', async () => {
    const march = threadIn(GLOBAL, ['March release?', 30 * DAY])[0]!;
    const june = threadIn(GLOBAL, ['June launch?', 9 * DAY])[0]!;
    seed(march, june);
    const store = await startStore();
    script = params => ok({ scope: GLOBAL, outcome: 'clarify', parts: [], sources: [], receipt: { looked_through: 0 },
      choices: [{ label: 'June launch', question: 'Did the June launch ship?' }], question: params.question });
    await store.ask('Did it ship?');
    expect(asked()[0]).toMatchObject({ previous: { candidate: true, question: june.question } });
    const id = kept().at(-1)!.id;
    await readAgain(store);
    await store.returnToAsk();
    script = params => answered(params);
    await store.ask('I meant the June launch.');
    expect(asked()[1]!.question).toBe('Did it ship?\nI meant the June launch.');
    expect(kept().at(-1)).toMatchObject({ id, text: 'Did it ship?', clarification: 'I meant the June launch.', typed: 'Did it ship?\nI meant the June launch.' });
    expect(store.chains().flatMap(chain => chain.questions)).toContain('Did it ship?\nI meant the June launch.');
    store.toggleTurn(march.id);
    script = params => ok({ scope: GLOBAL, outcome: 'clarify', parts: [], sources: [], receipt: { looked_through: 0 },
      question: params.question, choices: [{ label: 'March', question: 'Did the March release ship?' }] });
    await store.ask('Did it ship?');
    expect(asked()[2]).toMatchObject({ previous: { question: march.question } });
    expect(asked()[2]!.previous).not.toHaveProperty('candidate');
    expect(asked()[2]).not.toHaveProperty('threads');
    store.toggleTurn(june.id); // Read another answer while the question is waiting.
    expect(store.getState().ask?.clarify).not.toBeNull();
    script = null;
    await store.ask('The March release.');
    expect(asked()[3]).toMatchObject({ question: 'Did it ship?\nThe March release.', previous: { question: march.question } });
    expect(asked()[3]).not.toHaveProperty('threads');
  });
});
