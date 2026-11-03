import type {
  Answer, AnswerBlock, AnswerPart, AnswerSource, AnswerStatement, AnswerTableRow, ArrangedBlock, CardEntity, ConnectedTool, ExternalAnswerSource,
} from '../shared/protocol.js';
import { startOfDay } from './format.js';
import { sourceKey } from './openers.js';

/** What the pane may show of an answer with a layout v1 or none: at most 32 sources. */
export const MAX_SOURCES = 32;

/**
 * The sources an answer's page numbers and shows: every one of an answer the writer arranged in blocks (ADR-0051),
 * which has no count of citations of its own, and the first 32 of any other.
 */
export function numberedSources(answer: Pick<Answer, 'sources' | 'parts'>): readonly AnswerSource[] {
  return answer.parts.some(part => part.blocks !== undefined) ? answer.sources : answer.sources.slice(0, MAX_SOURCES);
}

/**
 * One source as an answer shows it: a document, a meeting's approved record,
 * or a live item. An answer cites passages and record items; those of one
 * document or one record are one source, numbered once.
 */
export interface SourceGroup {
  /** Its citations, by their place in the answer's sources. */
  readonly indexes: readonly number[];
}

/**
 * The place a source opens, as a person reads it: a meeting (whichever of its
 * items is cited), a document or note (whichever passage), a follow-up, a
 * project, a person, a tool, or one link: an item's in its tool, or a Jira
 * project's or Confluence space's. Sources of one place are one source.
 */
export function groupKey(source: AnswerSource): string {
  if (source.kind === 'record') return `record:${source.record.record_sha256}`;
  if (source.kind === 'original') return `original:${source.ref.source_id}`;
  // Any other source is one place already: the item itself.
  return sourceKey(source);
}

/** A table of a laid-out part, or of one arranged in blocks: layout v2's table is layout v1's, with a title. */
export type AnswerTable = Extract<AnswerBlock, { kind: 'table' }>;

/** A table row's id, as the pane knows it: its part, its table's place in the part's layout or blocks, and its own ("0.t4.1"). */
export function rowId(part: number, block: number, row: number): string {
  return `${part}.t${block}.${row}`;
}

/** A part's blocks, by their place: its layout (v1), or the blocks the writer arranged it in (v2). A part has one or neither. */
function blocksOf(part: AnswerPart): readonly (AnswerBlock | ArrangedBlock)[] {
  return part.layout ?? part.blocks ?? [];
}

/**
 * A table row as a sentence the pane can light: its cells, and the citations
 * it has. It says only you can read a source of it when one of its own
 * citations is private among the answer's `sources`, whatever its table's
 * other rows cite.
 */
export function rowStatement(row: AnswerTableRow, sources: readonly AnswerSource[]): AnswerStatement {
  return {
    text: row.cells.filter(cell => cell !== '').join(' · '), citation_indexes: row.citation_indexes,
    private: row.citation_indexes.some(index => sources[index]?.private === true),
  };
}

/**
 * Every sentence of an answer, by the id the pane knows it by: "direct", its
 * part and place ("0.2", "0.r1" for a passage found), or a table's row
 * ("0.t4.1"), laid out (v1) or arranged in blocks (v2). An arranged part's
 * point, event, fact and quote are its sentences, by their place.
 */
export function answerSentences(answer: Answer): [string, AnswerStatement][] {
  return [
    ...(answer.direct ? [['direct', answer.direct] as [string, AnswerStatement]] : []),
    ...answer.parts.flatMap((part, p) => [
      ...part.statements.map((statement, i) => [`${p}.${i}`, statement] as [string, AnswerStatement]),
      ...(part.records ?? []).map((statement, i) => [`${p}.r${i}`, statement] as [string, AnswerStatement]),
      ...blocksOf(part).flatMap((block, b) => block.kind !== 'table' ? []
        : block.rows.map((row, r) => [rowId(p, b, r), rowStatement(row, answer.sources)] as [string, AnswerStatement])),
    ]),
  ];
}

/** An answer's sources, in the order it first cites them. */
export function sourceGroups(sources: readonly AnswerSource[]): SourceGroup[] {
  const groups = new Map<string, { indexes: number[] }>();
  sources.forEach((source, index) => {
    const key = groupKey(source);
    const group = groups.get(key);
    if (group) group.indexes.push(index);
    else groups.set(key, { indexes: [index] });
  });
  return [...groups.values()];
}

