import { message } from '../messages.js';
import { moreList, openListItem, retryList, type State } from '../store.js';
import { ItemRow, useKeptPlace } from './items.js';

/**
 * Only me, from Home's footer (ADR-0049): everything only you can read
 * (notes, files and approved meetings whose only reader is you), filed in a
 * project or not, newest first. A filed row names your projects it is in; no
 * row carries a lock, as every one is only yours. With nothing in it the page
 * stays blank.
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
  return (
    <div class="column" data-testid="only-me" aria-busy={list?.loading ?? true} ref={column}>
      {list?.items.map(item => (
        <ItemRow key={`${item.ref.kind}:${item.ref.id}`} item={item} testid="only-me-row" projects mark={false} onOpen={() => void openListItem(item)} />
      ))}
      {list?.next && (
        <button type="button" class="link-button more" data-testid="only-me-more" disabled={list.loading} onClick={() => void moreList()}>More</button>
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
