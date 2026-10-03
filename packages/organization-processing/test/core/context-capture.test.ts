import { describe, expect, it } from 'vitest';
import {
  assertContextCaptureEnvelopeV1,
  assertContextStructuredPayloadV1,
  buildContextCaptureEnvelopeV1,
  sourceContentSha256V1,
  type ContextCaptureContentV1,
  type ContextCaptureEnvelopeV1,
  type ContextPassageV1,
  type SourceAdapterIdentityV1,
} from '../../src/core/index.js';

const identity = {
  kind: 'source', adapter_id: 'fixture-context', instance_id: 'workspace-1', version: '1',
} as const satisfies SourceAdapterIdentityV1;

function content(label = 'Design brief'): ContextCaptureContentV1 {
  return {
    schema_version: 1,
    kind: 'echo-context-capture-v1',
    label,
    provenance: { origin_ref: 'fixture://note/design-1', source_updated_at: '2026-10-01T00:00:00.000Z' },
    payload: { schema_version: 1, kind: 'note', format: 'markdown' },
    representation: {
      kind: 'full_snapshot',
      text: 'The design is ready for review.',
      passages: [{ id: 'body', source_anchor: 'body', start: 0, end: 31, text: 'The design is ready for review.' }],
    },
  };
}

function envelope(changes: Partial<ContextCaptureContentV1> = {}): ContextCaptureEnvelopeV1 {
  return buildContextCaptureEnvelopeV1({
    identity, external_id: 'design-1', captured_at: '2026-10-01T00:00:01.000Z', content: { ...content(), ...changes },
  });
}

function excerpt(passages: readonly ContextPassageV1[]): ContextCaptureEnvelopeV1 {
  return envelope({ representation: { kind: 'excerpt', passages } });
}

function withContent(source: ContextCaptureEnvelopeV1, value: unknown): unknown {
  return { ...source, content: value, revision: { ...source.revision, content_sha256: sourceContentSha256V1(value) } };
}

