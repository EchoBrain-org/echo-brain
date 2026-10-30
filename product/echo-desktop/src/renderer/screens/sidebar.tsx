import type { ProjectSummary } from '../../shared/protocol.js';
import { dateTime, identity, initial } from '../format.js';
import { message } from '../messages.js';
import { useState } from 'preact/hooks';
import {
  goHome, installUpdate, loadArchivedProjects, loadProjects, needsCount, openCompose, openNewProject, openOrganization, openProject, openTools,
  openYourFollowUps, returnToAsk, settleWords, showAccountMenu, signInAgain, type State,
} from '../store.js';
import { useDropTarget } from './drop.js';
import { Ask, Capture, Chevron, Home as HomeIcon, People, Person, Plug, Plus, Ticks, Up } from './icons.js';
import { ProjectSettingsButton } from './project-settings.js';

const CAPTURE_HINT = navigator.userAgent.includes('Mac') ? '⌘⇧E' : 'Ctrl+Shift+E';
/** A row that takes no drop: a file dropped on it goes nowhere. */
const noDrop = (event: DragEvent) => event.stopPropagation();

/**
 * One project: a click opens it, a dropped file is captured into it. A small
 * signal dot at its end says something new arrived since you last opened it
 * (ADR-0047).
 */
function SidebarProject({ project, current, state }: { project: ProjectSummary; current: boolean; state: State }) {
  const drop = useDropTarget(project);
  const news = !current && state.news.has(project.project_id);
  return (
    <div class={`side-project-row${current ? ' current' : ''}${drop.over ? ' drop-target' : ''}`} {...drop.handlers}>
      <button
        type="button" data-testid="sidebar-project" class="side-project" data-role={project.role}
        aria-current={current ? 'page' : undefined} aria-label={news ? `${project.name}, something new` : undefined} onClick={() => void openProject(project)}
      >
        <span class="dot" style={identity(project.project_id)} aria-hidden="true">{initial(project.name)}</span>
        <span class="label">{project.name}</span>
        {news && <span class="news-dot" data-testid="project-news" aria-hidden="true" />}
      </button>
      <ProjectSettingsButton state={state} project={project} />
    </div>
  );
}

/** "What · What to do", wrapping only at the dot. */
const twoPart = (what: string, action: string) => <span class="label"><span class="part">{what} ·</span> <span class="part">{action}</span></span>;

/**
 * A new version (ADR-0035), signed in or out and under ECHO could not start, so
 * a broken release can install its fix; or Updates are off, when the updater
 * should run but could not start (the log says why). Nothing clickable says
 * Update (Home's word for open items), and it takes no drop. It stays one button
 * so a keyboard click keeps focus; Updating, the location line and Updates are
 * off are aria-disabled.
 */
export function UpdateRow({ state }: { state: State }) {
  const { update, updateFailure: failure } = state;
  if (update.state === 'none') return null;
  const location = update.state === 'failed' && update.reason === 'location';
  const inert = update.state === 'installing' || update.state === 'off' || location;
  return (
    <div class="sidebar-rows update-rows" role="status" onDragOver={noDrop} onDrop={noDrop}>
      <button type="button" class="side-row update-row" data-testid="sidebar-update" aria-disabled={inert ? 'true' : undefined}
        onClick={inert ? undefined : () => void installUpdate()}>
        {update.state === 'installing' ? <><span class="asking" aria-hidden="true"><i /><i /><i /></span><span class="label">Updating</span></>
          : update.state === 'off' ? <><Up /><span class="label">Updates are off</span></>
          : location ? <><Up /><span class="label">Move ECHO to Applications to update</span></>
          : <><Up />{update.state === 'failed' ? twoPart('Couldn\'t update', 'Try again') : twoPart('New version', 'Restart')}</>}
      </button>
      {failure && (
        <p class="error update-note" data-testid="sidebar-update-note" aria-live="polite">
          {failure.code === 'update_held' ? settleWords(state) : message(failure)}
        </p>
      )}
    </div>
  );
}

