import { render, type ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { on } from './api.js';
import { ConfirmSignOut } from './screens/account.js';
import { AskView, Bar } from './screens/ask.js';
import { Compose } from './screens/compose.js';
import { Home } from './screens/home.js';
import { Back, SidebarIcon } from './screens/icons.js';
import { Project } from './screens/project.js';
import { Sidebar } from './screens/sidebar.js';
import { SignedOut } from './screens/signin.js';
import {
  accountCommand, closeAsk, closeCompose, closeReader, closeSheet, closeSigninForm, closeSource, conceal, getState, goHome, hostFailed,
  openCapture, refreshHome, refreshStatus, resume, retryStart, signinPhase, toggleSidebar, useStore, type State,
} from './store.js';

if (navigator.userAgent.includes('Mac')) document.documentElement.classList.add('mac');

/** The caret waits in the ask bar whenever the window comes forward, unless a sheet is up. */
function focusBar(): void {
  const { compose, sheet } = getState();
  if ((compose && !compose.hidden) || sheet) return;
  requestAnimationFrame(() => document.getElementById('ask-field')?.focus());
}

/** Escape steps back one level: a sheet, compose, source, answer, reader, project. */
function back(): void {
  const state = getState();
  if (state.sheet) return closeSheet();
  if (!state.status?.signed_in) return closeSigninForm();
  if (state.compose && !state.compose.hidden) return closeCompose();
  if (state.evidence) return closeSource();
  if (state.ask) return closeAsk();
  if (state.reader) return closeReader();
  if (state.route.page === 'project') return goHome();
}

function App() {
  const state = useStore();

  useEffect(() => {
    void refreshStatus().then(focusBar);
    const stops = [
      on('capture.open', () => { if (getState().status?.signed_in) openCapture(); }),
      on('lifecycle.conceal', conceal),
      on('lifecycle.resume', resume),
      on('window.shown', () => {
        if (getState().concealed) return;
        void refreshStatus().then(refreshHome);
        focusBar();
      }),
      on('signin.phase', payload => signinPhase(payload.browser_opened)),
      on('host.restarted', () => { void refreshStatus(); }),
      on('host.failed', hostFailed),
      on('account.command', payload => accountCommand(payload.command)),
    ];
    // One Escape handler for the whole window: it steps back exactly one level.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); back(); } };
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
  // Another app is in front: cover the page until ECHO is back. The sidebar's
  // project rows stay, so a file can still be dropped on one.
  const covered = state.concealed;
  const title = covered ? 'ECHO' : state.ask ? '' : inProject ? inProject.name : 'ECHO';
  const backLabel = covered ? null : state.evidence || state.ask ? 'Back' : state.reader ? inProject?.name : inProject ? 'Home' : null;
  return (
    <Shell state={state} title={title} backLabel={backLabel ?? null}>
      <main class="page">
        {covered ? <div class="cover" data-testid="concealed">ECHO</div>
          : state.ask ? <AskView state={state} /> : inProject ? <Project state={state} project={inProject} /> : <Home state={state} />}
      </main>
      <Bar state={state} />
      {state.compose && !state.compose.hidden && <Compose state={state} />}
      {state.sheet && <ConfirmSignOut state={state} sheet={state.sheet} />}
    </Shell>
  );
}

/** One window: the sidebar (unless hidden), then the title bar and the page. */
function Shell({ state, title, backLabel, children }: { state: State; title: string; backLabel: string | null; children: ComponentChildren }) {
  const open = state.sidebarOpen;
  return (
    <div class={`app shell${open ? ' with-sidebar' : ''}`}>
      {open && <Sidebar state={state} />}
      <div class="main">
        <header class="titlebar">
          <div class="side">
            <button type="button" class="icon-button" data-testid="sidebar-toggle" aria-label={open ? 'Hide sidebar' : 'Show sidebar'}
              aria-pressed={open} onClick={toggleSidebar}><SidebarIcon /></button>
            {backLabel && <button type="button" class="back" data-testid="back" onClick={back}><Back /><span>{backLabel}</span></button>}
          </div>
          <div class={`title${title === 'ECHO' ? ' brand' : ''}`} data-testid="title">{title}</div>
          <div class="side" />
        </header>
        {children}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
