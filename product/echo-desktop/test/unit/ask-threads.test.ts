// Ask threads (ADR-0056) and the conversations they make (ADR-0057), in the rules and in the store: which thread a turn
// belongs to, a thread's home and name, a conversation (chain) and its label, what an Ask carries of the other
// conversations and of its own older turns and how that is cut to fit; where an answer lands, a joined thread never
// changing, "Which one?" and "New question"; what ECHO just did and its Undo; links; the door; and the way out of every
// wait (cancel, failure, another account, a page change, closing Ask, the timeline read again).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonAnswerCitationV8 } from '@echo-brain/organization-api';
import type { Answer, AnswerSource, AnswerStatement, AppStatus, AskPrevious, AskScope, AskThread, TimelineTurn } from '../../src/shared/protocol.js';
import { MAX_REQUEST_BYTES, THREAD_ACTIVE_MS } from '../../src/shared/protocol.js';
import {
  askCarries, chainsOf, continuedThread, doorChains, earlierOf, homeTurns, labelOf, otherChains, ownWords, sameScope, threadActive, threadIds, threadsOf,
  type AskEarlierTurn, type Chain, type Thread,
} from '../../src/renderer/timeline.js';
import { askedWhen } from '../../src/renderer/format.js';
import { paragraphs } from '../fixtures/authority.js';
import {
  ACCOUNT, byTestId, click, elements, fail, fileOf, flush, Held, keysetPage, numbered, ok, plainHooks, project, render, rpcFor, startStore, storeLifecycle, text,
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
/**
 * How a `timeline.remove` ends: as the host does it (null); failed by the host, nothing written (a file it cannot
 * read); taken by no host, as main says when none is running; no reply in time; or taken by the file, its reply lost.
 */
let removeEnds: null | 'failed' | 'unsent' | 'timeout' | 'lost';
/** While set, a `timeline.remove` is taken by the file at once and its reply waits for this. */
let removeGate: Promise<unknown> | null;
/** The turns, by what was typed for them, whose `timeline.put` fails. */
let unsaved: Set<string>;
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
  removeEnds = null;
  removeGate = null;
  unsaved = new Set();
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
  rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'timeline.put' && unsaved.has((params.turn as TimelineTurn).text)) return fail('failed');
    if (method !== 'timeline.remove') return base(method, params);
    if (removeEnds === 'failed') return fail('failed');
    if (removeEnds === 'timeout') return fail('timeout', { retryable: true });
    if (removeEnds === 'unsent') return fail('host_restarted', { retryable: true, mutation_outcome: 'not_submitted' });
    const reply = await base(method, params);
    if (removeGate) await removeGate;
    if (removeEnds === 'lost') throw new Error('the reply was lost');
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
/** From here, a removal is taken by the file at once and its reply waits until the returned function is called. */
const gated = () => {
  let open!: (value?: unknown) => void;
  removeGate = new Promise((resolve) => { open = resolve; });
  return () => { removeGate = null; open(); };
};
/** Signed out and in again as the same person, Ask open behind the sign-in page: the timeline is read again, as a restart reads it. */
async function readAgain(store: Store) {
  app = { signed_in: false, account: null, client_version: 'test' };
  await store.refreshStatus();
  app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  await store.refreshStatus();
  await flush();
}
const words = () => import('../../src/renderer/store.js');
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
    expect(names(otherChains(threads, GLOBAL, by['When does the pilot start?']!.id))).toEqual(['What is Zephyr waiting on?', 'What is left in Apollo?', 'Which tests fail?', 'Who owns billing?']);
    // Asked from a page it continues none: every thread is a candidate.
    expect(names(otherChains(threads, GLOBAL, null))).toEqual(['What is Zephyr waiting on?', 'What is left in Apollo?', 'When does the pilot start?', 'Which tests fail?', 'Who owns billing?']);
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
    const { threads, sent } = askCarries('and the budget?', GLOBAL, null, [], otherChains(chainsOf(turns), GLOBAL, null).slice(1, 3));
    expect(threads).toEqual([
      { questions: ['What is left in Apollo?', 'and who owns it?'], asked_at: turns[4]!.asked_at },
      { questions: ['When does the pilot start?', 'did that change?'], asked_at: turns[1]!.asked_at },
    ]);
    expect(sent).toEqual([turns[3]!.id, turns[0]!.id]);
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
  const open = (store: Store) => store.getState().ask?.thread;


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


  it('places a question not asked in a thread among every conversation, the one shown included, with no earlier turn: it shows alone until placed, and a new subject starts a thread Ask then shows', async () => {
    const { billing, tests, pilot } = seeded();
    const store = await startStore();
    // Back in Ask from the sidebar, Ask shows the thread asked in last. The person has neither picked it nor asked in it.
    expect(await store.returnToAsk()).toBe(true);
    await flush();
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: false });
    expect(await questions(store)).toEqual(['who decided?']);
    const release = held.hold('ask.run');
    void store.ask('What is new this week?');
    await flush();
    expect(asked()[0]).not.toHaveProperty('previous');
    expect(asked()[0]!.threads).toEqual([
      { questions: ['When does the pilot start?', 'did that change?', 'who decided?'], asked_at: pilot[2]!.asked_at },
      { questions: ['Which tests fail?'], asked_at: tests[0]!.asked_at },
      { questions: ['Who owns billing?', 'when is it due?'], asked_at: billing[1]!.asked_at },
    ]);
    // On its way it shows alone: where it belongs is not known yet.
    expect(store.threadShown()).toBeUndefined();
    expect(await questions(store)).toEqual(['What is new this week?']);
    expect(byTestId(await page(store), 'timeline-row')).toEqual([]);
    release(answered(asked()[0]!));
    await flush();
    const saved = kept().at(-1)!;
    expect(saved).toMatchObject({ text: 'What is new this week?', thread: saved.id, follows: null });
    expect(store.threadShown()).toMatchObject({ id: saved.id, name: 'What is new this week?', home: GLOBAL });
    expect(await questions(store)).toEqual(['What is new this week?']);
    // From a page, Ask closed, the same: no earlier turn, every thread; and the person, having asked in it, is in the new one.
    expect(open(store)).toEqual({ id: saved.id, entered: true });
    store.closeAsk();
    await store.ask('Another subject?');
    expect(asked()[1]).not.toHaveProperty('previous');
    expect((asked()[1]!.threads as AskThread[]).map(thread => thread.questions[0])).toEqual(['What is new this week?', 'When does the pilot start?', 'Which tests fail?', 'Who owns billing?']);
  });

  it('continues the thread a person is in: the previous turn, its older turns from one fresh check, each sentence only when its sources were found readable, and the other threads; the answer is saved in it (R6)', async () => {
    const { billing, tests, pilot } = seeded();
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
      { questions: ['Which tests fail?'], asked_at: tests[0]!.asked_at }, { questions: ['Who owns billing?', 'when is it due?'], asked_at: billing[1]!.asked_at }]);
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

  it('carries an empty list from a person\'s only thread, so an answer that says the subject is new starts a second thread, which Ask shows and the next question continues', async () => {
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
    seed(...pilot);
    script = params => (params.question === 'What is for lunch?' ? answered(params, { thread: { kind: 'new' } }) : null);
    const store = await opened(pilot[0]!.id);
    // In it, a question continues it, and with no other thread the list still goes, empty.
    await store.ask('who decided that?');
    expect(asked()[0]).toMatchObject({ previous: { purpose: 'follow_up', question: 'When does the pilot start?' }, threads: [] });
    expect(kept().at(-1)!.thread).toBe(pilot[0]!.id);
    await store.ask('What is for lunch?');
    await flush();
    expect(asked()[1]).toMatchObject({ previous: { purpose: 'follow_up', question: 'who decided that?' }, threads: [] });
    const saved = kept().at(-1)!;
    expect(saved).toMatchObject({ text: 'What is for lunch?', thread: saved.id });
    expect(saved.answer).not.toHaveProperty('thread');
    expect(store.threads().map(thread => thread.name)).toEqual(['When does the pilot start?', 'What is for lunch?']);
    expect(store.threadShown()).toMatchObject({ id: saved.id, name: 'What is for lunch?' });
    expect(open(store)).toEqual({ id: saved.id, entered: true });
    expect(await questions(store)).toEqual(['What is for lunch?']);
    // The thread it was typed in is as it was, and the next question continues the new one.
    expect(filed()['who decided that?']).toBe(pilot[0]!.id);
    await store.ask('and for Friday?');
    expect(asked()[2]!.previous).toMatchObject({ question: 'What is for lunch?' });
    expect(kept().at(-1)!.thread).toBe(saved.id);
  });

  it('jumps without asking to the one other thread of the same home the answer names, and asks the same words there as a plain follow-up with no thread riding; from another page Home goes under Ask, and the thread Ask showed can be the one', async () => {
    const { billing, pilot } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Who owns billing?')]) : null);
    const store = await opened(pilot[0]!.id);
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
    expect(open(store)).toEqual({ id: billing[0]!.id, entered: true });
    expect(store.getState().route).toBe(route);
    expect(kept().at(-1)).toMatchObject({ text: 'who approves the invoices?', typed: 'who approves the invoices?', thread: billing[0]!.id, follows: billing[1]!.id });
    expect(kept()).toHaveLength(7);
    expect(await questions(store)).toEqual(['when is it due?', 'who approves the invoices?']);
    // The thread it was typed in keeps its turns.
    expect(pilot.map(each => filed()[each.text])).toEqual(Array(3).fill(pilot[0]!.id));
    // Asked over Tools, Ask closed, and sent on to the thread with no project: Home goes under Ask, as a pick of it would,
    // and Back leaves Ask for Home, where the thread lives, not for the page it was asked over.
    store.closeAsk();
    store.openTools();
    await store.ask('who signs them?');
    await flush();
    expect(store.threadShown()?.id).toBe(billing[0]!.id);
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(asked()[3]).toMatchObject({ question: 'who signs them?', scope: GLOBAL, previous: { question: 'who approves the invoices?' } });
    store.closeAsk();
    expect(store.getState().route).toEqual({ page: 'home' });
    // Back from the sidebar, the thread Ask shows is the one named: the person is then in it, and the words asked there.
    store.returnToAsk();
    await flush();
    expect(open(store)).toEqual({ id: billing[0]!.id, entered: false });
    await store.ask('and who pays them?');
    await flush();
    expect(asked()[4]).not.toHaveProperty('previous');
    expect(asked()[5]).toMatchObject({ question: 'and who pays them?', previous: { purpose: 'follow_up', question: 'who signs them?' } });
    expect(open(store)).toEqual({ id: billing[0]!.id, entered: true });
  });

  it('asks "Which one?" when the question could belong to several threads (R4): nothing guessed or kept, the shown thread among the buttons; a pick jumps there and asks the typed words in it', async () => {
    const { billing, pilot } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'When does the pilot start?'), placeOf(params, 'Who owns billing?')]) : null);
    const store = await startStore();
    store.returnToAsk();
    await flush();
    await store.ask('did that change?');
    await flush();
    // Nothing is guessed: nothing more is asked, nothing is kept, and the question still shows alone.
    expect(asked()).toHaveLength(1);
    expect(kept()).toHaveLength(6);
    expect(store.getState().ask?.clarify).toEqual({ kind: 'threads', question: 'did that change?', scope: GLOBAL, thread: null, threads: [pilot[0]!.id, billing[0]!.id], links: [] });
    expect(await questions(store)).toEqual(['did that change?']);
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: false });
    const clarify = byTestId(await page(store), 'clarify')[0]!;
    expect(text(clarify)).toContain('Which one do you mean?');
    expect(byTestId(clarify, 'choice').map(text)).toEqual(['When does the pilot start?', 'Who owns billing?', 'New question']);
    expect(byTestId(clarify, 'choice-project')).toEqual([]);
    // Picked, the person is in it: the words are asked there, and the next question continues it with only the others riding.
    click(byTestId(clarify, 'choice')[1]);
    await flush();
    expect(open(store)).toEqual({ id: billing[0]!.id, entered: true });
    expect(asked()[1]).toMatchObject({ question: 'did that change?', scope: GLOBAL, previous: { purpose: 'follow_up', question: 'when is it due?' } });
    expect(asked()[1]).not.toHaveProperty('threads');
    expect(store.getState().ask?.clarify).toBeNull();
    expect(kept().at(-1)).toMatchObject({ text: 'did that change?', thread: billing[0]!.id });
    await store.ask('and since when?');
    expect(asked()[2]).toMatchObject({ question: 'and since when?', previous: { purpose: 'follow_up', question: 'did that change?' } });
    expect((asked()[2]!.threads as AskThread[]).map(thread => thread.questions[0])).toEqual(['When does the pilot start?', 'Which tests fail?']);
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
    expect(store.getState().toast).toBe((await words()).THREAD_OUT_OF_REACH);
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

  it('reads the project of a thread picked to ask in, though the sidebar has it: archived meanwhile, nothing is asked and nothing joins, its button goes; a jump made only to look goes by the sidebar\'s copy', async () => {
    const tests = threadIn(inApollo, ['Which tests fail?', 5 * DAY]);
    const flaky = threadIn(inApollo, ['Which tests are flaky?', 4 * DAY]);
    seed(...tests, ...flaky);
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Which tests fail?')], { merge: [placeOf(params, 'Which tests are flaky?')] }) : null);
    const store = await startStore();
    await store.ask('are they fixed?');
    await flush();
    expect(store.getState().projects.items.map(each => each.project_id)).toContain(apollo.project_id);
    // Archived elsewhere since the sidebar read it: its copy still says active.
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation((method: string, params: Record<string, unknown>) => (method === 'projects.read' ? Promise.resolve(ok({ ...apollo, status: 'archived' })) : base(method, params)));
    await store.chooseThread(tests[0]!.id);
    await flush();
    expect(calls('projects.read')).toEqual([expect.objectContaining({ project_id: apollo.project_id })]);
    expect(store.getState().toast).toBe((await words()).THREAD_OUT_OF_REACH);
    expect(kept().some(each => each.continues !== undefined)).toBe(false);
    expect(filed()['Which tests are flaky?']).toBe(flaky[0]!.id);
    expect(asked()).toHaveLength(1);
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.clarifyThreads()).toEqual([]);
    expect(await store.openThread(flaky[0]!.id)).toBe(true);
    expect(calls('projects.read')).toHaveLength(1);
  });

  it('asks in a picked thread\'s project once its read says it is the person\'s, though their project list is still loading, and keeps the button, saying why, when the read fails', async () => {
    const { tests } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Which tests fail?'), placeOf(params, 'Who owns billing?')]) : null);
    // The project list has not come back yet.
    const listing = held.hold('projects.list');
    const store = await startStore();
    expect(store.getState().projects.items).toEqual([]);
    await store.ask('are they fixed?');
    await flush();
    // The read fails: the page says why, nothing is asked, and the pick can be made again.
    const reading = held.hold('projects.read');
    const pick = store.chooseThread(tests[0]!.id);
    reading(fail('unavailable', { retryable: true }));
    await pick;
    expect(asked()).toHaveLength(1);
    expect(store.getState().toast).toBe('ECHO is unavailable right now. Try again.');
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.clarifyThreads().map(each => each.name)).toEqual(['Which tests fail?', 'Who owns billing?']);
    // Read this time, one still theirs is asked in, never taken for lost.
    await store.chooseThread(tests[0]!.id);
    await flush();
    expect(calls('projects.read')).toEqual([expect.objectContaining({ project_id: apollo.project_id }), expect.objectContaining({ project_id: apollo.project_id })]);
    expect(store.getState().toast).not.toBe((await words()).THREAD_OUT_OF_REACH);
    expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: apollo.project_id } });
    expect(asked()[1]).toMatchObject({ question: 'are they fixed?', scope: inApollo, previous: { question: 'Which tests fail?' } });
    listing(ok(keysetPage(active, undefined)));
    await flush();
  });

  it.each([
    ['the typed words go back to the empty bar', '', 'are they fixed?'],
    ['the bar keeps what the person typed since', 'what else?', 'what else?'],
  ] as const)('drops a pick still reading its project once × widens the bar: nothing is asked, the bar stays wide, and %s', async (_why, typed, bar) => {
    const tests = threadIn(inApollo, ['Which tests fail?', 5 * DAY]);
    const flaky = threadIn(inApollo, ['Which tests are flaky?', 4 * DAY]);
    seed(...tests, ...flaky);
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Which tests fail?'), placeOf(params, 'Which tests are flaky?')]) : null);
    const store = await startStore();
    await store.openProject(apollo);
    await store.ask('are they fixed?');
    await flush();
    const reading = held.hold('projects.read');
    const pick = store.chooseThread(tests[0]!.id);
    store.widenScope();
    store.setBarText(typed);
    reading(ok(apollo));
    await pick;
    await flush();
    expect(asked()).toHaveLength(1);
    expect(store.getState().barScope).toEqual(GLOBAL);
    expect(store.getState().barText).toBe(bar);
    expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: apollo.project_id } });
    expect(store.clarifyThreads().map(each => each.name)).toEqual(['Which tests fail?', 'Which tests are flaky?']);
    // Picked again with nothing in the way, the bar narrows back to Apollo and the words are asked there.
    await store.chooseThread(tests[0]!.id);
    await flush();
    expect(store.getState().barScope).toEqual(inApollo);
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
    const store = await opened(pilot[0]!.id);
    await store.ask('who owns that ticket?');
    await flush();
    expect(store.getState().ask?.clarify).toMatchObject({ kind: 'choices', choices, follows: pilot[2]!.id, typed: 'who owns that ticket?' });
    store.chooseClarified(choices[1]!);
    await flush();
    // The choice is what is asked, not the typed words again.
    expect(asked()[1]).toMatchObject({ question: 'Who owns THERM-490?', previous: { purpose: 'follow_up', question: 'who decided?' } });
    expect(asked()[1]).not.toHaveProperty('threads');
    expect(asked()[1]!.previous).not.toHaveProperty('earlier');
    expect(kept().at(-1)).toMatchObject({ text: 'Who owns THERM-490?', typed: 'who owns that ticket?', thread: pilot[0]!.id });
  });

  it('asks outside a project\'s thread once × widens the bar: the thread stays on the page, and the question continues none', async () => {
    const { tests } = seeded();
    const store = await startStore();
    await store.openProject(apollo);
    store.returnToAsk();
    await flush();
    // The thread asked in most recently is the pilot's, at Home; Apollo's opens from the door.
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

  it('puts the person in a thread by each way of picking it, and never by the sidebar\'s Ask or the bar\'s ×', async () => {
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
    // Its own row in the list, when it is the thread shown, a jump like any row's; refused, like every row, while a
    // question is on its way.
    const onItsWay = held.hold('ask.run');
    void store.ask('Something else?');
    await flush();
    expect(await store.openThread(pilot[0]!.id)).toBe(false);
    expect(store.getState().ask?.thread).toEqual({ id: pilot[0]!.id, entered: false });
    store.cancelAsk();
    onItsWay(fail('unavailable', { retryable: true }));
    await flush();
    expect(await store.openThread(pilot[0]!.id)).toBe(true);
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
    // Widening the bar is not picking it.
    store.widenScope();
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: false });
    await flush();
    // Asking in it is: the answer to a question placed there lands there.
    script = params => (params.threads ? elsewhere(params, [0]) : null);
    await store.ask('and the budget?');
    await flush();
    expect(open(store)).toEqual({ id: pilot[0]!.id, entered: true });
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

  it.each<[string, (store: Store, tests: string) => unknown, 'pilot' | 'tests' | 'blocked' | 'the sidebar\'s Ask', boolean]>([
    // [where the person is, the thread jumped to, whether the page stays]
    // The bar asks all context already, and Apollo's page is still not where the pilot's thread lives.
    ['a project\'s page with its bar widened', async (store, tests) => { await store.openProject(apollo); await store.openThread(tests); store.widenScope(); }, 'pilot', false],
    ['a project\'s page with its bar widened, Ask closed', async (store) => { await store.openProject(apollo); store.widenScope(); }, 'the sidebar\'s Ask', false],
    // On its own project's page a thread stays there, and a widened bar narrows back; the open thread's own row too.
    ['its project\'s page with the bar widened', async (store) => { await store.openProject(apollo); store.widenScope(); }, 'tests', true],
    ['its project\'s page on it, the bar widened', async (store, tests) => { await store.openProject(apollo); await store.openThread(tests); store.widenScope(); }, 'tests', true],
    // Another project's thread opens that project, however the bar was widened.
    ['a project\'s page with its bar widened', async (store) => { await store.openProject(apollo); store.widenScope(); }, 'blocked', false],
    // Any page but Home gives way to Home under a thread with no project: Tools too; on Home already, Home stays as it is.
    ['Tools', store => store.openTools(), 'pilot', false],
    ['Home', () => undefined, 'pilot', true],
  ])('puts the thread\'s own page under Ask on a jump from %s to %s, whatever the bar asks', async (_from, start, to, stays) => {
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY]);
    const blocked = threadIn(inZephyr, ['What is blocked?', 3 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(...tests, ...blocked, ...pilot);
    const store = await startStore();
    await start(store, tests[0]!.id);
    const before = store.getState().route;
    const [thread, home] = { pilot: [pilot, GLOBAL], tests: [tests, inApollo], blocked: [blocked, inZephyr], 'the sidebar\'s Ask': [pilot, GLOBAL] }[to] as [TimelineTurn[], AskScope];
    expect(await (to === 'the sidebar\'s Ask' ? store.returnToAsk() : store.openThread(thread[0]!.id))).toBe(true);
    await flush();
    if (stays) expect(store.getState().route).toBe(before);
    else expect(store.getState().route).toEqual(home.kind === 'global' ? { page: 'home' } : expect.objectContaining({ page: 'project', project: expect.objectContaining({ project_id: home.project_id }) }));
    expect(store.getState().barScope).toEqual(home);
    expect(store.getState().ask?.thread).toEqual({ id: thread[0]!.id, entered: to !== 'the sidebar\'s Ask' });
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
      expect(store.getState().timeline.removing).toBe(false);
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

  it('follows what a question was written from all the way back: a turn carried by a turn its request carried counts, though that request never carried it', async () => {
    const other = orion();
    // Asked in the other thread after it, carrying it; the pilot's follow-up carried this one, and not the turn before it.
    const between = turn('What does that team own?', 5 * DAY, { follows: other.id, thread: other.id, carried: [other.id] });
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 3 * DAY]);
    const rewrite = `Who signs off the pilot that ${NAME} leads?`;
    const followUp = turn(rewrite, 2 * DAY, { text: 'and who signs it off?', typed: 'and who signs it off?', follows: pilot[0]!.id, thread: pilot[0]!.id,
      answer: answerOf('and who signs it off?'), carried: [pilot[0]!.id, between.id] });
    seed(other, between, ...pilot, followUp);
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
  const notFound: Partial<TimelineTurn> = { scope: inApollo, answer: { scope: inApollo, sources: [], parts: [], outcome: 'not_found' } };

  it('holds through a question, a pick, a jump, Ask again, Ask everywhere, and ECHO\'s own link (R16)', async () => {
    // A thread with no project that an older file holds mixed: one of its turns was asked in Apollo.
    const mixed = threadIn(GLOBAL, ['Who signs the ledger?', 7 * DAY]);
    const odd = turn('What is left in Apollo?', 6 * DAY + HOUR, { scope: inApollo, thread: mixed[0]!.id });
    const billing = threadIn(GLOBAL, ['Who owns billing?', 6 * DAY], ['when is it due?', 5 * DAY]);
    const tests = threadIn(inApollo, ['Which tests fail?', 4 * DAY]);
    const budget = turn('Is there a budget?', 3 * DAY, notFound);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(mixed[0]!, odd, ...billing, ...tests, budget, ...pilot);
    const store = await startStore();
    // The one turn out of place is the file's own, and nothing below adds one.
    const before = [['What is left in Apollo?'], ['What is left in Apollo?']];
    expect(strays(store)).toEqual(before);
    // A jump to Apollo's thread, then the bar widened: the question is asked everywhere, so it joins no thread of Apollo's.
    await store.openThread(tests[0]!.id);
    store.widenScope();
    await store.ask('and across everything?');
    await flush();
    expect(kept().at(-1)).toMatchObject({ scope: GLOBAL, follows: null, thread: kept().at(-1)!.id });
    expect(strays(store)).toEqual(before);
    // A pick of "Which one?" at Home: the words are asked again in Apollo, where the thread lives, and land in it.
    script = params => (params.question === 'are they fixed?' && params.threads ? elsewhere(params, [placeOf(params, 'Which tests fail?')]) : null);
    store.goHome();
    await store.ask('are they fixed?');
    await flush();
    await store.chooseThread(tests[0]!.id);
    await flush();
    expect(kept().at(-1)).toMatchObject({ text: 'are they fixed?', scope: inApollo, thread: tests[0]!.id });
    expect(strays(store)).toEqual(before);
    // Ask again asks where its turn was asked, whatever the bar asks; Ask everywhere starts a thread with no project.
    store.goHome();
    store.askAgain(billing[1]!.id);
    await flush();
    expect(kept().at(-1)).toMatchObject({ again_of: billing[1]!.id, scope: GLOBAL, thread: billing[0]!.id });
    await store.openThread(budget.id);
    store.askEverywhere(budget.id);
    await flush();
    expect(kept().at(-1)).toMatchObject({ text: 'Is there a budget?', scope: GLOBAL, thread: kept().at(-1)!.id });
    expect(strays(store)).toEqual(before);
    // ECHO's own link, on an answer naming every conversation sent: the answer lands in the pilot's thread and names the
    // newest thread of each living where it was asked (R16). None of Apollo's, and no turn changes thread.
    await store.openThread(pilot[0]!.id);
    await flush();
    script = params => (params.threads ? answered(params, { merge: (params.threads as AskThread[]).map((_, place) => place) }) : null);
    const threadsBefore = filed();
    await store.ask('and the budget?');
    await flush();
    const linking = kept().find(each => each.text === 'and the budget?')!;
    expect(linking).toMatchObject({ thread: pilot[0]!.id });
    expect(linking.answer).not.toHaveProperty('merge');
    expect(linking.continues).toContain(billing[0]!.id);
    for (const apollos of [tests[0]!.id, budget.id]) expect(linking.continues).not.toContain(apollos);
    const joined = store.chains().find(chain => chain.threads.some(thread => thread.id === pilot[0]!.id))!;
    expect(joined.threads.every(thread => sameScope(thread.home, GLOBAL))).toBe(true);
    expect(filed()).toMatchObject(threadsBefore);
    expect(strays(store)).toEqual(before);
  });


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
    late(answered(asked().at(-1)!));
    await flush();
    expect(kept()).toHaveLength(5);
    // With Ask open before: it stays, on the thread it jumped to, with nothing on its way and nothing kept.
    late = await jumping(store, 'thread');
    store.cancelAsk();
    expect(store.getState().ask).toMatchObject({ thread: { id: billing[0]!.id, entered: true }, asking: null, failed: null, clarify: null });
    late(answered(asked().at(-1)!));
    await flush();
    expect(kept()).toHaveLength(5);
    expect(await questions(store)).toEqual(['when is it due?']);
    // The next question typed there is that thread's, asked as any other.
    await store.ask('and next quarter?');
    expect(asked().at(-1)).toMatchObject({ previous: { question: 'when is it due?' } });
    expect(asked().at(-1)!.threads).toBeDefined();
  });

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
    expect([asked().length, calls('timeline.put').length, kept().length]).toEqual([sent, puts, 5]);
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
    expect(kept()).toHaveLength(5);
    expect(store.getState().timeline.turns).toHaveLength(5);
  });

  it('moves nothing when × widens the bar while ECHO is placing the question: Ask stays on the thread it showed, nothing is asked, and the words go back to the bar', async () => {
    const tests = threadIn(inApollo, ['Which tests fail?', 5 * DAY]);
    const flaky = threadIn(inApollo, ['Which tests are flaky?', 4 * DAY]);
    seed(...tests, ...flaky);
    const store = await startStore();
    await store.openProject(apollo);
    await store.openThread(tests[0]!.id);
    await flush();
    const placing = held.hold('ask.run');
    void store.ask('how often do they fail?');
    await flush();
    store.widenScope();
    placing(elsewhere(asked()[0]!, [placeOf(asked()[0]!, 'Which tests are flaky?')]));
    await flush();
    expect(asked()).toHaveLength(1);
    expect([store.threadShown()?.id, store.getState().ask?.asking]).toEqual([tests[0]!.id, null]);
    expect([store.getState().barScope, store.getState().barText]).toEqual([GLOBAL, 'how often do they fail?']);
  });

  it('closes an Ask opened only for a question whose placing the widened bar abandoned, as a cancelled one closes', async () => {
    seed(...threadIn(inApollo, ['Which tests fail?', 5 * DAY]));
    const store = await startStore();
    await store.openProject(apollo);
    const placing = held.hold('ask.run');
    void store.ask('how often do they fail?');
    await flush();
    expect(store.getState().ask).toMatchObject({ forQuestion: true, thread: null });
    store.widenScope();
    placing(elsewhere(asked()[0]!, [0]));
    await flush();
    expect([store.getState().ask, asked().length, store.getState().barText]).toEqual([null, 1, 'how often do they fail?']);
  });

  it('offers no button for a thread "Which one?" named that is no longer a thread in the timeline read again, and picking it does nothing', async () => {
    const { billing, pilot } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'When does the pilot start?'), placeOf(params, 'Who owns billing?')]) : null);
    const store = await startStore();
    await store.ask('did that change?');
    await flush();
    expect(store.clarifyThreads().map(each => each.name)).toEqual(['When does the pilot start?', 'Who owns billing?']);
    // The file read again has billing's turns in the pilot's thread, as a file written elsewhere may: billing is no longer a thread.
    timelineFiles.set(fileOf(ACCOUNT), kept().map(each => (each.thread === billing[0]!.id ? { ...each, thread: pilot[0]!.id } : each)));
    await readAgain(store);
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
    await readAgain(store);
    expect(store.getState().ask?.thread).toEqual({ id: pilot[0]!.id, entered: false });
    expect(store.threadShown()).toBeUndefined();
    expect(store.askThread()).toEqual([]);
    expect(await questions(store)).toEqual([]);
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
    const store = await opened(legacy.id);
    await store.ask('who owns it?');
    await flush();
    for (const key of ['previous', 'threads']) expect(asked()[0]).not.toHaveProperty(key);
    expect(kept().at(-1)).toMatchObject({ text: 'who owns it?', thread: legacy.id });
    // Saved again for what the check found, the old turn is named with the thread it belonged to all along.
    expect(kept().find(each => each.id === legacy.id)).toMatchObject({ thread: legacy.id, unreadable: [0, 1] });
  });

  it('keeps a question that failed through a read of the timeline while the turn it continued is still in its thread, and lets it go with that turn', async () => {
    seeded();
    // The read signing in makes is slow to come back: a question is answered first, and a follow-up of it fails.
    const reading = held.hold('timeline.read');
    const store = await startStore();
    await store.ask('What is new this week?');
    await flush();
    const first = store.getState().timeline.turns.at(-1)!;
    const failing = held.hold('ask.run');
    void store.ask('and since when?');
    await flush();
    failing(fail('unavailable', { retryable: true }));
    await flush();
    expect(store.getState().ask?.failed).toMatchObject({ question: 'and since when?', thread: first.id });
    reading(ok({ turns: kept().filter(each => each.id !== first.id) }));
    await flush();
    // The turn it continued was kept meanwhile, and stays, in its thread: Try again asks it as it shows.
    expect(store.getState().timeline.turns).toHaveLength(6);
    expect(store.getState().ask?.failed).toMatchObject({ question: 'and since when?', thread: first.id });
    // Signed out, the turns are forgotten: the turn it continued is gone, and so is the question.
    await readAgain(store);
    expect(store.getState().ask?.failed).toBeNull();
  });

  it('keeps a first question that failed through a read of the timeline that came back after it: it continued nothing', async () => {
    seeded();
    // The read signing in makes is slow to come back.
    const reading = held.hold('timeline.read');
    const store = await startStore();
    const failing = held.hold('ask.run');
    void store.ask('What is new this week?');
    await flush();
    failing(fail('unavailable', { retryable: true }));
    await flush();
    expect(store.getState().ask?.failed).toMatchObject({ question: 'What is new this week?', thread: null });
    reading(ok({ turns: kept() }));
    await flush();
    expect(store.getState().timeline.turns).toHaveLength(5);
    expect(store.getState().ask?.failed).toMatchObject({ question: 'What is new this week?' });
    expect(byTestId(await page(store), 'ask-retry')).toHaveLength(1);
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

  it('passes over a stored label the person\'s words do not hold: never shown on a button or behind the door, never sent', async () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 3 * DAY]).map(each => ({ ...each, label: 'billing: owner' }));
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY], ['who owns it?', DAY]).map((each, at) => (at === 1 ? { ...each, label: 'pilot: budget' } : each));
    seed(...billing, ...pilot);
    script = params => (params.threads ? elsewhere(params, [0, 1]) : null);
    const store = await startStore();
    await store.ask('did that change?');
    await flush();
    expect(JSON.stringify(asked()[0])).not.toMatch(/budget|owner/u);
    expect(byTestId(await page(store), 'choice').map(text)).toEqual(['When does the pilot start?', 'Who owns billing?', 'New question']);
    expect(store.doorRows(store.getState(), '').map(row => row.label)).toEqual(['When does the pilot start?', 'Who owns billing?']);
    await store.chooseThread(pilot[0]!.id);
    await flush();
    expect(asked().at(-1)!.previous).not.toHaveProperty('label');
  });
});

