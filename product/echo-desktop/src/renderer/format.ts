/** The hues a project's or a person's mark can take: styles.css's --id-1 to --id-6, tinted for each appearance. */
const HUES = 6;

/**
 * A stable mark per project or person: its letters in its hue, on a wash of
 * that hue over the workspace, opaque so overlapping faces stay apart.
 */
export function identity(key: string): { background: string; color: string } {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const hue = (hash % HUES) + 1;
  return { background: `linear-gradient(var(--id-${hue}-bg), var(--id-${hue}-bg)), var(--ink)`, color: `var(--id-${hue})` };
}

/** Text cut to `max` characters, ending "…" when it was longer. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
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

/** Midnight today, here. */
export function startOfDay(now: number): number {
  const today = new Date(now);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
}

/** 2h, Yesterday, Mon, Sep 18: short, like a message list. */
export function when(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const date = new Date(time);
  const startOfToday = startOfDay(now);
  if (time >= startOfToday) return `${Math.round(minutes / 60)}h`;
  if (time >= startOfToday - 86_400_000) return 'Yesterday';
  if (time >= startOfToday - 6 * 86_400_000) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** How an Ask turn's row says when it was asked: the time ("3:41 PM"), the day ("Oct 14"), and the day of another year ("Oct 14, 2025"). */
const ASKED_TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const ASKED_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const ASKED_DAY_AND_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Whether an Ask turn was asked today, here. */
export function askedToday(iso: string, now = Date.now()): boolean {
  return Date.parse(iso) >= startOfDay(now);
}

/** When an Ask turn was asked, as its row says it: the time for today ("3:41 PM"), else the day ("Oct 14"), with its year when not this year's. */
export function askedWhen(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  if (time >= startOfDay(now)) return ASKED_TIME.format(date);
  return (date.getFullYear() === new Date(now).getFullYear() ? ASKED_DAY : ASKED_DAY_AND_YEAR).format(date);
}

/** A file's size the way Finder shows it: 15 bytes, 340 KB, 2.1 MB. */
export function bytes(size: number): string {
  if (size < 1000) return `${size} bytes`;
  if (size < 999_500) return `${Math.round(size / 1000)} KB`;
  return `${(size / 1_000_000).toFixed(1)} MB`;
}

/** A piece of a match's text, and whether it is one of the query's words. */
interface Marked { readonly text: string; readonly hit: boolean }

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
 * in the meeting's own time zone when it has one. An all-day meeting is its
 * date alone, the UTC date its time names, so it is the same day wherever the
 * meeting or this computer is.
 */
export function meetingTime(iso: string, timeZone?: string, allDay = false): string {
  const options: Intl.DateTimeFormatOptions = allDay
    ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat(undefined, timeZone && !allDay ? { ...options, timeZone } : options).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date); // a time zone this computer does not know
  }
}

/**
 * A date and time, "Sep 28, 3:00 PM": when an invitation stops working. A
 * whole day (`allDay`) is its UTC date alone, "Sep 28", the same day anywhere.
 */
export function dateTime(iso: string, allDay = false): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : new Date(time).toLocaleString(undefined, allDay ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
