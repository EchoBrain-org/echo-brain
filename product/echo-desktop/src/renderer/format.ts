const COLORS = ['#6B5A3E', '#4E5A6B', '#5A6B4E', '#6B4E5A'];

/** A stable circle color per project. */
export function colorFor(key: string): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

export function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? '?';
}

/** A person's circle: the first letters of their first two names. */
export function initials(name: string): string {
  const letters = name.trim().split(/\s+/u).slice(0, 2).map(part => [...part][0]?.toUpperCase() ?? '').join('');
  return letters === '' ? '?' : letters;
}

const TYPES: Record<'pdf' | 'word' | 'markdown' | 'text', string> = { pdf: 'PDF', word: 'Word', markdown: 'Markdown', text: 'Text' };

/** A document's kind and size, the way its row shows them: "PDF · 2.1 MB". */
export function documentDetail(document: { type: 'pdf' | 'word' | 'markdown' | 'text'; size: number }): string {
  return `${TYPES[document.type]} · ${bytes(document.size)}`;
}

/** 2h, Yesterday, Mon, Sep 18: short, like a message list. */
export function when(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const date = new Date(time);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (time >= startOfToday) return `${Math.round(minutes / 60)}h`;
  if (time >= startOfToday - 86_400_000) return 'Yesterday';
  if (time >= startOfToday - 6 * 86_400_000) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A file's size the way Finder shows it: 15 bytes, 340 KB, 2.1 MB. */
export function bytes(size: number): string {
  if (size < 1000) return `${size} bytes`;
  if (size < 999_500) return `${Math.round(size / 1000)} KB`;
  return `${(size / 1_000_000).toFixed(1)} MB`;
}

/** A piece of a match's text, and whether it is one of the query's words. */
export interface Marked { readonly text: string; readonly hit: boolean }

function wordsPattern(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  const escaped = [...terms].sort((a, b) => b.length - a.length).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'giu');
}

/** A match's text in pieces, the query's words marked wherever they appear. */
export function marked(text: string, terms: readonly string[]): Marked[] {
  const pattern = wordsPattern(terms);
  if (!pattern) return [{ text, hit: false }];
  const pieces: Marked[] = [];
  let from = 0;
  for (const found of text.matchAll(pattern)) {
    if (found[0] === '') continue;
    if (found.index > from) pieces.push({ text: text.slice(from, found.index), hit: false });
    pieces.push({ text: found[0], hit: true });
    from = found.index + found[0].length;
  }
  if (from < text.length) pieces.push({ text: text.slice(from), hit: false });
  return pieces;
}

/**
 * The words around the first of the query's words in an excerpt, as
 * "…pricing tiers…", for a match whose title does not show why it matched.
 * Null when the excerpt has none of them.
 */
export function snippet(excerpt: string, terms: readonly string[]): string | null {
  const pattern = wordsPattern(terms);
  const line = excerpt.replace(/\s+/g, ' ').trim();
  const found = pattern ? pattern.exec(line) : null;
  if (!found) return null;
  const at = found.index;
  // A few words either side, cut between words.
  const before = line.indexOf(' ', at - 24);
  const start = at <= 24 ? 0 : before >= 0 && before < at ? before + 1 : at;
  const after = line.indexOf(' ', at + found[0].length + 16);
  const end = after < 0 ? line.length : after;
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

/**
 * A meeting's time as the source pane shows it, "Sep 15, 2026, 10:00 AM PDT":
 * in the meeting's own time zone when it has one, and without the time for an
 * all-day meeting.
 */
export function meetingTime(iso: string, timeZone?: string, allDay = false): string {
  const options: Intl.DateTimeFormatOptions = allDay
    ? { year: 'numeric', month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat(undefined, timeZone ? { ...options, timeZone } : options).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date); // a time zone this computer does not know
  }
}

/** A date and time, "Sep 28, 3:00 PM": when an invitation stops working. */
export function dateTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
