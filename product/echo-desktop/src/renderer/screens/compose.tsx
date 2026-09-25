import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { MAX_CAPTURE_PROJECTS, type ProjectSummary } from '../../shared/protocol.js';
import { bytes } from '../format.js';
import { message } from '../messages.js';
import {
  attachFile, checkCompose, chooseReaders, choosingProjects, closeCompose, closeProjects, keepUnresolved, loadProjects, newCompose, openProjects,
  projectNames, removeFile, sendCompose, setComposeText, tickProject, type ComposeState, type Readers, type State,
} from '../store.js';
import { useDropTarget } from './drop.js';
import { Caret, Clip, Close } from './icons.js';

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
  if (compose.readers === 'only-me') return 'Only you can read this.';
  const [first, ...rest] = compose.projects;
  if (!first) return 'Choose one or more projects.';
  return rest.length === 0 ? `${first.name} members can read this.` : `Members of ${projectNames(compose.projects)} can read this.`;
}

/** Past this many projects, a field finds one by name. */
const FIND_AFTER = 8;
/** Who can read, in order. */
const CHOICES: readonly Readers[] = ['only-me', 'projects', 'team'];
/** Arrow keys move through Who can read, and pick as they go. */
const STEPS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Every project a capture can be filed in: the one Capture was opened for
 * first, then Home's list. One ticked that the list no longer has stays.
 */
function projectChoices(compose: ComposeState, listed: readonly ProjectSummary[]): ProjectSummary[] {
  const choices: ProjectSummary[] = [];
  const seen = new Set<string>();
  const add = (project: ProjectSummary | null) => {
    if (project && !seen.has(project.project_id)) { seen.add(project.project_id); choices.push(project); }
  };
  add(compose.context);
  compose.projects.filter(ticked => !listed.some(project => project.project_id === ticked.project_id)).forEach(add);
  listed.forEach(add);
  return choices;
}

/**
 * The projects keep the places they first showed in. The window coming
 * forward reads Home's list again while Capture may be open: a project new to
 * it joins at the end, and one it no longer has keeps its place, so a click
 * never lands on a row that moved under it. The Authority still refuses a
 * save to a project that is no longer yours.
 */
function keepPlaces(placed: Map<string, ProjectSummary>, choices: readonly ProjectSummary[]): ProjectSummary[] {
  for (const project of choices) placed.set(project.project_id, project);
  return [...placed.values()];
}

/**
 * The Projects list, above Projects: one row per project to tick. Past eight
 * a field finds one, and More projects reads Home's next page.
 */
