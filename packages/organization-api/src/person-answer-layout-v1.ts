import { LAYOUT_CAPTION_MAX_BYTES, LAYOUT_CELL_MAX_BYTES, LAYOUT_COLUMN_MAX_BYTES, layoutIndexes, layoutLine, layoutTable } from './person-answer-layout-checks.js';
import { assertExactKeys, asEnumerableRecord as object, fail } from './validation.js';

/**
 * Answer layout v1 (ADR-0045): how a V8 answer part reads. The part's
 * statements stay the cited claims, validated as before; `layout` groups
 * them, in their order, into a lead, headings, paragraphs, bullets and tables.
 * It adds no claim and no citation: every block names the statements it
 * shows, and a table's rows cite only what its statements cite.
 *
 * A client asks for it with this header on an Ask, and for layout v2 with the
 * header's next value (ADR-0051). An answer to a request without the header
 * never carries a layout, so an older client never meets one.
 */
export const PERSON_ASK_ANSWER_LAYOUT_HEADER_V1 = 'x-echo-answer-layout';
export const PERSON_ASK_ANSWER_LAYOUT_HEADER_VALUE_V1 = '1';

const PERSON_ANSWER_LAYOUT_MAX_BLOCKS_V1 = 24;
/** One per statement at most: a part has at most ten, so every section keeps its own heading. */
const PERSON_ANSWER_LAYOUT_MAX_HEADINGS_V1 = 10;
/** A lead is the conclusion: one or two statements. */
export const PERSON_ANSWER_LEAD_MAX_STATEMENTS_V1 = 2;
export const PERSON_ANSWER_HEADING_MAX_BYTES_V1 = 200;
export const PERSON_ANSWER_COLUMN_MAX_BYTES_V1 = LAYOUT_COLUMN_MAX_BYTES;
export const PERSON_ANSWER_CELL_MAX_BYTES_V1 = LAYOUT_CELL_MAX_BYTES;
export const PERSON_ANSWER_CAPTION_MAX_BYTES_V1 = LAYOUT_CAPTION_MAX_BYTES;

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
      const own = layoutIndexes(input.statements, `${label} statements`, statements.length, 1, maximum);
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
      return Object.freeze({ kind: 'heading', text: layoutLine(input.text, `${label} text`, PERSON_ANSWER_HEADING_MAX_BYTES_V1) });
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
      return Object.freeze({ kind: 'table', statements: own, ...layoutTable(input, own, statements, citationCount, label) });
    }
    return fail('Ask answer layout block kind is invalid');
  });
  if (next !== statements.length) fail('Ask answer layout leaves a statement out');
  return Object.freeze(result);
}
