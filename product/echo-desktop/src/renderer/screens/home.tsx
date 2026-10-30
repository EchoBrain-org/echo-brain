import { identity, initial, when } from '../format.js';
import { message } from '../messages.js';
import { actionCount, itemLine, itemNames, meetingSuffix, monthDay, shortNames, titleLine, toSend } from '../needs.js';
import {
  awaitingLive, homeCategories, homeRows, loadHome, needAt, openCategory, openDecision, openFollowUp, openFollowUps, openNewProject, type HomeCategory,
  type NeedCategory, type NeedRow, type State,
} from '../store.js';
import { Altitude, MyProjects } from './altitude.js';
import { Chevron, KindMark, Plus } from './icons.js';

/** The row's verb: what a click will ask of you. "Check" is never one: it is ECHO's re-read (R63). */
const KIND: Record<NeedRow['kind'], string> = { approve: 'Approve', send: 'Send', update: 'Update', review: 'Review', failed: 'Retry', checking: 'Checking' };
/** A kind's verb on Home's top, and the mark it shares with its rows. */
const CATEGORY: Record<HomeCategory['category'], { verb: string; mark: NeedRow['kind'] }> = {
  approve: { verb: 'Approve', mark: 'approve' }, retry: { verb: 'Retry', mark: 'failed' }, send: { verb: 'Send', mark: 'send' },
  update: { verb: 'Update', mark: 'update' }, checking: { verb: 'Checking', mark: 'checking' },
};

