import {
  PERSON_ANSWER_CAPTION_MAX_BYTES_V1,
  PERSON_ANSWER_CELL_MAX_BYTES_V1,
  PERSON_ANSWER_COLUMN_MAX_BYTES_V1,
  PERSON_ANSWER_HEADING_MAX_BYTES_V1,
  PERSON_ANSWER_LAYOUT_MAX_HEADINGS_V1,
  PERSON_ANSWER_LEAD_MAX_STATEMENTS_V1,
  type PersonAnswerBlockV1,
  type PersonAnswerTableRowV1,
} from "@echo-brain/organization-api";
import { boundedBytes } from "../agentic-ask-v1-model-protocol.js";

/**
 * How Ask lays out a V8 answer part (answer layout v1, ADR-0045). The writer
 * marks each sentence's form and section, and code tabulates list statements;
 * here code orders the statements lead first and groups the ones the response
 * kept into blocks. Layout adds no claim and no citation: a block names the
 * statements it shows, and a table row cites what its statement cites.
 */

/** What one statement reads as: the lead, prose, a bullet or a row of its section's table, or a list statement as its own table. */
export type AskLayoutShapeV1 =
  | { readonly kind: "lead" | "text" | "bullet"; readonly section?: string }
  | { readonly kind: "row"; readonly section?: string; readonly columns: readonly string[]; readonly cells: readonly string[] }
  | {
    readonly kind: "list"; readonly caption: string; readonly columns: readonly string[];
    readonly rows: readonly { readonly cells: readonly string[]; readonly citation_indexes: readonly number[] }[];
  };
/** One statement the response kept, with its citations and its shape. */
export interface AskLayoutStatementV1 {
  readonly citation_indexes: readonly number[];
  readonly shape: AskLayoutShapeV1;
}

const LEAD = Object.freeze({ kind: "lead" as const });
const sectionOf = (shape: { readonly kind: string; readonly section?: string }) => shape.kind === "list" ? undefined : shape.section;

/**
 * A laid-out answer's statements in reading order: the writer's first two leads, then the list statements code writes,
 * then the writer's other sentences, those with no section first, then each section's in order of its first sentence.
 * A later lead is prose. With no lead, the first prose sentence with no section is the lead. A lead has no section.
 */
export function orderAskLayoutV1<L, S extends { readonly shape: { readonly kind: string; readonly section?: string } }>(lists: readonly L[], sentences: readonly S[]): readonly (L | S)[] {
  const marked = sentences.filter(sentence => sentence.shape.kind === "lead").slice(0, PERSON_ANSWER_LEAD_MAX_STATEMENTS_V1);
  const promoted = marked.length > 0 ? undefined : sentences.find(sentence => sentence.shape.kind === "text" && sentence.shape.section === undefined);
  const leads = promoted === undefined ? marked : [promoted];
  const rest = sentences.filter(sentence => !leads.includes(sentence)).map(sentence => sentence.shape.kind !== "lead" ? sentence
    : { ...sentence, shape: { kind: "text", ...(sentence.shape.section === undefined ? {} : { section: sentence.shape.section }) } } as S);
  const sections = [...new Set(rest.flatMap(sentence => sentence.shape.section ?? []))];
  return Object.freeze([
    ...leads.map(lead => ({ ...lead, shape: LEAD }) as S), ...lists,
    ...[undefined, ...sections].flatMap(section => rest.filter(sentence => sentence.shape.section === section)),
  ]);
}

type Draft =
  | { readonly kind: "lead" | "paragraph" | "bullets"; readonly statements: number[] }
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "table"; readonly statements: number[]; readonly columns: readonly string[]; readonly rows: PersonAnswerTableRowV1[]; readonly caption?: string; readonly key?: string };

/** A table's cells, one per column, each within the contract's bytes. */
function cellsOf(cells: readonly string[], columns: readonly string[]): readonly string[] {
  return Object.freeze(columns.map((_, at) => boundedBytes(cells[at] ?? "", PERSON_ANSWER_CELL_MAX_BYTES_V1)));
}

