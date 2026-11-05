import { LAYOUT_CAPTION_MAX_BYTES, LAYOUT_CELL_MAX_BYTES, LAYOUT_COLUMN_MAX_BYTES, layoutIndexes, layoutLine, layoutTable } from './person-answer-layout-checks.js';
import { assertExactKeys, asEnumerableRecord as object, fail, isCalendarDay } from './validation.js';

/**
 * Answer layout v2 (ADR-0051): how a V8 answer part reads when the writer
 * arranges it from seven blocks. The part's statements stay the cited claims,
 * validated as before; `blocks` groups them, in their order, into an answer,
 * text, points, a table, a timeline, a card or a quote. Every item a block
 * shows is a statement: a point, a table row, a timeline event, a card fact
 * and a quote each cite what their statement cites, and a table's rows cite
 * only what its statements cite. Layout never adds a claim or a citation.
 *
 * A client asks for it with `x-echo-answer-layout: 2`. An answer to any other
 * request never carries `blocks`, so an older client never meets them.
 */
export const PERSON_ASK_ANSWER_LAYOUT_HEADER_V1 = 'x-echo-answer-layout';
export const PERSON_ASK_ANSWER_LAYOUT_HEADER_VALUE_V2 = '2';
/** The header's value for answer layout v1 (ADR-0045), now retired, which desktops and CLIs from before layout v2 still send. */
const RETIRED_LAYOUT_V1 = '1';

/** The answer layout an Ask asked for: 2 (ADR-0051), the only one. */
export type PersonAskAnswerLayoutV2 = 2;

/**
 * Which answer layout an Ask asked for: none when the header is absent, or asks for retired layout v1, so an older
 * client's Ask gets the answer a request without the header gets; 2 by its value; any other value is refused.
 */
export function validatePersonAskAnswerLayoutHeaderV2(value: unknown): PersonAskAnswerLayoutV2 | undefined {
  if (value === undefined || value === RETIRED_LAYOUT_V1) return undefined;
  if (value === PERSON_ASK_ANSWER_LAYOUT_HEADER_VALUE_V2) return 2;
  return fail('Ask answer layout header is invalid');
}

/** The answer is the conclusion: one or two statements. How many blocks, and items in a block, has no cap of its own. */
export const PERSON_ANSWER_BLOCKS_ANSWER_MAX_STATEMENTS_V2 = 2;
/** A points, table, timeline or card block shows at least two items; fewer read as text. */
export const PERSON_ANSWER_BLOCKS_MIN_ITEMS_V2 = 2;
export const PERSON_ANSWER_BLOCK_TITLE_MAX_BYTES_V2 = 200;
/** A table's column, cell and caption, in bytes, as answer layout v1 (ADR-0045) bounded them. */
export const PERSON_ANSWER_COLUMN_MAX_BYTES_V1 = LAYOUT_COLUMN_MAX_BYTES;
export const PERSON_ANSWER_CELL_MAX_BYTES_V1 = LAYOUT_CELL_MAX_BYTES;
export const PERSON_ANSWER_CAPTION_MAX_BYTES_V1 = LAYOUT_CAPTION_MAX_BYTES;
export const PERSON_ANSWER_EVENT_TEXT_MAX_BYTES_V2 = 2_048;
export const PERSON_ANSWER_WHO_MAX_BYTES_V2 = 200;
export const PERSON_ANSWER_FACT_LABEL_MAX_BYTES_V2 = LAYOUT_COLUMN_MAX_BYTES;
export const PERSON_ANSWER_FACT_VALUE_MAX_BYTES_V2 = LAYOUT_CELL_MAX_BYTES;
export const PERSON_ANSWER_QUOTE_TEXT_MAX_BYTES_V2 = 2_048;
export const PERSON_ANSWER_QUOTE_FROM_MAX_BYTES_V2 = 200;
/** The blocks a part reads as, in the catalog's order: every kind of PersonAnswerBlockV2. */
export const PERSON_ANSWER_BLOCK_KINDS_V2 = Object.freeze(['answer', 'text', 'points', 'table', 'timeline', 'card', 'quote'] as const) satisfies readonly PersonAnswerBlockV2['kind'][];
/** What a card shows: one person, project, ticket or decision. */
export const PERSON_ANSWER_CARD_ENTITIES_V2 = Object.freeze(['person', 'project', 'ticket', 'decision'] as const);
export type PersonAnswerCardEntityV2 = (typeof PERSON_ANSWER_CARD_ENTITIES_V2)[number];

