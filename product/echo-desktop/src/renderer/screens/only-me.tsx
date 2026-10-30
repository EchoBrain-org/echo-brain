import type { ProjectSummary } from '../../shared/protocol.js';
import { message } from '../messages.js';
import { altitudeProjects, moreList, openListItem, retryList, type State } from '../store.js';
import { Caret } from './icons.js';
import { useKeptPlace } from './items.js';
import { OnlyMeRow, projectsByName } from './only-me-row.js';

/**
 * Every project of yours a tile can name: Home's whole list, with the sidebar's
 * rows laid over it by id, as the sidebar's are read more often. A project made,
 * joined or renamed since Home last read every page keeps its hue.
 */
function knownProjects(state: State): readonly ProjectSummary[] {
  const byId = new Map(altitudeProjects(state).map(project => [project.project_id, project]));
  for (const project of state.projects.items) if (project.status === 'active') byId.set(project.project_id, project);
  return [...byId.values()];
}

/**
 * Only me, from the sidebar (ADR-0049, One place to look v1): everything only
 * you can read (notes, files and approved meetings whose only reader is you),
 * filed in a project or not, newest first, in one flat list. A filed row shows
 * a tile for each of your projects it is in, named on hover; no row carries a
 * lock, as every one is only yours. With nothing in it the page stays blank.
 */
export function OnlyMe({ state }: { state: State }) {
  const list = state.list?.scope.kind === 'only-me' ? state.list : null;
  const { column } = useKeptPlace(list ? `only-me:${list.opened}` : undefined);
  if (list?.failure && list.items.length === 0 && !list.next) {
    return (
      <div class="column center" data-testid="only-me-error">
        <div class="error">{message(list.failure)}</div>
        <button type="button" class="link-button" data-testid="only-me-retry" disabled={list.loading} onClick={() => void retryList()}>Try again</button>
      </div>
    );
  }
  // Rows name projects only: each tile finds its project among every one of yours the app has read.
  const byName = projectsByName(knownProjects(state));
  const now = Date.now();
  return (
    <div class="column only-me" data-testid="only-me" aria-busy={list?.loading ?? true} ref={column}>
      {list?.items.map(item => (
        <OnlyMeRow key={`${item.ref.kind}:${item.ref.id}`} item={item} byName={byName} now={now} onOpen={() => void openListItem(item)} />
      ))}
      {list?.next && (
        <button type="button" class="only-me-more" data-testid="only-me-more" disabled={list.loading} onClick={() => void moreList()}><Caret /><span>More</span></button>
      )}
      {list?.failure && (
        <div class="error more" data-testid="only-me-failure">
          {message(list.failure)}
          <button type="button" class="link-button" data-testid="only-me-retry" disabled={list.loading} onClick={() => void retryList()}>Try again</button>
        </div>
      )}
    </div>
  );
}
