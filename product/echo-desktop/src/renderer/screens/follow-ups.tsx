import { useEffect, useRef, useState } from 'preact/hooks';
import type { Member, OpenItemView } from '../../shared/protocol.js';
import { externalSourceProvider } from '../answer.js';
import { colorFor, initials } from '../format.js';
import { message } from '../messages.js';
import {
  checkWords, firstName, itemGroups, itemHistory, itemKind, itemLabels, itemNames, itemTitle, matchesNow, monthDay, saysNow, sendLabel, STAGES,
} from '../needs.js';
import {
  checkNow, closeOwnerPicker, findOwner, moreFollowUps, openFollowUp, openFollowUps, openItemInTool, ownerChoices, pickFollowUpOwner, retryFollowUps, sendable,
  sendFollowUp, sendTicked, setFollowUpState, tickFollowUp, toggleOwnerPicker, undoFollowUp, type FollowUpList, type FollowUpView, type ItemPage, type Said,
  type State,
} from '../store.js';
import { Face } from './card.js';
import { within } from './change.js';

/** A person, as a chip: their initials in their color, and their first name. */
export function Chip({ person, label }: { person: { membership_id: string; name: string }; label: string }) {
  return (
    <span class="owner-chip">
      <span class="face" style={{ background: colorFor(person.membership_id) }} aria-hidden="true">{initials(person.name)}</span>
      <span class="owner-chip-name">{label}</span>
    </span>
  );
}

/** You, as an owner picker offers you. */
function meOf(state: State): Member | null {
  const account = state.status?.account;
  return account ? { membership_id: account.membership_id, display_name: account.display_name } : null;
}

/**
 * An item's owner: a chip ("You" when it is you), or a dashed "Pick owner"
 * while it is not sent and ECHO found no one, so it fell back to its
 * approver. Where you may change the owner, it opens the people picker.
 */
function Owner({ state, view, item, name }: { state: State; view: FollowUpView; item: OpenItemView; name: string }) {
  const me = state.status?.account?.membership_id;
  const unmatched = item.owner.match === 'approver' && item.state === 'unsent';
  const label = item.owner.membership_id === me ? 'You' : firstName(item.owner.name);
  if (!item.can.assign) {
    return <span class="owner-slot">{unmatched ? <span class="pick-button">Pick owner</span> : <Chip person={item.owner} label={label} />}</span>;
  }
  return (
    <span class="owner-slot">
      <button type="button" class={unmatched ? 'pick-button' : 'owner-button'} aria-label={unmatched ? `Pick owner: ${name}` : `Owner: ${label}. Change owner of ${name}`}
        aria-expanded={view.picker?.item_id === item.item_id} disabled={view.busy} onClick={() => toggleOwnerPicker(item.item_id)}>
        {unmatched ? 'Pick owner' : <Chip person={item.owner} label={label} />}
      </button>
    </span>
  );
}

/** The people picker under an owner chip: you first ("Me"), then the organization's people by name. Picking one changes the owner at once. */
function OwnerPicker({ state, view, item }: { state: State; view: FollowUpView; item: OpenItemView }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  const picker = view.picker!;
  const choices = ownerChoices(picker, item, meOf(state));
  return (
    <div class="picker" data-testid="owner-picker">
      <input ref={field} class="field small" type="search" autocomplete="off" maxLength={240} placeholder="Find a person" aria-label="Find a person"
        value={picker.query} onInput={event => void findOwner((event.target as HTMLInputElement).value)} />
      <div class="picker-list" role="listbox" aria-label="People" aria-busy={picker.loading}>
        {choices.map(({ person, me }) => (
          <button type="button" role="option" aria-selected={false} class="picker-option" key={person.membership_id} onClick={() => void pickFollowUpOwner(person)}>
            <Face name={person.display_name} keyed={person.membership_id} />
            <span class="name">{me ? 'Me' : person.display_name}</span>
          </button>
        ))}
      </div>
      {picker.failure && <div class="error">{picker.failure}</div>}
      {!picker.loading && !picker.failure && choices.length === 0 && <div class="notice">{picker.query.trim() ? 'No one by that name' : 'No one to pick'}</div>}
      <div class="picker-foot"><button type="button" class="link-button" onClick={closeOwnerPicker}>Cancel</button></div>
    </div>
  );
}