/** One timeline event: the day it happened (YYYY-MM-DD), what happened, and who, when the evidence says. */
export interface PersonAnswerEventV2 {
  readonly date: string;
  readonly text: string;
  readonly who?: string;
}

/** One fact of a card, as a label and its value. */
export interface PersonAnswerFactV2 {
  readonly label: string;
  readonly value: string;
}

/** One table row: its cells, in the table's column order, and the citations of what it shows. */
export interface PersonAnswerTableRowV1 {
  /** One per column; an empty cell is a fact the row does not record. */
  readonly cells: readonly string[];
  /** At least one, each among the citations of the table's statements. */
  readonly citation_indexes: readonly number[];
}

/**
 * One block of a part's `blocks`. `statements` are indexes into the part's statements: a point, an event or a fact is
 * the statement in the same place, and a quote is its one statement. A table shows a list statement as one row per
 * member it names, captioned ("At least 12 Jira tickets updated since Monday"), or one writer statement per row.
 */
export type PersonAnswerBlockV2 =
  | { readonly kind: 'answer'; readonly statements: readonly number[] }
  | { readonly kind: 'text'; readonly title?: string; readonly statements: readonly number[] }
  | { readonly kind: 'points'; readonly title?: string; readonly ordered: boolean; readonly statements: readonly number[] }
  | {
    readonly kind: 'table'; readonly title?: string; readonly statements: readonly number[]; readonly columns: readonly string[];
    readonly rows: readonly PersonAnswerTableRowV1[]; readonly caption?: string;
  }
  | { readonly kind: 'timeline'; readonly title?: string; readonly statements: readonly number[]; readonly events: readonly PersonAnswerEventV2[] }
  | {
    readonly kind: 'card'; readonly title: string; readonly entity: PersonAnswerCardEntityV2; readonly statements: readonly number[];
    readonly facts: readonly PersonAnswerFactV2[];
  }
  | { readonly kind: 'quote'; readonly statements: readonly number[]; readonly text: string; readonly from?: string };

/** A real calendar day, written YYYY-MM-DD: any day the kernel reads, years 0000 to 0099 too. */
function calendarDay(value: unknown, label: string): string {
  if (!isCalendarDay(value)) fail(`${label} is invalid`);
  return value;
}

/**
 * A part's `blocks`, against the part's statements (each statement's `citation_indexes`) and the answer's citation
 * count. Every statement is in exactly one block, in the statements' order; the answer block, if any, is first; a
 * points, table, timeline or card block shows at least two items; an event or fact is one statement, and a quote is
 * exactly one; a timeline's days never go back; a table's rows cite exactly what its statements cite.
 */
