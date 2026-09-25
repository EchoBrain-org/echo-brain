// A project's one feed: its notes and its documents, newest first, each read
// ten at a time from its own list. Only what is certainly in order shows.
import type { DocumentSummary, FeedItem } from '../shared/protocol.js';

export type FeedEntry = { readonly kind: 'note'; readonly item: FeedItem } | { readonly kind: 'document'; readonly item: DocumentSummary };

export interface FeedLists {
  readonly notes: readonly FeedItem[];
  readonly notesNext: string | null;
  readonly documents: readonly DocumentSummary[];
  readonly documentsNext: string | null;
}

type Source = 'notes' | 'documents';

function time(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** How far back a list with more to read is known: its oldest item read so far. Nothing read yet knows nothing. */
function reach(items: readonly { received_at: string }[]): number {
  return items.length === 0 ? Infinity : Math.min(...items.map(item => time(item.received_at)));
}

/**
 * The line the feed can show down to: older than this, a list with more to
 * read may still have items that belong above the ones already read.
 */
function cutoff(lists: FeedLists): number {
  let line = -Infinity;
  if (lists.notesNext !== null) line = Math.max(line, reach(lists.notes));
  if (lists.documentsNext !== null) line = Math.max(line, reach(lists.documents));
  return line;
}

/** Notes and documents, newest first, down to where both lists are known. */
export function mergedFeed(lists: FeedLists): FeedEntry[] {
  const line = cutoff(lists);
  const entries: FeedEntry[] = [
    ...lists.notes.map(item => ({ kind: 'note' as const, item })),
    ...lists.documents.map(item => ({ kind: 'document' as const, item })),
  ];
  return entries
    .filter(entry => time(entry.item.received_at) >= line)
    .sort((a, b) => time(b.item.received_at) - time(a.item.received_at));
}

/** More reads the next page of the list (or lists) that stop the feed going further back. */
export function moreSources(lists: FeedLists): Source[] {
  const line = cutoff(lists);
  const sources: Source[] = [];
  if (lists.notesNext !== null && reach(lists.notes) === line) sources.push('notes');
  if (lists.documentsNext !== null && reach(lists.documents) === line) sources.push('documents');
  return sources;
}
