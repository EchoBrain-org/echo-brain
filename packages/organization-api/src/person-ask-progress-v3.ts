import type { PersonAnswerResponseV5 } from './person-answer-v5.js';
import type { PersonAnswerResponseV6 } from './person-answer-v6.js';
import type { PersonAnswerResponseV7 } from './person-answer-v7.js';
import type { PersonAnswerCitationV8, PersonAnswerResponseV8 } from './person-answer-v8.js';
import {
  validatePersonAnswerCitationV8, validatePersonAnswerResponseV5, validatePersonAnswerResponseV6, validatePersonAnswerResponseV7, validatePersonAnswerResponseV8,
} from './person-answer-v4.js';
import { askProgressCodec } from './person-ask-progress-codec.js';
import {
  PERSON_ASK_PROGRESS_COUNT_MAX_V1,
  PERSON_ASK_PROGRESS_EVENT_MAX_BYTES_V1,
  PERSON_ASK_PROGRESS_LINE_MAX_CHARS_V1,
  PERSON_ASK_PROGRESS_NAMED_MAX_V1,
  PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1,
  PERSON_ASK_RECEIPT_ELAPSED_MAX_MS_V1,
  PERSON_ASK_RECEIPT_MAX_BYTES_V1,
  PERSON_ASK_RECEIPT_ROWS_MAX_V1,
  validatePersonAskReceiptV1,
  type PersonAskProgressErrorEventV1,
  type PersonAskProgressStageEventV1,
} from './person-ask-progress-v1.js';
import { validatePersonAskReceiptV2, type PersonAskProgressSourceV2 } from './person-ask-progress-v2.js';
import { asEnumerableRecord as object, assertExactKeys, fail } from './validation.js';

/**
 * Ask progress V3 (ADR-0042): V2's stream, under ADR-0039's rules, for the V8 answer on `POST /v7/person/ask`. A searched
 * row may also name the workspace or a connected tool's containers, up to 16 sources; a named item is a V8 citation. Its
 * receipt's `looked_through` counts every item research was shown, rows included, where V1 and V2 count only what it read
 * in full (ADR-0043).
 */
export const PERSON_ASK_PROGRESS_HEADER_VALUE_V3 = '3';
/** Distinct sources one searched row names: twice V1's. */
export const PERSON_ASK_PROGRESS_SOURCES_MAX_V3 = 16;

/** A V2 source kind, ECHO's workspace, or a connected tool's containers, by the tool's id. */
export type PersonAskProgressSourceV3 =
  | PersonAskProgressSourceV2
  | { readonly kind: 'projects' | 'people' | 'tools' }
  | { readonly kind: 'containers'; readonly tool_id: string };
/** A named item: exactly the V8 answer citation's projection. */
export type PersonAskProgressItemV3 = PersonAnswerCitationV8;
export type PersonAskProgressStageEventV3 = PersonAskProgressStageEventV1;
export interface PersonAskProgressSearchedEventV3 {
  readonly type: 'searched';
  readonly sources: readonly PersonAskProgressSourceV3[];
  readonly found: number;
}
export interface PersonAskProgressReadEventV3 {
  readonly type: 'read';
  readonly items: readonly PersonAskProgressItemV3[];
}
/** V1's receipt, whose rows may name the workspace, containers and their items. */
export interface PersonAskReceiptV3 {
  /**
   * Distinct items research was shown after an access check, as a row or in
   * full (ADR-0043); at least the items listed. It never counts a neighbour
   * an open brought along, or an item released beside a row.
   */
  readonly looked_through: number;
  readonly elapsed_ms: number;
  readonly rows: readonly PersonAskReceiptRowV3[];
}
export type PersonAskReceiptRowV3 = PersonAskProgressSearchedEventV3 | PersonAskProgressReadEventV3;
/** Terminal: the released V8 answer, exactly as the `/v7` JSON body, with its receipt. */
export interface PersonAskProgressAnswerEventV3 {
  readonly type: 'answer';
  readonly response: PersonAnswerResponseV8;
  readonly receipt: PersonAskReceiptV3;
}
export type PersonAskProgressErrorEventV3 = PersonAskProgressErrorEventV1;
export type PersonAskProgressStepEventV3 = PersonAskProgressStageEventV3 | PersonAskProgressSearchedEventV3 | PersonAskProgressReadEventV3;
export type PersonAskProgressTerminalEventV3 = PersonAskProgressAnswerEventV3 | PersonAskProgressErrorEventV3;
export type PersonAskProgressEventV3 = PersonAskProgressStepEventV3 | PersonAskProgressTerminalEventV3;