/** The sources a sentence cites, by their place among the answer's sources: one marker each. */
export function statementGroups(citations: readonly number[], groups: readonly SourceGroup[]): number[] {
  const cited = new Set(citations);
  return groups.flatMap((group, position) => group.indexes.some(index => cited.has(index)) ? [position] : []);
}

const EXTENSION = /\.(md|markdown|txt|text|pdf|docx?|rtf|html?)$/iu;
const VERSION = /^(.*\S)[\s_-]+(v\d+(?:\.\d+)*)$/iu;

/**
 * A file name as a person would say it: "SCOUT-Hardware-Review-v0.1.md" is
 * SCOUT Hardware Review, v0.1. A title someone wrote, with spaces, keeps
 * everything but its extension.
 */
export function documentName(label: string): { name: string; version?: string } {
  const stem = label.replace(EXTENSION, '');
  if (stem.trim() === '') return { name: label };
  if (/\s/u.test(stem)) return { name: stem };
  const name = stem.replace(/[-_]+/gu, ' ').trim();
  const versioned = VERSION.exec(name);
  return versioned ? { name: versioned[1]!, version: versioned[2]! } : { name };
}

/** A run of a passage's text: plain, bold, or code. */
export interface Inline {
  readonly text: string;
  readonly bold?: true;
  readonly code?: true;
}

/** A passage's text in the blocks its markdown means. Anything else stays as written, line by line. */
type Block =
  | { readonly kind: 'heading'; readonly text: readonly Inline[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly kind: 'paragraph'; readonly text: readonly Inline[] };

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/u;
const ITEM = /^\s*(?:[-*+]|(\d{1,9})[.)])\s+(.*)$/u;
const RULE = /^\s{0,3}(?:[-*_]\s*){3,}$/u;
const INLINE = /\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`/gu;

function inline(text: string): Inline[] {
  const runs: Inline[] = [];
  let from = 0;
  for (const found of text.matchAll(INLINE)) {
    if (found.index > from) runs.push({ text: text.slice(from, found.index) });
    runs.push(found[3] !== undefined ? { text: found[3], code: true } : { text: (found[1] ?? found[2])!, bold: true });
    from = found.index + found[0].length;
  }
  if (from < text.length) runs.push({ text: text.slice(from) });
  return runs;
}

/**
 * A cited passage, ready to read: its markdown as blocks. Evidence can start
 * with the file name it came from; the pane already names it, so it goes.
 */
export function passageBlocks(text: string, label: string): Block[] {
  let body = text;
  if (label !== '' && body.startsWith(label) && (body.length === label.length || /\s/u.test(body[label.length]!))) {
    body = body.slice(label.length).trimStart();
  }
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: inline(paragraph.join('\n')) });
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    paragraph = [];
    list = null;
  };
  for (const line of body.split(/\r?\n/u)) {
    if (line.trim() === '' || RULE.test(line)) { flush(); continue; }
    const heading = HEADING.exec(line);
    if (heading) { flush(); blocks.push({ kind: 'heading', text: inline(heading[1]!) }); continue; }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = item[1] !== undefined;
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(inline(item[2]!));
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Use the server's tool label when loaded; otherwise show its identity, never infer from the citation kind. */
export function externalSourceProvider(source: Pick<ExternalAnswerSource, 'tool_id'>, tools?: readonly ConnectedTool[] | null): string {
  return tools?.find(tool => tool.tool_id === source.tool_id)?.name ??
    source.tool_id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** An ISO date's day, here: null for any other text, or a date that is not one. */
function day(cell: string): Date | null {
  const found = DAY.exec(cell);
  if (!found) return null;
  const [year, month, date] = [Number(found[1]), Number(found[2]) - 1, Number(found[3])];
  const value = new Date(year, month, date);
  return value.getFullYear() === year && value.getMonth() === month && value.getDate() === date ? value : null;
}

/** An ISO date in a table ("2026-10-14") as a person reads it: "Oct 14", with its year when it is not this year's. Null for any other text. */
export function tableDay(cell: string, now = Date.now()): string | null {
  const value = day(cell);
  if (!value) return null;
  const year = value.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' as const };
  return value.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...year });
}

/** Text compared as words: trimmed, lower case, a curly apostrophe as a straight one. */
const plain = (text: string) => text.trim().replace(/[\u2018\u2019]/gu, "'").toLowerCase();
/** A table's owner column, by its exact name: never "Assigned by". Its due date and status columns, by a word of theirs. */
const OWNER_COLUMNS: ReadonlySet<string> = new Set(['owner', 'assignee', 'assigned to']);
const DUE = /\b(due|deadline)\b/iu;
const STATUS = /\b(status|state)\b/iu;
/** Statuses of work that is over: never late. */
const OVER: ReadonlySet<string> = new Set(['done', 'closed', 'resolved', 'complete', 'completed', 'fixed', 'shipped', 'merged', 'released', 'cancelled', 'canceled',
  "won't do", "won't fix", 'duplicate', 'rejected', 'obsolete', 'dismissed', 'not relevant']);

/** Whether a table cell names you as its row's owner: its column is the owner's, and it says "You" or your name (`me`). */
export function yoursIn(column: string, cell: string, me: string | null): boolean {
  const who = plain(cell);
  return OWNER_COLUMNS.has(plain(column)) && (who === 'you' || (me !== null && who === plain(me)));
}

/** The column that says when a row is due, or -1. */
export function dueColumn(columns: readonly string[]): number {
  return columns.findIndex(column => DUE.test(column));
}

/**
 * Whether a table row is yours and late: its owner is you ("You", or your
 * name), its due date has passed, and its status, if it has one, is not over.
 * The one thing an answer shows in the signal colour (ADR-0045).
 */
export function lateForYou(columns: readonly string[], cells: readonly string[], me: string | null, now = Date.now()): boolean {
  const due = dueColumn(columns);
  const status = columns.findIndex(column => STATUS.test(column));
  if (due < 0 || !columns.some((column, at) => yoursIn(column, cells[at]!, me))) return false;
  const when = day(cells[due]!);
  if (!when || when.getTime() >= startOfDay(now)) return false;
  return status < 0 || !OVER.has(plain(cells[status]!));
}

/**
 * Text as Markdown that reads as it was written: one line, so a newline
 * never starts a new block; CommonMark's punctuation and a pipe kept as text;
 * and a start that would make a list or a rule a sentence again ("1\\. step",
 * "\\- item").
 */
function markdownText(text: string): string {
  return text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).join(' ')
    .replace(/[\\`*_[\]<>#|]/gu, '\\$&')
    .replace(/^(\d+)([.)])(?=\s|$)/u, '$1\\$2')
    .replace(/^([-+])(?=[\s-]|$)/u, '\\$1');
}

