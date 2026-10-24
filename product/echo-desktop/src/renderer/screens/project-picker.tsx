import { useState } from 'preact/hooks';
import type { ProjectSummary } from '../../shared/protocol.js';

/**
 * A controlled, multi-project picker for a screen that already owns its choices. `named` are the projects counted toward `max`,
 * the ticked ones unless a wider choice counts more (a meeting counts every item's): once they reach it, only those can be
 * ticked. `partly` are projects only some of what it sets have, part-ticked.
 */
export function ProjectPicker({ projects, ticked, partly = [], named = ticked, onTick, onMore, more, max, disabled = false }: {
  projects: readonly ProjectSummary[];
  ticked: readonly string[];
  partly?: readonly string[];
  named?: readonly string[];
  onTick(id: string): void;
  onMore(): void;
  more: boolean;
  max: number;
  /** The choices are locked: nothing can be ticked, found or loaded. */
  disabled?: boolean;
}) {
  const [find, setFind] = useState('');
  const query = projects.length > 8 ? find.trim().toLocaleLowerCase() : '';
  const shown = query ? projects.filter(project => project.name.toLocaleLowerCase().includes(query)) : projects;
  const chosen = new Set(ticked);
  const some = new Set(partly);
  const counted = new Set(named);
  const full = counted.size >= max;
  // Ticking a project not counted yet would name one more.
  const room = (id: string) => counted.has(id) || !full;

  return <>
    {projects.length > 8 && <input
      type="text" class="field find" data-testid="projects-find" placeholder="Find a project" aria-label="Find a project" spellcheck={false}
      disabled={disabled} value={find} onInput={event => setFind((event.target as HTMLInputElement).value)}
      onKeyDown={event => {
        if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
        event.preventDefault();
        const match = shown[0];
        if (query && match && !chosen.has(match.project_id) && room(match.project_id)) onTick(match.project_id);
      }}
    />}
    <div class="project-ticks">
      {shown.map(project => {
        const on = chosen.has(project.project_id);
        return <label class="project-tick" key={project.project_id} data-testid="projects-row">
          <input type="checkbox" checked={on} indeterminate={!on && some.has(project.project_id)} disabled={disabled || (!on && !room(project.project_id))}
            onChange={() => onTick(project.project_id)} />
          <span>{project.name}</span>
        </label>;
      })}
      {shown.length === 0 && <div class="project-note" data-testid="projects-none">{query ? 'No project matches.' : 'No projects yet.'}</div>}
      {more && <button type="button" class="link-button" data-testid="projects-more" disabled={disabled} onClick={onMore}>More projects</button>}
    </div>
    <div aria-live="polite">{full && <span class="project-note" data-testid="projects-limit">Up to {max} projects.</span>}</div>
  </>;
}
