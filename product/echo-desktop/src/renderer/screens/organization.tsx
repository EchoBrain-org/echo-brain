import { useEffect, useRef } from 'preact/hooks';
import type { Employee } from '../../shared/protocol.js';
import { dateTime } from '../format.js';
import { message } from '../messages.js';
import {
  askRevoke, cancelRevoke, confirmRevoke, inviteEmployee, loadEmployees, reissueInvitation, setOrganizationField, showInvitation, shownEmployees,
  toggleEmployeeMenu, undoInvite, type OrganizationState, type State,
} from '../store.js';
import { within } from './change.js';
import { trapTab } from './compose.js';
import { Ellipsis } from './icons.js';
import { Face } from './people.js';

const INVITATION: Record<Employee['invitation'], string> = {
  pending: 'Awaiting sign-in', expired: 'Invitation expired', redeemed: 'Onboarded', none: 'No invitation',
};

/** Membership and invitation are separate: "Active · Awaiting sign-in". */
function standing(employee: Employee): string {
  return `${employee.membership === 'active' ? 'Active' : 'Revoked'} · ${INVITATION[employee.invitation]}`;
}

/** Revoke access… cannot be undone, so it is asked first. Cancel has the focus. */
function ConfirmRevoke({ employee }: { employee: Employee }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return (
    <div class="overlay" onClick={cancelRevoke}>
      <div class="sheet confirm" role="alertdialog" aria-labelledby="revoke-title" data-testid="revoke-confirm" ref={box}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <h2 id="revoke-title">Revoke access for {employee.display_name}?</h2>
        <p>{employee.email} loses organization access, and any invitation stops working.</p>
        <div class="choices">
          <button type="button" class="plain-button" ref={cancel} onClick={cancelRevoke}>Cancel</button>
          <button type="button" class="plain-button danger" data-testid="revoke-confirm-go" onClick={confirmRevoke}>Revoke access</button>
        </div>
      </div>
    </div>
  );
}

function EmployeeRow({ employee, page }: { employee: Employee; page: OrganizationState }) {
  const blocked = page.write !== null;
  const reissue = employee.membership === 'active' && (employee.invitation === 'pending' || employee.invitation === 'expired');
  return (
    <div class="person employee" data-testid="employee-row">
      <Face person={{ membership_id: employee.email, display_name: employee.display_name }} />
      <span class="lines">
        <span class="name">{employee.display_name}</span>
        <span class="detail selectable">{employee.email}</span>
      </span>
      <span class="standing" data-testid="employee-standing">{standing(employee)}</span>
      {employee.membership === 'active' && (
        <button type="button" class="icon-button" aria-label={`More for ${employee.display_name}`} aria-haspopup="menu"
          aria-expanded={page.menu === employee.email} data-testid="employee-more" disabled={blocked}
          onClick={() => toggleEmployeeMenu(employee.email)}><Ellipsis /></button>
      )}
      {page.menu === employee.email && (
        <div class="menu" role="menu" data-testid="employee-menu">
          {reissue && (
            <>
              <button type="button" role="menuitem" class="menu-item" data-testid="employee-reissue" disabled={blocked}
                onClick={() => void reissueInvitation(employee)}>Reissue invitation…</button>
              <div class="menu-rule" />
            </>
          )}
          <button type="button" role="menuitem" class="menu-item" data-testid="employee-revoke" disabled={blocked}
            onClick={() => askRevoke(employee)}>Revoke access…</button>
        </div>
      )}
    </div>
  );
}

/** What the last change did, and what can follow it: Show invitation in Finder, and an invite's Undo. */
function Status({ page }: { page: OrganizationState }) {
  const { saved, write } = page;
  if (write?.status === 'sending') return <div class="org-status notice" data-testid="org-status" aria-live="polite">Saving</div>;
  return (
    <div class="org-status" data-testid="org-status" aria-live="polite">
      {page.notice && <span class={write?.status === 'unknown' || page.items === null ? 'error' : 'notice'} data-testid="org-notice">{page.notice}</span>}
      {!page.notice && page.failure && <span class="error">{message(page.failure)}</span>}
      {saved && (
        <>
          <span data-testid="org-saved">
            {saved.action === 'invite' ? `Invitation for ${saved.name} saved.` : `New invitation for ${saved.name} saved; the previous one no longer works.`}
            {` It expires ${dateTime(saved.expires_at)}. Send the folder to them privately; they open it with Account ▸ Open invitation…`}
          </span>
          <span class="org-actions">
            <button type="button" class="pill" data-testid="invitation-show" onClick={showInvitation}>Show invitation in Finder</button>
            {saved.action === 'invite' && (
              <button type="button" class="pill" aria-label={`Undo inviting ${saved.name}`} data-testid="invite-undo" onClick={undoInvite}>Undo</button>
            )}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * People & invites: the organization's employees, for its owners. The name
 * and email typed narrow the list (search), then Invite… saves a private
 * invitation folder where main's dialog says, with an Undo. Revoke access is
 * asked first. A change whose outcome is unknown empties the list until
 * Refresh reads it again.
 */
export function Organization({ state, page }: { state: State; page: OrganizationState }) {
  const account = state.status?.account;
  const shown = shownEmployees(page);
  const sending = page.write?.status === 'sending';
  const count = page.items?.length ?? 0;
  return (
    <div class="column organization" data-testid="organization"
      onClick={event => { if (page.menu && !within(event, '.menu, [data-testid="employee-more"]')) toggleEmployeeMenu(page.menu); }}>
      {account && <div class="org-context">Owner: {account.display_name} · {account.authority}</div>}
      <form class="invite-row" onSubmit={event => { event.preventDefault(); void inviteEmployee(); }}>
        <input class="field small" data-testid="invite-name" type="text" autocomplete="off" maxLength={200} placeholder="Employee name"
          aria-label="Employee name" value={page.name} disabled={sending}
          onInput={event => setOrganizationField('name', (event.target as HTMLInputElement).value)} />
        <input class="field small" data-testid="invite-email" type="email" autocomplete="off" maxLength={254} placeholder="Email address"
          aria-label="Email address" value={page.email} disabled={sending}
          onInput={event => setOrganizationField('email', (event.target as HTMLInputElement).value)} />
        <button type="submit" class="pill" data-testid="invite" disabled={page.write !== null || page.items === null}>Invite…</button>
      </form>
      <Status page={page} />
      <div class="people-list employees" aria-busy={page.loading}>
        {shown.map(employee => <EmployeeRow key={employee.email} employee={employee} page={page} />)}
        {page.items !== null && count > 0 && shown.length === 0 && <div class="notice" data-testid="employees-none">No one by that name</div>}
        {page.items !== null && count === 0 && <div class="notice" data-testid="employees-empty">No employees yet</div>}
      </div>
      <div class="org-foot">
        {page.items !== null && <span data-testid="employees-count">{count} employee{count === 1 ? '' : 's'}.</span>}
        <button type="button" class="link-button" data-testid="employees-refresh" disabled={page.loading || sending}
          onClick={() => void loadEmployees()}>Refresh</button>
      </div>
      {page.confirm && <ConfirmRevoke employee={page.confirm} />}
    </div>
  );
}