describe('a joined thread never changes: a question for it starts a thread that continues it (R12, R13)', () => {
  const seeded = () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 9 * DAY], ['when is it due?', 8 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY], ['did that change?', DAY]);
    seed(...billing, ...pilot);
    return { billing, pilot };
  };
  type Seeded = ReturnType<typeof seeded>;

  it.each<[string, (store: Store, seeded: Seeded) => unknown, boolean]>([
    // [how the question gets there, what Ask shows the person, whether the line offers Undo: only when ECHO named the conversation (R15)]
    ['typed while the joined thread shows', async (store, { billing }) => { await store.openThread(billing[0]!.id); await flush(); await store.ask('who approves the invoices?'); }, false],
    ['placed there by ECHO, the one conversation named in the same home', async (store, { pilot }) => {
      script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Who owns billing?')]) : null);
      await store.openThread(pilot[0]!.id);
      await flush();
      await store.ask('who approves the invoices?');
    }, true],
    ['asked again from one of its turns', async (store, { billing }) => { await store.openThread(billing[0]!.id); await flush(); store.askAgain(billing[1]!.id); }, false],
  ])('lands a question %s in a new thread whose turn names the joined one in `continues`, and leaves every turn of the joined thread as it was', async (_how, step, undo) => {
    const threads = seeded();
    const store = await startStore();
    const joined = threads.billing[0]!.id;
    const before = kept().filter(each => each.thread === joined);
    await step(store, threads);
    await flush();
    const landed = kept().at(-1)!;
    expect(landed).toMatchObject({ thread: landed.id, continues: [joined], follows: threads.billing[1]!.id });
    expect(kept().filter(each => each.thread === joined)).toEqual(before);
    // Ask shows the new thread, one conversation with the joined one, which its line names and opens.
    expect(store.threadShown()?.id).toBe(landed.id);
    expect(store.chains().find(chain => chain.newest.id === landed.id)!.threads.map(thread => thread.id)).toEqual([joined, landed.id]);
    expect(store.continuesNote()).toMatchObject({ thread: joined, label: 'Who owns billing?', asked_at: threads.billing[1]!.asked_at });
    expect([store.continuesNote()!.undo, store.getState().ask?.placed != null]).toEqual([undo, undo]);
  });

  it('calls a joined thread none of whose turns kept the person\'s words "an earlier conversation" on the line, never by its first heading, which a model may have written (R2)', async () => {
    const { typed: _typed, follows: _follows, ...legacy } = turn('What are the details on THERM-490?', 9 * DAY);
    seed(legacy);
    const store = await opened(legacy.id);
    await store.ask('who owns it?');
    await flush();
    const landed = kept().at(-1)!;
    expect(landed).toMatchObject({ typed: 'who owns it?', thread: landed.id, continues: [legacy.id] });
    expect(store.continuesNote()).toMatchObject({ thread: legacy.id, label: 'an earlier conversation', undo: false });
    expect(JSON.stringify([store.continuesNote(), store.movedNote(), store.clarifyThreads()])).not.toMatch(/THERM-490/u);
    // Behind the door the conversation now goes by the words typed in it.
    expect(store.doorRows(store.getState(), '').map(row => row.label)).toEqual(['who owns it?']);
  });
});

