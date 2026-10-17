import { canonicalJson, canonicalJsonBytes } from '@echo-brain/federation-protocol';
import type { OrganizationApiErrorV1 } from './contracts.js';
import type { PersonAnswerResponseV5 } from './person-answer-v5.js';
import type { PersonAnswerCitationV6, PersonAnswerResponseV6 } from './person-answer-v6.js';
import { validatePersonAnswerCitationV6, validatePersonAnswerResponseV5, validatePersonAnswerResponseV6 } from './person-answer-v4.js';
import { asEnumerableRecord as object, assertExactKeys, assertPatternString, fail, validateOrganizationApiError } from './validation.js';

/**
 * Ask progress V1 (ADR-0039): while a live Ask runs, `POST /v5/person/ask`
 * streams what ECHO is doing as server-sent events, then the released answer
 * with a receipt. A client opts in with one request header; without it, or
 * on an Authority that predates it, the route answers with today's JSON.
 *
 * Framing: each event is exactly one `data: <JSON>` line followed by a blank
 * line, with no `event`, `id` or `retry` fields. A comment heartbeat keeps
 * proxies from timing out an idle stream. The last event is the one terminal
 * event (`answer` or `error`); nothing follows it.
 *
 * Before the answer, events carry only the stage, the source kinds a step
 * searched with a count of what those reads returned to this person, how many
 * items are about to be read, and the citation projection of items whose full
 * text the research model is about to be given, sent only after the access
 * check before that model call. Never notes, needs, plans, model-written or
 * provider queries, bodies, excerpts, scratchpad ids, rounds or hidden counts.
 */

/** Opt-in request header for `/v5/person/ask`; only this exact value streams. */
export const PERSON_ASK_PROGRESS_HEADER_V1 = 'x-echo-ask-progress';
export const PERSON_ASK_PROGRESS_HEADER_VALUE_V1 = '1';
/** The streamed response's media type; a JSON response means the Authority did not stream. */
export const PERSON_ASK_PROGRESS_CONTENT_TYPE_V1 = 'text/event-stream';
/** How often the Authority writes the heartbeat comment while nothing else is sent. */
export const PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1 = 10_000;
export const PERSON_ASK_PROGRESS_HEARTBEAT_V1 = ': keep-alive\n\n';
/** Items named in one run; reads beyond it still count in `looked_through` but are not named. */
export const PERSON_ASK_PROGRESS_NAMED_MAX_V1 = 100;
/** Items in one `read` event; a larger batch is sent as consecutive `read` events. */
export const PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1 = 25;
export const PERSON_ASK_PROGRESS_SOURCES_MAX_V1 = 8;
/** Bound on every count an event carries. */
export const PERSON_ASK_PROGRESS_COUNT_MAX_V1 = 1000;
export const PERSON_ASK_RECEIPT_ROWS_MAX_V1 = 64;
export const PERSON_ASK_RECEIPT_MAX_BYTES_V1 = 64 * 1024;
export const PERSON_ASK_RECEIPT_ELAPSED_MAX_MS_V1 = 300_000;
/** Canonical JSON bytes of any one event, the answer event included. */
export const PERSON_ASK_PROGRESS_EVENT_MAX_BYTES_V1 = 192 * 1024;
/** Characters of one stream line the decoder buffers before it fails closed. */
export const PERSON_ASK_PROGRESS_LINE_MAX_CHARS_V1 = 256 * 1024;
/**
 * UTF-8 bytes of one whole stream; a client stops reading and fails closed
 * beyond it. The bounds above keep a run well under it (about 610 KB at
 * worst), and the CLI's lines then stay under the desktop's 1 MiB output cap.
 */
export const PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1 = 768 * 1024;

/**
 * What ECHO is doing now, from what it actually ran: `searching` while a
 * research step's search or list reads run, `reading` while its open reads
 * run and while the research model reads, `checking_access` during the final
 * access check and audit, `writing` during the answer writer's call.
 */
export type PersonAskProgressStageV1 = 'searching' | 'reading' | 'checking_access' | 'writing';

/**
 * A source kind a step read, from the request's server-selected catalog. A
 * live tool is named by its tool id (`jira`, `confluence`), which the client
 * turns into the tool's display name; never a selector the model wrote.
 */
export type PersonAskProgressSourceV1 =
  | { readonly kind: 'meetings' | 'documents' | 'slack' }
  | { readonly kind: 'tickets' | 'pages'; readonly tool_id: string };

/**
 * A named item: exactly the projection an answer citation uses, so one
 * kind-to-opener mapping serves live rows, the receipt and the answer.
 */
export type PersonAskProgressItemV1 = PersonAnswerCitationV6;

