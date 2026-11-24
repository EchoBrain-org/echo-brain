// The Ask timeline (ADR-0047), as rules the store and the page share: which
// turns show in full, which sentences a check of their sources leaves out,
// the earlier turn a follow-up or Ask again carries, what the empty bar
// suggests from it, and the threads its turns make (ADR-0056): which thread a
// turn belongs to, a thread's home and name, and what an Ask carries of them.
// Pure, for the store and its tests; the store keeps the state and makes the
// calls.
import type {
  Answer, AnswerSource, AnswerStatement, AskCheckItem, AskCheckResult, AskCheckState, AskPrevious, AskScope, AskThread, CheckCitation, TimelineTurn,
} from '../shared/protocol.js';
import { checkOf, MAX_REQUEST_BYTES } from '../shared/protocol.js';
import { askText } from '../shared/query.js';
import { answerSentences, sourceGroups, type Sentence, type Shows, type SourceGroup } from './answer.js';

/** A check is good for five minutes: opening a thread then checks every turn of it again. */
export const CHECK_FRESH_MS = 5 * 60_000;

/** What a check said of one turn's sources, by their place among its answer's sources. */
export type TurnChecks = Readonly<Record<number, AskCheckState>>;

/** What a check said of one turn's sources, and when it went, by this computer's clock. */
export interface TurnCheck {
  readonly at: number;
  readonly states: TurnChecks;
}

/** What a check said of a turn's sources while it is good: five minutes from when it went, and nothing after (C5). */
export function freshStates(check: TurnCheck | undefined, now: number): TurnChecks | undefined {
  return check !== undefined && now - check.at < CHECK_FRESH_MS ? check.states : undefined;
}

/**
 * What is known of a turn's sources for what the page shows and a follow-up carries: what a check said in the last five
 * minutes, over the sources a check found unreadable (`turn.unreadable`). Those stay unreadable, however long ago that
 * check was, until one finds them readable again (C5): a check going stale never shows what it hid.
 */
export function knownStates(fresh: TurnChecks | undefined, unreadable: readonly number[] | undefined): TurnChecks | undefined {
  if (unreadable === undefined || unreadable.length === 0) return fresh;
  const known: Record<number, AskCheckState> = { ...fresh };
  for (const at of unreadable) if (known[at] !== 'same') known[at] = 'unreadable';
  return known;
}

/**
 * The sources a turn keeps as unreadable after a check that said `states` of
 * them: those it found unreadable join, those it found readable leave, and
 * those it could not tell of stay as they were.
 */
export function unreadableAfter(kept: readonly number[] | undefined, states: TurnChecks): number[] {
  const next = new Set(kept ?? []);
  for (const [at, said] of Object.entries(states)) {
    if (said === 'unreadable') next.add(Number(at));
    else if (said === 'same') next.delete(Number(at));
  }
  return [...next].sort((left, right) => left - right);
}

/**
 * What a check that did not finish keeps of what its requests that came back
 * said of a turn's sources: those they found unreadable, which stay hidden.
 * It speaks for no turn, so nothing it found readable counts.
 */
export function foundUnreadable(states: TurnChecks): TurnChecks {
  return Object.fromEntries(Object.entries(states).filter(([, said]) => said === 'unreadable'));
}

/**
 * The checks still good after one that did not finish: each as it was, but
 * taking what that check found unreadable (`hidden`, by turn), so an earlier
 * check that found a source readable never shows what this one hid.
 */
export function checksHiding(checks: Readonly<Record<string, TurnCheck>>, hidden: Readonly<Record<string, TurnChecks>>): Record<string, TurnCheck> {
  return Object.fromEntries(Object.entries(checks).map(([id, check]) => [id, hidden[id] === undefined ? check : { ...check, states: { ...check.states, ...hidden[id] } }]));
}

/** The checks still good at `now`: one five minutes old goes, so nothing it said shows any more. */
export function freshChecks(checks: Readonly<Record<string, TurnCheck>>, now: number): Record<string, TurnCheck> {
  return Object.fromEntries(Object.entries(checks).filter(([, check]) => freshStates(check, now) !== undefined));
}

