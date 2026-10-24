import { Fragment, type ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type {
  Answer, AnswerBlock, AnswerPart, AnswerSource, AskReceipt, AskSearched, ExternalAnswerSource, AnswerStatement, ApprovedRecord, Match, OpenItemView, RecordItem,
  ToolContainerKind,
} from '../../shared/protocol.js';
import { askText, queryTerms } from '../../shared/query.js';
import {
  answerSentences, coverage, documentName, dueColumn, externalSourceProvider, lateForYou, passageBlocks, rowId, rowStatement, statementGroups, tableDay, yoursIn,
  type AnswerTable, type Inline, type SourceGroup,
} from '../answer.js';
import { marked, meetingTime, snippet, when } from '../format.js';
import { message } from '../messages.js';
import { checkWords, ownerAndStatus } from '../needs.js';
import { sourceKey } from '../openers.js';
import {
  announceAfter, announcement, duration, foundBefore, headline, liveRows, namedPlaces, placeLabel, PROGRESS_AFTER_MS, receiptWords, searchedWords, type AskProgress,
  type LiveRow, type NamedPlace,
} from '../progress.js';
import {
  answerGroups, answerSources, ask, askEverywhere, askSuggestion, barSuggestions, cancelAsk, chipName, chooseSource, closeSources, copyAnswer, earlierTurns, foundNothingInProject,
  fullPageOffered, litAtoms, matchesShown, openCompose, openFullPage, openMatch, openExternalSource, openNamed, pageCovered, paneCitations, paneTarget, retryEvidence, retryRecord,
  searchAgain, setBarText, sourceName, submitBar, suggestionsShown, toggleSourceList, widenScope, UNTITLED, type AskTurn, type PaneTarget, type Read, type RecordSectionKey,
  type State,
} from '../store.js';
import { MAX_QUESTION, questionCount } from '../bar.js';
import { Caret, Check, Chevron, Close, Doc, Folder, Info, Lock, Meeting, OnePerson, Plug, Plus, Ticks, Up } from './icons.js';

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
 * "Try asking": the empty bar's suggestions, over the page where live matches
 * show. The caret stays in the bar: the arrow keys light one, and Return or a
 * click asks it.
 */
function Suggestions({ questions, active, onPick }: { questions: readonly string[]; active: number; onPick: (question: string) => void }) {
  return (
    <div class="matches suggestions" data-testid="suggestions" id="ask-suggestions" role="listbox" aria-label="Try asking">
      <div class="matches-head" aria-hidden="true">Try asking</div>
      {questions.map((question, index) => (
        <div key={question} id={`ask-suggestion-${index}`} role="option" aria-selected={index === active} data-testid="suggestion"
          class={`match-row suggestion${index === active ? ' active' : ''}`} onMouseDown={event => event.preventDefault()} onClick={() => onPick(question)}>
          <Up /><span class="label">{question}</span>
        </div>
      ))}
    </div>
  );
}

const CLOSED = { open: false, active: -1 };

/**
 * The one bar on every page. ⊕ captures and Return asks, both in the bar's
 * scope; typing shows live matches in it. The chip names a project scope, or
 * Mine, which is only asked; its × widens to all context without moving the
 * page. Mine is not a place to capture: it has no ⊕.
 *
 * Going to the empty bar (a click, or an arrow key) offers what to ask in its
 * scope; the caret only waiting there, as it does whenever the window comes
 * forward, offers nothing. Typing, Escape or leaving the bar closes them.
 * From 200 characters the bar counts them, and at its limit says why it stops.
 */
export function Bar({ state }: { state: State }) {
  // While another app is in front nothing says which project is open, or what
  // was typed over a covered page: the text is kept, and shows again on return.
  const chip = chipName(state);
  const covered = pageCovered(state);
  const text = covered ? '' : state.barText;
  const verb = state.ask || (chip !== null && state.barScope.kind === 'mine') ? 'Ask' : 'Search or ask';
  const name = `${verb} ${chip ?? 'ECHO'}`;
  const [suggesting, setSuggesting] = useState(CLOSED);
  const shown = suggesting.open && suggestionsShown(state) ? barSuggestions(state) : [];
  const active = shown.length === 0 ? -1 : Math.min(suggesting.active, shown.length - 1);
  // Another page, project or scope: the suggestions were for the one before.
  const where = `${state.route.page === 'project' ? state.route.project.project_id : state.route.page} ${state.barScope.kind}`;
  useEffect(() => { setSuggesting(CLOSED); }, [where]);
  const pick = (question: string) => { setSuggesting(CLOSED); askSuggestion(question); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (text !== '' || !suggestionsShown(state)) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const last = (shown.length > 0 ? shown.length : barSuggestions(state).length) - 1;
      // The list is above the bar: Up goes into it from the bar, Down past its last row comes back to the bar.
      if (shown.length === 0) setSuggesting({ open: true, active: event.key === 'ArrowUp' ? last : 0 });
      else if (event.key === 'ArrowUp') setSuggesting({ open: true, active: active === -1 ? last : Math.max(0, active - 1) });
      else setSuggesting({ open: true, active: active >= last ? -1 : active + 1 });
      return;
    }
    if (shown.length === 0) return;
    if (event.key === 'Enter' && active >= 0) { event.preventDefault(); pick(shown[active]!); return; }
    // Escape closes the suggestions only: the window's Escape would go back a level.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSuggesting(CLOSED); }
  };
  const count = covered ? null : questionCount(text);
  return (
    <div class={`bar-wrap${state.ask && !covered ? ' with-ask' : ''}`}>
      {matchesShown(state) && <Matches state={state} scopeName={chip} />}
      {shown.length > 0 && <Suggestions questions={shown} active={active} onPick={pick} />}
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
          id="ask-field" data-testid="ask-field" type="text" autocomplete="off" spellcheck maxLength={MAX_QUESTION} placeholder={name}
          role="combobox" aria-autocomplete="list" aria-expanded={shown.length > 0} aria-controls={shown.length > 0 ? 'ask-suggestions' : undefined}
          aria-activedescendant={active >= 0 ? `ask-suggestion-${active}` : undefined} aria-describedby={count?.full ? 'ask-limit' : undefined}
          value={text} readOnly={covered} onMouseDown={() => { if (text === '') setSuggesting({ open: true, active: -1 }); }} onKeyDown={onKeyDown}
          onBlur={() => setSuggesting(CLOSED)}
          onInput={event => { setSuggesting(CLOSED); setBarText((event.target as HTMLInputElement).value); }}
        />
        {count && <span class={`bar-count${count.full ? ' full' : ''}`} data-testid="ask-count" aria-hidden="true">{count.words}</span>}
        <button type="submit" class="circle primary" aria-label="Ask" data-testid="ask-send"
          disabled={text.trim() === '' || Boolean(state.ask?.asking)}><Up /></button>
      </form>
      {/* Always there, so a screen reader hears it when the limit is reached; the page's one status line stays the toast's. */}
      <div id="ask-limit" class={count?.full ? 'bar-note' : 'sr-only'} aria-live="polite" data-testid="ask-limit">{count?.full ? `Questions are up to ${MAX_QUESTION} characters` : ''}</div>
    </div>
  );
}

