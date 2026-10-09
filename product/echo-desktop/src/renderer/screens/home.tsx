import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { OpenItemView } from '../../shared/protocol.js';
import { externalSourceProvider } from '../answer.js';
import { colorFor, initial, when } from '../format.js';
import { message } from '../messages.js';
import { actionCount, itemFrom, itemKind, itemNames, itemParts, itemTitle, liveDetails, monthDay, needUpdating, shortNames, titleLine } from '../needs.js';
import { loadHome, markDone, openDecision, openItemInTool, openNewProject, openSend, type NeedRow, type State } from '../store.js';
import { Plus, Saved } from './icons.js';

/** The row's verb: what a click will ask of you. */
const KIND: Record<NeedRow['kind'], string> = { approve: 'Approve', send: 'Send', update: 'Update', check: 'Check', failed: 'Retry', checking: 'Checking' };

/** Projects by id, by name when Home knows them. */
function projectNames(state: State, ids: readonly string[]): { id: string; name: string }[] {
  const known = [...state.projects.items, ...state.archivedProjects.items];
  return ids.flatMap(id => {
    const project = known.find(item => item.project_id === id);
    return project ? [{ id, name: project.name }] : [];
  });
}

/** On the right: when, and the decision's first project. */
function Side({ state, at, projects, children }: { state: State; at?: string | null; projects: readonly string[]; children?: ComponentChildren }) {
  const names = projectNames(state, projects);
  const first = names[0];
  return (
    <span class="need-side">
      {at && <span class="need-when">{when(at)}</span>}
      {first && (
        <span class="need-project" title={names.map(name => name.name).join(', ')}>
          <span class="need-dot" style={{ background: colorFor(first.id) }} aria-hidden="true">{initial(first.name)}</span>
          <span>{first.name}{names.length > 1 ? ` +${names.length - 1}` : ''}</span>
        </span>
      )}
      {children}
    </span>
  );
}

/** A meeting's line: "Decision · 2 actions · Pilot planning meeting, Oct 6". */
function ReviewLine({ row }: { row: Extract<NeedRow, { review: unknown }> }) {
  const review = row.review;
  if (row.kind === 'checking') return <>{review.status === 'publishing' && !row.run ? 'Approved · publishing to ECHO' : 'Approved · checking what it changes'}</>;
  if (row.kind === 'failed') return <>Approved · the check did not finish</>;
  const day = review.meeting_at === null ? null : monthDay(review.meeting_at);
  const actions = actionCount(review.action_count);
  return <>Decision{actions ? ` · ${actions}` : ''} · <b>{review.title}</b> meeting{day ? `, ${day}` : ''}</>;
}

/** Approve, Send, Retry and Checking: the whole row is one button. */
function Row({ state, row }: { state: State; row: Exclude<NeedRow, { item: unknown }> }) {
  if (row.kind === 'send') {
    const send = row.send;
    const owners = shortNames(send.owners);
    return (
      <button type="button" class="need-row send" data-testid="need-row" data-kind="send" onClick={() => void openSend(send.run_id)}>
        <span class="need-kind">{KIND.send}</span>
        <span class="need-text">
          <span class="need-title">{titleLine(send.decision.first_line ?? send.decision.title)} — {needUpdating(send.items, send.kinds)}</span>
          <span class="need-detail">Impact of <b>{send.decision.title}</b>{owners.length > 0 ? ` · owners ${owners.join(', ')}` : ''}</span>
        </span>
        <Side state={state} at={send.finished_at} projects={send.decision.project_ids} />
      </button>
    );
  }
  const review = row.review;
  const run = row.kind === 'approve' ? undefined : row.run;
  return (
    <button type="button" class={`need-row ${row.kind}`} data-testid="need-row" data-kind={row.kind} disabled={row.kind === 'checking'}
      onClick={() => void openDecision(review.approval_id, run ?? null)}>
      <span class="need-kind">{KIND[row.kind]}</span>
      <span class="need-text">
        <span class="need-title">{titleLine(review.first_line ?? review.title)}</span>
        <span class="need-detail"><ReviewLine row={row} /></span>
      </span>
      <Side state={state} at={run?.updated_at} projects={review.project_ids}>
        {row.kind === 'checking' && <span class="asking" aria-hidden="true"><i /><i /><i /></span>}
      </Side>
    </button>
  );
}

/**
 * Open in Jira, only for an item ECHO opened for you just now: the tool checks
 * your access when it opens. Its name says which item, as Done's does.
 */