function ProjectList({ state, compose, projects, anchor }: {
  state: State; compose: ComposeState; projects: readonly ProjectSummary[]; anchor: { current: HTMLButtonElement | null };
}) {
  const list = useRef<HTMLDivElement>(null);
  const [find, setFind] = useState('');
  const finding = projects.length > FIND_AFTER;
  const query = finding ? find.trim().toLocaleLowerCase() : '';
  const shown = query ? projects.filter(project => project.name.toLocaleLowerCase().includes(query)) : projects;
  const ticked = new Set(compose.projects.map(project => project.project_id));
  const full = ticked.size >= MAX_CAPTURE_PROJECTS;

  // It opens over the note, lined up with Projects and inside the window, with the caret in it.
  useLayoutEffect(() => {
    const element = list.current!;
    const button = anchor.current!;
    const room = (element.offsetParent as HTMLElement | null)?.clientWidth ?? element.offsetWidth;
    element.style.left = `${Math.max(0, Math.min(button.offsetLeft, room - element.offsetWidth))}px`;
    element.style.maxHeight = `${Math.max(160, Math.min(320, button.getBoundingClientRect().top - 16))}px`;
    element.querySelector<HTMLElement>('input')?.focus();
  }, []);
  // A click anywhere else closes it. Projects itself opens and closes it, and
  // Only me or Organization close it as they are chosen, keeping what is unticked.
  const choices = () => anchor.current?.closest('[role="radiogroup"]') ?? null;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !choices()?.contains(target)) closeProjects();
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
      class="project-list" id="projects-list" role="dialog" aria-label="Projects" data-testid="projects-list" ref={list} tabIndex={-1}
      // Tab out of it closes it, as a click elsewhere does.
      onFocusOut={event => {
        const next = event.relatedTarget as Node | null;
        if (next && !list.current?.contains(next) && !choices()?.contains(next)) closeProjects();
      }}
    >
      {finding && (
        <input
          type="text" class="field find" data-testid="projects-find" placeholder="Find a project" aria-label="Find a project" spellcheck={false}
          value={find} onInput={event => setFind((event.target as HTMLInputElement).value)}
          onKeyDown={event => {
            // ⌘↩ still saves: only a plain Enter is the field's, and it ticks the first match.
            if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
            event.preventDefault();
            const match = shown[0];
            if (query && match && !ticked.has(match.project_id)) tickProject(match);
          }}
        />
      )}
      <div class="project-ticks">
        {shown.map(project => {
          const on = ticked.has(project.project_id);
          return (
            <label class="project-tick" key={project.project_id} data-testid="projects-row">
              <input type="checkbox" checked={on} disabled={!on && full} onChange={() => tickProject(project)} />
              <span>{project.name}</span>
            </label>
          );
        })}
        {shown.length === 0 && <div class="project-note" data-testid="projects-none">{query ? 'No project matches.' : 'No projects yet.'}</div>}
        {state.projects.next && (
          <button type="button" class="link-button" data-testid="projects-more" disabled={state.projects.loading}
            onClick={() => void loadProjects(true)}>More projects</button>
        )}
      </div>
      <div class="project-list-foot">
        {/* Always there, so ticking the last one a screen reader hears says why the rest are off. */}
        <div aria-live="polite">{full && <span class="project-note" data-testid="projects-limit">Up to {MAX_CAPTURE_PROJECTS} projects.</span>}</div>
        <button type="button" class="plain-button small" data-testid="projects-done" onClick={closeProjects}>Done</button>
      </div>
    </div>
  );
}

/**
 * Who can read: Only me, Projects or Organization, one row. Projects holds
 * the projects ticked in its list, and says which.
 */
function WhoCanRead({ state, compose, locked }: { state: State; compose: ComposeState; locked: boolean }) {
  const group = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLSpanElement>(null);
  const [placed] = useState(() => new Map<string, ProjectSummary>());
  const projects = keepPlaces(placed, projectChoices(compose, state.projects.items));
  const [first, ...rest] = compose.projects;
  const open = compose.picking !== null;

  // A name cut off, or several, are said in full in the tooltip.
  useLayoutEffect(() => {
    const cut = name.current !== null && name.current.scrollWidth - name.current.clientWidth > 1;
    if (cut || rest.length > 0) button.current!.title = compose.projects.map(project => project.name).join(', ');
    else button.current!.removeAttribute('title');
  });
  // The list closed with the caret in it (Done, Escape): the caret goes back to Projects.
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current && !open && document.activeElement === document.body) button.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // One Tab stop: the chosen one.
  const radio = (readers: Readers) => ({
    type: 'button' as const, role: 'radio' as const, 'aria-checked': compose.readers === readers,
    tabIndex: compose.readers === readers ? 0 : -1, disabled: locked,
  });
  return (
    <div class="readers">
      <span class="label" id="readers-label">Who can read</span>
      <div class="readers-row">
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
            // Projects with none ticked is chosen with nothing to save: Enter or Space opens its list.
            chooseReaders(CHOICES[next]!);
          }}
        >
          <button {...radio('only-me')} class="reader-pill" data-testid="readers-only-me" onClick={() => chooseReaders('only-me')}>Only me</button>
          <button {...radio('projects')} class="reader-pill projects" data-testid="readers-projects" ref={button}
            aria-controls={open ? 'projects-list' : undefined} onClick={openProjects}>
            <span class="name" ref={name}>{first ? first.name : 'Projects'}</span>
            {rest.length > 0 && <span class="count"> +{rest.length}</span>}
            <Caret />
          </button>
          <button {...radio('team')} class="reader-pill" data-testid="readers-team" onClick={() => chooseReaders('team')}>Organization</button>
        </div>
        {open && <ProjectList state={state} compose={compose} projects={projects} anchor={button} />}
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
        <WhoCanRead key={compose.seq} state={state} compose={compose} locked={locked} />
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
