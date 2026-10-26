import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { MAX_CAPTURE_PROJECTS, type ProjectSummary } from '../../shared/protocol.js';
import { bytes } from '../format.js';
import { message } from '../messages.js';
import {
  attachFile, checkCompose, choosePlace, choosingProjects, closeCompose, closeProjects, keepUnresolved, loadProjects, newCompose, onlyYou, openProjects,
  projectNames, removeFile, sendCompose, setComposeText, tickProject, toggleOnlyMe, type ComposeState, type State,
} from '../store.js';
import { useDropTarget } from './drop.js';
import { Caret, Check, Clip, Close, Lock } from './icons.js';
import { ProjectPicker } from './project-picker.js';

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
  // The sheet itself can hold focus (it opens that way): from there, Tab goes to the first control and Shift-Tab to the last.
  const inside = document.activeElement !== sheet && sheet.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
}

/** Who can read it, said before it is saved. Organization-wide cannot be narrowed later. */
function readersLine(compose: ComposeState): string {
  if (compose.place === 'team') return 'Everyone in your org can read this.';
  const [first, ...rest] = compose.projects;
  if (compose.place === 'projects' && !first) return 'Choose one or more projects.';
  if (onlyYou(compose) || !first) return 'Only you can read this.';
  return rest.length === 0 ? `${first.name} members can read this.` : `Members of ${projectNames(compose.projects)} can read this.`;
}

/**
 * Every project a capture can be filed in: the one Capture was opened for
 * first, then the sidebar's list. One ticked that the list no longer has stays.
 */
function projectChoices(compose: ComposeState, listed: readonly ProjectSummary[]): ProjectSummary[] {
  const choices: ProjectSummary[] = [];
  const seen = new Set<string>();
  const add = (project: ProjectSummary | null) => {
    if (project && !seen.has(project.project_id)) { seen.add(project.project_id); choices.push(project); }
  };
  add(compose.context);
  compose.projects.filter(ticked => !listed.some(project => project.project_id === ticked.project_id)).forEach(add);
  listed.filter(project => project.status === 'active').forEach(add);
  return choices;
}

/**
 * The projects keep the places they first showed in. The window coming
 * forward reads the sidebar's list again while Capture may be open: a project new to
 * it joins at the end, and one it no longer has keeps its place, so a click
 * never lands on a row that moved under it. The Authority still refuses a
 * save to a project that is no longer yours.
 */
function keepPlaces(placed: Map<string, ProjectSummary>, choices: readonly ProjectSummary[]): ProjectSummary[] {
  for (const project of choices) placed.set(project.project_id, project);
  return [...placed.values()];
}

/**
 * The place list, above the place button: one row per project to tick, then
 * No project and Organization. Past eight projects a field finds one, and
 * More projects reads the sidebar list's next page.
 */
function PlaceList({ state, compose, projects, anchor }: {
  state: State; compose: ComposeState; projects: readonly ProjectSummary[]; anchor: { current: HTMLButtonElement | null };
}) {
  const list = useRef<HTMLDivElement>(null);

  // It opens over the note, lined up with the place button and inside the window, with the caret in it.
  useLayoutEffect(() => {
    const element = list.current!;
    const button = anchor.current!;
    const room = (element.offsetParent as HTMLElement | null)?.clientWidth ?? element.offsetWidth;
    element.style.left = `${Math.max(0, Math.min(button.offsetLeft, room - element.offsetWidth))}px`;
    element.style.maxHeight = `${Math.max(160, Math.min(320, button.getBoundingClientRect().top - 16))}px`;
    element.querySelector<HTMLElement>('input, button')?.focus();
  }, []);
  // A click anywhere else closes it. The place button itself opens and closes
  // it, and No project or Organization close it as they are chosen.
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !anchor.current?.contains(target)) closeProjects();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, []);
  // More projects is off while a page loads, and gone after the last: the
  // caret stays in the list, so ⌘↩, Tab and Escape still work.
  useLayoutEffect(() => {
    if (document.activeElement === document.body) list.current?.focus();
  }, [state.projects.loading, state.projects.next]);

  return (
    <div
      class="project-list" id="projects-list" role="dialog" aria-label="Where it goes" data-testid="projects-list" ref={list} tabIndex={-1}
      // Tab out of it closes it, as a click elsewhere does.
      onFocusOut={event => {
        const next = event.relatedTarget as Node | null;
        if (next && !list.current?.contains(next) && !anchor.current?.contains(next)) closeProjects();
      }}
    >
      <ProjectPicker
        projects={projects} ticked={compose.projects.map(project => project.project_id)} max={MAX_CAPTURE_PROJECTS}
        onTick={id => { const project = projects.find(candidate => candidate.project_id === id); if (project) tickProject(project); }}
        more={state.projects.next !== null && !state.projects.loading} onMore={() => void loadProjects(true)}
      />
      {/* Either takes the place of every project: a choice of one, not a toggle. */}
      <div class="place-choices" role="radiogroup" aria-label="Not in a project">
        <button type="button" class="place-choice" data-testid="place-none" role="radio" aria-checked={compose.place === 'none'} onClick={() => choosePlace('none')}>
          No project{compose.place === 'none' && <Check />}
        </button>
        <button type="button" class="place-choice" data-testid="place-team" role="radio" aria-checked={compose.place === 'team'} onClick={() => choosePlace('team')}>
          Organization{compose.place === 'team' && <Check />}
        </button>
      </div>
      <div class="project-list-foot">
        <button type="button" class="plain-button small" data-testid="projects-done" onClick={closeProjects}>Done</button>
      </div>
    </div>
  );
}

