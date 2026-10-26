// The Ask timeline (ADR-0047), as rules the store and the page share: which
// turns show in full, what a check of their sources says of each turn and
// sentence, the earlier turn a follow-up or Ask again carries, and what the
// empty bar suggests from it. Pure, for the store and its tests; the store
// keeps the state and makes the calls.
import type {
  AnswerSource, AnswerStatement, AskCheckItem, AskCheckResult, AskCheckState, AskPrevious, AskScope, TimelineTurn,
} from '../shared/protocol.js';
import { MAX_ASK_BODY_BYTES, MAX_CHECK_ITEMS, MAX_CHECK_REQUEST_BYTES, PREVIOUS_LIMITS } from '../shared/protocol.js';
import { askText } from '../shared/query.js';
import { answerSentences, MAX_SOURCES, sourceGroups, type SourceGroup } from './answer.js';

/** A follow-up continues the latest turn while it was asked this recently, and Ask is open. */
export const FOLLOW_UP_MS = 60 * 60_000;
/** Opening Ask checks the sources of this many of the newest turns, and a check is good for five minutes. */
export const CHECK_TURNS = 10;
export const CHECK_FRESH_MS = 5 * 60_000;

/** What a check said of one turn's sources, by their place among its answer's sources. */
export type TurnChecks = Readonly<Record<number, AskCheckState>>;

/** One check: its items, and for each, the turn whose sources it stands for and their places there. */
export interface CheckPlan {
  readonly items: readonly AskCheckItem[];
  readonly places: readonly { readonly turn: string; readonly sources: readonly number[] }[];
}

