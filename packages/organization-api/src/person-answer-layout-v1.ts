import { assertExactKeys, asEnumerableRecord as object, fail, utf8ByteLength } from './validation.js';

/**
 * Answer layout v1 (ADR-0045): how a V8 answer part reads. The part's
 * statements stay the cited claims, validated as before; `layout` groups
 * them, in their order, into a lead, headings, paragraphs, bullets and tables.
 * It adds no claim and no citation: every block names the statements it
 * shows, and a table's rows cite only what its statements cite.
 *
 * A client asks for it with this header on an Ask. An Authority that
 * predates it ignores the header and answers without `layout`; an answer to a
 * request without the header never carries one, so an older client never
 * meets it.
 */
export const PERSON_ASK_ANSWER_LAYOUT_HEADER_V1 = 'x-echo-answer-layout';
export const PERSON_ASK_ANSWER_LAYOUT_HEADER_VALUE_V1 = '1';

export const PERSON_ANSWER_LAYOUT_MAX_BLOCKS_V1 = 24;
export const PERSON_ANSWER_LAYOUT_MAX_HEADINGS_V1 = 6;
/** A lead is the conclusion: one or two statements. */
export const PERSON_ANSWER_LEAD_MAX_STATEMENTS_V1 = 2;
export const PERSON_ANSWER_TABLE_MIN_COLUMNS_V1 = 2;
export const PERSON_ANSWER_TABLE_MAX_COLUMNS_V1 = 6;
/** A list names at most 25 members (ADR-0041), so a table of one has at most 25 rows. */
export const PERSON_ANSWER_TABLE_MAX_ROWS_V1 = 25;
export const PERSON_ANSWER_HEADING_MAX_BYTES_V1 = 200;
export const PERSON_ANSWER_COLUMN_MAX_BYTES_V1 = 100;
export const PERSON_ANSWER_CELL_MAX_BYTES_V1 = 300;
export const PERSON_ANSWER_CAPTION_MAX_BYTES_V1 = 600;

/** One table row: its cells, in the table's column order, and the citations of what it shows. */
export interface PersonAnswerTableRowV1 {
  /** One per column; an empty cell is a fact the row does not record. */
  readonly cells: readonly string[];
  /** At least one, each among the citations of the table's statements. */
  readonly citation_indexes: readonly number[];
}

/**
 * One block of a part's layout. `statements` are indexes into the part's
 * statements. A table shows its statements as rows: a list statement as one
 * row per member it names, or one writer statement per row; its `caption`
 * says what the rows are ("At least 12 Jira tickets updated since Monday").
 */
export type PersonAnswerBlockV1 =
  | { readonly kind: 'lead'; readonly statements: readonly number[] }
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly statements: readonly number[] }
  | { readonly kind: 'bullets'; readonly statements: readonly number[] }
  | {
    readonly kind: 'table'; readonly statements: readonly number[]; readonly columns: readonly string[];
    readonly rows: readonly PersonAnswerTableRowV1[]; readonly caption?: string;
  };

/** Whether an Ask asked for answer layout v1: absent is no, the header's value is yes, anything else is refused. */
export function validatePersonAskAnswerLayoutHeaderV1(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === PERSON_ASK_ANSWER_LAYOUT_HEADER_VALUE_V1) return true;
  return fail('Ask answer layout header is invalid');
}

/** Single-line, NFC, trimmed text within `maximumBytes`; empty only when `empty`. */
function line(value: unknown, label: string, maximumBytes: number, empty = false): string {
  if (
    typeof value !== 'string' || (value.length === 0 && !empty) || value.trim() !== value || value !== value.normalize('NFC') ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || utf8ByteLength(value) > maximumBytes
  ) fail(`${label} is invalid`);
  return value as string;
}