/**
 * The weekly sign-in, from a day before it is due: a quiet row above the account that signs in again now, at a moment
 * that suits, rather than when the week runs out mid-work. It takes no drop.
 */
export function SignInDueRow({ state }: { state: State }) {
  const due = state.signInDue;
  if (!due || !state.status?.signed_in) return null;
  const waiting = state.signin.phase === 'waiting';
  const failure = due.failure;
  return (
    <div class="sidebar-rows update-rows" role="status" onDragOver={noDrop} onDrop={noDrop}>
      <button type="button" class="side-row update-row" data-testid="sidebar-sign-in-again" aria-disabled={waiting ? 'true' : undefined}
        onClick={waiting ? undefined : () => void signInAgain()}>
        <Person />{twoPart(`Sign in again by ${dateTime(due.at)}`, 'Sign in')}
      </button>
      <p class={`update-note${failure ? ' error' : ''}`} data-testid="sidebar-sign-in-note" aria-live="polite">
        {!failure ? 'ECHO asks you to sign in once a week.' : failure.code === 'signout_held' ? settleWords(state) : message(failure)}
      </p>
    </div>
  );
}

/**
 * Always beside the page: Home (Only me is a link there, ADR-0049), Ask (back
 * to where you left it, and current while it is open over any page), Capture,
 * Follow-ups (everything you sent, own or last handed on), your projects (one
 * click switches) under a Projects header whose "+" starts a new project,
 * People & invites for owners, Tools, a new version, the weekly sign-in once
 * it is a day away, and who is signed in. It shares the list Home loads. While
 * another app is in front the page is covered, but the project rows stay, so
 * a dropped file lands.
 */
