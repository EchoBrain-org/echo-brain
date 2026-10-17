import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Member, OpenItemView } from '../../shared/protocol.js';
import { externalSourceProvider } from '../answer.js';
import { message } from '../messages.js';
import {
  ACTIVE_STATES, checkWords, CLOSED_STATES, followUpCount, itemGroups, itemHistory, itemKind, itemNames, itemTitle, joined, liveFacts, matchesNow, monthDay,
  ownerWords, reopenLabel, saysNow, sendLabel, STAGES, summaryTotal,
} from '../needs.js';
import {
  awaitingLive, checkNow, closeFollowUp, closeOwnerPicker, findOwner, listDecision, moreAfter, moreFollowUps, openFollowUp, openFollowUps, openImpactSource,
  openListDecision, ownerChoices, pickFollowUpOwner, retryFollowUp, retryFollowUps, sendable, sendFollowUp, sendTicked, setFollowUpState, shownItem, tickFollowUp,
  toggleClosedGroup, toggleOwnerPicker, undoFollowUp, type FollowUpList, type ItemPage, type OwnerPicker as Picker, type Said, type State,
} from '../store.js';
import { Face } from './card.js';
import { within } from './change.js';
import { Chevron } from './icons.js';
import { useKeptPlace } from './items.js';

/** A person, as a chip: their initials in their color, and their first name. */
function Chip({ person, label }: { person: { membership_id: string; name: string }; label: string }) {
  return <span class="owner-chip"><Face name={person.name} keyed={person.membership_id} /><span class="owner-chip-name">{label}</span></span>;
}

/** You, as an owner picker offers you. */
function meOf(state: State): Member | null {
  const account = state.status?.account;
  return account ? { membership_id: account.membership_id, display_name: account.display_name } : null;
}

/** Nothing has the focus any more: the control that had it went, or was disabled while a change was on its way. */
function focusLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/**
 * Where the focus goes when an owner picker closes (a pick, Cancel or
 * Escape): back to the item's owner chip, or, when the item left what you
 * see, to the line that says what happened.
 */
function usePickerFocus(pickerItem: string | undefined, box: { current: HTMLElement | null }, said: { current: HTMLElement | null }) {
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    const closed = last.current;
    last.current = pickerItem;
    if (closed === undefined || pickerItem !== undefined) return;
    const chip = box.current?.querySelector<HTMLElement>(`[data-owner="${closed}"]`);
    (chip ?? said.current)?.focus({ preventScroll: true });
  }, [pickerItem]);
}

/** After a change, focus left with nowhere to go (Send N went, a button changed) moves to the line that says what happened. */
function useSaidFocus(shown: Said | null, said: { current: HTMLElement | null }) {
  useEffect(() => { if (shown && focusLost()) said.current?.focus({ preventScroll: true }); }, [shown]);
}

/**
 * An item's owner: a chip ("You" when it is you), or "Pick owner" while it is
 * not sent and ECHO found no one, so it fell back to its approver: a dashed
 * button where you may pick, else plain faint words. Where you may change the
 * owner, it opens the people picker; while a change is on its way it does
 * nothing, and keeps the focus.
 */
function Owner({ state, busy, picking, item, name }: { state: State; busy: boolean; picking: boolean; item: OpenItemView; name: string }) {
  const me = state.status?.account?.membership_id;
  const unmatched = item.owner.match === 'approver' && item.state === 'unsent';
  const label = ownerWords(item, me);
  if (!item.can.assign) {
    return <span class="owner-slot">{unmatched ? <span class="faint">Pick owner</span> : <Chip person={item.owner} label={label} />}</span>;
  }
  return (
    <span class="owner-slot">
      <button type="button" class={unmatched ? 'pick-button' : 'owner-button'} data-owner={item.item_id}
        aria-label={unmatched ? `Pick owner: ${name}` : `Owner: ${label}. Change owner of ${name}`} aria-expanded={picking} aria-disabled={busy ? 'true' : undefined}
        onClick={() => toggleOwnerPicker(item.item_id)}>
        {unmatched ? 'Pick owner' : <Chip person={item.owner} label={label} />}
      </button>
    </span>
  );
}

