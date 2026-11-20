import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1, PERSON_ASK_PROGRESS_HEARTBEAT_V1, PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1, createPersonAskProgressDecoderV3,
  formatPersonAskProgressEventV3, type PersonAskProgressEventV3, type PersonAskProgressStepEventV3,
} from '@echo-brain/organization-api';
import { PERSON_ASK_PROGRESS_SHORTENED_V1, startPersonAskProgressStreamV1 } from '../src/presentation/person-ask-progress-stream-v1.js';

const followUp = { citation: { kind: 'follow_up', item_id: 'itm_launch-1' }, kind: 'follow_up', label: 'Ship the launch checklist', visibility: 'team', ref: 'follow_up:itm_launch-1' };
const ASK_ANSWER = { schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered', citations: [followUp],
  parts: [{ question: 'What is open?', status: 'answered', statements: [{ text: 'The launch checklist is open.', citation_indexes: [0], private: false }], blocks: [{ kind: 'answer', statements: [0] }] }] };

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

  it('stops sending progress before the stream would cross its byte bound, says so, and still sends the answer', () => {
    vi.useFakeTimers();
    const r = response();
    const stream = startPersonAskProgressStreamV1(r.response);
    // One read event of about 1 MB (labels at their 1 KiB bound), sent until it alone would cross the stream's bound.
    const items = Array.from({ length: 800 }, (_, at) => ({ citation: { kind: 'follow_up', item_id: `itm_bound-${at}` }, kind: 'follow_up', label: `${'L'.repeat(1000)} ${at}`,
      visibility: 'team', ref: `follow_up:itm_bound-${at}` }));
    const read = { type: 'read', items } as unknown as PersonAskProgressStepEventV3;
    const frame = Buffer.byteLength(formatPersonAskProgressEventV3(read));
    const sends = Math.ceil(PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1 / frame) + 2;
    for (let at = 0; at < sends; at += 1) {
      stream.step(read);
      vi.advanceTimersByTime(PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1);
    }
    // A small step after the cut is not sent either: progress stops, it does not skip. The heartbeat goes on.
    stream.step({ type: 'stage', stage: 'writing' });
    const before = r.writes.length;
    vi.advanceTimersByTime(PERSON_ASK_PROGRESS_HEARTBEAT_MS_V1);
    expect(r.writes.slice(before)).toEqual([PERSON_ASK_PROGRESS_HEARTBEAT_V1]);
    const answered = { type: 'answer', response: ASK_ANSWER, receipt: { looked_through: 1, elapsed_ms: 1, rows: [] } } as unknown as PersonAskProgressEventV3;
    stream.end(answered);
    // The events, which clients count against the stream bound (comments they drop unkept), stay within it.
    const bytes = r.writes.filter(write => !write.startsWith(':')).reduce((total, write) => total + Buffer.byteLength(write), 0);
    expect(bytes).toBeLessThanOrEqual(PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1);
    expect(r.writes.filter(write => write.startsWith('data: {"type":"read"')).length).toBeLessThan(sends);
    expect(r.writes.filter(write => write === PERSON_ASK_PROGRESS_SHORTENED_V1)).toHaveLength(1);
    expect(r.writes).not.toContain('data: {"type":"stage","stage":"writing"}\n\n');
    expect(r.writes.at(-1)).toBe(formatPersonAskProgressEventV3(answered));
    // The client's decoder reads the whole stream to its answer.
    const decoder = createPersonAskProgressDecoderV3();
    const events = decoder.push(r.writes.join(''));
    decoder.end();
    expect(events.at(-1)).toMatchObject({ type: 'answer' });
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
