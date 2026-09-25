import { useEffect, useRef, useState } from 'preact/hooks';
import { message } from '../messages.js';
import {
  askSkip, canDropFiles, cancelSkip, checkFile, chooseFiles, closeSheet, confirmSkip, createProject, dropFiles, EXTRACTION, keepNewProject,
  MAX_PROJECT_FILES, newProjectBusy, newProjectUnsettled, projectName, retryFile, setNewProjectName, type FindingSheet, type NewProjectSheet, type ProjectFile, type State,
} from '../store.js';
import { trapTab } from './compose.js';
import { Close, Doc, Saved, Warning } from './icons.js';
import { Confirm, Finder } from './people.js';

/** Where one file stands, in the app's own words. */
function fileLabel(file: ProjectFile, halted: boolean): string {
  switch (file.status) {
    case 'waiting': return halted ? 'Not started' : 'Waiting';
    case 'saving': return 'Preparing private copy…';
    case 'checking': return 'Checking…';
    case 'saved': return file.extraction ? `Saved · ${EXTRACTION[file.extraction]}` : 'Saved';
    case 'unknown': return 'This may not have been sent.';
    case 'skipped': return 'Skipped. It may have been saved.';
    case 'failed': return file.failure ? message(file.failure) : 'It was not saved.';
  }
}

function FileRow({ file, halted, busy }: { file: ProjectFile; halted: boolean; busy: boolean }) {
  const trouble = file.status === 'unknown' || file.status === 'failed' || file.status === 'skipped';
  return (
    <div class="file-row" data-testid="new-project-file" data-status={file.status}>
      {file.status === 'saved' ? <Saved /> : trouble ? <Warning /> : <Doc />}
      <span class="label">{file.name} · {fileLabel(file, halted)}</span>
      {file.status === 'unknown' && (
        <>
          <button type="button" class="pill" data-testid="file-check" disabled={busy} onClick={() => void checkFile(file.id)}>Check status</button>
          <button type="button" class="pill" data-testid="file-retry" disabled={busy} onClick={() => retryFile(file.id)}>Try again</button>
          <button type="button" class="pill" data-testid="file-skip" disabled={busy} onClick={() => askSkip(file.id)}>Skip…</button>
        </>
      )}
      {file.status === 'failed' && file.kept && (
        <button type="button" class="pill" data-testid="file-retry" disabled={busy} onClick={() => retryFile(file.id)}>Try again</button>
      )}
    </div>
  );
}

/** Skip…: the file may have been saved, so it is asked first. Keep has the focus. */
function SkipConfirm() {
  const keep = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { keep.current?.focus(); }, []);
  return (
    <div class="overlay" onClick={event => { event.stopPropagation(); cancelSkip(); }}>
      <div class="sheet confirm" role="alertdialog" aria-labelledby="skip-title" data-testid="skip-confirm" ref={box}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <h2 id="skip-title">Skip this file?</h2>
        <p>It may have been saved. Check its status first to avoid a duplicate.</p>
        <div class="choices">
          <button type="button" class="plain-button" ref={keep} onClick={cancelSkip}>Keep</button>
          <button type="button" class="plain-button danger" data-testid="skip-confirm-go" onClick={confirmSkip}>Skip</button>
        </div>
      </div>
    </div>
  );
}

/** Close, asked first: what may have arrived would no longer be checked or tried again. */
function CloseQuestion({ what }: { what: string }) {
  return (
    <div class="new-project-foot" aria-live="polite">
      <span class="error">Close? {what}</span>
      <button type="button" class="plain-button" data-testid="new-project-close-anyway" onClick={closeSheet}>Close</button>
      <button type="button" class="plain-button" onClick={keepNewProject}>Keep it</button>
    </div>
  );
}