/** Sent when the stage, or the reading count, changes. */
export interface PersonAskProgressStageEventV1 {
  readonly type: 'stage';
  readonly stage: PersonAskProgressStageV1;
  /**
   * Only with `reading`: items the research model is about to be given in
   * full for the first time. Their names follow in `read` events once the
   * access check before that call passes.
   */
  readonly pending?: number;
}

/** One research step's search and list reads (or the small-scope preload). */
export interface PersonAskProgressSearchedEventV1 {
  readonly type: 'searched';
  /** Distinct, in first-read order; a read with no source names every catalog source it covered. */
  readonly sources: readonly PersonAskProgressSourceV1[];
  /**
   * Distinct items these reads returned to this person that no earlier read
   * in the run returned, so consecutive rows add up exactly.
   */
  readonly found: number;
}

/**
 * Items whose complete released text the research model is given for the
 * first time in the call that follows: an opened item, a search hit shown in
 * full, or a starting item. Never a metadata-only row, a related reference
 * or a neighbour an open admitted. Sent at the gate's `before_call` point,
 * after the access check before that call, and each item at most once a run.
 */
export interface PersonAskProgressReadEventV1 {
  readonly type: 'read';
  readonly items: readonly PersonAskProgressItemV1[];
}

/**
 * Built by the Authority after the final access check passed, from its own
 * record of the run, never from what the client received.
 */
export interface PersonAskReceiptV1 {
  /** Distinct items whose full text research read; at least the items listed. */
  readonly looked_through: number;
  /** Authority time from the start of the run to release. */
  readonly elapsed_ms: number;
  /**
   * The run's searched and read rows in order, already merged: no two
   * neighbours share a type, sources are united, `found` is summed and items
   * are concatenated. Items appear once and may stop short of
   * `looked_through` when the named or byte bound was reached.
   */
  readonly rows: readonly PersonAskReceiptRowV1[];
}
export type PersonAskReceiptRowV1 = PersonAskProgressSearchedEventV1 | PersonAskProgressReadEventV1;

/** Terminal: the released V6 answer, exactly as today's JSON body, with its receipt. */
export interface PersonAskProgressAnswerEventV1 {
  readonly type: 'answer';
  readonly response: PersonAnswerResponseV6;
  readonly receipt: PersonAskReceiptV1;
}

/**
 * Terminal: an error after the stream started, with the status and body the
 * JSON response would have had. An error before the stream starts is the
 * ordinary JSON error response.
 */
export interface PersonAskProgressErrorEventV1 {
  readonly type: 'error';
  readonly status: PersonAskProgressErrorStatusV1;
  readonly error: OrganizationApiErrorV1['error'];
}
export type PersonAskProgressErrorStatusV1 = 400 | 401 | 404 | 409 | 429 | 500 | 502 | 503;

/** What the research run emits while it works; the kernel's progress sink receives these. */
export type PersonAskProgressStepEventV1 = PersonAskProgressStageEventV1 | PersonAskProgressSearchedEventV1 | PersonAskProgressReadEventV1;
export type PersonAskProgressTerminalEventV1 = PersonAskProgressAnswerEventV1 | PersonAskProgressErrorEventV1;
export type PersonAskProgressEventV1 = PersonAskProgressStepEventV1 | PersonAskProgressTerminalEventV1;

/**
 * `person ask --live --progress`: one line per step event before the final
 * line. Answer and error events are not printed as progress: the answer is
 * the final line, and an error is the command's ordinary failure.
 */
export interface PersonAskProgressLineV1 {
  readonly ok: true;
  readonly progress: PersonAskProgressStepEventV1;
}
/**
 * The final line keeps today's `{ok, result}` shape. `receipt` is present
 * only when the Authority streamed; an older Authority, or the `/v4`
 * fallback, prints exactly today's line.
 */
export interface PersonAskProgressResultLineV1 {
  readonly ok: true;
  readonly result: PersonAnswerResponseV6 | PersonAnswerResponseV5;
  readonly receipt?: PersonAskReceiptV1;
}

const STAGES: readonly string[] = ['searching', 'reading', 'checking_access', 'writing'];
const PLAIN_SOURCES: readonly string[] = ['meetings', 'documents', 'slack'];
const TOOL_SOURCES: readonly string[] = ['tickets', 'pages'];
const ERROR_STATUSES: readonly number[] = [400, 401, 404, 409, 429, 500, 502, 503];

function count(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > PERSON_ASK_PROGRESS_COUNT_MAX_V1) fail(`${label} is invalid`);
  return value as number;
}

function source(value: unknown): PersonAskProgressSourceV1 {
  const input = object(value, 'Ask progress source');
  if (PLAIN_SOURCES.includes(input.kind as string)) {
    assertExactKeys(input, ['kind'], 'Ask progress source');
    return Object.freeze({ kind: input.kind as 'meetings' | 'documents' | 'slack' });
  }
  if (!TOOL_SOURCES.includes(input.kind as string)) fail('Ask progress source kind is invalid');
  assertExactKeys(input, ['kind', 'tool_id'], 'Ask progress source');
  assertPatternString(input.tool_id, 'Ask progress source tool_id', 64, /^[a-z][a-z0-9-]*$/);
  return Object.freeze({ kind: input.kind as 'tickets' | 'pages', tool_id: input.tool_id });
}