/**
 * One check: the requests it takes, each with its items and, for each, the
 * turn whose sources it stands for and their places there; and the turns it
 * speaks for, every one: it asks about all of each turn's sources, and a turn
 * citing nothing a check asks about is spoken for without asking.
 */
export interface CheckPlan {
  readonly requests: readonly {
    readonly items: readonly AskCheckItem[];
    readonly places: readonly { readonly turn: string; readonly sources: readonly number[] }[];
  }[];
  readonly turns: readonly string[];
}

/** The answer's sources a check can ask about, numbered as the page numbers them, each with what a check asks of it. */
function checkable(turn: TimelineTurn): { at: number; citation: CheckCitation }[] {
  return turn.answer.sources.flatMap((source, at) => {
    const citation = checkOf(source);
    return citation === undefined ? [] : [{ at, citation }];
  });
}

/**
 * One check of `turns` (the one most wanted first: the newest, or the turn
 * opened): each turn's checkable sources, the same citation once per turn,
 * with when the turn was asked, the first turns' first, in as many requests
 * as they take, each at most 100 items within the route's 64 KiB. Every
 * source is asked about, so a check never speaks for part of a turn: an
 * answer can cite more sources than one request takes (ADR-0051).
 */
export function checkPlan(turns: readonly TimelineTurn[]): CheckPlan {
  const requests: { items: AskCheckItem[]; places: { turn: string; sources: number[] }[] }[] = [];
  // What the last request holds: its envelope, and a comma between items.
  let bytes = 0;
  for (const turn of turns) {
    const seen = new Map<string, number[]>();
    for (const { at, citation } of checkable(turn)) {
      const key = JSON.stringify(citation);
      const same = seen.get(key);
      if (same !== undefined) { same.push(at); continue; }
      const item: AskCheckItem = { asked_at: turn.asked_at, citation };
      const size = new TextEncoder().encode(JSON.stringify(item)).length + 1;
      const last = requests.at(-1);
      if (last === undefined || bytes + size > MAX_REQUEST_BYTES - 1024) {
        requests.push({ items: [], places: [] });
        bytes = 96;
      }
      bytes += size;
      const sources = [at];
      seen.set(key, sources);
      requests.at(-1)!.items.push(item);
      requests.at(-1)!.places.push({ turn: turn.id, sources });
    }
  }
  return { requests, turns: turns.map(turn => turn.id) };
}

/**
 * What a check's results, one list for each of its requests, say of each
 * turn it speaks for (nothing of one that cites nothing a check asks about).
 */
export function checkedOf(plan: CheckPlan, results: readonly (readonly AskCheckResult[])[]): Record<string, TurnChecks> {
  const turns: Record<string, Record<number, AskCheckState>> = Object.fromEntries(plan.turns.map(id => [id, {}]));
  plan.requests.forEach((request, asked) => request.places.forEach(({ turn, sources }, index) => {
    const result = results[asked]?.[index];
    if (!result) return;
    const states = turns[turn] ??= {};
    for (const at of sources) states[at] = result.state;
  }));
  return turns;
}

/** Which sentences and rows of a turn the page shows after a check: all but those citing a source you can no longer read. */
export function showsOf(checks: TurnChecks | undefined): Shows {
  return citations => !citations.some(at => checks?.[at] === 'unreadable');
}

/**
 * A turn's answer's sources as its page numbers them, one per place, without
 * a place every citation of which a check found you can no longer read, as
 * the sentences citing it are left out. Each keeps its citations' places
 * among the answer's sources.
 */
export function turnGroups(answer: Pick<Answer, 'sources'>, checks: TurnChecks | undefined): SourceGroup[] {
  const groups = sourceGroups(answer.sources);
  return checks === undefined ? groups : groups.filter(group => !group.indexes.every(at => checks[at] === 'unreadable'));
}

/** The turns a later turn asked again, by id: a thread folds them away (visibleTurns). */
function askedAgain(turns: readonly TimelineTurn[]): ReadonlySet<string> {
  return new Set(turns.flatMap(turn => (turn.again_of === undefined ? [] : [turn.again_of])));
}

