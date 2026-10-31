import { render, type ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { on } from './api.js';
import { itemTitle } from './needs.js';
import { ConfirmSignOut } from './screens/account.js';
import { AskView, Bar, SourcePane } from './screens/ask.js';
import { Compose } from './screens/compose.js';
import { Decision } from './screens/decision.js';
import { Stops } from './screens/altitude.js';
import { FollowUp, FollowUps } from './screens/follow-ups.js';
import { Home } from './screens/home.js';
import { ChangeLine, changeShownInPlace } from './screens/change.js';
import { Back, Saved, SidebarIcon, Warning } from './screens/icons.js';
import { NewProject } from './screens/new-project.js';
import { OnlyMe } from './screens/only-me.js';
import { Organization } from './screens/organization.js';
import { People } from './screens/people.js';
import { MembersButton, Project } from './screens/project.js';
import { ProjectSettings, ProjectSettingsButton, ProjectToolsButton } from './screens/project-settings.js';
import { Reader } from './screens/reader.js';
import { Sidebar, UpdateRow } from './screens/sidebar.js';
import { SignedOut } from './screens/signin.js';
import { ToolConnect, ToolManage, Tools } from './screens/tools.js';
import {
  acceptDrop, accountCommand, askProgress, canDrop, cancelMemberChange, cancelProjectSettingsAction, cancelRevoke, cancelSkip, clearBar, clearToast, closeAsk, closeCompose, closeFollowUp,
  closeOwnerPicker, closeProjects, closeReader, closeSheet, closeSigninForm, dismissProjectSetting, findingSheet, followUpShown, followUpsShown, getState, goHome,
  hostFailed, keepNewProject, matchesShown, newProjectProgress, openCapture, openNotified, openOnlyMe, pageCovered, paneTarget, projectSettingsModal, readUpdate, refreshStatus,
  retryStart, sheetShown, shownItem, signinPhase, toastOpensOnlyMe, toggleEmployeeMenu, toggleMemberMenu, toggleReaderMenu, toggleSidebar, trayOrganization, updateChanged,
  useStore, WARNINGS, windowState, zoomOut, type State,
} from './store.js';
import { woke } from './freshness.js';

if (navigator.userAgent.includes('Mac')) document.documentElement.classList.add('mac');

function sheetUp(): boolean {
  const { compose } = getState();
  return Boolean((compose && !compose.hidden) || sheetShown() || projectSettingsModal());
}

/** How long a toast that says something went well stays: one that warns stays until the next page. */
const TOAST_MS = 8_000;

/** The caret waits in the ask bar whenever the window comes forward, unless a sheet is up. */
function focusBar(): void {
  if (sheetUp()) return;
  // A sheet can open before the next frame (a drop, ⌘⇧E): it keeps the focus.
  requestAnimationFrame(() => { if (!sheetUp()) document.getElementById('ask-field')?.focus(); });
}

/**
 * Escape: the bar's text goes first, when the caret is in the bar or its
 * matches show; otherwise one level back.
 */
function escape(): void {
  const state = getState();
  const inBar = document.activeElement?.id === 'ask-field';
  if (state.status?.signed_in && !sheetUp() && state.barText !== '' && (inBar || matchesShown(state))) return clearBar();
  back();
}

/**
 * Back steps back one level: a sheet (or what is open in it), compose, the
 * answer (and the source beside it), an item page or a follow-ups list (the
 * one before it, or the page under them), reader, then a project or People &
 * invites. An owner picker closes first.
 */
function back(): void {
  const state = getState();
  const finding = findingSheet(state);
  if (finding?.confirm) return cancelMemberChange();
  if (finding?.menu) return toggleMemberMenu(finding.menu);
  const sheet = sheetShown(state);
  if (sheet?.kind === 'new-project' && sheet.skip !== null) return cancelSkip();
  if (sheet?.kind === 'new-project' && sheet.confirmClose) return keepNewProject();
  if (sheet) return closeSheet();
  // A project settings dialog owns Escape: a write on its way keeps it.
  const settings = state.projectSettings;
  if (settings?.write) { if (settings.write.status !== 'sending') dismissProjectSetting(); return; }
  if (settings && (settings.tools || settings.rename !== null || settings.confirm)) return cancelProjectSettingsAction();
  if (!state.status?.signed_in) return closeSigninForm();
  // Escape closes Capture's place list first, and only the list.
  if (state.compose && !state.compose.hidden) return state.compose.picking ? closeProjects() : closeCompose();
  if (state.ask) return closeAsk();
  const view = followUpShown(state);
  if (view?.kind !== 'decision' && view?.picker) return closeOwnerPicker();
  if (view) return closeFollowUp();
  if (state.reader?.menu !== undefined && state.reader.menu !== 'closed') return toggleReaderMenu();
  if (state.reader) return closeReader();
  if (state.organization?.confirm) return cancelRevoke();
  if (state.organization?.menu) return toggleEmployeeMenu(state.organization.menu);
  // On Home zoomed on a project or a person, or into one kind of what needs you, Escape zooms one level out.
  if (state.route.page === 'home' && zoomOut()) return;
  if (state.route.page !== 'home') return goHome();
}

function App() {
  const state = useStore();

  // Capture closed (saved, or put away): the caret goes back to the bar.
  const capturing = Boolean(state.compose && !state.compose.hidden);
  useEffect(() => { if (!capturing) focusBar(); }, [capturing]);
  // New project stepped aside or closed: the caret goes to the bar of the project it opened.
  const making = sheetShown(state)?.kind === 'new-project';
  useEffect(() => { if (!making) focusBar(); }, [making]);

  // A toast that says something went well goes by itself, counted while it can be seen.
  useEffect(() => {
    const toast = state.toast;
    if (!toast || WARNINGS.has(toast) || state.concealed) return;
    const shown = state.toastShown;
    const timer = setTimeout(() => clearToast(shown), TOAST_MS);
    return () => clearTimeout(timer);
  }, [state.toastShown, state.toast, state.concealed]);

  useEffect(() => {
    void refreshStatus().then(focusBar);
    // The update row is main's, signed in or out: read once, then main says each change.
    void readUpdate();
    const stops = [
      on('capture.open', () => { if (getState().status?.signed_in) openCapture(); }),
      // Covered while another app is in front; back on screen and in front, what shows is read again, and the caret waits in the bar.
      on('window.state', next => { if (windowState(next)) focusBar(); }),
      on('system.woke', woke),
      on('signin.phase', payload => signinPhase(payload.browser_opened)),
      on('host.restarted', () => { void refreshStatus(); }),
      on('host.failed', hostFailed),
      on('account.command', payload => accountCommand(payload.command)),
      on('organization.open', () => { if (getState().status?.signed_in) trayOrganization(); }),
      on('update.changed', updateChanged),
      on('notice.open', payload => openNotified(payload.target)),
      // A step of the Ask on its way: the store drops one of another Ask or account.
      on('ask.progress', askProgress),
    ];
    // One Escape handler for the whole window: it steps back exactly one level.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); escape(); } };
    window.addEventListener('keydown', onKey);
    return () => { stops.forEach(stop => stop()); window.removeEventListener('keydown', onKey); };
  }, []);

  if (state.booting) return <div class="app"><div class="titlebar"><div class="side" /><div class="title brand">ECHO</div><div class="side" /></div></div>;
  if (state.startFailed) {
    return (
      <div class="app">
        <div class="titlebar"><div class="side" /><div class="title brand">ECHO</div><div class="side" /></div>
        <div class="page"><div class="signin" data-testid="start-failed">
          <h1>ECHO could not start</h1>
          <button type="button" class="primary-button" data-testid="start-retry" onClick={() => void retryStart()}>Try again</button>
          <UpdateRow state={state} />
        </div></div>
      </div>
    );
  }
  if (!state.status?.signed_in) {
    return <Shell state={state} title="ECHO" backLabel={null}><SignedOut state={state} /></Shell>;
  }

  const inProject = state.route.page === 'project' ? state.route.project : null;
  const decision = state.route.page === 'decision' ? state.decision : null;
  const view = followUpShown(state);
  // A decision opened from a meeting's follow-ups shows over them.
  const listDecision = view?.kind === 'decision' && state.decision?.seq === view.seq ? state.decision : null;
  // The Follow-ups page (yours) is a page whose list is the first view: only views over it count as over the page.
  const over = (followUpsShown(state)?.views.length ?? 0) - (state.route.page === 'follow-ups' ? 1 : 0);
  const organization = state.route.page === 'organization' ? state.organization : null;
  const onlyMe = state.route.page === 'only-me';
  const tools = state.route.page === 'tools' ? state.tools : null;
  // Another app is in front: cover what a project, Only me, People & invites,
  // an answer or an original shows until ECHO is back. The sidebar's project
  // rows stay, so a file dragged from Finder can still be dropped on one.
  const covered = pageCovered(state);
  // Home itself, nothing over it: the title row holds its stops where a page's name would be (One place to look v1). Never under
  // the cover, since a stop names a project or a person.
  const homeShows = !covered && !state.ask && !view && !state.reader && state.route.page === 'home';
  const pageName = inProject ? inProject.name : organization ? 'People & invites' : tools ? 'Tools' : onlyMe ? 'Only me' : decision ? 'Decision'
    : state.route.page === 'follow-ups' ? 'Follow-ups' : null;
  // A follow-ups view names itself: Follow-ups, the meeting or the project; an item; a decision.
  const viewName = view?.kind === 'list' ? view.title ?? 'Follow-ups'
    : view?.kind === 'item' ? (view.item ? itemTitle(shownItem(view.item, view.live)) : 'Follow-up') : view?.kind === 'decision' ? 'Decision' : null;
  const title = covered ? 'ECHO' : state.ask ? 'Ask' : viewName ?? pageName ?? 'ECHO';
  // Back leaves Ask for the page it was asked from; asked over a reader (or a follow-ups view), Back goes to it.
  // A follow-ups view goes back to the one before it, or to the reader it was opened over.
  // Follow-ups and Only me are places of their own, opened from the sidebar: no link back Home. A page reached by drilling in keeps
  // its link, and so does one kind's list on Home.
  const overlay = over > 0;
  const covering = state.reader !== null || overlay;
  const sidebarPage = state.route.page === 'follow-ups' || state.route.page === 'only-me';
  const backLabel = covered ? null : (state.ask && covering) || (overlay && (state.reader !== null || over > 1)) ? 'Back'
    : state.ask || covering ? pageName ?? 'Home' : pageName ? (sidebarPage ? null : 'Home') : homeShows && state.altitude.category !== null ? 'Home' : null;
  const pane = !covered && paneTarget(state) !== null;
  // A project change not shown where it was asked for shows at the top of the page.
  const banner = state.change && !state.concealed && !changeShownInPlace(state) ? state.change : null;
  const sheet = state.sheet;
  // New project, stepped aside after Create: the toast says how far it got, when nothing else has just been said.
  const progress = sheet?.kind === 'new-project' ? newProjectProgress(sheet) : null;
  const toasts = !state.concealed;
  // The bar's matches rise from the bar: a toast moves to the top of the page while they show, so neither hides the other.
  const toastClass = `toast${matchesShown(state) ? ' lifted' : ''}`;
  return (
    <Shell state={state} title={title} center={homeShows ? <Stops state={state} /> : null} backLabel={backLabel} pane={pane}
      trailing={inProject && !covered && !state.ask ? <><MembersButton state={state} /><ProjectToolsButton state={state} /><ProjectSettingsButton state={state} /></> : null}>
      <main class="page">
        {covered ? <div class="cover" data-testid="concealed">ECHO</div>
          : state.ask ? <AskView state={state} />
          : view?.kind === 'item' ? <FollowUp state={state} page={view} />
          : view?.kind === 'list' ? <FollowUps state={state} list={view} />
          : listDecision ? <Decision state={state} decision={listDecision} />
          : state.reader ? <Reader state={state} reader={state.reader} backTo={pageName ?? 'Home'} />
          : inProject ? <Project state={state} project={inProject} />
          : organization ? <Organization state={state} page={organization} />
          : tools ? <Tools state={state} page={tools} />
          : decision ? <Decision state={state} decision={decision} />
          : onlyMe ? <OnlyMe state={state} /> : <Home state={state} />}
      </main>
      {/* Always there, so a screen reader announces each toast as it appears. A save in no project opens Only me. */}
      <div role="status">
        {toasts && state.toast ? (toastOpensOnlyMe(state.toast) ? (
          <button type="button" class={toastClass} data-testid="toast" onClick={() => void openOnlyMe()}><Saved /><span>{state.toast}</span></button>
        ) : (
          <div class={toastClass} data-testid="toast">{WARNINGS.has(state.toast) ? <Warning /> : <Saved />}<span>{state.toast}</span></div>
        )) : toasts && progress && (
          <div class={toastClass} data-testid="new-project-progress">
            <span class="asking" aria-hidden="true"><i /><i /><i /></span><span>{progress.words}</span>
            {progress.total > 0 && <span class="toast-count">{progress.done} of {progress.total}</span>}
          </div>
        )}
      </div>
      {/* Under a toast, not hidden by it: Try again and Dismiss stay in reach. */}
      {banner && <div class={`banner${state.toast ? ' below' : ''}`} data-testid="change-banner"><ChangeLine change={banner} /></div>}
      <Bar state={state} />
      {pane && <SourcePane state={state} />}
      {state.compose && !state.compose.hidden && <Compose state={state} />}
      {!state.concealed && <ProjectSettings state={state} />}
      {sheet?.kind === 'tool-connect' ? !state.concealed && <ToolConnect sheet={sheet} />
        : sheet?.kind === 'tool-manage' ? !state.concealed && <ToolManage sheet={sheet} />
        : sheet?.kind === 'people' ? !state.concealed && <People state={state} sheet={sheet} />
        : sheet?.kind === 'new-project' ? !sheet.hidden && <NewProject state={state} sheet={sheet} />
        : sheet && <ConfirmSignOut state={state} sheet={sheet} />}
    </Shell>
  );
}

/**
 * One window: the sidebar (unless hidden), then the title bar and the page.
 * The title bar names the page, or holds `center` in its place (Home's
 * stops). A file dropped anywhere but a project row goes to Capture: into the
 * open sheet, or a new capture for the project on screen, or in no project.
 */
function Shell({ state, title, center = null, backLabel, pane = false, trailing = null, children }: {
  state: State; title: string; center?: ComponentChildren; backLabel: string | null; pane?: boolean; trailing?: ComponentChildren; children: ComponentChildren;
}) {
  const open = state.sidebarOpen;
  const onDrop = (event: DragEvent) => {
    // Text and links drop as usual, into the note or the bar.
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    event.preventDefault();
    const capturing = Boolean(state.compose && !state.compose.hidden);
    if (files.length === 1) void acceptDrop(files[0]!, capturing ? 'sheet' : 'window');
  };
  return (
    <div class={`app shell${open ? ' with-sidebar' : ''}`} onDragOver={event => { if (canDrop(event)) event.preventDefault(); }}
      onDrop={onDrop}>
      {open && <Sidebar state={state} />}
      <div class={`main${pane ? ' with-pane' : ''}`}>
        <header class="titlebar">
          <div class="side">
            <button type="button" class="icon-button" data-testid="sidebar-toggle" aria-label={open ? 'Hide sidebar' : 'Show sidebar'}
              aria-pressed={open} onClick={toggleSidebar}><SidebarIcon /></button>
            {backLabel && <button type="button" class="back" data-testid="back" onClick={back}><Back /><span>{backLabel}</span></button>}
          </div>
          {center ? <div class="title alt-title" data-testid="title">{center}</div>
            : <div class={`title${title === 'ECHO' ? ' brand' : ''}`} data-testid="title">{title}</div>}
          <div class="side">{trailing}</div>
        </header>
        {children}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
