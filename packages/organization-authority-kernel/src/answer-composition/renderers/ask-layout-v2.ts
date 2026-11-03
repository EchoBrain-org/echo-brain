import {
  PERSON_ANSWER_BLOCK_TITLE_MAX_BYTES_V2,
  PERSON_ANSWER_BLOCKS_MIN_ITEMS_V2,
  PERSON_ANSWER_CAPTION_MAX_BYTES_V1,
  PERSON_ANSWER_CELL_MAX_BYTES_V1,
  PERSON_ANSWER_COLUMN_MAX_BYTES_V1,
  type PersonAnswerBlockV2,
  type PersonAnswerTableRowV1,
} from "@echo-brain/organization-api";
import { boundedBytes, type AnswerItem } from "../agentic-ask-v1-model-protocol.js";

/**
 * How Ask lays out a V8 answer part with answer layout v2 (ADR-0051). The
 * writer arranges its answer from the block catalog, and code reads each item
 * it kept as one statement; here code orders those statements and groups them
 * into the contract's blocks. Layout adds no claim and no citation: a block
 * names the statements it shows, and a table row cites what its statement
 * cites. Code also checks what a block shows against the evidence its item
 * cites: a quote word for word, and an event's day.
 */

/** What one statement reads as: a writer's item, a list statement code writes as its table, or plain text. */
export type AskBlockShapeV2 =
  | AnswerItem
  | { readonly kind: "text" }
  | { readonly kind: "list"; readonly caption: string; readonly columns: readonly string[]; readonly rows: readonly PersonAnswerTableRowV1[] };
/** One statement the response kept, with its citations and its shape. */
export interface AskBlockStatementV2 {
  readonly citation_indexes: readonly number[];
  readonly shape: AskBlockShapeV2;
}

/**
 * A v2 answer's kept statements in reading order: the writer's answer, then the list statements code writes, then the
 * writer's other items block by block in its order, each block's own items first, then those that read as text, and a
 * timeline's events oldest first. Only when the writer gave no answer at all (`answered`) is its first kept item the
 * answer, and only when it is untitled text: an answer the writer gave and code left out (W1, a repeat) leaves the part
 * with none, rather than one the writer never chose.
 */
export function orderAskBlocksV2<L, S extends { readonly item: AnswerItem }>(lists: readonly L[], sentences: readonly S[], answered: boolean): readonly (L | S)[] {
  const first = sentences[0];
  const promoted = !answered && first !== undefined && first.item.kind === "text" && first.item.title === undefined;
  const answers = answered ? sentences.filter(sentence => sentence.item.kind === "answer")
    : promoted ? [{ ...first, item: Object.freeze({ block: first.item.block, kind: "answer" as const }) }] : [];
  const rest = sentences.filter(sentence => sentence.item.kind !== "answer" && !(promoted && sentence === first));
  const day = (sentence: S) => sentence.item.kind === "event" ? sentence.item.date : "";
  return Object.freeze([
    ...answers, ...lists,
    ...[...new Set(rest.map(sentence => sentence.item.block))].flatMap(block => {
      const own = rest.filter(sentence => sentence.item.block === block);
      // A stable sort, so events of one day keep the writer's order.
      const shown = own.filter(sentence => sentence.item.kind !== "text").sort((left, right) => day(left) < day(right) ? -1 : day(left) > day(right) ? 1 : 0);
      return [...shown, ...own.filter(sentence => sentence.item.kind === "text")];
    }),
  ]);
}

