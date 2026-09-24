import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { on } from './api.js';
import { AskView, Bar } from './screens/ask.js';
import { Compose } from './screens/compose.js';
import { Home } from './screens/home.js';
import { Back } from './screens/icons.js';
import { Project } from './screens/project.js';
import { SignIn } from './screens/signin.js';
import {
  acceptDrop, closeAsk, closeCompose, closeReader, closeSource, conceal, getState, goHome, openCompose, refreshStatus, resume,
  signinPhase, useStore,
} from './store.js';

if (navigator.userAgent.includes('Mac')) document.documentElement.classList.add('mac');

/** Escape steps back one level: compose, source, answer, reader, project. */
function back(): void {
  const state = getState();
  if (state.compose) return closeCompose();
  if (state.evidence) return closeSource();
  if (state.ask) return closeAsk();
  if (state.reader) return closeReader();
  if (state.route.page === 'project') return goHome();
}

function App() {
  const state = useStore();

  useEffect(() => {
    void refreshStatus();
    const stops = [
      on('capture.open', () => { if (getState().status?.signed_in) openCompose(); }),
      on('lifecycle.conceal', conceal),
      on('lifecycle.resume', resume),
      on('window.shown', () => { if (!getState().concealed) void refreshStatus(); }),
      on('signin.phase', payload => signinPhase(payload.browser_opened)),
      on('host.restarted', () => { void refreshStatus(); }),
    ];
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !getState().compose) back(); };
    window.addEventListener('keydown', onKey);
    return () => { stops.forEach(stop => stop()); window.removeEventListener('keydown', onKey); };
  }, []);

  if (state.concealed) return <div class="concealed" data-testid="concealed">ECHO</div>;
  if (state.booting) return <div class="app"><div class="titlebar"><div class="side" /><div class="title brand">ECHO</div><div class="side" /></div></div>;
  if (!state.status?.signed_in) {
    return (
      <div class="app">
        <div class="titlebar"><div class="side" /><div class="title brand">ECHO</div><div class="side" /></div>
        <SignIn state={state} />
      </div>
    );
  }

  const inProject = state.route.page === 'project' ? state.route.project : null;
  const title = state.ask ? '' : inProject ? inProject.name : 'ECHO';
  const backLabel = state.evidence || state.ask ? 'Back' : state.reader ? inProject?.name : inProject ? 'Projects' : null;
  return (
    <div
      class="app"
      onDragOver={event => event.preventDefault()}
      onDrop={event => {
        event.preventDefault();
        const file = event.dataTransfer?.files[0];
        if (file && !state.compose) void acceptDrop(file);
      }}
    >
      <header class="titlebar">
        <div class="side">
          {backLabel && <button type="button" class="back" data-testid="back" onClick={back}><Back /><span>{backLabel}</span></button>}
        </div>
        <div class={`title${title === 'ECHO' ? ' brand' : ''}`} data-testid="title">{title}</div>
        <div class="side" />
      </header>
      <main class="page">
        {state.ask ? <AskView state={state} /> : inProject ? <Project state={state} project={inProject} /> : <Home state={state} />}
      </main>
      <Bar state={state} />
      {state.compose && <Compose state={state} />}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
