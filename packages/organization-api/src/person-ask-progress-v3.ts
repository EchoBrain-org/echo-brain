import type { OrganizationApiErrorV1 } from './contracts.js';
import type { PersonAnswerCitationV8, PersonAnswerResponseV8 } from './person-answer-v8.js';
import { validatePersonAnswerCitationV8, validatePersonAnswerResponseV8 } from './person-answer-v4.js';
import { askProgressCodec } from './person-ask-progress-codec.js';
import { asEnumerableRecord as object, assertExactKeys, fail } from './validation.js';

/**
 * Ask progress V3 (ADR-0039, ADR-0042): while an Ask runs, `POST /v7/person/ask`
 * streams what ECHO is doing as server-sent events, then the released V8
 * answer with a receipt. A client opts in with one request header; without
 * it, the route answers with its JSON. V1 (the V6 answer on `/v5`) and V2
 * (the V7 answer on `/v6`) were retired with those routes. V3 keeps their
 * header, framing, heartbeat, stages, bounds and terminal error unchanged,
 * which is why those keep their V1 names.
 *
 * Framing: each event is exactly one `data: <JSON>` line followed by a blank
 * line, with no `event`, `id` or `retry` fields. A comment heartbeat keeps
 * proxies from timing out an idle stream. The last event is the one terminal
 * event (`answer` or `error`); nothing follows it.
 *
 * Before the answer, events carry only the stage, the source kinds a step
 * searched with a count of what those reads released to this person and gave
 * research, how many items are about to be read, and the citation projection
 * of items whose full text the research model is about to be given, sent only
 * after the access check before that model call. Never notes, needs, plans,
 * model-written or provider queries, bodies, excerpts, scratchpad ids, rounds
 * or hidden counts. A searched row may name ECHO's shared follow-ups, the
 * workspace or a connected tool's containers, up to 16 sources; a named item
 * is a V8 citation. The receipt's `looked_through` counts every item research
 * was shown, rows included (ADR-0043).
 */

/** The opt-in request header. */
export const PERSON_ASK_PROGRESS_HEADER_V1 = 'x-echo-ask-progress';
/** The header's value that asks `/v7/person/ask` for this stream. */
export const PERSON_ASK_PROGRESS_HEADER_VALUE_V3 = '3';
/** The streamed response's media type; a JSON response means the Authority did not stream. */
export const PERSON_ASK_PROGRESS_CONTENT_TYPE_V1 = 'text/event-stream';
/** How often the Authority writes the heartbeat comment while nothing else is sent. */
export const PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1 = 10_000;
export const PERSON_ASK_PROGRESS_HEARTBEAT_V1 = ': keep-alive\n\n';
/** Items named in one run; reads beyond it still count in `looked_through` but are not named. */
export const PERSON_ASK_PROGRESS_NAMED_MAX_V1 = 100;
/** Items in one `read` event; a larger batch is sent as consecutive `read` events. */
export const PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1 = 25;
/** Distinct sources one searched row names. */
export const PERSON_ASK_PROGRESS_SOURCES_MAX_V3 = 16;
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
 * A source kind a step read, from the request's server-selected catalog: ECHO's
 * meetings, documents, shared follow-ups and workspace (your projects, the
 * people in your organization and your tools), or a connected tool's tickets,
 * pages or containers, by its tool id (`jira`, `confluence`), which the client
 * turns into the tool's display name; never a selector the model wrote.
 */
export type PersonAskProgressSourceV3 =
  | { readonly kind: 'meetings' | 'documents' | 'follow_ups' | 'projects' | 'people' | 'tools' }
  | { readonly kind: 'tickets' | 'pages' | 'containers'; readonly tool_id: string };

/**
 * A named item: exactly the projection a V8 answer citation uses, so one
 * kind-to-opener mapping serves live rows, the receipt and the answer.
 */
export type PersonAskProgressItemV3 = PersonAnswerCitationV8;

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

