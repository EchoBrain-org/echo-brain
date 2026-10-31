import type { ListItem, ProjectSummary } from '../../shared/protocol.js';
import { dateTime, documentDetail, initial, startOfDay } from '../format.js';
import { monthDay } from '../needs.js';
import { Tile } from './altitude.js';
import { Calendar, Note, Page } from './icons.js';

/**
 * Only me's row (One place to look v1): Home's flat row, with a grey shape
 * for what it is, its title, a tile for each project it is filed in, and how
 * long ago it was added. Words are in each mark's hover.
 */

/** What each kind is called, and its shape. Both meeting kinds are a meeting. */
const KINDS: Readonly<Record<ListItem['ref']['kind'], { word: string; Icon: typeof Note }>> = {
  note: { word: 'Note', Icon: Note }, meeting: { word: 'Meeting', Icon: Calendar }, imported_meeting: { word: 'Meeting', Icon: Calendar },
  document: { word: 'File', Icon: Page },
};

/** Tiles a row shows before "+N"; an item can be filed in up to 20 projects (ADR-0049). */
const TILES = 3;
const DAY = 86_400_000;
/**
 * Today's time on a 24-hour clock, "09:30", so it fits the age's column. Made on each call: a formatter keeps the time zone
 * it was made in, and ECHO runs for days, across a move to another zone.
 */
const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

/** How long ago something was added, short: the time today ("10:12"), days under a week ("3d"), then the day ("Sep 18"). */
export function shortAge(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const today = startOfDay(now);
  if (time >= today) return new Date(time).toLocaleTimeString('en-US', CLOCK);
  // Whole days between midnights, rounded over a clock change.
  const days = Math.round((today - startOfDay(time)) / DAY);
  return days < 7 ? `${days}d` : monthDay(iso) ?? '';
}

/**
 * Your projects by name, for rows that carry names only (ADR-0024 N-20): a
 * name two of them share is null, as nothing says which one a row means.
 */
export function projectsByName(projects: readonly ProjectSummary[]): ReadonlyMap<string, ProjectSummary | null> {
  const byName = new Map<string, ProjectSummary | null>();
  for (const project of projects) byName.set(project.name, byName.has(project.name) ? null : project);
  return byName;
}

/** A filed project's tile: in its hue, as the sidebar draws it, when the name is one project of yours; else neutral. */
function FiledTile({ name, project }: { name: string; project: ProjectSummary | null }) {
  return project ? <Tile project={project} /> : <span class="alt-tile only-me-unplaced" aria-hidden="true">{initial(name)}</span>;
}

export function OnlyMeRow({ item, byName, now, onOpen }: {
  item: ListItem; byName: ReadonlyMap<string, ProjectSummary | null>; now: number; onOpen: () => void;
}) {
  const { word, Icon } = KINDS[item.ref.kind];
  const names = item.projects;
  const added = `Added ${dateTime(item.added_at)}`;
  const filed = names.length > 0 ? names.join(', ') : undefined;
  const label = [`${word}: ${item.title}`, filed && `Filed in ${filed}`, added].filter(Boolean).join('. ');
  return (
    <button type="button" class="only-me-row" data-testid="only-me-row" data-kind={item.ref.kind} aria-label={label} onClick={onOpen}>
      <span class="only-me-kind" data-testid="only-me-kind" title={item.document ? `${word} · ${documentDetail(item.document)}` : word}><Icon /></span>
      <span class="only-me-title" data-testid="only-me-title">{item.title}</span>
      <span class="only-me-tiles" data-testid="only-me-tiles" title={filed}>
        {names.slice(0, TILES).map((name, index) => <FiledTile key={index} name={name} project={byName.get(name) ?? null} />)}
        {names.length > TILES && <span class="only-me-tiles-more" data-testid="only-me-tiles-more">+{names.length - TILES}</span>}
      </span>
      <span class="only-me-age" data-testid="only-me-age" title={added}>{shortAge(item.added_at, now)}</span>
    </button>
  );
}