/** What the last change did, in place: "Sent to Mina Patel", "Done · Undo", or why it did not go. */
function SaidLine({ said, testid }: { said: Said | null; testid: string }) {
  return (
    <div class={`result-line${said?.error ? ' error' : ''}`} data-testid={testid} role="status">
      {said && <>{said.words}{said.undo && <> · <button type="button" class="link-button" onClick={() => void undoFollowUp()}>Undo</button></>}</>}
    </div>
  );
}

/**
 * Check now, faint after a meeting's or a project's list head: "Checking…"
 * while its sweep is on its way, "Nothing open to check", or "Check failed ·
 * Try again".
 */
function CheckNow({ list }: { list: FollowUpList }) {
  if (list.check === 'checking') return <span class="items-line-check faint" role="status">Checking…</span>;
  if (list.check === 'nothing') return <span class="items-line-check faint" role="status">Nothing open to check</span>;
  if (list.check === 'failed') {
    return <span class="items-line-check" role="status"><span class="faint">Check failed · </span><button type="button" class="link-button" onClick={() => void checkNow()}>Try again</button></span>;
  }
  return <button type="button" class="need-open" onClick={() => void checkNow()}>Check now</button>;
}

/**
 * One row: a tick when it is not sent and you may send it, its title, one
 * faint line (what it is; its meeting when the list spans meetings; "matches
 * now" when ECHO's last check found it so), and its owner. A click anywhere
 * else opens its page.
 */
function Row({ state, list, item, label, name }: { state: State; list: FollowUpList; item: OpenItemView; label: string; name: string }) {
  const sub = [itemKind(item, state.tools?.items), list.scope === 'record' ? null : item.decision?.title ?? null, matchesNow(item)].filter(Boolean).join(' · ');
  return <>
    <div class="follow-up-row" data-testid="follow-up-row" data-state={item.state}
      onClick={event => { if (!within(event, '.send-box, .owner-slot')) void openFollowUp(item.item_id, item); }}>
      {sendable(item) && (
        <input type="checkbox" class="send-box" aria-label={name} checked={list.ticks[item.item_id] === true} disabled={list.busy}
          onChange={() => tickFollowUp(item.item_id)} />
      )}
      <button type="button" class="follow-up-open">
        <span class="follow-up-title">{label}</span>
        <span class="follow-up-sub">{sub}</span>
      </button>
      <Owner state={state} view={list} item={item} name={name} />
    </div>
    {list.picker?.item_id === item.item_id && <OwnerPicker state={state} view={list} item={item} />}
  </>;
}

/**
 * A follow-ups list: a meeting's, a project's, or yours (everything you sent
 * or own), grouped Not sent, Open, Done and Dismissed. Send N and Dismiss N
 * act on the ticked Not sent rows; the list stays, read again, and one line
 * says what happened. Every row opens its page.
 */
