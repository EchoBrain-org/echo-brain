import { useEffect, useRef } from 'preact/hooks';
import type { OpenItemView } from '../../shared/protocol.js';
import { message } from '../messages.js';
import { closable, itemLabels, itemNames, shortNames, STATUS, statusGroups, statusOf, statusSubline } from '../needs.js';
import { closeAllMatching, closeMatching, moreItemStatus, openItemStatus, type ItemStatusState } from '../store.js';
import { Chip } from './open-items.js';

/**
 * One item: its title and what the decision needs, how it stands since ECHO
 * last checked it, and its owner. A match you may close has a small Close,
 * named apart from every other item's (R37).
 */
function Line({ page, item, label, name }: { page: ItemStatusState; item: OpenItemView; label: string; name: string }) {
  const status = statusOf(item);
  const [owner] = shortNames([item.owner.name]);
  const closes = status === 'landed' && item.can.set_state;
  return (
    <div class={`status-line ${status}`} data-testid="status-item">
      <span class="status-text"><b>{label}</b>{item.expected !== null && <span class="faint"> · {item.expected}</span>}</span>
      <span class={`status-word ${status}`}>{STATUS[status]}</span>
      {closes && (
        <button type="button" class="need-open" aria-label={`Close: ${name}`} disabled={page.busy} onClick={() => void closeMatching(item)}>Close</button>
      )}
      <Chip person={item.owner} label={owner ?? item.owner.name} />
    </div>
  );
}

/**
 * Your open items (R68): a status view of the open items of your own, of a
 * decision or of a project, each as ECHO last found it: matches first, then
 * not updated or changed, then what ECHO couldn't read or has not checked.
 * Your own items from more than one decision are grouped by decision. The
 * decided line shows when the items are one decision's. "Close all N that
 * match" closes every match you may close, when there are two or more.
 */
export function ItemStatus({ page }: { page: ItemStatusState }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }); }, [page.seq]);
  const groups = statusGroups(page.items, page.scope);
  const names = itemNames(page.items);
  const labels = itemLabels(page.items);
  const matching = closable(page.items);
  const heading = page.scope === 'mine' ? 'Your open items' : page.scope === 'project' && page.title !== null ? `Open items · ${page.title}` : 'Open items';
  // No count until a read of the items succeeded: a failed first read shows its error, not "0 open" (D7).
  const subline = statusSubline(page.open, page.checked_at);
  const decided = page.scope === 'record' ? page.items.find(item => item.decision)?.decision?.first_line : null;
  return (
    <div class="column decision" ref={box}>
      <article class="decision-card" data-testid="item-status" aria-labelledby="item-status-head" aria-busy={page.loading || page.busy}>
        <h1 id="item-status-head" class="decision-ask" tabIndex={-1}>{heading}</h1>
        {subline !== null && <div class="decision-from">{subline}</div>}
        {decided && <div class="decision-line">{decided}</div>}
        {page.loading && page.items.length === 0 && <span class="asking" aria-hidden="true"><i /><i /><i /></span>}
        {groups.map(group => group.items.length > 0 && (
          <section key={group.key} class="decision-section" aria-label={group.header ?? heading}>
            {group.header && <div class="status-group-head" data-testid="status-group-head">{group.header}</div>}
            {group.items.map(item => (
              <Line key={item.item_id} page={page} item={item} label={labels.get(item.item_id)!} name={names.get(item.item_id)!} />
            ))}
          </section>
        ))}
        {!page.loading && !page.failure && page.items.length === 0 && <div class="notice">No open items</div>}
        {page.next && <button type="button" class="link-button more" disabled={page.loading} onClick={() => void moreItemStatus()}>More</button>}
        {page.failure && (
          <div class="error">
            {message(page.failure)}
            <button type="button" class="link-button" disabled={page.loading}
              onClick={() => void (page.items.length > 0 ? moreItemStatus() : openItemStatus(page.scope, page.id, page.title))}>Try again</button>
          </div>
        )}
        {page.closeFailure && <div class="error" aria-live="polite">{page.closeFailure}</div>}
        {matching.length >= 2 && (
          <div class="status-foot">
            <button type="button" class="need-open" disabled={page.busy} onClick={() => void closeAllMatching()}>Close all {matching.length} that match</button>
            {page.busy && <span class="asking"><i /><i /><i /><span>Sending</span></span>}
          </div>
        )}
      </article>
    </div>
  );
}