/** Every sentence a turn shows: its answer's, and Ask again's "since" list. */
function sentences(turn: TimelineTurn): Sentence[] {
  return [...answerSentences(turn.answer).map(([, statement]) => statement), ...(turn.since ?? [])];
}

/** Whether every sentence of a turn is left out: then an opened turn shows only Ask again. */
export function allOmitted(turn: TimelineTurn, checks: TurnChecks | undefined): boolean {
  if (checks === undefined) return false;
  const all = sentences(turn);
  const shows = showsOf(checks);
  return all.length > 0 && all.every(statement => !shows(statement.citation_indexes));
}

/**
 * Whether a turn shows in full: the latest, and `full`, the turns Ask shows
 * in full since it opened (the latest then, which a follow-up continues, and
 * every turn asked since). Every other turn folds.
 */
export function shownInFull(turn: TimelineTurn, turns: readonly TimelineTurn[], full: readonly string[]): boolean {
  return turns.at(-1)?.id === turn.id || full.includes(turn.id);
}

/** How many earlier questions Ask shows as lines before the older ones go behind one line. */
const EARLIER_SHOWN = 3;

/**
 * The earlier questions behind Ask's one "N earlier questions" line: every
 * turn shown as a line but the newest three, oldest first.
 */
export function behindEarlierLine(turns: readonly TimelineTurn[], full: readonly string[]): string[] {
  const folded = turns.filter(turn => !shownInFull(turn, turns, full));
  return folded.slice(0, Math.max(0, folded.length - EARLIER_SHOWN)).map(turn => turn.id);
}

/**
 * The turn a follow-up continues: the turn opened (from its line, or chosen from the bar's suggestions, the latest included),
 * or else the latest, however long ago it was asked. A question typed with Ask open is a follow-up because the person asks it there.
 */
export function followedTurn(turns: readonly TimelineTurn[], opened: string | null): TimelineTurn | null {
  const open = opened === null ? undefined : turns.find(turn => turn.id === opened);
  return open ?? turns.at(-1) ?? null;
}

/** What a value takes as JSON, in bytes. */
const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** An Ask request's body as the client sends it (`PersonAnswerRequestV3`), for its bytes. */
function bodyBytes(question: string, scope: AskScope, previous: AskPrevious | null): number {
  return jsonBytes({ schema_version: 3, question, ...(scope.kind === 'project' ? { project_id: scope.project_id } : {}), ...(previous === null ? {} : { previous }) });
}

/** The most an Ask's body may take: a little short of the bound, for how the client writes the same body. */
const BODY_ROOM = MAX_REQUEST_BYTES - 256;

/** Whether `known` finds the turn's source at `at` readable: one there, of a kind a check reads, found `same`. */
function sourceReadable(turn: TimelineTurn, known: TurnChecks | null | undefined, at: number): boolean {
  const source = turn.answer.sources[at];
  return source !== undefined && checkOf(source) !== undefined && known?.[at] === 'same';
}

/** Whether `known` finds the turn with at least one source, every one readable. */
export function turnReadable(turn: TimelineTurn, known: TurnChecks | undefined): boolean {
  return turn.answer.sources.length > 0 && turn.answer.sources.every((_, at) => sourceReadable(turn, known, at));
}

/**
 * The earlier turn an Ask carries (C3): its full question and when it was
 * asked; its sentences you can still read, in the order the answer says
 * them, each whole, with the citations they cite, as the answer's response
 * carried them, renumbered in the order first cited. A sentence goes only
 * when `known` (what a check found) has every source it cites readable
 * (sourceReadable); with nothing known (null), none goes, only the question
 * (C5): `previous` is read by the Authority's model, and a source this person
 * may no longer read must not reach it. `earlier` is the earlier question it
 * names: the turn's own unless the caller says which (questionOf). A turn an
 * older desktop saved (no `citations_complete`) carries its question only: a
 * sentence of it may rest on a row it no longer cites. Sentences go from the
 * end until the request, asking `question` in `scope`, fits the Ask body's
 * bound.
 */