describe('context capture contract', () => {
  it('replays the same immutable revision across poll and implementation-version changes, but changes it for capture state', () => {
    const first = buildContextCaptureEnvelopeV1({
      identity, external_id: 'design-1', captured_at: '2026-10-01T00:00:01.000Z', content: content(),
    });
    const replay = buildContextCaptureEnvelopeV1({
      identity, external_id: 'design-1', captured_at: '2026-10-01T00:01:01.000Z', content: content(),
    });
    const changed = buildContextCaptureEnvelopeV1({
      identity, external_id: 'design-1', captured_at: '2026-10-01T00:01:01.000Z', content: content('Revised design brief'),
    });
    const upgraded = buildContextCaptureEnvelopeV1({
      identity: { ...identity, version: '2' }, external_id: 'design-1', captured_at: '2026-10-01T00:01:01.000Z', content: content(),
    });

    expect(replay.revision.revision_id).toBe(first.revision.revision_id);
    expect(replay.revision.captured_at).not.toBe(first.revision.captured_at);
    expect(changed.revision.revision_id).not.toBe(first.revision.revision_id);
    expect(upgraded.revision.revision_id).toBe(first.revision.revision_id);
    assertContextCaptureEnvelopeV1(first, identity);
  });

  it('rejects an unsupported typed payload before a provider can emit an envelope', () => {
    expect(() => buildContextCaptureEnvelopeV1({
      identity, external_id: 'design-1', captured_at: '2026-10-01T00:00:01.000Z',
      content: { ...content(), payload: { schema_version: 1, kind: 'task', status: 'open' } } as unknown as ContextCaptureContentV1,
    })).toThrow('Context structured payload');
  });

  it('keeps document payload and original-artifact custody outside the V1 contract', () => {
    const base = envelope();
    const document = { schema_version: 2, kind: 'document', media_type: 'text/plain' };
    const original = { artifact_id: 'original', media_type: 'text/plain', sha256: 'a'.repeat(64), byte_length: 31 };
    expect(() => assertContextCaptureEnvelopeV1(withContent(base, { ...base.content, payload: document }), identity)).toThrow('Context structured payload');
    expect(() => assertContextCaptureEnvelopeV1({ ...base, revision: { ...base.revision, artifact_refs: [original] } }, identity)).toThrow('does not accept artifact');
  });

  it('rejects noncanonical identity, digest, provenance, anchors, bounds and closed fields', () => {
    const base = envelope();
    const forgedId = `source:${'a'.repeat(64)}`;
    const cases: readonly (readonly [unknown, string])[] = [
      [{ ...base, item: { ...base.item, source_id: forgedId }, revision: { ...base.revision, source_id: forgedId } }, 'identity is not canonical'],
      [{ ...base, item: { ...base.item, adapter: { ...identity, instance_id: 'forged-instance' } } }, 'does not match the configured adapter'],
      [{ ...base, revision: { ...base.revision, content_sha256: '0'.repeat(64) } }, 'does not match its revision digest'],
      [withContent(base, { ...base.content, provenance: { ...base.content.provenance, source_updated_at: '2026-10-01' } }), 'canonical UTC'],
      [withContent(base, { ...base.content, provenance: { ...base.content.provenance, source_updated_at: 'tomorrow' } }), 'canonical UTC'],
      [withContent(base, { ...base.content, provenance: { ...base.content.provenance, observed_at: '2026-10-01T00:00:00.000Z' } }), 'provenance has an unknown field'],
      [withContent(base, { ...base.content, representation: { kind: 'excerpt', passages: [{ id: 'bad', source_anchor: 'p:1', start: 0, end: 3, text: 'four' }] } }), 'unbounded or unanchored'],
      [withContent(base, { ...base.content, representation: { kind: 'excerpt', passages: [{ id: 'no-anchor', source_anchor: '', start: 0, end: 4, text: 'text' }] } }), 'source anchor must be bounded text'],
      [withContent(base, { ...base.content, representation: { kind: 'full_snapshot', text: 'x'.repeat(128 * 1024 + 1), passages: [{ id: 'body', source_anchor: 'body', start: 0, end: 1, text: 'x' }] } }), 'snapshot exceeds its bound'],
      [withContent(base, { ...base.content, label: 'x'.repeat(201) }), 'label must be bounded text'],
      [withContent(base, { ...base.content, extra: 'provider-cannot-widen-contract' }), 'capture has an unknown field'],
    ];
    for (const [value, message] of cases) expect(() => assertContextCaptureEnvelopeV1(value, identity), message).toThrow(message);
  });

  it('rejects provider truth, policy, approval or contributor claims', () => {
    const pointer = envelope({ representation: { kind: 'pointer', pointer: 'fixture://note/design-1' } });
    const cases: readonly (readonly [unknown, string])[] = [
      [withContent(pointer, { ...pointer.content, truth_status: 'approved_fact' }), 'unknown field'],
      [withContent(pointer, { ...pointer.content, policy: { disposition: 'retained', audience: 'everyone' } }), 'unknown field'],
      [withContent(pointer, { ...pointer.content, approval: { approved: true } }), 'unknown field'],
      [{ ...pointer, revision: { ...pointer.revision, contributor: { principal_id: 'prn_provider', membership_id: 'mem_provider' } } }, 'identity claims'],
    ];
    for (const [value, message] of cases) expect(() => assertContextCaptureEnvelopeV1(value, identity), message).toThrow(message);
  });

  it('rejects sparse, accessor and symbol-bearing adapter data without running provider getters', () => {
    const base = envelope();
    const sparse = { ...base, content: { ...base.content, representation: { ...base.content.representation, passages: new Array(1) } } };
    const accessor = envelope();
    let getterRan = false;
    Object.defineProperty(accessor.content, 'label', { enumerable: true, configurable: true, get: () => { getterRan = true; return 'getter must not run'; } });
    const symbol = envelope();
    Object.defineProperty(symbol.content, Symbol('provider-hidden-field'), { enumerable: true, value: 'hidden' });
    expect(() => assertContextCaptureEnvelopeV1(sparse, identity)).toThrow('arrays must be dense');
    expect(() => assertContextCaptureEnvelopeV1(accessor, identity)).toThrow('non-data fields');
    expect(getterRan).toBe(false);
    expect(() => assertContextCaptureEnvelopeV1(symbol, identity)).toThrow('symbol fields');
  });

  it('rejects conflicting excerpt overlaps at one anchor regardless of passage order', () => {
    const first = { id: 'first', source_anchor: 'paragraph:1', start: 10, end: 16, text: 'abcdef' };
    for (const conflict of [
      { id: 'identical-range', source_anchor: 'paragraph:1', start: 10, end: 16, text: 'abcXef' },
      { id: 'partial-range', source_anchor: 'paragraph:1', start: 14, end: 18, text: 'eXgh' },
      { id: 'contained-range', source_anchor: 'paragraph:1', start: 11, end: 14, text: 'bXd' },
    ]) {
      for (const passages of [[first, conflict], [conflict, first]]) {
        expect(() => excerpt(passages)).toThrow('Context excerpts conflict at the same source anchor');
      }
    }
  });

  it('preserves compatible excerpt overlaps, distinct anchors and separate ranges with JavaScript string offsets', () => {
    const passages = [
      { id: 'first', source_anchor: 'paragraph:1', start: 10, end: 17, text: 'a😀bcde' },
      { id: 'identical-range', source_anchor: 'paragraph:1', start: 10, end: 17, text: 'a😀bcde' },
      { id: 'contained-range', source_anchor: 'paragraph:1', start: 11, end: 14, text: '😀b' },
      { id: 'partial-range', source_anchor: 'paragraph:1', start: 15, end: 19, text: 'defg' },
      { id: 'adjacent-range', source_anchor: 'paragraph:1', start: 19, end: 21, text: 'hi' },
      { id: 'disjoint-range', source_anchor: 'paragraph:1', start: 25, end: 27, text: 'jk' },
      { id: 'other-anchor', source_anchor: 'paragraph:2', start: 10, end: 17, text: 'totally' },
    ];
    for (const ordered of [passages, [...passages].reverse()]) {
      expect(excerpt(ordered).content.representation).toEqual({ kind: 'excerpt', passages: ordered });
    }
  });

  it('rejects malformed structured provider payloads for their kind', () => {
    const ticket = { schema_version: 1, kind: 'ticket', key: 'CON-17', status: 'open', labels: ['fixture'] };
    const message = { schema_version: 1, kind: 'message', channel_ref: 'channel:CON', sent_at: '2026-10-01T11:50:00.000Z' };
    const meeting = { schema_version: 1, kind: 'meeting', started_at: '2026-10-01T10:00:00.000Z', ended_at: '2026-10-01T11:00:00.000Z', participant_refs: ['provider-user:ada'] };
    for (const value of [ticket, message, meeting]) expect(() => assertContextStructuredPayloadV1(value)).not.toThrow();
    const cases: readonly (readonly [unknown, string])[] = [
      [{ ...message, key: 'CON-17' }, 'unknown field'],
      [{ ...ticket, permission: 'provider-admin' }, 'unknown field'],
      [{ ...message, sent_at: 'not-a-utc-time' }, 'canonical UTC'],
      [{ ...meeting, ended_at: '2026-10-01T09:00:00.000Z' }, 'ends before it starts'],
      [{ ...meeting, participant_refs: ['provider-user:dup', 'provider-user:dup'] }, 'must be unique'],
      [{ ...meeting, participant_refs: [''] }, 'must be bounded text'],
      [{ ...ticket, labels: new Array(32).fill('x'.repeat(600)) }, 'exceeds its bound'],
    ];
    for (const [value, error] of cases) expect(() => assertContextStructuredPayloadV1(value), error).toThrow(error);
  });
});
