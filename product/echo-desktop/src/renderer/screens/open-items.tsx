import { useEffect, useRef, useState } from 'preact/hooks';
import type { OpenItemView } from '../../shared/protocol.js';
import { externalSourceProvider } from '../answer.js';
import { colorFor, initials, when } from '../format.js';
import { message } from '../messages.js';
import { approvedMeeting, checkLine, itemChange, itemKind, itemNow, itemTitle, itemWhose, monthDay, STAGES, stageSince } from '../needs.js';
import {
  checkReassign, closeCardItem, findReassignee, moreOpenItems, openItemInTool, openOpenItems, reassignCardItem, toggleReassign, type ItemCardState, type ItemsLine, type OpenItemsState,
  type State,
} from '../store.js';
import { CardHead, Face, Facts } from './card.js';

/** A person, as a chip: their initials in their color, and their first name (Tell the owners?, Your open items). */
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
 * item, as Done's does. On an item's card it is a button of its own.
 */
export function OpenInTool({ state, item, name, card = false }: { state: State; item: OpenItemView; name: string; card?: boolean }) {
  const [failed, setFailed] = useState(false);
  const source = item.reach === 'opened' ? item.current?.source : undefined;
  if (!source || !('permalink' in source)) return null;
  const label = `Open in ${externalSourceProvider(source, state.tools?.items)}`;
  return <>
    <button type="button" class={card ? 'outline-button' : 'need-open'} title={source.permalink} aria-label={`${label}: ${name}`}
      onClick={async () => { setFailed(false); setFailed(!(await openItemInTool(item))); }}>{label}</button>
    {failed && <span class="error need-error">The item could not be opened. Try again.</span>}
  </>;
}

/** Reassign…: the organization's people by name; picking one gives them the item. One that may have gone waits on Check status. */
function Reassign({ card, frozen }: { card: ItemCardState; frozen: boolean }) {
  const field = useRef<HTMLInputElement>(null);
  const check = useRef<HTMLButtonElement>(null);
  const picker = card.reassign!;
  // The field has the caret when it opens, and again when a pick did not go through; Check status, when it may have.
  useEffect(() => { (picker.unknown ? check : field).current?.focus(); }, [picker.failure, picker.unknown, picker.busy]);
  return (
    <div class="picker card-picker" data-testid="reassign-picker">
      <input ref={field} class="field small" type="search" autocomplete="off" maxLength={240} placeholder="Find a person" aria-label="Find a person"
        value={picker.query} disabled={frozen} onInput={event => void findReassignee((event.target as HTMLInputElement).value)} />
      <div class="picker-list" role="listbox" aria-label="People" aria-busy={picker.loading}>
        {picker.results.map(person => (
          <button type="button" role="option" aria-selected={picker.unknown?.membership_id === person.membership_id} class="picker-option" key={person.membership_id}
            disabled={frozen} onClick={() => void reassignCardItem(person)}>
            <Face name={person.display_name} keyed={person.membership_id} />
            <span class="name">{person.display_name}</span>
          </button>
        ))}
      </div>
      {picker.failure && <div class="error">{picker.failure}</div>}
      {!picker.loading && !picker.failure && picker.results.length === 0 && <div class="notice">{picker.query.trim() ? 'No one by that name' : 'No one to pick'}</div>}
      <div class="picker-foot">
        {picker.unknown
          ? <button type="button" class="link-button" data-testid="reassign-check" ref={check} disabled={picker.busy} onClick={() => void checkReassign()}>Check status</button>
          : <button type="button" class="link-button" disabled={picker.busy} onClick={toggleReassign}>Cancel</button>}
      </div>
    </div>
  );
}

/** "Oct 13": when the item was sent, for its card's top line. */
function sentOn(item: OpenItemView, mine: boolean): string | null {
  const day = item.sent_at ? monthDay(item.sent_at) : null;
  return day === null ? null : mine ? `sent to you ${day}` : `you sent it ${day}`;
}

/**
 * The item a changed item's row opened (ruling 3; R67): Update when it is
 * yours, Review when it is someone else's. On the left, what it says now
 * beside what the decision needs, the decision it came from, and ECHO's last
 * check; on the right, its facts, Mark updated and No change needed when you
 * may close it, Open in its tool, and Reassign… when you may. Nothing closes
 * before one is chosen.
 */
