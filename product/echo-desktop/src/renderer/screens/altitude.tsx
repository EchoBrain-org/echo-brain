import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { OpenItemView, ProjectSummary } from '../../shared/protocol.js';
import { byDecision, byOwner, byProject, needsAttention, rollup, unowned, waitedDays, type Face, type Health } from '../altitude.js';
import { identity, initial, initials } from '../format.js';
import { itemKind, itemTitle, monthDay } from '../needs.js';
import {
  altitudeProjects, awaitingLive, loadProjects, openFollowUp, openFollowUps, openNewProject, openProject, shownItem, zoomOut, zoomTo, type ProjectRead, type State,
} from '../store.js';
import { Calendar, Chevron, Doc, Folder, Grid, HealthDot, KindMark, Locate, OnePerson, Page, Plus, Ring, Ticket, Ticks } from './icons.js';

/**
 * Home's altitudes (Home altitude v1): the stops, and My projects, one
 * project and one person, each in the same row: a mark, who or what, its
 * name, what needs attention, its people, how far along, and how long.
 * Words are in each mark's tooltip.
 */

const HEALTH: Readonly<Record<Health, string>> = { on: 'On track', risk: 'At risk', off: 'Off track' };
const UNREAD = 'Couldn’t read just now';
const KIND_ICON: Readonly<Record<OpenItemView['kind'], () => ComponentChildren>> = {
  action: () => <Ticks />, ticket: () => <Ticket />, page: () => <Page />, document: () => <Doc />, record: () => <Calendar />,
};

const days = (count: number) => (count === 1 ? '1 day' : `${count} days`);
const percent = (done: number, total: number) => (total === 0 ? 100 : Math.round((done / total) * 100));

function Tile({ project }: { project: ProjectSummary }) {
  return <span class="alt-tile" style={identity(project.project_id)} aria-hidden="true">{initial(project.name)}</span>;
}

function FaceMark({ membership_id, name, needs = false }: { membership_id: string; name: string; needs?: boolean }) {
  return <span class={`face${needs ? ' needs' : ''}`} style={identity(membership_id)} title={name}>{initials(name)}</span>;
}

function NoOwner() {
  return <span class="face none" title="No owner">?</span>;
}

function Faces({ faces }: { faces: readonly Face[] }) {
  return <>{faces.slice(0, 4).map(face => <FaceMark key={face.membership_id} {...face} />)}</>;
}

