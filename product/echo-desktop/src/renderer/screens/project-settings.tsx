import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ProjectSummary } from '../../shared/protocol.js';
import { message } from '../messages.js';
import {
  beginProjectJira, setProjectJira, saveProjectJira, projectJiraValid, beginProjectConfluence, toggleProjectConfluenceSpace, moreProjectConfluenceSpaces, saveProjectConfluence,
  askProjectSetting, beginProjectRename, cancelProjectSettingsAction, closeProjectSettings, confirmProjectSetting, dismissProjectSetting,
  keepProjectSetting, projectRenameValid, projectSettingsBlocked, retryProjectSetting, setProjectRename, toggleProjectSettings, type State, type ProjectSettingsState, type ProjectToolSetting,
} from '../store.js';
import { trapTab } from './compose.js';
import { Ellipsis } from './icons.js';

/** Both entry points share one target and the same project actions. */
export function ProjectSettingsButton({ state, project }: { state: State; project?: ProjectSummary }) {
  const opener = useRef<HTMLButtonElement>(null);
  const route = state.route;
  const target = project ?? (route.page === 'project' ? route.project : null);
  const origin = project ? 'sidebar' : 'header';
  if (!target || state.concealed || (!project && (state.ask || state.reader))) return null;
  const settings = state.projectSettings?.project.project_id === target.project_id && state.projectSettings.menuOrigin === origin ? state.projectSettings : null;
  const busy = projectSettingsBlocked(state);
  return (
    <div class="project-settings">
      <button ref={opener} type="button" class="icon-button" data-testid={project ? 'sidebar-project-more' : 'project-settings'}
        aria-label={project ? `Actions for ${target.name}` : 'Project settings'} aria-haspopup="menu"
        aria-expanded={settings?.menu ?? false} disabled={busy} onClick={() => toggleProjectSettings(target, origin)}><Ellipsis /></button>
      {settings?.menu && opener.current && <ProjectMenu settings={settings} anchor={opener.current} />}
    </div>
  );
}

/** Render outside the scrolling sidebar and keep the complete menu inside the window. */
function ProjectMenu({ settings, anchor }: { settings: ProjectSettingsState; anchor: HTMLButtonElement }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const box = menu.current!.getBoundingClientRect();
    // Flip above when there is no room below, so the menu never covers its opener.
    const top = rect.bottom + 4 + box.height <= window.innerHeight - 8
      ? rect.bottom + 4 : rect.top - box.height - 4;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - box.height - 8)),
    });
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) closeProjectSettings();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        event.stopImmediatePropagation();
        items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== 'Escape' && event.key !== 'Tab') return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); }
      closeProjectSettings();
      anchor.focus({ preventScroll: true });
    };
    const moved = () => closeProjectSettings();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', moved);
    document.addEventListener('scroll', moved, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', moved);
      document.removeEventListener('scroll', moved, true);
    };
  }, [anchor]);
  return createPortal(
    <div ref={menu} class="menu project-actions-menu" style={position} role="menu" data-testid="project-settings-menu">
      <button type="button" role="menuitem" class="menu-item" data-testid="project-jira" onClick={() => void beginProjectJira()}>Jira project</button>
      <button type="button" role="menuitem" class="menu-item" data-testid="project-confluence" onClick={() => void beginProjectConfluence()}>Confluence spaces</button>
      {settings.project.role === 'lead' && <button type="button" role="menuitem" class="menu-item" data-testid="project-rename" onClick={beginProjectRename}>Rename project</button>}
      {settings.project.role === 'lead' && <button type="button" role="menuitem" class="menu-item" data-testid="project-archive"
        onClick={() => askProjectSetting(settings.project.status === 'archived' ? 'unarchive' : 'archive')}>
        {settings.project.status === 'archived' ? 'Restore project' : 'Archive project'}
      </button>}
      {settings.project.role === 'lead' && <div class="menu-rule" />}
      <button type="button" role="menuitem" class="menu-item danger" data-testid="project-leave" onClick={() => askProjectSetting('leave')}>Leave project</button>
    </div>, document.body,
  );
}