describe('a conversation is one: one entry, one button, one way on (R14)', () => {
  /** The pilot's conversation, its first thread joined and its newest active, labelled; and billing's. */
  const seeded = () => {
    const start = threadIn(GLOBAL, ['When does the pilot start?', 10 * DAY], ['who owns it?', 10 * DAY - HOUR]);
    const delay = threadIn(GLOBAL, ['Is the pilot delayed?', 3 * DAY]).map(each => ({ ...each, continues: [start[0]!.id], label: 'pilot: start, owns, delayed' }));
    const billing = threadIn(GLOBAL, ['Who owns billing?', 2 * DAY]);
    seed(...start, ...delay, ...billing);
    return { start, delay, billing };
  };

  it('sends a conversation as one entry, its typed questions across its threads oldest first and one label; "Which one?" offers it once, and a pick carries its older turns', async () => {
    const { delay, billing } = seeded();
    script = params => (params.threads ? elsewhere(params, [0, 1]) : null);
    const store = await startStore();
    await store.ask('did the date move?');
    await flush();
    expect(asked()[0]!.threads).toEqual([
      { questions: ['Who owns billing?'], asked_at: billing[0]!.asked_at },
      { questions: ['When does the pilot start?', 'who owns it?', 'Is the pilot delayed?'], asked_at: delay[0]!.asked_at, label: 'pilot: start, owns, delayed' },
    ]);
    const clarify = byTestId(await page(store), 'clarify')[0]!;
    expect(text(clarify)).toContain('Which one do you mean?');
    expect(byTestId(clarify, 'choice').map(text)).toEqual(['Who owns billing?', 'pilot: start, owns, delayed', 'New question']);
    await store.chooseThread(delay[0]!.id);
    await flush();
    const previous = asked()[1]!.previous as AskPrevious;
    expect(previous).toMatchObject({ purpose: 'follow_up', question: 'Is the pilot delayed?', label: 'pilot: start, owns, delayed' });
    expect(previous.earlier!.map(each => each.question)).toEqual(['When does the pilot start?', 'who owns it?']);
    expect(kept().at(-1)).toMatchObject({ text: 'did the date move?', thread: delay[0]!.id });
    // The person picked it: no Undo.
    expect([store.getState().ask?.placed, store.movedNote()]).toEqual([null, null]);
  });

  it('offers a conversation once, as when two "Which one?" named have since become one', async () => {
    const { delay } = seeded();
    script = params => (params.threads ? elsewhere(params, [0, 1]) : null);
    const store = await startStore();
    await store.ask('did the date move?');
    await flush();
    expect(store.clarifyThreads()).toHaveLength(2);
    timelineFiles.set(fileOf(ACCOUNT), kept().map(each => (each.text === 'Who owns billing?' ? { ...each, continues: [delay[0]!.id] } : each)));
    await readAgain(store);
    expect(store.clarifyThreads().map(each => each.name)).toEqual(['pilot: start, owns, delayed']);
  });

  it.each([
    ['active: the question lands in it and Ask shows it', 3 * DAY],
    ['joined: the question starts a thread that continues it', 8 * DAY],
  ])('goes on from the conversation\'s newest thread when an older part of it shows, that thread %s; the older part never changes', async (_how, ago) => {
    const start = threadIn(GLOBAL, ['When does the pilot start?', 10 * DAY], ['who owns it?', 10 * DAY - HOUR]);
    const delay = threadIn(GLOBAL, ['Is the pilot delayed?', ago]).map(each => ({ ...each, continues: [start[0]!.id] }));
    seed(...start, ...delay);
    const store = await opened(start[0]!.id);
    expect(store.threadShown()?.id).toBe(start[0]!.id);
    await store.ask('did the date move?');
    await flush();
    const previous = asked().at(-1)!.previous as AskPrevious;
    expect(previous).toMatchObject({ purpose: 'follow_up', question: 'Is the pilot delayed?' });
    expect(previous.earlier!.map(each => each.question)).toEqual(['When does the pilot start?', 'who owns it?']);
    const landed = kept().at(-1)!;
    if (ago < 7 * DAY) {
      expect(landed).toMatchObject({ thread: delay[0]!.id, follows: delay[0]!.id });
      expect(landed).not.toHaveProperty('continues');
    } else expect(landed).toMatchObject({ thread: landed.id, follows: delay[0]!.id, continues: [delay[0]!.id] });
    expect(store.threadShown()?.id).toBe(landed.thread);
    expect(kept().filter(each => each.thread === start[0]!.id)).toEqual(start);
    // The person asked it in this conversation: wherever the rules land it, no line says ECHO moved it and nothing offers Undo.
    expect([store.getState().ask?.placed, store.movedNote(), store.continuesNote()?.undo ?? false]).toEqual([null, null, false]);
  });

  it('shows a question typed in an older part where it was typed until its answer lands: no line, no Undo, and Cancel leaves the page as it was', async () => {
    const start = threadIn(GLOBAL, ['When does the pilot start?', 10 * DAY], ['who owns it?', 10 * DAY - HOUR]);
    const delay = threadIn(GLOBAL, ['Is the pilot delayed?', 3 * DAY]).map(each => ({ ...each, continues: [start[0]!.id] }));
    seed(...start, ...delay);
    const store = await opened(start[0]!.id);
    const land = held.hold('ask.run');
    void store.ask('did the date move?');
    await flush();
    expect(store.getState().ask?.asking).toMatchObject({ thread: delay[0]!.id, continues: null, placed: false });
    expect([store.threadShown()?.id, store.movedNote(), store.continuesNote()]).toEqual([start[0]!.id, null, null]);
    store.cancelAsk();
    expect([store.threadShown()?.id, store.getState().ask?.asking]).toEqual([start[0]!.id, null]);
    land(answered(asked()[0]!));
    await flush();
    expect(kept()).toHaveLength(3);
  });

  it('names a conversation by words typed in an older part when its newest part kept none, and joins nothing through a turn a file keeps in a thread from another place', () => {
    const [billing] = threadIn(GLOBAL, ['Who owns billing?', 10 * DAY]);
    const { typed: _typed, follows: _follows, ...untyped } = turn('What are the details on THERM-490?', 3 * DAY, { continues: [billing!.id] });
    expect(chainsOf([billing!, untyped])).toMatchObject([{ id: untyped.id, own: 'Who owns billing?', label: 'Who owns billing?', questions: ['Who owns billing?'] }]);
    const [fail] = threadIn(inApollo, ['Which tests fail?', 5 * DAY]);
    const [flaky] = threadIn(inApollo, ['Which tests are flaky?', 4 * DAY]);
    const apart = (turns: TimelineTurn[]) => chainsOf(turns).map(chain => chain.threads.map(thread => thread.id));
    // A Home turn in the first Apollo thread names the second, with a label every word of which was typed in Apollo.
    const stray = turn('Asked at Home', DAY, { thread: fail!.id, continues: [flaky!.id], label: 'tests fail' });
    expect(apart([fail!, flaky!, stray])).toEqual([[fail!.id], [flaky!.id]]);
    expect(chainsOf([fail!, flaky!, stray])[0]).not.toHaveProperty('sent');
    // The same link and label on a turn asked in the thread's home join and label them.
    const own = turn('and the flaky ones?', DAY, { scope: inApollo, thread: fail!.id, continues: [flaky!.id], label: 'tests fail' });
    expect(apart([fail!, flaky!, own])).toEqual([[fail!.id, flaky!.id]]);
    expect(chainsOf([fail!, flaky!, own])[0]).toMatchObject({ sent: 'tests fail', own: 'tests fail' });
  });
});

