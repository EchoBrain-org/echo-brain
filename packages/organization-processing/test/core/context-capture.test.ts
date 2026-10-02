import { describe, expect, it } from 'vitest';
import {
  assertContextCaptureEnvelopeV1,
  buildContextCaptureEnvelopeV1,
  type ContextCaptureContentV1,
  type SourceAdapterIdentityV1,
} from '../../src/core/index.js';

const identity = {
  kind: 'source', adapter_id: 'fixture-context', instance_id: 'workspace-1', version: '1',
} as const satisfies SourceAdapterIdentityV1;

function content(label = 'Design brief'): ContextCaptureContentV1 {
  return {
    schema_version: 1,
    kind: 'echo-context-capture-v1',
    source_type: 'document',
    truth_status: 'source_observation',
    label,
    provenance: { origin_ref: 'fixture://document/design-1', source_updated_at: '2026-10-01T00:00:00.000Z' },
    payload: { schema_version: 1, kind: 'document', media_type: 'text/markdown', language: 'en' },
    representation: {
      kind: 'full_snapshot',
      text: 'The design is ready for review.',
      passages: [{ id: 'body', source_anchor: 'body', start: 0, end: 31, text: 'The design is ready for review.' }],
    },
    observations: [],
  };
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

  it('rejects a malformed typed payload before a provider can emit an envelope', () => {
    expect(() => buildContextCaptureEnvelopeV1({
      identity, external_id: 'design-1', captured_at: '2026-10-01T00:00:01.000Z',
      content: { ...content(), payload: { schema_version: 1, kind: 'ticket', key: 'D-1', status: 'open', labels: [] } } as unknown as ContextCaptureContentV1,
    })).toThrow('kind does not match');
  });
});
