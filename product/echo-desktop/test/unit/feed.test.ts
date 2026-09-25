import { describe, expect, it } from 'vitest';
import type { DocumentSummary, FeedItem } from '../../src/shared/protocol.js';
import { mergedFeed, moreSources, reread } from '../../src/renderer/feed.js';

const note = (title: string, hour: number): FeedItem => ({
  context_id: `ctx_${title}`, title, received_at: `2026-09-20T${String(hour).padStart(2, '0')}:00:00.000Z`, audience: 'project',
});
const document = (title: string, hour: number): DocumentSummary => ({
  document_id: `doc_${title}`, title, filename: title, received_at: `2026-09-20T${String(hour).padStart(2, '0')}:00:00.000Z`,
  type: 'pdf', size: 1, audience: 'project', extraction: 'ready', project_ids: [],
});
const titles = (entries: ReturnType<typeof mergedFeed>) => entries.map(entry => entry.item.title);

describe('one feed of notes and documents', () => {
  it('shows both lists newest first once both are read to the end', () => {
    const lists = { notes: [note('n1', 20), note('n2', 10)], notesNext: null, documents: [document('d1', 15), document('d2', 5)], documentsNext: null };
    expect(titles(mergedFeed(lists))).toEqual(['n1', 'd1', 'n2', 'd2']);
    expect(moreSources(lists)).toEqual([]);
  });

  it('holds back what may belong below items not read yet, and More reads the list that stops it', () => {
    // Notes have more after 12:00; a 09:00 document may have newer notes above it.
    const lists = { notes: [note('n1', 20), note('n2', 12)], notesNext: 'next', documents: [document('d1', 15), document('d2', 9)], documentsNext: null };
    expect(titles(mergedFeed(lists))).toEqual(['n1', 'd1', 'n2']);
    expect(moreSources(lists)).toEqual(['notes']);
  });

  it('reads further the list that reaches back the least when both have more', () => {
    const lists = { notes: [note('n1', 20), note('n2', 8)], notesNext: 'next', documents: [document('d1', 15), document('d2', 11)], documentsNext: 'next' };
    expect(titles(mergedFeed(lists))).toEqual(['n1', 'd1', 'd2']);
    expect(moreSources(lists)).toEqual(['documents']);
  });
});

describe('a first page read again', () => {
  const key = (item: FeedItem) => item.context_id;
  const hours = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, index) => note(`n${from - index}`, from - index));

  it('leads with the page and keeps the older rows More loaded, with the cursor past them', () => {
    // Shown: twelve notes, read to the end. A new one pushes the tenth off the first page.
    const shown = { items: hours(20, 9), next: null };
    const first = { items: [note('new', 21), ...hours(20, 12)], next: 'page2' };
    const again = reread(shown, first, key);
    expect(again.items.map(item => item.title)).toEqual(['new', ...hours(20, 9).map(item => item.title)]);
    expect(again.next).toBeNull();
  });

  it('drops a shown row the page should hold but does not, and takes the page whole when it reaches the end', () => {
    // n15 left the list; n10 was loaded with More.
    const shown = { items: hours(20, 10), next: 'page2' };
    const first = { items: hours(20, 11).filter(item => item.title !== 'n15'), next: 'page2b' };
    const again = reread(shown, first, key);
    expect(again.items.map(item => item.title)).toEqual(['n20', 'n19', 'n18', 'n17', 'n16', 'n14', 'n13', 'n12', 'n11', 'n10']);
    expect(again.next).toBe('page2');
    expect(reread(shown, { items: hours(20, 16), next: null }, key)).toEqual({ items: hours(20, 16), next: null });
  });
});
