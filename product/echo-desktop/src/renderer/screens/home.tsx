import type { PersonMeetingReviewV2 } from '@echo-brain/organization-api';
import { colorFor, initial, when } from '../format.js';
import { message } from '../messages.js';
import { loadHome, openDecision, openNewProject, type NeedRow, type State } from '../store.js';
import { Plus, Saved } from './icons.js';

/** The row's verb: what a click will ask of you. */
const KIND: Record<NeedRow['kind'], string> = { approve: 'Approve', impact: 'Impact', checking: 'Checking' };

/** The projects a review suggests, by name when Home knows them. */
function projectNames(state: State, review: PersonMeetingReviewV2): string[] {
  return review.project_ids.map(id => state.projects.items.find(project => project.project_id === id)?.name ?? null).filter((name): name is string => name !== null);
}

/** One line under the title: what kind of thing it is and where it came from. */
function detail(row: NeedRow): string {
  if (row.kind === 'approve') return 'Decisions and actions from a meeting';
  if (row.kind === 'checking') return row.review.status === 'publishing' ? 'Approved · publishing to ECHO' : 'Approved · checking what it changes';
  return row.run?.state === 'failed' ? 'Approved · the check did not finish' : 'Approved · ECHO found what it changes';
}

function Row({ state, row }: { state: State; row: NeedRow }) {
  const names = projectNames(state, row.review);
  const first = names[0];
  const project = first ? state.projects.items.find(item => item.name === first) : undefined;
  return (
    <button type="button" class={`need-row ${row.kind}`} data-testid="need-row" data-kind={row.kind} disabled={row.kind === 'checking'}
      onClick={() => void openDecision(row)}>
      <span class="need-kind">{KIND[row.kind]}</span>
      <span class="need-text">
        <span class="need-title">{row.review.title}</span>
        <span class="need-detail">{detail(row)}</span>
      </span>
      <span class="need-side">
        {row.run && <span class="need-when">{when(row.run.updated_at)}</span>}
        {first && (
          <span class="need-project" title={names.join(', ')}>
            <span class="need-dot" style={{ background: colorFor(project?.project_id ?? first) }} aria-hidden="true">{initial(first)}</span>
            <span>{first}{names.length > 1 ? ` +${names.length - 1}` : ''}</span>
          </span>
        )}
        {row.kind === 'checking' && <span class="asking" aria-hidden="true"><i /><i /><i /></span>}
      </span>
    </button>
  );
}

/**
 * Home: only what needs you. Decisions from meetings waiting for your approval,
 * and the impact of ones you approved. Projects live in the sidebar.
 */
export function Home({ state }: { state: State }) {
  const home = state.home;
  const rows = home?.rows ?? [];
  const noProjects = !state.projects.loading && state.projects.items.length === 0 && !state.archivedProjects.loading && state.archivedProjects.items.length === 0;
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
      <div class="column center home-clear" data-testid="home-clear" aria-busy={home?.loading ?? true}>
        {home && !home.loading && <><Saved /><span>Nothing needs you</span></>}
      </div>
    );
  }
  const waiting = rows.filter(row => row.kind !== 'checking').length;
  return (
    <div class="column needs" data-testid="needs" aria-busy={home?.loading ?? true}>
      <div class="section-label needs-head">Needs you{waiting > 0 ? ` · ${waiting}` : ''}</div>
      {rows.map(row => <Row key={row.review.approval_id} state={state} row={row} />)}
      {home?.failure && <div class="error more">{message(home.failure)} <button type="button" class="link-button" onClick={() => void loadHome()}>Try again</button></div>}
    </div>
  );
}
