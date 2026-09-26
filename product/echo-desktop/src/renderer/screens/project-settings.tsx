import { useEffect, useRef } from 'preact/hooks';
import { message } from '../messages.js';
import {
  askProjectSetting, beginProjectRename, cancelProjectSettingsAction, closeProjectSettings, confirmProjectSetting, dismissProjectSetting,
  keepProjectSetting, projectRenameValid, retryProjectSetting, setProjectRename, toggleProjectSettings, type State,
} from '../store.js';
import { trapTab } from './compose.js';
import { Ellipsis } from './icons.js';

/** Project actions live beside People, rather than in a separate settings page. */
export function ProjectSettingsButton({ state }: { state: State }) {
  const route = state.route;
  if (route.page !== 'project' || state.concealed || state.ask || state.reader) return null;
  const settings = state.projectSettings?.project.project_id === route.project.project_id ? state.projectSettings : null;
  const busy = settings?.write?.status === 'sending' || settings?.write?.status === 'unknown';
  return (
    <div class="project-settings">
      <button type="button" class="icon-button" data-testid="project-settings" aria-label="Project settings" aria-haspopup="menu"
        aria-expanded={settings?.menu ?? false} disabled={busy} onClick={toggleProjectSettings}><Ellipsis /></button>
      {settings?.menu && (
        <div class="menu" role="menu" data-testid="project-settings-menu">
          {settings.project.role === 'lead' && <button type="button" role="menuitem" class="menu-item" data-testid="project-rename" onClick={beginProjectRename}>Rename project</button>}
          {settings.project.role === 'lead' && <button type="button" role="menuitem" class="menu-item" data-testid="project-archive"
            onClick={() => askProjectSetting(settings.project.status === 'archived' ? 'unarchive' : 'archive')}>
            {settings.project.status === 'archived' ? 'Restore project' : 'Archive project'}
          </button>}
          <div class="menu-rule" />
          <button type="button" role="menuitem" class="menu-item danger" data-testid="project-leave" onClick={() => askProjectSetting('leave')}>Leave project</button>
        </div>
      )}
    </div>
  );
}

function Rename({ state }: { state: State }) {
  const settings = state.projectSettings!;
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const valid = projectRenameValid(settings.rename!, settings.project.name);
  useEffect(() => { field.current?.focus(); }, []);
  return (
    <div class="overlay" onClick={cancelProjectSettingsAction}>
      <div class="sheet confirm project-setting-sheet" role="dialog" aria-labelledby="rename-project-title" ref={box}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <h2 id="rename-project-title">Rename project</h2>
        <input ref={field} class="field" data-testid="project-rename-input" aria-label="Project name" maxLength={200} value={settings.rename!}
          onInput={event => setProjectRename((event.target as HTMLInputElement).value)}
          onKeyDown={event => { if (event.key === 'Enter' && valid) { event.preventDefault(); confirmProjectSetting(); } }} />
        <div class="choices">
          <button type="button" class="plain-button" onClick={cancelProjectSettingsAction}>Cancel</button>
          <button type="button" class="plain-button" data-testid="project-rename-save" disabled={!valid} onClick={confirmProjectSetting}>Save</button>
        </div>
      </div>
    </div>
  );
}

function Confirm({ state }: { state: State }) {
  const settings = state.projectSettings!;
  const action = settings.confirm!;
  const cancel = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  const leave = action === 'leave';
  const archive = action === 'archive';
  const title = leave ? `Leave ${settings.project.name}?` : archive ? `Archive ${settings.project.name}?` : `Restore ${settings.project.name}?`;
  const detail = leave ? 'You will lose access through this project. If you are its last lead, promote another lead first.'
    : archive ? 'People can still read and Ask this project. Restore it to add files or notes.' : 'People can add files and notes again.';
  return (
    <div class="overlay" onClick={cancelProjectSettingsAction}>
      <div class="sheet confirm" role="alertdialog" aria-labelledby="project-settings-confirm-title" ref={box}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <h2 id="project-settings-confirm-title">{title}</h2>
        <p>{detail}</p>
        <div class="choices">
          <button type="button" class="plain-button" ref={cancel} onClick={cancelProjectSettingsAction}>Cancel</button>
          <button type="button" class={`plain-button${leave ? ' danger' : ''}`} data-testid="project-settings-confirm" onClick={confirmProjectSetting}>
            {leave ? 'Leave project' : archive ? 'Archive project' : 'Restore project'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A refusal and an unknown outcome stay visible, and an unknown retry reuses the request id. */
function Write({ state }: { state: State }) {
  const settings = state.projectSettings!;
  const write = settings.write!;
  const box = useRef<HTMLDivElement>(null);
  const conflict = write.operation === 'leave' && write.failure?.code === 'conflict';
  const text = write.status === 'sending' ? 'Saving project settings…' : write.status === 'unknown' && write.dismissConfirm ? 'Dismiss it? It may still have been made.'
    : write.status === 'unknown' ? 'This may not have been sent.'
    : conflict ? 'Promote another lead before leaving this project.' : message(write.failure!);
  return (
    <div class="overlay">
      <div class="sheet confirm" role="alertdialog" aria-live="polite" ref={box} onKeyDown={event => trapTab(event, box.current)}>
        <h2>{write.status === 'sending' ? 'Saving' : 'Project settings'}</h2>
        <p class={write.status === 'sending' ? '' : 'error'} data-testid="project-settings-error">{text}</p>
        {write.status !== 'sending' && <div class="choices">
          {write.status === 'unknown' && !write.dismissConfirm && <button type="button" class="plain-button" data-testid="project-settings-retry" onClick={retryProjectSetting}>Try again</button>}
          <button type="button" class="plain-button" data-testid="project-settings-dismiss" onClick={dismissProjectSetting}>Dismiss</button>
          {write.dismissConfirm && <button type="button" class="plain-button" onClick={keepProjectSetting}>Keep it</button>}
        </div>}
      </div>
    </div>
  );
}

export function ProjectSettings({ state }: { state: State }) {
  const settings = state.projectSettings;
  if (!settings) return null;
  if (settings.write) return <Write state={state} />;
  if (settings.rename !== null) return <Rename state={state} />;
  if (settings.confirm) return <Confirm state={state} />;
  return null;
}