/** How long ago, as Home's lines say it beside a kind: now, 5m, 2h, 3d; nothing with no time. */
export function age(iso: string | null, now = Date.now()): string {
  const minutes = iso === null ? Number.NaN : Math.floor(Math.max(0, now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  return minutes < 1_440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1_440)}d`;
}

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
      <button type="button" class="need-row send" data-testid="need-row" data-kind="send" data-alt-nav=""
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
    <button type="button" class={`need-row ${row.kind}`} data-testid="need-row" data-kind={row.kind} data-alt-nav="" disabled={row.kind === 'checking'}
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
    <button type="button" class={`need-row ${row.kind}`} data-testid="need-row" data-kind={row.kind} data-alt-nav="" aria-busy={reading || undefined}
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

/**
 * Each of Home's rows, as Needs you shows it: a follow-up by its title, apart
 * from any other on Home (R76: Home no longer repeats the meeting beneath
 * every title, so actions from different meetings use their qualified name),
 * and `name`, what a kind's line calls its newest: a follow-up's title, else
 * its meeting.
 */
function needRowsOf(state: State, rows: readonly NeedRow[]) {
  const names = itemNames(rows.flatMap(row => ('item' in row ? [row.item] : [])));
  return {
    shown: (row: NeedRow) => ('item' in row
      ? <ItemRow key={row.item.item_id} state={state} row={row} label={names.get(row.item.item_id)!.name} />
      : <Row key={row.kind === 'send' ? row.send.run_id : row.review.approval_id} state={state} row={row} />),
    name: (row: NeedRow) => ('item' in row ? names.get(row.item.item_id)!.name : row.kind === 'send' ? row.send.decision.title : row.review.title),
  };
}

/**
 * Two or more of one kind, as one line (One place to look v1): the verb and
 * how many, in orange, the newest's name, how many more, faintly, and how
 * long ago the newest came; a click opens the kind's list. Checks still on
 * their way are one faint line that opens nothing: there is nothing to do yet.
 */
function CategoryLine({ category: { category, rows }, name }: { category: HomeCategory; name: string }) {
  const { verb, mark } = CATEGORY[category];
  const words = <>
    <span class="need-kind"><KindMark kind={mark} />{verb}</span>
    {category !== 'checking' && <span class="need-category-count">{rows.length}</span>}
    <span class="need-category-name">{name}</span>
    <span class="need-category-more">and {rows.length - 1} more</span>
  </>;
  if (category === 'checking') return <div class="need-category checking" data-testid="need-category" data-category={category}>{words}</div>;
  return (
    <button type="button" class="need-category" data-testid="need-category" data-category={category} data-alt-nav="" data-zoom={`category:${category}`}
      title={`See all ${rows.length} to ${verb.toLowerCase()}`} onClick={() => openCategory(category)}>
      {words}<span class="need-category-age">{age(needAt(rows[0]!))}</span><Chevron />
    </button>
  );
}

/**
 * Home: zoomed out, its top (what needs you, then your projects) or one
 * kind's list; zoomed in, one project or one person (Home altitude v1, One
 * place to look v1). The stops are in the title row.
 */
export function Home({ state }: { state: State }) {
  const { category } = state.altitude;
  return (
    <div class="home" data-testid="home">
      <Altitude state={state} top={category === null ? <Top state={state} /> : <CategoryList state={state} category={category} />} />
    </div>
  );
}

/**
 * Home's top: what needs you, then your projects. With no projects and
 * nothing waiting it is the first run, with New project alone.
 */
function Top({ state }: { state: State }) {
  const home = state.home;
  const rows = homeRows(state);
  const noProjects = !state.projects.loading && !state.projects.failure && state.projects.items.length === 0 &&
    !state.archivedProjects.loading && !state.archivedProjects.failure && state.archivedProjects.items.length === 0;
  if (noProjects && rows.length === 0 && !home?.loading && !home?.failure) {
    return (
      <div class="alt-level-body alt-empty" data-testid="home-empty">
        <button type="button" class="empty-capture" data-testid="empty-new-project" onClick={openNewProject}>
          <span class="ring" aria-hidden="true"><Plus /></span>
          <span>New project</span>
        </button>
      </div>
    );
  }
  return (
    <div class="alt-level-body home-top">
      <NeedsYou state={state} rows={rows} />
      <MyProjects state={state} />
    </div>
  );
}

/**
 * What needs you, at the top of Home, by kind (One place to look v1): meetings
 * to approve, checks to retry, follow-ups to send, follow-ups to update (and
 * to review), then checks still on their way. A kind with one row shows that
 * row; with more, one line that opens its list. Its count is the sidebar's
 * badge. With nothing waiting, one quiet line.
 */
function NeedsYou({ state, rows }: { state: State; rows: readonly NeedRow[] }) {
  const home = state.home;
  const busy = home ? home.loading || home.reading : true;
  const failure = home?.failure && <div class="error more">{message(home.failure)} <button type="button" class="link-button" onClick={() => void loadHome()}>Try again</button></div>;
  if (home?.failure && rows.length === 0) return <section class="needs" data-testid="home-error">{failure}</section>;
  if (rows.length === 0) {
    return (
      <section class="needs" data-testid="needs" aria-busy={busy}>
        <div class="home-clear" data-testid="home-clear">{home && !home.loading && 'Nothing needs you'}</div>
      </section>
    );
  }
  const waiting = rows.filter(row => row.kind !== 'checking').length;
  const { shown, name } = needRowsOf(state, rows);
  return (
    <section class="needs" data-testid="needs" aria-busy={busy} aria-labelledby="needs-head">
      <h2 class="home-label" id="needs-head" data-testid="needs-head">Needs you{waiting > 0 && <span class="n">{waiting}</span>}</h2>
      {homeCategories(rows).map(category => (category.rows.length === 1 ? shown(category.rows[0]!)
        : <CategoryLine key={category.category} category={category} name={name(category.rows[0]!)} />))}
      {failure}
    </section>
  );
}

/**
 * One kind's list: Home zoomed into it (One place to look v1). Its verb and
 * how many, then its rows exactly as Needs you shows them, the newest first.
 * The title row's Home, Escape, the stops and the sidebar's Home go back to
 * the top; so does the store, by itself, once its last row is dealt with.
 */
function CategoryList({ state, category }: { state: State; category: NeedCategory }) {
  const home = state.home;
  const all = homeRows(state);
  const rows = homeCategories(all).find(each => each.category === category)?.rows ?? [];
  const { shown } = needRowsOf(state, all);
  return (
    <div class="alt-level-body">
      <section class="needs" data-testid="needs" data-category={category} aria-busy={home ? home.loading || home.reading : true} aria-labelledby="need-list-head">
        <h2 class="need-list-head" id="need-list-head" data-testid="need-list-head">
          <span class="need-list-verb">{CATEGORY[category].verb}</span><span class="need-category-count">{rows.length}</span>
        </h2>
        {rows.map(shown)}
      </section>
    </div>
  );
}
