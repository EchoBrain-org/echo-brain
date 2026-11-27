// The Ask timeline (ADR-0047), as rules the store and the page share: which
// turns show in full, which sentences a check of their sources leaves out,
// the earlier turn a follow-up or Ask again carries, what the empty bar
// suggests from it, its threads (ADR-0056) and the conversations they make
// (ADR-0057). Pure, for the store and its tests; the store keeps the state
// and makes the calls.
import { isPersonAnswerLabelV1, personAnswerLabelFitsV1 } from '@echo-brain/organization-api/person-answer-previous-v1';
import type {
  Answer, AnswerSource, AnswerStatement, AskCheckItem, AskCheckResult, AskCheckState, AskPrevious, AskResearchSubject, AskScope, AskThread, CheckCitation, TimelineTurn,
} from '../shared/protocol.js';
import { checkCitation, checkOf, subjectCitation, MAX_REQUEST_BYTES, THREAD_ACTIVE_MS } from '../shared/protocol.js';
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
  return [...turn.answer.sources.map(checkOf), ...(turn.subject_citations ?? []).map(checkCitation)].flatMap((citation, at) => {
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

/**
 * The turn a follow-up continues: the turn opened (from its line, or chosen from the bar's suggestions, the latest included),
 * or else the latest, however long ago it was asked. A question typed with Ask open is a follow-up because the person asks it there.
 */
export function followedTurn(turns: readonly TimelineTurn[], opened: string | null): TimelineTurn | null {
  const open = opened === null ? undefined : turns.find(turn => turn.id === opened);
  return open ?? turns.at(-1) ?? null;
}

const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** An Ask request's body as the client sends it (`PersonAnswerRequestV3`), for its bytes; every Ask but an Ask again reads labels (askLabels). */
function bodyBytes(question: string, scope: AskScope, previous: AskPrevious | null, subjects?: readonly AskResearchSubject[]): number {
  return jsonBytes({ schema_version: 3, question, ...(scope.kind === 'project' ? { project_id: scope.project_id } : {}), ...(previous === null ? {} : { previous }),
    ...(subjects === undefined ? {} : { research_subjects: subjects }), ...(previous?.purpose === 'ask_again' ? {} : { labels: true, research_clarification: true }) });
}

/** The most an Ask's body may take: a little short of the bound, for how the client writes the same body. */
const BODY_ROOM = MAX_REQUEST_BYTES - 256;

/** Whether `known` finds the turn's source at `at` readable: one there, of a kind a check reads, found `same`. */
function sourceReadable(turn: TimelineTurn, known: TurnChecks | null | undefined, at: number): boolean {
  const source = turn.answer.sources[at];
  return source !== undefined && checkOf(source) !== undefined && known?.[at] === 'same';
}

/** Access to every source selected to identify this answer’s subject. */
export function subjectAccess(turn: TimelineTurn, known: TurnChecks | null | undefined): AskCheckState {
  const states = (turn.subject_citations ?? []).map((_, i) => known?.[turn.answer.sources.length + i]);
  return states.includes('unreadable') ? 'unreadable' : states.every(state => state === 'same') ? 'same' : 'unknown';
}

export function turnReadable(turn: TimelineTurn, known: TurnChecks | undefined): boolean {
  return subjectAccess(turn, known) === 'same' && turn.answer.sources.length > 0 && turn.answer.sources.every((_, at) => sourceReadable(turn, known, at));
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
 * bound. `label`: its conversation's label, on a follow-up only (ADR-0057).
 */
export function previousOf(turn: TimelineTurn, purpose: AskPrevious['purpose'], known: TurnChecks | null, question: string, scope: AskScope,
  earlier: string = askText(turn.question), label?: string, candidate?: true, subjects?: readonly AskResearchSubject[]): AskPrevious {
  const chosen = readableStatements(turn, known);
  const labelled = purpose === 'follow_up' ? { ...(label === undefined ? {} : { label }), ...(candidate ? { candidate } : {}) } : {};
  let previous: AskPrevious = { purpose, ...carried(turn, earlier, chosen), ...labelled };
  while (chosen.length > 0 && bodyBytes(question, scope, previous, subjects) > BODY_ROOM) {
    chosen.pop();
    previous = { purpose, ...carried(turn, earlier, chosen), ...labelled };
  }
  return previous;
}

/** A turn's sentences an Ask may carry: those whose every source `known` found readable; none from an older desktop's turn. */
function readableStatements(turn: TimelineTurn, known: TurnChecks | null): AnswerStatement[] {
  if (known === null || turn.citations_complete !== true || subjectAccess(turn, known) !== 'same') return [];
  // The Authority checks a carried sentence’s original citations again. Carry it only if those
  // citations can also vouch for every selected subject at that final access check.
  const dependencies = turn.subject_citations?.map(citation => JSON.stringify(citation));
  const keys = dependencies && turn.answer.sources.map(source => source.cited && JSON.stringify(subjectCitation(source.cited.citation)));
  return [turn.answer.direct, ...turn.answer.parts.flatMap(part => [...part.statements, ...(part.records ?? [])])]
    .filter((statement): statement is AnswerStatement => statement !== undefined && statement.text.trim() !== ''
      && statement.citation_indexes.every(at => sourceReadable(turn, known, at))
      && (!dependencies || dependencies.every(key => statement.citation_indexes.some(at => keys?.[at] === key))));
}

/** A turn as an Ask carries it, previous or older alike, with only the citations its `chosen` sentences cite. */
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

/** The turns asked in a place, as its bar suggests them: all for Home, a project's own for a project. */
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

export type AskEarlierTurn = NonNullable<AskPrevious['earlier']>[number];

/**
 * What the person typed for a turn (R2): its `typed` words, or its `text` when known to have followed nothing; never a
 * question a model wrote. A turn saved before `typed` and `follows` has none, as its `text` may be a choice's question.
 */
export function ownWords(turn: TimelineTurn): string | undefined {
  if (turn.typed !== undefined) return turn.typed;
  return turn.follows === null && turn.again_of === undefined ? turn.text : undefined;
}

function sentWords(turn: TimelineTurn): string | undefined {
  const words = askText(ownWords(turn) ?? '');
  return words === '' ? undefined : words;
}

/**
 * The thread each turn belongs to (R8): the one it names, or for one saved before threads the thread of the turn it
 * followed or asked again, while that is kept and asked in the same place; otherwise its own.
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
  /** Where it lives: its first turn's scope, or its oldest's once that is gone; every turn is asked there (R9). */
  readonly home: AskScope;
  /** The question typed for its first turn, or the first typed in it where it lives (R2); undefined when nothing asked there kept the person's words. */
  readonly own?: string;
  /** What the door lists it by: `own`, or with none its first turn's heading as that turn shows it, never sent and shown nowhere else. */
  readonly name: string;
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
    // The turn it is named after is its first; once that is gone, its oldest kept stands in.
    const first = own.find(turn => turn.id === id) ?? own[0]!;
    const home = first.scope;
    // Only what was asked in its home names it: a turn an older file keeps here from another place never does.
    const worded = [first, ...own].find(turn => sameScope(turn.scope, home) && ownWords(turn)?.trim());
    const typed = worded && ownWords(worded)!.trim();
    return { id, turns: own, home, ...(typed === undefined ? {} : { own: typed }), name: typed ?? first.text.trim(), asked_at: own.at(-1)!.asked_at };
  });
}

