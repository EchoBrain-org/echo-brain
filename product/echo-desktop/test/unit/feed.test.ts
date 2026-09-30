import { describe, expect, it } from 'vitest';
import type { ListItem } from '../../src/shared/protocol.js';
import { reread } from '../../src/renderer/feed.js';

const row = (title: string, hour: number, kind: ListItem['ref']['kind'] = 'note'): ListItem => ({
  ref: { kind, id: `${kind}-${title}` }, title, added_at: `2026-09-20T${String(hour).padStart(2, '0')}:00:00.000Z`, visibility: 'project', projects: [],
});

describe('a first page read again', () => {
  const key = (item: ListItem) => `${item.ref.kind}:${item.ref.id}`;
  const hours = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, index) => row(`n${from - index}`, from - index));

  it('leads with the page and keeps the older rows More loaded, with the cursor past them', () => {
    // Shown: twelve rows, read to the end. A new one pushes the tenth off the first page.
    const shown = { items: hours(20, 9), next: null };
    const first = { items: [row('new', 21), ...hours(20, 12)], next: 'page2' };
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

  it('keeps notes, documents and meetings of the same time apart by their refs', () => {
    const shown = { items: [row('a', 12, 'meeting'), row('a', 11, 'note'), row('a', 11, 'document')], next: null };
    const first = { items: [row('b', 13), row('a', 12, 'meeting')], next: 'page2' };
    expect(reread(shown, first, key).items.map(key)).toEqual(['note:note-b', 'meeting:meeting-a', 'note:note-a', 'document:document-a']);
  });
});
