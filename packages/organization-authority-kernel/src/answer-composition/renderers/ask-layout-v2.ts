import {
  type PersonAnswerBlockV2,
  type PersonAnswerTableRowV1,
} from "@echo-brain/organization-api";
import type { AnswerItem } from "../agentic-ask-v1-model-protocol.js";

/**
 * How Ask lays out a V8 answer part with answer layout v2 (ADR-0051). The
 * writer arranges its answer from the block catalog, and code reads each item
 * it kept as one statement; here code orders those statements and groups them
 * into the contract's blocks. Layout adds no claim and no citation: a block
 * names the statements it shows, and a table row cites what its statement
 * cites. Code also checks what a block shows against the evidence its item
 * cites: a quote word for word, and an event's day.
 */

/**
 * A list statement code writes as its table (ADR-0041): its caption, its columns, and each row's cells and the citations
 * of what it shows; `group` when it is one of the statements of one list's use, which read as one table.
 */
export interface AskListShapeV2 {
  readonly kind: "list"; readonly caption: string; readonly columns: readonly string[]; readonly group?: number;
  readonly rows: readonly { readonly cells: readonly string[]; readonly citation_indexes: readonly number[] }[];
}
/** What one statement reads as: a writer's item, a list statement code writes as its table, or plain text. */
export type AskBlockShapeV2 = AnswerItem | { readonly kind: "text" } | AskListShapeV2;
/** One statement the response kept, with its citations and its shape. */
export interface AskBlockStatementV2 {
  readonly citation_indexes: readonly number[];
  readonly shape: AskBlockShapeV2;
}

/**
 * A v2 answer's kept statements in reading order: the writer's answer, then the list statements code writes of its own
 * accord (lists with no `block`), then the writer's other blocks in ascending block index. A list the writer placed
 * (ADR-0054) carries its block's index and reads where the writer put it among them, lists of one index in input order;
 * one placed before the answer reads right after it, since the answer is always first. Inside a writer block its own
 * items come first, then those that read as text, and a timeline's events oldest first. Only when the writer gave no
 * answer at all (`answered`) is its first kept item the answer, and only when it is untitled text: an answer the writer
 * gave and code left out (W1, a repeat) leaves the part with none, rather than one the writer never chose.
 */
export function orderAskBlocksV2<L extends { readonly block?: number }, S extends { readonly item: AnswerItem }>(lists: readonly L[], sentences: readonly S[], answered: boolean): readonly (L | S)[] {
  const first = sentences[0];
  const promoted = !answered && first !== undefined && first.item.kind === "text" && first.item.title === undefined;
  const answers = answered ? sentences.filter(sentence => sentence.item.kind === "answer")
    : promoted ? [{ ...first, item: Object.freeze({ block: first.item.block, kind: "answer" as const }) }] : [];
  const rest = sentences.filter(sentence => sentence.item.kind !== "answer" && !(promoted && sentence === first));
  const day = (sentence: S) => sentence.item.kind === "event" ? sentence.item.date : "";
  // A list with no block is code's own.
  const own = lists.filter(list => list.block === undefined);
  const placed = lists.filter(list => list.block !== undefined);
  const blocks = [...new Set([...rest.map(sentence => sentence.item.block), ...placed.map(list => list.block!)])]
    .sort((left, right) => left - right);
  return Object.freeze([
    ...answers, ...own,
    ...blocks.flatMap(block => {
      const items = rest.filter(sentence => sentence.item.block === block);
      // A stable sort, so events of one day keep the writer's order.
      const shown = items.filter(sentence => sentence.item.kind !== "text").sort((left, right) => day(left) < day(right) ? -1 : day(left) > day(right) ? 1 : 0);
      return [...shown, ...items.filter(sentence => sentence.item.kind === "text"), ...placed.filter(list => list.block === block)];
    }),
  ]);
}

/** A table's columns, whole. */
function columnsOf(columns: readonly string[]): string[] {
  return [...columns];
}

/** A table's cells, one per column, whole. */
function cellsOf(cells: readonly string[], columns: readonly string[]): readonly string[] {
  return Object.freeze(columns.map((_, at) => cells[at] ?? ""));
}

