import { expect, it } from 'vitest';
import { MAX_PARAMS_BYTES, plainJsonBytes } from '../../src/shared/protocol.js';

it('refuses what a structured clone carries but JSON does not', () => {
  for (const value of [new Map([['a', 1]]), new Set([1]), new Date(0), new Uint8Array(8), new ArrayBuffer(8), { at: new Date(0) }, [1, 2n], { run: () => 1 }, { n: Number.NaN }]) {
    expect(plainJsonBytes(value, MAX_PARAMS_BYTES), String(value)).toBeNull();
  }
});

it('counts a nested plain object as the bytes of its JSON', () => {
  const value = { expect: { authority: 'https://authority.example', membership_id: 'mem_1' }, ids: ['a', 'b'], n: 12.5, ok: true, none: null };
  expect(plainJsonBytes(value, MAX_PARAMS_BYTES)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
  expect(plainJsonBytes([], MAX_PARAMS_BYTES)).toBe(2);
});

it('counts UTF-8 bytes, not UTF-16 units', () => {
  const text = '€'.repeat(30_000); // 30,000 units, 90,000 bytes
  expect(text.length).toBeLessThan(MAX_PARAMS_BYTES);
  expect(plainJsonBytes({ text }, MAX_PARAMS_BYTES)).toBeNull();
  expect(plainJsonBytes({ text: '€'.repeat(100) }, MAX_PARAMS_BYTES)).toBe(311);
});

it('stops at the limit', () => {
  expect(plainJsonBytes({ text: 'a'.repeat(10) }, 21)).toBe(21);
  expect(plainJsonBytes({ text: 'a'.repeat(11) }, 21)).toBeNull();
});

it('counts JSON escapes in text and keys before admitting a request', () => {
  for (const value of [{ text: '\n'.repeat(40_000) }, { text: '\u0000'.repeat(12_000) }, { ['"'.repeat(40_000)]: '' }]) {
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeGreaterThan(MAX_PARAMS_BYTES);
    expect(plainJsonBytes(value, MAX_PARAMS_BYTES)).toBeNull();
  }
  const value = { '\t"': 'line\n\\\u0000\ud800€' };
  expect(plainJsonBytes(value, MAX_PARAMS_BYTES)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
});

it('takes a __proto__ key JSON.parse made as plain data', () => {
  const value = JSON.parse('{"__proto__":{"admin":true},"name":"x"}') as object;
  expect(plainJsonBytes(value, MAX_PARAMS_BYTES)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
});

it('refuses a cycle and nesting no request needs, without overflowing the stack', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(plainJsonBytes(cycle, MAX_PARAMS_BYTES)).toBeNull();
  let deep: unknown[] = [];
  for (let level = 0; level < 100_000; level += 1) deep = [deep];
  expect(plainJsonBytes(deep, MAX_PARAMS_BYTES)).toBeNull();
});