/** What a check found: each checked turn's sources' states, and the markers tickets have now. */
export interface Checked {
  readonly turns: Readonly<Record<string, TurnChecks>>;
  readonly markers: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The answer's sources a check can ask about, numbered as the page numbers them: the first 32. */
function checkable(turn: TimelineTurn): { source: AnswerSource; at: number }[] {
  return turn.answer.sources.slice(0, MAX_SOURCES).flatMap((source, at) => source.check === undefined ? [] : [{ source, at }]);
}

/**
 * One check of `turns` (newest first): each turn's checkable sources, the
 * same citation once per turn, with when the turn was asked and a ticket's
 * baseline marker; at most 100 items in all, within the route's 64 KiB, the
 * newest turns' first. `only` narrows the sources, as a new answer's tickets'
 * baseline does.
 */
export function checkPlan(turns: readonly TimelineTurn[], only: (source: AnswerSource) => boolean = () => true): CheckPlan {
  const items: AskCheckItem[] = [];
  const places: { turn: string; sources: number[] }[] = [];
  // The request's envelope, and a comma between items.
  let bytes = 96;
  for (const turn of turns) {
    const seen = new Map<string, number>();
    for (const { source, at } of checkable(turn)) {
      if (!only(source)) continue;
      const key = JSON.stringify(source.check);
      const same = seen.get(key);
      if (same !== undefined) { places[same]!.sources.push(at); continue; }
      const marker = source.kind === 'ticket' ? turn.markers?.[String(at)] : undefined;
      const item: AskCheckItem = { asked_at: turn.asked_at, citation: source.check!, ...(marker === undefined ? {} : { marker }) };
      const size = new TextEncoder().encode(JSON.stringify(item)).length + 1;
      if (items.length === MAX_CHECK_ITEMS || bytes + size > MAX_CHECK_REQUEST_BYTES - 1024) return { items, places };
      bytes += size;
      seen.set(key, places.length);
      items.push(item);
      places.push({ turn: turn.id, sources: [at] });
    }
  }
  return { items, places };
}

/** What a check's results say of each turn it asked about, and the markers its readable tickets have now. */
export function checkedOf(plan: CheckPlan, results: readonly AskCheckResult[]): Checked {
  const turns: Record<string, Record<number, AskCheckState>> = {};
  const markers: Record<string, Record<string, string>> = {};
  plan.places.forEach(({ turn, sources }, index) => {
    const result = results[index];
    if (!result) return;
    const states = turns[turn] ??= {};
    for (const at of sources) {
      states[at] = result.state;
      if (result.marker !== undefined) (markers[turn] ??= {})[String(at)] = result.marker;
    }
  });
  return { turns, markers };
}

/** How a sentence reads after a check: left out when it cites a source you can no longer read, lit when one it cites changed. */
export type Mark = 'omitted' | 'changed' | null;

export function markOf(citations: readonly number[], checks: TurnChecks | undefined): Mark {
  if (!checks) return null;
  if (citations.some(at => checks[at] === 'unreadable')) return 'omitted';
  return citations.some(at => checks[at] === 'changed') ? 'changed' : null;
}

/**
 * A turn's sources as its page numbers them: the first 32, one per place,
 * without a place every citation of which a check found you can no longer
 * read, as the sentences citing it are left out. Each keeps its citations'
 * places among the answer's sources.
 */
export function turnGroups(sources: readonly AnswerSource[], checks: TurnChecks | undefined): SourceGroup[] {
  const groups = sourceGroups(sources.slice(0, MAX_SOURCES));
  return checks === undefined ? groups : groups.filter(group => !group.indexes.every(at => checks[at] === 'unreadable'));
}

/** Whether a later turn asked this one again: then it shows no Changed tag. */
export function askedAgain(turn: TimelineTurn, turns: readonly TimelineTurn[]): boolean {
  return turns.some(later => later.again_of === turn.id);
}

/** Every sentence a turn shows: its answer's, and Ask again's "since" list. */
function sentences(turn: TimelineTurn): AnswerStatement[] {
  return [...answerSentences(turn.answer).map(([, statement]) => statement), ...(turn.since ?? [])];
}

/** A turn's Changed tag: a source one of its sentences cites changed, and no later turn asked it again. */
export function turnChanged(turn: TimelineTurn, checks: TurnChecks | undefined, turns: readonly TimelineTurn[]): boolean {
  return !askedAgain(turn, turns) && sentences(turn).some(statement => markOf(statement.citation_indexes, checks) === 'changed');
}

/** Whether a check says anything of a turn: it is in the last one. A turn it says nothing of has no note. */
export function checkedTurn(checks: TurnChecks | undefined): checks is TurnChecks {
  return checks !== undefined && Object.keys(checks).length > 0;
}

/** Whether every sentence of a turn is left out: then an opened turn shows only Ask again. */
export function allOmitted(turn: TimelineTurn, checks: TurnChecks | undefined): boolean {
  const all = sentences(turn);
  return all.length > 0 && all.every(statement => markOf(statement.citation_indexes, checks) === 'omitted');
}

/**
 * Whether a turn shows in full: the latest, and `full`, the turns Ask shows
 * in full since it opened (the latest then, which a follow-up continues, and
 * every turn asked since). Every other turn folds.
 */
export function shownInFull(turn: TimelineTurn, turns: readonly TimelineTurn[], full: readonly string[]): boolean {
  return turns.at(-1)?.id === turn.id || full.includes(turn.id);
}

/** The turn a follow-up continues: the earlier turn opened, or else the latest when it was asked in the last hour. */
export function followedTurn(turns: readonly TimelineTurn[], opened: string | null, now: number): TimelineTurn | null {
  const open = opened === null ? undefined : turns.find(turn => turn.id === opened);
  if (open) return open;
  const latest = turns.at(-1);
  return latest && now - Date.parse(latest.asked_at) <= FOLLOW_UP_MS ? latest : null;
}

/** `text` in at most `max` characters, as both a page and the API count them: cut with "…" when longer. */
function within(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = '';
  for (const character of text) {
    if (cut.length + character.length > max - 1) break;
    cut += character;
  }
  return `${cut.trimEnd()}…`;
}

/** An Ask request's body as the client sends it (`PersonAnswerRequestV3`), for its bytes. */
function bodyBytes(question: string, scope: AskScope, previous: AskPrevious): number {
  const body = { schema_version: 3, question, ...(scope.kind === 'project' ? { project_id: scope.project_id } : scope.kind === 'mine' ? { mine: true } : {}), previous };
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/**
 * The earlier turn an Ask carries (C3): its full question and when it was
 * asked; its sentences you can still read (none citing a source a check found
 * you can no longer read), in the order the answer says them, at most eight,
 * each at most 400 characters and four citations; and the citations they cite,
 * at most twelve, as the answer's response carried them, renumbered in the
 * order first cited. Sentences go from the end until the request, asking
 * `question` in `scope`, fits the Ask body's 16 KiB.
 */
export function previousOf(turn: TimelineTurn, purpose: AskPrevious['purpose'], checks: TurnChecks | undefined, question: string, scope: AskScope): AskPrevious {
  const sources = turn.answer.sources;
  const readable = [turn.answer.direct, ...turn.answer.parts.flatMap(part => [...part.statements, ...(part.records ?? [])])]
    .filter((statement): statement is AnswerStatement => statement !== undefined && statement.text.trim() !== '' && markOf(statement.citation_indexes, checks) !== 'omitted');
  const build = (chosen: readonly AnswerStatement[]): AskPrevious => {
    const cited: number[] = [];
    const statements = chosen.map(statement => {
      const places = statement.citation_indexes.filter(at => sources[at]?.cited !== undefined).slice(0, PREVIOUS_LIMITS.statement_citations);
      for (const at of places) if (!cited.includes(at)) cited.push(at);
      return { text: within(statement.text.trim(), PREVIOUS_LIMITS.statement_chars), citation_indexes: places.map(at => cited.indexOf(at)) };
    });
    return { purpose, question: askText(turn.question), asked_at: turn.asked_at, statements, citations: cited.map(at => sources[at]!.cited!) };
  };
  // At most eight sentences, and only as many as keep their citations within twelve.
  const chosen: AnswerStatement[] = [];
  for (const statement of readable) {
    if (chosen.length === PREVIOUS_LIMITS.statements) break;
    if (build([...chosen, statement]).citations.length > PREVIOUS_LIMITS.citations) break;
    chosen.push(statement);
  }
  let previous = build(chosen);
  // A little short of the bound, for how the client writes the same body.
  while (chosen.length > 0 && bodyBytes(question, scope, previous) > MAX_ASK_BODY_BYTES - 256) {
    chosen.pop();
    previous = build(chosen);
  }
  return previous;
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

/** The questions you asked in `scope`, newest first, each once (the newest turn of it), each reopening its turn. */
export function askedSuggestions(turns: readonly TimelineTurn[], scope: AskScope): Suggestion[] {
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  for (const turn of [...turns].reverse()) {
    if (!sameScope(turn.scope, scope)) continue;
    const key = turn.question.replace(/\s+/gu, ' ').trim().toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ question: turn.question, turn: turn.id });
  }
  return suggestions;
}

/** Midnight today, here. */
function startOfDay(now: number): number {
  const today = new Date(now);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
}

/** Whether a turn was asked today, here. */
export function askedToday(iso: string, now = Date.now()): boolean {
  return Date.parse(iso) >= startOfDay(now);
}

/** When a turn was asked, as its row says it: the time for today ("3:41 PM"), else the day ("Oct 14"), with its year when not this year's. */
export function askedWhen(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  if (time >= startOfDay(now)) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const year = date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' as const };
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...year });
}
