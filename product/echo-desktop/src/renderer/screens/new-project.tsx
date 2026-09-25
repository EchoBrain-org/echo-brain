import { useEffect, useRef, useState } from 'preact/hooks';
import { message } from '../messages.js';
import {
  askSkip, canDropFiles, cancelSkip, checkFile, chooseFiles, closeSheet, confirmSkip, createProject, dropFiles, EXTRACTION, keepNewProject,
  MAX_PROJECT_FILES, newProjectBusy, newProjectUnsettled, pickable, pickPerson, projectName, removeRow, retryFile, retryPick, searchPeople,
  setNewProjectName, setPickQuery, unsent, type FindingSheet, type NewProjectSheet, type ProjectFile, type ProjectPick, type State,
} from '../store.js';
import { trapTab } from './compose.js';
import { Close, Doc, Saved, Warning } from './icons.js';
import { Confirm, Face, Finder } from './people.js';

/** Where one file stands, in the app's own words. Before the project exists a file is only listed. */
function fileLabel(file: ProjectFile, halted: boolean, queued: boolean): string {
  switch (file.status) {
    case 'waiting': return !queued ? '' : halted ? 'Not started' : 'Waiting';
    case 'saving': return 'Preparing private copy…';
    case 'checking': return 'Checking…';
    case 'saved': return file.extraction ? `Saved · ${EXTRACTION[file.extraction]}` : 'Saved';
    case 'unknown': return 'This may not have been sent.';
    case 'skipped': return 'Skipped. It may have been saved.';
    case 'failed': return file.failure ? message(file.failure) : 'It was not saved.';
  }
}

/** Where one person picked stands. Before the project exists they are only listed. */
function pickLabel(pick: ProjectPick, halted: boolean, queued: boolean): string {
  switch (pick.status) {
    case 'waiting': return !queued ? '' : halted ? 'Not started' : 'Waiting';
    case 'adding': return 'Adding…';
    case 'added': return 'Added';
    case 'unknown': return 'This may not have been sent.';
    case 'skipped': return 'Skipped. They may have been added.';
    case 'failed': return pick.failure ? message(pick.failure) : 'They were not added.';
  }
}

/** ×: only for a row nothing was sent for. */
function Remove({ name, testId, id }: { name: string; testId: string; id: number }) {
  return (
    <button type="button" class="icon-button" aria-label={`Remove ${name}`} data-testid={testId} onClick={() => removeRow(id)}><Close /></button>
  );
}