type Run = { readonly shape: AskBlockShapeV2; readonly block?: number; readonly statements: number[] };
const blockOf = (shape: AskBlockShapeV2) => "block" in shape ? shape.block : undefined;
const titleOf = (shape: AskBlockShapeV2) => "title" in shape && shape.title !== undefined ? { title: boundedBytes(shape.title, PERSON_ANSWER_BLOCK_TITLE_MAX_BYTES_V2) } : {};
/** A table's cells, one per column, each within the contract's bytes. */
const cellsOf = (cells: readonly string[], columns: readonly string[]) => Object.freeze(columns.map((_, at) => boundedBytes(cells[at] ?? "", PERSON_ANSWER_CELL_MAX_BYTES_V1)));

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
    if (last !== undefined && block !== undefined && last.block === block && last.shape.kind === shape.kind && shape.kind !== "quote") last.statements.push(at);
    else runs.push({ shape, ...(block === undefined ? {} : { block }), statements: [at] });
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
    // A block's title heads its first run only: the items read as text after its own follow it untitled.
    const opens = run.block !== undefined && !titled.has(run.block);
    if (run.block !== undefined) titled.add(run.block);
    const title = opens ? titleOf(shape) : {};
    const shapes = run.statements.map(at => statements[at]!.shape);
    const enough = run.statements.length >= PERSON_ANSWER_BLOCKS_MIN_ITEMS_V2;
    if (shape.kind === "answer") blocks.push({ kind: "answer", statements: run.statements });
    else if (shape.kind === "list") {
      const columns = shape.columns.map(column => boundedBytes(column, PERSON_ANSWER_COLUMN_MAX_BYTES_V1));
      const caption = boundedBytes(shape.caption, PERSON_ANSWER_CAPTION_MAX_BYTES_V1);
      blocks.push({
        kind: "table", statements: run.statements, columns,
        rows: shape.rows.map(row => Object.freeze({ cells: cellsOf(row.cells, columns), citation_indexes: Object.freeze([...row.citation_indexes]) })),
        ...(caption.length === 0 ? {} : { caption }),
      });
    } else if (shape.kind === "quote") blocks.push({ kind: "quote", statements: run.statements, text: shape.text, ...(shape.from === undefined ? {} : { from: shape.from }) });
    else if (shape.kind === "point" && enough) blocks.push({ kind: "points", ...title, ordered: shape.ordered, statements: run.statements });
    else if (shape.kind === "row" && enough) {
      const columns = shape.columns.map(column => boundedBytes(column, PERSON_ANSWER_COLUMN_MAX_BYTES_V1));
      blocks.push({
        kind: "table", ...title, statements: run.statements, columns,
        rows: run.statements.map((at, row) => Object.freeze({ cells: cellsOf((shapes[row] as Extract<AnswerItem, { kind: "row" }>).cells, columns), citation_indexes: Object.freeze([...statements[at]!.citation_indexes]) })),
      });
    } else if (shape.kind === "event" && enough) {
      blocks.push({ kind: "timeline", ...title, statements: run.statements, events: shapes.map(value => {
        const event = value as Extract<AnswerItem, { kind: "event" }>;
        return Object.freeze({ date: event.date, text: event.text, ...(event.who === undefined ? {} : { who: event.who }) });
      }) });
    } else if (shape.kind === "fact" && enough) {
      blocks.push({ kind: "card", title: boundedBytes(shape.title, PERSON_ANSWER_BLOCK_TITLE_MAX_BYTES_V2), entity: shape.entity, statements: run.statements, facts: shapes.map(value => {
        const fact = value as Extract<AnswerItem, { kind: "fact" }>;
        return Object.freeze({ label: fact.label, value: fact.value });
      }) });
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
const NAMED_DAY = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/gu;

const dayOf = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const daysApart = (left: string, right: string) => Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`));

/**
 * Every day a text writes, as YYYY-MM-DD: an ISO day, a month's name with a day and a year, and a month's name with a
 * day alone read as the nearest such day to each of `anchors` (YYYY-MM-DD days, such as the days its item records), so
 * "Nov 3" in a note of Oct 27, 2025 is 2025-11-03, and "Jan 4" in one of Dec 28 is the next January's.
 */
export function daysWrittenV2(text: string, anchors: readonly string[]): ReadonlySet<string> {
  const days = new Set<string>();
  for (const found of text.matchAll(ISO_DAY)) days.add(`${found[1]}-${found[2]}-${found[3]}`);
  for (const found of text.matchAll(NAMED_DAY)) {
    const month = MONTHS[found[1]!.slice(0, 3).toLowerCase()];
    const day = Number(found[2]);
    if (month === undefined || day < 1 || day > 31) continue;
    if (found[3] !== undefined) { days.add(dayOf(Number(found[3]), month, day)); continue; }
    for (const anchor of anchors) {
      const year = Number(anchor.slice(0, 4));
      const nearest = [year - 1, year, year + 1].map(candidate => dayOf(candidate, month, day)).sort((left, right) => daysApart(left, anchor) - daysApart(right, anchor))[0]!;
      days.add(nearest);
    }
  }
  return days;
}
