import { useState } from 'preact/hooks';
import type { ProjectSummary } from '../../shared/protocol.js';
import { colorFor, initial } from '../format.js';
import { message } from '../messages.js';
import { acceptDrop, loadProjects, openProject, type State } from '../store.js';

function ProjectRow({ project }: { project: ProjectSummary }) {
  const [over, setOver] = useState(false);
  return (
    <button
      type="button" class={`row${over ? ' drop-target' : ''}`} data-testid="project-row" onClick={() => void openProject(project)}
      onDragOver={event => { event.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={event => {
        event.preventDefault(); event.stopPropagation(); setOver(false);
        const file = event.dataTransfer?.files[0];
        if (file) void acceptDrop(file, project);
      }}
    >
      <span class="avatar" style={{ background: colorFor(project.project_id) }} aria-hidden="true">{initial(project.name)}</span>
      <span class="name">{project.name}</span>
      {project.role === 'lead' && <span class="tag">Lead</span>}
    </button>
  );
}

/** Your projects, one line each, in the middle of an otherwise blank page. */
export function Home({ state }: { state: State }) {
  const { items, loading, failure } = state.projects;
  if (failure && items.length === 0) {
    return (
      <div class="column center" data-testid="home-error">
        <div class="error">{message(failure)}</div>
        <button type="button" class="link-button" onClick={() => void loadProjects()}>Try again</button>
      </div>
    );
  }
  if (!loading && items.length === 0) {
    return <div class="column center" data-testid="home-empty"><div>No projects yet</div></div>;
  }
  return (
    <div class="column" data-testid="project-list" aria-busy={loading}>
      {items.map(project => <ProjectRow key={project.project_id} project={project} />)}
      {state.projects.next && (
        <button type="button" class="link-button more" data-testid="more-projects" disabled={loading} onClick={() => void loadProjects(true)}>
          More projects
        </button>
      )}
      {failure && <div class="error more">{message(failure)}</div>}
    </div>
  );
}
