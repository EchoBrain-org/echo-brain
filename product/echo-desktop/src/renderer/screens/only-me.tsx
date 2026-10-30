import { message } from '../messages.js';
import { altitudeProjects, moreList, openListItem, retryList, type State } from '../store.js';
import { Caret } from './icons.js';
import { useKeptPlace } from './items.js';
import { OnlyMeRow, projectsByName } from './only-me-row.js';

/**
 * Only me, from the sidebar (ADR-0049, One place to look v1): everything only
 * you can read (notes, files and approved meetings whose only reader is you),
 * filed in a project or not, newest first, in one flat list. A filed row shows
 * a tile for each of your projects it is in, named on hover; no row carries a
 * lock, as every one is only yours. With nothing in it the page stays blank.
 */
export function OnlyMe({ state }: { state: State }) {
  const list = state.list?.scope.kind === 'only-me' ? state.list : null;
  const { column } = useKeptPlace(list ? `only-me:${list.opened}` : undefined);
  if (list?.failure && list.items.length === 0 && !list.next) {
    return (
      <div class="column center" data-testid="only-me-error">
        <div class="error">{message(list.failure)}</div>
        <button type="button" class="link-button" data-testid="only-me-retry" disabled={list.loading} onClick={() => void retryList()}>Try again</button>
      </div>
    );
  }
  // Rows name projects only: each tile finds its project among every one of yours Home can see.
  const byName = projectsByName(altitudeProjects(state));
  const now = Date.now();
  return (
    <div class="column only-me" data-testid="only-me" aria-busy={list?.loading ?? true} ref={column}>
      {list?.items.map(item => (
        <OnlyMeRow key={`${item.ref.kind}:${item.ref.id}`} item={item} byName={byName} now={now} onOpen={() => void openListItem(item)} />
      ))}
      {list?.next && (
        <button type="button" class="only-me-more" data-testid="only-me-more" disabled={list.loading} onClick={() => void moreList()}><Caret /><span>More</span></button>
      )}
      {list?.failure && (
        <div class="error more" data-testid="only-me-failure">
          {message(list.failure)}
          <button type="button" class="link-button" data-testid="only-me-retry" disabled={list.loading} onClick={() => void retryList()}>Try again</button>
        </div>
      )}
    </div>
  );
}