/** One row, every altitude: the same columns, so the page reads the same however far out it is. */
function Row({ testid, mark, markTitle, who, name, faint = false, needs = null, needsTitle, people = null, progress = null, date = null, label, zoom, onClick, data = {} }: {
  testid: string; mark: ComponentChildren; markTitle: string; who: ComponentChildren; name: ComponentChildren; faint?: boolean;
  needs?: ComponentChildren; needsTitle?: string; people?: ComponentChildren; progress?: ComponentChildren; date?: ComponentChildren;
  label?: string; zoom?: string; onClick: () => void; data?: Record<string, string>;
}) {
  return (
    <button type="button" class={`alt-row${faint ? ' faint' : ''}`} data-testid={testid} data-alt-nav="" data-zoom={zoom} aria-label={label} onClick={onClick} {...data}>
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
    <Row testid="alt-item" data={{ 'data-item': shown.item_id, 'data-state': shown.state }}
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

/** The stops: My projects, the project and the person Home last zoomed on, and Me. */
export function Stops({ state }: { state: State }) {
  const { level, project_id, membership_id, name } = state.altitude;
  const project = project_id === null ? null : state.projects.items.find(each => each.project_id === project_id) ?? null;
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
        {stop('project', project ? `Project, ${project.name}` : 'Project', project?.name ?? '', project ? <Tile project={project} /> : <Folder />, project === null)}
        <span class="alt-link" aria-hidden="true" />
        {stop('person', person ? `Person, ${person.name}` : 'Person', person?.name ?? '', person ? <FaceMark {...person} /> : <OnePerson />, person === null)}
      </div>
      <button type="button" class={`alt-me${level === 'me' ? ' on' : ''}`} data-testid="alt-me" aria-label="Me" title="Me" aria-pressed={level === 'me'}
        onClick={() => zoomTo('me')}><Locate /></button>
    </nav>
  );
}

/** My projects: each project's health, what needs attention, its people, how far along, and how long its oldest has waited. */
export function MyProjects({ state }: { state: State }) {
  const projects = altitudeProjects(state);
  if (projects.length === 0) {
    return (
      <div class="alt-level-body alt-empty" data-testid="alt-projects">
        {state.projects.failure ? (
          <div class="alt-unread">Couldn’t read your projects just now <button type="button" class="link-button" onClick={() => void loadProjects()}>Try again</button></div>
        ) : !state.projects.loading && (
          <button type="button" class="empty-capture" data-testid="empty-new-project" onClick={openNewProject}>
            <span class="ring" aria-hidden="true"><Plus /></span><span>New project</span>
          </button>
        )}
      </div>
    );
  }
  const now = Date.now();
  const rows = projects.map(project => {
    const read = state.altitude.reads[project.project_id];
    // A project whose last read failed is never shown as on track: it says it couldn't be read.
    const known = read !== undefined && !read.failure && !unknown(read);
    return { project, read, up: known ? rollup(read.active, read.counts, now) : null };
  });
  const row = ({ project, read, up }: (typeof rows)[number]) => {
    const zoom = () => zoomTo('project', { project_id: project.project_id });
    const data = { 'data-project': project.project_id };
    if (!up) {
      const failed = Boolean(read?.failure);
      return <Row key={project.project_id} testid="alt-project" data={data} zoom={`project:${project.project_id}`} onClick={zoom} faint
        label={`${project.name}, ${failed ? UNREAD : 'Reading'}`} mark={<Ring fraction={0} tone="faint" />} markTitle={failed ? UNREAD : 'Reading'}
        who={<Tile project={project} />} name={project.name} />;
    }
    const detail = [up.needs > 0 ? `${up.needs} need attention` : null, up.oldest !== null ? `oldest waiting ${days(up.oldest)}` : null].filter(Boolean).join(' · ');
    return <Row key={project.project_id} testid="alt-project" data={data} zoom={`project:${project.project_id}`} onClick={zoom}
      label={`${project.name}, ${HEALTH[up.health]}`} mark={<HealthDot health={up.health} />} markTitle={detail === '' ? HEALTH[up.health] : `${HEALTH[up.health]} · ${detail}`}
      who={<Tile project={project} />} name={project.name} needs={up.needs > 0 ? up.needs : null} needsTitle={`${up.needs} need attention`}
      people={<Faces faces={up.faces} />} progress={<Progress {...up} />} date={up.oldest === null ? null : `${up.oldest}d`} />;
  };
  const rank = (a: (typeof rows)[number], b: (typeof rows)[number]) => b.up!.needs - a.up!.needs || (b.up!.oldest ?? -1) - (a.up!.oldest ?? -1);
  const count = (health: Health) => rows.filter(each => each.up?.health === health).length;
  const unread = rows.filter(each => each.up === null);
  return (
    <div class="alt-level-body" data-testid="alt-projects">
      <header class="alt-head" data-testid="alt-head">
        <span class="alt-head-mark" aria-hidden="true"><Grid /></span><h2>My projects</h2>
        {(['off', 'risk', 'on'] as const).map(health => (
          <span key={health} class="alt-chip" data-testid="alt-chip" title={`${count(health)} ${HEALTH[health].toLowerCase()}`}><HealthDot health={health} />{count(health)}</span>
        ))}
      </header>
      {/* On first open the rows keep your list's order while their reads come in, so nothing moves under the pointer. */}
      {!state.altitude.settled ? <section class="alt-group" data-testid="alt-group" data-group="reading">{rows.map(row)}</section> : <>
        {(['off', 'risk', 'on'] as const).map(health => {
          const these = rows.filter(each => each.up?.health === health).sort(rank);
          return these.length === 0 ? null : (
            <section key={health} class="alt-group" data-testid="alt-group" data-group={health}>
              <GroupHead><HealthDot health={health} /><span class="alt-label">{HEALTH[health]}</span><span class="n">{these.length}</span></GroupHead>
              {these.map(row)}
            </section>
          );
        })}
        {unread.length > 0 && <section class="alt-group" data-testid="alt-group" data-group="unread">{unread.map(row)}</section>}
      </>}
    </div>
  );
}

/** One project: its decisions, then its follow-ups by owner, those needing attention first. */
export function ProjectLevel({ state }: { state: State }) {
  const project = altitudeProjects(state).find(each => each.project_id === state.altitude.project_id);
  if (!project) return <div class="alt-level-body" data-testid="alt-project-level" />;
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
            <Row key={decision.record_sha256} testid="alt-decision" onClick={() => void openFollowUps('record', decision.record_sha256, decision.title)}
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
            <button type="button" class="alt-group-head alt-owner" data-testid="alt-owner" data-alt-nav="" data-zoom={`person:${group.key}`} data-name={group.name}
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
  const failed = reads.some(read => read?.failure);
  const read = reads.every(read => read !== undefined && !read.failure && !unknown(read));
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
            <button type="button" class="alt-group-head" data-testid="alt-project-head" data-alt-nav="" data-zoom={`project:${group.project_id}`}
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
}

/** ↑ and ↓ move between rows once one has the focus; the Ask bar keeps its own keys. */
function arrows(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const here = document.activeElement;
  if (!(here instanceof HTMLElement) || !here.hasAttribute('data-alt-nav')) return;
  const all = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-alt-nav]:not([disabled])')];
  const next = all[all.indexOf(here) + (event.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/**
 * Home zoomed out: the altitude it shows, re-made at each zoom so it eases in.
 * A zoom that took away the row with the focus (Enter on it, Escape from it)
 * gives the focus to the row it came from on the way out, else the first row.
 */
export function Altitude({ state }: { state: State }) {
  const { level, project_id, membership_id } = state.altitude;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = box.current;
    if (!root || (document.activeElement !== null && document.activeElement !== document.body)) return;
    const from = level === 'projects' && project_id !== null ? `project:${project_id}` : level === 'project' && membership_id !== null ? `person:${membership_id}` : null;
    const back = from === null ? null : root.querySelector<HTMLElement>(`[data-zoom="${CSS.escape(from)}"]`);
    (back ?? root.querySelector<HTMLElement>('[data-alt-nav]:not([disabled])'))?.focus();
  }, [level, project_id, membership_id]);
  return (
    <div class="alt-level" ref={box} key={`${level} ${project_id} ${membership_id}`} onWheel={pinch} onKeyDown={arrows}>
      {level === 'project' ? <ProjectLevel state={state} /> : level === 'person' ? <PersonLevel state={state} /> : <MyProjects state={state} />}
    </div>
  );
}
