import { describe, expect, it } from 'vitest';
import type {
  AdapterConfig,
  MeetingDocument,
} from '../../../src/processing/core/index.js';
import { StructuredTextDecisionProcessor } from '../../../src/processing/adapters/decision-processors/structured-text/structured-text-decision-processor.js';
import { adapterConformance } from '../../../../../tests/support/adapter-conformance.js';

const config: AdapterConfig = {
  adapter_id: 'structured-text',
  instance_id: 'local',
  settings: {},
};

const meeting: MeetingDocument = {
  schema_version: 1,
  id: 'meeting-structured-1',
  title: 'Explicitly structured notes',
  time: { actual_start_at: '2026-07-16T16:00:00.000Z' },
  capture: {
    state: 'complete',
    components: [
      { kind: 'notes', state: 'available' },
      { kind: 'transcript', state: 'available' },
    ],
  },
  participants: [],
  content: [
    {
      id: 'notes-1',
      kind: 'note',
      text: [
        'This prose is deliberately ignored.',
        'Decision: Ship the adapter-shaped core',
        'Action: Document the local vertical slice',
        'Rationale: It makes the boundary executable',
        'Comment: Decision: this is not a labeled decision line',
        'Decision:    ',
      ].join('\n'),
      started_at: '2026-07-16T16:05:00.000Z',
      ended_at: '2026-07-16T16:10:00.000Z',
    },
    {
      id: 'transcript-1',
      kind: 'transcript',
      text: 'decision: Labels are case-insensitive\nAn unlabeled action is ignored.',
    },
  ],
  artifacts: [],
  provenance: {
    source: {
      kind: 'meeting-source',
      adapter_id: 'fixture-source',
      instance_id: 'local',
      version: '1.0.0',
    },
    external_id: 'fixture-1',
    canonical_revision: 'revision-7',
    observed_at: '2026-07-16T17:01:00.000Z',
    normalizer_version: '1.0.0',
    source_updated_at: '2026-07-16T17:00:00.000Z',
  },
};

adapterConformance({
  name: 'structured-text decision processor',
  kind: 'decision-processor',
  create: () =>
    new StructuredTextDecisionProcessor(config, {
      now: () => '2026-07-16T17:02:00.000Z',
    }),
  validConfig: config,
  invalidConfig: {
    adapter_id: 'structured-text',
    instance_id: 'Invalid Instance',
    credential_ref: 'env:SECRET_MUST_NOT_APPEAR',
    settings: { unsupported: true },
  },
});

describe('structured-text decision processor', () => {
  it('extracts only explicitly labeled lines and retains block evidence', async () => {
    const processor = new StructuredTextDecisionProcessor(config, {
      now: () => '2026-07-16T17:02:00.000Z',
    });
    const result = await processor.extract(meeting, {
      processor_version: processor.identity.version,
      input_fingerprint: 'fixture-fingerprint',
    });

    expect(result.signals.map((signal) => [signal.kind, signal.text])).toEqual([
      ['decision', 'Ship the adapter-shaped core'],
      ['action', 'Document the local vertical slice'],
      ['rationale', 'It makes the boundary executable'],
      ['decision', 'Labels are case-insensitive'],
    ]);
    expect(result.signals[0]!.evidence).toEqual([
      {
        meeting_id: meeting.id,
        block_id: 'notes-1',
        quote: 'Decision: Ship the adapter-shaped core',
        started_at: '2026-07-16T16:05:00.000Z',
        ended_at: '2026-07-16T16:10:00.000Z',
      },
    ]);
  });

  it('keeps signal IDs stable across generated timestamps', async () => {
    const first = new StructuredTextDecisionProcessor(config, {
      now: () => '2026-07-16T17:02:00.000Z',
    });
    const second = new StructuredTextDecisionProcessor(config, {
      now: () => '2026-07-17T17:02:00.000Z',
    });
    const context = {
      processor_version: first.identity.version,
      input_fingerprint: 'fixture-fingerprint',
    };
    const firstResult = await first.extract(meeting, context);
    const secondResult = await second.extract(meeting, context);

    expect(secondResult.signals.map((signal) => signal.id)).toEqual(
      firstResult.signals.map((signal) => signal.id),
    );
    expect(secondResult.generated_at).not.toBe(firstResult.generated_at);
  });

  it('rejects a foreign processor version and honors cancellation', async () => {
    const processor = new StructuredTextDecisionProcessor(config);
    await expect(
      processor.extract(meeting, {
        processor_version: 'another-version',
        input_fingerprint: 'fixture-fingerprint',
      }),
    ).rejects.toMatchObject({ code: 'invalid_config', retryable: false });

    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    await expect(
      processor.extract(
        meeting,
        {
          processor_version: processor.identity.version,
          input_fingerprint: 'fixture-fingerprint',
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });
});
