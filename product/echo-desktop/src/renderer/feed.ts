// A list read again over what it already shows: Mine, or a project's notes,
// documents and meetings, newest first, a page at a time.

function time(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * A project renamed: every row shown that names it, older rows More loaded
 * included, names it by its new name. Rows carry names only, so the caller
 * applies this only while no other project of yours had the old name.
 */
export function renamedProject<T extends { projects: readonly string[] }>(items: readonly T[], from: string, to: string): T[] {
  return items.map(item => item.projects.includes(from) ? { ...item, projects: item.projects.map(name => name === from ? to : name) } : item);
}

/**
 * A list's first page read again, over what already shows: the page leads,
 * and older rows loaded with More stay, with the cursor that reaches past
 * them. A shown row the page should hold but does not has left the list.
 */
export function reread<T extends { added_at: string }>(
  shown: { items: readonly T[]; next: string | null }, first: { items: readonly T[]; next: string | null }, key: (item: T) => string,
): { items: T[]; next: string | null } {
  // The page reaches the end: the list is all of it.
  if (first.next === null) return { items: [...first.items], next: null };
  const seen = new Set(first.items.map(key));
  // Rows after the page's last: older, or added at the same instant with a ref that sorts after it, as the Authority orders them.
  const last = first.items.at(-1);
  const boundary = last ? time(last.added_at) : Infinity;
  const lastKey = last ? key(last) : '';
  const older = shown.items.filter(item => !seen.has(key(item)) && (time(item.added_at) < boundary || (time(item.added_at) === boundary && key(item) > lastKey)));
  return older.length > 0 ? { items: [...first.items, ...older], next: shown.next } : { items: [...first.items], next: first.next };
}
