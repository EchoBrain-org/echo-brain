// The Ask timeline (ADR-0047), as rules the store and the page share: which
// turns show in full, what a check of their sources says of each turn and
// sentence, the earlier turn a follow-up or Ask again carries, and what the
// empty bar suggests from it. Pure, for the store and its tests; the store
// keeps the state and makes the calls.
import type {
  AnswerSource, AnswerStatement, AskCheckItem, AskCheckResult, AskCheckState, AskPrevious, AskScope, CheckCitation, TimelineTurn,
} from '../shared/protocol.js';
import { checkOf, MAX_ASK_BODY_BYTES, MAX_CHECK_ITEMS, MAX_CHECK_REQUEST_BYTES, PREVIOUS_LIMITS } from '../shared/protocol.js';
import { askText } from '../shared/query.js';
import { answerSentences, MAX_SOURCES, sourceGroups, type Shows, type SourceGroup } from './answer.js';

/** A follow-up continues the latest turn while it was asked this recently, and Ask is open. */
const FOLLOW_UP_MS = 60 * 60_000;
/** Opening Ask checks the sources of this many of the newest turns, and a check is good for five minutes. */
export const CHECK_TURNS = 10;
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
  for (const at of unreadable) if (known[at] !== 'same' && known[at] !== 'changed') known[at] = 'unreadable';
  return known;
}

/**
 * The sources a turn keeps as unreadable after a check that said `states` of
 * them: those it found unreadable join, those it found readable (the same or
 * changed) leave, and those it could not tell of stay as they were.
 */
export function unreadableAfter(kept: readonly number[] | undefined, states: TurnChecks): number[] {
  const next = new Set(kept ?? []);
  for (const [at, said] of Object.entries(states)) {
    if (said === 'unreadable') next.add(Number(at));
    else if (said === 'same' || said === 'changed') next.delete(Number(at));
  }
  return [...next].sort((left, right) => left - right);
}

/** The checks still good at `now`: one five minutes old goes, so nothing it said shows any more. */
export function freshChecks(checks: Readonly<Record<string, TurnCheck>>, now: number): Record<string, TurnCheck> {
  return Object.fromEntries(Object.entries(checks).filter(([, check]) => freshStates(check, now) !== undefined));
}

/**
 * One check: its items, and for each, the turn whose sources it stands for
 * and their places there; and the turns it speaks for: each it asks about,
 * and each citing nothing a check asks about. A turn none of whose sources
 * fit is not one of them.
 */
interface CheckPlan {
  readonly items: readonly AskCheckItem[];
  readonly places: readonly { readonly turn: string; readonly sources: readonly number[] }[];
  readonly turns: readonly string[];
}

