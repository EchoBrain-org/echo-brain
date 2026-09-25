import { when } from '../format.js';
import { message } from '../messages.js';
import { closeReader, type ReaderState } from '../store.js';

/** An original, read in place of the page's list. Back returns to it. */
export function Reader({ reader, backTo }: { reader: ReaderState; backTo: string }) {
  return (
    <article class="reader" data-testid="reader" aria-busy={reader.loading}>
      {reader.failure && <div class="error">{message(reader.failure)}</div>}
      {reader.content && (
        <>
          <h1>{reader.content.title}</h1>
          <div class="notice">{when(reader.content.received_at)}</div>
          <div class="body selectable" data-testid="reader-text">{reader.content.text}</div>
        </>
      )}
      <div class="actions"><button type="button" class="link-button" onClick={closeReader}>Back to {backTo}</button></div>
    </article>
  );
}