/** Which of an answer's sentences and rows the page shows, by what they cite: all, unless a check leaves some out (ADR-0047). */
export type Shows = (citations: readonly number[]) => boolean;

/**
 * The blocks of a laid-out part the page shows, by their place: a block with
 * a sentence or row it shows, and a heading only with such a block right
 * under it.
 */
export function shownBlocks(part: AnswerPart, layout: readonly AnswerBlock[], shows: Shows): boolean[] {
  const some = (block: AnswerBlock) => block.kind === 'heading' || (block.kind === 'table' ? block.rows.some(row => shows(row.citation_indexes))
    : block.statements.some(place => shows(part.statements[place]!.citation_indexes)));
  return layout.map((block, place) => some(block) && (block.kind !== 'heading' || (layout[place + 1] !== undefined && layout[place + 1]!.kind !== 'heading'
    && some(layout[place + 1]!))));
}

/**
 * The blocks of an arranged part (answer layout v2, ADR-0051) the page shows,
 * by their place: a block with a sentence or row it shows. A block's title is
 * its own, so it goes with it.
 */
export function shownArranged(part: AnswerPart, blocks: readonly ArrangedBlock[], shows: Shows): boolean[] {
  return blocks.map(block => block.kind === 'table' ? block.rows.some(row => shows(row.citation_indexes))
    : block.statements.some(place => shows(part.statements[place]!.citation_indexes)));
}

