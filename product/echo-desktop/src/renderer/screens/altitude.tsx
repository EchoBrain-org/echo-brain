import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { OpenItemView, ProjectSummary } from '../../shared/protocol.js';
import { byDecision, byOwner, byProject, needsAttention, rollup, unowned, waitedDays, type Face, type Health } from '../altitude.js';
import { identity, initial, initials } from '../format.js';
import { itemKind, itemTitle, monthDay } from '../needs.js';
import {
  altitudeProjects, awaitingLive, loadProjects, openCategory, openFollowUp, openFollowUps, openNewProject, openProject, shownItem, zoomOut, zoomTo, type AltLevel,
  type NeedCategory, type ProjectRead, type State,
} from '../store.js';
import { Calendar, Chevron, Doc, Folder, Grid, HealthDot, KindMark, OnePerson, Page, Plus, Ring, Ticket, Ticks } from './icons.js';

/**
 * Home's altitudes (Home altitude v1, One place to look v1): the stops, in
 * the title row; your projects at Home's top, one row each; then one project
 * and one person, each in the same row: a mark, who or what, its name, what
 * needs attention, its people, how far along, and how long. Words are in each
 * mark's tooltip.
 */

const HEALTH: Readonly<Record<Health, string>> = { on: 'On track', risk: 'At risk', off: 'Off track' };
const UNREAD = 'Couldn’t read just now';
export const KIND_ICON: Readonly<Record<OpenItemView['kind'], () => ComponentChildren>> = {
  action: () => <Ticks />, ticket: () => <Ticket />, page: () => <Page />, document: () => <Doc />, record: () => <Calendar />,
};

const days = (count: number) => (count === 1 ? '1 day' : `${count} days`);
const percent = (done: number, total: number) => (total === 0 ? 100 : Math.round((done / total) * 100));

export function Tile({ project }: { project: ProjectSummary }) {
  return <span class="alt-tile" style={identity(project.project_id)} aria-hidden="true">{initial(project.name)}</span>;
}

/** A person's face: their initials on their colour, named on hover, unless what holds it has its own hover (`titled` false), which then shows over it too. */
export function FaceMark({ membership_id, name, needs = false, titled = true }: { membership_id: string; name: string; needs?: boolean; titled?: boolean }) {
  return <span class={`face${needs ? ' needs' : ''}`} style={identity(membership_id)} title={titled ? name : undefined}>{initials(name)}</span>;
}

export function NoOwner() {
  return <span class="face none" title="No owner">?</span>;
}

function Faces({ faces }: { faces: readonly Face[] }) {
  return <>{faces.slice(0, 4).map(face => <FaceMark key={face.membership_id} {...face} />)}</>;
}

/** One row, in a project and for a person: the same columns, so the page reads the same however far in it is. */
function Row({ testid, nav, mark, markTitle, who, name, faint = false, needs = null, needsTitle, people = null, progress = null, date = null, label, zoom, onClick, data = {} }: {
  testid: string; nav: string; mark: ComponentChildren; markTitle: string; who: ComponentChildren; name: ComponentChildren; faint?: boolean;
  needs?: ComponentChildren; needsTitle?: string; people?: ComponentChildren; progress?: ComponentChildren; date?: ComponentChildren;
  label?: string; zoom?: string; onClick: () => void; data?: Record<string, string>;
}) {
  return (
    <button type="button" class={`alt-row${faint ? ' faint' : ''}`} data-testid={testid} data-alt-nav={nav} data-zoom={zoom} aria-label={label} onClick={onClick} {...data}>
      <span class="alt-mark" title={markTitle}>{mark}</span>
      <span class="alt-who">{who}</span>
      <span class="alt-name">{name}</span>
      <span class="alt-needs">{needs !== null && <span class="alt-need" title={needsTitle}>{needs}</span>}</span>
      <span class="alt-people">{people}</span>
      <span class="alt-progress">{progress}</span>
      <span class="alt-date">{date}</span>
    </button>
  );
}

function Progress({ done, total, needs }: { done: number; total: number; needs: number }) {
  const all = total === 0 || done >= total;
  return <><Ring fraction={total === 0 ? 1 : done / total} tone={all ? 'done' : needs > 0 ? 'signal' : 'muted'} />{percent(done, total)}%</>;
}