export function previousOf(turn: TimelineTurn, purpose: AskPrevious['purpose'], known: TurnChecks | null, question: string, scope: AskScope,
  earlier: string = askText(turn.question)): AskPrevious {
  const chosen = readableStatements(turn, known);
  let previous: AskPrevious = { purpose, ...carried(turn, earlier, chosen) };
  while (chosen.length > 0 && bodyBytes(question, scope, previous) > BODY_ROOM) {
    chosen.pop();
    previous = { purpose, ...carried(turn, earlier, chosen) };
  }
  return previous;
}

/**
 * The sentences of a turn an Ask may carry, in the order the answer says them: those every source of which `known`
 * (what a check found) has readable. None with nothing known (null), and none of a turn an older desktop saved (no
 * `citations_complete`).
 */
function readableStatements(turn: TimelineTurn, known: TurnChecks | null): AnswerStatement[] {
  return known === null || turn.citations_complete !== true ? [] : [turn.answer.direct, ...turn.answer.parts.flatMap(part => [...part.statements, ...(part.records ?? [])])]
    .filter((statement): statement is AnswerStatement => statement !== undefined && statement.text.trim() !== ''
      && statement.citation_indexes.every(at => sourceReadable(turn, known, at)));
}

/** A turn as an Ask carries it, the previous turn or an older one of its thread alike: `question`, when it was asked, and `chosen`, its sentences that go, with the citations they cite. */
function carried(turn: TimelineTurn, question: string, chosen: readonly AnswerStatement[]): AskEarlierTurn {
  const sources = turn.answer.sources;
  // Each citation once, by what it names (an answer may cite the same item at two places), and each sentence citing it once.
  const keys: string[] = [];
  const citations: NonNullable<AnswerSource['cited']>[] = [];
  const statements = chosen.map(statement => {
    const places: number[] = [];
    for (const at of statement.citation_indexes) {
      const cited = sources[at]?.cited;
      if (cited === undefined) continue;
      const key = JSON.stringify(cited);
      if (!keys.includes(key)) { keys.push(key); citations.push(cited); }
      const place = keys.indexOf(key);
      if (!places.includes(place)) places.push(place);
    }
    // Trimmed and NFC, as C3 takes a sentence.
    return { text: statement.text.trim().normalize('NFC'), citation_indexes: places };
  });
  return { question, asked_at: turn.asked_at, statements, citations };
}

/** A suggestion of the empty bar: a question, and the turn it reopens when it is one you asked. */
export interface Suggestion {
  readonly question: string;
  readonly turn?: string;
}

/** Two scopes are one: the same kind, and for a project the same one. */
export function sameScope(a: AskScope, b: AskScope): boolean {
  return a.kind === b.kind && (a.kind !== 'project' || (b.kind === 'project' && a.project_id === b.project_id));
}

/** The turns asked in a place, as its bar suggests them: Home's, all context, are every turn; a project's only those asked in it. */
export function askedIn(turns: readonly TimelineTurn[], scope: AskScope): readonly TimelineTurn[] {
  return scope.kind === 'project' ? turns.filter(turn => sameScope(turn.scope, scope)) : turns;
}

/** A question as two turns compare it: where it was asked, and its words in any case and spacing. */
function questionKey(turn: TimelineTurn): string {
  const where = turn.scope.kind === 'project' ? `project:${turn.scope.project_id}` : 'home';
  return `${where}\n${turn.question.trim().replace(/\s+/gu, ' ').toLowerCase()}`;
}

/**
 * The turns a thread shows (ADR-0049): each question once. A turn a later one
 * asked again, or whose question a later turn asked in the same place repeats,
 * folds away, and the newest stands for it. The timeline keeps them all.
 */
export function visibleTurns(turns: readonly TimelineTurn[]): TimelineTurn[] {
  const again = askedAgain(turns);
  const later = new Set<string>();
  const shown: TimelineTurn[] = [];
  for (const turn of [...turns].reverse()) {
    const key = questionKey(turn);
    if (again.has(turn.id) || later.has(key)) continue;
    later.add(key);
    shown.push(turn);
  }
  return shown.reverse();
}