/** A list statement's table (ADR-0041): its columns, its rows and its caption, when it has one, whole. */
function listTable(shape: AskListShapeV2): { readonly columns: string[]; readonly rows: PersonAnswerTableRowV1[]; readonly caption?: string } {
  const columns = columnsOf(shape.columns);
  const caption = shape.caption;
  return { columns, rows: shape.rows.map(row => Object.freeze({ cells: cellsOf(row.cells, columns), citation_indexes: Object.freeze([...row.citation_indexes]) })), ...(caption.length === 0 ? {} : { caption }) };
}

type Run = { readonly shape: AskBlockShapeV2; readonly statements: number[] };
const blockOf = (shape: AskBlockShapeV2) => "block" in shape ? shape.block : undefined;
const titleOf = (shape: AskBlockShapeV2) => "title" in shape && shape.title !== undefined ? { title: shape.title } : {};

/**
 * The blocks of the statements a v2 answer kept, in their order: the answer; each list statement as its own table, or
 * as text; and each writer block's items as that block, its title on its first run. A points, table, timeline or card
 * block left with fewer than two items reads as text, keeping its title; consecutive untitled text is one block. Every
 * text is kept within the contract's bytes.
 */
export function buildAskBlocksV2(statements: readonly AskBlockStatementV2[]): readonly PersonAnswerBlockV2[] {
  // Runs: consecutive statements of one writer block and one kind. A list statement, a quote and plain text are each their own.
  const runs: Run[] = [];
  statements.forEach(({ shape }, at) => {
    const last = runs.at(-1);
    const block = blockOf(shape);
    if (last !== undefined && shape.kind === "list" && last.shape.kind === "list" && shape.group !== undefined && last.shape.group === shape.group) last.statements.push(at);
    else if (last !== undefined && block !== undefined && blockOf(last.shape) === block && last.shape.kind === shape.kind && shape.kind !== "quote") last.statements.push(at);
    else runs.push({ shape, statements: [at] });
  });
  const blocks: PersonAnswerBlockV2[] = [];
  const titled = new Set<number>();
  const text = (run: Run, title: { readonly title?: string }) => {
    const last = blocks.at(-1);
    if (title.title === undefined && last?.kind === "text" && last.title === undefined) blocks[blocks.length - 1] = { kind: "text", statements: [...last.statements, ...run.statements] };
    else blocks.push({ kind: "text", ...title, statements: run.statements });
  };
  for (const run of runs) {
    const { shape } = run;
    const block = blockOf(shape);
    // A block's title heads its first run only: the items read as text after its own follow it untitled.
    const opens = block !== undefined && !titled.has(block);
    if (block !== undefined) titled.add(block);
    const title = opens ? titleOf(shape) : {};
    // A run's statements are all of its kind.
    const items = run.statements.map(at => statements[at]!);
    // A block may show one item: no count forces it into text.
    const enough = run.statements.length >= 1;
    if (shape.kind === "answer") blocks.push({ kind: "answer", statements: run.statements });
    else if (shape.kind === "list") blocks.push({ kind: "table", statements: run.statements, ...listTable({ ...shape,
      rows: items.flatMap(({ shape: item }) => item.kind === "list" ? item.rows : []),
    }) });
    else if (shape.kind === "quote") blocks.push({ kind: "quote", statements: run.statements, text: shape.text, ...(shape.from === undefined ? {} : { from: shape.from }) });
    else if (shape.kind === "point" && enough) blocks.push({ kind: "points", ...title, ordered: shape.ordered, statements: run.statements });
    else if (shape.kind === "row" && enough) {
      const columns = columnsOf(shape.columns);
      blocks.push({ kind: "table", ...title, statements: run.statements, columns, rows: items.flatMap(({ shape: row, citation_indexes }) => row.kind !== "row" ? []
        : [Object.freeze({ cells: cellsOf(row.cells, columns), citation_indexes: Object.freeze([...citation_indexes]) })]) });
    } else if (shape.kind === "event" && enough) {
      blocks.push({ kind: "timeline", ...title, statements: run.statements, events: items.flatMap(({ shape: event }) => event.kind !== "event" ? []
        : [Object.freeze({ date: event.date, text: event.text, ...(event.who === undefined ? {} : { who: event.who }) })]) });
    } else if (shape.kind === "fact" && enough) {
      blocks.push({ kind: "card", title: shape.title, entity: shape.entity, statements: run.statements,
        facts: items.flatMap(({ shape: fact }) => fact.kind !== "fact" ? [] : [Object.freeze({ label: fact.label, value: fact.value })]) });
    } else text(run, title);
  }
  return Object.freeze(blocks.map(block => Object.freeze({ ...block, statements: Object.freeze([...block.statements]) })));
}