/**
 * The turns of a thread a question asked in `scope` may build on (R9): its turns where it lives, none anywhere else, so
 * nothing asked outside a request's scope rides on it (R3); a turn an older file keeps there from elsewhere is left out.
 */
export function homeTurns(thread: Pick<Thread, 'home' | 'turns'> | undefined, scope: AskScope): readonly TimelineTurn[] {
  return thread !== undefined && sameScope(thread.home, scope) ? thread.turns.filter(turn => sameScope(turn.scope, scope)) : [];
}

/** Most recently asked in first; of two asked in at the same moment, the one started later. */
function newestFirst<T extends { readonly asked_at: string }>(all: readonly T[]): T[] {
  return all.map((each, at) => ({ each, at })).sort((left, right) => Date.parse(right.each.asked_at) - Date.parse(left.each.asked_at) || right.at - left.at)
    .map(({ each }) => each);
}

// ---- conversations (ADR-0057) --------------------------------------------------------

/** Whether a thread is active at `now` (R11): its newest turn was asked less than a week before. Any other is joined: part of memory. */
export function threadActive(thread: Pick<Thread, 'asked_at'>, now: number): boolean {
  return now - Date.parse(thread.asked_at) < THREAD_ACTIVE_MS;
}

/**
 * One conversation (R14): a thread with every thread it continues or is linked to, and theirs. Worked out from the
 * turns each time it is needed; nothing stores it, and a link only ever makes one larger.
 */
