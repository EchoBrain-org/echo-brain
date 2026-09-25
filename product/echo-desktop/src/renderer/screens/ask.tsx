import type { AnswerSource, ApprovedRecord, Match, RecordItem } from '../../shared/protocol.js';
import { askText, queryTerms } from '../../shared/query.js';
import { clock, marked, meetingTime, snippet, when } from '../format.js';
import { message } from '../messages.js';
import {
  answerSources, ask, chipProject, chooseSource, closeAsk, matchesShown, openCompose, openMatch, retryEvidence, retryRecord, searchAgain,
  setBarText, submitBar, toggleSources, widenScope, type SourcesState, type State,
} from '../store.js';
import { Close, Doc, Plus, Up } from './icons.js';

/** What an original source may show: 2,000 characters. The store keeps at most 32 sources. */
const MAX_EVIDENCE = 2_000;

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

/** A chip: its place in the answer, and its meeting's title once its record is read. */
function chipLabel(source: AnswerSource, sources: SourcesState | null): string {
  if (source.kind === 'original') return source.label;
  const read = sources?.records[source.record.record_sha256];
  return read && !read.loading && 'value' in read ? read.value.title ?? UNTITLED : source.label;
}

const UNTITLED = 'Untitled meeting';

/** BASED ON: one chip per source. The chosen one is lit while the pane shows it. */
function BasedOn({ state }: { state: State }) {
  const sources = answerSources(state);
  if (sources.length === 0) return null;
  const open = state.sources?.open ?? null;
  return (
    <div class="based-on" data-testid="based-on">
      <div class="section-label">Based on</div>
      <div class="chips">
        {sources.map((source, index) => (
          <button type="button" key={index} class={`source-chip${open === index ? ' on' : ''}`} data-testid="source-chip"
            aria-pressed={open === index} onClick={() => chooseSource(index)}
            title={source.kind === 'record' ? 'Show the approved record and supporting excerpts' : 'Show the verified evidence packet for this original source'}>
            <span class="n">{index + 1}</span><span class="label">{chipLabel(source, state.sources)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The latest question, its answer, and what it was based on. */
export function AskView({ state }: { state: State }) {
  const current = state.ask!;
  const count = answerSources(state).length;
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
          <BasedOn state={state} />
          <div class="actions">
            {count > 0 && (
              <button type="button" class="link-button" data-testid="sources-toggle" aria-pressed={state.sources?.open != null}
                onClick={toggleSources}>Sources ({count})</button>
            )}
            <button type="button" class="link-button" onClick={() => void ask(current.question, current.scope)}>Ask again</button>
          </div>
        </>
      )}
    </section>
  );
}

/** A decision, action or rationale, and the excerpts that support it. */
function Item({ item }: { item: RecordItem }) {
  return (
    <div class="record-item">
      {item.status && <div class="status">{item.status === 'proposed' ? 'Proposed' : 'Unresolved'}</div>}
      <div>{item.text}</div>
      {item.excerpts.map((excerpt, index) => (
        <div key={index} class="excerpt">
          <div class="quote">“{excerpt.quote}”</div>
          {excerpt.at && <div class="at">{meetingTime(excerpt.at)}</div>}
        </div>
      ))}
    </div>
  );
}

const SECTIONS = [['decisions', 'Decisions', 'decision'], ['actions', 'Actions', 'action'], ['rationales', 'Rationale', 'rationale']] as const;

/** MEETING · APPROVED RECORD: who approved it, who was there, who can read it, and what was approved. */
function RecordDetail({ record }: { record: ApprovedRecord }) {
  const participants = [...record.participants, ...(record.participants_more ? ['Additional participants not shown'] : [])];
  return (
    <div class="source-detail selectable" data-testid="record">
      <div class="section-label">Meeting · Approved record</div>
      <h2>{record.title ?? UNTITLED}</h2>
      {record.started_at && <div class="meta">{meetingTime(record.started_at, record.timezone, record.all_day)}</div>}
      <dl class="fields">
        {record.approved_by && <><dt>Record approved by</dt><dd>{record.approved_by}</dd></>}
        {participants.length > 0 && <><dt>Participants</dt><dd>{participants.join(', ')}</dd></>}
        <dt>Visibility</dt>
        <dd>{record.visibility === 'organization' ? 'Visible to active organization members' : 'Only the approver'}</dd>
      </dl>
      {SECTIONS.map(([key, heading, kind]) => {
        const section = record[key];
        if (section.items.length === 0) return null;
        return (
          <div key={key} class="record-section" data-testid={`record-${key}`}>
            <div class="section-label">{heading}</div>
            {section.items.map((item, index) => <Item key={index} item={item} />)}
            {section.more && <div class="record-item">Additional approved {kind} items are not shown.</div>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Beside the answer: the source a chip chose. An approved record, or an
 * original source's verified evidence packet, at most 2,000 characters.
 */
export function SourcePane({ state }: { state: State }) {
  const sources = state.sources!;
  const index = sources.open!;
  const source = answerSources(state)[index];
  if (!source) return null;
  let body;
  if (source.kind === 'record') {
    const read = sources.records[source.record.record_sha256];
    body = !read || read.loading ? <div class="notice">Loading…</div>
      : 'failure' in read ? (
        <div class="source-failure">
          <div class="error" data-testid="source-error">{message(read.failure)}</div>
          <button type="button" class="link-button" onClick={retryRecord}>Try again</button>
        </div>
      ) : <RecordDetail record={read.value} />;
  } else {
    const read = sources.evidence?.index === index ? sources.evidence.read : { loading: true } as const;
    const text = !read.loading && 'value' in read ? read.value.text : undefined;
    body = (
      <div class="source-detail">
        <div class="section-label">Original source</div>
        <h2>{!read.loading && 'value' in read ? read.value.label : source.label}</h2>
        {read.loading && <div class="notice">Loading verified evidence…</div>}
        {!read.loading && 'failure' in read && (
          <div class="source-failure">
            <div class="error" data-testid="source-error">{message(read.failure)}</div>
            <button type="button" class="link-button" data-testid="retry-evidence" onClick={retryEvidence}>Retry evidence</button>
          </div>
        )}
        {text !== undefined && (
          <div class="body selectable" data-testid="evidence-text">{text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE)}…` : text}</div>
        )}
      </div>
    );
  }
  return (
    <aside class="source-pane" data-testid="source-pane" aria-label="Source">
      <button type="button" class="icon-button close" aria-label="Close sources" data-testid="source-close" onClick={toggleSources}><Close /></button>
      {body}
    </aside>
  );
}