/** A follow-up's row: its ring (dashed until sent, full once done), what it is, its title, its owner, how long it has waited. */
function ItemRow({ state, item, now, reading }: { state: State; item: OpenItemView; now: number; reading: boolean }) {
  const shown = shownItem(item, state.altitude.live);
  const needs = needsAttention(shown, now);
  const waited = waitedDays(shown, now);
  const words = shown.state === 'unsent' ? 'Not sent yet' : shown.state === 'done' ? 'Done' : 'Sent, still open';
  return (
    <Row testid="alt-item" nav={`item:${shown.item_id}`} data={{ 'data-item': shown.item_id, 'data-state': shown.state }}
      mark={<Ring fraction={shown.state === 'done' ? 1 : 0} tone={shown.state === 'done' ? 'done' : needs ? 'signal' : 'muted'} dashed={shown.state === 'unsent'} />}
      markTitle={waited === null ? words : `${words} · waiting ${days(waited)}`}
      who={<span class="alt-kind" data-kind={shown.kind} title={itemKind(shown, state.tools?.items)}>{KIND_ICON[shown.kind]()}</span>}
      name={<span class={reading && awaitingLive(shown) ? 'reading-title' : undefined}>{itemTitle(shown)}</span>}
      needs={needs ? '!' : null} needsTitle={unowned(shown) ? 'No owner' : waited === null ? undefined : `Waiting ${days(waited)}`}
      people={unowned(shown) ? <NoOwner /> : <FaceMark membership_id={shown.owner.membership_id} name={shown.owner.name} />}
      progress={waited === null ? null : `${waited}d`}
      onClick={() => void openFollowUp(shown.item_id, shown)} />
  );
}

/** The project zoomed into's follow-ups as far as Home read them: every one once read, else those still waiting. */
function rowsOf(read: ProjectRead | undefined): readonly OpenItemView[] {
  return read?.all ?? read?.active ?? [];
}

/** A project Home has not read yet, or read before and is reading again with nothing to show meanwhile. */
const unknown = (read: ProjectRead | undefined) => read === undefined || (read.loading && read.counts === null && read.active.length === 0 && !read.failure);

/** What a header says in place of health and progress while its project is unread. */
function Unread({ failed }: { failed: boolean }) {
  return <span class="alt-chip faint" data-testid="alt-chip" title={failed ? UNREAD : 'Reading'}><Ring fraction={0} tone="faint" />{failed ? UNREAD : 'Reading'}</span>;
}

function GroupHead({ children }: { children: ComponentChildren }) {
  return <div class="alt-group-head" data-testid="alt-group-head">{children}</div>;
}

/** The stops, in the title row on Home: My projects (its top, and any kind's list there), then the project and the person Home last zoomed on. */
export function Stops({ state }: { state: State }) {
  const { level, project_id, membership_id, name } = state.altitude;
  const project = project_id === null ? null : altitudeProjects(state).find(each => each.project_id === project_id) ?? null;
  const person = membership_id !== null && name !== null ? { membership_id, name } : null;
  const stop = (at: 'projects' | 'project' | 'person', label: string, words: string, mark: ComponentChildren, disabled: boolean) => (
    <button type="button" class={`alt-stop${level === at ? ' on' : ''}`} data-testid="alt-stop" data-level={at} aria-label={label} title={label}
      aria-pressed={level === at} disabled={disabled} onClick={() => zoomTo(at)}>
      {mark}{level === at && <span>{words}</span>}
    </button>
  );
  return (
    <nav class="alt-stops" data-testid="alt-stops" aria-label="Zoom">
      <div class="alt-pill">
        {stop('projects', 'My projects', 'My projects', <Grid />, false)}
        <span class="alt-link" aria-hidden="true" />
        {/* A remembered project Home cannot see yet (past the sidebar's first page) still opens: the zoom reads your whole list. */}
        {stop('project', project ? `Project, ${project.name}` : 'Project', project?.name ?? '', project ? <Tile project={project} /> : <Folder />, project_id === null)}
        <span class="alt-link" aria-hidden="true" />
        {stop('person', person ? `Person, ${person.name}` : 'Person', person?.name ?? '', person ? <FaceMark {...person} /> : <OnePerson />, person === null)}
      </div>
    </nav>
  );
}

/** A project at Home's top, as its reads roll up; null while it is unread, or its read failed. */
interface ProjectLine { project: ProjectSummary; read: ProjectRead | undefined; up: ReturnType<typeof rollup> | null }

/**
 * One project at Home's top (One place to look v1): a mark only when it is
 * not on track (a solid orange dot off track, an orange ring at risk; a faint
 * ring while unread), its tile and name, and, faint, why: the follow-up that
 * has needed attention longest, and whose it is. Then a grey bar of how much
 * of its work is done (none with no follow-ups), and how long its oldest has
 * waited. A click zooms into it.
 */