/** Both collection editors share focus, dismissal, write-state and conflict handling. */
function ProjectMappingDialog({ settings, setting, tool, title, loading, canSave, retry, focus, reload, save, children }: {
  settings: ProjectSettingsState;
  setting: ProjectToolSetting<{ mapping: unknown | null }>;
  tool: string; title: string; loading: string; canSave: boolean; retry?: boolean;
  focus?: () => void; reload: () => Promise<unknown>; save: (remove?: boolean) => Promise<void>;
  children: ComponentChildren;
}) {
  const box = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const lead = settings.project.role === 'lead';
  useEffect(() => { if (setting.status === 'ready' && lead && focus) focus(); else done.current?.focus(); }, [setting.status, lead]);
  return <div class="overlay" onClick={cancelProjectSettingsAction}>
    <div class="sheet confirm project-setting-sheet" role="dialog" aria-labelledby={`${tool}-mapping-title`} ref={box}
      onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelProjectSettingsAction(); }
        else trapTab(event, box.current);
      }}>
      <h2 id={`${tool}-mapping-title`}>{title}</h2>
      {setting.status === 'loading' && <p role="status">{loading}</p>}
      {children}
      {setting.status === 'saving' && <p role="status">Checking access and saving…</p>}
      {setting.failure && <p class="error" data-testid={`project-${tool}-error`}>{setting.failure.code === 'conflict'
        ? 'This setting changed. Reload it before editing.' : setting.writeFailed
          ? 'The change could not be confirmed. Reload the setting before editing again.' : message(setting.failure)}</p>}
      <div class="choices">
        <button ref={done} type="button" class="plain-button" disabled={setting.status === 'saving'} onClick={cancelProjectSettingsAction}>Done</button>
        {(setting.status === 'failed' || retry) && <button type="button" class="plain-button" onClick={() => void reload()}>Reload setting</button>}
        {lead && setting.value?.mapping != null && <button type="button" class="plain-button" data-testid={`project-${tool}-remove`} disabled={setting.status !== 'ready'} onClick={() => void save(true)}>Remove mapping</button>}
        {lead && setting.value && <button type="button" class="plain-button" data-testid={`project-${tool}-save`} disabled={setting.status !== 'ready' || !canSave} onClick={() => void save()}>Save</button>}
      </div>
    </div>
  </div>;
}

function JiraProject({ state }: { state: State }) {
  const settings = state.projectSettings!;
  const jira = settings.jira!;
  const field = useRef<HTMLInputElement>(null);
  const lead = settings.project.role === 'lead';
  return <ProjectMappingDialog settings={settings} setting={jira} tool="jira" title="Jira project" loading="Loading setting…"
    canSave={projectJiraValid(jira)} focus={() => field.current?.focus()} reload={beginProjectJira} save={saveProjectJira}>
    <p>Questions in {settings.project.name} read this Jira project live, using each person’s connected Jira account.</p>
    {jira.value && <>
      <p data-testid="project-jira-current">{jira.value.mapping ? `Mapped to ${jira.value.mapping.project_key}` : 'No Jira project mapped'}</p>
      {lead ? <label class="jira-project-field">Jira project key
        <input ref={field} class="field" data-testid="project-jira-input" aria-label="Jira project key" maxLength={64} placeholder="e.g. KAN"
          value={jira.key} disabled={jira.status !== 'ready'} onInput={event => setProjectJira((event.target as HTMLInputElement).value)}
          onKeyDown={event => { if (event.key === 'Enter' && projectJiraValid(jira)) { event.preventDefault(); void saveProjectJira(); } }} />
      </label> : <p>A project lead can change this setting.</p>}
      {lead && <p>Connect your Jira account in Tools before saving.</p>}
    </>}
  </ProjectMappingDialog>;
}

function ConfluenceSpaces({ state }: { state: State }) {
  const settings = state.projectSettings!;
  const confluence = settings.confluence!;
  const lead = settings.project.role === 'lead';
  return <ProjectMappingDialog settings={settings} setting={confluence} tool="confluence" title="Confluence spaces" loading="Loading accessible spaces…"
    canSave={confluence.pickerFailure === undefined && confluence.selected.length > 0} retry={confluence.pickerFailure !== undefined}
    reload={beginProjectConfluence} save={saveProjectConfluence}>
    <p>Questions in {settings.project.name} read these spaces live, using each person’s connected Confluence account.</p>
    {confluence.value && <>
      <p data-testid="project-confluence-current">{confluence.value.mapping ? `${confluence.value.mapping.space_ids.length} space${confluence.value.mapping.space_ids.length === 1 ? '' : 's'} mapped` : 'No Confluence spaces mapped'}</p>
      {lead ? <div class="check-list" data-testid="project-confluence-spaces">{confluence.spaces.map(space => <label key={space.id} class="check">
        <input type="checkbox" checked={confluence.selected.includes(space.id)} disabled={confluence.status !== 'ready'} onChange={() => toggleProjectConfluenceSpace(space.id)} /><span>{space.name} ({space.key})</span>
      </label>)}</div> : <p>A project lead can change this setting.</p>}
      {lead && <p>Connect your Confluence account in Tools before saving.</p>}
      {confluence.next !== null && <button type="button" class="plain-button" data-testid="project-confluence-more" disabled={confluence.loadingMore || confluence.status !== 'ready'} onClick={() => void moreProjectConfluenceSpaces()}>{confluence.loadingMore ? 'Loading…' : 'Load more spaces'}</button>}
    </>}
    {confluence.pickerFailure && <p class="error" data-testid="project-confluence-picker-error">Could not load accessible spaces. {message(confluence.pickerFailure)}</p>}
  </ProjectMappingDialog>;
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
  if (settings.jira) return state.sheet ? null : <JiraProject state={state} />;
  if (settings.confluence) return state.sheet ? null : <ConfluenceSpaces state={state} />;
  if (settings.write) return <Write state={state} />;
  if (settings.rename !== null) return <Rename state={state} />;
  if (settings.confirm) return <Confirm state={state} />;
  return null;
}
