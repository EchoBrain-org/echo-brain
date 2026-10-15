import type { ComponentChildren } from 'preact';
import { colorFor, initial, when } from '../format.js';
import { message } from '../messages.js';
import { actionCount, homeFooter, itemNames, itemNeeds, itemWhy, meetingSuffix, monthDay, shortNames, titleLine, toSend } from '../needs.js';
import { awaitingLive, loadHome, openDecision, openFollowUp, openFollowUps, openNewProject, openYourFollowUps, type NeedRow, type State } from '../store.js';
import { Plus, Saved } from './icons.js';

/** The row's verb: what a click will ask of you. "Check" is never one: it is ECHO's re-read (R63). */
const KIND: Record<NeedRow['kind'], string> = { approve: 'Approve', send: 'Send', update: 'Update', review: 'Review', failed: 'Retry', checking: 'Checking' };

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

/** A meeting's line: "Decision · 2 actions · Pilot planning meeting, Oct 6" ("meeting" only once, R76). */
export function ReviewLine({ row }: { row: Extract<NeedRow, { review: unknown }> }) {
  const review = row.review;
  if (row.kind === 'checking') return <>{review.status === 'publishing' && !row.run ? 'Approved · publishing to ECHO' : 'Approved · checking what it changes'}</>;
  if (row.kind === 'failed') return <>Approved · the check did not finish</>;
  const day = review.meeting_at === null ? null : monthDay(review.meeting_at);
  const actions = actionCount(review.action_count);
  return <>Decision{actions ? ` · ${actions}` : ''} · <b>{review.title}</b>{meetingSuffix(review.title)}{day ? `, ${day}` : ''}</>;
}

/** Approve, Send, Retry and Checking: the whole row is one button. A Send row opens its meeting's follow-ups. */
function Row({ state, row }: { state: State; row: Exclude<NeedRow, { item: unknown }> }) {
  if (row.kind === 'send') {
    const send = row.send;
    const owners = shortNames(send.owners);
    return (
      <button type="button" class="need-row send" data-testid="need-row" data-kind="send"
        onClick={() => void openFollowUps('record', send.decision.record_sha256, send.decision.title)}>
        <span class="need-kind">{KIND.send}</span>
        <span class="need-text">
          <span class="need-title">{titleLine(send.decision.first_line ?? send.decision.title)} — {toSend(send.items)}</span>
          <span class="need-detail">From <b>{send.decision.title}</b>{owners.length > 0 ? ` · owners ${owners.join(', ')}` : ''}</span>
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
 * Update, for a follow-up that waits on you, and Review, for one someone else
 * owns that changed since you sent it (R64): the whole row opens its page
 * (F5). Its three lines: its title (`label`, apart from any other on Home);
 * for a document, what it says now and what the meeting needs; and, muted,
 * what it is, its meeting and whose it is.
 */
function ItemRow({ state, row, label }: { state: State; row: Extract<NeedRow, { item: unknown }>; label: string }) {
  const { item } = row;
  const needs = itemNeeds(item);
  // Shown from ECHO's own fields at once: while ECHO reads it in its tool, its title says what it is and its meeting, faintly.
  const reading = state.home?.reading === true && awaitingLive(item);
  return (
    <button type="button" class={`need-row ${row.kind}`} data-testid="need-row" data-kind={row.kind} aria-busy={reading || undefined}
      onClick={() => void openFollowUp(item.item_id, item)}>
      <span class="need-kind">{KIND[row.kind]}</span>
      <span class="need-text">
        <span class={`need-title${reading ? ' reading-title' : ''}`} data-reading={reading || undefined}>{label}</span>
        {needs && <span class="need-change">{needs}</span>}
        <span class="need-detail">{itemWhy(item, state.status?.account?.membership_id ?? null, state.tools?.items)}</span>
      </span>
      <Side state={state} projects={item.decision?.project_ids ?? []} />
    </button>
  );
}

/**
 * Under the rows, and on an empty Home (F9): what waits on others and when
 * ECHO last checked, and Follow-ups (everything you sent or own), always.
 */
function Footer({ state }: { state: State }) {
  const open = state.home?.open;
  const words = open ? homeFooter(open) : null;
  return (
    <div class="needs-foot" data-testid="needs-foot">
      <span class="needs-foot-words">{words}</span>
      <button type="button" class="need-open" data-testid="your-follow-ups" onClick={() => void openYourFollowUps()}>Follow-ups</button>
    </div>
  );
}

/**
 * Home: only what waits on you. Decisions from meetings to approve, meetings
 * you approved with follow-ups to send, follow-ups that wait on you, and
 * checks still on their way. Projects live in the sidebar.
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
        <div class="column needs empty" data-testid="home-empty">
          <div class="home-clear">
            <button type="button" class="empty-capture" data-testid="empty-new-project" onClick={openNewProject}>
              <span class="ring" aria-hidden="true"><Plus /></span>
              <span>New project</span>
            </button>
          </div>
          <Footer state={state} />
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
    <div class="column needs" data-testid="needs" aria-busy={home ? home.loading || home.reading : true}>
      <div class="section-label needs-head">Needs you{waiting > 0 ? ` · ${waiting}` : ''}</div>
      {rows.map(row => ('item' in row
        ? <ItemRow key={row.item.item_id} state={state} row={row} label={names.get(row.item.item_id)!.label} />
        : <Row key={row.kind === 'send' ? row.send.run_id : row.review.approval_id} state={state} row={row} />))}
      {home?.failure && <div class="error more">{message(home.failure)} <button type="button" class="link-button" onClick={() => void loadHome()}>Try again</button></div>}
      <Footer state={state} />
    </div>
  );
}
