import type { Match } from '../../shared/protocol.js';
import { askText, queryTerms } from '../../shared/query.js';
import { clock, marked, snippet, when } from '../format.js';
import { message } from '../messages.js';
import {
  ask, chipProject, closeAsk, closeSource, matchesShown, openCompose, openMatch, openSource, searchAgain, setBarText, submitBar, widenScope,
  type State,
} from '../store.js';
import { Close, Doc, Plus, Up } from './icons.js';

/** What a source may show: 2,000 characters, and at most 32 sources. */
const MAX_EVIDENCE = 2_000;
const MAX_SOURCES = 32;

/** One match: its title with the query's words marked, or where in its text they are. */
function MatchRow({ match, terms }: { match: Match; terms: readonly string[] }) {
  const title = marked(match.title, terms);
  const around = title.some(piece => piece.hit) ? null : snippet(match.excerpt, terms);
  return (
    <button type="button" class="match-row" data-testid="match-row" onClick={() => void openMatch(match)}>
      <Doc />
      <span class="label">
        {title.map((piece, index) => piece.hit ? <b key={index}>{piece.text}</b> : piece.text)}
        {around && <> · “{marked(around, terms).map((piece, index) => piece.hit ? <b key={index}>{piece.text}</b> : piece.text)}”</>}
      </span>
      <span class="meta">{when(match.received_at)}</span>
    </button>
  );
}

/** Live matches above the bar, within its scope, and the Ask that Return makes. */
function Matches({ state, scopeName }: { state: State; scopeName: string | null }) {
  const matches = state.matches!;
  const terms = queryTerms(matches.query);
  return (
    <div class="matches" data-testid="matches" role="group" aria-label="Matches">
      <div class="matches-head" data-testid="matches-head">Matches in {scopeName ?? 'all context'}</div>
      {matches.items.map(match => <MatchRow key={`${match.source}-${match.context_id}`} match={match} terms={terms} />)}
      {matches.loading && matches.items.length === 0 && <div class="matches-note">Searching</div>}
      {!matches.loading && !matches.failure && matches.items.length === 0 && <div class="matches-note" data-testid="matches-empty">No matches</div>}
      {matches.failure && (
        <div class="matches-note" data-testid="matches-error">
          <span class="error">{message(matches.failure)}</span>
          <button type="button" class="link-button" onClick={searchAgain}>Try again</button>
        </div>
      )}
      <div class="matches-rule" />
      <button type="button" class="match-row ask-row" data-testid="match-ask" onClick={submitBar}>
        <Up />
        <span class="label">Ask {scopeName ?? 'ECHO'} about “{askText(state.barText)}”</span>
        <span class="meta">↩</span>
      </button>
    </div>
  );
}

/**
 * The one bar on every page. ⊕ captures and Return asks, both in the bar's
 * scope; typing shows live matches in it. The chip names a project scope, and
 * its × widens to all context without moving the page.
 */
export function Bar({ state }: { state: State }) {
  // While another app is in front nothing says which project is open.
  const chip = chipProject(state);
  const verb = state.ask ? 'Ask' : 'Search or ask';
  return (
    <div class="bar-wrap">
      {matchesShown(state) && <Matches state={state} scopeName={chip?.name ?? null} />}
      <form class="bar" onSubmit={event => { event.preventDefault(); submitBar(); }}>
        <button type="button" class="circle" aria-label="Capture" data-testid="write-button" onClick={() => openCompose()}><Plus /></button>
        {chip && (
          <span class="chip" data-testid="scope-chip">
            <span>{chip.name}</span>
            <button type="button" aria-label="Widen to all context" data-testid="scope-clear"
              onClick={() => { widenScope(); document.getElementById('ask-field')?.focus(); }}><Close /></button>
          </span>
        )}
        <label for="ask-field" class="sr-only">{verb} ECHO</label>
        <input
          id="ask-field" data-testid="ask-field" type="text" autocomplete="off" spellcheck maxLength={240}
          placeholder={`${verb} ${chip?.name ?? 'ECHO'}`}
          value={state.barText} onInput={event => setBarText((event.target as HTMLInputElement).value)}
        />
        <button type="submit" class="circle primary" aria-label="Ask" data-testid="ask-send" disabled={state.barText.trim() === ''}><Up /></button>
      </form>
    </div>
  );
}

/** The latest question, its answer, and the sources it came from. */
export function AskView({ state }: { state: State }) {
  const current = state.ask!;
  const evidence = state.evidence;
  if (evidence) {
    return (
      <article class="reader" data-testid="evidence" aria-busy={evidence.loading}>
        <h1>{evidence.label}</h1>
        {evidence.failure && <div class="error">{message(evidence.failure)}</div>}
        {evidence.text !== undefined && (
          <div class="body selectable" data-testid="evidence-text">
            {evidence.text.length > MAX_EVIDENCE ? `${evidence.text.slice(0, MAX_EVIDENCE)}…` : evidence.text}
          </div>
        )}
        <div class="actions"><button type="button" class="link-button" onClick={closeSource}>Back to answer</button></div>
      </article>
    );
  }
  return (
    <section class="ask" data-testid="ask-view" aria-live="polite">
      <div class="question selectable" data-testid="question">{current.question}</div>
      <div class="asked">{current.scopeName} · Asked at {clock(current.askedAt)}</div>
      {current.status === 'loading' && (
        <div class="asking" data-testid="asking">
          <i /><i /><i /><span>Asking</span>
          <button type="button" class="link-button" data-testid="ask-cancel" onClick={closeAsk}>Cancel</button>
        </div>
      )}
      {current.status === 'error' && current.failure && (
        <div>
          <div class="error" data-testid="ask-error">{message(current.failure)}</div>
          {current.failure.retryable && (
            <button type="button" class="link-button" onClick={() => void ask(current.question, current.scope)}>Ask again</button>
          )}
        </div>
      )}
      {current.status === 'answer' && current.answer && (
        <>
          <div class="answer selectable" data-testid="answer">{current.answer.text}</div>
          <div class="actions">
            <button type="button" class="link-button" onClick={() => void ask(current.question, current.scope)}>Ask again</button>
          </div>
          {current.answer.sources.length > 0 && (
            <div class="sources">
              <h2>Sources</h2>
              {current.answer.sources.slice(0, MAX_SOURCES).map((source, index) => (
                <button type="button" key={`${source.label}-${index}`} class="source-row" data-testid="source-row"
                  disabled={!source.ref} onClick={() => void openSource(index)}>{source.label}</button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
