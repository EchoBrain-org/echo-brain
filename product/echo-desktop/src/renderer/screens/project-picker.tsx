import { useState } from 'preact/hooks';
import type { ProjectSummary } from '../../shared/protocol.js';

/** A controlled, multi-project picker for a screen that already owns its choices. */
export function ProjectPicker({ projects, ticked, onTick, onMore, more, max }: {
  projects: readonly ProjectSummary[];
  ticked: readonly string[];
  onTick(id: string): void;
  onMore(): void;
  more: boolean;
  max: number;
}) {
  const [find, setFind] = useState('');
  const query = projects.length > 8 ? find.trim().toLocaleLowerCase() : '';
  const shown = query ? projects.filter(project => project.name.toLocaleLowerCase().includes(query)) : projects;
  const chosen = new Set(ticked);
  const full = chosen.size >= max;

  return <>
    {projects.length > 8 && <input
      type="text" class="field find" data-testid="projects-find" placeholder="Find a project" aria-label="Find a project" spellcheck={false}
      value={find} onInput={event => setFind((event.target as HTMLInputElement).value)}
      onKeyDown={event => {
        if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
        event.preventDefault();
        const match = shown[0];
        if (query && match && !chosen.has(match.project_id)) onTick(match.project_id);
      }}
    />}
    <div class="project-ticks">
      {shown.map(project => {
        const on = chosen.has(project.project_id);
        return <label class="project-tick" key={project.project_id} data-testid="projects-row">
          <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onTick(project.project_id)} />
          <span>{project.name}</span>
        </label>;
      })}
      {shown.length === 0 && <div class="project-note" data-testid="projects-none">{query ? 'No project matches.' : 'No projects yet.'}</div>}
      {more && <button type="button" class="link-button" data-testid="projects-more" onClick={onMore}>More projects</button>}
    </div>
    <div aria-live="polite">{full && <span class="project-note" data-testid="projects-limit">Up to {max} projects.</span>}</div>
  </>;
}
