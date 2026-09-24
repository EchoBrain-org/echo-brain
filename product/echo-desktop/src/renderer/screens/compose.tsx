import { useEffect, useRef, useState } from 'preact/hooks';
import { message } from '../messages.js';
import {
  acceptDrop, attachFile, checkCompose, chooseTarget, closeCompose, keepUnresolved, newCompose, removeFile, sendCompose,
  sentLabel, setComposeText, targetLabel, toggleTargets, type ComposeTarget, type State,
} from '../store.js';
import { Check, Chevron, Clip, Close, Up } from './icons.js';

/** Tab and Shift-Tab stay inside the sheet. */
function trapTab(event: KeyboardEvent, sheet: HTMLElement | null): void {
  if (event.key !== 'Tab' || !sheet) return;
  const focusable = [...sheet.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, [tabindex="0"]')];
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const inside = sheet.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
}

/** Write and Capture: To, then a note or a file, then send. A note's first line is its title. */
export function Compose({ state }: { state: State }) {
  const compose = state.compose!;
  const body = useRef<HTMLTextAreaElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => { if (!compose.hidden) (body.current ?? sheet.current)?.focus(); }, [compose.seq, compose.hidden, compose.file]);
  // When the footer changes under the focused control, keep focus in the sheet.
  useEffect(() => {
    if (compose.status === 'sent') { done.current?.focus(); return; }
    if (sheet.current && !sheet.current.contains(document.activeElement)) sheet.current.focus();
  }, [compose.status, compose.confirmNew]);

  if (compose.status === 'sent') {
    return (
      <div class="overlay" onClick={closeCompose}>
        <div class="sheet" role="dialog" aria-label="Sent" ref={sheet} onClick={event => event.stopPropagation()}
          onKeyDown={event => trapTab(event, sheet.current)}>
          <div class="sent" data-testid="sent">
            <div class="check"><Check /></div>
            <div class="what">{sentLabel(compose.target)}</div>
            <button type="button" class="plain-button" data-testid="compose-done" ref={done} onClick={closeCompose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  const targets: ComposeTarget[] = [
    { kind: 'only-me' },
    ...state.projects.items.map(project => ({ kind: 'project' as const, project })),
    { kind: 'team' },
  ];
  const same = (a: ComposeTarget, b: ComposeTarget) =>
    a.kind === b.kind && (a.kind !== 'project' || (b.kind === 'project' && a.project.project_id === b.project.project_id));
  const busy = compose.status === 'sending' || compose.status === 'checking';
  const unresolved = compose.status === 'unknown' || compose.status === 'checking';
  const locked = busy || unresolved;
  const empty = compose.text.trim() === '' && !compose.file;

  return (
    <div class="overlay" onClick={closeCompose}>
      <div
        class={`sheet${over ? ' drop-target' : ''}`} role="dialog" aria-label="Write" data-testid="compose" ref={sheet} tabIndex={-1}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          // Escape is handled once, at the window: it hides the sheet and keeps the draft.
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !unresolved) { event.preventDefault(); void sendCompose(); }
          trapTab(event, sheet.current);
        }}
        onDragOver={event => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={event => {
          event.preventDefault(); event.stopPropagation(); setOver(false);
          const file = event.dataTransfer?.files[0];
          if (file) void acceptDrop(file);
        }}
      >
        <div class="to-row">
          <button type="button" class="circle" aria-label="Close" data-testid="compose-close" onClick={closeCompose} disabled={busy}><Close /></button>
          <span class="label">To</span>
          <button type="button" class="to-button" data-testid="compose-to" aria-expanded={compose.picking} onClick={toggleTargets} disabled={locked}>
            <span>{targetLabel(compose.target)}</span><Chevron />
          </button>
        </div>
        {compose.picking && (
          <div class="pills" role="listbox" aria-label="To">
            {targets.map(target => (
              <button
                type="button" role="option" aria-selected={same(target, compose.target)} data-testid="compose-target"
                key={target.kind === 'project' ? target.project.project_id : target.kind}
                class={`pill${same(target, compose.target) ? ' on' : ''}`} onClick={() => chooseTarget(target)}
              >{targetLabel(target)}</button>
            ))}
          </div>
        )}
        {compose.target.kind === 'team' && (
          <div class="warning" data-testid="compose-warning">Everyone in your organization will be able to read this.</div>
        )}
        {compose.file ? (
          // A file goes on its own: its name is the title, and there is no note to lose.
          <div class="file-only">
            <div class="file-chip" data-testid="compose-file">
              <span>{compose.file.name}</span>
              <button type="button" aria-label="Remove file" data-testid="compose-remove-file" onClick={removeFile} disabled={locked}><Close /></button>
            </div>
          </div>
        ) : (
          <>
            <label for="compose-body" class="sr-only">What happened?</label>
            <textarea
              id="compose-body" ref={body} data-testid="compose-body" placeholder="What happened?" readOnly={locked}
              value={compose.text} onInput={event => setComposeText((event.target as HTMLTextAreaElement).value)}
            />
          </>
        )}
        {compose.notice && <div class="notice-line" data-testid="compose-notice" aria-live="polite">{compose.notice}</div>}
        {unresolved ? (
          <div class="unresolved" data-testid="compose-unresolved" aria-live="polite">
            {compose.confirmNew ? (
              <>
                <span class="error">Start a new note? The earlier one may still arrive.</span>
                <div class="choices">
                  <button type="button" class="plain-button" data-testid="compose-start-over" onClick={newCompose}>Start over</button>
                  <button type="button" class="plain-button" onClick={keepUnresolved}>Keep it</button>
                </div>
              </>
            ) : (
              <>
                <span class="error" data-testid="compose-error">
                  {compose.status === 'checking' ? 'Checking…' : 'This may not have been sent.'}
                </span>
                <div class="choices">
                  <button type="button" class="plain-button" data-testid="compose-check" disabled={busy} onClick={() => void checkCompose()}>Check status</button>
                  <button type="button" class="plain-button" data-testid="compose-retry" disabled={busy} onClick={() => void sendCompose()}>Retry</button>
                  <button type="button" class="plain-button" data-testid="compose-new" disabled={busy} onClick={newCompose}>Write new</button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div class="sheet-foot">
            {!compose.file && (
              <button type="button" class="circle" aria-label="Attach a file" data-testid="compose-attach" onClick={() => void attachFile()} disabled={locked}><Clip /></button>
            )}
            <div class="status" aria-live="polite">
              {compose.status === 'sending' && <span class="notice">Sending</span>}
              {compose.status === 'error' && compose.failure && <span class="error" data-testid="compose-error">{message(compose.failure)}</span>}
            </div>
            <span class="hint">⌘↩</span>
            <button type="button" class="circle primary" aria-label="Send" data-testid="compose-send" disabled={locked || empty} onClick={() => void sendCompose()}><Up /></button>
          </div>
        )}
      </div>
    </div>
  );
}
