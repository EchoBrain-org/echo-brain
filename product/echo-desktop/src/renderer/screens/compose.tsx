import { useEffect, useRef } from 'preact/hooks';
import { bytes } from '../format.js';
import { message } from '../messages.js';
import {
  attachFile, checkCompose, chooseProject, chooseReaders, closeCompose, keepUnresolved, loadProjects, newCompose, removeFile, sendCompose,
  setComposeText, toggleMore, type ComposeState, type State,
} from '../store.js';
import { useDropTarget } from './drop.js';
import { Clip, Close } from './icons.js';

const SAVE_HINT = navigator.userAgent.includes('Mac') ? '⌘↩' : 'Ctrl+↩';

/** Tab and Shift-Tab stay inside the sheet. */
export function trapTab(event: KeyboardEvent, sheet: HTMLElement | null): void {
  if (event.key !== 'Tab' || !sheet) return;
  const focusable = [...sheet.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea, [tabindex="0"]')];
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const inside = sheet.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
}

/** Who can read it, said before it is saved. Organization-wide cannot be narrowed later. */
function readersLine(compose: ComposeState): string {
  if (compose.readers === 'team') return 'Everyone in your org can read this.';
  if (compose.readers === 'project' && compose.project) return `${compose.project.name} members can read this.`;
  return 'Only you can read this.';
}

/** Capture: a note or one file, who can read it, then Save. A note's first line is its title. */
export function Compose({ state }: { state: State }) {
  const compose = state.compose!;
  const body = useRef<HTMLTextAreaElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const drop = useDropTarget('sheet');
  useEffect(() => { if (!compose.hidden) (body.current ?? sheet.current)?.focus(); }, [compose.seq, compose.hidden, compose.file]);
  // When the footer changes under the focused control, keep focus in the sheet.
  useEffect(() => {
    if (sheet.current && !sheet.current.contains(document.activeElement)) sheet.current.focus();
  }, [compose.status, compose.confirmNew]);

  const busy = compose.status === 'sending' || compose.status === 'checking';
  const unresolved = compose.status === 'unknown' || compose.status === 'checking';
  const locked = busy || unresolved;
  const empty = compose.text.trim() === '' && !compose.file;
  // More… offers the projects not already in the row.
  const others = state.projects.items.filter(project => project.project_id !== compose.project?.project_id);
  const more = others.length > 0 || state.projects.next !== null;

  return (
    <div class="overlay" onClick={closeCompose}>
      <div
        class={`sheet capture${drop.over ? ' drop-target' : ''}`} role="dialog" aria-label="Capture" data-testid="compose" ref={sheet} tabIndex={-1}
        {...drop.handlers}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          // Escape is handled once, at the window: it hides the sheet and keeps the draft.
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !unresolved) { event.preventDefault(); void sendCompose(); }
          trapTab(event, sheet.current);
        }}
      >
        <div class="sheet-head">
          <h2>Capture</h2>
          <button type="button" class="circle small" aria-label="Close" data-testid="compose-close" onClick={closeCompose} disabled={busy}><Close /></button>
        </div>
        <div class="well">
          {compose.file ? (
            // A file goes on its own: its name is the title, and there is no note to lose.
            <div class="file-chip" data-testid="compose-file">
              <span>{compose.file.name}{compose.file.size === undefined ? '' : ` · ${bytes(compose.file.size)}`}</span>
              <button type="button" aria-label="Remove file" data-testid="compose-remove-file" onClick={removeFile} disabled={locked}><Close /></button>
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
        </div>
        {compose.notice && <div class="notice-line" data-testid="compose-notice" aria-live="polite">{compose.notice}</div>}
        <div class="readers">
          <span class="label" id="readers-label">Who can read</span>
          <div class="segments" role="group" aria-labelledby="readers-label">
            <button type="button" class="segment" data-testid="readers-only-me" aria-pressed={compose.readers === 'only-me'} disabled={locked}
              onClick={() => chooseReaders('only-me')}>Only me</button>
            {compose.project && (
              <button type="button" class="segment" data-testid="readers-project" aria-pressed={compose.readers === 'project'} disabled={locked}
                onClick={() => chooseReaders('project')}>{compose.project.name}</button>
            )}
            <button type="button" class="segment" data-testid="readers-team" aria-pressed={compose.readers === 'team'} disabled={locked}
              onClick={() => chooseReaders('team')}>Organization</button>
            {more && (
              <button type="button" class="segment" data-testid="readers-more" aria-expanded={compose.picking} disabled={locked}
                onClick={toggleMore}>More…</button>
            )}
          </div>
        </div>
        {compose.picking && (
          <div class="pills" role="group" aria-label="Projects">
            {others.map(project => (
              <button type="button" key={project.project_id} class="pill" data-testid="readers-choice" onClick={() => chooseProject(project)}>
                {project.name}
              </button>
            ))}
            {state.projects.next && (
              <button type="button" class="pill" data-testid="readers-choice-more" disabled={state.projects.loading}
                onClick={() => void loadProjects(true)}>More</button>
            )}
          </div>
        )}
        <div class={`readers-line${compose.readers === 'team' ? ' warning' : ''}`} data-testid="compose-readers" aria-live="polite">
          {readersLine(compose)}
        </div>
        {unresolved ? (
          <div class="unresolved" data-testid="compose-unresolved" aria-live="polite">
            {compose.confirmNew ? (
              <>
                <span class="error">Start over? The earlier one may still arrive.</span>
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
                  <button type="button" class="plain-button" data-testid="compose-retry" disabled={busy} onClick={() => void sendCompose()}>Try again</button>
                  <button type="button" class="plain-button" data-testid="compose-new" disabled={busy} onClick={newCompose}>Start over</button>
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
              {compose.status === 'sending' && <span class="notice">Saving</span>}
              {compose.status === 'error' && compose.failure && <span class="error" data-testid="compose-error">{message(compose.failure)}</span>}
            </div>
            <button type="button" class="primary-button small" data-testid="compose-send" disabled={locked || empty} onClick={() => void sendCompose()}>
              Save <span class="hint">{SAVE_HINT}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