export interface Chain {
  /** Its newest thread's id: a thread id, so it names this conversation only while that thread is its newest. */
  readonly id: string;
  /** Its threads, in the order they were started. */
  readonly threads: readonly Thread[];
  /** The thread last asked in: the one a question in this conversation continues (R14). */
  readonly newest: Thread;
  /** Its turns across its threads, oldest first, as the timeline keeps them. */
  readonly turns: readonly TimelineTurn[];
  /** Where it lives: every thread of it lives there (R9). */
  readonly home: AskScope;
  /** Its typed questions, oldest first, each asked question once: all an Ask ever sends of it (R2). */
  readonly questions: readonly string[];
  /** Its label, when it has one that may be sent (R2). */
  readonly sent?: string;
  /**
   * What the page may call it anywhere (R2): its label, or else the own words that name the thread of it last asked in
   * that has any; undefined when nothing in it kept the person's words.
   */
  readonly own?: string;
  /** What the door lists it by: `own`, or with none its newest thread's first heading, shown nowhere else. */
  readonly label: string;
  /** When it was last asked in. */
  readonly asked_at: string;
}

/**
 * The label among `turns` that still stands (R2): the newest in form whose every word is a word of `questions`, the
 * words typed in its conversation. One that fails is passed over wherever it is found, never repaired.
 */
export function labelOf(turns: readonly Pick<TimelineTurn, 'label'>[], questions: readonly string[]): string | undefined {
  return turns.findLast(turn => isPersonAnswerLabelV1(turn.label) && personAnswerLabelFitsV1(turn.label, questions))?.label;
}

/**
 * The timeline's conversations, in the order their first threads were started: threads joined by `continues`, followed
 * both ways. A turn that names a thread no longer kept, its own, or one living elsewhere (R9) joins nothing, and neither
 * does a turn an older file keeps in a thread from another place: only what was asked in a thread's home speaks for it.
 */
export function chainsOf(turns: readonly TimelineTurn[], threads: readonly Thread[] = threadsOf(turns)): Chain[] {
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  // Each thread's group: joining two moves the later-started group's threads into the earlier's.
  const group = new Map(threads.map(thread => [thread.id, [thread]]));
  for (const thread of threads) {
    for (const id of homeTurns(thread, thread.home).flatMap(turn => turn.continues ?? [])) {
      const other = byId.get(id);
      if (other === undefined || !sameScope(other.home, thread.home)) continue;
      const [mine, theirs] = [group.get(thread.id)!, group.get(other.id)!];
      if (mine === theirs) continue;
      const [into, from] = threads.indexOf(mine[0]!) < threads.indexOf(theirs[0]!) ? [mine, theirs] : [theirs, mine];
      into.push(...from);
      for (const moved of from) group.set(moved.id, into);
    }
  }
  const place = new Map(turns.map((turn, at) => [turn.id, at]));
  return [...new Set(group.values())].map((members) => {
    const own = [...members].sort((left, right) => threads.indexOf(left) - threads.indexOf(right));
    const newest = newestFirst(own)[0]!;
    const all = own.flatMap(thread => thread.turns).sort((left, right) => place.get(left.id)! - place.get(right.id)!);
    const home = newest.home;
    // Only what was asked in its home is ever sent of it, or labels it.
    const here = all.filter(turn => sameScope(turn.scope, home));
    const questions = visibleTurns(here).flatMap(turn => sentWords(turn) ?? []);
    const sent = labelOf(here, questions);
    const named = sent ?? newestFirst(own).find(thread => thread.own !== undefined)?.own;
    return {
      id: newest.id, threads: own, newest, turns: all, home, questions, ...(sent === undefined ? {} : { sent }), ...(named === undefined ? {} : { own: named }),
      label: named ?? newest.name, asked_at: newest.asked_at,
    };
  });
}

/**
 * The thread a thread continues (R13), which its "Continues" line opens: the first one its own first turn names, as
 * that turn is written (the joined thread first, then any links), while that thread is kept in the same home. A link
 * (R16) on a later turn names none here, so linking never adds a line.
 */
