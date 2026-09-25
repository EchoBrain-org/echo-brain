import { render, type ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { on } from './api.js';
import { ConfirmSignOut, ConnectedTools } from './screens/account.js';
import { AskView, Bar, SourcePane } from './screens/ask.js';
import { Compose } from './screens/compose.js';
import { Home } from './screens/home.js';
import { ChangeLine, changeShownInPlace } from './screens/change.js';
import { Back, Saved, SidebarIcon, Warning } from './screens/icons.js';
import { NewProject } from './screens/new-project.js';
import { Organization } from './screens/organization.js';
import { People } from './screens/people.js';
import { MembersButton, Project } from './screens/project.js';
import { Reader } from './screens/reader.js';
import { Sidebar } from './screens/sidebar.js';
import { SignedOut } from './screens/signin.js';
import {
  acceptDrop, accountCommand, canDrop, cancelMemberChange, cancelRevoke, cancelSkip, clearBar, closeAsk, closeCompose, closeProjects, closeReader,
  closeSheet, closeSigninForm, conceal, findingSheet, getState, goHome, hostFailed, keepNewProject, matchesShown, openCapture, pageCovered,
  refreshStatus, resume, retryStart, signinPhase, toggleEmployeeMenu, toggleMemberMenu, toggleReaderMenu, toggleSidebar, trayOrganization,
  UNSAVED_FILES, useStore, windowShown, type State,
} from './store.js';

if (navigator.userAgent.includes('Mac')) document.documentElement.classList.add('mac');

function sheetUp(): boolean {
  const { compose, sheet } = getState();
  return Boolean((compose && !compose.hidden) || sheet);
}

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
 * answer (and the source beside it), reader, then a project or People & invites.
 */
function back(): void {
  const state = getState();
  const finding = findingSheet(state);
  if (finding?.confirm) return cancelMemberChange();
  if (finding?.menu) return toggleMemberMenu(finding.menu);
  if (state.sheet?.kind === 'new-project' && state.sheet.skip !== null) return cancelSkip();
  if (state.sheet?.kind === 'new-project' && state.sheet.confirmClose) return keepNewProject();
  if (state.sheet) return closeSheet();
  if (!state.status?.signed_in) return closeSigninForm();
  // Escape closes the Projects list first, and only the list.
  if (state.compose && !state.compose.hidden) return state.compose.picking ? closeProjects() : closeCompose();
  if (state.ask) return closeAsk();
  if (state.reader?.menu !== undefined && state.reader.menu !== 'closed') return toggleReaderMenu();
  if (state.reader) return closeReader();
  if (state.organization?.confirm) return cancelRevoke();
  if (state.organization?.menu) return toggleEmployeeMenu(state.organization.menu);
  if (state.route.page !== 'home') return goHome();
}

function App() {
  const state = useStore();

  // Capture closed (saved, or put away): the caret goes back to the bar.
  const capturing = Boolean(state.compose && !state.compose.hidden);
  useEffect(() => { if (!capturing) focusBar(); }, [capturing]);

  useEffect(() => {
    void refreshStatus().then(focusBar);
    const stops = [
      on('capture.open', () => { if (getState().status?.signed_in) openCapture(); }),
      on('lifecycle.conceal', conceal),
      on('lifecycle.resume', resume),
      on('window.shown', () => {
        if (getState().concealed) return;
        void windowShown();
        focusBar();
      }),
      on('signin.phase', payload => signinPhase(payload.browser_opened)),
      on('host.restarted', () => { void refreshStatus(); }),
      on('host.failed', hostFailed),
      on('account.command', payload => accountCommand(payload.command)),
      on('organization.open', () => { if (getState().status?.signed_in) trayOrganization(); }),
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
        </div></div>
      </div>
    );
  }
  if (!state.status?.signed_in) {
    return <Shell state={state} title="ECHO" backLabel={null}><SignedOut state={state} /></Shell>;
  }

  const inProject = state.route.page === 'project' ? state.route.project : null;
  const organization = state.route.page === 'organization' ? state.organization : null;
  // Another app is in front: cover what a project, People & invites, an answer
  // or an original shows until ECHO is back. Project rows stay (Home's and the
  // sidebar's), so a file dragged from Finder can still be dropped on one.
  const covered = pageCovered(state);
  const pageName = inProject ? inProject.name : organization ? 'People & invites' : null;
  const title = covered ? 'ECHO' : state.ask ? 'Ask' : pageName ?? 'ECHO';
  // Back leaves Ask for the page it was asked from; asked over a reader, Back goes to the reader.
  const backLabel = covered ? null : state.ask && state.reader ? 'Back'
    : state.ask || state.reader ? pageName ?? 'Home' : pageName ? 'Home' : null;
  const pane = !covered && state.ask !== null && state.sources?.open != null;
  // A project change not shown where it was asked for shows at the top of the page.
  const banner = state.change && !state.concealed && !changeShownInPlace(state) ? state.change : null;
  const sheet = state.sheet;
  return (
    <Shell state={state} title={title} backLabel={backLabel} pane={pane}
      trailing={inProject && !covered && !state.ask ? <MembersButton state={state} /> : null}>
      <main class="page">
        {covered ? <div class="cover" data-testid="concealed">ECHO</div>
          : state.ask ? <AskView state={state} />
          : state.reader ? <Reader state={state} reader={state.reader} backTo={inProject?.name ?? 'Home'} />
          : inProject ? <Project state={state} project={inProject} />
          : organization ? <Organization state={state} page={organization} /> : <Home state={state} />}
      </main>
      {/* Always there, so a screen reader announces each toast as it appears. */}
      <div role="status">
        {state.toast && !state.concealed && (
          <div class="toast" data-testid="toast">{state.toast === UNSAVED_FILES ? <Warning /> : <Saved />}<span>{state.toast}</span></div>
        )}
      </div>
      {/* Under a toast, not hidden by it: Try again and Dismiss stay in reach. */}
      {banner && <div class={`banner${state.toast ? ' below' : ''}`} data-testid="change-banner"><ChangeLine change={banner} /></div>}
      <Bar state={state} />
      {pane && <SourcePane state={state} />}
      {state.compose && !state.compose.hidden && <Compose state={state} />}
      {sheet?.kind === 'tools' ? <ConnectedTools state={state} sheet={sheet} />
        : sheet?.kind === 'people' ? !state.concealed && <People state={state} sheet={sheet} />
        : sheet?.kind === 'new-project' ? <NewProject state={state} sheet={sheet} />
        : sheet && <ConfirmSignOut state={state} sheet={sheet} />}
    </Shell>
  );
}

/**
 * One window: the sidebar (unless hidden), then the title bar and the page.
 * A file dropped anywhere but a project row goes to Capture: into the open
 * sheet, or a new capture for the project on screen.
 */
function Shell({ state, title, backLabel, pane = false, trailing = null, children }: {
  state: State; title: string; backLabel: string | null; pane?: boolean; trailing?: ComponentChildren; children: ComponentChildren;
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
    <div class={`app shell${open ? ' with-sidebar' : ''}`} onDragOver={event => { if (canDrop(event)) event.preventDefault(); }} onDrop={onDrop}>
      {open && <Sidebar state={state} />}
      <div class={`main${pane ? ' with-pane' : ''}`}>
        <header class="titlebar">
          <div class="side">
            <button type="button" class="icon-button" data-testid="sidebar-toggle" aria-label={open ? 'Hide sidebar' : 'Show sidebar'}
              aria-pressed={open} onClick={toggleSidebar}><SidebarIcon /></button>
            {backLabel && <button type="button" class="back" data-testid="back" onClick={back}><Back /><span>{backLabel}</span></button>}
          </div>
          <div class={`title${title === 'ECHO' ? ' brand' : ''}`} data-testid="title">{title}</div>
          <div class="side">{trailing}</div>
        </header>
        {children}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
