import type { ProjectSummary } from '../../shared/protocol.js';
import { colorFor, initial } from '../format.js';
import { useState } from 'preact/hooks';
import { goHome, loadArchivedProjects, loadProjects, needsCount, openCompose, openMine, openNewProject, openOrganization, openProject, openTools, showAccountMenu, type State } from '../store.js';
import { useDropTarget } from './drop.js';
import { Capture, Chevron, FolderPlus, Home as HomeIcon, OnePerson, People, Person, Plug } from './icons.js';
import { ProjectSettingsButton } from './project-settings.js';

const CAPTURE_HINT = navigator.userAgent.includes('Mac') ? '⌘⇧E' : 'Ctrl+Shift+E';

/** One project: a click opens it, a dropped file is captured into it. */
function SidebarProject({ project, current, state }: { project: ProjectSummary; current: boolean; state: State }) {
  const drop = useDropTarget(project);
  return (
    <div class={`side-project-row${current ? ' current' : ''}${drop.over ? ' drop-target' : ''}`} {...drop.handlers}>
      <button
        type="button" data-testid="sidebar-project" class="side-project" data-role={project.role}
        aria-current={current ? 'page' : undefined} onClick={() => void openProject(project)}
      >
        <span class="dot" style={{ background: colorFor(project.project_id) }} aria-hidden="true">{initial(project.name)}</span>
        <span class="label">{project.name}</span>
      </button>
      <ProjectSettingsButton state={state} project={project} />
    </div>
  );
}

/**
 * Always beside the page: Capture, New project, Mine, your projects (one
 * click switches), People & invites for owners, Tools, and who is signed in. It
 * shares the list Home loads. While another app is in front the page is
 * covered, but the project rows stay, so a dropped file lands. Mine never
 * takes a drop.
 */
export function Sidebar({ state }: { state: State }) {
  const account = state.status?.account ?? null;
  const { items, next, loading } = state.projects;
  const current = !state.concealed && state.route.page === 'project' ? state.route.project.project_id : null;
  const mine = !state.concealed && state.route.page === 'mine';
  const tools = !state.concealed && state.route.page === 'tools';
  const home = !state.concealed && (state.route.page === 'home' || state.route.page === 'decision');
  const needs = needsCount(state);
  const archived = state.archivedProjects;
  const [archivedOpen, setArchivedOpen] = useState(false);
  const noDrop = (event: DragEvent) => event.stopPropagation();
  return (
    <aside class="sidebar" data-testid="sidebar">
      <div class="sidebar-drag" />
      {account && (
        <div class="sidebar-rows">
          <button type="button" class={`side-row${home ? ' current' : ''}`} data-testid="sidebar-home" aria-current={home ? 'page' : undefined}
            onClick={goHome} onDragOver={noDrop} onDrop={noDrop}>
            <HomeIcon /><span class="label">Home</span>{needs > 0 && <span class="badge" data-testid="sidebar-badge">{needs}</span>}
          </button>
          <button type="button" class="side-row" data-testid="sidebar-capture" onClick={() => openCompose()}>
            <Capture /><span class="label">Capture</span><span class="hint">{CAPTURE_HINT}</span>
          </button>
          <button type="button" class="side-row" data-testid="sidebar-new-project" onClick={openNewProject}>
            <FolderPlus /><span class="label">New project</span>
          </button>
          <button type="button" class={`side-row${mine ? ' current' : ''}`} data-testid="sidebar-mine" aria-current={mine ? 'page' : undefined}
            onClick={() => void openMine()} onDragOver={noDrop} onDrop={noDrop}>
            <OnePerson /><span class="label">Mine</span>
          </button>
        </div>
      )}
      <nav class="sidebar-list" aria-label="Projects">
        {account && items.length > 0 && (
          <>
            <div class="side-header">PROJECTS</div>
            {items.filter(project => project.status === 'active').map(project => <SidebarProject key={project.project_id} project={project} current={project.project_id === current} state={state} />)}
            {next && (
              <button type="button" class="link-button side-more" data-testid="sidebar-more" disabled={loading} onClick={() => void loadProjects(true)}>
                More
              </button>
            )}
          </>
        )}
        {account && (archived.items.length > 0 || archived.loading || archived.failure) && (
          <section class="archived-projects" data-testid="archived-projects" aria-label="Archived projects">
            <button type="button" class="archived-heading" data-testid="archived-projects-toggle" aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen(!archivedOpen)}><Chevron /><span>ARCHIVED</span></button>
            {archivedOpen && archived.items.map(project => (
              <button type="button" key={project.project_id} data-testid="archived-project-row" class="side-project" onClick={() => void openProject(project)}>
                <span class="dot" style={{ background: colorFor(project.project_id) }} aria-hidden="true">{initial(project.name)}</span>
                <span class="label">{project.name}</span>
              </button>
            ))}
            {archivedOpen && archived.next && (
              <button type="button" class="link-button side-more" data-testid="more-archived-projects" disabled={archived.loading}
                onClick={() => void loadArchivedProjects(true)}>More</button>
            )}
          </section>
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
      {account && (
        <div class="sidebar-rows tools-rows">
          <button type="button" data-testid="sidebar-tools" onClick={openTools}
            class={`side-row${tools ? ' current' : ''}`} aria-current={tools ? 'page' : undefined}>
            <Plug /><span class="label">Tools</span>
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