/** A source's first citation stands for it: its kind, its label, its record or its link. */
function firstSource(state: State, group: SourceGroup): AnswerSource {
  return answerSources(state)[group.indexes[0]!]!;
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

/** Whether the sentence or row `id` is lit: its number opened the pane. */
function lit(state: State, id: string): boolean {
  return state.sources?.open != null && state.sources.focus === id;
}

/** A sentence and the numbers of its sources. The one whose number opened the pane is lit. */
function Statement({ state, statement, id }: { state: State; statement: AnswerStatement; id: string }) {
  const on = lit(state, id);
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

/** A sentence of the lead or a paragraph, inline with the others: its text and its numbers, lit on its own. */
function Claim({ state, statement, id }: { state: State; statement: AnswerStatement; id: string }) {
  return (
    <span class={`claim${lit(state, id) ? ' on' : ''}`} data-testid="statement">
      <span data-testid="statement-text">{statement.text}</span>
      <Markers state={state} statement={statement} id={id} />
    </span>
  );
}

/** The sentences of a lead or a paragraph, one after another, each with its own numbers. */
function Claims({ state, part, index, statements }: { state: State; part: AnswerPart; index: number; statements: readonly number[] }) {
  return <>{statements.map((place, at) => <Fragment key={place}>{at > 0 && ' '}
    <Claim state={state} statement={part.statements[place]!} id={`${index}.${place}`} /></Fragment>)}</>;
}

/** One cell of a table that is not its first: an ISO date as "Oct 14" in mono, late when the row is yours and late; you, as the owner, heavier. */
function Cell({ cell, late, you }: { cell: string; late: boolean; you: boolean }) {
  const day = tableDay(cell);
  if (day !== null) {
    return <td class={`day${late ? ' late' : ''}`}><time dateTime={cell}>{day}</time>{late && <span class="sr-only">, overdue</span>}</td>;
  }
  const kind = [you ? 'you' : '', [...cell].length <= 32 ? 'short' : ''].filter(Boolean).join(' ');
  return <td class={kind || undefined}>{cell}</td>;
}

/**
 * A table of a laid-out part, in its own box that scrolls when the window is
 * narrow; the page never does. Its caption above it, in the lead's type when
 * the table opens the answer (`opens`). Each row's numbers are in its first
 * cell, and a row is lit on its own. Only your row's late due date is in the
 * signal colour.
 */
function Table({ state, sources, index, block, place, opens, label }: {
  state: State; sources: readonly AnswerSource[]; index: number; block: AnswerTable; place: number; opens: boolean; label: string;
}) {
  const me = state.status?.account?.display_name ?? null;
  const due = dueColumn(block.columns);
  return <>
    {block.caption && <p class={`${opens ? 'answer-lead' : 'answer-caption'} selectable`}>{block.caption}</p>}
    <div class="answer-table selectable" role="region" tabIndex={0} aria-label={block.caption ?? label}>
      <table class={`cols-${block.columns.length}`}>
        <thead><tr>{block.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>
          {block.rows.map((row, at) => {
            const id = rowId(index, place, at);
            const late = lateForYou(block.columns, row.cells, me);
            return (
              <tr key={at} class={lit(state, id) ? 'on' : undefined} data-testid="answer-row">
                {row.cells.map((cell, column) => column === 0
                  ? <td key={column}><span class="first">{cell}<Markers state={state} statement={rowStatement(row, sources)} id={id} /></span></td>
                  : <Cell key={column} cell={cell} late={late && column === due} you={yoursIn(block.columns[column]!, cell, me)} />)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </>;
}

/**
 * A laid-out part (answer layout v1, ADR-0045), in the desktop's own type:
 * the lead, its first sentence heavier; headings; paragraphs; bullets; and
 * tables. Every sentence and row keeps its own numbers and is lit on its own.
 * `opening`: the part opens the answer, so a table first has no lead above it.
 */
function LaidOut({ state, sources, part, index, layout, opening }: {
  state: State; sources: readonly AnswerSource[]; part: AnswerPart; index: number; layout: readonly AnswerBlock[]; opening: boolean;
}) {
  // A table without a caption is named by the heading above it.
  let heading = 'Table';
  return (
    <div class="answer-layout">
      {layout.map((block, place) => {
        if (block.kind === 'heading') { heading = block.text; return <h3 key={place} class="answer-heading">{block.text}</h3>; }
        if (block.kind === 'lead') return <p key={place} class="answer-lead selectable"><Claims state={state} part={part} index={index} statements={block.statements} /></p>;
        if (block.kind === 'paragraph') return <p key={place} class="answer-paragraph selectable"><Claims state={state} part={part} index={index} statements={block.statements} /></p>;
        if (block.kind === 'bullets') {
          return (
            <ul key={place} class="answer-bullets selectable">
              {block.statements.map(at => {
                const id = `${index}.${at}`;
                const statement = part.statements[at]!;
                return <li key={at} class={lit(state, id) ? 'on' : undefined} data-testid="statement">
                  <span><span data-testid="statement-text">{statement.text}</span><Markers state={state} statement={statement} id={id} /></span>
                </li>;
              })}
            </ul>
          );
        }
        return <Table key={place} state={state} sources={sources} index={index} block={block} place={place} opens={opening && place === 0} label={heading} />;
      })}
    </div>
  );
}

/**
 * What research did not cover, as one quiet note after the answer, never a
 * banner over it: the notice, then each part's gap, after its part's
 * question when there are several.
 */
function CoverageNote({ answer }: { answer: Answer }) {
  const { notice, gaps } = coverage(answer);
  if (!notice && gaps.length === 0) return null;
  return (
    <p class="coverage-note selectable" data-testid="coverage-note">
      <Info />
      <span>
        {notice && <span data-testid="answer-notice">{notice}</span>}
        {gaps.map((gap, at) => <Fragment key={at}>{(notice || at > 0) && ' '}
          {gap.question && <span class="part">{gap.question} </span>}<span data-testid="answer-gap">{gap.text}</span></Fragment>)}
      </span>
    </p>
  );
}

/**
 * The answer: an assumption or an off-scope line on top, then each part, laid
 * out when it carries a layout and a paragraph per sentence when not, then
 * what research did not cover. A part with nothing to show is left out: its
 * gap is in the note.
 */
function AgenticAnswer({ state, turn }: { state: State; turn: AskTurn }) {
  const answer = turn.answer;
  return (
    <div class="agentic-answer" data-testid="answer">
      {answer.assumption && <div class="answer-banner" data-testid="answer-assumption">{answer.assumption}</div>}
      {answer.outcome === 'off_scope' && <div class="answer-banner" data-testid="answer-off-scope">The accessible evidence may be about a different subject.</div>}
      {answer.direct && <Statement state={state} statement={answer.direct} id="direct" />}
      {answer.parts.map((part, index) => part.statements.length === 0 && !part.records?.length ? null : (
        <section class="answer-part" key={index}>
          {/* One part answers the question itself: its label would repeat it. */}
          {answer.parts.length > 1 && <div class="section-label">{part.question}</div>}
          {part.layout
            ? <LaidOut state={state} sources={answer.sources} part={part} index={index} layout={part.layout} opening={index === 0 && !answer.direct} />
            : part.statements.map((statement, place) => <Statement key={place} state={state} statement={statement} id={`${index}.${place}`} />)}
          {part.records?.map((statement, place) => <Found key={`record-${place}`} state={state} statement={statement} id={`${index}.r${place}`} />)}
        </section>
      ))}
      <CoverageNote answer={answer} />
    </div>
  );
}

/** An original's version, and how many of its passages the answer cites when more than one: "v0.1 · 3 passages". */
function originalMeta(source: Extract<AnswerSource, { kind: 'original' }>, group: SourceGroup, passages: string): string {
  const { version } = documentName(source.label);
  const count = group.indexes.length;
  return [version, count > 1 ? `${count} ${passages}` : undefined].filter(Boolean).join(' · ');
}

/**
 * A source's mark: a meeting, a follow-up, a project (yours in ECHO, a Jira
 * project or a Confluence space), a person, a tool, or a document, ticket or
 * page.
 */
function KindIcon({ source }: { source: AnswerSource }) {
  if (source.kind === 'record') return <Meeting />;
  if (source.kind === 'follow_up') return <Ticks />;
  if (source.kind === 'project' || source.kind === 'container') return <Folder />;
  if (source.kind === 'person') return <OnePerson />;
  return source.kind === 'tool' ? <Plug /> : <Doc />;
}

/** A follow-up's row as read now, once it is: its owner and status ("Mara · Open"), nothing while it is read or when it could not be. */
function followUpRow(state: State, source: Extract<AnswerSource, { kind: 'follow_up' }>): OpenItemView | null {
  const read = state.sources?.followUps[source.item_id];
  return read !== undefined && !read.loading && 'value' in read ? read.value : null;
}

/** A Jira project's or Confluence space's tool, and its key there when it has one: "Jira · THERM", "Confluence". */
function containerMeta(source: Extract<AnswerSource, { kind: 'container' }>, provider: string): string {
  return source.key === undefined ? provider : `${provider} · ${source.key}`;
}

/** A source's name on the sources' line: up to its first " · ", so a ticket is its key. */
function shortName(name: string): string {
  return name.split(' · ')[0]!;
}

/**
 * The answer's sources: one line, "4 sources · Tuesday sync · Apollo update",
 * that opens onto a row per source, numbered as the sentences cite it. It
 * starts closed (ADR-0045). Citation numbers open the source pane without
 * expanding this list. If expanded explicitly, the row the pane shows is lit.
 */
function SourceList({ state }: { state: State }) {
  const groups = answerGroups(state);
  if (groups.length === 0) return null;
  const open = state.sources?.open ?? null;
  const listed = state.sources?.listed === true;
  const names = groups.map(group => sourceName(firstSource(state, group), state.sources));
  return (
    <div class="source-list" data-testid="source-list">
      <button type="button" class={`sources-toggle${listed ? ' open' : ''}`} data-testid="sources-toggle" aria-expanded={listed} onClick={toggleSourceList}>
        <span class="count">{groups.length === 1 ? '1 source' : `${groups.length} sources`}</span>
        <span class="names">{names.map(shortName).join(' · ')}</span>
        <Caret />
      </button>
      {listed && <div class="source-rows">{groups.map((group, index) => {
        const source = firstSource(state, group);
        // One short qualifier only where it helps: a document's version and passages, a follow-up's owner and status, a
        // container's tool and key. A project, a person and a tool are named by their label alone.
        const row = source.kind === 'follow_up' ? followUpRow(state, source) : null;
        const meta = source.kind === 'original' ? originalMeta(source, group, 'passages')
          : source.kind === 'container' ? containerMeta(source, externalSourceProvider(source, state.tools?.items))
            : row ? ownerAndStatus(row, state.status?.account?.membership_id) : '';
        return (
          <button type="button" key={index} class={`source-row${open === index ? ' on' : ''}`} data-testid="source-row" aria-pressed={open === index}
            title={source.kind === 'original' ? source.label : undefined} onClick={() => chooseSource(index)}>
            <span class="marker">{index + 1}</span>
            <KindIcon source={source} />
            <span class="label">{names[index]}</span>
            {meta && <span class="meta">{meta}</span>}
          </button>
        );
      })}</div>}
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
function CurrentAnswer({ state, turn, line }: { state: State; turn: AskTurn; line: Line }) {
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
      {turn.receipt && <Receipt state={state} receipt={turn.receipt} took={turn.took ?? 0} line={line} />}
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

/** How near its bottom the thread counts as read to the end: a new row of the Ask on its way follows it there. */
const FOLLOW_PX = 40;

/**
 * The Ask thread: earlier answers collapsed at the top, the current answer,
 * then a question on its way or one that failed. Newest at the bottom.
 */
export function AskView({ state }: { state: State }) {
  const thread = state.ask!;
  const scroller = useRef<HTMLElement>(null);
  // Whether the person was at the bottom when they last scrolled, or the thread last took them there.
  const atBottom = useRef(true);
  // Where the thread last put the view: the scroll event that records a person's scroll can arrive after a new row.
  const placedAt = useRef<number | null>(null);
  const toBottom = () => {
    const view = scroller.current;
    if (view) { view.scrollTop = view.scrollHeight; placedAt.current = view.scrollTop; }
    atBottom.current = true;
  };
  // A new question, answer or failure scrolls to the bottom.
  useLayoutEffect(toBottom, [thread.seq, thread.shown, thread.asking === null, thread.failed]);
  // A row of the question on its way only when the person is there: one who scrolled up to read stays put, even before
  // their scroll event has arrived, because the view is no longer where the thread left it.
  const follow = useCallback(() => {
    const view = scroller.current;
    if (view && placedAt.current !== null && view.scrollTop < placedAt.current - FOLLOW_PX) atBottom.current = false;
    if (atBottom.current) toBottom();
  }, []);
  const onScroll = () => {
    const view = scroller.current;
    if (view) atBottom.current = view.scrollHeight - view.scrollTop - view.clientHeight < FOLLOW_PX;
  };
  // Which Ask's line is open: the question on its way and its answer share an id, so a line opened while Ask works
  // stays open as its receipt, and the next question's line starts closed.
  const [openFor, setOpenFor] = useState<number | null>(null);
  const lineFor = (id: number): Line => ({ open: openFor === id, toggle: () => setOpenFor(openFor === id ? null : id) });
  const { asking, failed } = thread;
  return (
    <section class="ask" data-testid="ask-view" aria-live="polite" ref={scroller} onScroll={onScroll}>
      {earlierTurns(thread).map(turn => <EarlierTurn key={turn.id} turn={turn} />)}
      {thread.shown && <CurrentAnswer key={thread.shown.id} state={state} turn={thread.shown} line={lineFor(thread.shown.id)} />}
      {asking && (
        <div class="turn">
          <div class="question selectable" data-testid="question">{asking.question}</div>
          <div class="asked">{asking.scopeName}</div>
          <Asking state={state} progress={asking.progress} follow={follow} line={lineFor(thread.seq)} />
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

/** How often the live line's timer moves. */
const TICK_MS = 250;

/** `text`, said to a screen reader at most every few seconds: the latest text once the wait is over. */
function useAnnouncement(text: string): string {
  const [said, setSaid] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    const wait = announceAfter(text, said, Date.now());
    if (wait === null) return;
    const timer = setTimeout(() => setSaid({ text, at: Date.now() }), wait);
    return () => clearTimeout(timer);
  }, [text, said]);
  return said?.text ?? '';
}

/** Whether an Ask's line is open, and the toggle that opens or closes it. */
interface Line {
  readonly open: boolean;
  readonly toggle: () => void;
}

/**
 * The question on its way: one quiet line (a pulse, the step now, how long,
 * Cancel) that opens, once Ask has worked a few seconds and has rows, onto
 * every search and read so far. Each name opens beside Ask, which keeps
 * running. The section is a live region: the line, its timer and its rows are
 * kept out of it, and a screen reader hears the stage at most every few
 * seconds instead.
 */
function Asking({ state, progress, follow, line }: { state: State; progress: AskProgress; follow: () => void; line: Line }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, now - progress.started);
  // A quick Ask shows nothing more than it always did.
  const live = elapsed >= PROGRESS_AFTER_MS;
  const rows = live ? liveRows(progress) : [];
  const canOpen = rows.length > 0;
  const open = line.open && canOpen;
  // The line never changes height; its rows, opened, and each new one, are followed by a person at the bottom.
  useLayoutEffect(() => { if (open) follow(); }, [open, open && progress.rows.length, open && progress.pending > 0, follow]);
  // Heard at once, as the line always was; then the stage, once it shows, at most every few seconds.
  const heard = useAnnouncement(live ? announcement(progress) || 'Thinking…' : 'Thinking…');
  const words = <>
    <i class="pulse" aria-hidden="true" />
    <span class="headline working" data-testid="ask-stage">{live ? headline(progress) : 'Thinking…'}</span>
    <span class="timer" data-testid="ask-timer" aria-hidden="true">{duration(elapsed)}</span>
  </>;
  return <>
    <div class="ask-trail" aria-live="off">
      <div class="ask-line" data-testid="asking">
        {canOpen ? (
          <button type="button" class={`ask-line-toggle${open ? ' open' : ''}`} data-testid="ask-line" aria-expanded={open} onClick={line.toggle}>
            {words}<Chevron />
          </button>
        ) : <span class="ask-line-toggle">{words}</span>}
        <button type="button" class="link-button faint-link" data-testid="ask-cancel" onClick={cancelAsk}>Cancel</button>
      </div>
      {open && (
        <ul class="ask-steps" data-testid="ask-steps" aria-label="What Ask has looked through">
          {rows.map((row, index) => <LiveStep key={index} state={state} row={row} />)}
        </ul>
      )}
    </div>
    <span class="sr-only" aria-live="polite" data-testid="ask-announcement">{heard}</span>
  </>;
}

/** A row's mark: done, or still going. */
function Mark({ done }: { done: boolean }) {
  return done ? <span class="mark"><Check /></span> : <span class="mark" aria-hidden="true"><i /></span>;
}

/** A search: its source kinds, never the words searched, and what it found (`earlier`: a search before it found something). */
function SearchedStep({ state, row, earlier }: { state: State; row: AskSearched; earlier: boolean }) {
  return <li class="ask-step done" data-testid="ask-step"><Mark done /><span class="words">{searchedWords(row, state.tools?.items, earlier)}</span></li>;
}

/** One row of the line, opened: a search, a read with every name it has so far, or how many are being read. */
function LiveStep({ state, row }: { state: State; row: LiveRow }) {
  if (row.type === 'searched') return <SearchedStep state={state} row={row.row} earlier={row.earlier} />;
  if (row.type === 'pending') {
    return (
      <li class="ask-step" data-testid="ask-step"><Mark done={false} />
        <span class="words">Reading {row.count} {row.more ? 'more' : row.count === 1 ? 'item' : 'items'}</span></li>
    );
  }
  return (
    <li class={`ask-step${row.done ? ' done' : ''}`} data-testid="ask-step"><Mark done={row.done} />
      <span class="words">{row.done ? 'Read' : 'Reading'} <Names state={state} places={namedPlaces(row.row.items)} /></span>
    </li>
  );
}

/**
 * Names, each opening its place beside Ask with every item of it the name
 * stands for, and how many when more than one ("Tuesday sync ×4"). The one
 * the pane shows is lit: its first item read, which stays as a live row's
 * place reads more.
 */
function Names({ state, places }: { state: State; places: readonly NamedPlace[] }) {
  const first = state.sources?.named?.[0];
  const shown = first ? sourceKey(first) : null;
  return <>{places.map(({ source, items }, index) => {
    const on = shown === sourceKey(source);
    const label = placeLabel(source);
    const count = items.length;
    return <span key={sourceKey(source)}>{index > 0 && ', '}
      <button type="button" class={`step-name${on ? ' on' : ''}`} data-testid="ask-step-name" aria-pressed={on}
        aria-label={count > 1 ? `${label}, ${count} items` : undefined} onClick={() => openNamed(items)}>
        {label}{count > 1 && <span class="count"> ×{count}</span>}</button></span>;
  })}</>;
}

/**
 * Above an answer that took a while: the Ask's line, in place, as one dim
 * receipt, "Looked through 58 items · 48s ›", that opens the searches and
 * reads the Authority audited, each name opening beside the answer. A line
 * opened while Ask worked stays open. The searches' found counts and the
 * names account for what it looked through (ADR-0043).
 */
function Receipt({ state, receipt, took, line }: { state: State; receipt: AskReceipt; took: number; line: Line }) {
  const { open } = line;
  return (
    <div class="ask-trail">
      <div class="ask-line">
        <button type="button" class={`ask-line-toggle${open ? ' open' : ''}`} data-testid="ask-receipt" aria-expanded={open} onClick={line.toggle}>
          <span>{receiptWords(receipt, took)}</span><Chevron />
        </button>
      </div>
      {open && (
        // Kept out of the thread's live region, as the running line's rows are: a receipt that comes open is not read out row by row.
        <ul class="ask-steps" data-testid="receipt-rows" aria-live="off">
          {receipt.rows.map((row, index) => row.type === 'searched' ? <SearchedStep key={index} state={state} row={row} earlier={foundBefore(receipt.rows, index)} />
            : <li key={index} class="ask-step done" data-testid="ask-step"><Mark done /><span class="words">Read <Names state={state} places={namedPlaces(row.items)} /></span></li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * A decision, action or rationale, and the excerpts that support it. One an
 * answer cites is lit (`on`), and says so to a screen reader, not by colour alone.
 */
function Item({ item, on = false }: { item: RecordItem; on?: boolean }) {
  return (
    <div class={`record-item${on ? ' on' : ''}`} data-cited={on ? 'true' : undefined}>
      {on && <span class="sr-only">Cited: </span>}
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

/** Whether an item of a record is lit: by its section, its place there, and the item. */
export type LitItem = (section: RecordSectionKey, index: number, item: RecordItem) => boolean;

/** The items an answer or a named item cites, by atom id: as the pane lights them. */
function byAtom(atoms: ReadonlySet<string>): LitItem {
  return (_section, _index, item) => item.atom_id !== undefined && atoms.has(item.atom_id);
}

/**
 * MEETING · APPROVED RECORD: who approved it, who was there, who can read it,
 * and what was approved. In the source pane, and in the reader, whose own
 * head names it and who can read it (`headed` false). The items an answer or
 * a named item cites are lit (`lit`): in the pane by atom id, in the reader
 * by their place. The first is scrolled into view once it shows.
 */
export function RecordDetail({ record, headed = true, lit }: { record: ApprovedRecord; headed?: boolean; lit?: LitItem }) {
  const participants = [...record.participants, ...(record.participants_more ? ['Additional participants not shown'] : [])];
  const detail = useRef<HTMLDivElement>(null);
  const on = (section: RecordSectionKey, index: number, item: RecordItem) => lit?.(section, index, item) === true;
  const found = SECTIONS.flatMap(([key]) => record[key].items.map((item, index) => [key, index, item] as const)).find(([key, index, item]) => on(key, index, item));
  // Which item is first lit, so a later page read under it never scrolls back.
  const first = found === undefined ? undefined : `${found[0]}:${found[1]}:${found[2].atom_id ?? ''}`;
  useLayoutEffect(() => {
    if (first !== undefined) detail.current?.querySelector('[data-cited="true"]')?.scrollIntoView({ block: 'center' });
  }, [first]);
  return (
    <div class="source-detail selectable" data-testid="record" ref={detail}>
      {headed && <h2>{record.title ?? UNTITLED}</h2>}
      {record.started_at && <div class="meta">{meetingTime(record.started_at, record.timezone, record.all_day)}</div>}
      <dl class="fields">
        {record.approved_by && <><dt>Record approved by</dt><dd>{record.approved_by}</dd></>}
        {participants.length > 0 && <><dt>Participants</dt><dd>{participants.join(', ')}</dd></>}
        {headed && <><dt>Visibility</dt><dd data-testid="record-visibility">{VISIBILITY[record.visibility]}</dd></>}
      </dl>
      {SECTIONS.map(([key, heading, kind]) => {
        const section = record[key];
        if (section.items.length === 0) return null;
        return (
          <div key={key} class="record-section" data-testid={`record-${key}`}>
            <div class="section-label">{heading}</div>
            {section.items.map((item, index) => <Item key={index} item={item} on={on(key, index, item)} />)}
            {section.more && <div class="record-item">Additional approved {kind} items are not shown.</div>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Live evidence beside Ask: its label, and Open in its own app, where the tool
 * checks your access. A Jira project or Confluence space also says its tool
 * and key, in its source row's words ("Jira · THERM").
 */
function ExternalSource({ source, provider }: { source: ExternalAnswerSource; provider: string }) {
  return <div class="source-detail">
    <h2>{source.label}</h2>
    {source.kind === 'container' && <div class="meta" data-testid="pane-container-meta">{containerMeta(source, provider)}</div>}
    <OpenIn source={source} provider={provider} />
  </div>;
}

/** Open in its own app, beside Ask or on a follow-up's page (`item`): the tool checks your access, and one it could not open says so. */
export function OpenIn({ source, provider, item = false }: { source: ExternalAnswerSource; provider: string; item?: boolean }) {
  const [failed, setFailed] = useState(false);
  return <>
    <button type="button" class={item ? 'link-button card-side-link' : 'link-button'} data-testid={item ? undefined : `open-${source.kind}-source`}
      title={source.permalink} onClick={async () => { setFailed(false); setFailed(!(await openExternalSource(source))); }}>Open in {provider}</button>
    {failed && <div class="error">The {item ? 'item' : 'source'} could not be opened. Try again.</div>}
  </>;
}

/** A run of a passage: bold and code as the document marks them. */
function Runs({ runs }: { runs: readonly Inline[] }) {
  return <>{runs.map((run, index) => run.bold ? <strong key={index}>{run.text}</strong> : run.code ? <code key={index}>{run.text}</code> : run.text)}</>;
}

/** A passage's markdown as its document reads: headings, lists, bold. Never markup from the text itself. */
export function Passage({ text, label }: { text: string; label: string }) {
  return <>{passageBlocks(text, label).map((block, index) =>
    block.kind === 'heading' ? <h3 key={index}><Runs runs={block.text} /></h3>
      : block.kind === 'paragraph' ? <p key={index}><Runs runs={block.text} /></p>
        : block.ordered ? <ol key={index}>{block.items.map((item, at) => <li key={at}><Runs runs={item} /></li>)}</ol>
          : <ul key={index}>{block.items.map((item, at) => <li key={at}><Runs runs={item} /></li>)}</ul>)}</>;
}

/**
 * An original's cited passages, each its verified evidence at most 2,000
 * characters. A sentence's number lights the passages it cites, when it cites
 * only some of them. A named place's are the passages its name stands for.
 */
function OriginalSource({ state, target, source }: { state: State; target: PaneTarget; source: Extract<AnswerSource, { kind: 'original' }> }) {
  const sources = state.sources!;
  const reads = sources.evidence?.group === target.number ? sources.evidence.reads : {};
  const places = paneCitations(target);
  const count = places.length;
  const meta = target.group ? originalMeta(source, target.group, 'passages cited') : documentName(source.label).version ?? '';
  const answer = state.ask?.shown?.answer;
  const focused = target.group && answer ? answerSentences(answer).find(([id]) => id === sources.focus)?.[1].citation_indexes ?? [] : [];
  const lit = places.filter(index => focused.includes(index));
  const light = lit.length > 0 && lit.length < count;
  const all = places.map(index => reads[index] ?? { loading: true } as const);
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
      {places.map((index, at) => {
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

/** A record the pane reads: loading, could not be read (with Try again when that can help), or the record. */
function ReadRecord<T>({ read, children }: { read: Read<T> | undefined; children: (value: T) => ComponentChildren }) {
  if (!read || read.loading) return <div class="notice">Loading…</div>;
  if ('failure' in read) {
    return (
      <div class="source-failure">
        <div class="error" data-testid="source-error">{message(read.failure)}</div>
        {read.failure.retryable && <button type="button" class="link-button" onClick={retryRecord}>Try again</button>}
      </div>
    );
  }
  return <>{children(read.value)}</>;
}

/** A container, as the pane's head names it after its tool: "Jira · Project", "Confluence · Space". */
const CONTAINER_WORDS: Readonly<Record<ToolContainerKind, string>> = { jira_project: 'Project', confluence_space: 'Space' };

/** What the pane's head calls an item: its kind, or a live tool's name and kind. */
function paneHeading(source: AnswerSource, state: State): string {
  if (source.kind === 'record') return 'Meeting · Approved record';
  if (source.kind === 'original') return 'Original source';
  if (source.kind === 'follow_up') return 'Follow-up';
  if (source.kind === 'project') return 'Project';
  if (source.kind === 'person') return 'Person';
  if (source.kind === 'tool') return 'Tool';
  const provider = externalSourceProvider(source, state.tools?.items);
  if (source.kind === 'container') return `${provider} · ${CONTAINER_WORDS[source.container]}`;
  return `${provider} · ${source.kind === 'ticket' ? 'Ticket' : 'Page'}`;
}

/**
 * A follow-up beside Ask (ADR-0040): its title as the answer cites it, then,
 * in its source row's own words and with no labels, who owns it and its
 * status ("Mina · Open"), and its latest check, as Home reads its row now.
 * Its item page, with everything else, is Open, once the answer came.
 */
function FollowUpSource({ state, source, item }: { state: State; source: Extract<AnswerSource, { kind: 'follow_up' }>; item: OpenItemView }) {
  const checked = checkWords(item.check);
  return (
    <div class="source-detail selectable" data-testid="pane-follow-up">
      <h2>{source.label}</h2>
      <div class="meta" data-testid="pane-follow-up-meta">{ownerAndStatus(item, state.status?.account?.membership_id)}</div>
      {checked && <div class="meta" data-testid="pane-follow-up-check">{checked}</div>}
    </div>
  );
}

/**
 * One of your projects, a person in your organization, or one of your tools
 * beside Ask (research tool contract v1): its name, as the answer cites it,
 * and nothing is read for it. A tool's connection is the answer's to say, as
 * the Authority read it for this Ask; a state Tools read earlier may be stale.
 * Once the answer came, Open goes to the project, or to Tools; a person has no
 * page to open.
 */
function WorkspaceSource({ source }: { source: Extract<AnswerSource, { kind: 'project' | 'person' | 'tool' }> }) {
  return (
    <div class="source-detail selectable" data-testid={`pane-${source.kind}`}>
      <h2>{source.label}</h2>
    </div>
  );
}

/**
 * Beside Ask: one of the answer's sources, or an item Ask named, opened by
 * its kind (openers.ts): a meeting's approved record with the cited items lit,
 * an original's cited passages, a follow-up, a project, a person or a tool, or
 * Open in its own app. Once the answer came, Open goes to the item's own page.
 */
export function SourcePane({ state }: { state: State }) {
  const sources = state.sources!;
  const target = paneTarget(state);
  if (!target) return null;
  const source = target.sources[0]!;
  let body;
  if (source.kind === 'record') {
    body = <ReadRecord read={sources.records[source.record.record_sha256]}>{record => <RecordDetail record={record} lit={byAtom(litAtoms(state, target))} />}</ReadRecord>;
  } else if ('permalink' in source) {
    body = <ExternalSource key={`${source.tool_id}:${source.permalink}`} source={source} provider={externalSourceProvider(source, state.tools?.items)} />;
  } else if (source.kind === 'original') {
    body = <OriginalSource state={state} target={target} source={source} />;
  } else if (source.kind === 'follow_up') {
    body = <ReadRecord read={sources.followUps[source.item_id]}>{item => <FollowUpSource state={state} source={source} item={item} />}</ReadRecord>;
  } else if (source.kind === 'project' || source.kind === 'person' || source.kind === 'tool') {
    body = <WorkspaceSource source={source} />;
  }
  return (
    <aside class="source-pane" data-testid="source-pane" aria-label="Source">
      <div class="pane-head">
        <div class="pane-kind">
          {target.number !== null && <span class="marker on">{target.number + 1}</span>}
          <span class="section-label">{paneHeading(source, state)}</span>
        </div>
        <div class="pane-actions">
          {/* While Ask works there is no Open: leaving Ask would cancel it. */}
          {fullPageOffered(state) && <button type="button" class="link-button" data-testid="source-open" onClick={openFullPage}>Open</button>}
          <button type="button" class="icon-button" aria-label="Close sources" data-testid="source-close" onClick={closeSources}><Close /></button>
        </div>
      </div>
      {body}
    </aside>
  );
}
