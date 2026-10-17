import type { ServerResponse } from 'node:http';
import {
  PERSON_ASK_PROGRESS_CONTENT_TYPE_V1,
  PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1,
  PERSON_ASK_PROGRESS_HEARTBEAT_V1,
  formatPersonAskProgressEventV1,
  formatPersonAskProgressEventV2,
  type PersonAskProgressEventV1,
  type PersonAskProgressEventV2,
  type PersonAskProgressStepEventV1,
  type PersonAskProgressStepEventV2,
  type PersonAskProgressTerminalEventV1,
  type PersonAskProgressTerminalEventV2,
} from '@echo-brain/organization-api';

/**
 * One Ask progress response (ADR-0039): server-sent events, one `data:` line
 * per event, a comment heartbeat after a quiet interval, and exactly one
 * terminal event last. Headers go out at once, so a proxy sees the stream
 * start before research does. Nothing is written once the client has gone.
 */
export interface PersonAskProgressStreamV1 {
  /** A step event; one the contract refuses is dropped, never written. */
  step(event: PersonAskProgressStepEventV1): void;
  /** The answer or an error, then the end of the response. Nothing follows it. */
  end(event: PersonAskProgressTerminalEventV1): void;
  /** Ends the response with no terminal event: the client disconnected, so nothing more is written. */
  close(): void;
}

/** The `/v6` stream (Ask progress V2, ADR-0040): the same response, whose events may name follow-ups. */
export interface PersonAskProgressStreamV2 {
  step(event: PersonAskProgressStepEventV2): void;
  end(event: PersonAskProgressTerminalEventV2): void;
  close(): void;
}

/** Status and headers set before this call (the route header) are kept. */
export function startPersonAskProgressStreamV1(response: ServerResponse, options: { readonly heartbeat_ms?: number } = {}): PersonAskProgressStreamV1 {
  return start<PersonAskProgressEventV1>(response, formatPersonAskProgressEventV1, options);
}

/** `/v6`'s stream: V1's framing, heartbeat and terminal rules, with each event validated as V2. */
export function startPersonAskProgressStreamV2(response: ServerResponse, options: { readonly heartbeat_ms?: number } = {}): PersonAskProgressStreamV2 {
  return start<PersonAskProgressEventV2>(response, formatPersonAskProgressEventV2, options);
}

function start<Event extends PersonAskProgressEventV1 | PersonAskProgressEventV2>(response: ServerResponse, format: (event: Event) => string,
  options: { readonly heartbeat_ms?: number }): { step(event: Event): void; end(event: Event): void; close(): void } {
  const heartbeatMs = options.heartbeat_ms ?? PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1;
  response.writeHead(200, { 'content-type': `${PERSON_ASK_PROGRESS_CONTENT_TYPE_V1}; charset=utf-8`, 'cache-control': 'no-store' });
  response.flushHeaders();
  let ended = false;
  let timer: NodeJS.Timeout | undefined;
  const open = () => !ended && !response.destroyed && !response.writableEnded;
  const stop = () => { ended = true; if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  // A heartbeat follows the last write by the interval, so an idle stream keeps one every interval.
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { if (!open()) return; response.write(PERSON_ASK_PROGRESS_HEARTBEAT_V1); arm(); }, heartbeatMs);
    timer.unref?.();
  };
  arm();
  return Object.freeze({
    step(event: Event) {
      if (!open()) return;
      let frame: string;
      try { frame = format(event); } catch { return; }
      response.write(frame);
      arm();
    },
    end(event: Event) {
      if (ended) return;
      // The heartbeat is cleared before the terminal event, so nothing can follow it.
      stop();
      if (response.destroyed || response.writableEnded) return;
      let frame: string;
      try { frame = format(event); }
      catch { frame = format({ type: 'error', status: 500, error: { code: 'internal', message: 'request failed' } } as Event); }
      response.end(frame);
    },
    close() {
      stop();
      if (!response.writableEnded) response.end();
    },
  });
}