/** A text's words, as the checks read them: runs of letters and digits, joined across an inner apostrophe, dot, underscore or hyphen, lower case. */
function wordsOf(text: string): readonly string[] {
  return text.normalize("NFC").replace(/[‘’]/gu, "'").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+(?:['._-][\p{L}\p{N}]+)*/gu) ?? [];
}

/** Whether `quote` is in one of `sources` word for word: a run of its whole words, ignoring case and punctuation. */
export function quoteIsWordForWordV2(quote: string, sources: readonly string[]): boolean {
  const wanted = wordsOf(quote);
  if (wanted.length === 0) return false;
  return sources.some(source => {
    const words = wordsOf(source);
    return words.some((_, at) => wanted.every((word, offset) => words[at + offset] === word));
  });
}

const MONTHS: Readonly<Record<string, number>> = Object.freeze({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 });
const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/gu;
const MONTH_NAME = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;
const NAMED_DAY = new RegExp(String.raw`\b${MONTH_NAME}\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?`, "gu");
/** A day before its month's name: "4 November 2026", "4th of Nov". */
const DAY_FIRST = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_NAME}\b\.?(?:,?\s+(\d{4}))?`, "gu");
/** A numeric day: year first (2026/11/04, 2026.11.04), or day and month either way round with a year (04/11/2026). */
const YEAR_FIRST_DAY = /\b(\d{4})[/.](\d{1,2})[/.](\d{1,2})\b/gu;
const NUMERIC_DAY = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/gu;
/** A day written in Chinese or Japanese: 2026年11月4日, or 11月4日. */
const CJK_DAY = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/gu;

const dayOf = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const daysApart = (left: string, right: string) => Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`));

/**
 * Every day a text writes, as YYYY-MM-DD: an ISO day; a month's name with a day, either order ("Nov 3", "3 November");
 * a numeric day year first or, where only one reading is possible, day and month either way round; and a Chinese or
 * Japanese day (11月4日). A day with no year is read as the nearest such day to each of `anchors` (YYYY-MM-DD days, such as
 * the days its item records), so "Nov 3" in a note of Oct 27, 2025 is 2025-11-03, and "Jan 4" in one of Dec 28 is the
 * next January's. A day it cannot read leaves an event undated, never wrongly dated.
 */
export function daysWrittenV2(text: string, anchors: readonly string[]): ReadonlySet<string> {
  const days = new Set<string>();
  /** A month and day, with a year or else the nearest such day to each anchor. */
  const add = (month: number | undefined, day: number, year?: string) => {
    if (month === undefined || month < 1 || month > 12 || day < 1 || day > 31) return;
    if (year !== undefined) { days.add(dayOf(Number(year), month, day)); return; }
    for (const anchor of anchors) {
      const anchorYear = Number(anchor.slice(0, 4));
      const nearest = [anchorYear - 1, anchorYear, anchorYear + 1].map(candidate => dayOf(candidate, month, day)).sort((left, right) => daysApart(left, anchor) - daysApart(right, anchor))[0]!;
      days.add(nearest);
    }
  };
  const named = (name: string) => MONTHS[name.slice(0, 3).toLowerCase()];
  for (const found of text.matchAll(ISO_DAY)) days.add(`${found[1]}-${found[2]}-${found[3]}`);
  for (const found of text.matchAll(NAMED_DAY)) add(named(found[1]!), Number(found[2]), found[3]);
  for (const found of text.matchAll(DAY_FIRST)) add(named(found[2]!), Number(found[1]), found[3]);
  for (const found of text.matchAll(YEAR_FIRST_DAY)) add(Number(found[2]), Number(found[3]), found[1]);
  for (const found of text.matchAll(CJK_DAY)) add(Number(found[2]), Number(found[3]), found[1]);
  // 04/11/2026 is April 11 or November 4: read only when one reading is impossible or both are the same day, so an event
  // is never dated by a guess.
  for (const found of text.matchAll(NUMERIC_DAY)) {
    const [first, second] = [Number(found[1]), Number(found[2])];
    if (first > 12 && second <= 12) add(second, first, found[3]);
    else if (second > 12 && first <= 12) add(first, second, found[3]);
    else if (first === second) add(first, second, found[3]);
  }
  return days;
}
