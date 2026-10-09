import { useEffect, useRef } from 'preact/hooks';
import type { Member, OpenItemView } from '../../shared/protocol.js';
import { colorFor, initials } from '../format.js';
import { itemParts, itemTitle, monthDay, nameList, shortNames } from '../needs.js';
import {
  clearPick, closePicker, goHome, pickOwner, searchOwner, sendDecision, sendDetails, sendRecipients, sendToOwners, tickSend, type SendState, type State,
} from '../store.js';
import { Close } from './icons.js';

/** A person, as a chip: their initials in their color, and their first name. */
function Chip({ person, label }: { person: { membership_id: string; name: string }; label: string }) {
  return (
    <span class="owner-chip">
      <span class="face" style={{ background: colorFor(person.membership_id) }} aria-hidden="true">{initials(person.name)}</span>
      <span class="owner-chip-name">{label}</span>
    </span>
  );
}

/** Pick a person: a search over the organization's people, under the item it picks for. */
function Picker({ send, item }: { send: SendState; item: OpenItemView }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  const picker = send.picker!;
  const searched = picker.query.trim() !== '';
  return (
    <div class="picker" data-testid="owner-picker">
      <input ref={field} class="field small" type="search" autocomplete="off" maxLength={240} placeholder="Find a person" aria-label="Find a person"
        value={picker.query} onInput={event => void searchOwner(item.item_id, (event.target as HTMLInputElement).value)} />
      <div class="picker-list" role="listbox" aria-label="People" aria-busy={picker.loading}>
        {picker.results.map(person => (
          <button type="button" role="option" aria-selected={false} class="picker-option" key={person.membership_id} onClick={() => pickOwner(item.item_id, person)}>
            <span class="face" style={{ background: colorFor(person.membership_id) }} aria-hidden="true">{initials(person.display_name)}</span>
            <span class="name">{person.display_name}</span>
          </button>
        ))}
      </div>
      {picker.failure && <div class="error">{picker.failure}</div>}
      {!picker.loading && !picker.failure && picker.results.length === 0 && <div class="notice">{searched ? 'No one by that name' : 'No one to pick'}</div>}
      <div class="picker-foot"><button type="button" class="link-button" onClick={closePicker}>Cancel</button></div>
    </div>
  );
}

/** Who an item goes to: the person picked, its owner, or Pick a person where ECHO matched no one (it stays yours). */
function Owner({ send, item, me }: { send: SendState; item: OpenItemView; me: string | undefined }) {
  const pick: Member | undefined = send.picks[item.item_id];
  if (pick) {
    const [name] = shortNames([pick.display_name]);
    return (
      <span class="owner-slot">
        <Chip person={{ membership_id: pick.membership_id, name: pick.display_name }} label={name ?? pick.display_name} />
        <button type="button" class="icon-button" aria-label={`Remove ${pick.display_name}`} disabled={send.busy} onClick={() => clearPick(item.item_id)}><Close /></button>
      </span>
    );
  }
  if (item.owner.match === 'approver' && item.owner.membership_id === me) {
    return (
      <button type="button" class="pick-button" disabled={send.busy || !send.ticks[item.item_id]} aria-expanded={send.picker?.item_id === item.item_id}
        aria-label={`Pick a person: ${itemTitle(item)}`} onClick={() => void searchOwner(item.item_id, '')}>Pick a person</button>
    );
  }
  const [name] = shortNames([item.owner.name]);
  return <span class="owner-slot"><Chip person={item.owner} label={name ?? item.owner.name} /></span>;
}

/** The button: who it tells, or what happens when it tells no one. */
function sendLabel(send: SendState, me: string | undefined): string {
  if (!send.items.some(item => send.ticks[item.item_id])) return 'None of these need changing';
  const recipients = sendRecipients(send, me);
  return recipients.length === 0 ? 'Keep on my Home' : `Send to ${nameList(shortNames(recipients))}`;
}

/**
 * Tell the owners? (canvas 9.3): what a decision you approved changes, one
 * ticked line per item with who it goes to. Send tells them on their Home;
 * unticked items are not relevant; Not now leaves the row on your Home.
 */
export function Send({ state, send }: { state: State; send: SendState }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('.decision-foot button:not(:disabled)')?.focus({ preventScroll: true }); }, [send.loading]);
  if (send.loading) return <div class="column center" aria-busy="true" data-testid="send-loading"><span class="asking"><i /><i /><i /></span></div>;
  const me = state.status?.account?.membership_id;
  const decision = sendDecision(state);
  const approved = decision ? monthDay(decision.approved_at) : null;
  return (
    <div class="column decision" ref={box}>
      <article class="decision-card" data-testid="send" aria-labelledby="send-ask" aria-busy={send.busy}>
        <h1 id="send-ask" class="decision-ask">Tell the owners?</h1>
        {decision && (
          <div class="decision-from">You approved <b>{decision.title}</b>{approved ? ` on ${approved}` : ''}. ECHO found what it changes.</div>
        )}
        {decision?.first_line && <div class="decision-line">{decision.first_line}</div>}
        {send.items.length > 0 ? (
          <section class="decision-section" aria-labelledby="must-change">
            <div class="section-label" id="must-change">Must change</div>
            {send.items.map(item => {
              const { title, change } = itemParts(item);
              return (
                <div class="send-item" key={item.item_id} data-testid="send-item">
                  <div class="send-line">
                    <label class="check send-tick">
                      <input type="checkbox" checked={send.ticks[item.item_id] === true} disabled={send.busy} onChange={() => tickSend(item.item_id)} />
                      <span><b>{title}</b>{change && <span class="faint"> {change}</span>}</span>
                    </label>
                    <Owner send={send} item={item} me={me} />
                  </div>
                  {send.picker?.item_id === item.item_id && <Picker send={send} item={item} />}
                </div>
              );
            })}
          </section>
        ) : !send.failure && <div class="notice" data-testid="send-none">Nothing is waiting to be sent.</div>}
        <div class="send-note">
          <span class="notice">Untick anything that's wrong. Owners get it on their Home.</span>
          {decision && <button type="button" class="link-button" data-testid="send-details" onClick={sendDetails}>Details</button>}
        </div>
        {send.failure && <div class="error" data-testid="send-error" aria-live="polite">{send.failure}</div>}
        <div class="decision-foot">
          <button type="button" class="primary-button small" data-testid="send-go" disabled={send.busy || send.items.length === 0} onClick={() => void sendToOwners()}>
            {sendLabel(send, me)}
          </button>
          <button type="button" class="plain-button" data-testid="send-later" disabled={send.busy} onClick={goHome}>Not now</button>
          {send.busy && <span class="asking"><i /><i /><i /><span>Sending</span></span>}
        </div>
      </article>
    </div>
  );
}