export function continuedThread(thread: Thread, threads: readonly Thread[]): Thread | undefined {
  const named = thread.turns.find(turn => turn.id === thread.id)?.continues?.[0];
  const other = threads.find(each => each.id === named);
  return other !== undefined && other.id !== thread.id && sameScope(other.home, thread.home) ? other : undefined;
}

/**
 * The other conversations an Ask in `scope` carries, most recent first: all but the one it continues (`continued`, a
 * thread of it), and in a project only that project's (R3). One with no typed question has nothing to send, so ECHO
 * never places a question in it.
 */
export function otherChains(chains: readonly Chain[], scope: AskScope, continued: string | null): Chain[] {
  return newestFirst(chains.filter(chain => !chain.threads.some(thread => thread.id === continued) && chain.questions.length > 0
    && sameScope(chain.home, scope)));
}

/** The door's rows: conversations whose label or a typed question holds `find`, the one asked in most recently first. */
export function doorChains(chains: readonly Chain[], find: string): Chain[] {
  const wanted = find.trim().toLowerCase();
  return newestFirst(chains).filter(chain => wanted === '' || [chain.label, ...chain.questions].some(text => text.toLowerCase().includes(wanted)));
}

/**
 * The older turns a follow-up carries (R6), oldest first, each question once as Ask shows them: folded with `before`
 * among them, then without it, and found among all turns kept, so a repeat asked later in the conversation never hides `before`.
 */
export function earlierTurns(turns: readonly TimelineTurn[], before: TimelineTurn): TimelineTurn[] {
  const at = turns.findIndex(turn => turn.id === before.id);
  return visibleTurns(turns.slice(0, at + 1)).filter(turn => turn.id !== before.id && sentWords(turn) !== undefined);
}

/** Those older turns as `previous.earlier` carries them (R6): own words, and only the sentences `found` readable. */
export function earlierOf(turns: readonly TimelineTurn[], before: TimelineTurn, found: Readonly<Record<string, TurnChecks>> | null): AskEarlierTurn[] {
  return earlierTurns(turns, before).map(turn => carried(turn, sentWords(turn)!, readableStatements(turn, found?.[turn.id] ?? null)));
}

/** What an Ask carries beside its question, with which conversations were sent. */
export interface AskCarries {
  readonly previous?: AskPrevious;
  /** Present, though it may be empty, on a question to be placed: one entry for each conversation (R14). */
  readonly threads?: AskThread[];
  /** The conversations sent, each by its newest thread's id then, in the order sent: an answer names one by its place here. */
  readonly sent: readonly string[];
}

/**
 * What an Ask carries within the body's bound, with no count of its own (R7): when all does not fit, threads go first,
 * least recently asked first, then older turns from the oldest. `others` null: not to be placed, no list; to be placed,
 * a list goes even when empty, so the answer can say the question starts a thread.
 */
export function askCarries(question: string, scope: AskScope, previous: AskPrevious | null, earlier: readonly AskEarlierTurn[], others: readonly Chain[] | null, subjects?: readonly AskResearchSubject[]): AskCarries {
  const threads = (others ?? []).map(({ questions, asked_at, sent }): AskThread => ({ questions, asked_at, ...(sent === undefined ? {} : { label: sent }) }));
  // Each entry with the comma before the next, and each list that goes with its key and brackets.
  const sizes = (entries: readonly unknown[]) => entries.map(entry => jsonBytes(entry) + 1);
  const total = (bytes: readonly number[]) => bytes.reduce((sum, size) => sum + size, 0);
  const [turnBytes, threadBytes] = [sizes(previous === null ? [] : earlier), sizes(threads)];
  const room = BODY_ROOM - bodyBytes(question, scope, previous, subjects);
  let [turns, listed, from, kept] = [total(turnBytes), total(threadBytes), 0, threads.length];
  const fits = () => (from < turnBytes.length ? 16 + turns : 0) + (kept > 0 ? 16 + listed : 0) <= room;
  while (kept > 0 && !fits()) listed -= threadBytes[--kept]!;
  while (from < turnBytes.length && !fits()) turns -= turnBytes[from++]!;
  const older = previous === null ? [] : earlier.slice(from);
  return {
    ...(previous === null ? {} : { previous: older.length > 0 ? { ...previous, earlier: older } : previous }),
    ...(others === null ? {} : { threads: threads.slice(0, kept) }),
    sent: (others ?? []).slice(0, kept).map(chain => chain.id),
  };
}
