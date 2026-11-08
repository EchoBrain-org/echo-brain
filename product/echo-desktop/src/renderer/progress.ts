import type { AnswerSource, AskRead, AskReceipt, AskSearched, AskSearchedSource, AskStage, AskStep, ConnectedTool } from '../shared/protocol.js';
import { documentName, externalSourceProvider, groupKey } from './answer.js';

/**
 * What Ask shows while it works (Ask progress and internal links v1,
 * ADR-0039; the quiet line, 2026-10-19): one line that names the step now
 * and, while it reads, what. Everything here is built from the steps the
 * Authority reported, never from model text, and none of it outlives the
 * Ask: a cancel, a timeout or a refused answer drops it.
 */
export interface AskProgress {
  /** When the question was asked, by the page's clock. */
  readonly started: number;
  /** The stage now; null until the first step comes (an answer that does not stream sends none). */
  readonly stage: AskStage | null;
  /** Items about to be read whose names have not come yet. */
  readonly pending: number;
  /** The items read since the last search, in order: what the line names while it reads. */
  readonly read: readonly AnswerSource[];
}

/** Nothing extra shows for an Ask answered sooner: the line says only "Thinking…", and leaves no receipt. */
export const PROGRESS_AFTER_MS = 3_000;
/** The shortest time between two announcements to a screen reader. */
export const ANNOUNCE_MS = 5_000;

export function startProgress(now: number): AskProgress {
  return { started: now, stage: null, pending: 0, read: [] };
}

/**
 * One step more. A search starts the names over: they wait for the next
 * read. A read's items all stay, so the line counts what the Authority
 * counts: it names each citation once, and two the page shows alike (two
 * sections of one page) are two items read.
 */
export function withStep(progress: AskProgress, step: AskStep): AskProgress {
  if (step.type === 'stage') return { ...progress, stage: step.stage, pending: step.stage === 'reading' ? step.pending ?? 0 : 0 };
  if (step.type === 'searched') return { ...progress, read: [] };
  const items = step.items;
  const pending = Math.max(0, progress.pending - items.length);
  return items.length === 0 ? { ...progress, pending } : { ...progress, pending, read: [...progress.read, ...items] };
}

/** Whether a search before `index` among `rows` found anything. */
export function foundBefore(rows: readonly (AskSearched | AskRead)[], index: number): boolean {
  return rows.slice(0, index).some(row => row.type === 'searched' && row.found > 0);
}

const VERBS: Record<AskStage, string> = { searching: 'Searching', reading: 'Reading', checking_access: 'Checking access', writing: 'Writing' };

/**
 * The line's words: the stage, and while it reads, what. "Reading Tuesday
 * sync and 3 more" names the first place of what it read since the last
 * search and counts the other places. Before any step came, what Ask always
 * said.
 */
export function headline(progress: AskProgress | null): string {
  if (!progress?.stage) return 'Thinking…';
  if (progress.stage === 'writing') return 'Writing the answer';
  if (progress.stage !== 'reading') return VERBS[progress.stage];
  if (progress.pending > 0) return `Reading ${progress.pending} ${progress.pending === 1 ? 'item' : 'items'}`;
  if (progress.read.length === 0) return VERBS.reading;
  const places = namedPlaces(progress.read);
  const others = places.length - 1;
  return `Reading ${placeLabel(places[0]!.source)}${others > 0 ? ` and ${others} more` : ''}`;
}

/** "meetings, documents and Jira" */
export function listWords(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * A searched source as a person says it: a tool by its own name, once its
 * list is read, whether its tickets, pages or containers (its Jira projects or
 * Confluence spaces) were searched; ECHO's follow-ups as "follow-ups"; your
 * projects, people and tools as those words.
 */
function sourceWords(source: AskSearchedSource, tools?: readonly ConnectedTool[] | null): string {
  if (!('tool_id' in source)) return source.kind === 'follow_ups' ? 'follow-ups' : source.kind;
  return externalSourceProvider(source, tools);
}

/**
 * "Searched meetings and Jira · 22 found": source kinds, never the words
 * searched, each named once (a tool's issues and its projects are both
 * "Jira"). An empty search found nothing, or, once one before it found
 * items (`earlier`), nothing new.
 */
export function searchedWords(row: AskSearched, tools?: readonly ConnectedTool[] | null, earlier = false): string {
  const found = row.found > 0 ? `${row.found} found` : earlier ? 'nothing new' : 'nothing found';
  return `Searched ${listWords([...new Set(row.sources.map(source => sourceWords(source, tools)))])} · ${found}`;
}

/** A place Ask read, as one name: the first of its items read stands for it, and all of its items read go with it. */
export interface NamedPlace {
  readonly source: AnswerSource;
  readonly items: readonly AnswerSource[];
}

/**
 * Names as a person reads them: one per place, as an answer's sources are
 * grouped. Two decisions of one meeting, or two sections of one page, carry
 * the same name and open the same place: one name for both, which counts and
 * opens both, so the names account for every item read.
 */
export function namedPlaces(items: readonly AnswerSource[]): NamedPlace[] {
  const places = new Map<string, AnswerSource[]>();
  for (const item of items) {
    const key = groupKey(item);
    const place = places.get(key);
    if (place) place.push(item);
    else places.set(key, [item]);
  }
  return [...places.values()].map(read => ({ source: read[0]!, items: read }));
}

/** What a named place is called: a file's name as a person says it, otherwise its label. */
export function placeLabel(source: AnswerSource): string {
  return source.kind === 'original' ? documentName(source.label).name : source.label;
}

/** "48s", "1m 12s": whole seconds gone, as the live timer counts them. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * What an answer looked through: "Looked through 58 items", every item Ask
 * looked through as the Authority counted it (since progress V3, ADR-0043,
 * the rows it was shown as well as what it read in full). The line under the
 * answer adds the wait the person watched (by the page's clock), never the
 * Authority's own `elapsed_ms`, which leaves out the client and the network.
 */
export function lookedThrough(receipt: AskReceipt): string {
  return `Looked through ${receipt.looked_through} ${receipt.looked_through === 1 ? 'item' : 'items'}`;
}

/** What a screen reader hears while Ask works: the stage, and how many items it is reading. */
export function announcement(progress: AskProgress | null): string {
  if (!progress?.stage) return '';
  return progress.stage === 'reading' && progress.pending > 0 ? `Reading ${progress.pending} ${progress.pending === 1 ? 'item' : 'items'}` : VERBS[progress.stage];
}

/**
 * When to announce `text`, last announced `last` at `at`: now, after `wait`
 * ms (the latest text then), or never (it was already said).
 */
export function announceAfter(text: string, last: { text: string; at: number } | null, now: number): number | null {
  if (text === '' || text === last?.text) return null;
  return last === null ? 0 : Math.max(0, last.at + ANNOUNCE_MS - now);
}
