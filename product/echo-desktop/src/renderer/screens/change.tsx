import { message } from '../messages.js';
import { dismissChange, keepChange, retryChange, type ChangeState, type State } from '../store.js';

/** What a refused change says: a member change that would leave no lead says that. */
function refusal(change: ChangeState): string {
  const member = change.change.kind.startsWith('member-');
  return member && change.failure?.code === 'conflict' ? 'A project must keep at least one lead.' : message(change.failure!);
}

/**
 * Where a project change stands: on its way, refused, or unknown. Unknown is
 * never called made or not: Try again resends exactly it, and Dismiss is
 * asked first.
 */
export function ChangeLine({ change }: { change: ChangeState }) {
  if (change.status === 'sending') return <div class="change-line notice" data-testid="change-line" aria-live="polite">Saving</div>;
  if (change.status === 'failed') {
    return (
      <div class="change-line" data-testid="change-line" aria-live="polite">
        <span class="error" data-testid="change-error">{refusal(change)}</span>
        <button type="button" class="link-button" data-testid="change-dismiss" onClick={dismissChange}>Dismiss</button>
      </div>
    );
  }
  return (
    <div class="change-line" data-testid="change-line" aria-live="polite">
      {change.confirmDismiss ? (
        <>
          <span class="error">Dismiss it? It may still have been made.</span>
          <button type="button" class="link-button" data-testid="change-dismiss" onClick={dismissChange}>Dismiss</button>
          <button type="button" class="link-button" onClick={keepChange}>Keep it</button>
        </>
      ) : (
        <>
          <span class="error" data-testid="change-error">This may not have been sent.</span>
          <button type="button" class="link-button" data-testid="change-retry" onClick={retryChange}>Try again</button>
          <button type="button" class="link-button" data-testid="change-dismiss" onClick={dismissChange}>Dismiss</button>
        </>
      )}
    </div>
  );
}

/** The change shows where it was asked for; anywhere else, at the top of the page. */
export function changeShownInPlace(state: State): boolean {
  const change = state.change;
  if (!change || state.concealed) return false;
  if (change.origin === 'people') return state.sheet?.kind === 'people' && state.sheet.project.project_id === change.project.project_id;
  const target = 'context_id' in change.change ? change.change.context_id : 'document_id' in change.change ? change.change.document_id : null;
  return state.reader?.id === target && !state.ask;
}

/** Whether a click started inside what the selector names. The path is the one it had then: a menu may have changed since. */
export function within(event: Event, selector: string): boolean {
  return event.composedPath().some(node => node instanceof Element && node.matches(selector));
}
