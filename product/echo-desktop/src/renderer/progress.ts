import type { AnswerSource, AskRead, AskReceipt, AskSearched, AskSearchedSource, AskStage, AskStep, ConnectedTool } from '../shared/protocol.js';
import { groupKey } from './answer.js';

/**
 * What Ask shows while it works (Ask progress and internal links v1,
 * ADR-0039): one live line, the stage now, and under it at most three rows
 * of what it searched and read. Everything here is built from the steps the
 * Authority reported, never from model text, and none of it outlives the Ask:
 * a cancel, a timeout or a refused answer drops it.
 */
export interface AskProgress {
  /** When the question was asked, by the page's clock. */
  readonly started: number;
  /** The stage now; null until the first step comes (an Authority that predates progress sends none). */
  readonly stage: AskStage | null;
  /** Items about to be read whose names have not come yet. */
  readonly pending: number;
  /** Its searches and reads in order, neighbours of a type merged, as the receipt's are. */
  readonly rows: readonly (AskSearched | AskRead)[];
}

/** Nothing extra shows for an Ask answered sooner: no live line, no rows, no receipt. */
export const PROGRESS_AFTER_MS = 3_000;
/** Live rows under the line; older ones fold away, and the receipt has them all. */
export const LIVE_ROWS = 3;
/** Names a live row shows before "+N". */
export const ROW_NAMES = 3;
/** The shortest time between two announcements to a screen reader. */
export const ANNOUNCE_MS = 5_000;

export function startProgress(now: number): AskProgress {
  return { started: now, stage: null, pending: 0, rows: [] };
}

function sameSource(a: AskSearchedSource, b: AskSearchedSource): boolean {
  return a.kind === b.kind && ('tool_id' in a ? 'tool_id' in b && a.tool_id === b.tool_id : !('tool_id' in b));
}

/**
 * One step more. A read's items all stay, so a row counts what the Authority
 * counts: it names each citation once, and two the page shows alike (two
 * sections of one page) are two items read.
 */
export function withStep(progress: AskProgress, step: AskStep): AskProgress {
  if (step.type === 'stage') return { ...progress, stage: step.stage, pending: step.stage === 'reading' ? step.pending ?? 0 : 0 };
  const rows = progress.rows;
  const last = rows.at(-1);
  if (step.type === 'searched') {
    if (last?.type !== 'searched') return { ...progress, rows: [...rows, { type: 'searched', sources: [...step.sources], found: step.found }] };
    const sources = [...last.sources, ...step.sources.filter(source => !last.sources.some(known => sameSource(known, source)))];
    return { ...progress, rows: [...rows.slice(0, -1), { type: 'searched', sources, found: last.found + step.found }] };
  }
  const items = step.items;
  const pending = Math.max(0, progress.pending - items.length);
  if (items.length === 0) return { ...progress, pending };
  return {
    ...progress, pending,
    rows: last?.type === 'read' ? [...rows.slice(0, -1), { type: 'read', items: [...last.items, ...items] }] : [...rows, { type: 'read', items }],
  };
}

/** A live row: a search or a read, done or still going, or the items being read whose names have not come. */
export type LiveRow =
  | { readonly type: 'searched'; readonly row: AskSearched }
  | { readonly type: 'read'; readonly row: AskRead; readonly done: boolean }
  | { readonly type: 'pending'; readonly count: number; readonly more: boolean };

/**
 * The rows under the live line: the last LIVE_ROWS. A search is reported
 * done; the newest read is still going while the research model reads it.
 */
export function liveRows(progress: AskProgress): LiveRow[] {
  const reading = progress.stage === 'reading';
  const rows: LiveRow[] = progress.rows.map((row, index) => row.type === 'searched' ? { type: 'searched', row }
    : { type: 'read', row, done: !(reading && progress.pending === 0 && index === progress.rows.length - 1) });
  if (reading && progress.pending > 0) rows.push({ type: 'pending', count: progress.pending, more: progress.rows.some(row => row.type === 'read') });
  return rows.slice(-LIVE_ROWS);
}

const VERBS: Record<AskStage, string> = { searching: 'Searching', reading: 'Reading', checking_access: 'Checking access', writing: 'Writing' };

/** The live line's words: the stage, or, before any step came, what Ask always said. */
export function stageWords(progress: AskProgress | null): string {
  return progress?.stage ? VERBS[progress.stage] : 'Thinking…';
}

/** "meetings, documents and Jira" */
export function listWords(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** A searched source as a person says it: a tool by its own name, once its list is read. */
export function sourceWords(source: AskSearchedSource, tools?: readonly ConnectedTool[] | null): string {
  if (!('tool_id' in source)) return source.kind === 'slack' ? 'Slack' : source.kind;
  return tools?.find(tool => tool.tool_id === source.tool_id)?.name ??
    source.tool_id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** "Searched meetings and Jira · 22 found": source kinds, never the words searched. */
export function searchedWords(row: AskSearched, tools?: readonly ConnectedTool[] | null): string {
  return `Searched ${listWords(row.sources.map(source => sourceWords(source, tools)))} · ${row.found === 0 ? 'nothing new' : `${row.found} found`}`;
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

/** A read row's names: the first ROW_NAMES places, and how many more items, so "+N" counts what "Reading N items" did. */
export function rowNames(items: readonly AnswerSource[], shown = ROW_NAMES): { names: readonly NamedPlace[]; more: number } {
  const names = namedPlaces(items).slice(0, shown);
  return { names, more: items.length - names.reduce((total, place) => total + place.items.length, 0) };
}

/** "48s", "1m 12s". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The receipt's one line: "Looked through 14 items · 48s". */
export function receiptWords(receipt: AskReceipt): string {
  return `Looked through ${receipt.looked_through} ${receipt.looked_through === 1 ? 'item' : 'items'} · ${duration(receipt.elapsed_ms)}`;
}

/** Items read that the receipt does not name: past its bound of names. */
export function receiptUnnamed(receipt: AskReceipt): number {
  const named = receipt.rows.reduce((total, row) => total + (row.type === 'read' ? row.items.length : 0), 0);
  return Math.max(0, receipt.looked_through - named);
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
