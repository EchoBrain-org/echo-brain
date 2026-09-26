import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ProjectSummary } from '../../shared/protocol.js';
import { colorFor, initial } from '../format.js';
import { message } from '../messages.js';
import { loadArchivedProjects, loadProjects, openNewProject, openProject, type State } from '../store.js';
import { useDropTarget } from './drop.js';
import { Plus } from './icons.js';

/** One project. A file dropped on it is captured into it. */
function ProjectRow({ project }: { project: ProjectSummary }) {
  const archived = project.status === 'archived';
  const drop = useDropTarget(project);
  return (
    <button type="button" class={`row${drop.over ? ' drop-target' : ''}`} data-testid={archived ? 'archived-project-row' : 'project-row'} onClick={() => void openProject(project)}
      {...drop.handlers}>
      <span class="avatar" style={{ background: colorFor(project.project_id) }} aria-hidden="true">{initial(project.name)}</span>
      <span class="name">{project.name}</span>
      {project.role === 'lead' && <span class="tag">Lead</span>}
    </button>
  );
}

/** Where the list was scrolled when a project opened; Back returns there. */
let savedScroll = 0;

/** Your projects, one line each, in the middle of an otherwise blank page. */
export function Home({ state }: { state: State }) {
  const { items, loading, failure } = state.projects;
  const archived = state.archivedProjects;
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = savedScroll;
    return () => { if (element) savedScroll = element.scrollTop; };
  }, [list.current]);
  if (failure && items.length === 0 && archived.items.length === 0) {
    return (
      <div class="column center" data-testid="home-error">
        <div class="error">{message(failure)}</div>
        <button type="button" class="link-button" onClick={() => void loadProjects()}>Try again</button>
      </div>
    );
  }
  if (!loading && items.length === 0 && !archived.loading && archived.items.length === 0 && !archived.failure) {
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
    <div class="column" data-testid="project-list" aria-busy={loading} ref={list}>
      {items.map(project => <ProjectRow key={project.project_id} project={project} />)}
      {state.projects.next && (
        <button type="button" class="link-button more" data-testid="more-projects" disabled={loading} onClick={() => void loadProjects(true)}>
          More
        </button>
      )}
      {failure && <div class="error more">{message(failure)} <button type="button" class="link-button" onClick={() => void loadProjects()}>Try again</button></div>}
      {(archived.items.length > 0 || archived.loading || archived.failure) && (
        <section class="archived-projects" data-testid="archived-projects" aria-label="Archived projects">
          <div class="side-header">ARCHIVED</div>
          {archived.items.map(project => <ProjectRow key={project.project_id} project={project} />)}
          {archived.next && (
            <button type="button" class="link-button more" data-testid="more-archived-projects" disabled={archived.loading}
              onClick={() => void loadArchivedProjects(true)}>More</button>
          )}
          {archived.failure && <div class="error more">{message(archived.failure)} <button type="button" class="link-button"
            onClick={() => void loadArchivedProjects()}>Try again</button></div>}
        </section>
      )}
    </div>
  );
}
