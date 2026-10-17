import type { ServerResponse } from 'node:http';
import {
  PERSON_ASK_PROGRESS_CONTENT_TYPE_V1,
  PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1,
  PERSON_ASK_PROGRESS_HEARTBEAT_V1,
  formatPersonAskProgressEventV1,
  type PersonAskProgressStepEventV1,
  type PersonAskProgressTerminalEventV1,
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

/** Status and headers set before this call (the route header) are kept. */
export function startPersonAskProgressStreamV1(response: ServerResponse, options: { readonly heartbeat_ms?: number } = {}): PersonAskProgressStreamV1 {
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
    step(event: PersonAskProgressStepEventV1) {
      if (!open()) return;
      let frame: string;
      try { frame = formatPersonAskProgressEventV1(event); } catch { return; }
      response.write(frame);
      arm();
    },
    end(event: PersonAskProgressTerminalEventV1) {
      if (ended) return;
      // The heartbeat is cleared before the terminal event, so nothing can follow it.
      stop();
      if (response.destroyed || response.writableEnded) return;
      let frame: string;
      try { frame = formatPersonAskProgressEventV1(event); }
      catch { frame = formatPersonAskProgressEventV1({ type: 'error', status: 500, error: { code: 'internal', message: 'request failed' } }); }
      response.end(frame);
    },
    close() {
      stop();
      if (!response.writableEnded) response.end();
    },
  });
}
