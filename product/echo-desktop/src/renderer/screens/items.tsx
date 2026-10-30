import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ListItem, Visibility } from '../../shared/protocol.js';
import { documentDetail, when } from '../format.js';
import { Calendar, Globe, Lock, Note, Page } from './icons.js';

/** Who can read a row, when it is not its projects' members. A project row keeps the place, so the times line up. */
function Mark({ visibility }: { visibility: Visibility }) {
  if (visibility === 'only-me') return <span class="mark" title="Only me" aria-label="Only me"><Lock /></span>;
  if (visibility === 'team') return <span class="mark" title="Organization" aria-label="Organization"><Globe /></span>;
  return <span class="mark" aria-hidden="true" />;
}

const ICONS = { imported_meeting: Calendar, note: Note, document: Page, meeting: Calendar };

/**
 * One row: what kind it is, its title (a document's kind and size under it),
 * the names of your projects it is filed in, who can read it, and when it was
 * added. A project's own page leaves the projects out, says on a meeting's row
 * how many of its follow-ups are not closed ("4 follow-ups"), and marks a row
 * that arrived since your previous visit "New" for this visit (ADR-0047).
 * Only me leaves out who can read it (`mark`): every row there is only yours.
 */
export function ItemRow({ item, testid, projects, mark = true, badge, fresh = false, onOpen }: {
  item: ListItem; testid: string; projects: boolean; mark?: boolean; badge?: string | null | undefined; fresh?: boolean; onOpen: () => void;
}) {
  const Icon = ICONS[item.ref.kind];
  return (
    <button type="button" class="row item-row" data-testid={testid} data-kind={item.ref.kind} onClick={onOpen}>
      <span class="item-icon" aria-hidden="true"><Icon /></span>
      {item.document ? (
        <span class="lines">
          <span class="name">{item.title}</span>
          <span class="detail" data-testid="document-detail">{documentDetail(item.document)}</span>
        </span>
      ) : <span class="name">{item.title}</span>}
      {fresh && <span class="new-tag" data-testid="item-new">New</span>}
      {projects && item.projects.length > 0 && <span class="projects" data-testid="item-projects">{item.projects.join(', ')}</span>}
      {badge && <span class="open-count" data-testid="item-follow-ups">{badge}</span>}
      {mark && <Mark visibility={item.visibility} />}
      <span class="meta">{when(item.added_at)}</span>
    </button>
  );
}

/** Where each list was scrolled when it last left the screen, by its key (a few at most). */
const keptPlaces = new Map<string, number>();
const KEPT_PLACES_MAX = 20;

/**
 * Where a list was scrolled on this visit to it (`key`: one per visit). Back
 * from an item or an answer, or ECHO coming back, returns there; opening it
 * again starts at the top. `returned` says, from the first layout on, whether
 * this showing came back to a kept place.
 */
export function useKeptPlace(key: string | undefined): { column: RefObject<HTMLDivElement>; returned: RefObject<boolean> } {
  const column = useRef<HTMLDivElement>(null);
  const returned = useRef(false);
  useLayoutEffect(() => {
    const element = column.current;
    if (!element || key === undefined) return;
    const top = keptPlaces.get(key);
    returned.current = top !== undefined;
    element.scrollTop = top ?? 0;
    return () => {
      keptPlaces.delete(key);
      keptPlaces.set(key, element.scrollTop);
      for (const old of keptPlaces.keys()) { if (keptPlaces.size <= KEPT_PLACES_MAX) break; keptPlaces.delete(old); }
    };
  }, [column.current, key]);
  return { column, returned };
}