/** The people picker under an owner chip: you first ("You", as a chip says), then the organization's people by name. Picking one changes the owner at once. */
function OwnerPicker({ state, picker, item }: { state: State; picker: Picker; item: OpenItemView }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  const choices = ownerChoices(picker, item, meOf(state));
  return (
    <div class="picker" data-testid="owner-picker">
      <input ref={field} class="field small" type="search" autocomplete="off" maxLength={240} placeholder="Find a person" aria-label="Find a person"
        value={picker.query} onInput={event => void findOwner((event.target as HTMLInputElement).value)} />
      <div class="picker-list" role="listbox" aria-label="People" aria-busy={picker.loading}>
        {choices.map(({ person, me }) => (
          <button type="button" role="option" aria-selected={false} class="picker-option" key={person.membership_id} onClick={() => void pickFollowUpOwner(person)}>
            <Face name={person.display_name} keyed={person.membership_id} />
            <span class="name">{me ? 'You' : person.display_name}</span>
          </button>
        ))}
      </div>
      {picker.failure && <div class="error">{picker.failure}</div>}
      {!picker.loading && !picker.failure && choices.length === 0 && <div class="notice">{picker.query.trim() ? 'No one by that name' : 'No one to pick'}</div>}
      <div class="picker-foot"><button type="button" class="link-button" onClick={closeOwnerPicker}>Cancel</button></div>
    </div>
  );
}

/**
 * What the last change did, in place: "Sent to Mina", "Done · Undo", or why
 * it did not go. Always there, so a screen reader announces each change; it
 * takes the focus when the control that had it went.
 */
function SaidLine({ said, testid, line }: { said: Said | null; testid: string; line: { current: HTMLDivElement | null } }) {
  return (
    <div ref={line} class={`result-line${said?.error ? ' error' : ''}${said ? '' : ' sr-only'}`} data-testid={testid} role="status" tabIndex={-1}>
      {said && <>{said.words}{said.undo && <> · <button type="button" class="link-button" onClick={() => void undoFollowUp()}>Undo</button></>}</>}
    </div>
  );
}

/**
 * Check now, faint after a meeting's or a project's list head, while
 * something is open to check: "Checking…" while its sweep is on its way,
 * "Nothing open to check", or "Check failed · Try again", each until the list
 * is read again.
 */
function CheckNow({ list }: { list: FollowUpList }) {
  if (list.check === 'checking') return <span class="items-line-check faint" role="status">Checking…</span>;
  if (list.check === 'nothing') return <span class="items-line-check faint" role="status">Nothing open to check</span>;
  if (list.check === 'failed') {
    return <span class="items-line-check" role="status"><span class="faint">Check failed · </span><button type="button" class="link-button" onClick={() => void checkNow()}>Try again</button></span>;
  }
  if (!list.summary || list.summary.open === 0) return null;
  return <button type="button" class="need-open" onClick={() => void checkNow()}>Check now</button>;
}

/**
 * One row: a tick when it is not sent and you may send it, its title, one
 * faint line (what it is; its meeting when the list spans meetings; "matches
 * now" when ECHO's last check found it so), and its owner. A click anywhere
 * else opens its page.
 */
function Row({ state, list, item, label, name }: { state: State; list: FollowUpList; item: OpenItemView; label: string; name: string }) {
  const sub = joined([itemKind(item, state.tools?.items), list.scope === 'record' ? null : item.decision?.title ?? null, matchesNow(item)]);
  // Read rows only first: while ECHO reads it in its tool, its title says what it is and its meeting, faintly.
  const reading = list.reading && awaitingLive(item);
  return <>
    <div class="follow-up-row" data-testid="follow-up-row" data-item={item.item_id} data-state={item.state}
      onClick={event => { if (!within(event, '.send-box, .owner-slot')) void openFollowUp(item.item_id, item); }}>
      {sendable(item) && (
        <input type="checkbox" class="send-box" aria-label={name} checked={list.ticks[item.item_id] === true} disabled={list.busy}
          onChange={() => tickFollowUp(item.item_id)} />
      )}
      <button type="button" class="follow-up-open" aria-busy={reading || undefined}>
        <span class={`follow-up-title${reading ? ' reading-title' : ''}`} data-reading={reading || undefined}>{label}</span>
        <span class="follow-up-sub">{sub}</span>
      </button>
      <Owner state={state} busy={list.busy} picking={list.picker?.item_id === item.item_id} item={item} name={name} />
    </div>
    {list.picker?.item_id === item.item_id && <OwnerPicker state={state} picker={list.picker} item={item} />}
  </>;
}