/** An arranged block's section heading: its title, but for a card's, which names the card itself. */
export function blockTitle(block: ArrangedBlock): string | undefined {
  return block.kind === 'text' || block.kind === 'points' || block.kind === 'table' || block.kind === 'timeline' ? block.title : undefined;
}

/** What a card's kind reads as, before its title ("Ticket THERM-48"). */
export const CARD_WORDS: Readonly<Record<CardEntity, string>> = { person: 'Person', project: 'Project', ticket: 'Ticket', decision: 'Decision' };

/** Text, then the numbers of what it cites: as Copy answer writes a claim. */
type Cited = (text: string, citations: readonly number[]) => string;

/** A table as Copy answer writes it: its caption, then its columns and the rows the page shows, each row's numbers in its first cell. */
function tableMarkdown(block: AnswerTable, shows: Shows, cited: Cited): string[] {
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [...(block.caption ? [markdownText(block.caption)] : []), [
    line(block.columns.map(markdownText)), line(block.columns.map(() => '---')),
    ...block.rows.filter(row => shows(row.citation_indexes)).map(row => line(row.cells.map((cell, at) => at === 0 ? cited(cell, row.citation_indexes) : markdownText(cell)))),
  ].join('\n')];
}

/**
 * An arranged part as Copy answer writes it, in the page's order and without
 * what the page leaves out: a title as a heading; the answer and text as
 * paragraphs; points as a list, numbered when they are steps; a table as a
 * laid-out part's; a timeline as a list, each event from its day as the page
 * names it ("Oct 27, Noor Haddad: Approved the soak plan."); a card as its
 * kind and title in bold, then its facts as a list; a quote quoted, its
 * source under it. Each item is followed by its sentence's numbers.
 */
function arrangedMarkdown(part: AnswerPart, blocks: readonly ArrangedBlock[], shows: Shows, cited: Cited): string[] {
  const showing = shownArranged(part, blocks, shows);
  /** A block's sentences the page shows, each with its item's place in the block. */
  const items = (places: readonly number[]) => places.map((place, at) => ({ statement: part.statements[place]!, at }))
    .filter(({ statement }) => shows(statement.citation_indexes));
  return blocks.flatMap((block, place) => {
    if (!showing[place]) return [];
    const title = blockTitle(block);
    const heading = title === undefined ? [] : [`### ${markdownText(title)}`];
    const shown = items(block.statements);
    const claims = shown.map(({ statement }) => cited(statement.text, statement.citation_indexes));
    switch (block.kind) {
      case 'answer': case 'text': return [...heading, claims.join(' ')];
      case 'points': return [...heading, claims.map((claim, at) => `${block.ordered ? `${at + 1}.` : '-'} ${claim}`).join('\n')];
      case 'table': return [...heading, ...tableMarkdown(block, shows, cited)];
      case 'timeline': return [...heading, shown.map(({ statement, at }) => {
        const event = block.events[at]!;
        const when = [tableDay(event.date) ?? event.date, ...(event.who === undefined ? [] : [event.who])].join(', ');
        return `- ${cited(`${when}: ${event.text}`, statement.citation_indexes)}`;
      }).join('\n')];
      case 'card': return [`**${markdownText(`${CARD_WORDS[block.entity]}: ${block.title}`)}**`, shown.map(({ statement, at }) => {
        const fact = block.facts[at]!;
        return `- ${markdownText(fact.label)}: ${cited(fact.value, statement.citation_indexes)}`;
      }).join('\n')];
      case 'quote': return [[`> ${cited(block.text, shown[0]!.statement.citation_indexes)}`, ...(block.from === undefined ? [] : ['>', `> ${markdownText(block.from)}`])].join('\n')];
    }
  });
}

/** Whether the page shows anything of a part: a sentence, or a passage found. */
export function partShows(part: AnswerPart, shows: Shows): boolean {
  return [...part.statements, ...(part.records ?? [])].some(statement => shows(statement.citation_indexes));
}

/**
 * Ask again's "Since" list (ADR-0047) as Copy answer writes it, with the day
 * the earlier answer was asked as the page names it ("Oct 14"): "Nothing
 * changed since" for an empty list, and nothing for one whose every item
 * cites what a check left out, as on the page.
 */
interface CopiedSince {
  readonly statements: readonly AnswerStatement[];
  readonly when: string;
}

