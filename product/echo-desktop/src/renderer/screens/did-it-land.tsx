import { useEffect, useRef } from 'preact/hooks';
import type { OpenItemView } from '../../shared/protocol.js';
import { message } from '../messages.js';
import { checkedAgo, itemCount, itemNames, landedGroups, landedNote, markable, shortNames } from '../needs.js';
import { markLandedDone, moreDidItLand, openDidItLand, tickLanded, type DidItLandState } from '../store.js';
import { Chip } from './send.js';

/** One item: its name, what it says now and why it is in its part, and its owner. A landed item you may close has its tick. */
function Line({ page, item, name, tick }: { page: DidItLandState; item: OpenItemView; name: string; tick: boolean }) {
  const note = landedNote(item);
  const [owner] = shortNames([item.owner.name]);
  const words = <span class="landed-text"><b>{name}</b>{note && <span class="faint"> {note}</span>}</span>;
  const chip = <Chip person={item.owner} label={owner ?? item.owner.name} />;
  if (tick) {
    return (
      <label class="check landed-line" data-testid="landed-item">
        <input type="checkbox" checked={!page.unticked[item.item_id]} disabled={page.busy} onChange={() => tickLanded(item.item_id)} />
        {words}{chip}
      </label>
    );
  }
  return (
    <div class={`landed-line${item.check?.verdict === 'unreadable' ? ' unreadable' : ''}`} data-testid="landed-item">
      <span class="landed-gap" aria-hidden="true" />{words}{chip}
    </div>
  );
}

/** One part of the card: "Landed · 1", its items under it; none when it has none. */
function Part({ page, label, tone, items, names }: {
  page: DidItLandState; label: string; tone: 'landed' | 'open' | 'unreadable'; items: readonly OpenItemView[]; names: ReadonlyMap<string, string>;
}) {
  if (items.length === 0) return null;
  const heading = `${label} · ${items.length}`;
  return (
    <section class="decision-section" aria-label={heading}>
      <div class={`landed-head ${tone}`}>{heading}</div>
      {items.map(item => <Line key={item.item_id} page={page} item={item} name={names.get(item.item_id)!} tick={tone === 'landed' && item.can.set_state} />)}
    </section>
  );
}

/**
 * Did it land? (canvas 9.4; ruling 36): the open items of your own, of a
 * decision or of a project, by what ECHO saw when it last checked them.
 * Landed ones come ticked, and "Mark N done" closes those you may close. The
 * decided line shows when the items are one decision's.
 */
export function DidItLand({ page }: { page: DidItLandState }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('.decision-foot button:not(:disabled)')?.focus({ preventScroll: true }); }, [page.loading]);
  const groups = landedGroups(page.items);
  const names = itemNames(page.items);
  const marked = markable(page.items, page.unticked);
  const decided = page.scope === 'record' ? page.items.find(item => item.decision)?.decision?.first_line : null;
  const read = !page.loading || page.items.length > 0;
  return (
    <div class="column decision" ref={box}>
      <article class="decision-card" data-testid="did-it-land" aria-labelledby="did-it-land-ask" aria-busy={page.loading || page.busy}>
        <h1 id="did-it-land-ask" class="decision-ask">Did it land?</h1>
        <div class="decision-from">
          <b>{page.title ?? 'Your items'}</b>{page.checked_at && ` · checked ${checkedAgo(page.checked_at)}`}{read && ` · ${itemCount(page.open)}`}
        </div>
        {decided && <div class="decision-line">{decided}</div>}
        {page.loading && page.items.length === 0 && <span class="asking" aria-hidden="true"><i /><i /><i /></span>}
        <Part page={page} label="Landed" tone="landed" items={groups.landed} names={names} />
        <Part page={page} label="Still open" tone="open" items={groups.open} names={names} />
        <Part page={page} label="Couldn't read" tone="unreadable" items={groups.unreadable} names={names} />
        {!page.loading && !page.failure && page.items.length === 0 && <div class="notice">Nothing open to check</div>}
        {page.next && <button type="button" class="link-button more" disabled={page.loading} onClick={() => void moreDidItLand()}>More</button>}
        {page.failure && (
          <div class="error">
            {message(page.failure)}
            <button type="button" class="link-button" disabled={page.loading}
              onClick={() => void (page.items.length > 0 ? moreDidItLand() : openDidItLand(page.scope, page.id, page.title))}>Try again</button>
          </div>
        )}
        {page.markFailure && <div class="error" aria-live="polite">{page.markFailure}</div>}
        {groups.landed.some(item => item.can.set_state) && (
          <div class="decision-foot">
            <button type="button" class="primary-button small" disabled={page.busy || marked.length === 0} onClick={() => void markLandedDone()}>
              Mark {marked.length} done
            </button>
            {page.busy && <span class="asking"><i /><i /><i /><span>Sending</span></span>}
          </div>
        )}
      </article>
    </div>
  );
}