/** The list's head: its name, and under it what it is ("Approved Oct 6 · 4 follow-ups", or the project), with Check now. */
function Head({ list }: { list: FollowUpList }) {
  const total = list.summary && summaryTotal(list.summary);
  const decision = listDecision(list);
  const heading = list.scope === 'record' ? list.title ?? decision?.title ?? 'Follow-ups' : list.ids ? list.title ?? 'Follow-ups' : 'Follow-ups';
  const day = decision ? monthDay(decision.approved_at) : null;
  // A meeting's approval opens its decision page over the list, when you approved it.
  const approved = list.scope !== 'record' || !day ? null
    : list.stage?.mine ? <button type="button" class="link-button inline faint-link" onClick={() => void openListDecision()}>Approved {day}</button> : <span>Approved {day}</span>;
  const count = list.scope === 'record' && total !== null ? followUpCount(total) : null;
  return (
    <header class="follow-ups-head">
      <h1 tabIndex={-1}>{heading}</h1>
      {(list.scope === 'record' || list.scope === 'project') && (
        <div class="follow-ups-sub">
          <span>{list.scope === 'project' ? list.title : <>{approved}{approved && count ? ' · ' : ''}{count}</>}</span>
          <CheckNow list={list} />
        </div>
      )}
    </header>
  );
}

/**
 * A follow-ups list: a meeting's, a project's, or yours (everything you sent
 * or own), grouped Not sent, Open, Done and Dismissed, each counted over the
 * whole list. Current work comes first, with its own More; once it is read to
 * its end, each closed group, which opens and closes (yours and a project's
 * start closed), with its own. Send N and Dismiss N act on the ticked Not sent
 * rows; the list stays where it was, and its foot says what happened. Every
 * row opens its page, and Back returns to that row.
 */