/** Distinct whole indexes below `bound`, between `minimum` and `maximum` of them. */
function indexes(value: unknown, label: string, bound: number, minimum: number, maximum: number): readonly number[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} is invalid`);
  const result = (value as unknown[]).map((index) => {
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= bound) fail(`${label} is invalid`);
    return index as number;
  });
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  return Object.freeze(result);
}

/**
 * A part's layout, against the part's statements (each statement's
 * `citation_indexes`) and the answer's citation count. Every statement is in
 * exactly one block, in the statements' order; a lead opens the layout; a
 * heading is followed by a block that is not a heading; a table's rows cite
 * exactly what its statements cite.
 */
export function validatePersonAnswerLayoutV1(
  value: unknown,
  statements: readonly { readonly citation_indexes: readonly number[] }[],
  citationCount: number,
): readonly PersonAnswerBlockV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PERSON_ANSWER_LAYOUT_MAX_BLOCKS_V1) fail('Ask answer layout is invalid');
  const blocks = value as unknown[];
  let next = 0;
  let headings = 0;
  const result = blocks.map((raw, place): PersonAnswerBlockV1 => {
    const input = object(raw, 'Ask answer layout block');
    const label = `Ask answer layout ${String(input.kind)}`;
    /** The block's statements: the next ones of the part, in order. */
    const shown = (maximum: number) => {
      const own = indexes(input.statements, `${label} statements`, statements.length, 1, maximum);
      for (const index of own) {
        if (index !== next) fail('Ask answer layout statements are out of order');
        next += 1;
      }
      return own;
    };
    if (input.kind === 'heading') {
      assertExactKeys(input, ['kind', 'text'], label);
      headings += 1;
      if (headings > PERSON_ANSWER_LAYOUT_MAX_HEADINGS_V1 || place === blocks.length - 1 || object(blocks[place + 1], 'Ask answer layout block').kind === 'heading') fail('Ask answer layout heading is misplaced');
      return Object.freeze({ kind: 'heading', text: line(input.text, `${label} text`, PERSON_ANSWER_HEADING_MAX_BYTES_V1) });
    }
    if (input.kind === 'lead') {
      assertExactKeys(input, ['kind', 'statements'], label);
      if (place !== 0) fail('Ask answer layout lead is misplaced');
      return Object.freeze({ kind: 'lead', statements: shown(PERSON_ANSWER_LEAD_MAX_STATEMENTS_V1) });
    }
    if (input.kind === 'paragraph' || input.kind === 'bullets') {
      assertExactKeys(input, ['kind', 'statements'], label);
      const own = shown(statements.length);
      // One bullet is a paragraph.
      if (input.kind === 'bullets' && own.length < 2) fail(`${label} is invalid`);
      return Object.freeze({ kind: input.kind, statements: own });
    }
    if (input.kind === 'table') {
      assertExactKeys(input, ['kind', 'statements', 'columns', 'rows', ...(Object.hasOwn(input, 'caption') ? ['caption'] : [])], label);
      const own = shown(statements.length);
      if (!Array.isArray(input.columns) || input.columns.length < PERSON_ANSWER_TABLE_MIN_COLUMNS_V1 || input.columns.length > PERSON_ANSWER_TABLE_MAX_COLUMNS_V1) fail(`${label} columns is invalid`);
      const columns = Object.freeze((input.columns as unknown[]).map(column => line(column, `${label} column`, PERSON_ANSWER_COLUMN_MAX_BYTES_V1)));
      if (new Set(columns).size !== columns.length) fail(`${label} columns contains duplicates`);
      if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > PERSON_ANSWER_TABLE_MAX_ROWS_V1) fail(`${label} rows is invalid`);
      const cited = new Set(own.flatMap(index => statements[index]!.citation_indexes));
      const rowCited = new Set<number>();
      const rows = Object.freeze((input.rows as unknown[]).map((rawRow) => {
        const row = object(rawRow, `${label} row`);
        assertExactKeys(row, ['cells', 'citation_indexes'], `${label} row`);
        if (!Array.isArray(row.cells) || row.cells.length !== columns.length) fail(`${label} row cells is invalid`);
        const cells = Object.freeze((row.cells as unknown[]).map(cell => line(cell, `${label} cell`, PERSON_ANSWER_CELL_MAX_BYTES_V1, true)));
        if (cells.every(cell => cell === '')) fail(`${label} row is empty`);
        const rowIndexes = indexes(row.citation_indexes, `${label} row citation_indexes`, citationCount, 1, 40);
        for (const index of rowIndexes) {
          if (!cited.has(index)) fail(`${label} row cites what its statements do not`);
          rowCited.add(index);
        }
        return Object.freeze({ cells, citation_indexes: rowIndexes });
      }));
      if (rowCited.size !== cited.size) fail(`${label} rows leave a citation of its statements out`);
      return Object.freeze({
        kind: 'table', statements: own, columns, rows,
        ...(Object.hasOwn(input, 'caption') ? { caption: line(input.caption, `${label} caption`, PERSON_ANSWER_CAPTION_MAX_BYTES_V1) } : {}),
      });
    }
    return fail('Ask answer layout block kind is invalid');
  });
  if (next !== statements.length) fail('Ask answer layout leaves a statement out');
  return Object.freeze(result);
}
