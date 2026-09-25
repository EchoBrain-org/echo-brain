import { colorFor, initial } from '../format.js';
import { loadProjects, openCompose, openProject, showAccountMenu, type State } from '../store.js';
import { Capture, Person } from './icons.js';

const CAPTURE_HINT = navigator.userAgent.includes('Mac') ? '⌘⇧E' : 'Ctrl+Shift+E';

/**
 * Always beside the page: Capture, your projects (one click switches), and who
 * is signed in. It shares the list Home loads. While another app is in front
 * the page is covered, but the project rows stay, so a dropped file lands.
 */
export function Sidebar({ state }: { state: State }) {
  const account = state.status?.account ?? null;
  const { items, next, loading } = state.projects;
  const current = !state.concealed && state.route.page === 'project' ? state.route.project.project_id : null;
  return (
    <aside class="sidebar" data-testid="sidebar">
      <div class="sidebar-drag" />
      {account && (
        <div class="sidebar-rows">
          <button type="button" class="side-row" data-testid="sidebar-capture" onClick={() => openCompose()}>
            <Capture /><span class="label">Capture</span><span class="hint">{CAPTURE_HINT}</span>
          </button>
        </div>
      )}
      <nav class="sidebar-list" aria-label="Projects">
        {account && items.length > 0 && (
          <>
            <div class="side-header">PROJECTS</div>
            {items.map(project => (
              <button
                type="button" key={project.project_id} data-testid="sidebar-project"
                class={`side-project${project.project_id === current ? ' current' : ''}`}
                aria-current={project.project_id === current ? 'page' : undefined} onClick={() => void openProject(project)}
              >
                <span class="dot" style={{ background: colorFor(project.project_id) }} aria-hidden="true">{initial(project.name)}</span>
                <span class="label">{project.name}</span>
              </button>
            ))}
            {next && (
              <button type="button" class="link-button side-more" data-testid="sidebar-more" disabled={loading} onClick={() => void loadProjects(true)}>
                More
              </button>
            )}
          </>
        )}
      </nav>
      <button type="button" class="account-row" data-testid="account-row" aria-label="Account" aria-haspopup="menu"
        onClick={event => showAccountMenu(event.currentTarget, 'row')}>
        {account ? (
          <>
            <span class="avatar" style={{ background: colorFor(account.membership_id) }} aria-hidden="true">{initial(account.display_name)}</span>
            <span class="who"><span class="name">{account.display_name}</span><span class="role">{account.role}</span></span>
          </>
        ) : (
          <><span class="avatar signed-out" aria-hidden="true"><Person /></span><span class="who"><span class="name">Account · Sign in</span></span></>
        )}
      </button>
    </aside>
  );
}