/**
 * The questions asked in `scope`, newest first, each reopening its turn in
 * its thread: never one folded away. The bar's suggestions take each once,
 * the newest.
 */
export function askedSuggestions(turns: readonly TimelineTurn[], scope: AskScope): Suggestion[] {
  return visibleTurns(askedIn(turns, scope)).reverse().map(turn => ({ question: turn.question, turn: turn.id }));
}

// ---- threads (ADR-0056) -----------------------------------------------------------

/** An older turn of the thread a follow-up continues, as `previous.earlier` carries it. */
export type AskEarlierTurn = NonNullable<AskPrevious['earlier']>[number];

/**
 * What the person typed for a turn, when the turn knows it (R2): its `typed` words, or its `text` when it is known to
 * have followed nothing. Never a question a model wrote: a follow-up's full question, a choice of "Which one?", or the
 * question an Ask again or Ask everywhere asked. A turn saved before `typed` and `follows` were kept says neither, and
 * its `text` may be such a question (a choice was saved as one), so it has none.
 */
export function ownWords(turn: TimelineTurn): string | undefined {
  if (turn.typed !== undefined) return turn.typed;
  return turn.follows === null && turn.again_of === undefined ? turn.text : undefined;
}

/** A turn's own words as an Ask sends them (askText), or undefined with none to send. */
function sentWords(turn: TimelineTurn): string | undefined {
  const words = askText(ownWords(turn) ?? '');
  return words === '' ? undefined : words;
}

/**
 * The thread each turn belongs to, by turn id (R8). A turn names its thread by the id of the thread's first turn. One
 * saved before threads names none: it belongs to the thread of the turn it followed, or asked again, while that turn is
 * still kept and was asked in the same place, and otherwise starts its own.
 */
export function threadIds(turns: readonly TimelineTurn[]): ReadonlyMap<string, string> {
  const byId = new Map(turns.map(turn => [turn.id, turn]));
  const ids = new Map<string, string>();
  const idOf = (turn: TimelineTurn, walked: ReadonlySet<string>): string => {
    const known = ids.get(turn.id);
    if (known !== undefined) return known;
    const earlier = turn.thread === undefined ? byId.get(turn.follows ?? turn.again_of ?? '') : undefined;
    // A chain that comes back to itself ends where it does.
    const id = turn.thread ?? (earlier !== undefined && !walked.has(earlier.id) && sameScope(earlier.scope, turn.scope)
      ? idOf(earlier, new Set([...walked, turn.id])) : turn.id);
    ids.set(turn.id, id);
    return id;
  };
  for (const turn of turns) idOf(turn, new Set());
  return ids;
}

/** One thread (ADR-0056): the turns that share its id. */
export interface Thread {
  /** The id of its first turn. */
  readonly id: string;
  /** Its turns, oldest first, as the timeline keeps them. */
  readonly turns: readonly TimelineTurn[];
  /**
   * Where it lives, one project or none: the scope of its first turn, or of its oldest once that one is gone. Every turn
   * of a thread was asked there (R9): a thread is asked in only in its home's scope, and no merge crosses homes.
   */
  readonly home: AskScope;
  /**
   * What the page calls it: the question typed for its first turn (R2), which a merge does not change, or else the first
   * typed in it. A thread none of whose turns kept the person's words (all saved before they were) is called by its
   * first turn's heading, as its page shows that turn; nothing of it is sent.
   */
  readonly name: string;
  /** The questions typed in it, oldest first, each question it shows once: all an Ask ever sends of it (R2). */
  readonly questions: readonly string[];
  /** When it was last asked in. */
  readonly asked_at: string;
}

