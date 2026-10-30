import { useState } from 'preact/hooks';
import { identity, initial, when } from '../format.js';
import { message } from '../messages.js';
import { actionCount, homeFooter, itemLine, itemNames, meetingSuffix, monthDay, shortNames, titleLine, toSend } from '../needs.js';
import {
  awaitingLive, homeRows, loadHome, openDecision, openFollowUp, openFollowUps, openNewProject, openOnlyMe, openYourFollowUps, type NeedRow, type State,
} from '../store.js';
import { Altitude, Stops } from './altitude.js';
import { KindMark, Lock, Plus } from './icons.js';

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

/**
 * Where and when, opening a row's second line (Proximity): the first of its
 * projects Home knows, as its mark and name ("Supplier review +1"; all of
 * them in its tooltip), then when, for a row that has a time. With no project
 * known it starts with the time; with neither it is nothing.
 */
export function Where({ state, at, projects }: { state: State; at?: string | null; projects: readonly string[] }) {
  const names = projectNames(state, projects);
  const first = names[0];
  const time = at ? when(at) : '';
  if (!first && time === '') return null;
  return (
    <>
      {first && (
        <span class="need-where" title={names.map(name => name.name).join(', ')}>
          <span class="need-dot" style={identity(first.id)} aria-hidden="true">{initial(first.name)}</span>
          <span class="need-where-name">{first.name}</span>
          {names.length > 1 && <span class="need-where-more">+{names.length - 1}</span>}
        </span>
      )}
      {first && time !== '' && ' · '}
      {time !== '' && <span class="need-when">{time}</span>}
      {' · '}
    </>
  );
}

/** A meeting's line: "Decision · 2 actions · Pilot planning meeting, Oct 6" ("meeting" only once, R76). */
export function ReviewLine({ row }: { row: Extract<NeedRow, { review: unknown }> }) {
  const review = row.review;
  if (row.kind === 'checking') return <>{review.status === 'publishing' && !row.run ? 'Approved · publishing to ECHO' : 'Approved · checking what it changes'}</>;
  if (row.kind === 'failed') return <>Approved · the check did not finish</>;
  // A whole day is its UTC date, the same day wherever Home shows it.
  const day = review.meeting_at === null ? null : monthDay(review.all_day ? review.meeting_at.slice(0, 10) : review.meeting_at);
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
        <span class="need-kind"><KindMark kind="send" />{KIND.send}</span>
        <span class="need-text">
          <span class="need-title">{titleLine(send.decision.first_line ?? send.decision.title)} — {toSend(send.items)}</span>
          <span class="need-detail">
            <Where state={state} at={send.finished_at} projects={send.decision.project_ids} />
            From <b>{send.decision.title}</b>{owners.length > 0 ? ` · owners ${owners.join(', ')}` : ''}
          </span>
        </span>
      </button>
    );
  }
  const review = row.review;
  const run = row.kind === 'approve' ? undefined : row.run;
  return (
    <button type="button" class={`need-row ${row.kind}`} data-testid="need-row" data-kind={row.kind} disabled={row.kind === 'checking'}
      onClick={() => void openDecision(review.approval_id, run ?? null)}>
      <span class="need-kind"><KindMark kind={row.kind} />{KIND[row.kind]}</span>
      <span class="need-text">
        <span class="need-title">{titleLine(review.first_line ?? review.title)}</span>
        <span class="need-detail">
          <Where state={state} at={run?.updated_at} projects={review.project_ids} />
          <ReviewLine row={row} />
          {row.kind === 'checking' && <span class="asking" aria-hidden="true"><i /><i /><i /></span>}
        </span>
      </span>
    </button>
  );
}

/**
 * Update, for a follow-up that waits on you, and Review, for one someone else
 * owns that changed since you sent it (R64): the whole row opens its page
 * (F5), which says where it came from. Its two lines: its title (`label`,
 * apart from any other on Home), and its project, then what the meeting needs
 * of it, what it says now and whose it is.
 */
function ItemRow({ state, row, label }: { state: State; row: Extract<NeedRow, { item: unknown }>; label: string }) {
  const { item } = row;
  // Shown from ECHO's own fields at once: while ECHO reads it in its tool, its title says what it is and its meeting, faintly.
  const reading = state.home?.reading === true && awaitingLive(item);
  return (
    <button type="button" class={`need-row ${row.kind}`} data-testid="need-row" data-kind={row.kind} aria-busy={reading || undefined}
      onClick={() => void openFollowUp(item.item_id, item)}>
      <span class="need-kind"><KindMark kind={row.kind} />{KIND[row.kind]}</span>
      <span class="need-text">
        <span class={`need-title${reading ? ' reading-title' : ''}`} data-reading={reading || undefined}>{label}</span>
        <span class="need-change">
          <Where state={state} projects={item.decision?.project_ids ?? []} />
          {itemLine(item, state.status?.account?.membership_id ?? null, state.tools?.items)}
        </span>
      </span>
    </button>
  );
}

