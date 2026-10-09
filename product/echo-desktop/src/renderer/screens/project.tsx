import type { ProjectSummary } from '../../shared/protocol.js';
import { colorFor, initials } from '../format.js';
import { message } from '../messages.js';
import { openCount, projectWords } from '../needs.js';
import { checkNow, moreList, openCompose, openListItem, openOpenItems, openPeople, openProject, retryList, type State } from '../store.js';
import { People, Plus } from './icons.js';
import { ItemRow, useKeptPlace } from './items.js';
import { CheckNow } from './open-items.js';

/**
 * A project's one list: its notes, documents and approved meetings, newest
 * first, one line each, and one More for older ones. Choosing a row reads it
 * in place. Above it, what the project's decisions have open (canvas 9.7):
 * the line opens those items and checks them now, and each decision's row
 * says how many.
 */
export function Project({ state, project }: { state: State; project: ProjectSummary }) {
  const list = state.list?.scope.kind === 'project' && state.list.scope.project_id === project.project_id ? state.list : null;
  const column = useKeptPlace(list?.opened);
  const items = list?.items ?? [];
  const more = Boolean(list?.next);
  const line = state.projectLine?.scope === 'project' && state.projectLine.id === project.project_id ? state.projectLine : null;
  const words = line?.summary ? projectWords(line.summary) : null;
  const open = new Map(line?.summary?.by_decision.map(decision => [decision.record_sha256, openCount(decision)]) ?? []);
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
      <div class="column center" data-testid="feed-empty">
        <button type="button" class="empty-capture" data-testid="empty-capture" onClick={() => openCompose()}>
          <span class="ring" aria-hidden="true"><Plus /></span>
          <span>Capture</span>
        </button>
      </div>
    );
  }
  return (
    <div class="column" data-testid="feed" aria-busy={list?.loading ?? true} ref={column}>
      {words && line && (
        <div class="items-line project-line" data-testid="project-line">
          <button type="button" class="items-line-open" onClick={() => void openOpenItems('project', project.project_id, project.name)}>
            <b>{words.count}</b>{words.from && <span class="faint"> · {words.from}</span>}{words.checked && <span class="faint"> · {words.checked}</span>}
          </button>
          <CheckNow line={line} onCheck={() => void checkNow('projectLine', project.name)} />
        </div>
      )}
      {items.map(item => (
        <ItemRow key={`${item.ref.kind}:${item.ref.id}`} item={item} testid="feed-row" projects={false} onOpen={() => void openListItem(item)}
          open={item.ref.kind === 'meeting' ? open.get(item.ref.id) : undefined} />
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
        <span key={person.membership_id} class="face" style={{ background: colorFor(person.membership_id) }} aria-hidden="true">
          {initials(person.display_name)}
        </span>
      ))}
    </button>
  );
}
