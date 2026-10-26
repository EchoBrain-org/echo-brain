import { Fragment, type ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type {
  Answer, AnswerBlock, AnswerPart, AnswerSource, AskReceipt, AskSearched, ExternalAnswerSource, AnswerStatement, ApprovedRecord, Match, OpenItemView, RecordItem,
  TimelineTurn, ToolContainerKind,
} from '../../shared/protocol.js';
import { askText, queryTerms } from '../../shared/query.js';
import {
  answerSentences, documentName, dueColumn, externalSourceProvider, lateForYou, passageBlocks, rowId, rowStatement, statementGroups, tableDay, yoursIn,
  type AnswerTable, type Inline, type SourceGroup,
} from '../answer.js';
import { identity, initial, marked, meetingTime, snippet, when } from '../format.js';
import { message } from '../messages.js';
import { checkWords, ownerAndStatus } from '../needs.js';
import { sourceKey } from '../openers.js';
import {
  announceAfter, announcement, duration, foundBefore, headline, liveRows, namedPlaces, placeLabel, PROGRESS_AFTER_MS, receiptWords, searchedWords, type AskProgress,
  type LiveRow, type NamedPlace,
} from '../progress.js';
import {
  activeTurn, askAgain, askEverywhere, barSuggestions, cancelAsk, checksOf, chipName, shownChecks, chooseClarified, chooseSource, closeSources, copyAnswer, foundNothingInProject, fullTurns,
  fullPageOffered, litAtoms, matchesShown, openCompose, openFullPage, openMatch, openExternalSource, openNamed, pageCovered, paneCitations, paneTarget, pickSuggestion,
  retryAsk, retryEvidence, retryRecord, scopeName, searchAgain, setBarText, sourceName, submitBar, suggestionsShown, toggleSourceList, toggleTurn, turnOf, widenScope, UNTITLED,
  type AskClarify, type PaneTarget, type Read, type RecordSectionKey, type ShownTurn, type State,
} from '../store.js';
import { MAX_QUESTION, questionCount } from '../bar.js';
import {
  allOmitted, askedToday, askedWhen, markOf, shownInFull, turnChanged, turnGroups, turnNote, type Mark, type Suggestion, type TurnChecks,
} from '../timeline.js';
import { Caret, Check, Chevron, Close, Doc, Folder, Lock, Meeting, OnePerson, Plug, Plus, Refresh, Ticks, Up } from './icons.js';

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
 * click asks it, or, for a question you asked, opens its turn (ADR-0047).
 */
function Suggestions({ suggestions, active, onPick }: { suggestions: readonly Suggestion[]; active: number; onPick: (suggestion: Suggestion) => void }) {
  return (
    <div class="matches suggestions" data-testid="suggestions" id="ask-suggestions" role="listbox" aria-label="Try asking">
      <div class="matches-head" aria-hidden="true">Try asking</div>
      {suggestions.map((suggestion, index) => (
        <div key={suggestion.question} id={`ask-suggestion-${index}`} role="option" aria-selected={index === active} data-testid="suggestion"
          data-asked={suggestion.turn === undefined ? undefined : 'true'} class={`match-row suggestion${index === active ? ' active' : ''}`}
          onMouseDown={event => event.preventDefault()} onClick={() => onPick(suggestion)}>
          <Up /><span class="label">{suggestion.question}</span>
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
  const pick = (suggestion: Suggestion) => { setSuggesting(CLOSED); pickSuggestion(suggestion); };
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
      {shown.length > 0 && <Suggestions suggestions={shown} active={active} onPick={pick} />}
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

/**
 * One turn's answer as the page shows it (ADR-0047): its sources, numbered as
 * its sentences cite them, and what the last check found of them, when one
 * applies (never to a turn asked in this Ask).
 */
interface TurnView {
  readonly id: string;
  readonly answer: Answer;
  readonly groups: readonly SourceGroup[];
  readonly checks: TurnChecks | undefined;
}

function turnView(turn: TimelineTurn, checks: TurnChecks | undefined): TurnView {
  return { id: turn.id, answer: turn.answer, groups: turnGroups(turn.answer.sources, checks), checks };
}

/** A source's first citation stands for it: its kind, its label, its record or its link. */
function firstSource(view: TurnView, group: SourceGroup): AnswerSource {
  return view.answer.sources[group.indexes[0]!]!;
}

/** Whether the pane shows a source of this turn. */
function paneOn(state: State, view: TurnView): boolean {
  return state.sources?.turn === view.id;
}

/** A source's number after a sentence: it opens the pane on that source, for that sentence. */
function Marker({ state, view, group, focus }: { state: State; view: TurnView; group: number; focus: string }) {
  const on = paneOn(state, view) && state.sources?.open === group && state.sources.focus === focus;
  const name = sourceName(firstSource(view, view.groups[group]!), state.sources);
  return (
    <button type="button" class={`marker${on ? ' on' : ''}`} data-testid="citation" aria-pressed={on} aria-label={`Source ${group + 1}: ${name}`}
      title={name} onClick={() => chooseSource(group, focus, view.id)}>{group + 1}</button>
  );
}

/** Numbers after a sentence, one per source it cites, and a lock when only you can read one of them. */
function Markers({ state, view, statement, id }: { state: State; view: TurnView; statement: AnswerStatement; id: string }) {
  return <>
    {statementGroups(statement.citation_indexes, view.groups).map(group => <Marker key={group} state={state} view={view} group={group} focus={id} />)}
    {statement.private && (
      <span class="private-mark" data-testid="private-mark" role="img" aria-label="Only you can read a source of this" title="Only you can read a source of this"><Lock /></span>
    )}
  </>;
}

/** Whether the sentence or row `id` of a turn is lit: its number opened the pane. */
function lit(state: State, view: TurnView, id: string): boolean {
  return paneOn(state, view) && state.sources?.open != null && state.sources.focus === id;
}

/** What a check says of a sentence: lit in the signal when a source it cites changed (`changed`), left out when you can no longer read one (`omitted`). */
function markIn(view: TurnView, citations: readonly number[]): Mark {
  return markOf(citations, view.checks);
}

/** A sentence's classes: lit by its number, and changed since it was said. */
function markClass(base: string, on: boolean, mark: Mark): string {
  return `${base}${on ? ' on' : ''}${mark === 'changed' ? ' changed' : ''}`;
}

/** A sentence and the numbers of its sources. The one whose number opened the pane is lit. One a check left out is not shown. */
function Statement({ state, view, statement, id }: { state: State; view: TurnView; statement: AnswerStatement; id: string }) {
  const mark = markIn(view, statement.citation_indexes);
  if (mark === 'omitted') return null;
  return (
    <p class={markClass('answer-statement selectable', lit(state, view, id), mark)} data-testid="statement" data-mark={mark ?? undefined}>
      <span data-testid="statement-text">{statement.text}</span>
      <Markers state={state} view={view} statement={statement} id={id} />
    </p>
  );
}

/** No sentence could be written: what research found, as its passages read, with their sources' numbers. */
function Found({ state, view, statement, id }: { state: State; view: TurnView; statement: AnswerStatement; id: string }) {
  const mark = markIn(view, statement.citation_indexes);
  if (mark === 'omitted') return null;
  const source = view.answer.sources[statement.citation_indexes[0]!];
  return (
    <div class={markClass('passage selectable', false, mark)} data-testid="found" data-mark={mark ?? undefined}>
      <Passage text={statement.text} label={source?.label ?? ''} />
      <div><Markers state={state} view={view} statement={statement} id={id} /></div>
    </div>
  );
}

/** A sentence of the lead or a paragraph, inline with the others: its text and its numbers, lit on its own. */
function Claim({ state, view, statement, id, mark }: { state: State; view: TurnView; statement: AnswerStatement; id: string; mark: Mark }) {
  return (
    <span class={markClass('claim', lit(state, view, id), mark)} data-testid="statement" data-mark={mark ?? undefined}>
      <span data-testid="statement-text">{statement.text}</span>
      <Markers state={state} view={view} statement={statement} id={id} />
    </span>
  );
}

/** The places of a block's sentences a check leaves to show. */
function shownPlaces(view: TurnView, part: AnswerPart, places: readonly number[]): number[] {
  return places.filter(place => markIn(view, part.statements[place]!.citation_indexes) !== 'omitted');
}

/** The sentences of a lead or a paragraph, one after another, each with its own numbers. */
function Claims({ state, view, part, index, statements }: { state: State; view: TurnView; part: AnswerPart; index: number; statements: readonly number[] }) {
  return <>{statements.map((place, at) => {
    const statement = part.statements[place]!;
    return <Fragment key={place}>{at > 0 && ' '}
      <Claim state={state} view={view} statement={statement} id={`${index}.${place}`} mark={markIn(view, statement.citation_indexes)} /></Fragment>;
  })}</>;
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
 * signal colour, but for a row whose sources changed since.
 */
function Table({ state, view, index, block, place, opens, label }: {
  state: State; view: TurnView; index: number; block: AnswerTable; place: number; opens: boolean; label: string;
}) {
  const me = state.status?.account?.display_name ?? null;
  const due = dueColumn(block.columns);
  const rows = block.rows.map((row, at) => ({ row, at, mark: markIn(view, row.citation_indexes) })).filter(({ mark }) => mark !== 'omitted');
  return <>
    {block.caption && <p class={`${opens ? 'answer-lead' : 'answer-caption'} selectable`}>{block.caption}</p>}
    <div class="answer-table selectable" role="region" tabIndex={0} aria-label={block.caption ?? label}>
      <table class={`cols-${block.columns.length}`}>
        <thead><tr>{block.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>
          {rows.map(({ row, at, mark }) => {
            const id = rowId(index, place, at);
            const late = lateForYou(block.columns, row.cells, me);
            return (
              <tr key={at} class={[lit(state, view, id) ? 'on' : '', mark === 'changed' ? 'changed' : ''].filter(Boolean).join(' ') || undefined}
                data-testid="answer-row" data-mark={mark ?? undefined}>
                {row.cells.map((cell, column) => column === 0
                  ? <td key={column}><span class="first">{cell}<Markers state={state} view={view} statement={rowStatement(row, view.answer.sources)} id={id} /></span></td>
                  : <Cell key={column} cell={cell} late={late && column === due} you={yoursIn(block.columns[column]!, cell, me)} />)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </>;
}

/** Whether a laid-out block shows anything once a check leaves out what you can no longer read. */
function blockShows(view: TurnView, part: AnswerPart, block: AnswerBlock): boolean {
  if (block.kind === 'heading') return true;
  if (block.kind === 'table') return block.rows.some(row => markIn(view, row.citation_indexes) !== 'omitted');
  return shownPlaces(view, part, block.statements).length > 0;
}

/**
 * A laid-out part (answer layout v1, ADR-0045), in the desktop's own type:
 * the lead, its first sentence heavier; headings; paragraphs; bullets; and
 * tables. Every sentence and row keeps its own numbers and is lit on its own.
 * `opening`: the part opens the answer, so a table first has no lead above it.
 * A block a check leaves empty goes, and so does a heading with nothing under it.
 */
function LaidOut({ state, view, part, index, layout, opening }: {
  state: State; view: TurnView; part: AnswerPart; index: number; layout: readonly AnswerBlock[]; opening: boolean;
}) {
  // A table without a caption is named by the heading above it.
  let heading = 'Table';
  const shows = layout.map((block, place) => blockShows(view, part, block) && (block.kind !== 'heading' || (layout[place + 1] !== undefined && layout[place + 1]!.kind !== 'heading'
    && blockShows(view, part, layout[place + 1]!))));
  return (
    <div class="answer-layout">
      {layout.map((block, place) => {
        if (!shows[place]) return null;
        if (block.kind === 'heading') { heading = block.text; return <h3 key={place} class="answer-heading">{block.text}</h3>; }
        if (block.kind === 'lead') {
          return <p key={place} class="answer-lead selectable"><Claims state={state} view={view} part={part} index={index} statements={shownPlaces(view, part, block.statements)} /></p>;
        }
        if (block.kind === 'paragraph') {
          return <p key={place} class="answer-paragraph selectable"><Claims state={state} view={view} part={part} index={index} statements={shownPlaces(view, part, block.statements)} /></p>;
        }
        if (block.kind === 'bullets') {
          return (
            <ul key={place} class="answer-bullets selectable">
              {shownPlaces(view, part, block.statements).map(at => {
                const id = `${index}.${at}`;
                const statement = part.statements[at]!;
                const mark = markIn(view, statement.citation_indexes);
                return <li key={at} class={[lit(state, view, id) ? 'on' : '', mark === 'changed' ? 'changed' : ''].filter(Boolean).join(' ') || undefined}
                  data-testid="statement" data-mark={mark ?? undefined}>
                  <span><span data-testid="statement-text">{statement.text}</span><Markers state={state} view={view} statement={statement} id={id} /></span>
                </li>;
              })}
            </ul>
          );
        }
        return <Table key={place} state={state} view={view} index={index} block={block} place={place} opens={opening && place === 0} label={heading} />;
      })}
    </div>
  );
}

/** Whether a part shows anything once a check leaves out what you can no longer read. */
function partShows(view: TurnView, part: AnswerPart): boolean {
  return [...part.statements, ...(part.records ?? [])].some(statement => markIn(view, statement.citation_indexes) !== 'omitted');
}

/**
 * The answer: each part, laid out when it carries a layout and a paragraph
 * per sentence when not. A part with nothing to show is left out, and so is a
 * sentence citing a source you can no longer read; one whose source changed is
 * lit in the signal (ADR-0047). What research did not cover is not shown; an
 * answer with nothing to say says nothing matched, unless the project's own
 * line says so.
 */
function AgenticAnswer({ state, view, dimmed = false, empty = true }: { state: State; view: TurnView; dimmed?: boolean; empty?: boolean }) {
  const answer = view.answer;
  const parts = answer.parts.map((part, index) => ({ part, index })).filter(({ part }) => partShows(view, part));
  const said = parts.length > 0 || (answer.direct !== undefined && markIn(view, answer.direct.citation_indexes) !== 'omitted');
  return (
    <div class={`agentic-answer${dimmed ? ' dimmed' : ''}`} data-testid="answer">
      {answer.direct && <Statement state={state} view={view} statement={answer.direct} id="direct" />}
      {parts.map(({ part, index }) => (
        <section class="answer-part" key={index}>
          {/* One part answers the question itself: its label would repeat it. */}
          {answer.parts.length > 1 && <div class="section-label">{part.question}</div>}
          {part.layout
            ? <LaidOut state={state} view={view} part={part} index={index} layout={part.layout} opening={index === 0 && !answer.direct} />
            : part.statements.map((statement, place) => <Statement key={place} state={state} view={view} statement={statement} id={`${index}.${place}`} />)}
          {part.records?.map((statement, place) => <Found key={`record-${place}`} state={state} view={view} statement={statement} id={`${index}.r${place}`} />)}
        </section>
      ))}
      {!said && empty && <p class="answer-empty" data-testid="answer-empty">Nothing you can see matched.</p>}
    </div>
  );
}

/**
 * Ask again's "Since Oct 14": what is different now, each cited, from the
 * answer itself; or that nothing material changed. `at` is when the turn it
 * asked again was asked.
 */
function SinceList({ state, view, since, at }: { state: State; view: TurnView; since: readonly AnswerStatement[]; at: string | null }) {
  const when = at === null ? 'then' : askedWhen(at);
  const shown = since.map((statement, place) => ({ statement, place })).filter(({ statement }) => markIn(view, statement.citation_indexes) !== 'omitted');
  if (since.length === 0) return <p class="since-note" data-testid="since-nothing">Nothing changed since {when}</p>;
  if (shown.length === 0) return null;
  return (
    <div class="since" data-testid="since">
      <div class="since-label">Since {when}</div>
      <ul class="since-items selectable">
        {shown.map(({ statement, place }) => (
          <li key={place} class={lit(state, view, `since.${place}`) ? 'on' : undefined} data-testid="since-item">
            <span><span data-testid="since-text">{statement.text}</span><Markers state={state} view={view} statement={statement} id={`since.${place}`} /></span>
          </li>
        ))}
      </ul>
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
 * A turn's sources: one line, "4 sources · Tuesday sync · Apollo update",
 * that opens onto a row per source, numbered as the sentences cite it. It
 * starts closed (ADR-0045). Citation numbers open the source pane without
 * expanding this list. If expanded explicitly, the row the pane shows is lit.
 */
function SourceList({ state, view }: { state: State; view: TurnView }) {
  const groups = view.groups;
  if (groups.length === 0) return null;
  const open = paneOn(state, view) ? state.sources?.open ?? null : null;
  const listed = state.sources?.listed.includes(view.id) === true;
  const names = groups.map(group => sourceName(firstSource(view, group), state.sources));
  return (
    <div class="source-list" data-testid="source-list">
      <button type="button" class={`sources-toggle${listed ? ' open' : ''}`} data-testid="sources-toggle" aria-expanded={listed} onClick={() => toggleSourceList(view.id)}>
        <span class="count">{groups.length === 1 ? '1 source' : `${groups.length} sources`}</span>
        <span class="names">{names.map(shortName).join(' · ')}</span>
        <Caret />
      </button>
      {listed && <div class="source-rows">{groups.map((group, index) => {
        const source = firstSource(view, group);
        // One short qualifier only where it helps: a document's version and passages, a follow-up's owner and status, a
        // container's tool and key. A project, a person and a tool are named by their label alone.
        const row = source.kind === 'follow_up' ? followUpRow(state, source) : null;
        const meta = source.kind === 'original' ? originalMeta(source, group, 'passages')
          : source.kind === 'container' ? containerMeta(source, externalSourceProvider(source, state.tools?.items))
            : row ? ownerAndStatus(row, state.status?.account?.membership_id) : '';
        return (
          <button type="button" key={index} class={`source-row${open === index ? ' on' : ''}`} data-testid="source-row" aria-pressed={open === index}
            title={source.kind === 'original' ? source.label : undefined} onClick={() => chooseSource(index, null, view.id)}>
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

/** How long Copy answer says Copied. */
const COPIED_MS = 1_600;

/** Copy answer, under a turn's answer: Copied, for a moment, once it is on the clipboard. */
function CopyAnswer({ turn }: { turn: TimelineTurn }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button type="button" class="link-button" data-testid="copy-answer" aria-label={copied ? 'Answer copied' : 'Copy answer'}
      onClick={() => void copyAnswer(turn.id).then(done => setCopied(done))}>{copied ? 'Copied' : 'Copy answer'}</button>
  );
}

/**
 * Under an answer asked before this Ask (ADR-0047): Ask again, and what the
 * last check says of it: "Highlighted parts changed since Oct 14" when a
 * sentence it shows cites a source that changed, or "Nothing changed since
 * Oct 20" only when every source they cite was checked and is the same. A
 * check that could not tell, or none, says nothing; with every sentence left
 * out, only Ask again shows.
 */
function AgainRow({ state, turn, view, children }: { state: State; turn: TimelineTurn; view: TurnView; children?: ComponentChildren }) {
  const when = askedWhen(turn.asked_at);
  const note = turnNote(turn, view.checks);
  return (
    <div class="again-row">
      <button type="button" class="again-button" data-testid="ask-again" disabled={Boolean(state.ask?.asking)} onClick={() => askAgain(turn.id)}><Refresh />Ask again</button>
      {note && (
        <span class={`again-note${note === 'changed' ? ' changed' : ''}`} data-testid="again-note">
          {note === 'changed' ? `Highlighted parts changed since ${when}` : `Nothing changed since ${when}`}
        </span>
      )}
      {children}
    </div>
  );
}

/** When the turn a turn asked again was asked, while the timeline still has it. */
function againAt(state: State, turn: TimelineTurn): string | null {
  return turn.again_of === undefined ? null : turnOf(turn.again_of, state)?.asked_at ?? null;
}

/**
 * A turn in full: the latest, or one asked since Ask was opened. The question
 * as the asker typed it, what it looked through when this Ask asked it, Ask
 * again's "since", the answer, the project's own line when nothing in it
 * matched, the sources, and Copy answer. One asked before this Ask also says
 * what changed since, with Ask again (`current` false).
 */
function FullTurn({ state, turn, current, line }: { state: State; turn: ShownTurn; current: boolean; line: Line }) {
  const view = turnView(turn, shownChecks(turn, state));
  const omitted = allOmitted(turn, view.checks);
  return (
    <div class="turn" data-testid="turn" data-turn={turn.id}>
      <div class="question selectable" data-testid="question">{turn.text}</div>
      {turn.receipt && <Receipt state={state} receipt={turn.receipt} took={turn.took ?? 0} line={line} />}
      {!omitted && turn.since && <SinceList state={state} view={view} since={turn.since} at={againAt(state, turn)} />}
      {!omitted && <AgenticAnswer state={state} view={view} empty={!foundNothingInProject(turn)} />}
      {foundNothingInProject(turn) && (
        <div class="project-empty" data-testid="project-empty">
          <span>Nothing in {scopeName(turn.scope, state)} matched.</span>
          {/* Offered on the latest turn only, as the next step; never under a question that failed. */}
          {!state.ask?.failed && state.timeline.turns.at(-1)?.id === turn.id && (
            <button type="button" class="link-button" data-testid="ask-everywhere" onClick={() => askEverywhere(turn.id)}>Ask across everything you can see</button>
          )}
        </div>
      )}
      {!omitted && <SourceList state={state} view={view} />}
      {/* One asked before this Ask says what changed, with Ask again; Copy answer joins that row. */}
      {current ? <div class="actions"><CopyAnswer turn={turn} /></div>
        : <AgainRow state={state} turn={turn} view={view}>{!omitted && <CopyAnswer turn={turn} />}</AgainRow>}
    </div>
  );
}

/**
 * An earlier turn, folded to one line (ADR-0047): its project's square (none
 * for all context or Mine), its full question, "Changed" when a source it
 * cited changed and no later turn asked it again, and when it was asked. The
 * line opens the answer as it was, dimmed: what changed lit, what you can no
 * longer read left out, then Ask again and what the check said.
 */
function FoldedTurn({ state, turn, opened }: { state: State; turn: TimelineTurn; opened: boolean }) {
  const checks = checksOf(turn, state);
  const changed = turnChanged(turn, checks, state.timeline.turns);
  const view = turnView(turn, checks);
  const omitted = allOmitted(turn, checks);
  const square = turn.scope.kind === 'project'
    ? <span class="turn-square" style={identity(turn.scope.project_id)} aria-hidden="true">{initial(scopeName(turn.scope, state))}</span>
    : <span class="turn-square none" aria-hidden="true" />;
  return (
    <div class={`folded-turn${opened ? ' open' : ''}`} data-turn={turn.id}>
      <button type="button" class="folded" data-testid="timeline-row" aria-expanded={opened} onClick={() => toggleTurn(turn.id)}>
        {square}
        <span class="q" data-testid="timeline-question">{turn.question}</span>
        {changed && <span class="changed-tag" data-testid="changed-tag">Changed</span>}
        <span class="when">{askedWhen(turn.asked_at)}</span>
      </button>
      {opened && (
        <div class="opened" data-testid="opened-turn">
          {!omitted && turn.since && <SinceList state={state} view={view} since={turn.since} at={againAt(state, turn)} />}
          {!omitted && <AgenticAnswer state={state} view={view} dimmed />}
          {!omitted && <SourceList state={state} view={view} />}
          <AgainRow state={state} turn={turn} view={view} />
        </div>
      )}
    </div>
  );
}

/** "Which one?": a follow-up that could mean several things, and a button for each; one asks its full question. */
function Clarify({ state, clarify }: { state: State; clarify: AskClarify }) {
  return (
    <div class="turn" data-testid="clarify">
      <div class="question selectable" data-testid="question">{clarify.question}</div>
      <p class="answer-paragraph">Which one?</p>
      <div class="choices">
        {clarify.choices.map(choice => (
          <button type="button" key={choice.question} class="choice" data-testid="choice" disabled={Boolean(state.ask?.asking)} title={choice.question}
            onClick={() => chooseClarified(choice)}>{choice.label}</button>
        ))}
      </div>
    </div>
  );
}

/** The quiet line above the first of today's turns, when earlier days have turns. */
function Today() {
  return <div class="today" role="separator" data-testid="today"><span>Today</span></div>;
}

/** How near its bottom the timeline counts as read to the end: a new row of the Ask on its way follows it there. */
const FOLLOW_PX = 40;

/**
 * Ask, on the timeline (ADR-0047): every earlier turn as one line, the latest
 * and those asked since Ask was opened in full, then a question on its way,
 * "Which one?", or one that failed. Newest at the bottom, with a quiet Today
 * above the first of today's turns.
 */
export function AskView({ state }: { state: State }) {
  const thread = state.ask!;
  const { turns } = state.timeline;
  const scroller = useRef<HTMLElement>(null);
  // Whether the person was at the bottom when they last scrolled, or the timeline last took them there.
  const atBottom = useRef(true);
  // Where the timeline last put the view: the scroll event that records a person's scroll can arrive after a new row.
  const placedAt = useRef<number | null>(null);
  const toBottom = () => {
    const view = scroller.current;
    if (view) { view.scrollTop = view.scrollHeight; placedAt.current = view.scrollTop; }
    atBottom.current = true;
  };
  // A new question, answer, choice or failure scrolls to the bottom.
  useLayoutEffect(toBottom, [thread.seq, turns.length, thread.asking === null, thread.failed, thread.clarify]);
  // A suggestion opened Ask at a turn: that turn comes into view.
  useLayoutEffect(() => {
    if (thread.focus === null) return;
    scroller.current?.querySelector(`[data-turn="${thread.focus}"]`)?.scrollIntoView({ block: 'start' });
    atBottom.current = false;
  }, [thread.focus]);
  // A row of the question on its way only when the person is there: one who scrolled up to read stays put, even before
  // their scroll event has arrived, because the view is no longer where the timeline left it.
  const follow = useCallback(() => {
    const view = scroller.current;
    if (view && placedAt.current !== null && view.scrollTop < placedAt.current - FOLLOW_PX) atBottom.current = false;
    if (atBottom.current) toBottom();
  }, []);
  const onScroll = () => {
    const view = scroller.current;
    if (view) atBottom.current = view.scrollHeight - view.scrollTop - view.clientHeight < FOLLOW_PX;
  };
  // Which Ask's line is open: the question on its way and its answer share its seq, so a line opened while Ask works
  // stays open as its receipt, and the next question's line starts closed.
  const [openFor, setOpenFor] = useState<number | null>(null);
  const lineFor = (id: number): Line => ({ open: openFor === id, toggle: () => setOpenFor(openFor === id ? null : id) });
  const { asking, failed, clarify } = thread;
  const now = Date.now();
  // Today's line goes above its first turn, or, with none yet, above the question on its way; only when earlier days have turns.
  const first = turns.findIndex(turn => askedToday(turn.asked_at, now));
  const today = first > 0 ? first : first === -1 && turns.length > 0 && (asking || clarify || failed) ? turns.length : -1;
  return (
    <section class="ask timeline" data-testid="ask-view" aria-live="polite" ref={scroller} onScroll={onScroll}>
      {turns.map((turn, index) => (
        <Fragment key={turn.id}>
          {index === today && <Today />}
          {shownInFull(turn, turns, fullTurns(thread))
            ? <FullTurn state={state} turn={{ ...turn, ...thread.took[turn.id] }} current={thread.asked.includes(turn.id)} line={lineFor(thread.took[turn.id]?.seq ?? -1)} />
            : <FoldedTurn state={state} turn={turn} opened={thread.opened === turn.id} />}
        </Fragment>
      ))}
      {today === turns.length && <Today />}
      {asking && (
        <div class="turn">
          <div class="question selectable" data-testid="question">{asking.question}</div>
          <Asking state={state} progress={asking.progress} follow={follow} line={lineFor(thread.seq)} />
        </div>
      )}
      {clarify && <Clarify state={state} clarify={clarify} />}
      {failed && (
        <div class="turn" data-testid="ask-failed">
          <div class="question selectable">{failed.question}</div>
          <div class="error" data-testid="ask-error">{message(failed.failure)}</div>
          {failed.failure.retryable && (
            <div class="actions">
              <button type="button" class="link-button" data-testid="ask-retry" onClick={retryAsk}>Try again</button>
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
  const answer = activeTurn(state)?.answer;
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