/** Home's groups, once it is long, in its order. */
export type HomeGroupName = 'decisions' | 'send' | 'follow-ups' | 'checking';
const GROUPS: readonly { name: HomeGroupName; label: string; kinds: readonly NeedRow['kind'][] }[] = [
  { name: 'decisions', label: 'Decisions', kinds: ['approve', 'failed'] },
  { name: 'send', label: 'To send', kinds: ['send'] },
  { name: 'follow-ups', label: 'Follow-ups', kinds: ['review', 'update'] },
  { name: 'checking', label: 'Checking', kinds: ['checking'] },
];
/** More rows than this wait on you (Checking aside), and Home groups them. */
export const FLAT_ROWS = 10;
/** The rows a group shows before its "Show N more". */
export const GROUP_ROWS = 5;

export interface HomeGroup {
  name: HomeGroupName;
  label: string;
  /** All its rows, shown or not. */
  count: number;
  rows: NeedRow[];
  /** Its rows past the first five, until it is opened. */
  hidden: number;
}

/**
 * Home's rows as it shows them: one list while at most ten wait on you
 * (null); past that, grouped in Home's order, Decisions (Approve and Retry),
 * To send, Follow-ups and Checking, each counted and showing its first five
 * rows until it is opened (`open`).
 */
export function homeGroups(rows: readonly NeedRow[], open: ReadonlySet<HomeGroupName>): HomeGroup[] | null {
  if (rows.filter(row => row.kind !== 'checking').length <= FLAT_ROWS) return null;
  return GROUPS.flatMap(({ name, label, kinds }) => {
    const all = rows.filter(row => kinds.includes(row.kind));
    const shown = open.has(name) ? all : all.slice(0, GROUP_ROWS);
    return all.length === 0 ? [] : [{ name, label, count: all.length, rows: shown, hidden: all.length - shown.length }];
  });
}

/**
 * Under the rows, and on an empty Home (F9): one line, its links first. "2
 * waiting on others" while anything waits on others, else "Follow-ups": it
 * opens Follow-ups (everything you sent, own or last handed on), so Home
 * keeps its own way there even with the sidebar hidden. Then Only me, with
 * its lock and no count: everything only you can read, filed in a project or
 * not (ADR-0049). Then when ECHO last checked.
 */
export function Footer({ state }: { state: State }) {
  const { link, checked } = homeFooter(state.home?.open ?? null);
  return (
    <div class="needs-foot" data-testid="needs-foot">
      <button type="button" class="link-button inline needs-foot-link" data-testid="your-follow-ups" onClick={() => void openYourFollowUps()}>{link}</button>
      <span class="needs-foot-words">{' · '}</span>
      <button type="button" class="link-button inline needs-foot-link" data-testid="home-only-me" onClick={() => void openOnlyMe()}><Lock />Only me</button>
      {checked !== null && <span class="needs-foot-words">{` · ${checked}`}</span>}
    </div>
  );
}

/**
 * Home: the stops, then Me (only what waits on you) or, zoomed out, your
 * projects, one project or one person (Home altitude v1).
 */
export function Home({ state }: { state: State }) {
  return (
    <div class="home" data-testid="home">
      <Stops state={state} />
      {state.altitude.level === 'me' ? <NeedsYou state={state} /> : <Altitude state={state} />}
    </div>
  );
}

/**
 * Me: only what waits on you. Decisions from meetings to approve, checks
 * to retry, meetings you approved with follow-ups to send, follow-ups that
 * wait on you, and checks still on their way; grouped once it is long.
 * Projects live in the sidebar.
 */
function NeedsYou({ state }: { state: State }) {
  // Groups opened past their first five rows stay open while Home is on screen.
  const [open, setOpen] = useState<ReadonlySet<HomeGroupName>>(new Set());
  const home = state.home;
  const rows = homeRows(state);
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
        <div class="home-clear" data-testid="home-clear">{home && !home.loading && <span>Nothing needs you</span>}</div>
        <Footer state={state} />
      </div>
    );
  }
  const waiting = rows.filter(row => row.kind !== 'checking').length;
  const names = itemNames(rows.flatMap(row => ('item' in row ? [row.item] : [])));
  // Home no longer repeats the meeting beneath every title. Use the qualified
  // name when titles collide, so actions from different meetings stay distinct.
  const shown = (row: NeedRow) => ('item' in row
    ? <ItemRow key={row.item.item_id} state={state} row={row} label={names.get(row.item.item_id)!.name} />
    : <Row key={row.kind === 'send' ? row.send.run_id : row.review.approval_id} state={state} row={row} />);
  const groups = homeGroups(rows, open);
  return (
    <div class="column needs" data-testid="needs" aria-busy={home ? home.loading || home.reading : true}>
      <h1 class="needs-head">Needs you{waiting > 0 && <> <span class="count">{waiting}</span></>}</h1>
      {groups === null ? rows.map(shown) : groups.map(group => (
        <section key={group.name} class="needs-group" data-testid="needs-group" aria-labelledby={`needs-group-${group.name}`}>
          <h2 class="section-label needs-group-head" id={`needs-group-${group.name}`}>{group.label} · {group.count}</h2>
          {group.rows.map(shown)}
          {group.hidden > 0 && (
            <button type="button" class="link-button needs-more" data-testid="needs-more" onClick={() => setOpen(new Set([...open, group.name]))}>
              Show {group.hidden} more
            </button>
          )}
        </section>
      ))}
      {home?.failure && <div class="error more">{message(home.failure)} <button type="button" class="link-button" onClick={() => void loadHome()}>Try again</button></div>}
      <Footer state={state} />
    </div>
  );
}
