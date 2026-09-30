import { message } from '../messages.js';
import { moreList, openListItem, retryList, type State } from '../store.js';
import { ItemRow, useKeptPlace } from './items.js';

/**
 * Mine: only what you added (notes you saved, documents you uploaded and
 * meetings you approved), newest first, with the names of your projects each
 * is filed in. A place to see and ask, never to capture: with nothing in it
 * the page stays blank.
 */
export function Mine({ state }: { state: State }) {
  const list = state.list?.scope.kind === 'mine' ? state.list : null;
  const column = useKeptPlace(list?.opened);
  if (list?.failure && list.items.length === 0 && !list.next) {
    return (
      <div class="column center" data-testid="mine-error">
        <div class="error">{message(list.failure)}</div>
        <button type="button" class="link-button" data-testid="mine-retry" disabled={list.loading} onClick={() => void retryList()}>Try again</button>
      </div>
    );
  }
  return (
    <div class="column" data-testid="mine" aria-busy={list?.loading ?? true} ref={column}>
      {list?.items.map(item => (
        <ItemRow key={`${item.ref.kind}:${item.ref.id}`} item={item} testid="mine-row" projects onOpen={() => void openListItem(item)} />
      ))}
      {list?.next && (
        <button type="button" class="link-button more" data-testid="mine-more" disabled={list.loading} onClick={() => void moreList()}>More</button>
      )}
      {list?.failure && (
        <div class="error more" data-testid="mine-failure">
          {message(list.failure)}
          <button type="button" class="link-button" data-testid="mine-retry" disabled={list.loading} onClick={() => void retryList()}>Try again</button>
        </div>
      )}
    </div>
  );
}