export function FollowUps({ state, list }: { state: State; list: FollowUpList }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }); }, [list.seq]);
  const labels = itemLabels(list.items);
  const names = itemNames(list.items);
  const summary = list.summary;
  const counts: Record<string, number> = summary ? { unsent: summary.unsent, open: summary.open, done: summary.done, not_relevant: summary.not_relevant } : {};
  const total = summary ? summary.unsent + summary.open + summary.done + summary.not_relevant : null;
  const decision = list.items.find(item => item.decision)?.decision;
  const heading = list.scope === 'mine' ? 'Your follow-ups' : list.scope === 'project' ? 'Follow-ups' : list.title ?? decision?.title ?? 'Follow-ups';
  const approved = decision ? monthDay(decision.approved_at) : null;
  const sub = list.scope === 'project' ? list.title
    : list.scope === 'record' && total !== null ? [approved ? `Approved ${approved}` : null, total === 1 ? '1 follow-up' : `${total} follow-ups`].filter(Boolean).join(' · ') : null;
  const ticked = list.items.filter(item => sendable(item) && list.ticks[item.item_id]).length;
  return (
    <div class="column follow-ups" data-testid="follow-ups" ref={box} aria-busy={list.loading || list.busy}>
      <header class="follow-ups-head">
        <h1 tabIndex={-1}>{heading}</h1>
        {(sub || list.scope !== 'mine') && <div class="follow-ups-sub"><span>{sub}</span>{list.scope !== 'mine' && <CheckNow list={list} />}</div>}
      </header>
      <SaidLine said={list.said} testid="follow-ups-said" />
      {itemGroups(list.items).map(group => (
        <section key={group.state} class="follow-ups-group" aria-label={STAGES[group.state]}>
          <div class="section-label">{STAGES[group.state]} · {counts[group.state] ?? group.items.length}</div>
          <div class="follow-ups-rows">
            {group.items.map(item => <Row key={item.item_id} state={state} list={list} item={item} label={labels.get(item.item_id)!} name={names.get(item.item_id)!} />)}
          </div>
        </section>
      ))}
      {list.loading && list.items.length === 0 && <span class="asking" aria-hidden="true"><i /><i /><i /></span>}
      {!list.loading && !list.failure && list.items.length === 0 && <div class="notice">No follow-ups</div>}
      {list.next && <button type="button" class="link-button more" disabled={list.loading} onClick={() => void moreFollowUps()}>More</button>}
      {list.failure && (
        <div class="error more">
          {message(list.failure)}
          <button type="button" class="link-button" disabled={list.loading} onClick={() => void retryFollowUps()}>Try again</button>
        </div>
      )}
      {ticked > 0 && (
        <div class="follow-ups-foot">
          <button type="button" class="primary-button small" disabled={list.busy || list.loading} onClick={() => void sendTicked(true)}>Send {ticked}</button>
          <button type="button" class="plain-button small" disabled={list.busy || list.loading} onClick={() => void sendTicked(false)}>Dismiss {ticked}</button>
          {list.busy && <span class="asking"><i /><i /><i /></span>}
        </div>
      )}
    </div>
  );
}

/**
 * Open in Jira (or the item's own tool), only for an item ECHO opened for you
 * just now: the tool checks your access when it opens.
 */
function OpenInTool({ state, item }: { state: State; item: OpenItemView }) {
  const [failed, setFailed] = useState(false);
  const source = item.reach === 'opened' ? item.current?.source : undefined;
  if (!source || !('permalink' in source)) return null;
  return <>
    <button type="button" class="link-button card-side-link" title={source.permalink}
      onClick={async () => { setFailed(false); setFailed(!(await openItemInTool(item))); }}>Open in {externalSourceProvider(source, state.tools?.items)}</button>
    {failed && <span class="error">The item could not be opened. Try again.</span>}
  </>;
}

/** Why a follow-up is here: the meeting decided it, or what a document says now beside what the meeting decided. */
function Why({ state, item }: { state: State; item: OpenItemView }) {
  if (item.kind === 'action') return <div class="card-text">Decided in the meeting</div>;
  return <>
    {item.relation === null && <div class="card-text">May be affected by the meeting</div>}
    <div class="card-delta">
      <div><span class="card-delta-label">Says now</span><span class="card-delta-now">{saysNow(item)}</span></div>
      {item.expected !== null && <div><span class="card-delta-label needs">Meeting decided</span><span>{item.expected}</span></div>}
    </div>
    <OpenInTool state={state} item={item} />
  </>;
}