/**
 * Copy answer's Markdown (ADR-0045): the answer as the page shows it, each
 * claim followed by its sources' numbers as the page shows them ("[1][3]"),
 * and the sources, numbered and named (`names`, one per number). The page's
 * `groups` number them; `shows` says which sentences and rows it shows, so
 * what a check left out is not written, nor a part, block or heading left
 * with nothing to show (ADR-0047). A laid-out part keeps its lead, headings,
 * bullets and tables, and an arranged one its blocks (ADR-0051); any other
 * is a paragraph per sentence. A part's question heads what it says when
 * there are several. What research did not cover is not written: the page no
 * longer shows it (ADR-0047).
 */
export function answerMarkdown(answer: Answer, names: readonly string[], groups: readonly SourceGroup[], shows: Shows, since?: CopiedSince): string {
  const numbers = (citations: readonly number[]) => statementGroups(citations, groups).map(group => `[${group + 1}]`).join('');
  /** Text, then the numbers of what it cites: they stay on their claim. */
  const cited = (text: string, citations: readonly number[]) => [markdownText(text), numbers(citations)].filter(Boolean).join(' ');
  const claim = (statement: AnswerStatement) => cited(statement.text, statement.citation_indexes);
  const shown = (statements: readonly AnswerStatement[]) => statements.filter(statement => shows(statement.citation_indexes));
  const blocks: string[] = [];
  // Ask again's "Since" (ADR-0047), first as on the page, each item with its numbers.
  const listed = since === undefined ? [] : shown(since.statements);
  if (since?.statements.length === 0) blocks.push(`Nothing changed since ${markdownText(since.when)}`);
  else if (since !== undefined && listed.length > 0) blocks.push(`**Since ${markdownText(since.when)}**`, listed.map(statement => `- ${claim(statement)}`).join('\n'));
  if (answer.direct && shows(answer.direct.citation_indexes)) blocks.push(claim(answer.direct));
  for (const part of answer.parts) {
    // A part with nothing to show is not written, nor headed.
    if (!partShows(part, shows)) continue;
    if (answer.parts.length > 1) blocks.push(`## ${markdownText(part.question)}`);
    const said = (indexes: readonly number[]) => shown(indexes.map(index => part.statements[index]!)).map(claim);
    if (part.layout) {
      const showing = shownBlocks(part, part.layout, shows);
      part.layout.forEach((block, place) => {
        if (!showing[place]) return;
        if (block.kind === 'heading') blocks.push(`### ${markdownText(block.text)}`);
        else if (block.kind === 'bullets') blocks.push(said(block.statements).map(line => `- ${line}`).join('\n'));
        else if (block.kind !== 'table') blocks.push(said(block.statements).join(' '));
        else blocks.push(...tableMarkdown(block, shows, cited));
      });
    } else if (part.blocks) blocks.push(...arrangedMarkdown(part, part.blocks, shows, cited));
    else blocks.push(...shown(part.statements).map(claim));
    blocks.push(...shown(part.records ?? []).map(claim));
  }
  if (groups.length > 0) blocks.push('Sources', groups.map((_, index) => `${index + 1}. ${markdownText(names[index] ?? '')}`.trimEnd()).join('\n'));
  return blocks.join('\n\n');
}

/**
 * Copy answer's plain reading of what the page shows, for an answer whose
 * Markdown is longer than Copy answer takes: as the answer's own `text` reads
 * (its sentences one a line, each part's question first when there are
 * several), without what a check left out.
 */
export function answerText(answer: Answer, shows: Shows, since?: CopiedSince): string {
  const said = (statements: readonly AnswerStatement[]) => statements.filter(statement => shows(statement.citation_indexes)).map(statement => statement.text);
  const listed = since === undefined ? [] : said(since.statements);
  const changes = since === undefined ? [] : since.statements.length === 0 ? [`Nothing changed since ${since.when}`] : listed.length > 0 ? [`Since ${since.when}`, ...listed] : [];
  return [...changes, ...said(answer.direct ? [answer.direct] : []), ...answer.parts.filter(part => partShows(part, shows))
    .flatMap(part => [answer.parts.length > 1 ? part.question : '', ...said(part.statements), ...said(part.records ?? [])])]
    .filter(line => line !== '').join('\n');
}