/** What the foot of the sheet offers: before the project exists, Create and its recovery; after, Done. */
function Foot({ sheet }: { sheet: NewProjectSheet }) {
  const busy = newProjectBusy(sheet);
  const { create } = sheet;
  const asking = sheet.confirmClose && newProjectUnsettled(sheet);
  if (sheet.project) {
    if (asking) return <CloseQuestion what="A file may still have been saved." />;
    // Done sits where Create was: the second click of a double-click on Create does not close the sheet.
    return (
      <div class="choices">
        <button type="button" class="primary-button small" data-testid="new-project-done" disabled={busy}
          onClick={event => { if (event.detail <= 1) closeSheet(); }}>Done</button>
      </div>
    );
  }
  if (sheet.createdId) {
    // Made, but not read: never offer a second Create.
    return (
      <div class="new-project-foot" aria-live="polite">
        {sheet.opening ? <span class="notice">Opening</span> : (
          <span class="error" data-testid="new-project-error">
            Created, but it did not open.{sheet.openFailure ? ` ${message(sheet.openFailure)}` : ''}
          </span>
        )}
        <button type="button" class="plain-button" disabled={busy} onClick={closeSheet}>Close</button>
        <button type="button" class="primary-button small" data-testid="new-project-open" disabled={busy} onClick={() => void createProject()}>Open</button>
      </div>
    );
  }
  if (asking) return <CloseQuestion what="The project may still have been made." />;
  if (create.status === 'unknown') {
    return (
      <div class="new-project-foot" aria-live="polite">
        <span class="error" data-testid="new-project-error">This may not have been sent.</span>
        <button type="button" class="plain-button" onClick={closeSheet}>Cancel</button>
        <button type="button" class="primary-button small" data-testid="new-project-retry" onClick={() => void createProject()}>Try again</button>
      </div>
    );
  }
  return (
    <div class="new-project-foot" aria-live="polite">
      {create.status === 'sending' && <span class="notice">Saving</span>}
      {create.status === 'failed' && create.failure && <span class="error" data-testid="new-project-error">{message(create.failure)}</span>}
      <button type="button" class="plain-button" data-testid="new-project-cancel" disabled={busy} onClick={closeSheet}>Cancel</button>
      <button type="button" class="primary-button small" data-testid="new-project-create" disabled={busy || projectName(sheet.name) === null}
        onClick={() => void createProject()}>Create</button>
    </div>
  );
}

/**
 * New project, one page: a name, then Create, which opens the project behind
 * the sheet. People and Files show from the start and turn on once the
 * project exists: people are added at once, with Undo, and files, which are
 * optional, start saving as they are added or dropped on the sheet, up to 20.
 * While another app is in front its people are hidden; files still drop.
 */
export function NewProject({ state, sheet }: { state: State; sheet: NewProjectSheet }) {
  const box = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const made = sheet.project;
  useEffect(() => { (made ? find.current ?? box.current : name.current)?.focus(); }, [made?.project_id]);
  const busy = newProjectBusy(sheet);
  const locked = sheet.createdId !== null || sheet.create.status === 'sending' || sheet.create.status === 'unknown';
  const halted = sheet.files.some(file => file.status === 'unknown' || file.status === 'checking');
  // Why People and Files are off, read out with the name field and with each of them.
  const first = !made && !sheet.createdId;
  const why = first ? 'new-project-first' : undefined;
  return (
    <div class="overlay top">
      <div
        class={`sheet people new-project${over ? ' drop-target' : ''}`} role="dialog" aria-label="New project" data-testid="new-project" ref={box}
        tabIndex={-1} onKeyDown={event => trapTab(event, box.current)}
        onDragOver={event => {
          if (!canDropFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          // Before Create a drop is taken only to say so: the sheet does not light up.
          if (!made) return;
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }}
        onDragLeave={event => { if (!(event.currentTarget as Node).contains(event.relatedTarget as Node | null)) setOver(false); }}
        onDrop={event => {
          setOver(false);
          const files = event.dataTransfer?.files;
          if (!files || files.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          void dropFiles([...files]);
        }}
      >
        <div class="sheet-head">
          {made ? <h2 class="project-name" data-testid="new-project-title">{made.name}</h2> : (
            <input
              ref={name} class="field name-field" data-testid="new-project-name" type="text" autocomplete="off" maxLength={200}
              placeholder="Name" aria-label="Project name" aria-describedby={why} value={sheet.name} readOnly={locked}
              onInput={event => setNewProjectName((event.target as HTMLInputElement).value)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createProject(); } }}
            />
          )}
          <button type="button" class="circle small" aria-label="Close" data-testid="new-project-close" disabled={busy} onClick={closeSheet}><Close /></button>
        </div>
        {first && (
          <div class="notice-line" id="new-project-first" data-testid="new-project-first">Create the project first to add people and files.</div>
        )}
        {!state.concealed && (
          <>
            <div class="section-label">People</div>
            {made ? <Finder state={state} sheet={sheet as FindingSheet} menus={false} field={find} /> : (
              <input class="field small" data-testid="people-find" type="text" disabled placeholder="Add someone by name" aria-label="Add someone by name"
                aria-describedby={why} />
            )}
          </>
        )}
        <div class="section-label">Files · optional</div>
        <div class="files-well" data-testid="new-project-files">
          {sheet.files.length > 0 && (
            <div class="file-list">
              {sheet.files.map(file => <FileRow key={file.id} file={file} halted={halted} busy={busy} />)}
            </div>
          )}
          <button type="button" class="pill" data-testid="new-project-add-files" disabled={!made || sheet.files.length >= MAX_PROJECT_FILES}
            aria-describedby={why} onClick={() => void chooseFiles()}>Add files…</button>
        </div>
        {sheet.notice && <div class="notice-line" data-testid="new-project-notice" aria-live="polite">{sheet.notice}</div>}
        <Foot sheet={sheet} />
      </div>
      {sheet.confirm && made && <Confirm sheet={sheet as FindingSheet} />}
      {sheet.skip !== null && <SkipConfirm />}
    </div>
  );
}
