import { documentDetail, when } from '../format.js';
import { message } from '../messages.js';
import {
  addToProject, changeBlocked, closeReader, EXTRACTION, loadProjects, nextTextPage, projectChoices, refreshDocument, removableFrom, removeFromProject,
  saveOriginal, showProjectChoices, toggleReaderMenu, type ReaderState, type State,
} from '../store.js';
import { ChangeLine, changeShownInPlace, within } from './change.js';
import { Chevron, Ellipsis } from './icons.js';

/** Who can read it, when that is not a project's members: the words Capture uses. */
function readersWord(audience: 'only-me' | 'project' | 'team' | undefined): string | null {
  return audience === 'only-me' ? 'Only me' : audience === 'team' ? 'Organization' : null;
}

/** What Save original… came to. */
function saveLine(reader: ReaderState): { text: string; error: boolean } | null {
  const save = reader.save;
  if (!save) return null;
  if (save.status === 'saving') return { text: 'Saving the original', error: false };
  if (save.status === 'saved') return { text: 'Original saved to your selected file.', error: false };
  if (save.failure?.code === 'file_exists') return { text: message(save.failure), error: true };
  return { text: 'Could not confirm the download. Check the selected file before trying again.', error: true };
}

/** The ⋯ menu: for a document its original and text pages, and for either where it is filed. */
function Actions({ state, reader }: { state: State; reader: ReaderState }) {
  const blocked = changeBlocked(state);
  const document = reader.document;
  const removable = removableFrom(state);
  if (reader.menu === 'projects') {
    const choices = projectChoices(state);
    return (
      <div class="menu" role="menu" data-testid="reader-menu">
        {choices.map(project => (
          <button type="button" role="menuitem" key={project.project_id} class="menu-item" data-testid="reader-project" disabled={blocked}
            onClick={() => addToProject(project)}>{project.name}</button>
        ))}
        {state.projects.next && (
          <button type="button" role="menuitem" class="menu-item" disabled={state.projects.loading} onClick={() => void loadProjects(true)}>More</button>
        )}
        {choices.length === 0 && !state.projects.next && <div class="menu-note">No other projects</div>}
      </div>
    );
  }
  return (
    <div class="menu" role="menu" data-testid="reader-menu">
      {reader.from.kind === 'document' && (
        <>
          <button type="button" role="menuitem" class="menu-item" data-testid="reader-save" disabled={!document || reader.save?.status === 'saving'}
            onClick={() => void saveOriginal()}>Save original…</button>
          <button type="button" role="menuitem" class="menu-item" data-testid="reader-next" disabled={!document?.next_cursor || reader.loading}
            onClick={nextTextPage}>Next text page</button>
          <button type="button" role="menuitem" class="menu-item" data-testid="reader-refresh" disabled={reader.loading}
            onClick={refreshDocument}>Refresh document</button>
          <div class="menu-rule" />
        </>
      )}
      {removable && (
        <button type="button" role="menuitem" class="menu-item" data-testid="reader-remove" disabled={blocked || reader.loading}
          onClick={removeFromProject}>Remove from this project</button>
      )}
      <button type="button" role="menuitem" class="menu-item" data-testid="reader-add" disabled={blocked || reader.loading}
        onClick={showProjectChoices}>Add to project <Chevron /></button>
    </div>
  );
}

/**
 * An original, read in place of the page's list: a note's text as it was
 * saved, or a document's text a page at a time. Back returns to the list.
 */
export function Reader({ state, reader, backTo }: { state: State; reader: ReaderState; backTo: string }) {
  const content = reader.content;
  const document = reader.document;
  const title = content?.title ?? document?.document.title;
  const received = content?.received_at ?? document?.document.received_at;
  const meta = [readersWord(content?.audience ?? document?.document.audience), received ? when(received) : null,
    document ? documentDetail(document.document) : null].filter(Boolean).join(' · ');
  const saving = saveLine(reader);
  const readable = Boolean(content || document);
  return (
    <article class="reader" data-testid="reader" aria-busy={reader.loading} onClick={event => {
      // A click anywhere but the menu or its ⋯ closes it.
      if (reader.menu !== 'closed' && !within(event, '.menu, [data-testid="reader-actions"]')) toggleReaderMenu();
    }}>
      {readable && (
        <div class="reader-head">
          <div class="reader-title">
            <h1>{title}</h1>
            <div class="notice" data-testid="reader-meta">{meta}</div>
          </div>
          <button type="button" class="circle small" aria-label="More actions" aria-haspopup="menu" aria-expanded={reader.menu !== 'closed'}
            data-testid="reader-actions" onClick={toggleReaderMenu}><Ellipsis /></button>
          {reader.menu !== 'closed' && <Actions state={state} reader={reader} />}
        </div>
      )}
      {state.change?.origin === 'reader' && changeShownInPlace(state) && <ChangeLine change={state.change} />}
      {saving && <div class={saving.error ? 'error' : 'notice'} data-testid="reader-save-status" aria-live="polite">{saving.text}</div>}
      {reader.failure && <div class="error">{message(reader.failure)}</div>}
      {content && <div class="body selectable" data-testid="reader-text">{content.text}</div>}
      {document && (document.chunks.length === 0 ? (
        <div class="body notice" data-testid="reader-text">Original saved · {EXTRACTION[document.document.extraction]}.</div>
      ) : (
        <div class="body selectable" data-testid="reader-text">
          {document.chunks.map(chunk => (
            <section key={`${chunk.anchor}-${chunk.start}`} class="chunk">
              <div class="chunk-label">{chunk.anchor === 'page' ? 'Page' : 'Paragraph'} {chunk.start}</div>
              <div data-testid="reader-chunk">{chunk.text}</div>
            </section>
          ))}
        </div>
      ))}
      <div class="actions"><button type="button" class="link-button" onClick={closeReader}>Back to {backTo}</button></div>
    </article>
  );
}
