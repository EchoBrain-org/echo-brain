import { useEffect, useRef, useState } from 'preact/hooks';
import { message } from '../messages.js';
import { closeSigninForm, showAccountMenu, signIn, type State } from '../store.js';

const LAST_AUTHORITY = 'echo.lastAuthority';

function remembered(): string {
  try { return localStorage.getItem(LAST_AUTHORITY) ?? ''; } catch { return ''; }
}

/** Signed out: "Sign in to use ECHO". Sign in… opens the Account menu, as the sidebar's Account row does. */
export function SignedOut({ state }: { state: State }) {
  if (state.signin.form) return <SignInForm state={state} />;
  const { phase, failure, browserOpened } = state.signin;
  const waiting = phase === 'waiting';
  return (
    <div class="page">
      <div class="signin" data-testid="signed-out">
        <p class="lead">Sign in to use ECHO</p>
        <button type="button" class="primary-button small" data-testid="signin-open" disabled={waiting} aria-haspopup="menu"
          onClick={event => showAccountMenu(event.currentTarget, 'below')}>
          {waiting ? 'Waiting for your browser' : 'Sign in…'}
        </button>
        {waiting && <p>{browserOpened === false ? 'Open the sign-in page from your browser.' : 'Finish signing in in your browser.'}</p>}
        {phase === 'failed' && failure && <p class="error" data-testid="signin-error">{message(failure)}</p>}
      </div>
    </div>
  );
}

/** Sign in with Google…: your organization's address, then Google in the browser. */
function SignInForm({ state }: { state: State }) {
  const [url, setUrl] = useState(remembered);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  const waiting = state.signin.phase === 'waiting';
  const valid = /^https:\/\/[^\s/]+/.test(url.trim());
  return (
    <div class="page">
      <form class="signin" data-testid="signin" onSubmit={event => {
        event.preventDefault();
        if (!valid || waiting) return;
        try { localStorage.setItem(LAST_AUTHORITY, url.trim()); } catch { /* optional convenience */ }
        void signIn(url.trim());
      }}>
        <h1>Sign in to ECHO</h1>
        <label for="authority" class="sr-only">Organization address</label>
        <input id="authority" ref={field} class="field" data-testid="signin-url" type="url" placeholder="https://echo.your-company.com"
          value={url} onInput={event => setUrl((event.target as HTMLInputElement).value)} disabled={waiting} />
        <button type="submit" class="primary-button" data-testid="signin-button" disabled={!valid || waiting}>
          {waiting ? 'Waiting for your browser' : 'Sign in with Google'}
        </button>
        {waiting && <p>{state.signin.browserOpened === false ? 'Open the sign-in page from your browser.' : 'Finish signing in in your browser.'}</p>}
        {state.signin.phase === 'failed' && state.signin.failure && <p class="error">{message(state.signin.failure)}</p>}
        {!waiting && <button type="button" class="link-button cancel" data-testid="signin-cancel" onClick={closeSigninForm}>Cancel</button>}
      </form>
    </div>
  );
}
