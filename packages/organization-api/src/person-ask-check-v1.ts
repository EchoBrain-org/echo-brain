import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { validatePersonAnswerEvidenceCitationV8 } from './person-answer-v4.js';
import type { PersonAnswerEvidenceCitationV8 } from './person-answer-v8.js';
import { asEnumerableRecord, assertDigest, assertExactKeys, assertTimestamp, boundedList, fail, oneOf } from './validation.js';

/**
 * The Ask source check (Ask timeline v1, C1; ADR-0047). The desktop keeps old
 * answers on the device; this read takes the sources such an answer cited and
 * says, for each, whether it is the `same`, `changed`, `unreadable` or
 * `unknown`. It decides readability first: `changed` and a ticket's marker are
 * only ever returned for a source the caller can read now, and `unreadable`
 * never says why (hidden, deleted, out of scope and never existed are one
 * state). It returns no labels, text, counts or ids, makes no model call and
 * stores nothing (ADR-0012, ADR-0036). `unknown` is a source whose tool is not
 * connected, failed or ran past the check's budget or deadline.
 */
export const PERSON_ASK_CHECK_PATH_V1 = '/v1/person/ask/check';
export const PERSON_ASK_CHECK_REQUEST_KIND_V1 = 'echo-person-ask-check-request-v1';
export const PERSON_ASK_CHECK_KIND_V1 = 'echo-person-ask-check-v1';

/** The evidence citations a check reads; any other kind is `invalid_request`. */
export const PERSON_ASK_CHECK_CITATION_KINDS_V1 = Object.freeze(['approved_record', 'source_revision', 'follow_up', 'ticket', 'page'] as const);
export type PersonAskCheckCitationKindV1 = (typeof PERSON_ASK_CHECK_CITATION_KINDS_V1)[number];
export const PERSON_ASK_CHECK_STATES_V1 = Object.freeze(['same', 'changed', 'unreadable', 'unknown'] as const);
export type PersonAskCheckStateV1 = (typeof PERSON_ASK_CHECK_STATES_V1)[number];

/** 1 to 100 items, and a request body of at most 64 KiB of canonical JSON. */
export const PERSON_ASK_CHECK_LIMITS_V1 = Object.freeze({ items_min: 1, items_max: 100, body_bytes: 64 * 1024 });

export interface PersonAskCheckRequestItemV1 {
  /** When the turn whose answer cited this source was asked. */
  readonly asked_at: string;
  /** The evidence citation exactly as the answer's `citations[i].citation` carried it, of a kind in `PERSON_ASK_CHECK_CITATION_KINDS_V1`. */
  readonly citation: PersonAnswerEvidenceCitationV8;
  /** Only for a ticket: the marker an earlier check returned for it. */
  readonly marker?: string;
}

export interface PersonAskCheckRequestV1 {
  readonly schema_version: 1;
  readonly kind: typeof PERSON_ASK_CHECK_REQUEST_KIND_V1;
  /** 1 to 100, in the order the response answers them. */
  readonly items: readonly PersonAskCheckRequestItemV1[];
}

export interface PersonAskCheckItemV1 {
  readonly state: PersonAskCheckStateV1;
  /**
   * Only for a readable ticket (`same` or `changed`): its current marker, `sha256:` and the hex SHA-256 of the canonical JSON
   * of its summary, description, status name, assignee display name and due date.
   */
  readonly marker?: string;
}

export interface PersonAskCheckV1 {
  readonly schema_version: 1;
  readonly kind: typeof PERSON_ASK_CHECK_KIND_V1;
  /** Same length and order as the request's items. */
  readonly items: readonly PersonAskCheckItemV1[];
}

function citation(value: unknown, label: string): PersonAnswerEvidenceCitationV8 {
  const kind = asEnumerableRecord(value, `${label} citation`).kind;
  if (!(PERSON_ASK_CHECK_CITATION_KINDS_V1 as readonly unknown[]).includes(kind)) fail(`${label} citation kind is invalid`);
  return validatePersonAnswerEvidenceCitationV8(value);
}