/** The timeline's threads, in the order they were started. */
export function threadsOf(turns: readonly TimelineTurn[]): Thread[] {
  const ids = threadIds(turns);
  const grouped = new Map<string, TimelineTurn[]>();
  for (const turn of turns) {
    const id = ids.get(turn.id)!;
    const own = grouped.get(id);
    if (own) own.push(turn); else grouped.set(id, [turn]);
  }
  return [...grouped].map(([id, own]) => {
    // Its first turn, the one it is named after, then the others oldest first: turns a merge brought in may be older.
    const first = own.find(turn => turn.id === id) ?? own[0]!;
    const worded = [first, ...own].find(turn => ownWords(turn)?.trim());
    const home = first.scope;
    // Only what was typed in its home is ever sent of it.
    const questions = visibleTurns(homeTurns({ home, turns: own }, home)).flatMap(turn => sentWords(turn) ?? []);
    return { id, turns: own, home, name: (worded ? ownWords(worded)! : first.text).trim(), questions, asked_at: own.at(-1)!.asked_at };
  });
}

/**
 * The turns of a thread a question asked in `scope` may build on (R9), the one check of it: the thread's turns where the
 * thread lives, and none anywhere else. So a question continues a turn, carries the thread's older turns, and has its
 * answer join the thread only in the thread's home, and nothing asked outside a request's scope rides on it (R3). A turn
 * kept in a thread that was not asked in the thread's home is never one of them: none is saved so, and one can only be
 * left from before merges were held to one home.
 */
export function homeTurns(thread: Pick<Thread, 'home' | 'turns'> | undefined, scope: AskScope): readonly TimelineTurn[] {
  return thread !== undefined && sameScope(thread.home, scope) ? thread.turns.filter(turn => sameScope(turn.scope, scope)) : [];
}

/**
 * Whether `thread` may merge into `into` (R9): another thread, living where it does, every turn of it asked there, so
 * one an older file holds mixed never carries a turn of another scope across. The one rule for every merge, by hand or
 * ECHO's own, and for the row that offers it.
 */
export function mergeable(thread: Thread, into: Thread | undefined): boolean {
  return into !== undefined && thread.id !== into.id && sameScope(thread.home, into.home) && thread.turns.every(turn => sameScope(turn.scope, into.home));
}

/** Threads, the one asked in most recently first. */
function newestFirst(threads: readonly Thread[]): Thread[] {
  return [...threads].sort((left, right) => Date.parse(right.asked_at) - Date.parse(left.asked_at));
}

/**
 * The other threads an Ask in `scope` carries (R3), most recently asked first: every thread but the one it continues
 * (`continued`, null for none) when it asks all context, and only that project's when it asks a project, so nothing from
 * outside a project enters a project's request. A thread with no question typed in it has nothing to send.
 */
export function otherThreads(threads: readonly Thread[], scope: AskScope, continued: string | null): Thread[] {
  return newestFirst(threads.filter(thread => thread.id !== continued && thread.questions.length > 0 && (scope.kind === 'global' || sameScope(thread.home, scope))));
}

/**
 * The older turns of a thread a follow-up carries (R6), oldest first: those `turns` (the thread as Ask shows it) has
 * before `before`, the turn it continues, with the person's own words.
 */
export function earlierTurns(turns: readonly TimelineTurn[], before: TimelineTurn): TimelineTurn[] {
  const at = turns.findIndex(turn => turn.id === before.id);
  return turns.slice(0, Math.max(at, 0)).filter(turn => sentWords(turn) !== undefined);
}

/**
 * Those older turns as `previous.earlier` carries them (R6): each by the person's own words, with its sentences `found`
 * (the check this follow-up made, by turn) has readable, as the previous turn's go: only its question with nothing
 * found of it.
 */
export function earlierOf(turns: readonly TimelineTurn[], before: TimelineTurn, found: Readonly<Record<string, TurnChecks>> | null): AskEarlierTurn[] {
  return earlierTurns(turns, before).map(turn => carried(turn, sentWords(turn)!, readableStatements(turn, found?.[turn.id] ?? null)));
}

