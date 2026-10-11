import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ProjectSummary } from '../../shared/protocol.js';
import { message, toolMessage } from '../messages.js';
import {
  askProjectSetting, beginProjectRename, cancelProjectConnect, cancelProjectSettingsAction, clearProjectTool, closeProjectSettings, confirmProjectSetting,
  connectProjectTool, dismissProjectSetting, hiddenSpaces, keepProjectSetting, moreProjectConfluenceSpaces, openProjectTools, PROJECT_MAPPING_TOOLS, projectRenameValid,
  projectSettingsBlocked, projectToolChange, projectToolEntry, projectToolFailureWords, projectToolsSavable, projectToolUsable, reloadProjectTool, reloadProjectToolList,
  retryProjectSetting, saveProjectTools, setProjectJira, setProjectRename, sheetShown, toggleProjectConfluenceSpace, toggleProjectSettings,
  type MappingTool, type ProjectSettingsState, type State,
} from '../store.js';
import { trapTab } from './compose.js';
import { Check, Close, Ellipsis, Plug } from './icons.js';
import { expiresIn, useMinuteTick } from './tools.js';

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

/** Tools, in the project's title bar, once the organization has a tool a project can read. */
export function ProjectToolsButton({ state }: { state: State }) {
  const route = state.route;
  if (route.page !== 'project' || state.concealed || state.ask || state.reader) return null;
  const reads = state.projectReads?.project_id === route.project.project_id ? state.projectReads : null;
  if (!reads?.available) return null;
  return (
    <button type="button" class="tools-pill" data-testid="project-tools" disabled={projectSettingsBlocked(state)}
      onClick={() => openProjectTools(route.project)}><Plug /><span>Tools</span></button>
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
      <button type="button" role="menuitem" class="menu-item" data-testid="project-tools-item" onClick={() => openProjectTools(settings.project)}>Tools…</button>
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

/** The tool's name as the Authority lists it, until it is read. */
const NAMES: Record<MappingTool, string> = { jira: 'Jira', confluence: 'Confluence' };
/** What each tool's setting holds. */
const SCOPE: Record<MappingTool, string> = { jira: 'One project', confluence: 'Up to 20 spaces' };

/** What the project reads from a tool now, as the Authority last said. */
function currentWords(settings: ProjectSettingsState, tool: MappingTool): string {
  const setting = settings[tool];
  if (!setting || setting.status === 'loading') return 'Loading…';
  if (setting.status === 'failed' && !setting.value) return 'Could not be read';
  if (!setting.value) return SCOPE[tool];
  if (tool === 'jira') return settings.jira?.value?.mapping ? `Reads ${settings.jira.value.mapping.project_key}` : 'Not set';
  const spaces = settings.confluence?.value?.mapping?.space_ids.length ?? 0;
  return spaces > 0 ? `Reads ${spaces} space${spaces === 1 ? '' : 's'}` : 'Not set';
}

/** Connected, Connect or Reconnect, on the right of a row. */
function Connection({ settings, tool, name }: { settings: ProjectSettingsState; tool: MappingTool; name: string }) {
  const sheet = settings.tools!;
  const entry = projectToolEntry(settings, tool);
  const connecting = sheet.connect?.tool.tool_id === tool && sheet.connect.phase !== 'failed';
  if (!entry || connecting) return null;
  if (entry.status === 'linked') {
    return <span class="tool-linked" data-testid={`project-${tool}-linked`}><Check />{sheet.connected === tool ? 'Connected just now' : 'Connected'}</span>;
  }
  if (entry.status === 'unavailable') return <span class="tool-off">Not turned on</span>;
  return (
    <button type="button" class="primary-button small" data-testid={`project-${tool}-connect`} disabled={sheet.saving || Boolean(sheet.connect && sheet.connect.phase !== 'failed')}
      aria-label={`${entry.status === 'revoked' ? 'Reconnect' : 'Connect'} ${name}`} onClick={() => void connectProjectTool(entry)}>
      {entry.status === 'revoked' ? 'Reconnect' : 'Connect'}
    </button>
  );
}

/** A connection started in the row: waiting on the browser, or why it did not connect. */
function Connecting({ settings, tool, name }: { settings: ProjectSettingsState; tool: MappingTool; name: string }) {
  const connect = settings.tools!.connect;
  if (connect?.tool.tool_id !== tool) return null;
  useMinuteTick();
  if (connect.phase === 'failed') {
    return (
      <div class="tool-body tool-trouble" role="alert">
        <span class="error" data-testid={`project-${tool}-connect-failure`}>{toolMessage(name, connect.reason, connect.failure)}</span>
        <button type="button" class="link-button" onClick={() => void connectProjectTool(connect.tool)}>Try again</button>
      </div>
    );
  }
  return (
    <div class="tool-body tool-wait" role="status" data-testid={`project-${tool}-waiting`}>
      <span class="asking" aria-hidden="true"><i /><i /><i /></span>
      <span class="lines">
        <span>Finish connecting {name} in your browser</span>
        <span class="detail">{connect.phase === 'starting' ? `Opening ${name}…` : `This row updates by itself · ${expiresIn(connect.attempt!.expires_at)}`}</span>
      </span>
      <button type="button" class="link-button" data-testid={`project-${tool}-connect-cancel`} onClick={cancelProjectConnect}>Cancel</button>
    </div>
  );
}

/** What a lead picks: the Jira project's key, or Confluence spaces from their own. */
function Picker({ settings, tool, name, onSave }: { settings: ProjectSettingsState; tool: MappingTool; name: string; onSave: () => void }) {
  const sheet = settings.tools!;
  const editing = !sheet.saving;
  if (tool === 'jira') {
    const jira = settings.jira!;
    const invalid = projectToolChange(settings, 'jira') === 'invalid';
    return (
      <label class="tool-body tool-field">
        <span class="select-label">Project key</span>
        <input class="field small" data-testid="project-jira-input" aria-label="Jira project key" maxLength={64} placeholder="e.g. KAN" autocomplete="off"
          value={jira.key} disabled={!editing || jira.status !== 'ready'} onInput={event => setProjectJira((event.target as HTMLInputElement).value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onSave(); } }} />
        {invalid && <span class="notice-line">Use the project’s key, like KAN.</span>}
      </label>
    );
  }
  const confluence = settings.confluence!;
  if (confluence.catalog !== 'read') return <div class="tool-body notice-line" role="status">Loading your {name} spaces…</div>;
  if (confluence.pickerFailure) {
    return (
      <div class="tool-body tool-trouble">
        <span class="error" data-testid="project-confluence-picker-error">Could not load your spaces. {message(confluence.pickerFailure)}</span>
        <button type="button" class="link-button" onClick={() => reloadProjectTool('confluence')}>Try again</button>
      </div>
    );
  }
  const hidden = hiddenSpaces(confluence);
  return (
    <div class="tool-body tool-spaces">
      <span class="select-label">Spaces</span>
      <div class="check-list" data-testid="project-confluence-spaces">
        {confluence.spaces.map(space => (
          <label key={space.id} class="check">
            <input type="checkbox" checked={confluence.selected.includes(space.id)} disabled={!editing || confluence.status !== 'ready'}
              onChange={() => toggleProjectConfluenceSpace(space.id)} />
            <span>{space.name} <span class="faint">({space.key})</span></span>
          </label>
        ))}
        {/* Read by the project, picked by another lead or on a page not read yet: it can still be unticked. */}
        {hidden.map(id => (
          <label key={id} class="check" data-testid="project-confluence-hidden-space">
            <input type="checkbox" checked disabled={!editing || confluence.status !== 'ready'} onChange={() => toggleProjectConfluenceSpace(id)} />
            <span>A space you can’t see <span class="faint">({id})</span></span>
          </label>
        ))}
        {confluence.spaces.length === 0 && hidden.length === 0 && <span class="notice-line">You can’t see any spaces in {name}.</span>}
      </div>
      {confluence.status === 'ready' && confluence.failure && (
        <span class="error" data-testid="project-confluence-more-error">More spaces could not be read. {message(confluence.failure)}</span>
      )}
      {confluence.next !== null && (
        <button type="button" class="link-button tool-more" data-testid="project-confluence-more" disabled={confluence.loadingMore || !editing}
          onClick={() => void moreProjectConfluenceSpaces()}>{confluence.loadingMore ? 'Loading…' : 'More spaces'}</button>
      )}
    </div>
  );
}

/** One tool: your connection, what the project reads, and, for a lead who is connected, the pick. */
function ToolSection({ state, tool, onSave }: { state: State; tool: MappingTool; onSave: () => void }) {
  const settings = state.projectSettings!;
  const sheet = settings.tools!;
  const setting = settings[tool]!;
  const name = projectToolEntry(settings, tool)?.name ?? NAMES[tool];
  const lead = settings.project.role === 'lead';
  const usable = projectToolUsable(settings, tool);
  const connecting = sheet.connect?.tool.tool_id === tool;
  const failure = projectToolFailureWords(settings, tool, name);
  const off = projectToolEntry(settings, tool)?.status === 'unavailable';
  const mapped = tool === 'jira' ? Boolean(settings.jira?.value?.mapping) : Boolean(settings.confluence?.value?.mapping);
  const change = projectToolChange(settings, tool);
  return (
    <section class="tool-section" aria-label={name} data-testid={`project-${tool}`}>
      <div class="tool-section-head">
        <span class="tool-mark" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <span class="lines">
          <span class="name">{name}</span>
          <span class="state" data-testid={`project-${tool}-current`}>{currentWords(settings, tool)}{change === 'remove' ? ' · stops on Save' : ''}</span>
        </span>
        {lead && mapped && setting.status === 'ready' && change !== 'remove' && (
          <button type="button" class="link-button" data-testid={`project-${tool}-remove`} disabled={sheet.saving} onClick={() => clearProjectTool(tool)}>Stop reading</button>
        )}
        <Connection settings={settings} tool={tool} name={name} />
      </div>
      <Connecting settings={settings} tool={tool} name={name} />
      {failure && (
        <div class="tool-body tool-trouble">
          <span class="error" data-testid={`project-${tool}-error`}>{failure}</span>
          {setting.status === 'failed' && (
            <button type="button" class="link-button" data-testid={`project-${tool}-reload`} disabled={sheet.saving} onClick={() => reloadProjectTool(tool)}>Reload setting</button>
          )}
        </div>
      )}
      {setting.status === 'saving' && <div class="tool-body notice-line" role="status">Checking access and saving…</div>}
      {lead && !connecting && setting.value && setting.status !== 'failed' && (usable
        ? <Picker settings={settings} tool={tool} name={name} onSave={onSave} />
        : !off && <div class="tool-body notice-line">Connect {name} to choose what {settings.project.name} reads.</div>)}
    </section>
  );
}

/**
 * A project's Tools: every tool a project can read, on one sheet. Connect
 * waits in its row; Save writes what changed and closes the sheet. A member
 * who is not a lead sees what the project reads, and can connect their own
 * account.
 */
function ProjectTools({ state }: { state: State }) {
  const settings = state.projectSettings!;
  const sheet = settings.tools!;
  const box = useRef<HTMLDivElement>(null);
  const lead = settings.project.role === 'lead';
  useEffect(() => { box.current?.focus(); }, []);
  const savable = projectToolsSavable(settings);
  const save = () => { if (savable) void saveProjectTools(); };
  const tools = PROJECT_MAPPING_TOOLS.filter(tool => {
    const entry = projectToolEntry(settings, tool);
    const mapped = tool === 'jira' ? settings.jira?.value?.mapping : settings.confluence?.value?.mapping;
    return !sheet.items || (entry !== undefined && entry.status !== 'unavailable') || Boolean(mapped);
  });
  return (
    <div class="overlay" onClick={cancelProjectSettingsAction}>
      <div class="sheet tools-sheet" role="dialog" aria-labelledby="project-tools-title" data-testid="project-tools-sheet" ref={box} tabIndex={-1}
        onClick={event => event.stopPropagation()} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelProjectSettingsAction(); }
          else trapTab(event, box.current);
        }}>
        <div class="tools-sheet-head">
          <div class="lines">
            <h2 id="project-tools-title">Tools for {settings.project.name}</h2>
            <p>Questions in {settings.project.name} read these live, with each person’s own access. ECHO never changes anything in them.</p>
          </div>
          <button type="button" class="circle small" aria-label="Close" data-testid="project-tools-x" disabled={sheet.saving} onClick={cancelProjectSettingsAction}><Close /></button>
        </div>
        <div class="tools-sheet-rows">
          {sheet.failure && (
            <p class="error tool-list-failure">Your connections could not be read. {message(sheet.failure)}{' '}
              <button type="button" class="link-button" data-testid="project-tools-reload" disabled={sheet.saving} onClick={reloadProjectToolList}>Try again</button>
            </p>
          )}
          {tools.map(tool => <ToolSection key={tool} state={state} tool={tool} onSave={save} />)}
          {tools.length === 0 && <p class="notice-line tool-none">Your organization hasn’t turned on a tool a project can read.</p>}
        </div>
        <div class="tools-sheet-foot">
          <span class="notice-line">{lead ? 'Other tools are set up per person in Tools.' : `A project lead can change what ${settings.project.name} reads.`}</span>
          {lead ? (
            <>
              <button type="button" class="plain-button" data-testid="project-tools-cancel" disabled={sheet.saving} onClick={cancelProjectSettingsAction}>Cancel</button>
              <button type="button" class="primary-button small" data-testid="project-tools-save" disabled={!savable} onClick={save}>
                {sheet.saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : <button type="button" class="plain-button" data-testid="project-tools-close" onClick={cancelProjectSettingsAction}>Close</button>}
        </div>
      </div>
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
  useEffect(() => { box.current?.focus(); }, []);
  const conflict = write.operation === 'leave' && write.failure?.code === 'conflict';
  const text = write.status === 'sending' ? 'Saving project settings…' : write.status === 'unknown' && write.dismissConfirm ? 'Dismiss it? It may still have been made.'
    : write.status === 'unknown' ? 'This may not have been sent.'
    : conflict ? 'Promote another lead before leaving this project.' : message(write.failure!);
  return (
    <div class="overlay">
      <div class="sheet confirm" role="alertdialog" aria-labelledby="project-settings-write-title" aria-live="polite" ref={box} tabIndex={-1}
        onKeyDown={event => trapTab(event, box.current)}>
        <h2 id="project-settings-write-title">{write.status === 'sending' ? 'Saving' : 'Project settings'}</h2>
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
  if (settings.tools) return sheetShown(state) ? null : <ProjectTools state={state} />;
  if (settings.write) return <Write state={state} />;
  if (settings.rename !== null) return <Rename state={state} />;
  if (settings.confirm) return <Confirm state={state} />;
  return null;
}