function ProjectRow({ state, line: { project, read, up } }: { state: State; line: ProjectLine }) {
  const label = up ? HEALTH[up.health] : read?.failure ? UNREAD : 'Reading';
  const detail = up ? [up.needs > 0 ? `${up.needs} need attention` : null, up.oldest !== null ? `oldest waiting ${days(up.oldest)}` : null].filter(Boolean).join(' · ') : '';
  // Its title as the live reads Home already made say it (its own, and its altitudes'), so it reads as in Needs you above.
  const why = up?.reason
    ? `${itemTitle(shownItem(up.reason, { ...state.home?.live, ...state.altitude.live }))} · ${unowned(up.reason) ? 'no owner' : up.reason.owner.name}` : null;
  return (
    <button type="button" class={`alt-project-row${up ? '' : ' faint'}`} data-testid="alt-project" data-alt-nav={`project:${project.project_id}`} data-project={project.project_id}
      data-zoom={`project:${project.project_id}`} aria-label={`${project.name}, ${label}`} onClick={() => zoomTo('project', { project_id: project.project_id })}>
      <span class="alt-mark" title={detail === '' ? label : `${label} · ${detail}`}>
        {!up ? <Ring fraction={0} tone="faint" /> : up.health !== 'on' && <HealthDot health={up.health} />}
      </span>
      <span class="alt-what">
        <Tile project={project} /><span class="alt-project-name">{project.name}</span>
        {why !== null && <span class="alt-reason" title={why}>{why}</span>}
      </span>
      <span class="alt-done">
        {up && up.total > 0 && (
          <span class="alt-bar" title={`${up.done} of ${up.total} follow-ups done`}><i style={{ width: `${percent(up.done, up.total)}%` }} /></span>
        )}
      </span>
      <span class="alt-date">{up && up.oldest !== null ? `${up.oldest}d` : null}</span>
    </button>
  );
}

/**
 * Your projects, under Home's Needs you: off track, then at risk, then on
 * track (those needing attention most, then waiting longest, first), then any
 * it could not read. Order carries the grouping: there are no group bars.
 */
export function MyProjects({ state }: { state: State }) {
  const projects = altitudeProjects(state);
  const now = Date.now();
  const lines: ProjectLine[] = projects.map(project => {
    const read = state.altitude.reads[project.project_id];
    // A project whose last read failed is never shown as on track: it says it couldn't be read.
    const known = read !== undefined && !read.failure && !unknown(read);
    return { project, read, up: known ? rollup(read.active, read.counts, now) : null };
  });
  const rank = (a: ProjectLine, b: ProjectLine) => b.up!.needs - a.up!.needs || (b.up!.oldest ?? -1) - (a.up!.oldest ?? -1);
  // On first open the rows keep your list's order while their reads come in, so nothing moves under the pointer.
  const ordered = !state.altitude.settled ? lines : [
    ...(['off', 'risk', 'on'] as const).flatMap(health => lines.filter(line => line.up?.health === health).sort(rank)),
    ...lines.filter(line => line.up === null),
  ];
  return (
    <section class="alt-projects" data-testid="alt-projects" aria-labelledby="alt-projects-head">
      <h2 class="home-label" id="alt-projects-head" data-testid="alt-projects-head">Projects</h2>
      {projects.length === 0 ? (
        state.projects.failure ? (
          <div class="alt-unread">Couldn’t read your projects just now <button type="button" class="link-button" onClick={() => void loadProjects()}>Try again</button></div>
        ) : !state.projects.loading && (
          <button type="button" class="empty-capture" data-testid="empty-new-project" onClick={openNewProject}>
            <span class="ring" aria-hidden="true"><Plus /></span><span>New project</span>
          </button>
        )
      ) : <>
        {state.altitude.listFailure && state.projects.next !== null && <div class="alt-unread">Couldn’t read every project just now</div>}
        {ordered.map(line => <ProjectRow key={line.project.project_id} state={state} line={line} />)}
      </>}
    </section>
  );
}

