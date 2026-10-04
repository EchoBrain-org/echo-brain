import { useEffect, useRef } from 'preact/hooks';
import { message } from '../messages.js';
import { closeSheet, signOut, signOutHeld, type SignOutSheet, type State } from '../store.js';
import { trapTab } from './compose.js';

/** Sign out and Switch account cannot be undone, so they are asked first. Cancel has the focus. */
export function ConfirmSignOut({ state, sheet }: { state: State; sheet: SignOutSheet }) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, [sheet.kind]);
  const held = signOutHeld();
  // An outcome that is unknown is settled where it shows, before signing out.
  const settle = state.compose?.status === 'unknown' ? 'A save may not have arrived. Check it in Capture first.'
    : state.change?.status === 'unknown' ? 'A project change may not have finished. Try it again or dismiss it first.'
    : 'Finish the current save first.';
  return (
    <div class="overlay" onClick={closeSheet}>
      <div class="sheet confirm" role="alertdialog" aria-labelledby="confirm-title" data-testid="confirm" ref={box}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <h2 id="confirm-title">{sheet.kind === 'switch' ? 'Switch account' : 'Sign out of this ECHO account?'}</h2>
        <p>{sheet.kind === 'switch'
          ? 'ECHO will sign out before you choose the next organization account.'
          : 'Ask and organization information will be cleared on this computer.'}</p>
        {held && <p class="error">{settle}</p>}
        {sheet.failure && <p class="error" aria-live="polite">{message(sheet.failure)}</p>}
        <div class="choices">
          <button type="button" class="plain-button" data-testid="confirm-cancel" ref={cancel} disabled={sheet.busy} onClick={closeSheet}>Cancel</button>
          <button type="button" class="plain-button danger" data-testid="confirm-signout" disabled={sheet.busy || held} onClick={() => void signOut()}>
            {sheet.failure ? 'Try again' : 'Sign out'}
          </button>
        </div>
      </div>
    </div>
  );
}