function searched(input: Record<string, unknown>, label: string): PersonAskProgressSearchedEventV1 {
  assertExactKeys(input, ['type', 'sources', 'found'], label);
  if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > PERSON_ASK_PROGRESS_SOURCES_MAX_V1) fail(`${label} sources is invalid`);
  const sources = input.sources.map(source);
  if (new Set(sources.map(value => canonicalJson(value))).size !== sources.length) fail(`${label} sources contains duplicates`);
  return Object.freeze({ type: 'searched', sources: Object.freeze(sources), found: count(input.found, `${label} found`) });
}

/** Items of one read event or receipt row; `seen` spans a whole receipt so an item is named once. */
function read(input: Record<string, unknown>, label: string, maximum: number, seen: Set<string> = new Set()): PersonAskProgressReadEventV1 {
  assertExactKeys(input, ['type', 'items'], label);
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > maximum) fail(`${label} items is invalid`);
  const items = input.items.map(item => validatePersonAnswerCitationV6(item));
  for (const item of items) {
    const key = canonicalJson(item.citation);
    if (seen.has(key)) fail(`${label} names an item twice`);
    seen.add(key);
  }
  return Object.freeze({ type: 'read', items: Object.freeze(items) });
}

function stepEvent(input: Record<string, unknown>): PersonAskProgressStepEventV1 {
  if (input.type === 'stage') {
    assertExactKeys(input, ['type', 'stage', ...(Object.hasOwn(input, 'pending') ? ['pending'] : [])], 'Ask progress stage');
    if (!STAGES.includes(input.stage as string)) fail('Ask progress stage is invalid');
    if (Object.hasOwn(input, 'pending') && input.stage !== 'reading') fail('Ask progress pending applies only to reading');
    return Object.freeze({ type: 'stage', stage: input.stage as PersonAskProgressStageV1, ...(Object.hasOwn(input, 'pending') ? { pending: count(input.pending, 'Ask progress pending', 1) } : {}) });
  }
  if (input.type === 'searched') return searched(input, 'Ask progress searched');
  if (input.type === 'read') return read(input, 'Ask progress read', PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1);
  fail('Ask progress event type is invalid');
}

function bounded<T>(value: T, maximum: number, label: string): T {
  if (canonicalJsonBytes(value).byteLength > maximum) fail(`${label} exceeds its JSON byte bound`);
  return value;
}

/** A stage, searched or read event: what the run emits, and what a progress line carries. */
export function validatePersonAskProgressStepEventV1(value: unknown): PersonAskProgressStepEventV1 {
  return bounded(stepEvent(object(value, 'Ask progress event')), PERSON_ASK_PROGRESS_EVENT_MAX_BYTES_V1, 'Ask progress event');
}

export function validatePersonAskReceiptV1(value: unknown): PersonAskReceiptV1 {
  const input = object(value, 'Ask receipt');
  assertExactKeys(input, ['looked_through', 'elapsed_ms', 'rows'], 'Ask receipt');
  const lookedThrough = count(input.looked_through, 'Ask receipt looked_through');
  if (!Number.isSafeInteger(input.elapsed_ms) || (input.elapsed_ms as number) < 0 || (input.elapsed_ms as number) > PERSON_ASK_RECEIPT_ELAPSED_MAX_MS_V1) fail('Ask receipt elapsed_ms is invalid');
  if (!Array.isArray(input.rows) || input.rows.length > PERSON_ASK_RECEIPT_ROWS_MAX_V1) fail('Ask receipt rows is invalid');
  const seen = new Set<string>();
  const rows = input.rows.map((value: unknown): PersonAskReceiptRowV1 => {
    const row = object(value, 'Ask receipt row');
    if (row.type === 'searched') return searched(row, 'Ask receipt row');
    if (row.type === 'read') return read(row, 'Ask receipt row', PERSON_ASK_PROGRESS_NAMED_MAX_V1, seen);
    fail('Ask receipt row type is invalid');
  });
  for (let index = 1; index < rows.length; index += 1) if (rows[index]!.type === rows[index - 1]!.type) fail('Ask receipt rows are not merged');
  if (seen.size > PERSON_ASK_PROGRESS_NAMED_MAX_V1) fail('Ask receipt names too many items');
  if (lookedThrough < seen.size) fail('Ask receipt looked_through is less than the items it names');
  return bounded(Object.freeze({ looked_through: lookedThrough, elapsed_ms: input.elapsed_ms as number, rows: Object.freeze(rows) }), PERSON_ASK_RECEIPT_MAX_BYTES_V1, 'Ask receipt');
}

