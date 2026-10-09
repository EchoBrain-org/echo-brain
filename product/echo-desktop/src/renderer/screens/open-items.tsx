import { useEffect, useRef, useState } from 'preact/hooks';
import type { OpenItemView } from '../../shared/protocol.js';
import { externalSourceProvider } from '../answer.js';
import { colorFor, initials, when } from '../format.js';
import { message } from '../messages.js';
import { checkedAgo, itemChange, itemFrom, itemKind, itemTitle, STAGES, stageSince } from '../needs.js';
import { closeCheckedItem, moreOpenItems, openItemInTool, openOpenItems, type CheckCardState, type ItemsLine, type OpenItemsState, type State } from '../store.js';

/** A person, as a chip: their initials in their color, and their first name (Tell the owners?, Did it land?). */
export function Chip({ person, label }: { person: { membership_id: string; name: string }; label: string }) {
  return (
    <span class="owner-chip">
      <span class="face" style={{ background: colorFor(person.membership_id) }} aria-hidden="true">{initials(person.name)}</span>
      <span class="owner-chip-name">{label}</span>
    </span>
  );
}

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

/**
 * Open in Jira (or the item's own tool), only for an item ECHO opened for you
 * just now: the tool checks your access when it opens. Its name says which
 * item, as Done's does.
 */
export function OpenInTool({ state, item, name }: { state: State; item: OpenItemView; name: string }) {
  const [failed, setFailed] = useState(false);
  const source = item.reach === 'opened' ? item.current?.source : undefined;
  if (!source || !('permalink' in source)) return null;
  const label = `Open in ${externalSourceProvider(source, state.tools?.items)}`;
  return <>
    <button type="button" class="need-open" title={source.permalink} aria-label={`${label}: ${name}`}
      onClick={async () => { setFailed(false); setFailed(!(await openItemInTool(item))); }}>{label}</button>
    {failed && <span class="error need-error">The item could not be opened. Try again.</span>}
  </>;
}

/** A last check's verdict, on a Check row's item. */
const VERDICTS: Readonly<Record<NonNullable<OpenItemView['check']>['verdict'], string>> = {
  landed: 'Landed', still_open: 'Still open', changed: 'Not what was decided', unreadable: 'Couldn\'t read',
};

/**
 * The item a Check row opened (ruling 3): what it says now beside what the
 * decision requires of it, its last check ("Checked 2 h ago by Mina Patel"),
 * Open in Jira when ECHO opened it for you, and Done or Not relevant when you
 * may close it. Nothing closes before one is chosen.
 */
export function CheckCard({ state, card }: { state: State; card: CheckCardState }) {
  const box = useRef<HTMLDivElement>(null);
  // Its main control takes the focus, as Tell the owners?'s and Did it land?'s do.
  useEffect(() => { box.current?.querySelector<HTMLElement>('.decision-foot button:not(:disabled)')?.focus({ preventScroll: true }); }, [card.item.item_id]);
  const { item } = card;
  const title = itemTitle(item);
  const change = itemChange(item);
  const assignee = item.current?.assignee;
  return (
    <div class="column decision" ref={box}>
      <article class="decision-card" data-testid="check-card" aria-labelledby="check-title">
        <h1 id="check-title" class="decision-ask">{title}</h1>
        <div class="decision-from">{itemKind(item, state.tools?.items)}{assignee ? ` · now ${assignee}` : ''} · from <b>{itemFrom(item)}</b></div>
        {change && <div class="decision-line check-change">{change}</div>}
        {item.check && (
          <div class="check-verdict">
            <span class={`check-verdict-word ${item.check.verdict}`}>{VERDICTS[item.check.verdict]}</span>
            <span class="faint"> · Checked {checkedAgo(item.check.checked_at)} by {item.check.checked_by}</span>
          </div>
        )}
        <div class="decision-foot">
          {item.can.set_state && <>
            <button type="button" class="primary-button small" onClick={() => closeCheckedItem('done')}>Done</button>
            <button type="button" class="plain-button" onClick={() => closeCheckedItem('not_relevant')}>Not relevant</button>
          </>}
          <OpenInTool state={state} item={item} name={title} />
        </div>
      </article>
    </div>
  );
}

/**
 * Check now, at the end of a decision's or a project's line, the faint link
 * the canvas draws (9.6, 9.7): "Checking…" while its sweep is on its way,
 * "Nothing open to check", or "Check failed · Try again".
 */
export function CheckNow({ line, onCheck }: { line: ItemsLine; onCheck: () => void }) {
  if (line.check === 'checking') return <span class="items-line-check faint" role="status">Checking…</span>;
  if (line.check === 'nothing') return <span class="items-line-check faint" role="status">Nothing open to check</span>;
  if (line.check === 'failed') {
    return <span class="items-line-check" role="status"><span class="faint">Check failed · </span><button type="button" class="link-button" onClick={onCheck}>Try again</button></span>;
  }
  return <button type="button" class="need-open" onClick={onCheck}>Check now</button>;
}
