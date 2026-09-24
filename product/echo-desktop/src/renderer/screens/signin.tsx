import { useState } from 'preact/hooks';
import { message } from '../messages.js';
import { signIn, type State } from '../store.js';

const LAST_AUTHORITY = 'echo.lastAuthority';

function remembered(): string {
  try { return localStorage.getItem(LAST_AUTHORITY) ?? ''; } catch { return ''; }
}

/** Signed out: your organization's address, then Google in the browser. */
export function SignIn({ state }: { state: State }) {
  const [url, setUrl] = useState(remembered);
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
        <input id="authority" class="field" data-testid="signin-url" type="url" placeholder="https://echo.your-company.com"
          value={url} onInput={event => setUrl((event.target as HTMLInputElement).value)} disabled={waiting} />
        <button type="submit" class="primary-button" data-testid="signin-button" disabled={!valid || waiting}>
          {waiting ? 'Waiting for your browser' : 'Sign in with Google'}
        </button>
        {waiting && <p>{state.signin.browserOpened === false ? 'Open the sign-in page from your browser.' : 'Finish signing in in your browser.'}</p>}
        {state.signin.phase === 'failed' && state.signin.failure && <p class="error">{message(state.signin.failure)}</p>}
      </form>
    </div>
  );
}