/** What a check found: each checked turn's sources' states, and the markers tickets have now. */
export interface Checked {
  readonly turns: Readonly<Record<string, TurnChecks>>;
  readonly markers: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The answer's sources a check can ask about, numbered as the page numbers them: the first 32, each with what a check asks of it. */
function checkable(turn: TimelineTurn): { source: AnswerSource; at: number; citation: CheckCitation }[] {
  return turn.answer.sources.slice(0, MAX_SOURCES).flatMap((source, at) => {
    const citation = checkOf(source);
    return citation === undefined ? [] : [{ source, at, citation }];
  });
}

/**
 * One check of `turns` (the one most wanted first: the newest, or the turn
 * opened): each turn's checkable sources, the same citation once per turn,
 * with when the turn was asked and a ticket's baseline marker; at most 100
 * items in all, within the route's 64 KiB, the first turns' first. `only`
 * narrows the sources, as a new answer's tickets' baseline does.
 */
export function checkPlan(turns: readonly TimelineTurn[], only: (source: AnswerSource) => boolean = () => true): CheckPlan {
  const items: AskCheckItem[] = [];
  const places: { turn: string; sources: number[] }[] = [];
  const spoken: string[] = [];
  // The request's envelope, and a comma between items.
  let bytes = 96;
  let full = false;
  for (const turn of turns) {
    const asked = checkable(turn).filter(({ source }) => only(source));
    if (asked.length === 0) { spoken.push(turn.id); continue; }
    const seen = new Map<string, number>();
    for (const { source, at, citation } of full ? [] : asked) {
      const key = JSON.stringify(citation);
      const same = seen.get(key);
      if (same !== undefined) { places[same]!.sources.push(at); continue; }
      const marker = source.kind === 'ticket' ? turn.markers?.[String(at)] : undefined;
      const item: AskCheckItem = { asked_at: turn.asked_at, citation, ...(marker === undefined ? {} : { marker }) };
      const size = new TextEncoder().encode(JSON.stringify(item)).length + 1;
      if (items.length === MAX_CHECK_ITEMS || bytes + size > MAX_CHECK_REQUEST_BYTES - 1024) { full = true; break; }
      bytes += size;
      seen.set(key, places.length);
      items.push(item);
      places.push({ turn: turn.id, sources: [at] });
    }
    if (seen.size > 0) spoken.push(turn.id);
  }
  return { items, places, turns: spoken };
}

/**
 * What a check's results say of each turn it speaks for (nothing of one that
 * cites nothing a check asks about), and the markers its readable tickets
 * have now.
 */
export function checkedOf(plan: CheckPlan, results: readonly AskCheckResult[]): Checked {
  const turns: Record<string, Record<number, AskCheckState>> = Object.fromEntries(plan.turns.map(id => [id, {}]));
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

/** Which sentences and rows of a turn the page shows after a check: all but those it leaves out. */
export function showsOf(checks: TurnChecks | undefined): Shows {
  return citations => markOf(citations, checks) !== 'omitted';
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

/** The turns a later turn asked again, by id: they show no Changed tag. */
export function askedAgain(turns: readonly TimelineTurn[]): ReadonlySet<string> {
  return new Set(turns.flatMap(turn => (turn.again_of === undefined ? [] : [turn.again_of])));
}

/** Every sentence a turn shows: its answer's, and Ask again's "since" list. */
function sentences(turn: TimelineTurn): AnswerStatement[] {
  return [...answerSentences(turn.answer).map(([, statement]) => statement), ...(turn.since ?? [])];
}

/**
 * What a check says of a turn as a whole, as the line under it says it:
 * `changed` when a sentence it shows cites a source that changed; `same` only
 * when every source the sentences it shows cite was checked and is the same;
 * and nothing otherwise. A check that could not tell (`unknown`), a source it
 * did not ask about (one past what it could take, or a project, a person or a
 * tool, which no check asks about) and a turn with every sentence left out
 * leave an old answer saying nothing: it never looks current unless the check
 * says so.
 */
type TurnNote = 'changed' | 'same' | null;

export function turnNote(turn: TimelineTurn, checks: TurnChecks | undefined): TurnNote {
  if (checks === undefined) return null;
  const shown = sentences(turn).filter(statement => markOf(statement.citation_indexes, checks) !== 'omitted');
  if (shown.some(statement => markOf(statement.citation_indexes, checks) === 'changed')) return 'changed';
  const cited = shown.flatMap(statement => statement.citation_indexes);
  return cited.length > 0 && cited.every(at => checks[at] === 'same') ? 'same' : null;
}

/** A turn's Changed tag: a source one of the sentences it shows cites changed, and no later turn asked it again (`again`, askedAgain's). */
export function turnChanged(turn: TimelineTurn, checks: TurnChecks | undefined, again: ReadonlySet<string>): boolean {
  return !again.has(turn.id) && turnNote(turn, checks) === 'changed';
}

/** Whether every sentence of a turn is left out: then an opened turn shows only Ask again. */
export function allOmitted(turn: TimelineTurn, checks: TurnChecks | undefined): boolean {
  if (checks === undefined) return false;
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
 * or else the latest when it was asked in the last hour.
 */
export function followedTurn(turns: readonly TimelineTurn[], opened: string | null, now: number): TimelineTurn | null {
  const open = opened === null ? undefined : turns.find(turn => turn.id === opened);
  if (open) return open;
  const latest = turns.at(-1);
  return latest && now - Date.parse(latest.asked_at) <= FOLLOW_UP_MS ? latest : null;
}

/** `text` in at most `max` characters, as both a page (UTF-16) and the API (code points) count them: cut with "…" when longer. */
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
 * What a turn's own answer says of its sources while it is new: it read every
 * one a check asks about just now, so each is as it was. For a turn asked in
 * the last five minutes, as good as a check.
 */
export function answeredNow(turn: TimelineTurn): TurnChecks {
  return Object.fromEntries(turn.answer.sources.flatMap((source, at) => (checkOf(source) === undefined ? [] : [[at, 'same' as const]])));
}

/**
 * The earlier turn an Ask carries (C3): its full question and when it was
 * asked; its sentences you can still read, in the order the answer says
 * them, at most eight, each at most 400 characters and four citations; and
 * the citations they cite, at most twelve, as the answer's response carried
 * them, renumbered in the order first cited. A sentence goes only when what
 * is known now (`known`: what a check said in the last five minutes, or a new
 * turn's own answer) has each source it cites that a check asks about
 * readable, the same or changed; with nothing known (null), none goes, only
 * the question (C5). Sentences go from the end until the request, asking
 * `question` in `scope`, fits the Ask body's 16 KiB.
 */
export function previousOf(turn: TimelineTurn, purpose: AskPrevious['purpose'], known: TurnChecks | null, question: string, scope: AskScope): AskPrevious {
  const sources = turn.answer.sources;
  const read = (at: number) => sources[at] === undefined || checkOf(sources[at]) === undefined || known?.[at] === 'same' || known?.[at] === 'changed';
  const readable = known === null ? [] : [turn.answer.direct, ...turn.answer.parts.flatMap(part => [...part.statements, ...(part.records ?? [])])]
    .filter((statement): statement is AnswerStatement => statement !== undefined && statement.text.trim() !== '' && statement.citation_indexes.every(read));
  const build = (chosen: readonly AnswerStatement[]): AskPrevious => {
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
        if (!places.includes(place) && places.length < PREVIOUS_LIMITS.statement_citations) places.push(place);
      }
      // Trimmed and NFC, as C3 takes a sentence; cut with "…" past 400 characters.
      return { text: within(statement.text.trim(), PREVIOUS_LIMITS.statement_chars).normalize('NFC'), citation_indexes: places };
    });
    return { purpose, question: askText(turn.question), asked_at: turn.asked_at, statements, citations };
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

/**
 * The thread of a place (ADR-0049): Home's, all context, is every turn; a
 * project's is only the turns asked in it. One asked in Mine stays on Home's.
 */
export function threadOf(turns: readonly TimelineTurn[], scope: AskScope): readonly TimelineTurn[] {
  return scope.kind === 'project' ? turns.filter(turn => sameScope(turn.scope, scope)) : turns;
}

/** A question as two turns compare it: where it was asked (Mine, before it went, as Home), and its words in any case and spacing. */
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
 * The questions of `scope`'s thread as Ask shows it, newest first, each
 * reopening its turn: never one folded away. The bar's suggestions take each
 * once, the newest.
 */
export function askedSuggestions(turns: readonly TimelineTurn[], scope: AskScope): Suggestion[] {
  return visibleTurns(threadOf(turns, scope)).reverse().map(turn => ({ question: turn.question, turn: turn.id }));
}