/** One research step's search and list reads. */
export interface PersonAskProgressSearchedEventV3 {
  readonly type: 'searched';
  /** Distinct, in first-read order; a read with no source names every catalog source it covered. */
  readonly sources: readonly PersonAskProgressSourceV3[];
  /**
   * Distinct items these reads gave research that no earlier read in the run
   * gave it, so consecutive rows add up exactly: a search's hits and a list's
   * page, never the rows a list fetched behind its page (ADR-0043).
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
export interface PersonAskProgressReadEventV3 {
  readonly type: 'read';
  readonly items: readonly PersonAskProgressItemV3[];
}

/**
 * Built by the Authority after the final access check passed, from its own
 * record of the run, never from what the client received.
 */
export interface PersonAskReceiptV3 {
  /**
   * Distinct items research was shown after an access check, as a row or in
   * full (ADR-0043); at least the items listed. It never counts a neighbour
   * an open brought along, or an item released beside a row.
   */
  readonly looked_through: number;
  /** Authority time from the start of the request to release, across any restarted attempt. */
  readonly elapsed_ms: number;
  /**
   * The run's searched and read rows in order, already merged: no two
   * neighbours share a type, sources are united, `found` is summed and items
   * are concatenated. Items appear once and may stop short of
   * `looked_through` when the named or byte bound was reached.
   */
  readonly rows: readonly PersonAskReceiptRowV3[];
}
export type PersonAskReceiptRowV3 = PersonAskProgressSearchedEventV3 | PersonAskProgressReadEventV3;

/** Terminal: the released V8 answer, exactly as the `/v7` JSON body, with its receipt. */
export interface PersonAskProgressAnswerEventV3 {
  readonly type: 'answer';
  readonly response: PersonAnswerResponseV8;
  readonly receipt: PersonAskReceiptV3;
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
export type PersonAskProgressStepEventV3 = PersonAskProgressStageEventV1 | PersonAskProgressSearchedEventV3 | PersonAskProgressReadEventV3;
export type PersonAskProgressTerminalEventV3 = PersonAskProgressAnswerEventV3 | PersonAskProgressErrorEventV1;
export type PersonAskProgressEventV3 = PersonAskProgressStepEventV3 | PersonAskProgressTerminalEventV3;

/** `person ask --progress`: one line per step event. */
export interface PersonAskProgressLineV3 {
  readonly ok: true;
  readonly progress: PersonAskProgressStepEventV3;
}
/** The final line: the answer, with its receipt when the Authority streamed. */
export interface PersonAskProgressResultLineV3 {
  readonly ok: true;
  readonly result: PersonAnswerResponseV8;
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

/** A stage, searched or read event: what the run emits, and what a progress line carries. */
export function validatePersonAskProgressStepEventV3(value: unknown): PersonAskProgressStepEventV3 { return V3.step(value) as PersonAskProgressStepEventV3; }
export function validatePersonAskReceiptV3(value: unknown): PersonAskReceiptV3 { return V3.receipt(value) as PersonAskReceiptV3; }
/** One event as its stream frame. `JSON.stringify` escapes newlines, so the frame is one data line. */
export function formatPersonAskProgressEventV3(event: PersonAskProgressEventV3): string { return V3.format(event); }
export interface PersonAskProgressDecoderV3 {
  /** Feeds decoded stream text; returns the events it completed, in order. Throws on any malformed frame. */
  push(text: string): readonly PersonAskProgressEventV3[];
  /** The stream ended. Throws unless it ended just after its terminal event. */
  end(): void;
}
/**
 * Reads the stream exactly as framed above and fails closed: a line other
 * than a comment, one `data: ` line or a blank line, a second data line in
 * one event, an over-long line, an invalid event, or anything after the
 * terminal event throws.
 */
export function createPersonAskProgressDecoderV3(): PersonAskProgressDecoderV3 { return V3.decoder() as PersonAskProgressDecoderV3; }
export function validatePersonAskProgressLineV3(value: unknown): PersonAskProgressLineV3 { return V3.line(value) as PersonAskProgressLineV3; }

export function validatePersonAskProgressResultLineV3(value: unknown): PersonAskProgressResultLineV3 {
  const input = object(value, 'Ask result line');
  assertExactKeys(input, ['ok', 'result', ...(Object.hasOwn(input, 'receipt') ? ['receipt'] : [])], 'Ask result line');
  if (input.ok !== true) fail('Ask result line is invalid');
  const result = validatePersonAnswerResponseV8(input.result);
  return Object.freeze({ ok: true, result, ...(Object.hasOwn(input, 'receipt') ? { receipt: validatePersonAskReceiptV3(input.receipt) } : {}) });
}