export function FollowUps({ state, list }: { state: State; list: FollowUpList }) {
  const { column, returned } = useKeptPlace(`follow-ups:${list.seq}`);
  const said = useRef<HTMLDivElement>(null);
  // Opened, the heading takes the focus; come back to, the row it was left from does, and again once a read moved that row.
  const openedRow = () => (list.opened ? column.current?.querySelector<HTMLElement>(`[data-item="${list.opened}"] .follow-up-open`) ?? null : null);
  useEffect(() => {
    const row = returned.current ? openedRow() : null;
    if (row) row.focus({ preventScroll: true });
    else if (!returned.current) column.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }, [list.seq]);
  useEffect(() => { if (!list.loading && returned.current && focusLost()) openedRow()?.focus({ preventScroll: true }); }, [list.loading]);
  usePickerFocus(list.picker?.item_id, column, said);
  useSaidFocus(list.said, said);
  // Each row as it shows, its live part laid over it, and its names, worked out once each time the rows change.
  const items = useMemo(() => list.items.map(item => shownItem(item, list.live)), [list.items, list.live]);
  const names = useMemo(() => itemNames(items), [items]);
  const counts = list.summary;
  const groups = itemGroups(items);
  const ticked = items.filter(item => sendable(item) && list.ticks[item.item_id]).length;
  const mores = moreAfter(list);
  const rowsOf = (status: OpenItemView['state']) => groups.find(entry => entry.state === status)?.items ?? [];
  const rows = (entries: readonly OpenItemView[]) => (
    <div class="follow-ups-rows">
      {entries.map(item => <Row key={item.item_id} state={state} list={list} item={item} label={names.get(item.item_id)!.label} name={names.get(item.item_id)!.name} />)}
    </div>
  );
  const more = (part: 'active' | (typeof CLOSED_STATES)[number]) => mores.includes(part) && (
    <button type="button" class="link-button more" data-testid={part === 'active' ? 'follow-ups-more' : 'follow-ups-more-closed'} disabled={list.loading}
      onClick={() => void moreFollowUps(part)}>More</button>
  );
  const group = (status: (typeof ACTIVE_STATES)[number]) => rowsOf(status).length > 0 && (
    <section key={status} class="follow-ups-group" aria-label={STAGES[status]}>
      <div class="section-label">{STAGES[status]} · {counts?.[status] ?? rowsOf(status).length}</div>
      {rows(rowsOf(status))}
    </section>
  );
  // Current work read to its end, each closed group shows, counted over the whole list ("Done · 12"); opened, its rows show.
  const ended = list.reads.some(read => read.parts.includes('active') && read.next === null);
  const closedGroup = (status: (typeof CLOSED_STATES)[number]) => {
    const count = counts?.[status] ?? rowsOf(status).length;
    if (!ended && !list.reads.some(read => read.parts.includes(status))) return null;
    const open = list.expanded[status] === true;
    return (
      <Fragment key={status}>
        {(count > 0 || rowsOf(status).length > 0) && (
          <section class="follow-ups-group" aria-label={STAGES[status]}>
            <button type="button" class="section-label disclosure" aria-expanded={open}
              onClick={() => toggleClosedGroup(status)}><Chevron /><span>{STAGES[status]} · {count}</span></button>
            {open && rowsOf(status).length > 0 && rows(rowsOf(status))}
          </section>
        )}
        {more(status)}
      </Fragment>
    );
  };
  const foot = ticked > 0 || list.said !== null;
  return (
    <div class="column follow-ups" data-testid="follow-ups" ref={column} aria-busy={list.loading || list.busy}>
      <Head list={list} />
      {ACTIVE_STATES.map(group)}
      {more('active')}
      {CLOSED_STATES.map(closedGroup)}
      {list.loading && list.items.length === 0 && <span class="asking" aria-hidden="true"><i /><i /><i /></span>}
      {!list.loading && !list.failed && (list.summary ? summaryTotal(list.summary) : list.items.length) === 0 && <div class="notice">No follow-ups</div>}
      {list.failed && (
        <div class="error more">
          {message(list.failed.failure)}
          <button type="button" class="link-button" disabled={list.loading} onClick={() => void retryFollowUps()}>Try again</button>
        </div>
      )}
      {/* No tick and nothing said: the foot takes no room, and its status line stays where a screen reader hears it. */}
      <div class={foot ? 'follow-ups-foot' : 'sr-only'} data-testid="follow-ups-foot">
        {ticked > 0 && <>
          <button type="button" class="primary-button small" disabled={list.busy || list.loading} onClick={() => void sendTicked(true)}>Send {ticked}</button>
          <button type="button" class="plain-button small" disabled={list.busy || list.loading} onClick={() => void sendTicked(false)}>Dismiss {ticked}</button>
        </>}
        {list.busy && <span class="asking" aria-hidden="true"><i /><i /><i /></span>}
        <SaidLine said={list.said} testid="follow-ups-said" line={said} />
      </div>
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
      onClick={async () => { setFailed(false); setFailed(!(await openImpactSource(source))); }}>Open in {externalSourceProvider(source, state.tools?.items)}</button>
    {failed && <span class="error">The item could not be opened. Try again.</span>}
  </>;
}

/**
 * Why a document is a follow-up: what it says now (with its tool's facts in
 * one faint line) beside what the meeting decided. A meeting's action needs
 * none: its line above says it came from the meeting.
 */
function Why({ state, item, reading }: { state: State; item: OpenItemView; reading: boolean }) {
  const facts = liveFacts(item);
  return (
    <section class="card-section" aria-labelledby="follow-up-why">
      <div id="follow-up-why" class="section-label">Why it's here</div>
      {item.relation === null && <div class="card-text">May be affected by the meeting</div>}
      <div class="card-delta">
        <div>
          <span class="card-delta-label">Says now</span>
          <span class={`card-delta-now${reading ? ' reading-title' : ''}`}>{reading ? 'Reading…' : saysNow(item)}</span>
          {facts && <span class="card-delta-facts faint" data-testid="follow-up-facts">{facts}</span>}
        </div>
        {item.expected !== null && <div><span class="card-delta-label needs">Meeting decided</span><span>{item.expected}</span></div>}
      </div>
      <OpenInTool state={state} item={item} />
    </section>
  );
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
  return <button type="button" class="primary-button" disabled={frozen} onClick={() => void setFollowUpState('open')}>{reopenLabel(item, me)}</button>;
}

/**
 * One follow-up's page (F5): its title and status; what it is and the
 * meeting it came from (which opens that meeting's follow-ups, or goes back
 * to them); why it is here; what happened to it; and, beside them, its owner
 * and the one next step. After a change the page stays and says what
 * happened; one that took it out of what you see says so, with Back.
 */
export function FollowUp({ state, page }: { state: State; page: ItemPage }) {
  const box = useRef<HTMLDivElement>(null);
  const said = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }); }, [page.seq, page.item !== null, page.gone === true]);
  usePickerFocus(page.picker?.item_id, box, said);
  useSaidFocus(page.said, said);
  const item = page.item && shownItem(page.item, page.live);
  if (!item) {
    return (
      <div class="column center" data-testid="follow-up-loading" aria-busy={page.loading}>
        {page.failure ? <>
          <div class="error">{message(page.failure)}</div>
          <button type="button" class="link-button" disabled={page.loading} onClick={retryFollowUp}>Try again</button>
        </> : <span class="asking"><i /><i /><i /></span>}
      </div>
    );
  }
  if (page.gone) {
    return (
      <div class="column center" ref={box} data-testid="follow-up-gone">
        <h1 class="card-title" tabIndex={-1}>{itemTitle(item)}</h1>
        <SaidLine said={page.said} testid="follow-up-said" line={said} />
        <div class="notice">You no longer see this follow-up</div>
        <button type="button" class="link-button" onClick={closeFollowUp}>Back</button>
      </div>
    );
  }
  const me = state.status?.account?.membership_id ?? null;
  const { decision } = item;
  const day = decision ? monthDay(decision.approved_at) : null;
  const checked = checkWords(item.check);
  // Its row shows at once; while ECHO reads it in its tool, its title says what it is and its meeting, faintly.
  const reading = page.loading && awaitingLive(item);
  return (
    <div class="column card" ref={box}>
      <div class="card-page" data-testid="follow-up" aria-busy={page.loading || page.busy}>
        <article class="card-main" aria-labelledby="follow-up-title">
          <header class="card-head">
            <div class="card-top"><span class={`stage-pill ${item.state}`} data-testid="follow-up-state">{STAGES[item.state]}</span></div>
            <h1 id="follow-up-title" class={`card-title${reading ? ' reading-title' : ''}`} tabIndex={-1} data-reading={reading || undefined}>{itemTitle(item)}</h1>
            <div class="card-meta">
              {itemKind(item, state.tools?.items)} · {decision
                ? <button type="button" class="link-button inline" onClick={() => void openFollowUps('record', decision.record_sha256, decision.title)}>
                  from {decision.title}{day ? `, ${day}` : ''}</button>
                : `Sent by ${item.approver.membership_id === me ? 'you' : item.approver.name}`}
            </div>
          </header>
          {item.kind !== 'action' && <Why state={state} item={item} reading={reading} />}
          <section class="card-section" aria-labelledby="follow-up-history">
            <div id="follow-up-history" class="section-label">History</div>
            <ol class="history" data-testid="follow-up-history">
              {itemHistory(item, me).map((event, index) => (
                <li key={index}><span class="history-when">{monthDay(event.at)}</span><span>{event.words}</span></li>
              ))}
            </ol>
          </section>
          {checked && <div class="faint" data-testid="follow-up-check">{checked}</div>}
          {(page.failure || item.reach === 'unavailable') && <div class="error" role="status">
            {page.failure ? message(page.failure) : 'ECHO couldn’t read the details just now.'}
            <button type="button" class="link-button" disabled={page.loading || page.busy} onClick={retryFollowUp}>Try again</button>
          </div>}
        </article>
        <aside class="card-rail" aria-label="Owner and next step">
          <section class="card-panel" aria-labelledby="follow-up-owner">
            <div id="follow-up-owner" class="section-label">Owner</div>
            <Owner state={state} busy={page.busy} picking={page.picker !== null} item={item} name={itemTitle(item)} />
            {page.picker && <OwnerPicker state={state} picker={page.picker} item={item} />}
            <div class="card-rule" />
            <SaidLine said={page.said} testid="follow-up-said" line={said} />
            <Actions state={state} page={page} item={item} />
            {page.busy && <span class="asking card-busy"><i /><i /><i /></span>}
          </section>
        </aside>
      </div>
    </div>
  );
}