/** One project: its decisions, then its follow-ups by owner, those needing attention first. */
export function ProjectLevel({ state }: { state: State }) {
  const project = altitudeProjects(state).find(each => each.project_id === state.altitude.project_id);
  if (!project) {
    // A remembered project Home cannot see yet: your projects are still being read, or could not be read at all.
    const failed = Boolean(state.altitude.listFailure) || (Boolean(state.projects.failure) && altitudeProjects(state).length === 0);
    return (
      <div class="alt-level-body" data-testid="alt-project-level">
        <div class="alt-unread">
          {failed ? 'Couldn’t read every project just now' : 'Reading'}{' '}
          {failed && <button type="button" class="link-button" data-testid="alt-back-to-projects" onClick={() => zoomTo('projects')}>My projects</button>}
        </div>
      </div>
    );
  }
  const read = state.altitude.reads[project.project_id];
  const now = Date.now();
  const rows = rowsOf(read);
  const up = rollup(rows, read?.all ? null : read?.counts ?? null, now);
  const owners = byOwner(rows, now);
  const decisions = byDecision(rows, now);
  return (
    <div class="alt-level-body" data-testid="alt-project-level" aria-busy={read?.loading || read?.reading || undefined}>
      <header class="alt-head" data-testid="alt-head">
        <Tile project={project} /><h2>{project.name}</h2>
        {read?.failure || unknown(read) ? <Unread failed={Boolean(read?.failure)} /> : <>
          <span class="alt-chip" data-testid="alt-chip" title={HEALTH[up.health]}><HealthDot health={up.health} />{HEALTH[up.health]}</span>
          <span class="alt-chip" data-testid="alt-chip" title={`${up.done} of ${up.total} follow-ups done`}><Progress {...up} /></span>
          {up.needs > 0 && <span class="alt-chip signal" data-testid="alt-chip" title={`${up.needs} need attention`}>{up.needs}</span>}
        </>}
        <button type="button" class="link-button alt-open" data-testid="alt-open-project" onClick={() => void openProject(project)}>Project page</button>
      </header>
      {decisions.length > 0 && (
        <section class="alt-group" data-testid="alt-group" data-group="decisions">
          <GroupHead><span>Decisions</span><span class="n">{decisions.length}</span></GroupHead>
          {decisions.map(decision => (
            <Row key={decision.record_sha256} testid="alt-decision" nav={`record:${decision.record_sha256}`} onClick={() => void openFollowUps('record', decision.record_sha256, decision.title)}
              mark={<Ring fraction={decision.total === 0 ? 1 : decision.done / decision.total} tone={decision.done >= decision.total ? 'done' : decision.needs > 0 ? 'signal' : 'muted'} />}
              markTitle={`${decision.done} of ${decision.total} follow-ups done`} who={<span class="alt-kind approve" title="Decision"><KindMark kind="approve" /></span>}
              name={decision.title} needs={decision.needs > 0 ? decision.needs : null} needsTitle={`${decision.needs} need attention`}
              people={<Faces faces={decision.faces} />} progress={`${decision.done}/${decision.total}`} date={monthDay(decision.approved_at)} />
          ))}
        </section>
      )}
      {owners.map(group => (
        <section key={group.key} class="alt-group" data-testid="alt-group" data-group={group.key}>
          {group.key === 'none' ? (
            <div class="alt-group-head alt-owner" data-testid="alt-owner"><NoOwner /><span class="alt-label">{group.name}</span><span class="n">{group.total}</span></div>
          ) : (
            <button type="button" class="alt-group-head alt-owner" data-testid="alt-owner" data-alt-nav={`person:${group.key}`} data-zoom={`person:${group.key}`} data-name={group.name}
              onClick={() => zoomTo('person', { membership_id: group.key, name: group.name })}>
              <FaceMark membership_id={group.key} name={group.name} needs={group.needs > 0} /><span class="alt-label">{group.name}</span><span class="n">{group.total}</span>
              <span class="more" title={`${group.done} of ${group.total} done`}><Ring fraction={group.done / group.total} tone={group.done === group.total ? 'done' : 'muted'} /><Chevron /></span>
            </button>
          )}
          {group.rows.map(item => <ItemRow key={item.item_id} state={state} item={item} now={now} reading={Boolean(read?.reading) && item.state !== 'done'} />)}
        </section>
      ))}
    </div>
  );
}

