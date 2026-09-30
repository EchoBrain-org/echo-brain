import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Answer, AnswerSource, AnswerStatement, ApprovedRecord, Match, RecordItem } from '../../shared/protocol.js';
import { askText, queryTerms } from '../../shared/query.js';
import { documentName, passageBlocks, statementGroups, type Inline, type SourceGroup } from '../answer.js';
import { marked, meetingTime, snippet, when } from '../format.js';
import { message } from '../messages.js';
import {
  answerGroups, answerSources, ask, askEverywhere, cancelAsk, chipName, chooseSource, closeSources, copyAnswer, earlierTurns, foundNothingInProject,
  matchesShown, openCompose, openMatch, openSlackSource, pageCovered, retryEvidence, retryRecord, searchAgain, setBarText, submitBar, widenScope,
  type AskTurn, type SourcesState, type State,
} from '../store.js';
import { Close, Doc, Hash, Lock, Meeting, Plus, Up } from './icons.js';

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

/** Live matches above the bar, within its scope, and the Ask that Return makes. Mine is only asked, never searched. */
function Matches({ state, scopeName }: { state: State; scopeName: string | null }) {
  const matches = state.matches!;
  const terms = queryTerms(matches.query);
  const searched = matches.scope.kind !== 'mine';
  return (
    <div class="matches" data-testid="matches" role="group" aria-label="Matches">
      {searched && (
        <>
          <div class="matches-head" data-testid="matches-head">Matches in {scopeName ?? 'all context'}</div>
          {matches.items.map(match => <MatchRow key={match.context_id} match={match} terms={terms} />)}
          {matches.loading && matches.items.length === 0 && <div class="matches-note">Searching</div>}
          {!matches.loading && !matches.failure && matches.items.length === 0 && <div class="matches-note" data-testid="matches-empty">No matches</div>}
          {matches.failure && (
            <div class="matches-note" data-testid="matches-error">
              <span class="error">{message(matches.failure)}</span>
              <button type="button" class="link-button" onClick={searchAgain}>Try again</button>
            </div>
          )}
          <div class="matches-rule" />
        </>
      )}
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
 * scope; typing shows live matches in it. The chip names a project scope, or
 * Mine, which is only asked; its × widens to all context without moving the
 * page. Mine is not a place to capture: it has no ⊕.
 */
export function Bar({ state }: { state: State }) {
  // While another app is in front nothing says which project is open, or what
  // was typed over a covered page: the text is kept, and shows again on return.
  const chip = chipName(state);
  const covered = pageCovered(state);
  const text = covered ? '' : state.barText;
  const verb = state.ask || (chip !== null && state.barScope.kind === 'mine') ? 'Ask' : 'Search or ask';
  const name = `${verb} ${chip ?? 'ECHO'}`;
  return (
    <div class={`bar-wrap${state.ask && !covered ? ' with-ask' : ''}`}>
      {matchesShown(state) && <Matches state={state} scopeName={chip} />}
      <form class="bar" onSubmit={event => { event.preventDefault(); submitBar(); }}>
        {state.route.page !== 'mine' && (
          <button type="button" class="circle" aria-label="Capture" data-testid="write-button" onClick={() => openCompose()}><Plus /></button>
        )}
        {chip && (
          <span class="chip" data-testid="scope-chip">
            <span>{chip}</span>
            <button type="button" aria-label="Widen to all context" data-testid="scope-clear"
              onClick={() => { widenScope(); document.getElementById('ask-field')?.focus(); }}><Close /></button>
          </span>
        )}
        <label for="ask-field" class="sr-only">{name}</label>
        <input
          id="ask-field" data-testid="ask-field" type="text" autocomplete="off" spellcheck maxLength={240} placeholder={name}
          value={text} readOnly={covered} onInput={event => setBarText((event.target as HTMLInputElement).value)}
        />
        <button type="submit" class="circle primary" aria-label="Ask" data-testid="ask-send"
          disabled={text.trim() === '' || Boolean(state.ask?.asking)}><Up /></button>
      </form>
    </div>
  );
}

/** What a source is called: a meeting's title once its record is read, a file's name as a person says it. */
function sourceName(source: AnswerSource, sources: SourcesState | null): string {
  if (source.kind === 'original') return documentName(source.label).name;
  if (source.kind === 'slack') return source.label;
  const read = sources?.records[source.record.record_sha256];
  return read && !read.loading && 'value' in read ? read.value.title ?? UNTITLED : source.label;
}

const UNTITLED = 'Untitled meeting';

/** A source's first citation stands for it: its kind, its label, its record or its Slack message. */
function firstSource(state: State, group: SourceGroup): AnswerSource {
  return answerSources(state)[group.indexes[0]!]!;
}

/** Every sentence of an answer, by the id the pane knows it by. */
function sentences(answer: Answer): [string, AnswerStatement][] {
  return [
    ...(answer.direct ? [['direct', answer.direct] as [string, AnswerStatement]] : []),
    ...answer.parts.flatMap((part, p) => [
      ...part.statements.map((statement, i) => [`${p}.${i}`, statement] as [string, AnswerStatement]),
      ...(part.records ?? []).map((statement, i) => [`${p}.r${i}`, statement] as [string, AnswerStatement]),
    ]),
  ];
}

/** A source's number after a sentence: it opens the pane on that source, for that sentence. */
function Marker({ state, group, focus }: { state: State; group: number; focus: string }) {
  const on = state.sources?.open === group && state.sources.focus === focus;
  const name = sourceName(firstSource(state, answerGroups(state)[group]!), state.sources);
  return (
    <button type="button" class={`marker${on ? ' on' : ''}`} data-testid="citation" aria-pressed={on} aria-label={`Source ${group + 1}: ${name}`}
      title={name} onClick={() => chooseSource(group, focus)}>{group + 1}</button>
  );
}

/** Numbers after a sentence, one per source it cites, and a lock when only you can read one of them. */
function Markers({ state, statement, id }: { state: State; statement: AnswerStatement; id: string }) {
  return <>
    {statementGroups(statement.citation_indexes, answerGroups(state)).map(group => <Marker key={group} state={state} group={group} focus={id} />)}
    {statement.private && (
      <span class="private-mark" data-testid="private-mark" role="img" aria-label="Only you can read a source of this" title="Only you can read a source of this"><Lock /></span>
    )}
  </>;
}

/** A sentence and the numbers of its sources. The one whose number opened the pane is lit. */
function Statement({ state, statement, id }: { state: State; statement: AnswerStatement; id: string }) {
  const on = state.sources?.open != null && state.sources.focus === id;
  return (
    <p class={`answer-statement selectable${on ? ' on' : ''}`} data-testid="statement">
      <span data-testid="statement-text">{statement.text}</span>
      <Markers state={state} statement={statement} id={id} />
    </p>
  );
}

/** No sentence could be written: what research found, as its passages read, with their sources' numbers. */
function Found({ state, statement, id }: { state: State; statement: AnswerStatement; id: string }) {
  const source = answerSources(state)[statement.citation_indexes[0]!];
  return (
    <div class="passage selectable" data-testid="found">
      <Passage text={statement.text} label={source?.label ?? ''} />
      <div><Markers state={state} statement={statement} id={id} /></div>
    </div>
  );
}

function AgenticAnswer({ state, turn }: { state: State; turn: AskTurn }) {
  const answer = turn.answer;
  return (
    <div class="agentic-answer" data-testid="answer">
      {answer.assumption && <div class="answer-banner" data-testid="answer-assumption">{answer.assumption}</div>}
      {answer.outcome === 'off_scope' && <div class="answer-banner" data-testid="answer-off-scope">The accessible evidence may be about a different subject.</div>}
      {answer.notice && <div class="answer-banner" data-testid="answer-notice">{answer.notice}</div>}
      {answer.direct && <Statement state={state} statement={answer.direct} id="direct" />}
      {answer.parts.map((part, index) => (
        <section class="answer-part" key={index}>
          {/* One part answers the question itself: its label would repeat it. */}
          {answer.parts.length > 1 && <div class="section-label">{part.question}</div>}
          {part.statements.map((statement, place) => <Statement key={place} state={state} statement={statement} id={`${index}.${place}`} />)}
          {part.records?.map((statement, place) => <Found key={`record-${place}`} state={state} statement={statement} id={`${index}.r${place}`} />)}
          {part.gap && <div class="answer-gap" data-testid="answer-gap">{part.gap}</div>}
        </section>
      ))}
    </div>
  );
}

/** An original's version, and how many of its passages the answer cites when more than one: "v0.1 · 3 passages". */
function originalMeta(source: Extract<AnswerSource, { kind: 'original' }>, group: SourceGroup, passages: string): string {
  const { version } = documentName(source.label);
  const count = group.indexes.length;
  return [version, count > 1 ? `${count} ${passages}` : undefined].filter(Boolean).join(' · ');
}

function KindIcon({ kind }: { kind: SourceGroup['kind'] }) {
  return kind === 'record' ? <Meeting /> : kind === 'slack' ? <Hash /> : <Doc />;
}

/** One row per source, numbered as the sentences cite it. The one the pane shows is lit. */
function SourceList({ state }: { state: State }) {
  const groups = answerGroups(state);
  if (groups.length === 0) return null;
  const open = state.sources?.open ?? null;
  return (
    <div class="source-list" data-testid="source-list">
      {groups.map((group, index) => {
        const source = firstSource(state, group);
        const meta = source.kind === 'original' ? originalMeta(source, group, 'passages') : '';
        return (
          <button type="button" key={index} class={`source-row${open === index ? ' on' : ''}`} data-testid="source-row" aria-pressed={open === index}
            title={source.kind === 'original' ? source.label : undefined} onClick={() => chooseSource(index)}>
            <span class="marker">{index + 1}</span>
            <KindIcon kind={group.kind} />
            <span class="label">{sourceName(source, state.sources)}</span>
            {meta && <span class="meta">{meta}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** An earlier question and, collapsed, two lines of its answer. A click shows or hides the rest. */
function EarlierTurn({ turn }: { turn: AskTurn }) {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" class={`earlier${open ? ' open' : ''}`} data-testid="earlier-turn" aria-expanded={open} title={turn.scopeName}
      onClick={() => setOpen(!open)}>
      <span class="q">{turn.question}</span>
      <span class="a">{turn.answer.text}</span>
    </button>
  );
}

/** How long Copy answer says Copied. */
const COPIED_MS = 1_600;

/** The current answer: its sources, and what can be done with it. */
function CurrentAnswer({ state, turn }: { state: State; turn: AskTurn }) {
  const thread = state.ask!;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div class="turn">
      <div class="question selectable" data-testid="question">{turn.question}</div>
      <div class="asked">{turn.scopeName}</div>
      <AgenticAnswer state={state} turn={turn} />
      {foundNothingInProject(turn) && (
        <div class="project-empty" data-testid="project-empty">
          <span>Nothing in {turn.scopeName} matched.</span>
          {!thread.failed && (
            <button type="button" class="link-button" data-testid="ask-everywhere" onClick={askEverywhere}>Ask across everything you can see</button>
          )}
        </div>
      )}
      <SourceList state={state} />
      <div class="actions">
        <button type="button" class="link-button" data-testid="copy-answer" aria-label={copied ? 'Answer copied' : 'Copy answer'}
          onClick={() => void copyAnswer().then(done => setCopied(done))}>{copied ? 'Copied' : 'Copy answer'}</button>
        {/* A question that failed below has its own Try again. */}
        {!thread.failed && (
          <button type="button" class="link-button" data-testid="ask-again" onClick={() => void ask(turn.question, turn.scope)}>Try again</button>
        )}
      </div>
    </div>
  );
}

/**
 * The Ask thread: earlier answers collapsed at the top, the current answer,
 * then a question on its way or one that failed. Newest at the bottom.
 */
export function AskView({ state }: { state: State }) {
  const thread = state.ask!;
  const scroller = useRef<HTMLElement>(null);
  // A new question, answer or failure scrolls to the bottom.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [thread.seq, thread.shown, thread.asking, thread.failed]);
  const { asking, failed } = thread;
  return (
    <section class="ask" data-testid="ask-view" aria-live="polite" ref={scroller}>
      {earlierTurns(thread).map(turn => <EarlierTurn key={turn.id} turn={turn} />)}
      {thread.shown && <CurrentAnswer key={thread.shown.id} state={state} turn={thread.shown} />}
      {asking && (
        <div class="turn">
          <div class="question selectable" data-testid="question">{asking.question}</div>
          <div class="asked">{asking.scopeName}</div>
          <Asking />
        </div>
      )}
      {failed && (
        <div class="turn" data-testid="ask-failed">
          <div class="question selectable">{failed.question}</div>
          <div class="asked">{failed.scopeName}</div>
          <div class="error" data-testid="ask-error">{message(failed.failure)}</div>
          {failed.failure.retryable && (
            <div class="actions">
              <button type="button" class="link-button" data-testid="ask-retry" onClick={() => void ask(failed.question, failed.scope)}>Try again</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Asking() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, []);
  return <div class="asking" data-testid="asking">
    <i /><i /><i /><span>Thinking… {elapsed}s</span>
    <button type="button" class="link-button" data-testid="ask-cancel" onClick={cancelAsk}>Cancel</button>
  </div>;
}

/** A decision, action or rationale, and the excerpts that support it. */
function Item({ item }: { item: RecordItem }) {
  return (
    <div class="record-item">
      {item.status && <div class="status">{item.status === 'proposed' ? 'Proposed' : 'Unresolved'}</div>}
      <div>{item.text}</div>
      {item.owner && <div class="owner" data-testid="record-owner">Owner: {item.owner}</div>}
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

const VISIBILITY: Record<ApprovedRecord['visibility'], string> = {
  organization: 'Visible to active organization members', project: 'Visible to project members', approver: 'Only the approver',
};

/**
 * MEETING · APPROVED RECORD: who approved it, who was there, who can read it,
 * and what was approved. In the source pane, and in the reader.
 */
export function RecordDetail({ record }: { record: ApprovedRecord }) {
  const participants = [...record.participants, ...(record.participants_more ? ['Additional participants not shown'] : [])];
  return (
    <div class="source-detail selectable" data-testid="record">
      <h2>{record.title ?? UNTITLED}</h2>
      {record.started_at && <div class="meta">{meetingTime(record.started_at, record.timezone, record.all_day)}</div>}
      <dl class="fields">
        {record.approved_by && <><dt>Record approved by</dt><dd>{record.approved_by}</dd></>}
        {participants.length > 0 && <><dt>Participants</dt><dd>{participants.join(', ')}</dd></>}
        <dt>Visibility</dt>
        <dd data-testid="record-visibility">{VISIBILITY[record.visibility]}</dd>
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

function SlackSource({ source, index }: { source: Extract<AnswerSource, { kind: 'slack' }>; index: number }) {
  const [failed, setFailed] = useState(false);
  return <div class="source-detail">
    <h2>{source.label}</h2>
    <button type="button" class="link-button" data-testid="open-slack-source" title={source.permalink}
      onClick={async () => { setFailed(false); setFailed(!(await openSlackSource(index))); }}>Open in Slack</button>
    {failed && <div class="error">Slack could not be opened. Try again.</div>}
  </div>;
}

/** A run of a passage: bold and code as the document marks them. */
function Runs({ runs }: { runs: readonly Inline[] }) {
  return <>{runs.map((run, index) => run.bold ? <strong key={index}>{run.text}</strong> : run.code ? <code key={index}>{run.text}</code> : run.text)}</>;
}

/** A passage's markdown as its document reads: headings, lists, bold. Never markup from the text itself. */
function Passage({ text, label }: { text: string; label: string }) {
  return <>{passageBlocks(text, label).map((block, index) =>
    block.kind === 'heading' ? <h3 key={index}><Runs runs={block.text} /></h3>
      : block.kind === 'paragraph' ? <p key={index}><Runs runs={block.text} /></p>
        : block.ordered ? <ol key={index}>{block.items.map((item, at) => <li key={at}><Runs runs={item} /></li>)}</ol>
          : <ul key={index}>{block.items.map((item, at) => <li key={at}><Runs runs={item} /></li>)}</ul>)}</>;
}

/**
 * An original's cited passages, each its verified evidence at most 2,000
 * characters. A sentence's number lights the passages it cites, when it cites
 * only some of them.
 */
function OriginalSource({ state, group, source }: { state: State; group: SourceGroup; source: Extract<AnswerSource, { kind: 'original' }> }) {
  const sources = state.sources!;
  const reads = sources.evidence?.group === sources.open ? sources.evidence.reads : {};
  const count = group.indexes.length;
  const meta = originalMeta(source, group, 'passages cited');
  const focused = sentences(state.ask!.shown!.answer).find(([id]) => id === sources.focus)?.[1].citation_indexes ?? [];
  const lit = group.indexes.filter(index => focused.includes(index));
  const light = lit.length > 0 && lit.length < count;
  const all = group.indexes.map(index => reads[index] ?? { loading: true } as const);
  const failure = all.find(read => !read.loading && 'failure' in read);
  return (
    <div class="source-detail">
      <h2>{documentName(source.label).name}</h2>
      {meta && <div class="meta" data-testid="source-meta">{meta}</div>}
      {failure && !failure.loading && 'failure' in failure && (
        <div class="source-failure">
          <div class="error" data-testid="source-error">{message(failure.failure)}</div>
          <button type="button" class="link-button" data-testid="retry-evidence" onClick={retryEvidence}>Try again</button>
        </div>
      )}
      {group.indexes.map((index, at) => {
        const read = all[at]!;
        if (read.loading || !('value' in read)) return null;
        const text = read.value.text.length > MAX_EVIDENCE ? `${read.value.text.slice(0, MAX_EVIDENCE)}…` : read.value.text;
        return (
          <div key={index} class={`passage selectable${light && lit.includes(index) ? ' on' : ''}`} data-testid="evidence-text">
            <Passage text={text} label={source.label} />
          </div>
        );
      })}
      {all.some(read => read.loading) && <div class="notice">Loading verified evidence…</div>}
    </div>
  );
}

/** Beside the answer: an approved record, an original's cited passages, or a link to a live Slack message. */
export function SourcePane({ state }: { state: State }) {
  const sources = state.sources!;
  const open = sources.open!;
  const group = answerGroups(state)[open];
  if (!group) return null;
  const source = firstSource(state, group);
  let body;
  if (source.kind === 'record') {
    const read = sources.records[source.record.record_sha256];
    body = !read || read.loading ? <div class="notice">Loading…</div>
      : 'failure' in read ? (
        <div class="source-failure">
          <div class="error" data-testid="source-error">{message(read.failure)}</div>
          {read.failure.retryable && <button type="button" class="link-button" onClick={retryRecord}>Try again</button>}
        </div>
      ) : <RecordDetail record={read.value} />;
  } else if (source.kind === 'slack') {
    body = <SlackSource key={source.permalink} source={source} index={group.indexes[0]!} />;
  } else {
    body = <OriginalSource state={state} group={group} source={source} />;
  }
  return (
    <aside class="source-pane" data-testid="source-pane" aria-label="Source">
      <div class="pane-head">
        <div class="pane-kind">
          <span class="marker on">{open + 1}</span>
          <span class="section-label">{source.kind === 'record' ? 'Meeting · Approved record' : source.kind === 'slack' ? 'Slack message' : 'Original source'}</span>
        </div>
        <button type="button" class="icon-button" aria-label="Close sources" data-testid="source-close" onClick={closeSources}><Close /></button>
      </div>
      {body}
    </aside>
  );
}
