import type { ProjectSummary } from '../../shared/protocol.js';
import { when } from '../format.js';
import { message } from '../messages.js';
import { closeReader, openItem, openProject, type State } from '../store.js';
import { Globe, Lock, Note } from './icons.js';

/** A project's items, one line each; choosing one reads it in place. */
export function Project({ state, project }: { state: State; project: ProjectSummary }) {
  const reader = state.reader;
  if (reader) {
    return (
      <article class="reader" data-testid="reader" aria-busy={reader.loading}>
        {reader.failure && <div class="error">{message(reader.failure)}</div>}
        {reader.content && (
          <>
            <h1>{reader.content.title}</h1>
            <div class="notice">{when(reader.content.received_at)}</div>
            <div class="body selectable" data-testid="reader-text">{reader.content.text}</div>
          </>
        )}
        <div class="actions"><button type="button" class="link-button" onClick={closeReader}>Back to {project.name}</button></div>
      </article>
    );
  }
  const feed = state.feed;
  if (feed?.failure && feed.items.length === 0) {
    return (
      <div class="column center" data-testid="feed-error">
        <div class="error">{message(feed.failure)}</div>
        <button type="button" class="link-button" onClick={() => void openProject(project)}>Try again</button>
      </div>
    );
  }
  if (feed && !feed.loading && feed.items.length === 0) {
    return <div class="column center" data-testid="feed-empty"><div>Nothing here yet</div></div>;
  }
  return (
    <div class="column" data-testid="feed" aria-busy={feed?.loading ?? true}>
      {feed?.items.map(item => (
        <button type="button" key={item.context_id} class="row item-row" data-testid="feed-row" onClick={() => void openItem(item)}>
          <span class="item-icon" aria-hidden="true"><Note /></span>
          <span class="name">{item.title}</span>
          {item.audience === 'only-me' && <span class="mark" title="Only you" aria-label="Only you"><Lock /></span>}
          {item.audience === 'team' && <span class="mark" title="Everyone" aria-label="Everyone"><Globe /></span>}
          <span class="meta">{when(item.received_at)}</span>
        </button>
      ))}
    </div>
  );
}