/** What an Ask carries beside its question: the previous turn with its thread's older turns, and the threads it may be placed in, with which threads those are. */
export interface AskCarries {
  readonly previous?: AskPrevious;
  /** Present, though it may be empty, on a question to be placed. */
  readonly threads?: AskThread[];
  /** The threads sent, by id, in the order sent: an answer names one by its place here. */
  readonly sent: readonly string[];
}

/**
 * What an Ask of `question` in `scope` carries, within the request body's bound and with no count of its own (R7):
 * `previous` (previousOf's, which fits alone) with `earlier`, its thread's older turns, and `others`, the threads it may
 * be placed in. When they do not all fit, threads go first, from the least recently asked, then older turns from the
 * oldest. `others` null: the question is not to be placed, and carries no list. A question to be placed carries one even
 * when it is empty, so the answer can say it starts a thread although the person has no other.
 */
export function askCarries(question: string, scope: AskScope, previous: AskPrevious | null, earlier: readonly AskEarlierTurn[], others: readonly Thread[] | null): AskCarries {
  const threads = (others ?? []).map(({ questions, asked_at }): AskThread => ({ questions, asked_at }));
  // Each entry with the comma before the next, and each list that goes with its key and brackets.
  const sizes = (entries: readonly unknown[]) => entries.map(entry => jsonBytes(entry) + 1);
  const total = (bytes: readonly number[]) => bytes.reduce((sum, size) => sum + size, 0);
  const [turnBytes, threadBytes] = [sizes(previous === null ? [] : earlier), sizes(threads)];
  const room = BODY_ROOM - bodyBytes(question, scope, previous);
  let [turns, listed, from, kept] = [total(turnBytes), total(threadBytes), 0, threads.length];
  const fits = () => (from < turnBytes.length ? 16 + turns : 0) + (kept > 0 ? 16 + listed : 0) <= room;
  while (kept > 0 && !fits()) listed -= threadBytes[--kept]!;
  while (from < turnBytes.length && !fits()) turns -= turnBytes[from++]!;
  const older = previous === null ? [] : earlier.slice(from);
  return {
    ...(previous === null ? {} : { previous: older.length > 0 ? { ...previous, earlier: older } : previous }),
    ...(others === null ? {} : { threads: threads.slice(0, kept) }),
    sent: (others ?? []).slice(0, kept).map(thread => thread.id),
  };
}

/** A turn a merge moved, and the thread it was in. */
export interface MovedTurn {
  readonly turn: string;
  readonly from: string;
}

/**
 * Whether a merge into `into` can still be undone, given the thread each kept turn is in now (threadIds): every turn it
 * moved is still kept and still in that thread. One that has gone, or moved again, means the merge is no longer what
 * Undo would take back.
 */
export function undoable(moved: readonly MovedTurn[], into: string, ids: ReadonlyMap<string, string>): boolean {
  return moved.length > 0 && moved.every(({ turn }) => ids.get(turn) === into);
}

/** The threads of one home, as the thread list groups them. */
export interface ThreadGroup {
  readonly home: AskScope;
  readonly threads: readonly Thread[];
}

/**
 * The thread list (ADR-0056): every thread a question typed in which holds `find`, in any case (all with nothing to
 * find), grouped by home: the open thread's first, then no project, then projects by the one asked in most recently;
 * inside a group, the one asked in most recently first.
 */
export function threadGroups(threads: readonly Thread[], open: Thread | undefined, find: string): ThreadGroup[] {
  const wanted = find.trim().toLowerCase();
  const found = newestFirst(threads).filter(thread => wanted === '' || [thread.name, ...thread.questions].some(question => question.toLowerCase().includes(wanted)));
  const groups: { home: AskScope; threads: Thread[] }[] = [];
  for (const thread of found) {
    const group = groups.find(each => sameScope(each.home, thread.home));
    if (group) group.threads.push(thread); else groups.push({ home: thread.home, threads: [thread] });
  }
  // Stable: projects stay in the order of their newest thread.
  const rank = (group: ThreadGroup) => (open !== undefined && sameScope(group.home, open.home) ? 0 : group.home.kind === 'global' ? 1 : 2);
  return groups.sort((left, right) => rank(left) - rank(right));
}
