import { expect, it } from 'vitest';
import { MAX_ORGANIZATION_API_BODY_BYTES, PERSON_ANSWER_REQUEST_MAX_BYTES_V3, PERSON_ANSWER_RESPONSE_MAX_BYTES_V4, PERSON_ASK_CHECK_LIMITS_V1, PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1, PERSON_UPDATE_REQUEST_MAX_BYTES_V1 } from '@echo-brain/organization-api';
import { MAX_OUTPUT_BYTES } from '../../src/host/cli.js';
import { MAX_COPY_CHARACTERS, MAX_REQUEST_BYTES, MAX_TIMELINE_PUT_BYTES, paramsLimit, plainJsonBytes } from '../../src/shared/protocol.js';

it('holds every request to the Authority\'s one Person body bound, and never to less', () => {
  for (const bound of [MAX_ORGANIZATION_API_BODY_BYTES, PERSON_UPDATE_REQUEST_MAX_BYTES_V1, PERSON_ANSWER_REQUEST_MAX_BYTES_V3, PERSON_ASK_CHECK_LIMITS_V1.body_bytes]) expect(MAX_REQUEST_BYTES).toBe(bound);
  expect(paramsLimit('notes.submit')).toBe(MAX_REQUEST_BYTES);
  expect(paramsLimit('ask.run')).toBe(MAX_REQUEST_BYTES);
  expect(plainJsonBytes({ question: 'x'.repeat(512 * 1024) }, paramsLimit('ask.run'))).not.toBeNull();
  expect(plainJsonBytes({ text: 'x'.repeat(512 * 1024) }, paramsLimit('notes.submit'))).not.toBeNull();
});

it('sizes each bound a whole answer passes through above the one beneath it', () => {
  // One turn holds an answer and its sources' citations beside it; Copy answer takes what a turn holds.
  expect(MAX_TIMELINE_PUT_BYTES).toBeGreaterThanOrEqual(4 * PERSON_ANSWER_RESPONSE_MAX_BYTES_V4);
  expect(MAX_COPY_CHARACTERS).toBe(MAX_TIMELINE_PUT_BYTES);
  // The CLI prints every step and the answer: more than a whole Ask stream.
  expect(MAX_OUTPUT_BYTES).toBeGreaterThan(PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1);
  // A call that carries one whole answer (a timeline put, Copy answer) may take one; a removal names one turn, and takes
  // the ordinary bound.
  expect(paramsLimit('timeline.put')).toBe(MAX_TIMELINE_PUT_BYTES);
  expect(paramsLimit('clipboard.writeText')).toBe(MAX_TIMELINE_PUT_BYTES);
  expect(paramsLimit('timeline.remove')).toBe(MAX_REQUEST_BYTES);
});

it('refuses what a structured clone carries but JSON does not', () => {
  for (const value of [new Map([['a', 1]]), new Set([1]), new Date(0), new Uint8Array(8), new ArrayBuffer(8), { at: new Date(0) }, [1, 2n], { run: () => 1 }, { n: Number.NaN }]) {
    expect(plainJsonBytes(value, MAX_REQUEST_BYTES), String(value)).toBeNull();
  }
});

it('counts a nested plain object as the bytes of its JSON', () => {
  const value = { expect: { authority: 'https://authority.example', membership_id: 'mem_1' }, ids: ['a', 'b'], n: 12.5, ok: true, none: null };
  expect(plainJsonBytes(value, MAX_REQUEST_BYTES)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
  expect(plainJsonBytes([], MAX_REQUEST_BYTES)).toBe(2);
});

it('counts UTF-8 bytes, not UTF-16 units', () => {
  const text = '€'.repeat(400_000); // 400,000 units, 1,200,000 bytes
  expect(text.length).toBeLessThan(MAX_REQUEST_BYTES);
  expect(plainJsonBytes({ text }, MAX_REQUEST_BYTES)).toBeNull();
  expect(plainJsonBytes({ text: '€'.repeat(100) }, MAX_REQUEST_BYTES)).toBe(311);
});

it('stops at the limit', () => {
  expect(plainJsonBytes({ text: 'a'.repeat(10) }, 21)).toBe(21);
  expect(plainJsonBytes({ text: 'a'.repeat(11) }, 21)).toBeNull();
});

it('counts JSON escapes in text and keys before admitting a request', () => {
  for (const value of [{ text: '\n'.repeat(600_000) }, { text: '\u0000'.repeat(200_000) }, { ['"'.repeat(600_000)]: '' }]) {
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(plainJsonBytes(value, MAX_REQUEST_BYTES)).toBeNull();
  }
  const value = { '\t"': 'line\n\\\u0000\ud800€' };
  expect(plainJsonBytes(value, MAX_REQUEST_BYTES)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
});

it('takes a __proto__ key JSON.parse made as plain data', () => {
  const value = JSON.parse('{"__proto__":{"admin":true},"name":"x"}') as object;
  expect(plainJsonBytes(value, MAX_REQUEST_BYTES)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
});

it('refuses a cycle and nesting no request needs, without overflowing the stack', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(plainJsonBytes(cycle, MAX_REQUEST_BYTES)).toBeNull();
  let deep: unknown[] = [];
  for (let level = 0; level < 100_000; level += 1) deep = [deep];
  expect(plainJsonBytes(deep, MAX_REQUEST_BYTES)).toBeNull();
});