function FileRow({ file, halted, queued, busy }: { file: ProjectFile; halted: boolean; queued: boolean; busy: boolean }) {
  const trouble = file.status === 'unknown' || file.status === 'failed' || file.status === 'skipped';
  const label = fileLabel(file, halted, queued);
  return (
    <div class="file-row" data-testid="new-project-file" data-status={file.status}>
      {file.status === 'saved' ? <Saved /> : trouble ? <Warning /> : <Doc />}
      <span class="label">{label ? `${file.name} · ${label}` : file.name}</span>
      {unsent(file) && <Remove name={file.name} testId="file-remove" id={file.id} />}
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

/**
 * A person picked. An add whose outcome is unknown is resent as it was (Try
 * again), as People does; there is no status to check for a project change.
 */
function PickRow({ pick, halted, queued, busy }: { pick: ProjectPick; halted: boolean; queued: boolean; busy: boolean }) {
  const trouble = pick.status === 'unknown' || pick.status === 'failed' || pick.status === 'skipped';
  const label = pickLabel(pick, halted, queued);
  return (
    <div class="person pick" data-testid="pick-row" data-status={pick.status}>
      <Face person={pick.person} />
      <span class="name">{pick.person.display_name}</span>
      {label && <span class={`standing${trouble ? ' error' : ''}`}>{label}</span>}
      {pick.status === 'waiting' && <Remove name={pick.person.display_name} testId="pick-remove" id={pick.id} />}
      {pick.status === 'unknown' && (
        <>
          <button type="button" class="pill" data-testid="pick-retry" disabled={busy} onClick={() => retryPick(pick.id)}>Try again</button>
          <button type="button" class="pill" data-testid="pick-skip" disabled={busy} onClick={() => askSkip(pick.id)}>Skip…</button>
        </>
      )}
    </div>
  );
}

/**
 * People, from the organization's directory: you, as the project's lead, the
 * people picked, and the people found by name to pick. Picking sends nothing
 * until the project exists.
 */
function Picker({ state, sheet, field, queued, halted, busy }: {
  state: State; sheet: NewProjectSheet; field: { current: HTMLInputElement | null }; queued: boolean; halted: boolean; busy: boolean;
}) {
  const me = state.status?.account;
  const found = pickable(state);
  const directory = sheet.directory;
  return (
    <>
      <input
        ref={field} class="field small" data-testid="people-find" type="text" autocomplete="off" maxLength={240}
        placeholder="Add someone by name" aria-label="Add someone by name" value={sheet.query}
        onInput={event => setPickQuery((event.target as HTMLInputElement).value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void searchPeople(); } }}
      />
      <div class="people-list" aria-busy={directory?.loading ?? false}>
        {me && (
          <div class="person" data-testid="member-row">
            <Face person={me} />
            <span class="name">{me.display_name}</span>
            <span class="tag">Lead</span>
          </div>
        )}
        {sheet.picks.map(pick => <PickRow key={pick.id} pick={pick} halted={halted} queued={queued} busy={busy} />)}
        {found.map(person => (
          <div class="person" data-testid="candidate-row" key={person.membership_id}>
            <Face person={person} />
            <span class="name">{person.display_name}</span>
            <button type="button" class="pill" aria-label={`Add ${person.display_name}`} data-testid="candidate-add"
              onClick={() => pickPerson(person)}>Add</button>
          </div>
        ))}
        {directory?.failure && <div class="error">{message(directory.failure)}</div>}
        {directory && !directory.loading && !directory.failure && found.length === 0 && sheet.query.trim() !== '' && (
          <div class="notice" data-testid="people-none">No one else by that name</div>
        )}
        {directory?.next && (
          <button type="button" class="pill center" data-testid="people-more" disabled={directory.loading}
            onClick={() => void searchPeople(true)}>More people</button>
        )}
      </div>
    </>
  );
}

/** Skip…: the person may have been added, or the file saved, so it is asked first. Keep has the focus. */
function SkipConfirm({ sheet }: { sheet: NewProjectSheet }) {
  const keep = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { keep.current?.focus(); }, []);
  const pick = sheet.picks.find(entry => entry.id === sheet.skip);
  return (
    <div class="overlay" onClick={event => { event.stopPropagation(); cancelSkip(); }}>
      <div class="sheet confirm" role="alertdialog" aria-labelledby="skip-title" data-testid="skip-confirm" ref={box}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <h2 id="skip-title">{pick ? `Skip ${pick.person.display_name}?` : 'Skip this file?'}</h2>
        <p>{pick ? 'They may have been added. Try again first to find out.' : 'It may have been saved. Check its status first to avoid a duplicate.'}</p>
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

/** What the close question says may have arrived, once the project exists. */
function mayHave(sheet: NewProjectSheet): string {
  const person = sheet.picks.some(pick => pick.status === 'unknown');
  const file = sheet.files.some(entry => entry.status === 'unknown');
  return person && file ? 'Someone may still have been added, and a file saved.' : person ? 'Someone may still have been added.'
    : 'A file may still have been saved.';
}

/** What the foot of the sheet offers: before the project exists, Create and its recovery; after, Done. */
function Foot({ sheet }: { sheet: NewProjectSheet }) {
  const busy = newProjectBusy(sheet);
  const { create } = sheet;
  const asking = sheet.confirmClose && newProjectUnsettled(sheet);
  if (sheet.project) {
    if (asking) return <CloseQuestion what={mayHave(sheet)} />;
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
 * New project, one page: a name, then People and Files, both optional and
 * usable from the start. Nothing is sent before Create. Create makes the
 * project; then, with a status on each row, each person is added and each
 * file saved, one at a time, and the project opens behind the sheet. Done
 * closes it. Without the organization's directory, people are added after
 * Create from the project's own, as People does. While another app is in
 * front its people are hidden; files still drop.
 */
export function NewProject({ state, sheet }: { state: State; sheet: NewProjectSheet }) {
  const box = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const made = sheet.project;
  // The name first; once the project exists, the project's directory where it is used, or else the sheet.
  useEffect(() => { (made ? (sheet.peopleLater ? find.current : null) ?? box.current : name.current)?.focus(); }, [made?.project_id]);
  const busy = newProjectBusy(sheet);
  const locked = sheet.createdId !== null || sheet.create.status === 'sending' || sheet.create.status === 'unknown';
  const queued = made !== null;
  const heldByPerson = sheet.picks.some(pick => pick.status === 'unknown');
  const halted = heldByPerson || sheet.files.some(file => file.status === 'unknown' || file.status === 'checking');
  const finder = made && sheet.peopleLater ? sheet as FindingSheet : null;
  return (
    <div class="overlay top">
      <div
        class={`sheet people new-project${over ? ' drop-target' : ''}`} role="dialog" aria-label="New project" data-testid="new-project" ref={box}
        tabIndex={-1} onKeyDown={event => trapTab(event, box.current)}
        onDragOver={event => {
          if (!canDropFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
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
              placeholder="Name" aria-label="Project name" value={sheet.name} readOnly={locked}
              onInput={event => setNewProjectName((event.target as HTMLInputElement).value)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createProject(); } }}
            />
          )}
          <button type="button" class="circle small" aria-label="Close" data-testid="new-project-close" disabled={busy} onClick={closeSheet}><Close /></button>
        </div>
        {!state.concealed && (
          <>
            <div class="section-label">People · optional</div>
            {finder ? <Finder state={state} sheet={finder} menus={false} field={find} />
              : sheet.peopleLater ? <div class="notice-line" data-testid="people-later">Add people after Create</div>
              : <Picker state={state} sheet={sheet} field={find} queued={queued} halted={heldByPerson} busy={busy} />}
            {sheet.peopleLater && sheet.picks.length > 0 && (
              <div class="people-list">
                {sheet.picks.map(pick => <PickRow key={pick.id} pick={pick} halted={heldByPerson} queued={queued} busy={busy} />)}
              </div>
            )}
          </>
        )}
        <div class="section-label">Files · optional</div>
        <div class="files-well" data-testid="new-project-files">
          {sheet.files.length > 0 && (
            <div class="file-list">
              {sheet.files.map(file => <FileRow key={file.id} file={file} halted={halted} queued={queued} busy={busy} />)}
            </div>
          )}
          <button type="button" class="pill" data-testid="new-project-add-files" disabled={sheet.files.length >= MAX_PROJECT_FILES}
            onClick={() => void chooseFiles()}>Add files…</button>
        </div>
        {sheet.notice && <div class="notice-line" data-testid="new-project-notice" aria-live="polite">{sheet.notice}</div>}
        <Foot sheet={sheet} />
      </div>
      {sheet.confirm && finder && <Confirm sheet={finder} />}
      {sheet.skip !== null && <SkipConfirm sheet={sheet} />}
    </div>
  );
}
