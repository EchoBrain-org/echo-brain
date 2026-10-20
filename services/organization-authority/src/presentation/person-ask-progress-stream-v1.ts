import type { ServerResponse } from 'node:http';
import {
  PERSON_ASK_PROGRESS_CONTENT_TYPE_V1,
  PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1,
  PERSON_ASK_PROGRESS_HEARTBEAT_V1,
  type PersonAskProgressEventV2,
  type PersonAskProgressEventV3,
} from '@echo-brain/organization-api';

/**
 * One Ask progress response (ADR-0039): server-sent events, one `data:` line
 * per event, a comment heartbeat after a quiet interval, and exactly one
 * terminal event last. Headers go out at once, so a proxy sees the stream
 * start before research does. Nothing is written once the client has gone.
 */
export interface PersonAskProgressStreamV1<Event> {
  /** A step event; one the contract refuses is dropped, never written. */
  step(event: Event): void;
  /** The answer or an error, then the end of the response. Nothing follows it. */
  end(event: Event): void;
  /** Ends the response with no terminal event: the client disconnected, so nothing more is written. */
  close(): void;
}

/**
 * Starts one stream with V1's framing, heartbeat and terminal rules; `format` validates each event in its version:
 * Ask progress V2 for `/v6` (events may name follow-ups, ADR-0040), V3 for `/v7` (workspace items and tool containers,
 * research tool contract v1). `/v5` no longer streams: its progress V1 was retired on 2026-10-19. Status and headers set
 * before this call (the route header) are kept.
 */
export function startPersonAskProgressStreamV1<Event extends PersonAskProgressEventV2 | PersonAskProgressEventV3>(
  response: ServerResponse, format: (event: Event) => string, options: { readonly heartbeat_ms?: number } = {}): PersonAskProgressStreamV1<Event> {
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