export function validatePersonAnswerBlocksV2(
  value: unknown,
  statements: readonly { readonly citation_indexes: readonly number[] }[],
  citationCount: number,
): readonly PersonAnswerBlockV2[] {
  if (!Array.isArray(value) || value.length === 0) fail('Ask answer blocks are invalid');
  let next = 0;
  const result = (value as unknown[]).map((raw, place): PersonAnswerBlockV2 => {
    const input = object(raw, 'Ask answer block');
    const label = `Ask answer ${String(input.kind)} block`;
    /** The keys a block of `kind` has: its own, and a title where it may have one. */
    const keys = (own: readonly string[], optional: readonly string[] = []) => assertExactKeys(input, ['kind', 'statements', ...own, ...optional.filter(key => Object.hasOwn(input, key))], label);
    /** The block's statements: the next ones of the part, in order. */
    const shown = (minimum: number, maximum: number) => {
      const own = layoutIndexes(input.statements, `${label} statements`, statements.length, minimum, maximum);
      for (const index of own) {
        if (index !== next) fail('Ask answer blocks are out of order');
        next += 1;
      }
      return own;
    };
    const title = () => Object.hasOwn(input, 'title') ? { title: layoutLine(input.title, `${label} title`, PERSON_ANSWER_BLOCK_TITLE_MAX_BYTES_V2) } : {};
    const all = statements.length;
    switch (input.kind) {
      case 'answer':
        keys([]);
        if (place !== 0) fail('Ask answer block is misplaced');
        return Object.freeze({ kind: 'answer', statements: shown(1, PERSON_ANSWER_BLOCKS_ANSWER_MAX_STATEMENTS_V2) });
      case 'text':
        keys([], ['title']);
        return Object.freeze({ kind: 'text', ...title(), statements: shown(1, all) });
      case 'points':
        keys(['ordered'], ['title']);
        if (typeof input.ordered !== 'boolean') fail(`${label} ordered is invalid`);
        return Object.freeze({ kind: 'points', ...title(), ordered: input.ordered as boolean, statements: shown(PERSON_ANSWER_BLOCKS_MIN_ITEMS_V2, all) });
      case 'table': {
        keys(['columns', 'rows'], ['title', 'caption']);
        const titled = title();
        const own = shown(1, all);
        // Two or more rows, and as many rows and columns as its statements hold.
        return Object.freeze({ kind: 'table', ...titled, statements: own, ...layoutTable(input, own, statements, citationCount, label, PERSON_ANSWER_BLOCKS_MIN_ITEMS_V2) });
      }
      case 'timeline': {
        keys(['events'], ['title']);
        const titled = title();
        const own = shown(PERSON_ANSWER_BLOCKS_MIN_ITEMS_V2, all);
        if (!Array.isArray(input.events) || input.events.length !== own.length) fail(`${label} events is invalid`);
        const events = Object.freeze((input.events as unknown[]).map((rawEvent): PersonAnswerEventV2 => {
          const event = object(rawEvent, `${label} event`);
          assertExactKeys(event, ['date', 'text', ...(Object.hasOwn(event, 'who') ? ['who'] : [])], `${label} event`);
          return Object.freeze({
            date: calendarDay(event.date, `${label} event date`), text: layoutLine(event.text, `${label} event text`, PERSON_ANSWER_EVENT_TEXT_MAX_BYTES_V2),
            ...(Object.hasOwn(event, 'who') ? { who: layoutLine(event.who, `${label} event who`, PERSON_ANSWER_WHO_MAX_BYTES_V2) } : {}),
          });
        }));
        if (events.some((event, at) => at > 0 && event.date < events[at - 1]!.date)) fail(`${label} events are out of date order`);
        return Object.freeze({ kind: 'timeline', ...titled, statements: own, events });
      }
      case 'card': {
        keys(['title', 'entity', 'facts']);
        const titled = { title: layoutLine(input.title, `${label} title`, PERSON_ANSWER_BLOCK_TITLE_MAX_BYTES_V2) };
        if (!(PERSON_ANSWER_CARD_ENTITIES_V2 as readonly unknown[]).includes(input.entity)) fail(`${label} entity is invalid`);
        const own = shown(PERSON_ANSWER_BLOCKS_MIN_ITEMS_V2, all);
        if (!Array.isArray(input.facts) || input.facts.length !== own.length) fail(`${label} facts is invalid`);
        const facts = Object.freeze((input.facts as unknown[]).map((rawFact): PersonAnswerFactV2 => {
          const fact = object(rawFact, `${label} fact`);
          assertExactKeys(fact, ['label', 'value'], `${label} fact`);
          return Object.freeze({ label: layoutLine(fact.label, `${label} fact label`, PERSON_ANSWER_FACT_LABEL_MAX_BYTES_V2), value: layoutLine(fact.value, `${label} fact value`, PERSON_ANSWER_FACT_VALUE_MAX_BYTES_V2) });
        }));
        return Object.freeze({ kind: 'card', ...titled, entity: input.entity as PersonAnswerCardEntityV2, statements: own, facts });
      }
      case 'quote':
        keys(['text'], ['from']);
        return Object.freeze({
          kind: 'quote', statements: shown(1, 1), text: layoutLine(input.text, `${label} text`, PERSON_ANSWER_QUOTE_TEXT_MAX_BYTES_V2),
          ...(Object.hasOwn(input, 'from') ? { from: layoutLine(input.from, `${label} from`, PERSON_ANSWER_QUOTE_FROM_MAX_BYTES_V2) } : {}),
        });
      default:
        return fail('Ask answer block kind is invalid');
    }
  });
  if (next !== statements.length) fail('Ask answer blocks leave a statement out');
  return Object.freeze(result);
}