describe('what ECHO just did with a question, and its Undo (R15)', () => {
  const seeded = () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 5 * DAY], ['when is it due?', 4 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY], ['did that change?', DAY]);
    seed(...billing, ...pilot);
    return { billing, pilot };
  };
  /** In the pilot's thread, a question ECHO moves to billing's active thread; its words asked there are held until `land`. */
  const moving = async () => {
    const threads = seeded();
    const store = await opened(threads.pilot[0]!.id);
    const first = held.hold('ask.run');
    void store.ask('who approves the invoices?');
    await flush();
    const land = held.hold('ask.run');
    first(elsewhere(asked()[0]!, [placeOf(asked()[0]!, 'Who owns billing?')]));
    await flush();
    return { store, ...threads, land: async () => { land(answered(asked().at(-1)!)); await flush(); } };
  };
  /** The page's elements with these test ids, in order. */
  const shown = async (store: Store, ...testids: string[]) => elements(await page(store)).filter(node => testids.includes(String(node.props['data-testid'])));

  it('says "Continuing (label) · Undo" just above a question ECHO moved to another active thread, on its way and once landed; never for one that lands where the person was looking', async () => {
    const { store, billing, land } = await moving();
    expect(store.threadShown()?.id).toBe(billing[0]!.id);
    expect(store.movedNote()).toEqual({ label: 'Who owns billing?', turn: null });
    expect((await shown(store, 'moved-note')).map(text)).toEqual(['Continuing Who owns billing?·Undo']);
    await land();
    const landed = kept().at(-1)!;
    expect(landed).toMatchObject({ text: 'who approves the invoices?', thread: billing[0]!.id });
    expect(store.movedNote()).toEqual({ label: 'Who owns billing?', turn: landed.id });
    expect((await shown(store, 'moved-note', 'turn')).map(node => (node.props['data-testid'] === 'turn' ? node.props['data-turn'] : 'note')))
      .toEqual([billing[1]!.id, 'note', landed.id]);
    await store.ask('and who signs them?');
    await flush();
    expect(kept().at(-1)).toMatchObject({ thread: billing[0]!.id });
    expect(store.movedNote()).toBeNull();
    expect(await shown(store, 'moved-note', 'placed-undo')).toEqual([]);
  });

  it('says "Continues (label) from (date)" on a thread with an older part, its label opening that part, and offers Undo on it only right after ECHO started it', async () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 9 * DAY], ['when is it due?', 8 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(...billing, ...pilot);
    const store = await opened(pilot[0]!.id);
    const first = held.hold('ask.run');
    void store.ask('who approves the invoices?');
    await flush();
    const land = held.hold('ask.run');
    first(elsewhere(asked()[0]!, [placeOf(asked()[0]!, 'Who owns billing?')]));
    await flush();
    // On its way it shows alone, under the line.
    expect(store.threadShown()).toBeUndefined();
    const line = { thread: billing[0]!.id, label: 'Who owns billing?', asked_at: billing[1]!.asked_at };
    expect(store.continuesNote()).toEqual({ ...line, undo: true });
    expect((await shown(store, 'continues-note')).map(text)).toEqual([`ContinuesWho owns billing?from ${askedWhen(billing[1]!.asked_at)}·Undo`]);
    land(answered(asked().at(-1)!));
    await flush();
    expect(store.continuesNote()).toEqual({ ...line, undo: true });
    // The next question: the line stays, its Undo goes; so too when the thread is opened again.
    await store.ask('and who signs them?');
    await flush();
    expect(store.continuesNote()).toEqual({ ...line, undo: false });
    expect(await shown(store, 'placed-undo')).toEqual([]);
    const started = kept().at(-1)!.thread!;
    store.closeAsk();
    await store.openThread(started);
    await flush();
    expect(store.continuesNote()).toEqual({ ...line, undo: false });
    click((await shown(store, 'continues-open'))[0]);
    await flush();
    expect(store.threadShown()?.id).toBe(billing[0]!.id);
    expect(store.continuesNote()).toBeNull();
  });

  it('stops a question still on its way on Undo, as Cancel does, and asks the same words as a new question with nothing carried', async () => {
    const { store, land } = await moving();
    const before = kept().length;
    await store.undoPlaced();
    await flush();
    expect(calls('ask.cancel')).toHaveLength(1);
    const again = asked().at(-1)!;
    expect(again).toMatchObject({ question: 'who approves the invoices?', scope: GLOBAL });
    for (const key of ['previous', 'threads']) expect(again).not.toHaveProperty(key);
    const saved = kept().at(-1)!;
    expect(kept()).toHaveLength(before + 1);
    expect(saved).toMatchObject({ text: 'who approves the invoices?', thread: saved.id, follows: null });
    expect(saved).not.toHaveProperty('continues');
    expect(store.threadShown()?.id).toBe(saved.id);
    expect(store.getState().ask?.placed).toBeNull();
    // The stopped question's own answer is dropped.
    await land();
    expect(kept()).toHaveLength(before + 1);
  });

  it('takes a landed turn back on Undo through the file, off the page only once the file says so, then asks the same words as a new question; nothing else starts meanwhile', async () => {
    const { store, billing, pilot, land } = await moving();
    await land();
    const landed = kept().at(-1)!;
    const open = gated();
    const undoing = store.undoPlaced();
    await flush();
    expect(calls('timeline.remove')).toEqual([expect.objectContaining({ turn: landed.id })]);
    expect(store.getState().timeline.turns.map(each => each.id)).toContain(landed.id);
    expect(store.askBusy()).toBe(true);
    expect((await shown(store, 'placed-undo')).map(button => button.props.disabled)).toEqual([true]);
    // Nothing else can be asked: no question, jump, door or new chat.
    const sent = asked().length;
    await store.ask('Something else?');
    expect(await store.openThread(pilot[0]!.id)).toBe(false);
    store.openDoor();
    store.newQuestion();
    expect(asked()).toHaveLength(sent);
    expect(store.getState().ask).toMatchObject({ door: false, fresh: false, thread: { id: billing[0]!.id } });
    open();
    await undoing;
    await flush();
    expect(store.getState().timeline.turns.map(each => each.id)).not.toContain(landed.id);
    expect(kept().map(each => each.id)).not.toContain(landed.id);
    const again = asked().at(-1)!;
    expect(again).toMatchObject({ question: 'who approves the invoices?' });
    for (const key of ['previous', 'threads']) expect(again).not.toHaveProperty(key);
    expect(store.threadShown()).toMatchObject({ name: 'who approves the invoices?' });
    expect(store.getState().ask?.placed).toBeNull();
  });

  it.each<[string, (landed: TimelineTurn) => void, 'UNDO_REFUSED' | 'UNDO_UNCONFIRMED', boolean]>([
    // [why nothing is removed, what came meanwhile, what the page says, whether the same Undo is still offered]
    ['the file has a newer turn in its thread', landed => { seed(...kept(), turn('and later?', 0, { thread: landed.thread!, follows: null })); }, 'UNDO_REFUSED', false],
    ...(['follows', 'again_of', 'carried', 'continues'] as const).map((field): [string, (landed: TimelineTurn) => void, 'UNDO_REFUSED', boolean] => [`a kept turn names it in ${field}`,
      landed => { seed(...kept(), turn('Elsewhere?', 0, { [field]: field === 'carried' || field === 'continues' ? [landed.id] : landed.id })); }, 'UNDO_REFUSED', false]),
    ['it is 7 days old', landed => { vi.setSystemTime(Date.parse(landed.asked_at) + THREAD_ACTIVE_MS); }, 'UNDO_REFUSED', false],
    ['the file cannot be read, so the host fails it', () => { removeEnds = 'failed'; }, 'UNDO_REFUSED', true],
    ['no host takes it', () => { removeEnds = 'unsent'; }, 'UNDO_REFUSED', true],
    ['no reply comes in time', () => { removeEnds = 'timeout'; }, 'UNDO_UNCONFIRMED', false],
    ['the file takes it and its reply is lost', () => { removeEnds = 'lost'; }, 'UNDO_UNCONFIRMED', false],
  ])('leaves the turn on the page and asks nothing when %s, and says so as a warning', async (_why, meanwhile, toast, offered) => {
    const { store, land } = await moving();
    await land();
    const landed = kept().at(-1)!;
    meanwhile(landed);
    const placed = store.getState().ask!.placed;
    await store.undoPlaced();
    await flush();
    const { WARNINGS, ...said } = await words();
    expect(store.getState().toast).toBe(said[toast]);
    expect(WARNINGS.has(store.getState().toast!)).toBe(true);
    expect(store.getState().timeline.turns.map(each => each.id)).toContain(landed.id);
    expect(store.getState().ask?.placed).toBe(offered ? placed : null);
    expect([asked().length, store.askBusy()]).toEqual([2, false]);
  });

  it.each<[string, (store: Store, pilot: string) => unknown]>([
    ['the next question', store => store.ask('and who signs them?')],
    ['a jump', (store, pilot) => store.openThread(pilot)],
    ['Ask closing', store => store.closeAsk()],
    ['the timeline read again', store => readAgain(store)],
  ])('drops the Undo offer at %s: Undo then takes nothing back', async (_when, step) => {
    const { store, pilot, land } = await moving();
    await land();
    expect(store.getState().ask?.placed).not.toBeNull();
    await step(store, pilot[0]!.id);
    await flush();
    expect(store.getState().ask?.placed ?? null).toBeNull();
    expect(store.movedNote()).toBeNull();
    await store.undoPlaced();
    expect(calls('timeline.remove')).toEqual([]);
  });

  it('keeps the line and its Undo through Try again on a question ECHO placed that failed there', async () => {
    const { billing, pilot } = seeded();
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Who owns billing?')]) : fail('timeout', { retryable: true }));
    const store = await opened(pilot[0]!.id);
    await store.ask('who approves the invoices?');
    await flush();
    expect(store.getState().ask?.failed).toMatchObject({ question: 'who approves the invoices?', thread: billing[0]!.id, echo: { shown: pilot[0]!.id } });
    script = null;
    store.retryAsk();
    await flush();
    const landed = kept().at(-1)!;
    expect(landed).toMatchObject({ text: 'who approves the invoices?', thread: billing[0]!.id });
    expect(store.movedNote()).toEqual({ label: 'Who owns billing?', turn: landed.id });
    expect(store.getState().ask?.placed).toMatchObject({ kind: 'moved', turn: landed.id, words: 'who approves the invoices?' });
  });

  it('never brings a turn back once Undo took it: a check that finds one of its sources unreadable while the removal waits changes the turn only in its place', async () => {
    const { store, land } = await moving();
    await land();
    const landed = kept().at(-1)!;
    const check = held.hold('ask.check');
    store.toggleTurn(landed.id);
    await flush();
    const open = gated();
    const undoing = store.undoPlaced();
    await flush();
    // The file has taken the turn out and its reply waits: the check comes back meanwhile.
    expect(kept().map(each => each.id)).not.toContain(landed.id);
    check(ok({ items: [{ state: 'unreadable' }, { state: 'same' }] }));
    await flush();
    expect(calls('timeline.put').at(-1)).toMatchObject({ turn: { id: landed.id, unreadable: [0] }, known: true });
    expect(kept().map(each => each.id)).not.toContain(landed.id);
    open();
    await undoing;
    await flush();
    expect(store.getState().timeline.turns.map(each => each.id)).not.toContain(landed.id);
    expect(kept().map(each => each.id)).not.toContain(landed.id);
    // The first save of a turn carries no such mark: it is kept at the end.
    expect(calls('timeline.put').at(-1)).not.toHaveProperty('known');
    expect(kept().at(-1)).toMatchObject({ text: 'who approves the invoices?', follows: null });
  });

  it('decides active or joined by when the person asked, however long placing the question took (R11): asked a second before the week is up, it lands in that thread, asked then', async () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 7 * DAY - 1000]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(...billing, ...pilot);
    const store = await opened(pilot[0]!.id);
    const first = held.hold('ask.run');
    void store.ask('who approves the invoices?');
    await flush();
    vi.setSystemTime(NOW.getTime() + 2000);
    first(elsewhere(asked()[0]!, [placeOf(asked()[0]!, 'Who owns billing?')]));
    await flush();
    const landed = kept().at(-1)!;
    expect(landed).toMatchObject({ text: 'who approves the invoices?', thread: billing[0]!.id, asked_at: NOW.toISOString() });
    expect(landed).not.toHaveProperty('continues');
  });

  it('offers no Undo for a question ECHO started as a new subject', async () => {
    const { pilot } = seeded();
    script = params => (params.threads ? answered(params, { thread: { kind: 'new' } }) : null);
    const store = await opened(pilot[0]!.id);
    await store.ask('What is for lunch?');
    await flush();
    const saved = kept().at(-1)!;
    expect(saved).toMatchObject({ thread: saved.id });
    expect(saved).not.toHaveProperty('continues');
    expect([store.getState().ask?.placed, store.movedNote(), store.continuesNote()]).toEqual([null, null, null]);
    expect(await shown(store, 'placed-undo')).toEqual([]);
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
    expect(calls('timeline.put').slice(puts).map(put => (put.turn as TimelineTurn).id)).toEqual([landed.id]);
    expect(kept().slice(0, -1)).toEqual(before);
    expect(apart(store)).toEqual([[billing[0]!.id, pilot[0]!.id], [ledger[0]!.id], [tests[0]!.id]]);
    // Billing's was last asked in before the pilot's thread started: a link still adds no line, and offers no Undo.
    expect([store.movedNote(), store.continuesNote(), store.getState().ask?.placed]).toEqual([null, null, null]);
  });

  it('links beside a single other placement too, and undoing that placement takes the turn and its link with it', async () => {
    const { billing, ledger, tests, pilot } = seeded();
    script = params => (params.threads
      ? elsewhere(params, [placeOf(params, 'Who owns billing?')], { merge: [placeOf(params, 'Where is the ledger?'), placeOf(params, 'Which tests fail?')] }) : null);
    const store = await opened(pilot[0]!.id);
    await store.ask('who approves the invoices?');
    await flush();
    const landed = kept().at(-1)!;
    expect(landed).toMatchObject({ thread: billing[0]!.id, continues: [ledger[0]!.id] });
    expect(apart(store)).toEqual([[billing[0]!.id, ledger[0]!.id], [tests[0]!.id], [pilot[0]!.id]]);
    await store.undoPlaced();
    await flush();
    expect(kept().map(each => each.id)).not.toContain(landed.id);
    expect(apart(store).slice(0, 4)).toEqual([[billing[0]!.id], [ledger[0]!.id], [tests[0]!.id], [pilot[0]!.id]]);
  });
});