export function Sidebar({ state }: { state: State }) {
  const account = state.status?.account ?? null;
  const { items, next, loading, failure } = state.projects;
  // Ask open over the page is the place you are: the page under it is not current.
  const askOpen = !state.concealed && state.ask !== null;
  const page = !state.concealed && !askOpen ? state.route.page : null;
  const current = page === 'project' && state.route.page === 'project' ? state.route.project.project_id : null;
  const tools = page === 'tools';
  const followUps = page === 'follow-ups';
  // Home's own pages: a decision opened from it, and Only me.
  const home = page === 'home' || page === 'decision' || page === 'only-me';
  const needs = needsCount(state);
  const archived = state.archivedProjects;
  const [archivedOpen, setArchivedOpen] = useState(false);
  return (
    <aside class="sidebar" data-testid="sidebar">
      <div class="sidebar-drag" />
      {account && (
        <div class="sidebar-rows">
          <button type="button" class={`side-row${home ? ' current' : ''}`} data-testid="sidebar-home" aria-current={home ? 'page' : undefined}
            onClick={goHome} onDragOver={noDrop} onDrop={noDrop}>
            <HomeIcon /><span class="label">Home</span>{needs > 0 && <span class="badge" data-testid="sidebar-badge">{needs}</span>}
          </button>
          {/* With nothing asked yet there is nothing to go back to: the cursor goes to the bar. */}
          <button type="button" class={`side-row${askOpen ? ' current' : ''}`} data-testid="sidebar-ask" aria-current={askOpen ? 'page' : undefined}
            onClick={() => { if (!returnToAsk()) document.getElementById('ask-field')?.focus(); }} onDragOver={noDrop} onDrop={noDrop}>
            <Ask /><span class="label">Ask</span>
          </button>
          <button type="button" class="side-row" data-testid="sidebar-capture" onClick={() => openCompose()}>
            <Capture /><span class="label">Capture</span><span class="hint">{CAPTURE_HINT}</span>
          </button>
          <button type="button" class={`side-row${followUps ? ' current' : ''}`} data-testid="sidebar-follow-ups" aria-current={followUps ? 'page' : undefined}
            onClick={() => void openYourFollowUps()} onDragOver={noDrop} onDrop={noDrop}>
            <Ticks /><span class="label">Follow-ups</span>
          </button>
        </div>
      )}
      <nav class="sidebar-list" aria-label="Projects">
        {account && (
          <>
            {/* Shown signed in even with no projects yet, so a new project is always one click away. */}
            <div class="side-header with-action" data-testid="sidebar-projects-header">
              <span>Projects</span>
              <button type="button" class="icon-button" data-testid="sidebar-new-project" aria-label="New project" title="New project" onClick={openNewProject}>
                <Plus />
              </button>
            </div>
            {items.filter(project => project.status === 'active').map(project => <SidebarProject key={project.project_id} project={project} current={project.project_id === current} state={state} />)}
            {next && (
              <button type="button" class="link-button side-more" data-testid="sidebar-more" disabled={loading} onClick={() => void loadProjects(true)}>
                More
              </button>
            )}
            {failure && <div class="error side-more" data-testid="sidebar-projects-error">{message(failure)} <button type="button" class="link-button"
              disabled={loading} onClick={() => void loadProjects()}>Try again</button></div>}
          </>
        )}
        {account && (archived.items.length > 0 || archived.loading || archived.failure) && (
          <section class="archived-projects" data-testid="archived-projects" aria-label="Archived projects">
            <button type="button" class="disclosure archived-heading" data-testid="archived-projects-toggle" aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen(!archivedOpen)}><Chevron /><span>Archived</span></button>
            {archivedOpen && archived.items.map(project => (
              <button type="button" key={project.project_id} data-testid="archived-project-row" class="side-project" onClick={() => void openProject(project)}>
                <span class="dot" style={identity(project.project_id)} aria-hidden="true">{initial(project.name)}</span>
                <span class="label">{project.name}</span>
              </button>
            ))}
            {archivedOpen && archived.next && (
              <button type="button" class="link-button side-more" data-testid="more-archived-projects" disabled={archived.loading}
                onClick={() => void loadArchivedProjects(true)}>More</button>
            )}
            {archivedOpen && archived.failure && <div class="error side-more" data-testid="archived-projects-error">{message(archived.failure)} <button type="button" class="link-button"
              disabled={archived.loading} onClick={() => void loadArchivedProjects()}>Try again</button></div>}
          </section>
        )}
      </nav>
      {account?.role === 'owner' && (
        <div class="sidebar-rows organization-rows">
          <div class="side-header">Organization</div>
          <button type="button" data-testid="sidebar-organization" onClick={() => openOrganization()}
            class={`side-row${page === 'organization' ? ' current' : ''}`} aria-current={page === 'organization' ? 'page' : undefined}>
            <People /><span class="label">People &amp; invites</span>
          </button>
        </div>
      )}
      {account && (
        <div class="sidebar-rows tools-rows">
          <button type="button" data-testid="sidebar-tools" onClick={() => openTools()}
            class={`side-row${tools ? ' current' : ''}`} aria-current={tools ? 'page' : undefined}>
            <Plug /><span class="label">Tools</span>
          </button>
        </div>
      )}
      <UpdateRow state={state} />
      <SignInDueRow state={state} />
      <button type="button" class="account-row" data-testid="account-row" aria-haspopup="menu"
        aria-label={account ? `Account, ${account.display_name}, ${account.role}` : undefined}
        onClick={event => showAccountMenu(event.currentTarget, 'row')}>
        {account ? (
          <>
            <span class="avatar" style={identity(account.membership_id)} aria-hidden="true">{initial(account.display_name)}</span>
            <span class="who"><span class="name">{account.display_name}</span><span class="role">{account.role}</span></span>
          </>
        ) : (
          <><span class="avatar signed-out" aria-hidden="true"><Person /></span><span class="who"><span class="name">Account · Sign in</span></span></>
        )}
      </button>
    </aside>
  );
}