function requestItem(value: unknown, label: string): PersonAskCheckRequestItemV1 {
  const input = asEnumerableRecord(value, label);
  const marked = Object.hasOwn(input, 'marker');
  assertExactKeys(input, ['asked_at', 'citation', ...(marked ? ['marker'] : [])], label);
  assertTimestamp(input.asked_at, `${label} asked_at`);
  const cited = citation(input.citation, label);
  if (marked) {
    if (cited.kind !== 'ticket') fail(`${label} marker is only for a ticket`);
    assertDigest(input.marker, `${label} marker`);
  }
  return Object.freeze({ asked_at: input.asked_at, citation: cited, ...(marked ? { marker: input.marker as string } : {}) });
}

export function validatePersonAskCheckRequestV1(value: unknown): PersonAskCheckRequestV1 {
  const input = asEnumerableRecord(value, 'Ask check request');
  assertExactKeys(input, ['schema_version', 'kind', 'items'], 'Ask check request');
  if (input.schema_version !== 1) fail('Ask check request schema_version is unsupported');
  if (input.kind !== PERSON_ASK_CHECK_REQUEST_KIND_V1) fail('Ask check request kind is invalid');
  const items = boundedList(input.items, 'Ask check request items', PERSON_ASK_CHECK_LIMITS_V1.items_max, PERSON_ASK_CHECK_LIMITS_V1.items_min)
    .map((entry, index) => requestItem(entry, `Ask check request item ${index}`));
  const result: PersonAskCheckRequestV1 = Object.freeze({ schema_version: 1, kind: PERSON_ASK_CHECK_REQUEST_KIND_V1, items: Object.freeze(items) });
  if (canonicalJsonBytes(result).byteLength > PERSON_ASK_CHECK_LIMITS_V1.body_bytes) fail('Ask check request exceeds its byte bound');
  return result;
}

function answerItem(value: unknown, label: string, asked: PersonAskCheckRequestItemV1 | undefined): PersonAskCheckItemV1 {
  const input = asEnumerableRecord(value, label);
  const marked = Object.hasOwn(input, 'marker');
  assertExactKeys(input, ['state', ...(marked ? ['marker'] : [])], label);
  const state = oneOf(input.state, PERSON_ASK_CHECK_STATES_V1, `${label} state`);
  const readable = state === 'same' || state === 'changed';
  if (marked) {
    assertDigest(input.marker, `${label} marker`);
    if (!readable) fail(`${label} marker is only for a readable ticket`);
  }
  // Against its request: a readable ticket always carries its marker, and nothing else ever does.
  if (asked !== undefined && marked !== (readable && asked.citation.kind === 'ticket')) fail(`${label} marker does not match its item`);
  return Object.freeze({ state, ...(marked ? { marker: input.marker as string } : {}) });
}

/**
 * The check's answer. With the request it answers, it must also answer every item in order, and carry a marker exactly on
 * each readable ticket.
 */
export function validatePersonAskCheckV1(value: unknown, request?: PersonAskCheckRequestV1): PersonAskCheckV1 {
  const input = asEnumerableRecord(value, 'Ask check');
  assertExactKeys(input, ['schema_version', 'kind', 'items'], 'Ask check');
  if (input.schema_version !== 1) fail('Ask check schema_version is unsupported');
  if (input.kind !== PERSON_ASK_CHECK_KIND_V1) fail('Ask check kind is invalid');
  const listed = boundedList(input.items, 'Ask check items', PERSON_ASK_CHECK_LIMITS_V1.items_max, PERSON_ASK_CHECK_LIMITS_V1.items_min);
  if (request !== undefined && listed.length !== request.items.length) fail('Ask check answers a different number of items');
  const items = listed.map((entry, index) => answerItem(entry, `Ask check item ${index}`, request?.items[index]));
  return Object.freeze({ schema_version: 1, kind: PERSON_ASK_CHECK_KIND_V1, items: Object.freeze(items) });
}
