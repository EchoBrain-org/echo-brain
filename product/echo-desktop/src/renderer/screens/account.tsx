import { useEffect, useRef } from 'preact/hooks';
import { message } from '../messages.js';
import { closeSheet, saveInFlight, signOut, type SignOutSheet, type State } from '../store.js';
import { trapTab } from './compose.js';

/** Sign out and Switch account cannot be undone, so they are asked first. Cancel has the focus. */
export function ConfirmSignOut({ state, sheet }: { state: State; sheet: SignOutSheet }) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, [sheet.kind]);
  const saving = saveInFlight();
  const unresolved = state.compose?.status === 'unknown';
  return (
    <div class="overlay" onClick={closeSheet}>
      <div class="sheet confirm" role="alertdialog" aria-labelledby="confirm-title" data-testid="confirm" ref={box}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <h2 id="confirm-title">{sheet.kind === 'switch' ? 'Switch account' : 'Sign out of this ECHO account?'}</h2>
        <p>{sheet.kind === 'switch'
          ? 'ECHO will sign out before you choose the next organization account.'
          : 'Ask and organization information will be cleared on this computer.'}</p>
        {saving && <p class="error">Finish the current save first.</p>}
        {!saving && unresolved && <p class="warning">A save may not have arrived. Signing out forgets it.</p>}
        {sheet.failure && <p class="error" aria-live="polite">{message(sheet.failure)}</p>}
        <div class="choices">
          <button type="button" class="plain-button" data-testid="confirm-cancel" ref={cancel} disabled={sheet.busy} onClick={closeSheet}>Cancel</button>
          <button type="button" class="plain-button danger" data-testid="confirm-signout" disabled={sheet.busy || saving} onClick={() => void signOut()}>
            {sheet.failure ? 'Try again' : 'Sign out'}
          </button>
        </div>
      </div>
    </div>
  );
}
