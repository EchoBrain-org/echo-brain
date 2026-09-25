import type { ProjectSummary } from '../../shared/protocol.js';
import { when } from '../format.js';
import { message } from '../messages.js';
import { openItem, openProject, type State } from '../store.js';
import { Globe, Lock, Note } from './icons.js';

/** A project's items, one line each; choosing one reads it in place. */
export function Project({ state, project }: { state: State; project: ProjectSummary }) {
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
          {item.audience === 'only-me' && <span class="mark" title="Only me" aria-label="Only me"><Lock /></span>}
          {item.audience === 'team' && <span class="mark" title="Organization" aria-label="Organization"><Globe /></span>}
          <span class="meta">{when(item.received_at)}</span>
        </button>
      ))}
    </div>
  );
}
