import { useEffect, useState } from 'preact/hooks';
import type { OpenItemView } from '../../shared/protocol.js';
import { message } from '../messages.js';
import { dueOnWords, itemTitle, ownerUnmatched, ownerWords, sendLabel } from '../needs.js';
import { dismissable, editAskCard, openFollowUp, readAskCards, sendable, sendAskCard, type AskCard, type State } from '../store.js';
import { EditFollowUp } from './edit-follow-up.js';
import { Owner, OwnerPicker, StateMark } from './follow-ups.js';

/** Where a card from this chat stands, after "From this chat": its owner while not sent, else what became of it. */
function standing(item: OpenItemView, me: string | null): string {
  switch (item.state) {
    case 'unsent': return ownerUnmatched(item) ? 'No owner yet' : `For ${item.owner.membership_id === me ? 'you' : ownerWords(item, me)}`;
    case 'open': return item.owner.membership_id === me ? 'Kept for you' : `Sent to ${ownerWords(item, me)}`;
    case 'done': return 'Done';
    default: return 'Dismissed';
  }
}

/**
 * One follow-up the answer drafted (ADR-0053), in the follow-ups list's own
 * row look: its state mark, its one line (which opens its page), and its
 * owner, "Pick owner" while it has none, which opens the people picker. Under
 * it, faintly, "From this chat", whose it is or what became of it, and its due
 * date; then, while it is not sent and yours to send, Send to <owner>, Edit
 * and Dismiss. Nobody owns it: no Send until someone is picked. The line under
 * it says what the last change did.
 */
function Card({ state, item_id, card }: { state: State; item_id: string; card: AskCard }) {
  const [editing, setEditing] = useState(false);
  const me = state.status?.account?.membership_id ?? null;
  const item = card.item;
  if (card.gone) {
    return <div class="ask-follow-up faint" data-testid="ask-follow-up" data-status="gone">You no longer see this follow-up</div>;
  }
  if (!item) {
    return card.failure ? (
      <div class="ask-follow-up error" data-testid="ask-follow-up" data-status="failed">
        Couldn't load this follow-up. {message(card.failure)}
        <button type="button" class="link-button" disabled={card.loading} onClick={() => void readAskCards([item_id])}>Try again</button>
      </div>
    ) : (
      <div class="ask-follow-up faint" data-testid="ask-follow-up" data-status="loading" aria-busy="true">
        Loading follow-up… <span class="asking" aria-hidden="true"><i /><i /><i /></span>
      </div>
    );
  }
  const now = Date.now();
  const title = itemTitle(item);
  const picker = state.askCards.picker?.item_id === item_id ? state.askCards.picker : null;
  // Its last read failed: what shows may be out of date, so nothing acts on it until a read succeeds.
  const stale = card.failure !== undefined;
  const line = ['From this chat', standing(item, me), item.state === 'unsent' || item.state === 'open' ? dueOnWords(item.due_on, now) : null]
    .filter((part): part is string => part !== null).join(' · ');
  return (
    <div class="ask-follow-up" data-testid="ask-follow-up" data-status="loaded" data-item={item_id} data-state={item.state} aria-busy={card.busy || card.loading}>
      <div class="follow-up-row">
        <StateMark item={item} now={now} />
        <button type="button" class="follow-up-open" data-testid="ask-follow-up-title" title="Open this follow-up" onClick={() => void openFollowUp(item_id, item)}>
          <span class="follow-up-title">{title}</span>
        </button>
        <Owner state={state} busy={card.busy || stale} picking={picker !== null} item={item} name={title} flat />
      </div>
      {picker && <OwnerPicker state={state} picker={picker} item={item} />}
      <div class="ask-follow-up-line" data-testid="ask-follow-up-line">{line}</div>
      {stale ? (
        <div class="ask-follow-up-stale error" data-testid="ask-follow-up-stale" role="status">
          Couldn't refresh this follow-up. {message(card.failure!)}
          <button type="button" class="link-button" disabled={card.loading} onClick={() => void readAskCards([item_id])}>Try again</button>
        </div>
      ) : editing ? <EditFollowUp item={item} busy={card.busy} save={edit => editAskCard(item_id, edit)} close={() => setEditing(false)} /> : (
        <div class="ask-follow-up-actions">
          {sendable(item) && (
            <button type="button" class="primary-button small" data-testid="ask-follow-up-send" disabled={card.busy} onClick={() => void sendAskCard(item_id, true)}>
              {sendLabel(item, me)}
            </button>
          )}
          {item.can.edit && <button type="button" class="link-button" data-testid="ask-follow-up-edit" disabled={card.busy} onClick={() => setEditing(true)}>Edit</button>}
          {dismissable(item) && (
            <button type="button" class="link-button" data-testid="ask-follow-up-dismiss" disabled={card.busy} onClick={() => void sendAskCard(item_id, false)}>Dismiss</button>
          )}
          {card.busy && <span class="asking" aria-hidden="true"><i /><i /><i /></span>}
        </div>
      )}
      <div class={`result-line${card.said?.error ? ' error' : ''}${card.said ? '' : ' sr-only'}`} data-testid="ask-follow-up-said" role="status">{card.said?.words}</div>
    </div>
  );
}

/**
 * The follow-ups an answer drafted (ADR-0053), under it: each a card read
 * again, rows only, each time its turn shows, so what it says is never older
 * than that read. The draft is the question: ECHO never asks in words.
 */
export function AskFollowUps({ state, ids }: { state: State; ids: readonly string[] }) {
  useEffect(() => { void readAskCards(ids); }, [ids.join()]);
  return (
    <section class="ask-follow-ups" data-testid="ask-follow-ups" aria-label={ids.length === 1 ? 'Follow-up' : 'Follow-ups'}>
      {ids.map(id => {
        const card = state.askCards.cards[id] ?? { item: null, loading: true, gone: false, busy: false, said: null, send: null };
        return <Card key={id} state={state} item_id={id} card={card} />;
      })}
    </section>
  );
}
