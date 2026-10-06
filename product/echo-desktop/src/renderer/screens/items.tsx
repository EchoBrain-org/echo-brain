import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ListItem, Visibility } from '../../shared/protocol.js';
import { documentDetail, when } from '../format.js';
import { Calendar, Globe, Lock, Note, Page } from './icons.js';

/** Who can read a row, when it is not its projects' members. A project row keeps the place, so the times line up. */
export function Mark({ visibility }: { visibility: Visibility }) {
  if (visibility === 'only-me') return <span class="mark" title="Only me" aria-label="Only me"><Lock /></span>;
  if (visibility === 'team') return <span class="mark" title="Organization" aria-label="Organization"><Globe /></span>;
  return <span class="mark" aria-hidden="true" />;
}

const ICONS = { imported_meeting: Calendar, note: Note, document: Page, meeting: Calendar };

/**
 * One row: what kind it is, its title (a document's kind and size under it),
 * the names of your projects it is filed in, who can read it, and when it was
 * added. A project's own page leaves the projects out.
 */
export function ItemRow({ item, testid, projects, onOpen }: { item: ListItem; testid: string; projects: boolean; onOpen: () => void }) {
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
      {projects && item.projects.length > 0 && <span class="projects" data-testid="item-projects">{item.projects.join(', ')}</span>}
      <Mark visibility={item.visibility} />
      <span class="meta">{when(item.added_at)}</span>
    </button>
  );
}

/**
 * Where a list was scrolled on this visit to its page. Back from an item or
 * an answer, or ECHO coming back, returns there; opening the page again
 * starts at the top.
 */
let keptPlace: { opened: number; top: number } | null = null;

export function useKeptPlace(opened: number | undefined) {
  const column = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = column.current;
    if (!element || opened === undefined) return;
    element.scrollTop = keptPlace?.opened === opened ? keptPlace.top : 0;
    return () => { keptPlace = { opened, top: element.scrollTop }; };
  }, [column.current, opened]);
  return column;
}
