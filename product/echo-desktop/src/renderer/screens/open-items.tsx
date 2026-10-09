import type { OpenItemView } from '../../shared/protocol.js';
import { colorFor, initials, when } from '../format.js';
import { message } from '../messages.js';
import { itemChange, itemTitle, STAGES, stageSince } from '../needs.js';
import { moreOpenItems, openOpenItems, type OpenItemsState } from '../store.js';

/** Items by who they wait on, each owner once, in the order of their oldest item. */
function byOwner(items: readonly OpenItemView[]): { id: string; name: string; items: OpenItemView[] }[] {
  const groups = new Map<string, { id: string; name: string; items: OpenItemView[] }>();
  for (const item of items) {
    const group = groups.get(item.owner.membership_id) ?? { id: item.owner.membership_id, name: item.owner.name, items: [] };
    group.items.push(item);
    groups.set(group.id, group);
  }
  return [...groups.values()];
}

/**
 * A decision's or a project's open items (canvas 9.6, 9.7), grouped by owner,
 * oldest first, each with its stage and how long it has been there. Read-only
 * in this version: an item is closed from its owner's Home.
 */
export function OpenItems({ page }: { page: OpenItemsState }) {
  const groups = byOwner(page.items);
  return (
    <div class="column open-items" data-testid="open-items" aria-busy={page.loading}>
      <div class="open-items-head">
        <h1>Open items</h1>
        <div class="notice">{page.title}</div>
      </div>
      {groups.map(group => (
        <section key={group.id} class="open-items-group" aria-label={group.name}>
          <div class="open-items-owner">
            <span class="face" style={{ background: colorFor(group.id) }} aria-hidden="true">{initials(group.name)}</span>
            <span class="section-label">{group.name}</span>
          </div>
          {group.items.map(item => {
            const change = itemChange(item);
            return (
              <div class="open-item" data-testid="open-item" data-state={item.state} key={item.item_id}>
                <span class="open-item-text">
                  <span class="open-item-title">{itemTitle(item)}</span>
                  {change && <span class="open-item-change">{change}</span>}
                </span>
                <span class="open-item-side">
                  <span class={`open-item-stage ${item.state}`}>{STAGES[item.state]}</span>
                  <span class="open-item-when">{when(stageSince(item))}</span>
                </span>
              </div>
            );
          })}
        </section>
      ))}
      {!page.loading && !page.failure && page.items.length === 0 && <div class="notice">Nothing here yet.</div>}
      {page.next && <button type="button" class="link-button more" disabled={page.loading} onClick={() => void moreOpenItems()}>More</button>}
      {page.failure && (
        <div class="error more">
          {message(page.failure)}
          <button type="button" class="link-button" disabled={page.loading}
            onClick={() => void (page.items.length > 0 ? moreOpenItems() : openOpenItems(page.scope, page.id, page.title))}>Try again</button>
        </div>
      )}
    </div>
  );
}
