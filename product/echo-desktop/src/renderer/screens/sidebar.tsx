import type { ProjectSummary } from '../../shared/protocol.js';
import { colorFor, initial } from '../format.js';
import { loadProjects, openCompose, openNewProject, openOrganization, openProject, showAccountMenu, type State } from '../store.js';
import { useDropTarget } from './drop.js';
import { Capture, FolderPlus, People, Person } from './icons.js';

const CAPTURE_HINT = navigator.userAgent.includes('Mac') ? '⌘⇧E' : 'Ctrl+Shift+E';

/** One project: a click opens it, a dropped file is captured into it. */
function SidebarProject({ project, current }: { project: ProjectSummary; current: boolean }) {
  const drop = useDropTarget(project);
  return (
    <button
      type="button" data-testid="sidebar-project" class={`side-project${current ? ' current' : ''}${drop.over ? ' drop-target' : ''}`}
      aria-current={current ? 'page' : undefined} onClick={() => void openProject(project)} {...drop.handlers}
    >
      <span class="dot" style={{ background: colorFor(project.project_id) }} aria-hidden="true">{initial(project.name)}</span>
      <span class="label">{project.name}</span>
    </button>
  );
}

/**
 * Always beside the page: Capture, New project, your projects (one click
 * switches), People & invites for owners, and who is signed in. It shares the
 * list Home loads. While another app is in front the page is covered, but the
 * project rows stay, so a dropped file lands.
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
          <button type="button" class="side-row" data-testid="sidebar-new-project" onClick={openNewProject}>
            <FolderPlus /><span class="label">New project</span>
          </button>
        </div>
      )}
      <nav class="sidebar-list" aria-label="Projects">
        {account && items.length > 0 && (
          <>
            <div class="side-header">PROJECTS</div>
            {items.map(project => <SidebarProject key={project.project_id} project={project} current={project.project_id === current} />)}
            {next && (
              <button type="button" class="link-button side-more" data-testid="sidebar-more" disabled={loading} onClick={() => void loadProjects(true)}>
                More
              </button>
            )}
          </>
        )}
      </nav>
      {account?.role === 'owner' && (
        <div class="sidebar-rows organization-rows">
          <div class="side-header">ORGANIZATION</div>
          <button type="button" data-testid="sidebar-organization" onClick={() => openOrganization()}
            class={`side-row${!state.concealed && state.route.page === 'organization' ? ' current' : ''}`}
            aria-current={!state.concealed && state.route.page === 'organization' ? 'page' : undefined}>
            <People /><span class="label">People &amp; invites</span>
          </button>
        </div>
      )}
      <button type="button" class="account-row" data-testid="account-row" aria-haspopup="menu"
        aria-label={account ? `Account, ${account.display_name}, ${account.role}` : undefined}
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