describe('what ECHO decided for a question stays decided through "Which one?" between things', () => {
  it('lands the choice asked in the follow-up\'s place with the link ECHO named, and with the Undo of its placement', async () => {
    const billing = threadIn(GLOBAL, ['Who owns billing?', 5 * DAY], ['when is it due?', 4 * DAY]);
    const ledger = threadIn(GLOBAL, ['Where is the ledger?', 3 * DAY]);
    const pilot = threadIn(GLOBAL, ['When does the pilot start?', 2 * DAY]);
    seed(...billing, ...ledger, ...pilot);
    const choices = [{ label: 'March', question: 'Who approves the March invoices?' }, { label: 'April', question: 'Who approves the April invoices?' }];
    script = params => (params.threads ? elsewhere(params, [placeOf(params, 'Who owns billing?')], { merge: [placeOf(params, 'Where is the ledger?')] })
      : params.question === 'who approves the invoices?'
        ? ok({ scope: GLOBAL, sources: [], parts: [], outcome: 'clarify', receipt: { looked_through: 0 }, question: 'who approves the invoices?', choices }) : null);
    const store = await opened(pilot[0]!.id);
    await store.ask('who approves the invoices?');
    await flush();
    expect(store.getState().ask?.clarify).toMatchObject({ kind: 'choices', thread: billing[0]!.id, links: [ledger[0]!.id], echo: { shown: pilot[0]!.id } });
    store.chooseClarified(choices[0]!);
    await flush();
    const landed = kept().at(-1)!;
    expect(landed).toMatchObject({ text: 'Who approves the March invoices?', typed: 'who approves the invoices?', thread: billing[0]!.id, continues: [ledger[0]!.id] });
    expect(store.chains().map(chain => chain.threads.map(thread => thread.id))).toEqual([[billing[0]!.id, ledger[0]!.id], [pilot[0]!.id]]);
    expect(store.movedNote()).toEqual({ label: 'Who owns billing?', turn: landed.id });
    expect(store.getState().ask?.placed).toMatchObject({ kind: 'moved', turn: landed.id, words: 'who approves the invoices?' });
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

  it('"New question" shows an empty chat and asks the next question with neither an earlier turn nor the conversations; asking, a pick and Ask closing each clear it', async () => {
    const { pilot } = seeded();
    const store = await opened(pilot[0]!.id);
    store.openDoor();
    click(byTestId(await door(store), 'door-new')[0]);
    expect(store.getState().ask).toMatchObject({ fresh: true, door: false, thread: null });
    expect([await questions(store), byTestId(await page(store), 'timeline-row')]).toEqual([[], []]);
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
