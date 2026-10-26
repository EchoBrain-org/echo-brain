import type { ListItem, ProjectSummary } from '../../shared/protocol.js';
import { identity, initials } from '../format.js';
import { message } from '../messages.js';
import { activeTotal, followUpCount, followUpProgress, stateCounts } from '../needs.js';
import { moreList, newOnVisit, openCompose, openFollowUps, openListItem, openPeople, openProject, openProjectTools, readsWords, retryList, type State } from '../store.js';
import { People, Plug, Plus } from './icons.js';
import { FollowUpsLabel } from './impact-card.js';
import { ItemRow, useKeptPlace } from './items.js';
import { ProgressBar } from './progress-bar.js';

/**
 * What the project reads from its tools, above its feed: Set up tools for a
 * lead while it reads none, and what it reads once it does. Only when the
 * organization has a tool a project can read.
 */
function ToolsLine({ state, project }: { state: State; project: ProjectSummary }) {
  const reads = state.projectReads?.project_id === project.project_id ? state.projectReads : null;
  if (!reads?.available || reads.jira === undefined || reads.confluence === undefined) return null;
  const words = readsWords(reads);
  const lead = project.role === 'lead';
  if (words.length === 0) {
    if (!lead || project.status !== 'active') return null;
    return (
      <div class="tools-line setup" data-testid="project-tools-line">
        <Plug />
        <span class="tools-line-words">{project.name} reads nothing from your tools yet</span>
        <button type="button" class="link-button" data-testid="project-tools-setup" onClick={() => openProjectTools(project)}>Set up tools</button>
      </div>
    );
  }
  return (
    <div class="tools-line" data-testid="project-tools-line">
      <Plug />
      <span class="tools-line-words"><b>Reads</b> <span class="faint">· {words.join(' · ')}</span></span>
      <button type="button" class="link-button" data-testid="project-tools-change" onClick={() => openProjectTools(project)}>{lead ? 'Change' : 'View'}</button>
    </div>
  );
}

/**
 * A project's one list: its notes, documents and approved meetings, newest
 * first, one line each, and one More for older ones. Choosing a row reads it
 * in place. Above it, the project's follow-ups counted by status as a
 * meeting's are ("Follow-ups · 1 open · 3 not sent", canvas 9.7), with how far
 * they have come in a thin bar under the words: the line opens the project's
 * follow-ups, and each meeting's row says how many of its follow-ups are not
 * closed ("4 follow-ups"). Rows that arrived since your previous visit say
 * "New" for this visit (ADR-0047).
 */
export function Project({ state, project }: { state: State; project: ProjectSummary }) {
  const list = state.list?.scope.kind === 'project' && state.list.scope.project_id === project.project_id ? state.list : null;
  const { column } = useKeptPlace(list ? `project:${list.opened}` : undefined);
  const items = list?.items ?? [];
  const more = Boolean(list?.next);
  const line = state.projectLine?.scope === 'project' && state.projectLine.id === project.project_id ? state.projectLine : null;
  const words = line?.summary ? stateCounts(line.summary) : '';
  const active = new Map(line?.summary?.by_decision.map(decision => [decision.record_sha256, activeTotal(decision)]) ?? []);
  const badge = (item: ListItem) => {
    const count = item.ref.kind === 'meeting' ? active.get(item.ref.id) ?? 0 : 0;
    return count > 0 ? followUpCount(count) : null;
  };
  if (list?.failure && items.length === 0 && !more) {
    return (
      <div class="column center" data-testid="feed-error">
        <div class="error">{message(list.failure)}</div>
        <button type="button" class="link-button" onClick={() => void openProject(project)}>Try again</button>
      </div>
    );
  }
  if (list && !list.loading && items.length === 0 && !more) {
    if (project.status === 'archived') {
      return <div class="column center" data-testid="archived-project-empty"><div class="notice">This project is archived. Restore it to add files or notes.</div></div>;
    }
    return (
      <div class="column" data-testid="feed-empty">
        <ToolsLine state={state} project={project} />
        <div class="feed-empty">
          <button type="button" class="empty-capture" data-testid="empty-capture" onClick={() => openCompose()}>
            <span class="ring" aria-hidden="true"><Plus /></span>
            <span>Capture</span>
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="column" data-testid="feed" aria-busy={list?.loading ?? true} ref={column}>
      <ToolsLine state={state} project={project} />
      {words && (
        <div class="items-line project-line" data-testid="project-line">
          <FollowUpsLabel words={words} open={() => void openFollowUps('project', project.project_id, project.name)} class="items-line-open" />
          {line?.summary && <ProgressBar progress={followUpProgress(line.summary)} />}
        </div>
      )}
      {items.map(item => (
        <ItemRow key={`${item.ref.kind}:${item.ref.id}`} item={item} testid="feed-row" projects={false} onOpen={() => void openListItem(item)} badge={badge(item)}
          fresh={newOnVisit(state, project.project_id, item.added_at)} />
      ))}
      {more && (
        <button type="button" class="link-button more" data-testid="feed-more" disabled={list?.loading} onClick={() => void moreList()}>More</button>
      )}
      {list?.failure && (
        <div class="error more" data-testid="feed-failure">
          {message(list.failure)}
          <button type="button" class="link-button" data-testid="feed-retry" disabled={list.loading} onClick={() => void retryList()}>Try again</button>
        </div>
      )}
    </div>
  );
}

/** The project's members, up to three, in the title bar: they open People. */
export function MembersButton({ state }: { state: State }) {
  const route = state.route;
  const roster = route.page === 'project' && state.roster?.projectId === route.project.project_id ? state.roster : null;
  const shown = roster?.items.slice(0, 3) ?? [];
  return (
    <button type="button" class="members-button" data-testid="members-button" aria-label="Project members" onClick={() => void openPeople()}>
      {shown.length === 0 ? <People /> : shown.map(person => (
        <span key={person.membership_id} class="face" style={identity(person.membership_id)} aria-hidden="true">
          {initials(person.display_name)}
        </span>
      ))}
    </button>
  );
}