export function ItemCard({ state, card }: { state: State; card: ItemCardState }) {
  const box = useRef<HTMLDivElement>(null);
  // Its main control takes the focus, as Tell the owners?'s does.
  useEffect(() => { box.current?.querySelector<HTMLElement>('.card-panel button:not(:disabled)')?.focus({ preventScroll: true }); }, [card.item.item_id]);
  const { item } = card;
  const me = state.status?.account?.membership_id ?? null;
  const mine = me === null || item.owner.membership_id === me;
  const title = itemTitle(item);
  const changed = item.check?.verdict === 'changed';
  const headline = !mine && changed ? `${title} changed, but still doesn’t match`
    : item.relation === null ? `${title} may need updating` : `${title} doesn’t match the decision yet`;
  const sent = sentOn(item, mine);
  const checked = checkLine(item.check);
  const current = item.current;
  const { decision } = item;
  const assignable = item.can.assign;
  // Reassign… sending, or maybe sent: nothing else is sent from the card until Check status reads the item.
  const frozen = card.reassign?.busy === true || card.reassign?.unknown !== undefined;
  // Reassign… closed (Cancel, Escape): the caret goes back to its button.
  const picking = Boolean(card.reassign);
  const opened = useRef(false);
  useEffect(() => {
    if (picking) { opened.current = true; return; }
    if (opened.current) box.current?.querySelector<HTMLElement>('[data-testid="reassign"]')?.focus({ preventScroll: true });
  }, [picking]);
  return (
    <div class="column card" ref={box}>
      <div class="card-page" data-testid="item-card">
        <article class="card-main" aria-labelledby="item-card-title">
          <CardHead kind={mine ? 'update' : 'review'} verb={mine ? 'Update' : 'Review'} id="item-card-title" title={headline}
            where={<>{itemKind(item, state.tools?.items)} · {itemWhose(item, me)}{sent ? ` · ${sent}` : ''}</>}
            meta={mine ? null : <span class="card-owner-line"><Face name={item.owner.name} keyed={item.owner.membership_id} />{item.owner.name}</span>} />
          <div class="card-compare">
            <section class="card-pane" aria-labelledby="item-card-now">
              <span id="item-card-now" class="section-label">It says now</span>
              <span class="card-pane-now">{itemNow(item)}</span>
            </section>
            {item.expected !== null && <>
              <span class="card-arrow" aria-hidden="true">→</span>
              <section class="card-pane needs" aria-labelledby="item-card-needs">
                <span id="item-card-needs" class="section-label">The decision needs</span>
                <span>{item.expected}</span>
              </section>
            </>}
          </div>
          {checked && <div class={`card-check ${item.check!.verdict}`}>{checked}</div>}
          {decision ? (
            <section class="card-section" aria-labelledby="item-card-decision">
              <div id="item-card-decision" class="section-label">The decision</div>
              <div class="card-decided selectable">{decision.first_line ?? decision.title}</div>
              <div class="card-side-meta">{approvedMeeting(decision, ' · ')}</div>
            </section>
          ) : <div class="faint">Sent by {item.approver.name}</div>}
        </article>
        <aside class="card-rail" aria-label={mine ? 'Your update' : 'Your review'}>
          <section class="card-panel" aria-label="The item">
            <Facts facts={[['Status', current?.status], ['Due', current?.due_at ? monthDay(current.due_at) ?? current.due_at : null], ['Assignee', current?.assignee]]} />
            {(current?.status || current?.due_at || current?.assignee) && <div class="card-rule" />}
            {item.can.set_state && <>
              <button type="button" class="primary-button" disabled={frozen} onClick={() => closeCardItem('done')}>Mark updated</button>
              <button type="button" class="plain-button" disabled={frozen} onClick={() => closeCardItem('not_relevant')}>No change needed</button>
            </>}
            <OpenInTool state={state} item={item} name={title} card />
            {assignable && !card.reassign && <button type="button" class="outline-button" data-testid="reassign" onClick={toggleReassign}>Reassign…</button>}
            {card.reassign && <Reassign card={card} frozen={frozen} />}
          </section>
        </aside>
      </div>
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