function OpenInTool({ state, item, name }: { state: State; item: OpenItemView; name: string }) {
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

/**
 * Update and Check: an item that waits on you, closed in place. "Open in
 * Jira" only when you can open it; Done when you may close it. `name` names
 * the item on its buttons.
 */
function ItemRow({ state, row, name }: { state: State; row: Extract<NeedRow, { item: unknown }>; name: string }) {
  const item = row.item;
  const failure = state.home?.closeFailures[item.item_id];
  const kind = itemKind(item, state.tools?.items);
  let title: string;
  let line: string;
  if (row.kind === 'check') {
    const details = liveDetails(item);
    title = `${itemTitle(item)}${details ? ` · ${details}` : ''} — not what was decided`;
    line = `${kind}${item.current?.assignee ? ` · now ${item.current.assignee}` : ''} · from `;
  } else {
    const { title: name, change } = itemParts(item);
    title = `${name}${change ? ` ${change}` : ''}`;
    line = `${kind} you own · from `;
  }
  return (
    <div class={`need-row ${row.kind}`} data-testid="need-row" data-kind={row.kind}>
      <span class="need-kind">{KIND[row.kind]}</span>
      <span class="need-text">
        <span class="need-title">{title}</span>
        <span class="need-detail">{line}<b>{itemFrom(item)}</b></span>
        {failure && <span class="error need-error" role="status">{failure}</span>}
      </span>
      <Side state={state} at={row.kind === 'check' ? item.check?.checked_at : null} projects={item.decision?.project_ids ?? []}>
        <span class="need-actions">
          <OpenInTool state={state} item={item} name={name} />
          {item.can.set_state && (
            <button type="button" class="need-act" aria-label={`Done: ${name}`} onClick={() => void markDone(item)}>Done</button>
          )}
        </span>
      </Side>
    </div>
  );
}

/** Under the rows, and on an empty Home: what you sent that waits on someone else. */
function Footer({ state }: { state: State }) {
  const waiting = state.home?.open?.waiting ?? 0;
  if (waiting === 0) return null;
  return <div class="needs-foot" data-testid="needs-foot">{waiting} with others</div>;
}

/**
 * Home: only what waits on you. Decisions from meetings to approve, what a
 * decision you approved changes (to send to its owners), items that wait on
 * you, and checks still on their way. Projects live in the sidebar.
 */
export function Home({ state }: { state: State }) {
  const home = state.home;
  const rows = home?.rows ?? [];
  const noProjects = !state.projects.loading && !state.projects.failure && state.projects.items.length === 0 &&
    !state.archivedProjects.loading && !state.archivedProjects.failure && state.archivedProjects.items.length === 0;
  if (home?.failure && rows.length === 0) {
    return (
      <div class="column center" data-testid="home-error">
        <div class="error">{message(home.failure)}</div>
        <button type="button" class="link-button" onClick={() => void loadHome()}>Try again</button>
      </div>
    );
  }
  if (rows.length === 0) {
    if (noProjects && !home?.loading) {
      return (
        <div class="column center" data-testid="home-empty">
          <button type="button" class="empty-capture" data-testid="empty-new-project" onClick={openNewProject}>
            <span class="ring" aria-hidden="true"><Plus /></span>
            <span>New project</span>
          </button>
        </div>
      );
    }
    return (
      <div class="column needs empty" data-testid="needs" aria-busy={home?.loading ?? true}>
        <div class="home-clear" data-testid="home-clear">{home && !home.loading && <><Saved /><span>Nothing needs you</span></>}</div>
        <Footer state={state} />
      </div>
    );
  }
  const waiting = rows.filter(row => row.kind !== 'checking').length;
  const names = itemNames(rows.flatMap(row => ('item' in row ? [row.item] : [])));
  return (
    <div class="column needs" data-testid="needs" aria-busy={home?.loading ?? true}>
      <div class="section-label needs-head">Needs you{waiting > 0 ? ` · ${waiting}` : ''}</div>
      {rows.map(row => 'item' in row
        ? <ItemRow key={row.item.item_id} state={state} row={row} name={names.get(row.item.item_id) ?? itemTitle(row.item)} />
        : <Row key={row.kind === 'send' ? row.send.run_id : row.review.approval_id} state={state} row={row} />)}
      {home?.failure && <div class="error more">{message(home.failure)} <button type="button" class="link-button" onClick={() => void loadHome()}>Try again</button></div>}
      <Footer state={state} />
    </div>
  );
}