/** The one next step, by status and your rights: one primary button, one secondary at most. */
function Actions({ state, page, item }: { state: State; page: ItemPage; item: OpenItemView }) {
  const me = state.status?.account?.membership_id ?? null;
  const frozen = page.busy;
  if (sendable(item)) {
    return <>
      <button type="button" class="primary-button" disabled={frozen} onClick={() => void sendFollowUp(true)}>{sendLabel(item, me)}</button>
      <button type="button" class="plain-button" disabled={frozen} onClick={() => void sendFollowUp(false)}>Dismiss</button>
    </>;
  }
  if (!item.can.set_state || item.state === 'unsent') return null;
  if (item.state === 'open') {
    return <>
      <button type="button" class="primary-button" disabled={frozen} onClick={() => void setFollowUpState('done')}>Mark done</button>
      <button type="button" class="plain-button" disabled={frozen} onClick={() => void setFollowUpState('not_relevant')}>Dismiss</button>
    </>;
  }
  // Dismissed before it was sent: reopening it reaches its owner.
  const reaches = !item.reached_owner && item.owner.membership_id !== me;
  return <button type="button" class="primary-button" disabled={frozen} onClick={() => void setFollowUpState('open')}>{reaches ? sendLabel(item, me) : 'Reopen'}</button>;
}

/**
 * One follow-up's page (F5): its title and status; what it is and the
 * meeting it came from (which opens that meeting's follow-ups); why it is
 * here; what happened to it; and, beside them, its owner and the one next
 * step. After a change the page stays and says what happened.
 */
export function FollowUp({ state, page }: { state: State; page: ItemPage }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }); }, [page.seq, page.item !== null]);
  const item = page.item;
  if (!item) {
    return (
      <div class="column center" data-testid="follow-up-loading" aria-busy={page.loading}>
        {page.failure ? <div class="error">{message(page.failure)}</div> : <span class="asking"><i /><i /><i /></span>}
      </div>
    );
  }
  const me = state.status?.account?.membership_id ?? null;
  const { decision } = item;
  const day = decision ? monthDay(decision.approved_at) : null;
  const checked = item.kind === 'action' ? null : checkWords(item.check);
  return (
    <div class="column card" ref={box}>
      <div class="card-page" data-testid="follow-up" aria-busy={page.loading || page.busy}>
        <article class="card-main" aria-labelledby="follow-up-title">
          <header class="card-head">
            <div class="card-top"><span class={`stage-pill ${item.state}`} data-testid="follow-up-state">{STAGES[item.state]}</span></div>
            <h1 id="follow-up-title" class="card-title" tabIndex={-1}>{itemTitle(item)}</h1>
            <div class="card-meta">
              {itemKind(item, state.tools?.items)} · {decision
                ? <button type="button" class="link-button inline" onClick={() => void openFollowUps('record', decision.record_sha256, decision.title)}>
                  from {decision.title}{day ? `, ${day}` : ''}</button>
                : `Sent by ${item.approver.membership_id === me ? 'you' : item.approver.name}`}
            </div>
          </header>
          <section class="card-section" aria-labelledby="follow-up-why">
            <div id="follow-up-why" class="section-label">Why it's here</div>
            <Why state={state} item={item} />
          </section>
          <section class="card-section" aria-labelledby="follow-up-history">
            <div id="follow-up-history" class="section-label">History</div>
            <ol class="history" data-testid="follow-up-history">
              {itemHistory(item, me).map((event, index) => (
                <li key={index}><span class="history-when">{monthDay(event.at)}</span><span>{event.words}</span></li>
              ))}
            </ol>
          </section>
          {checked && <div class="faint" data-testid="follow-up-check">{checked}</div>}
          {page.failure && <div class="error">{message(page.failure)}</div>}
        </article>
        <aside class="card-rail" aria-label="Owner and next step">
          <section class="card-panel" aria-labelledby="follow-up-owner">
            <div id="follow-up-owner" class="section-label">Owner</div>
            <Owner state={state} view={page} item={item} name={itemTitle(item)} />
            {page.picker && <OwnerPicker state={state} view={page} item={item} />}
            <div class="card-rule" />
            <SaidLine said={page.said} testid="follow-up-said" />
            <Actions state={state} page={page} item={item} />
            {page.busy && <span class="asking card-busy"><i /><i /><i /></span>}
          </section>
        </aside>
      </div>
    </div>
  );
}