/**
 * Where it goes, one row (ADR-0049): the place button, naming the projects
 * ticked ("THERM", "THERM +1"), No project or Organization, which opens the
 * place list; then the Only me lock. On a project choice the lock is off
 * until turned on; No project is always only you, so its lock shows on and
 * cannot be turned off; Organization is everyone, and has none.
 */
function Place({ state, compose, locked }: { state: State; compose: ComposeState; locked: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLSpanElement>(null);
  const [placed] = useState(() => new Map<string, ProjectSummary>());
  const projects = keepPlaces(placed, projectChoices(compose, state.projects.items));
  const [first, ...rest] = compose.projects;
  const open = compose.picking !== null;
  const label = compose.place === 'none' ? 'No project' : compose.place === 'team' ? 'Organization' : first ? first.name : 'Projects';

  // A name cut off, or several, are said in full in the tooltip.
  useLayoutEffect(() => {
    const cut = name.current !== null && name.current.scrollWidth - name.current.clientWidth > 1;
    if (cut || rest.length > 0) button.current!.title = compose.projects.map(project => project.name).join(', ');
    else button.current!.removeAttribute('title');
  });
  // The list closed with the caret in it (Done, Escape): the caret goes back to the place button.
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current && !open && document.activeElement === document.body) button.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // Both controls say who can read it, from the line under them. No project's lock stays a Tab stop that says so, though it
  // cannot be turned off. The list comes right after the place button, so Shift+Tab out of it goes back there.
  return (
    <div class="place-row" role="group" aria-label="Where it goes">
      <button type="button" class="place-button" data-testid="capture-place" ref={button} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? 'projects-list' : undefined} aria-describedby="capture-readers" disabled={locked} onClick={openProjects}>
        <span class="name" ref={name}>{label}</span>
        {rest.length > 0 && <span class="count"> +{rest.length}</span>}
        <Caret />
      </button>
      {open && <PlaceList state={state} compose={compose} projects={projects} anchor={button} />}
      {compose.place !== 'team' && (
        <button type="button" class="lock-toggle" data-testid="capture-lock" aria-pressed={onlyYou(compose)} aria-describedby="capture-readers"
          aria-disabled={compose.place === 'none' ? 'true' : undefined} disabled={locked} onClick={toggleOnlyMe}>
          <Lock />Only me
        </button>
      )}
    </div>
  );
}

/** Capture: a note or one file, where it goes and who can read it, then Save. A note's first line is its title. */
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
        {/* A new capture places its projects afresh, its own first. */}
        <Place key={compose.seq} state={state} compose={compose} locked={locked} />
        <div class={`readers-line${compose.place === 'team' ? ' warning' : ''}`} id="capture-readers" data-testid="compose-readers" aria-live="polite">
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
                    : onlyYou(compose) ? 'This may not have been saved.' : 'This may not have been sent.'}
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
            <button type="button" class="primary-button small" data-testid="compose-send" disabled={locked || empty || choosingProjects(compose)}
              onClick={() => void sendCompose()}>
              Save <span class="hint">{SAVE_HINT}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
