import { assertExactKeys, asEnumerableRecord as object, fail, utf8ByteLength } from './validation.js';

/**
 * What answer layouts v1 (ADR-0045) and v2 (ADR-0051) check alike: a text, a
 * block's statements, and a table over its statements. Internal: the index
 * exports each layout's own validator, never these.
 */

const TABLE_MIN_COLUMNS = 2;
/**
 * How many rows and columns a table may have: layout v1's at most 6 columns, and 25 rows, since a list names at most 25
 * members (ADR-0041). Layout v2's tables have no cap of their own (ADR-0051).
 */
export interface LayoutTableCounts {
  readonly minimumRows: number;
  readonly maximumColumns: number;
  readonly maximumRows: number;
}
const V1_TABLE_COUNTS: LayoutTableCounts = Object.freeze({ minimumRows: 1, maximumColumns: 6, maximumRows: 25 });
export const LAYOUT_COLUMN_MAX_BYTES = 100;
export const LAYOUT_CELL_MAX_BYTES = 300;
export const LAYOUT_CAPTION_MAX_BYTES = 600;

/** Single-line, NFC, trimmed text within `maximumBytes`; empty only when `empty`. */
export function layoutLine(value: unknown, label: string, maximumBytes: number, empty = false): string {
  if (
    typeof value !== 'string' || (value.length === 0 && !empty) || value.trim() !== value || value !== value.normalize('NFC') ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || utf8ByteLength(value) > maximumBytes
  ) fail(`${label} is invalid`);
  return value as string;
}

/** Distinct whole indexes below `bound`, between `minimum` and `maximum` of them. */
export function layoutIndexes(value: unknown, label: string, bound: number, minimum: number, maximum: number): readonly number[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} is invalid`);
  const result = (value as unknown[]).map((index) => {
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= bound) fail(`${label} is invalid`);
    return index as number;
  });
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  return Object.freeze(result);
}

/**
 * A table's columns, rows and caption, against the statements it shows (`own`, indexes into `statements`) and the
 * answer's citation count: at least 2 distinct columns and `counts`' rows, of one cell per column, none empty, within
 * `counts`, and rows that together cite exactly what its statements cite.
 */
export function layoutTable(
  input: Record<string, unknown>,
  own: readonly number[],
  statements: readonly { readonly citation_indexes: readonly number[] }[],
  citationCount: number,
  label: string,
  counts: LayoutTableCounts = V1_TABLE_COUNTS,
): {
  readonly columns: readonly string[]; readonly rows: readonly { readonly cells: readonly string[]; readonly citation_indexes: readonly number[] }[]; readonly caption?: string;
} {
  if (!Array.isArray(input.columns) || input.columns.length < TABLE_MIN_COLUMNS || input.columns.length > counts.maximumColumns) fail(`${label} columns is invalid`);
  const columns = Object.freeze((input.columns as unknown[]).map(column => layoutLine(column, `${label} column`, LAYOUT_COLUMN_MAX_BYTES)));
  if (new Set(columns).size !== columns.length) fail(`${label} columns contains duplicates`);
  if (!Array.isArray(input.rows) || input.rows.length < counts.minimumRows || input.rows.length > counts.maximumRows) fail(`${label} rows is invalid`);
  const cited = new Set(own.flatMap(index => statements[index]!.citation_indexes));
  const rowCited = new Set<number>();
  const rows = Object.freeze((input.rows as unknown[]).map((rawRow) => {
    const row = object(rawRow, `${label} row`);
    assertExactKeys(row, ['cells', 'citation_indexes'], `${label} row`);
    if (!Array.isArray(row.cells) || row.cells.length !== columns.length) fail(`${label} row cells is invalid`);
    const cells = Object.freeze((row.cells as unknown[]).map(cell => layoutLine(cell, `${label} cell`, LAYOUT_CELL_MAX_BYTES, true)));
    if (cells.every(cell => cell === '')) fail(`${label} row is empty`);
    const rowIndexes = layoutIndexes(row.citation_indexes, `${label} row citation_indexes`, citationCount, 1, 40);
    for (const index of rowIndexes) {
      if (!cited.has(index)) fail(`${label} row cites what its statements do not`);
      rowCited.add(index);
    }
    return Object.freeze({ cells, citation_indexes: rowIndexes });
  }));
  if (rowCited.size !== cited.size) fail(`${label} rows leave a citation of its statements out`);
  return {
    columns, rows,
    ...(Object.hasOwn(input, 'caption') ? { caption: layoutLine(input.caption, `${label} caption`, LAYOUT_CAPTION_MAX_BYTES) } : {}),
  };
}
