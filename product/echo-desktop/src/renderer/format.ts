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

export function clock(time: number): string {
  return new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** A file's size the way Finder shows it: 15 bytes, 340 KB, 2.1 MB. */
export function bytes(size: number): string {
  if (size < 1000) return `${size} bytes`;
  if (size < 999_500) return `${Math.round(size / 1000)} KB`;
  return `${(size / 1_000_000).toFixed(1)} MB`;
}