/** One person: what of theirs is waiting in each of your projects, project by project. */
export function PersonLevel({ state }: { state: State }) {
  const { membership_id, name } = state.altitude;
  const projects = altitudeProjects(state);
  if (membership_id === null || name === null) return <div class="alt-level-body" data-testid="alt-person-level" />;
  const now = Date.now();
  const reads = projects.map(project => state.altitude.reads[project.project_id]);
  // Waiting rows only: done ones are read only for the project zoomed into, and would go stale here.
  const groups = byProject(new Map(projects.map((project, index) => [project.project_id, reads[index]?.active ?? []])), membership_id);
  // A follow-up filed in two projects shows in both, and counts once.
  const theirs = [...new Map(groups.flatMap(group => group.rows).map(item => [item.item_id, item])).values()];
  const needs = theirs.filter(item => needsAttention(item, now)).length;
  // Your projects themselves read (or none to read), and each of them read: only then is "nothing waiting" true.
  // A sidebar page that failed counts only when nothing of your list could be read; Home's own read of every page, while it is the list in use.
  const listFailed = (Boolean(state.projects.failure) && projects.length === 0) || (Boolean(state.altitude.listFailure) && state.projects.next !== null);
  const failed = reads.some(read => read?.failure) || listFailed;
  const read = !failed && (projects.length > 0 || !state.projects.loading) && reads.every(read => read !== undefined && !unknown(read));
  return (
    <div class="alt-level-body" data-testid="alt-person-level">
      <header class="alt-head" data-testid="alt-head">
        <FaceMark membership_id={membership_id} name={name} /><h2>{name}</h2>
        <span class="alt-chip" data-testid="alt-chip" title={`${theirs.length} waiting`}><Ring fraction={0} tone="muted" />{theirs.length}</span>
        {needs > 0 && <span class="alt-chip signal" data-testid="alt-chip" title={`${needs} need attention`}>{needs}</span>}
      </header>
      {failed && <div class="alt-unread">Couldn’t read every project just now</div>}
      {groups.length === 0 && read && <div class="alt-unread">Nothing of theirs is waiting</div>}
      {groups.map(group => {
        const project = projects.find(each => each.project_id === group.project_id)!;
        const projectRead = state.altitude.reads[group.project_id];
        const health = projectRead && !projectRead.failure && !unknown(projectRead) ? rollup(projectRead.active, null, now).health : null;
        return (
          <section key={group.project_id} class="alt-group" data-testid="alt-group" data-group={group.project_id}>
            <button type="button" class="alt-group-head" data-testid="alt-project-head" data-alt-nav={`project:${group.project_id}`} data-zoom={`project:${group.project_id}`}
              onClick={() => zoomTo('project', { project_id: group.project_id })}>
              <Tile project={project} /><span class="alt-label">{project.name}</span><span class="n">{group.rows.length}</span>
              <span class="more" title={health ? HEALTH[health] : UNREAD}>{health ? <HealthDot health={health} /> : <Ring fraction={0} tone="faint" />}<Chevron /></span>
            </button>
            {group.rows.map(item => <ItemRow key={item.item_id} state={state} item={item} now={now} reading={state.altitude.reading} />)}
          </section>
        );
      })}
    </div>
  );
}

/** When the last pinch zoomed: a pinch zooms at most once every 400 ms, starting with the first. */
let lastPinch = Number.NEGATIVE_INFINITY;

/** A trackpad pinch (a wheel with ctrl): spread over a row to zoom into it, pinch to zoom out. Plain scrolling scrolls. */
function pinch(event: WheelEvent): void {
  if (!event.ctrlKey) return;
  event.preventDefault();
  if (event.timeStamp - lastPinch < 400) return;
  lastPinch = event.timeStamp;
  if (event.deltaY > 0) { zoomOut(); return; }
  const target = (event.target as Element | null)?.closest<HTMLElement>('[data-zoom]');
  const [level, id] = (target?.dataset.zoom ?? '').split(':');
  if (level === 'project' && id) zoomTo('project', { project_id: id });
  else if (level === 'person' && id && target?.dataset.name) zoomTo('person', { membership_id: id, name: target.dataset.name });
  else if (level === 'category' && id) openCategory(id as NeedCategory);
}

/** The rows ↑ and ↓ move between, each `data-alt-nav` naming its row (`item:…`, `project:…`), in the order they show. */
const navRows = (box: HTMLElement) => [...box.querySelectorAll<HTMLElement>('[data-alt-nav]:not([disabled])')];

