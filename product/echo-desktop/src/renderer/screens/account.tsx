import { useEffect, useRef } from 'preact/hooks';
import { message } from '../messages.js';
import { closeSheet, loadTools, signOut, signOutHeld, type SignOutSheet, type State, type ToolsSheet } from '../store.js';
import { trapTab } from './compose.js';
import { Close } from './icons.js';

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

/** Connected tools…: what the organization has enabled, and whether you linked your own account. */
export function ConnectedTools({ state, sheet }: { state: State; sheet: ToolsSheet }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const account = state.status?.account;
  return (
    <div class="overlay" onClick={closeSheet}>
      <div class="sheet tools" role="dialog" aria-labelledby="tools-title" data-testid="tools" ref={box} tabIndex={-1}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <div class="sheet-head">
          <h2 id="tools-title">Connected tools</h2>
          <button type="button" class="circle" aria-label="Close" data-testid="tools-close" onClick={closeSheet}><Close /></button>
        </div>
        {account && <p class="context">{account.display_name} · {account.authority}</p>}
        <div aria-live="polite" aria-busy={sheet.loading}>
          {sheet.loading && <p>Checking organization tools…</p>}
          {sheet.failure && (
            <div class="choices start">
              <p class="error">{message(sheet.failure)}</p>
              <button type="button" class="plain-button" onClick={() => void loadTools()}>Try again</button>
            </div>
          )}
          {sheet.tools && sheet.tools.length === 0 && <p>Your organization has no supported tools enabled.</p>}
          {sheet.tools && sheet.tools.length > 0 && (
            <ul class="tool-list">
              {sheet.tools.map(tool => (
                <li class="tool-row" data-testid="tool-row" key={tool.name}>
                  <span class="name">{tool.name}</span>
                  <span class="state">{tool.enabled
                    ? `Organization: enabled · Your link: ${tool.linked ? 'Connected' : 'Not connected'}`
                    : 'Not enabled for this organization. Ask an owner to connect it.'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p class="context">Linking a tool is optional; Ask and Sources already use your ECHO access.</p>
      </div>
    </div>
  );
}
