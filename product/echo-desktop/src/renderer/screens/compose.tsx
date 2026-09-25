import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ProjectSummary } from '../../shared/protocol.js';
import { bytes } from '../format.js';
import { message } from '../messages.js';
import {
  attachFile, checkCompose, chooseReaders, closeCompose, keepUnresolved, loadProjects, newCompose, removeFile, sendCompose,
  setComposeText, type ComposeState, type State,
} from '../store.js';
import { useDropTarget } from './drop.js';
import { Clip, Close } from './icons.js';

const SAVE_HINT = navigator.userAgent.includes('Mac') ? '⌘↩' : 'Ctrl+↩';

/** Tab and Shift-Tab stay inside the sheet. */
export function trapTab(event: KeyboardEvent, sheet: HTMLElement | null): void {
  if (event.key !== 'Tab' || !sheet) return;
  const focusable = [...sheet.querySelectorAll<HTMLElement>(
    'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), textarea, [tabindex="0"]',
  )];
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

/** Past this many projects, a field finds one by name. */
const FIND_AFTER = 8;
/** Arrow keys move through Who can read, and pick as they go. */
const STEPS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Every project a capture can be for: the one Capture was opened for first,
 * then Home's list. One chosen that the list no longer has stays in sight.
 */
function projectChoices(compose: ComposeState, listed: readonly ProjectSummary[]): ProjectSummary[] {
  const choices: ProjectSummary[] = [];
  const seen = new Set<string>();
  const add = (project: ProjectSummary | null) => {
    if (project && !seen.has(project.project_id)) { seen.add(project.project_id); choices.push(project); }
  };
  add(compose.context);
  if (compose.project && !listed.some(project => project.project_id === compose.project!.project_id)) add(compose.project);
  listed.forEach(add);
  return choices;
}

/**
 * Who can read: Only me, every project by name, then Organization. One click
 * picks; the pills wrap, and with many projects a field finds one.
 */
function WhoCanRead({ state, compose, locked }: { state: State; compose: ComposeState; locked: boolean }) {
  const group = useRef<HTMLDivElement>(null);
  const [find, setFind] = useState('');
  const projects = projectChoices(compose, state.projects.items);
  const finding = projects.length > FIND_AFTER;
  const query = finding ? find.trim().toLocaleLowerCase() : '';
  const shown = query ? projects.filter(project => project.name.toLocaleLowerCase().includes(query)) : projects;
  const choices = [
    { key: 'only-me', label: 'Only me', choice: 'only-me' as const, testid: 'readers-only-me', checked: compose.readers === 'only-me' },
    ...shown.map(project => ({
      key: project.project_id, label: project.name, choice: project, testid: 'readers-project',
      checked: compose.readers === 'project' && compose.project?.project_id === project.project_id,
    })),
    { key: 'team', label: 'Organization', choice: 'team' as const, testid: 'readers-team', checked: compose.readers === 'team' },
  ];
  // One Tab stop: the chosen pill, or Only me while a search hides it.
  const stop = Math.max(0, choices.findIndex(choice => choice.checked));

  // Opened again on a project far down the list, its pill is in sight.
  useLayoutEffect(() => { group.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' }); }, []);
  // Only a name wider than the whole sheet is cut off, and then its tooltip says it in full.
  useLayoutEffect(() => {
    for (const radio of group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []) {
      if (radio.scrollWidth - radio.clientWidth > 1) radio.title = radio.textContent ?? '';
      else radio.removeAttribute('title');
    }
  });

  return (
    <div class="readers">
      <div class="readers-head">
        <span class="label" id="readers-label">Who can read</span>
        {finding && (
          <input
            type="text" class="field find" data-testid="readers-find" placeholder="Find a project" aria-label="Find a project" spellcheck={false}
            value={find} disabled={locked} onInput={event => setFind((event.target as HTMLInputElement).value)}
            onKeyDown={event => {
              // ⌘↩ still saves and Escape still closes: only a plain Enter is the field's.
              if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
              event.preventDefault();
              if (query && shown[0]) chooseReaders(shown[0]);
            }}
          />
        )}
      </div>
      <div class="reader-pills">
        <div
          role="radiogroup" aria-labelledby="readers-label" ref={group}
          onKeyDown={event => {
            const step = STEPS[event.key];
            if (!step || event.metaKey || event.ctrlKey || event.altKey) return;
            const radios = [...group.current!.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
            const at = radios.indexOf(document.activeElement as HTMLButtonElement);
            if (at < 0) return;
            event.preventDefault();
            const next = (at + step + radios.length) % radios.length;
            radios[next]!.focus();
            chooseReaders(choices[next]!.choice);
          }}
        >
          {choices.map((choice, index) => (
            <button
              type="button" role="radio" key={choice.key} class="reader-pill" data-testid={choice.testid} aria-checked={choice.checked}
              tabIndex={index === stop ? 0 : -1} disabled={locked} onClick={() => chooseReaders(choice.choice)}
            >{choice.label}</button>
          ))}
        </div>
        {state.projects.next && (
          <button type="button" class="reader-pill reader-more" data-testid="readers-more-projects" disabled={locked || state.projects.loading}
            onClick={() => void loadProjects(true)}>More projects</button>
        )}
      </div>
    </div>
  );
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
  // More projects is off while a page loads, and gone after the last: the
  // caret stays in the sheet, so ⌘↩ and Tab still work. Before paint, so no
  // key pressed right after is lost.
  useLayoutEffect(() => {
    if (document.activeElement === document.body) sheet.current?.focus();
  }, [state.projects.loading, state.projects.next]);

  const busy = compose.status === 'sending' || compose.status === 'checking';
  const unresolved = compose.status === 'unknown' || compose.status === 'checking';
  const locked = busy || unresolved;
  const empty = compose.text.trim() === '' && !compose.file;

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
        <WhoCanRead state={state} compose={compose} locked={locked} />
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
                {/* Saved when it is kept for yourself, sent when others get it. */}
                <span class="error" data-testid="compose-error">
                  {compose.status === 'checking' ? 'Checking…'
                    : compose.readers === 'only-me' ? 'This may not have been saved.' : 'This may not have been sent.'}
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