/** ↑ and ↓ move between rows once one (or the level itself) has the focus; the Ask bar keeps its own keys. */
function arrows(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const here = document.activeElement;
  const box = event.currentTarget as HTMLElement;
  const all = navRows(box);
  if (here === box) {
    if (event.key === 'ArrowDown' && all[0]) { event.preventDefault(); all[0].focus(); }
    return;
  }
  if (!(here instanceof HTMLElement) || !here.hasAttribute('data-alt-nav')) return;
  const next = all[all.indexOf(here) + (event.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/** How far in Home is: its top, one kind's list just under it, then a project, then a person. */
const DEPTH: Readonly<Record<AltLevel, number>> = { projects: 0, project: 2, person: 3 };
const depth = (level: AltLevel, category: NeedCategory | null) => DEPTH[level] + (category === null ? 0 : 1);

/**
 * The row Home's focus was on last, kept while Home is away (a row's page, a
 * decision, another page): at which altitude, which row, and where it was
 * among the rows.
 */
let held: { at: string; row: string; index: number } | null = null;

/** Nothing has the focus: whatever had it went, or a click let go of it. */
const focusLost = () => document.activeElement === null || document.activeElement === document.body;

/** A row took the focus: Home keeps it, to give it back. */
function hold(event: FocusEvent, at: string): void {
  const row = event.target as HTMLElement;
  if (row.dataset?.altNav !== undefined) held = { at, row: row.dataset.altNav, index: navRows(event.currentTarget as HTMLElement).indexOf(row) };
}

/**
 * Home: the altitude it shows, re-made at each zoom so it eases in. At the
 * top it shows `top` (what needs you and your projects, or one kind's list).
 * A zoom that took away the row with the focus (Enter on it, Escape from it)
 * gives the focus, on the way out, to the row it came from; on the way in, to
 * the first row; with no rows yet, to the level itself, where ↓ finds them.
 * Back on Home as it was left, the row it was left on has it again, else the
 * row now in its place. A read that takes the focus from the level (it moves
 * the row with it, reads that row away, or takes Try again) gives it back the
 * same way; a focus already elsewhere (a click let go of it) stays there.
 */
export function Altitude({ state, top }: { state: State; top: ComponentChildren }) {
  const { level, category, project_id, membership_id } = state.altitude;
  const at = `${level} ${category} ${project_id} ${membership_id}`;
  const box = useRef<HTMLDivElement>(null);
  // The focus is in the level as it was before this render.
  const had = box.current?.contains(document.activeElement) ?? false;
  // Null until it shows: Home is back, not zoomed.
  const was = useRef<{ level: AltLevel; category: NeedCategory | null } | null>(null);
  useEffect(() => {
    const before = was.current;
    was.current = { level, category };
    const root = box.current;
    if (!root || !focusLost()) return;
    const out = before !== null && depth(level, category) < depth(before.level, before.category);
    const from = !out ? null : before.category !== null ? `category:${before.category}` : level === 'projects' && project_id !== null ? `project:${project_id}`
      : level === 'project' && membership_id !== null ? `person:${membership_id}` : null;
    const back = from === null ? null : root.querySelector<HTMLElement>(`[data-zoom="${CSS.escape(from)}"]`)
      // Out of a kind's list down to one row: the top shows that row in place of the kind's line.
      ?? (before?.category ? root.querySelector<HTMLElement>(`[data-category="${before.category}"][data-alt-nav]:not([disabled])`) : null);
    const rows = navRows(root);
    const kept = before === null && held?.at === at ? held : null;
    const left = kept ? rows.find(row => row.dataset.altNav === kept.row) ?? rows[Math.min(kept.index, rows.length - 1)] : undefined;
    const target = back ?? left ?? rows[0];
    if (target) { target.focus(); return; }
    // No rows yet: the level holds the focus (↓ finds the rows once they come), and lets go of it after, so a click never lands on it.
    root.tabIndex = -1;
    root.addEventListener('blur', () => root.removeAttribute('tabindex'), { once: true });
    root.focus();
  }, [level, category, project_id, membership_id]);
  // This render took the focus from the level (a reload moved or read away what had it): the row it was on takes it again, else the
  // row now in its place, else the last row. Home stays scrolled where the person left it.
  useEffect(() => {
    const root = box.current;
    const kept = held;
    if (!root || kept?.at !== at) return;
    const rows = navRows(root);
    const index = rows.findIndex(row => row.dataset.altNav === kept.row);
    if (index >= 0) kept.index = index;
    if (had && focusLost()) rows[Math.min(kept.index, rows.length - 1)]?.focus({ preventScroll: true });
  });
  return (
    <div class="alt-level" ref={box} key={at} onWheel={pinch} onKeyDown={arrows} onFocusCapture={event => hold(event, at)}>
      {level === 'project' ? <ProjectLevel state={state} /> : level === 'person' ? <PersonLevel state={state} /> : top}
    </div>
  );
}
