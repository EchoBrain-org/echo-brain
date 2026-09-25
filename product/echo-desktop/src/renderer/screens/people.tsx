import { useEffect, useRef } from 'preact/hooks';
import type { Member } from '../../shared/protocol.js';
import { colorFor, initials } from '../format.js';
import { message } from '../messages.js';
import {
  addPerson, askMemberChange, cancelMemberChange, candidates, canManage, closeSheet, confirmMemberChange, findPeople, moreMembers, openPeople,
  setPeopleQuery, toggleMemberMenu, undoAdd, type PeopleSheet, type State,
} from '../store.js';
import { ChangeLine, within } from './change.js';
import { trapTab } from './compose.js';
import { Close, Ellipsis } from './icons.js';

function Face({ person }: { person: Member }) {
  return <span class="face large" style={{ background: colorFor(person.membership_id) }} aria-hidden="true">{initials(person.display_name)}</span>;
}

/** Make lead, Make member and Remove from project: each is asked first, and Cancel has the focus. */
function Confirm({ sheet }: { sheet: PeopleSheet }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  const { action, person } = sheet.confirm!;
  const title = action === 'remove' ? `Remove ${person.display_name}?` : `Make ${person.display_name} a ${action}?`;
  const detail = action === 'remove' ? 'They lose access through this project.' : 'Leads manage who is in the project.';
  const verb = action === 'remove' ? 'Remove' : action === 'lead' ? 'Make lead' : 'Make member';
  return (
    <div class="overlay" onClick={event => { event.stopPropagation(); cancelMemberChange(); }}>
      <div class="sheet confirm" role="alertdialog" aria-labelledby="people-confirm-title" data-testid="people-confirm" ref={box}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <h2 id="people-confirm-title">{title}</h2>
        <p>{detail}</p>
        <div class="choices">
          <button type="button" class="plain-button" ref={cancel} onClick={cancelMemberChange}>Cancel</button>
          <button type="button" class={`plain-button${action === 'remove' ? ' danger' : ''}`} data-testid="people-confirm-go"
            onClick={confirmMemberChange}>{verb}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * People: who is in the project and, for a lead, the organization's people to
 * add by name. Adding is instant, with an Undo that removes only that person.
 * You never manage your own row.
 */
export function People({ state, sheet }: { state: State; sheet: PeopleSheet }) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const lead = sheet.project.role === 'lead';
  const manage = canManage(state);
  useEffect(() => { (field.current ?? box.current)?.focus(); }, [lead]);
  const roster = state.roster?.projectId === sheet.project.project_id ? state.roster : null;
  const me = state.status?.account?.membership_id;
  const found = candidates(state);
  const change = state.change?.origin === 'people' && state.change.project.project_id === sheet.project.project_id ? state.change : null;
  const sending = change?.status === 'sending';
  return (
    <div class="overlay top" onClick={closeSheet}>
      <div class="sheet people" role="dialog" aria-labelledby="people-title" data-testid="people" ref={box} tabIndex={-1}
        onClick={event => {
          event.stopPropagation();
          // A click anywhere but a member's menu or its ⋯ closes it.
          if (sheet.menu && !within(event, '.menu, [data-testid="member-more"]')) toggleMemberMenu(sheet.menu);
        }}
        onKeyDown={event => trapTab(event, box.current)}>
        <div class="sheet-head">
          <h2 id="people-title">People</h2>
          <button type="button" class="circle small" aria-label="Close" data-testid="people-close" disabled={sending} onClick={closeSheet}><Close /></button>
        </div>
        {lead && (
          <input
            ref={field} class="field small" data-testid="people-find" type="text" autocomplete="off" maxLength={240}
            placeholder="Add someone by name" aria-label="Add someone by name" value={sheet.query} disabled={!manage}
            onInput={event => setPeopleQuery((event.target as HTMLInputElement).value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void findPeople(); } }}
          />
        )}
        {sheet.failure && (
          <div class="choices start">
            <span class="error">{message(sheet.failure)}</span>
            <button type="button" class="link-button" onClick={() => { closeSheet(); void openPeople(); }}>Try again</button>
          </div>
        )}
        <div class="people-list" aria-busy={roster?.loading ?? true}>
          {roster?.items.map(person => (
            <div class="person" data-testid="member-row" key={person.membership_id}>
              <Face person={person} />
              <span class="name">{person.display_name}</span>
              {person.role === 'lead' && <span class="tag">Lead</span>}
              {lead && person.membership_id !== me && (
                <button type="button" class="icon-button" aria-label={`More for ${person.display_name}`} aria-haspopup="menu"
                  aria-expanded={sheet.menu === person.membership_id} data-testid="member-more" disabled={!manage}
                  onClick={() => toggleMemberMenu(person.membership_id)}><Ellipsis /></button>
              )}
              {sheet.menu === person.membership_id && (
                <div class="menu" role="menu" data-testid="member-menu">
                  <button type="button" role="menuitem" class="menu-item" data-testid="member-role" disabled={!manage}
                    onClick={() => askMemberChange(person.role === 'lead' ? 'member' : 'lead', person)}>
                    {person.role === 'lead' ? 'Make member' : 'Make lead'}
                  </button>
                  <div class="menu-rule" />
                  <button type="button" role="menuitem" class="menu-item" data-testid="member-remove" disabled={!manage}
                    onClick={() => askMemberChange('remove', person)}>Remove from project</button>
                </div>
              )}
            </div>
          ))}
          {roster?.failure && (
            <div class="choices start">
              <span class="error">{message(roster.failure)}</span>
              <button type="button" class="link-button" onClick={() => { closeSheet(); void openPeople(); }}>Try again</button>
            </div>
          )}
          {roster?.next && (
            <button type="button" class="pill center" data-testid="members-more" disabled={roster.loading} onClick={moreMembers}>More</button>
          )}
          {lead && found.map(person => (
            <div class="person" data-testid="candidate-row" key={person.membership_id}>
              <Face person={person} />
              <span class="name">{person.display_name}</span>
              <button type="button" class="pill" aria-label={`Add ${person.display_name}`} data-testid="candidate-add" disabled={!manage}
                onClick={() => addPerson(person)}>Add</button>
            </div>
          ))}
          {lead && sheet.directory?.failure && <div class="error">{message(sheet.directory.failure)}</div>}
          {lead && sheet.directory && !sheet.directory.loading && !sheet.directory.failure && found.length === 0 && sheet.query.trim() !== '' && (
            <div class="notice" data-testid="people-none">No one else by that name</div>
          )}
          {lead && sheet.directory?.next && (
            <button type="button" class="pill center" data-testid="people-more" disabled={sheet.directory.loading || !manage}
              onClick={() => void findPeople(true)}>More people</button>
          )}
        </div>
        {change && <ChangeLine change={change} />}
        {lead && sheet.added && !change && (
          <div class="added" data-testid="people-added" aria-live="polite">
            <span>Added {sheet.added.person.display_name}.</span>
            <button type="button" class="pill" aria-label={`Undo adding ${sheet.added.person.display_name}`} data-testid="people-undo"
              disabled={!manage} onClick={undoAdd}>Undo</button>
          </div>
        )}
      </div>
      {sheet.confirm && <Confirm sheet={sheet} />}
    </div>
  );
}
