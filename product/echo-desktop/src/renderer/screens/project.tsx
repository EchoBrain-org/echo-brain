import { useLayoutEffect, useRef } from 'preact/hooks';
import type { FeedItem, ProjectSummary } from '../../shared/protocol.js';
import { mergedFeed, moreSources } from '../feed.js';
import { colorFor, documentDetail, initials, when } from '../format.js';
import { message } from '../messages.js';
import { moreFeed, openCompose, openDocument, openItem, openPeople, openProject, retryFeed, type State } from '../store.js';
import { Globe, Lock, Note, People, Plus } from './icons.js';

/** Who can read a row, when it is not the project's members. */
function Mark({ audience }: { audience: FeedItem['audience'] }) {
  if (audience === 'only-me') return <span class="mark" title="Only me" aria-label="Only me"><Lock /></span>;
  if (audience === 'team') return <span class="mark" title="Organization" aria-label="Organization"><Globe /></span>;
  return null;
}

/**
 * Where the feed was scrolled on this visit to the project. Back from an
 * original or an answer, or ECHO coming back, returns there; opening the
 * project again starts at the top.
 */
let savedPlace: { opened: number; top: number } | null = null;

/**
 * A project's one feed: its notes and documents, newest first, one line each,
 * and one More for older ones. Choosing a row reads it in place.
 */
export function Project({ state, project }: { state: State; project: ProjectSummary }) {
  const feed = state.feed;
  const column = useRef<HTMLDivElement>(null);
  const opened = feed?.opened;
  useLayoutEffect(() => {
    const element = column.current;
    if (!element || opened === undefined) return;
    element.scrollTop = savedPlace?.opened === opened ? savedPlace.top : 0;
    return () => { savedPlace = { opened, top: element.scrollTop }; };
  }, [column.current, opened]);
  const entries = feed ? mergedFeed(feed) : [];
  const more = feed ? moreSources(feed).length > 0 : false;
  if (feed?.failure && entries.length === 0 && !more) {
    return (
      <div class="column center" data-testid="feed-error">
        <div class="error">{message(feed.failure)}</div>
        <button type="button" class="link-button" onClick={() => void openProject(project)}>Try again</button>
      </div>
    );
  }
  if (feed && !feed.loading && entries.length === 0 && !more) {
    return (
      <div class="column center" data-testid="feed-empty">
        <button type="button" class="empty-capture" data-testid="empty-capture" onClick={() => openCompose()}>
          <span class="ring" aria-hidden="true"><Plus /></span>
          <span>Capture</span>
        </button>
      </div>
    );
  }
  return (
    <div class="column" data-testid="feed" aria-busy={feed?.loading ?? true} ref={column}>
      {entries.map(entry => entry.kind === 'note' ? (
        <button type="button" key={entry.item.context_id} class="row item-row" data-testid="feed-row" onClick={() => void openItem(entry.item)}>
          <span class="item-icon" aria-hidden="true"><Note /></span>
          <span class="name">{entry.item.title}</span>
          <Mark audience={entry.item.audience} />
          <span class="meta">{when(entry.item.received_at)}</span>
        </button>
      ) : (
        <button type="button" key={entry.item.document_id} class="row item-row" data-testid="feed-row" data-kind="document"
          onClick={() => void openDocument(entry.item)}>
          <span class="item-icon" aria-hidden="true"><Note /></span>
          <span class="lines">
            <span class="name">{entry.item.title}</span>
            <span class="detail" data-testid="document-detail">{documentDetail(entry.item)}</span>
          </span>
          <Mark audience={entry.item.audience} />
          <span class="meta">{when(entry.item.received_at)}</span>
        </button>
      ))}
      {more && (
        <button type="button" class="link-button more" data-testid="feed-more" disabled={feed?.loading} onClick={() => void moreFeed()}>More</button>
      )}
      {feed?.failure && (
        <div class="error more" data-testid="feed-failure">
          {message(feed.failure)}
          {feed.unread.length > 0 && (
            <button type="button" class="link-button" data-testid="feed-retry" disabled={feed.loading} onClick={() => void retryFeed()}>Try again</button>
          )}
        </div>
      )}
    </div>
  );
}

/** The project's members, up to three, in the title bar: they open People. */
export function MembersButton({ state }: { state: State }) {
  const route = state.route;
  const roster = route.page === 'project' && state.roster?.projectId === route.project.project_id ? state.roster : null;
  const shown = roster?.items.slice(0, 3) ?? [];
  return (
    <button type="button" class="members-button" data-testid="members-button" aria-label="Project members" onClick={() => void openPeople()}>
      {shown.length === 0 ? <People /> : shown.map(person => (
        <span key={person.membership_id} class="face" style={{ background: colorFor(person.membership_id) }} aria-hidden="true">
          {initials(person.display_name)}
        </span>
      ))}
    </button>
  );
}
