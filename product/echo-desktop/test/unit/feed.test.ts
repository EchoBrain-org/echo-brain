import { describe, expect, it } from 'vitest';
import type { DocumentSummary, FeedItem } from '../../src/shared/protocol.js';
import { mergedFeed, moreSources } from '../../src/renderer/feed.js';

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
