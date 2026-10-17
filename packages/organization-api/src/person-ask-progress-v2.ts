import type { PersonAnswerResponseV5 } from './person-answer-v5.js';
import type { PersonAnswerResponseV6 } from './person-answer-v6.js';
import type { PersonAnswerCitationV7, PersonAnswerResponseV7 } from './person-answer-v7.js';
import { validatePersonAnswerCitationV7, validatePersonAnswerResponseV5, validatePersonAnswerResponseV6, validatePersonAnswerResponseV7 } from './person-answer-v4.js';
import { askProgressCodec } from './person-ask-progress-codec.js';
import {
  PERSON_ASK_PROGRESS_COUNT_MAX_V1,
  PERSON_ASK_PROGRESS_EVENT_MAX_BYTES_V1,
  PERSON_ASK_PROGRESS_LINE_MAX_CHARS_V1,
  PERSON_ASK_PROGRESS_NAMED_MAX_V1,
  PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1,
  PERSON_ASK_PROGRESS_SOURCES_MAX_V1,
  PERSON_ASK_RECEIPT_ELAPSED_MAX_MS_V1,
  PERSON_ASK_RECEIPT_MAX_BYTES_V1,
  PERSON_ASK_RECEIPT_ROWS_MAX_V1,
  validatePersonAskReceiptV1,
  type PersonAskProgressErrorEventV1,
  type PersonAskProgressSourceV1,
  type PersonAskProgressStageEventV1,
} from './person-ask-progress-v1.js';
import { asEnumerableRecord as object, assertExactKeys, fail } from './validation.js';

/**
 * Ask progress V2 (ADR-0039, ADR-0040): the same stream as V1, for the V7
 * answer on `POST /v6/person/ask`, which may read and cite follow-ups. A
 * client opts in with `PERSON_ASK_PROGRESS_HEADER_V1` set to `2`; the `/v5`
 * route keeps streaming V1 for `1`, so a V1 client never meets a follow-up.
 *
 * V2 adds exactly two things to V1, and nothing else changes: framing,
 * heartbeat, stages, bounds, the receipt's merge and coverage rules and the
 * terminal error event are V1's.
 * - A searched row may name `follow_ups`, ECHO's shared follow-ups.
 * - A named item, in a read event or a receipt row, is a V7 citation, so it
 *   may be a follow-up (`{ kind: 'follow_up', item_id }`, with the ref that
 *   opens its item page). The answer event carries the V7 answer.
 */
export const PERSON_ASK_PROGRESS_HEADER_VALUE_V2 = '2';

/** A V1 source kind, or ECHO's shared follow-ups. */
export type PersonAskProgressSourceV2 = PersonAskProgressSourceV1 | { readonly kind: 'follow_ups' };
/** A named item: exactly the V7 answer citation's projection. */
export type PersonAskProgressItemV2 = PersonAnswerCitationV7;
export type PersonAskProgressStageEventV2 = PersonAskProgressStageEventV1;
export interface PersonAskProgressSearchedEventV2 {
  readonly type: 'searched';
  readonly sources: readonly PersonAskProgressSourceV2[];
  readonly found: number;
}
export interface PersonAskProgressReadEventV2 {
  readonly type: 'read';
  readonly items: readonly PersonAskProgressItemV2[];
}
/** V1's receipt, whose rows may name follow-ups. */
export interface PersonAskReceiptV2 {
  readonly looked_through: number;
  readonly elapsed_ms: number;
  readonly rows: readonly PersonAskReceiptRowV2[];
}
export type PersonAskReceiptRowV2 = PersonAskProgressSearchedEventV2 | PersonAskProgressReadEventV2;
/** Terminal: the released V7 answer, exactly as the `/v6` JSON body, with its receipt. */
export interface PersonAskProgressAnswerEventV2 {
  readonly type: 'answer';
  readonly response: PersonAnswerResponseV7;
  readonly receipt: PersonAskReceiptV2;
}
export type PersonAskProgressErrorEventV2 = PersonAskProgressErrorEventV1;
export type PersonAskProgressStepEventV2 = PersonAskProgressStageEventV2 | PersonAskProgressSearchedEventV2 | PersonAskProgressReadEventV2;
export type PersonAskProgressTerminalEventV2 = PersonAskProgressAnswerEventV2 | PersonAskProgressErrorEventV2;
export type PersonAskProgressEventV2 = PersonAskProgressStepEventV2 | PersonAskProgressTerminalEventV2;

