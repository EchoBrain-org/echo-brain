import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1, PERSON_ASK_PROGRESS_HEARTBEAT_V1 } from '@echo-brain/organization-api';
import { startPersonAskProgressStreamV1 } from '../src/presentation/person-ask-progress-stream-v1.js';

/** A response that records what the stream wrote. */
function response() {
  const writes: string[] = [];
  const headers: { status?: number; values?: Record<string, string> } = {};
  let flushed = false;
  const value = {
    destroyed: false, writableEnded: false,
    writeHead: vi.fn((status: number, values: Record<string, string>) => { headers.status = status; headers.values = values; return value; }),
    flushHeaders: vi.fn(() => { flushed = true; }),
    write: vi.fn((chunk: string) => { writes.push(chunk); return true; }),
    end: vi.fn((chunk?: string) => { if (chunk !== undefined) writes.push(chunk); value.writableEnded = true; return value; }),
  };
  return { value, response: value as unknown as ServerResponse, writes, headers, flushed: () => flushed };
}

afterEach(() => { vi.useRealTimers(); });

describe('Ask progress stream', () => {
  it('sends its headers at once and a heartbeat comment only after a quiet interval', () => {
    vi.useFakeTimers();
    const r = response();
    const stream = startPersonAskProgressStreamV1(r.response);
    expect(r.headers).toEqual({ status: 200, values: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
    expect(r.flushed()).toBe(true);
    vi.advanceTimersByTime(PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1 - 1);
    expect(r.writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(r.writes).toEqual([PERSON_ASK_PROGRESS_HEARTBEAT_V1]);
    // A write resets the interval.
    vi.advanceTimersByTime(PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1 - 1);
    stream.step({ type: 'stage', stage: 'searching' });
    vi.advanceTimersByTime(PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1 - 1);
    expect(r.writes).toEqual([PERSON_ASK_PROGRESS_HEARTBEAT_V1, 'data: {"type":"stage","stage":"searching"}\n\n']);
    vi.advanceTimersByTime(1);
    expect(r.writes.at(-1)).toBe(PERSON_ASK_PROGRESS_HEARTBEAT_V1);
  });

  it('writes exactly one terminal event last, clears the heartbeat first, and drops what the contract refuses', () => {
    vi.useFakeTimers();
    const r = response();
    const stream = startPersonAskProgressStreamV1(r.response);
    // Not a contract event: never written.
    stream.step({ type: 'stage', stage: 'thinking' } as never);
    stream.step({ type: 'searched', sources: [{ kind: 'meetings' }], found: 2, query: 'launch' } as never);
    stream.end({ type: 'error', status: 503, error: { code: 'unavailable', message: 'request failed' } });
    stream.step({ type: 'stage', stage: 'writing' });
    stream.end({ type: 'error', status: 500, error: { code: 'internal', message: 'request failed' } });
    vi.advanceTimersByTime(10 * PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1);
    expect(r.writes).toEqual(['data: {"type":"error","status":503,"error":{"code":"unavailable","message":"request failed"}}\n\n']);
    expect(r.value.end).toHaveBeenCalledTimes(1);
  });

  it('replaces a terminal event the contract refuses with an internal error, never a partial answer', () => {
    const r = response();
    startPersonAskProgressStreamV1(r.response).end({ type: 'answer', response: { schema_version: 8 } as never, receipt: { looked_through: 0, elapsed_ms: 0, rows: [] } });
    expect(r.writes).toEqual(['data: {"type":"error","status":500,"error":{"code":"internal","message":"request failed"}}\n\n']);
  });

  it('writes nothing once the client has gone, and closes without a terminal event', () => {
    vi.useFakeTimers();
    const r = response();
    const stream = startPersonAskProgressStreamV1(r.response);
    r.value.destroyed = true;
    stream.step({ type: 'stage', stage: 'searching' });
    vi.advanceTimersByTime(PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1);
    stream.close();
    stream.end({ type: 'error', status: 503, error: { code: 'unavailable', message: 'request failed' } });
    expect(r.writes).toEqual([]);
  });
});