/**
 * The blocks of the statements a response kept, in their order: the leads that open them (at most two) as the lead;
 * a heading where each section starts, sections past six read under the sixth; consecutive prose as one paragraph,
 * two or more consecutive bullets as bullets and one as prose; consecutive rows of one section's table as that table;
 * and each list statement as its own table, captioned. Every text is kept within the contract's bytes.
 */
export function buildAskLayoutV1(statements: readonly AskLayoutStatementV1[]): readonly PersonAnswerBlockV1[] {
  const drafts: Draft[] = [];
  let at = 0;
  const lead: number[] = [];
  while (at < statements.length && lead.length < PERSON_ANSWER_LEAD_MAX_STATEMENTS_V1 && statements[at]!.shape.kind === "lead") lead.push(at++);
  if (lead.length > 0) drafts.push({ kind: "lead", statements: lead });
  let section: string | undefined;
  let headings = 0;
  for (; at < statements.length; at += 1) {
    const { shape, citation_indexes } = statements[at]!;
    const own = sectionOf(shape);
    if (own !== undefined && own !== section && headings < PERSON_ANSWER_LAYOUT_MAX_HEADINGS_V1) {
      drafts.push({ kind: "heading", text: boundedBytes(own, PERSON_ANSWER_HEADING_MAX_BYTES_V1) });
      headings += 1;
      section = own;
    }
    const last = drafts.at(-1);
    if (shape.kind === "list") {
      const columns = shape.columns.map(column => boundedBytes(column, PERSON_ANSWER_COLUMN_MAX_BYTES_V1));
      const caption = boundedBytes(shape.caption, PERSON_ANSWER_CAPTION_MAX_BYTES_V1);
      drafts.push({
        kind: "table", statements: [at], columns, rows: shape.rows.map(row => Object.freeze({ cells: cellsOf(row.cells, columns), citation_indexes: Object.freeze([...row.citation_indexes]) })),
        ...(caption.length === 0 ? {} : { caption }),
      });
    } else if (shape.kind === "row") {
      const columns = shape.columns.map(column => boundedBytes(column, PERSON_ANSWER_COLUMN_MAX_BYTES_V1));
      const row = Object.freeze({ cells: cellsOf(shape.cells, columns), citation_indexes: Object.freeze([...citation_indexes]) });
      // One table per section's columns: a list's table, or another section's, starts a new one.
      const key = JSON.stringify([own ?? null, columns]);
      if (last?.kind === "table" && last.key === key) { last.statements.push(at); last.rows.push(row); }
      else drafts.push({ kind: "table", statements: [at], columns, rows: [row], key });
    } else {
      // A lead past the opening ones reads as prose.
      const kind = shape.kind === "bullet" ? "bullets" : "paragraph";
      if (last?.kind === kind) last.statements.push(at);
      else drafts.push({ kind, statements: [at] });
    }
  }
  // One bullet is prose, and reads as one paragraph with the prose beside it.
  const blocks: Draft[] = [];
  for (const draft of drafts) {
    const previous = blocks.at(-1);
    const prose = draft.kind === "paragraph" || (draft.kind === "bullets" && draft.statements.length < 2);
    if (prose && previous?.kind === "paragraph") previous.statements.push(...draft.statements);
    else blocks.push(prose ? { kind: "paragraph", statements: [...draft.statements] } : draft);
  }
  return Object.freeze(blocks.map((block): PersonAnswerBlockV1 => {
    if (block.kind === "heading") return Object.freeze({ kind: "heading", text: block.text });
    if (block.kind !== "table") return Object.freeze({ kind: block.kind, statements: Object.freeze(block.statements) });
    return Object.freeze({
      kind: "table", statements: Object.freeze(block.statements), columns: Object.freeze([...block.columns]), rows: Object.freeze(block.rows),
      ...(block.caption === undefined ? {} : { caption: block.caption }),
    });
  }));
}
