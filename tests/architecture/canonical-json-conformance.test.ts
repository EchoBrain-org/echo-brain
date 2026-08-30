import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError as ProtocolCanonicalJsonError,
  canonicalJson as protocolCanonicalJson,
  canonicalSha256 as protocolCanonicalSha256,
} from '@echo-brain/federation-protocol';
import {
  CanonicalJsonError as ControlPlaneCanonicalJsonError,
  canonicalJson as controlPlaneCanonicalJson,
  canonicalSha256 as controlPlaneCanonicalSha256,
} from '../../packages/organization-control-plane/src/canonical/canonical-json.js';

/**
 * The control plane deliberately keeps its own canonicalizer: its boundary
 * declares no workspace packages, so it may not import
 * `@echo-brain/federation-protocol`. That independence is the point, but two
 * copies of one digest rule silently diverging is a persisted-digest hazard.
 *
 * This is the cross-check the control-plane copy's own comment says nobody
 * runs: the same vectors and the same rejection cases through both
 * implementations, asserting byte-identical output and matched refusals.
 * Neither boundary is weakened -- only this test imports both; the two
 * sources still import nothing from each other.
 *
 * Adding a case is one row in ACCEPTED or REJECTED.
 */

const CYCLIC: Record<string, unknown> = {};
CYCLIC['self'] = CYCLIC;

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = { n: value };
  return value;
}

class NotAPlainObject {
  constructor(readonly method: string) {}
}

const ACCEPTED: readonly (readonly [string, unknown])[] = [
  ['null', null],
  ['booleans', { no: false, yes: true }],
  ['numbers including negative zero', { a: 0, b: -0, c: -1, d: 1e21, e: 1.5 }],
  ['an empty object', {}],
  ['an empty array', []],
  [
    'mixed-case keys ordered by UTF-16 code unit',
    { A_id: 1, a_id: 2, T0BFX: 3, t0bfx: 4, User: 5, user: 6 },
  ],
  [
    'keys whose code-unit order differs from locale order',
    { z: 1, Z: 2, 'ä': 3, '10': 5, '9': 6, '': 7 },
  ],
  [
    'escapes, astral planes, and paired surrogates',
    {
      ascii: 'plain',
      control: '\u0000\u001f',
      quote: '"\\/',
      astral: '\u{1f600}',
      bmp: 'é中',
    },
  ],
  ['nesting at exactly the depth limit', nested(128)],
  [
    'a persisted-shape record',
    {
      approve_reaction: 'white_check_mark',
      channel_id: 'C123CHANNEL',
      reject_reaction: 'x',
      slack_app_id: 'A123APP',
      slack_bot_id: 'B123BOT',
      slack_bot_user_id: 'U123BOT',
      slack_enterprise_id: null,
    },
  ],
  ['arrays of objects', [{ b: 1, a: [1, 2, { d: null, c: true }] }, []]],
];

const REJECTED: readonly (readonly [string, unknown])[] = [
  ['NaN', { n: Number.NaN }],
  ['Infinity', { n: Number.POSITIVE_INFINITY }],
  ['-Infinity', { n: Number.NEGATIVE_INFINITY }],
  ['undefined', { a: undefined }],
  ['a bigint', { a: 1n }],
  ['a function', { a: () => 1 }],
  ['a symbol', { a: Symbol('a') }],
  ['an unpaired high surrogate in a value', { a: 'x\ud800y' }],
  ['an unpaired low surrogate in a value', { a: 'x\udc00y' }],
  ['an unpaired surrogate in a key', { '\ud800': 1 }],
  ['a cycle', CYCLIC],
  ['nesting one past the depth limit', nested(129)],
  ['a class instance', new NotAPlainObject('slack_auth_test')],
  ['a sparse array slot', Object.assign([1], { length: 3 })],
];

describe('canonical JSON conformance across independent implementations', () => {
  it.each(ACCEPTED)('agrees byte for byte on %s', (_label, value) => {
    const protocol = protocolCanonicalJson(value);
    expect(controlPlaneCanonicalJson(value)).toBe(protocol);
    expect(controlPlaneCanonicalSha256(value)).toBe(
      protocolCanonicalSha256(value),
    );
  });

  it.each(REJECTED)('both refuse %s the same way', (_label, value) => {
    let protocolFailure: unknown;
    let controlPlaneFailure: unknown;
    try {
      protocolCanonicalJson(value);
    } catch (error) {
      protocolFailure = error;
    }
    try {
      controlPlaneCanonicalJson(value);
    } catch (error) {
      controlPlaneFailure = error;
    }
    expect(protocolFailure).toBeInstanceOf(ProtocolCanonicalJsonError);
    expect(controlPlaneFailure).toBeInstanceOf(ControlPlaneCanonicalJsonError);
    expect((controlPlaneFailure as Error).message).toBe(
      (protocolFailure as Error).message,
    );
  });

  it('keeps the control-plane copy independent of the protocol package', () => {
    // Conformance must never be "fixed" by making the control plane import the
    // shared implementation; its boundary forbids that edge on purpose.
    const boundary = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../packages/organization-control-plane/source-boundary.v1.json',
        ),
        'utf8',
      ),
    ) as { allowed_workspace_packages: readonly string[] };
    expect(boundary.allowed_workspace_packages).toEqual([]);
  });
});
