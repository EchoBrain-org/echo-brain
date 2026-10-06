import { Meetings } from './meetings.js';
import { useEffect, useRef } from 'preact/hooks';
import type { ConnectedTool, ToolStatus } from '../../shared/protocol.js';
import { message, toolMessage } from '../messages.js';
import {
  cancelConnect, closeSheet, connectTool, disconnectTool, loadToolList, manageTool,
  type State, type ToolConnectSheet, type ToolManageSheet, type ToolsPage,
} from '../store.js';
import { trapTab } from './compose.js';
import { Close } from './icons.js';

/** Sections in the order they show; an empty one is left out. */
const SECTIONS: readonly { label: string; status: ToolStatus }[] = [
  { label: 'Needs attention', status: 'revoked' },
  { label: 'Connected', status: 'linked' },
  { label: 'Available', status: 'unlinked' },
  { label: 'Not turned on', status: 'unavailable' },
];

const STATE: Record<ToolStatus, string> = {
  linked: 'Connected',
  unlinked: 'Not connected',
  revoked: 'Connection stopped. Reconnect to keep using it.',
  unavailable: 'Not turned on for your organization.',
};

/** A tool's mark: its first letter, until tools carry their own icon. */
function Mark({ tool }: { tool: ConnectedTool }) {
  return <span class={`tool-mark${tool.status === 'unavailable' ? ' off' : ''}`} aria-hidden="true">{tool.name.slice(0, 1).toUpperCase()}</span>;
}

function ToolRow({ tool }: { tool: ConnectedTool }) {
  return (
    <div class={`tool-row ${tool.status}`} data-testid="tool-row" data-tool={tool.tool_id}>
      <Mark tool={tool} />
      <span class="lines">
        <span class="name">{tool.name}</span>
        <span class="state" data-testid="tool-state">{STATE[tool.status]}</span>
      </span>
      {(tool.status === 'linked' || (tool.tool_id === 'granola' && tool.status !== 'unavailable')) && (
        <button type="button" class="plain-button" data-testid="tool-manage" onClick={() => manageTool(tool)}>Manage</button>
      )}
      {(tool.status === 'unlinked' || tool.status === 'revoked') && (
        <button type="button" class="primary-button small" data-testid="tool-connect" onClick={() => void connectTool(tool)}>
          {tool.status === 'revoked' ? 'Reconnect' : 'Connect'}
        </button>
      )}
    </div>
  );
}

/**
 * Tools: every tool the organization lists, grouped by your connection to it.
 * The page names no tool itself, so a tool the Authority adds shows here as is.
 */
export function Tools({ state, page }: { state: State; page: ToolsPage }) {
  const account = state.status?.account;
  const items = page.items;
  return (
    <div class="column tools-page" data-testid="tools">
      {account && <div class="org-context">{account.display_name} · {account.authority}</div>}
      <div class="tools-intro">Connect your work apps so ECHO can use them. Ask only reads what you can already see.</div>
      <div class="tools-list" aria-live="polite" aria-busy={page.loading}>
        {items === null && page.loading && <p class="notice">Checking your tools…</p>}
        {page.failure && (
          <div class="choices start">
            <p class="error">{message(page.failure)}</p>
            <button type="button" class="plain-button small" onClick={() => void loadToolList()}>Try again</button>
          </div>
        )}
        {items !== null && items.length === 0 && <p class="notice">Your organization has no tools yet.</p>}
        {items !== null && SECTIONS.map(section => {
          const rows = items.filter(tool => tool.status === section.status);
          return rows.length === 0 ? null : (
            <section key={section.status} aria-label={section.label}>
              <div class="side-header">{section.label.toUpperCase()}</div>
              {rows.map(tool => <ToolRow key={tool.tool_id} tool={tool} />)}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Opening the page, waiting on the browser, or why it did not connect. Closing cancels a waiting attempt. */
export function ToolConnect({ sheet }: { sheet: ToolConnectSheet }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, [sheet.phase]);
  const { tool } = sheet;
  const failed = sheet.phase === 'failed';
  return (
    <div class="overlay" onClick={cancelConnect}>
      <div class="sheet confirm tool-connect" role={failed ? 'alertdialog' : 'dialog'} aria-labelledby="tool-connect-title"
        data-testid="tool-connect-sheet" ref={box} tabIndex={-1}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <h2 id="tool-connect-title">{failed ? `${tool.name} was not connected` : `Finish connecting ${tool.name} in your browser`}</h2>
        {failed
          ? <p class="error" data-testid="tool-connect-failure">{toolMessage(tool.name, sheet.reason, sheet.failure)}</p>
          : <p>{sheet.phase === 'starting' ? `Opening ${tool.name}…` : 'Approve ECHO there, then come back. This updates by itself.'}</p>}
        {sheet.phase === 'waiting' && sheet.attempt && <p class="context" data-testid="tool-connect-waiting">Waiting · {expiresIn(sheet.attempt.expires_at)}</p>}
        <div class="choices">
          <button type="button" class="plain-button" data-testid="tool-connect-cancel" onClick={cancelConnect}>{failed ? 'Close' : 'Cancel'}</button>
          {failed && <button type="button" class="primary-button small" data-testid="tool-connect-retry" onClick={() => void connectTool(tool)}>Try again</button>}
        </div>
      </div>
    </div>
  );
}

function expiresIn(expiresAt: string): string {
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));
  return `expires in ${minutes} min`;
}

/** Manage: Disconnect removes only your own connection. */
export function ToolManage({ sheet }: { sheet: ToolManageSheet }) {
  const box = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => { done.current?.focus(); }, []);
  const { tool } = sheet;
  return (
    <div class="overlay" onClick={closeSheet}>
      <div class={`sheet confirm${tool.tool_id === 'granola' ? ' meeting-manage' : ''}`} role="dialog" aria-labelledby="tool-manage-title" data-testid="tool-manage-sheet" ref={box}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <div class="sheet-head">
          <h2 id="tool-manage-title">{tool.name}</h2>
          <button type="button" class="circle" aria-label="Close" onClick={closeSheet} disabled={sheet.busy}><Close /></button>
        </div>
        {tool.tool_id === 'granola' && <Meetings />}
        <p>{tool.tool_id === 'granola' ? 'Disconnecting stops new imports. Retained meetings and approved records keep their existing audience. You can reconnect later.' : <>Disconnecting removes only your own {tool.name} connection; you can connect again later.</>}</p>
        {sheet.failure && <p class="error" aria-live="polite">{message(sheet.failure)}</p>}
        <div class="choices">
          <button type="button" class="plain-button danger" data-testid="tool-disconnect" disabled={sheet.busy} onClick={() => void disconnectTool()}>
            {sheet.busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
          <button type="button" class="plain-button" ref={done} disabled={sheet.busy} onClick={closeSheet}>Done</button>
        </div>
      </div>
    </div>
  );
}