/**
 * `person ask --live --progress` on a client that prefers `/v6`: one line per
 * step event. A V1 step, from an Authority that only streams `/v5`, is a V2
 * step too, so one line shape serves both.
 */
export interface PersonAskProgressLineV2 {
  readonly ok: true;
  readonly progress: PersonAskProgressStepEventV2;
}
/**
 * The final line: the V7 answer with a V2 receipt when `/v6` streamed, the V6
 * answer with a V1 receipt when only `/v5` did, and no receipt when the
 * Authority did not stream (or for the `/v4` fallback).
 */
export interface PersonAskProgressResultLineV2 {
  readonly ok: true;
  readonly result: PersonAnswerResponseV7 | PersonAnswerResponseV6 | PersonAnswerResponseV5;
  readonly receipt?: PersonAskReceiptV2;
}

const V2 = askProgressCodec({
  plain_sources: ['meetings', 'documents', 'slack', 'follow_ups'],
  item: validatePersonAnswerCitationV7,
  answer: validatePersonAnswerResponseV7,
  bounds: {
    count: PERSON_ASK_PROGRESS_COUNT_MAX_V1, sources: PERSON_ASK_PROGRESS_SOURCES_MAX_V1, read_items: PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1,
    named: PERSON_ASK_PROGRESS_NAMED_MAX_V1, receipt_rows: PERSON_ASK_RECEIPT_ROWS_MAX_V1, receipt_bytes: PERSON_ASK_RECEIPT_MAX_BYTES_V1,
    receipt_elapsed_ms: PERSON_ASK_RECEIPT_ELAPSED_MAX_MS_V1, event_bytes: PERSON_ASK_PROGRESS_EVENT_MAX_BYTES_V1, line_chars: PERSON_ASK_PROGRESS_LINE_MAX_CHARS_V1,
  },
});

export function validatePersonAskProgressStepEventV2(value: unknown): PersonAskProgressStepEventV2 {
  return V2.step(value) as PersonAskProgressStepEventV2;
}

export function validatePersonAskReceiptV2(value: unknown): PersonAskReceiptV2 {
  return V2.receipt(value) as PersonAskReceiptV2;
}

/** Any one `/v6` stream event, terminal events included. */
export function validatePersonAskProgressEventV2(value: unknown): PersonAskProgressEventV2 {
  return V2.event(value) as PersonAskProgressEventV2;
}

export function formatPersonAskProgressEventV2(event: PersonAskProgressEventV2): string {
  return V2.format(event);
}

export interface PersonAskProgressDecoderV2 {
  push(text: string): readonly PersonAskProgressEventV2[];
  end(): void;
}

/** V1's decoder, for V2 events: it fails closed exactly as V1's does. */
export function createPersonAskProgressDecoderV2(): PersonAskProgressDecoderV2 {
  return V2.decoder() as PersonAskProgressDecoderV2;
}

export function validatePersonAskProgressLineV2(value: unknown): PersonAskProgressLineV2 {
  return V2.line(value) as PersonAskProgressLineV2;
}

export function validatePersonAskProgressResultLineV2(value: unknown): PersonAskProgressResultLineV2 {
  const input = object(value, 'Ask result line');
  assertExactKeys(input, ['ok', 'result', ...(Object.hasOwn(input, 'receipt') ? ['receipt'] : [])], 'Ask result line');
  if (input.ok !== true) fail('Ask result line is invalid');
  const version = object(input.result, 'Ask result line result').schema_version;
  // A receipt comes only with a streamed answer: V7 from `/v6`, V6 from `/v5`, each with its own receipt.
  if (Object.hasOwn(input, 'receipt') && version !== 7 && version !== 6) fail('Ask result line receipt needs a streamed answer');
  const result = version === 7 ? validatePersonAnswerResponseV7(input.result) : version === 6 ? validatePersonAnswerResponseV6(input.result) : validatePersonAnswerResponseV5(input.result);
  const receipt = !Object.hasOwn(input, 'receipt') ? undefined : version === 7 ? validatePersonAskReceiptV2(input.receipt) : validatePersonAskReceiptV1(input.receipt);
  return Object.freeze({ ok: true, result, ...(receipt === undefined ? {} : { receipt }) });
}