/** Any one stream event, terminal events included. */
export function validatePersonAskProgressEventV1(value: unknown): PersonAskProgressEventV1 {
  const input = object(value, 'Ask progress event');
  if (input.type === 'answer') {
    assertExactKeys(input, ['type', 'response', 'receipt'], 'Ask progress answer');
    return bounded(Object.freeze({ type: 'answer', response: validatePersonAnswerResponseV6(input.response), receipt: validatePersonAskReceiptV1(input.receipt) }), PERSON_ASK_PROGRESS_EVENT_MAX_BYTES_V1, 'Ask progress answer');
  }
  if (input.type === 'error') {
    assertExactKeys(input, ['type', 'status', 'error'], 'Ask progress error');
    if (!ERROR_STATUSES.includes(input.status as number)) fail('Ask progress error status is invalid');
    const { error } = validateOrganizationApiError({ error: input.error });
    return Object.freeze({ type: 'error', status: input.status as PersonAskProgressErrorStatusV1, error: Object.freeze(error) });
  }
  return bounded(stepEvent(input), PERSON_ASK_PROGRESS_EVENT_MAX_BYTES_V1, 'Ask progress event');
}

/** One event as its stream frame. `JSON.stringify` escapes newlines, so the frame is one data line. */
export function formatPersonAskProgressEventV1(event: PersonAskProgressEventV1): string {
  return `data: ${JSON.stringify(validatePersonAskProgressEventV1(event))}\n\n`;
}

export interface PersonAskProgressDecoderV1 {
  /** Feeds decoded stream text; returns the events it completed, in order. Throws on any malformed frame. */
  push(text: string): readonly PersonAskProgressEventV1[];
  /** The stream ended. Throws unless it ended just after its terminal event. */
  end(): void;
}

/**
 * Reads the stream exactly as framed above and fails closed: a line other
 * than a comment, one `data: ` line or a blank line, a second data line in
 * one event, an over-long line, an invalid event, or anything after the
 * terminal event throws.
 */
export function createPersonAskProgressDecoderV1(): PersonAskProgressDecoderV1 {
  let buffered = '';
  let data: string | undefined;
  let terminal = false;
  const line = (text: string, events: PersonAskProgressEventV1[]) => {
    if (text.includes('\r')) fail('Ask progress stream line is invalid');
    if (text === '') {
      if (data === undefined) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch (error) { fail('Ask progress event is not JSON', error); }
      data = undefined;
      const event = validatePersonAskProgressEventV1(parsed);
      events.push(event);
      if (event.type === 'answer' || event.type === 'error') terminal = true;
      return;
    }
    if (terminal) fail('Ask progress stream continued after its result');
    if (text.startsWith(':')) return;
    if (!text.startsWith('data: ') || data !== undefined) fail('Ask progress stream line is invalid');
    data = text.slice('data: '.length);
  };
  return Object.freeze({
    push(text: string) {
      const events: PersonAskProgressEventV1[] = [];
      buffered += text;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        line(buffered.slice(0, newline), events);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
      if (buffered.length > PERSON_ASK_PROGRESS_LINE_MAX_CHARS_V1) fail('Ask progress stream line exceeds its bound');
      return Object.freeze(events);
    },
    end() {
      if (buffered !== '' || data !== undefined || !terminal) fail('Ask progress stream ended without its result');
    },
  });
}

export function validatePersonAskProgressLineV1(value: unknown): PersonAskProgressLineV1 {
  const input = object(value, 'Ask progress line');
  assertExactKeys(input, ['ok', 'progress'], 'Ask progress line');
  if (input.ok !== true) fail('Ask progress line is invalid');
  return Object.freeze({ ok: true, progress: validatePersonAskProgressStepEventV1(input.progress) });
}

export function validatePersonAskProgressResultLineV1(value: unknown): PersonAskProgressResultLineV1 {
  const input = object(value, 'Ask result line');
  assertExactKeys(input, ['ok', 'result', ...(Object.hasOwn(input, 'receipt') ? ['receipt'] : [])], 'Ask result line');
  if (input.ok !== true) fail('Ask result line is invalid');
  const version = object(input.result, 'Ask result line result').schema_version;
  // A receipt comes only with a streamed answer, which is always V6.
  if (Object.hasOwn(input, 'receipt') && version !== 6) fail('Ask result line receipt needs a V6 answer');
  const result = version === 6 ? validatePersonAnswerResponseV6(input.result) : validatePersonAnswerResponseV5(input.result);
  return Object.freeze({ ok: true, result, ...(Object.hasOwn(input, 'receipt') ? { receipt: validatePersonAskReceiptV1(input.receipt) } : {}) });
}