/** `person ask --live --progress` on a `/v7` client: one line per step event, a V1 or V2 step being a V3 step too. */
export interface PersonAskProgressLineV3 {
  readonly ok: true;
  readonly progress: PersonAskProgressStepEventV3;
}
/** The final line: each streamed answer with its own receipt (V8 with V3, V7 with V2, V6 with V1), else no receipt. */
export interface PersonAskProgressResultLineV3 {
  readonly ok: true;
  readonly result: PersonAnswerResponseV8 | PersonAnswerResponseV7 | PersonAnswerResponseV6 | PersonAnswerResponseV5;
  readonly receipt?: PersonAskReceiptV3;
}

const V3 = askProgressCodec({
  plain_sources: ['meetings', 'documents', 'follow_ups', 'projects', 'people', 'tools'],
  tool_sources: ['tickets', 'pages', 'containers'],
  item: validatePersonAnswerCitationV8,
  answer: validatePersonAnswerResponseV8,
  bounds: {
    count: PERSON_ASK_PROGRESS_COUNT_MAX_V1, sources: PERSON_ASK_PROGRESS_SOURCES_MAX_V3, read_items: PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1,
    named: PERSON_ASK_PROGRESS_NAMED_MAX_V1, receipt_rows: PERSON_ASK_RECEIPT_ROWS_MAX_V1, receipt_bytes: PERSON_ASK_RECEIPT_MAX_BYTES_V1,
    receipt_elapsed_ms: PERSON_ASK_RECEIPT_ELAPSED_MAX_MS_V1, event_bytes: PERSON_ASK_PROGRESS_EVENT_MAX_BYTES_V1, line_chars: PERSON_ASK_PROGRESS_LINE_MAX_CHARS_V1,
  },
});

export function validatePersonAskProgressStepEventV3(value: unknown): PersonAskProgressStepEventV3 { return V3.step(value) as PersonAskProgressStepEventV3; }
export function validatePersonAskReceiptV3(value: unknown): PersonAskReceiptV3 { return V3.receipt(value) as PersonAskReceiptV3; }
export function formatPersonAskProgressEventV3(event: PersonAskProgressEventV3): string { return V3.format(event); }
export interface PersonAskProgressDecoderV3 { push(text: string): readonly PersonAskProgressEventV3[]; end(): void }
/** V1's decoder, for V3 events: it fails closed exactly as V1's does. */
export function createPersonAskProgressDecoderV3(): PersonAskProgressDecoderV3 { return V3.decoder() as PersonAskProgressDecoderV3; }
export function validatePersonAskProgressLineV3(value: unknown): PersonAskProgressLineV3 { return V3.line(value) as PersonAskProgressLineV3; }

export function validatePersonAskProgressResultLineV3(value: unknown): PersonAskProgressResultLineV3 {
  const input = object(value, 'Ask result line');
  assertExactKeys(input, ['ok', 'result', ...(Object.hasOwn(input, 'receipt') ? ['receipt'] : [])], 'Ask result line');
  if (input.ok !== true) fail('Ask result line is invalid');
  const version = object(input.result, 'Ask result line result').schema_version;
  // A receipt comes only with a streamed answer: V8 from `/v7`, V7 from `/v6`, V6 from `/v5`, each with its own receipt.
  if (Object.hasOwn(input, 'receipt') && version !== 8 && version !== 7 && version !== 6) fail('Ask result line receipt needs a streamed answer');
  const result = version === 8 ? validatePersonAnswerResponseV8(input.result) : version === 7 ? validatePersonAnswerResponseV7(input.result)
    : version === 6 ? validatePersonAnswerResponseV6(input.result) : validatePersonAnswerResponseV5(input.result);
  const receipt = !Object.hasOwn(input, 'receipt') ? undefined : version === 8 ? validatePersonAskReceiptV3(input.receipt)
    : version === 7 ? validatePersonAskReceiptV2(input.receipt) : validatePersonAskReceiptV1(input.receipt);
  return Object.freeze({ ok: true, result, ...(receipt === undefined ? {} : { receipt }) });
}
