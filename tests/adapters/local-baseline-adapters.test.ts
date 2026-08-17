import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AdapterConfig,
  type DecisionBrief,
  type DeliveryEnvelope,
  type MeetingDocument,
} from '@echo-brain/organization-authority/processing/core/index.js';
import { StructuredTextDecisionProcessor } from '../../src/adapters/decision-processors/structured-text/index.js';
import {
  JsonlOutboxDeliverySurface,
  type JsonlOutboxRecord,
} from '../../src/adapters/delivery-surfaces/jsonl-outbox/index.js';
import { adapterConformance } from '../support/adapter-conformance.js';

const processorConfig: AdapterConfig = {
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
    new StructuredTextDecisionProcessor(processorConfig, {
      now: () => '2026-07-16T17:02:00.000Z',
    }),
  validConfig: processorConfig,
  invalidConfig: {
    adapter_id: 'structured-text',
    instance_id: 'Invalid Instance',
    credential_ref: 'env:SECRET_MUST_NOT_APPEAR',
    settings: { unsupported: true },
  },
});

describe('structured-text decision processor', () => {
  it('extracts only explicitly labeled lines and retains block-level evidence', async () => {
    const processor = new StructuredTextDecisionProcessor(processorConfig, {
      now: () => '2026-07-16T17:02:00.000Z',
    });
    const result = await processor.extract(meeting, {
      processor_version: processor.identity.version,
      input_fingerprint: 'fixture-fingerprint',
    });

    expect(result).toMatchObject({
      schema_version: 1,
      meeting_id: meeting.id,
      meeting_revision: 'revision-7',
      processor: processor.identity,
      generated_at: '2026-07-16T17:02:00.000Z',
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
    expect(result.signals[0]).toMatchObject({
      kind: 'decision',
      subject: null,
      confidence: null,
      status: 'decided',
    });
    expect(result.signals[1]).toMatchObject({
      kind: 'action',
      owner: null,
      due_at: null,
    });
    expect(result.signals[2]).toMatchObject({
      kind: 'rationale',
      supports_signal_ids: [],
    });
  });

  it('produces stable signal IDs without pretending generated timestamps are stable', async () => {
    const first = new StructuredTextDecisionProcessor(processorConfig, {
      now: () => '2026-07-16T17:02:00.000Z',
    });
    const second = new StructuredTextDecisionProcessor(processorConfig, {
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
    expect(
      firstResult.signals.every((signal) =>
        /:sha256:[a-f0-9]{64}$/.test(signal.id),
      ),
    ).toBe(true);
  });

  it('rejects extraction contexts for another processor version', async () => {
    const processor = new StructuredTextDecisionProcessor(processorConfig);
    await expect(
      processor.extract(meeting, {
        processor_version: 'another-version',
        input_fingerprint: 'fixture-fingerprint',
      }),
    ).rejects.toMatchObject({ code: 'invalid_config', retryable: false });
  });

  it('honors a cancelled extraction context', async () => {
    const processor = new StructuredTextDecisionProcessor(processorConfig);
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

const temporaryDirectories: string[] = [];

async function temporaryOutbox(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'echo-brain-jsonl-outbox-'));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, 'approved-deliveries.jsonl') };
}

function outboxConfig(path: string): AdapterConfig {
  return {
    adapter_id: 'jsonl-outbox',
    instance_id: 'local',
    settings: { path, destination_id: 'local-approved-decisions' },
  };
}

function decisionBrief(id: string): DecisionBrief {
  return {
    schema_version: 1,
    id,
    meeting: {
      id: meeting.id,
      title: meeting.title,
      time: meeting.time,
      participants: [],
    },
    decisions: [],
    actions: [],
    rationales: [],
    provenance: {
      meeting_revision: meeting.provenance.canonical_revision,
      processor: {
        kind: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'local',
        version: '1.0.0',
      },
      generated_at: '2026-07-16T17:02:00.000Z',
    },
  };
}

function envelopeFor(
  surface: JsonlOutboxDeliverySurface,
  id: string,
  idempotencyKey = 'delivery:fixture:jsonl-outbox:local',
): DeliveryEnvelope {
  return {
    schema_version: 1,
    id,
    idempotency_key: idempotencyKey,
    destination: surface.destination,
    brief: decisionBrief(`brief-${id}`),
    approved_at: '2026-07-16T17:03:00.000Z',
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

adapterConformance({
  name: 'JSONL outbox delivery surface',
  kind: 'delivery-surface',
  create: () =>
    new JsonlOutboxDeliverySurface(
      outboxConfig(
        join(tmpdir(), `echo-brain-outbox-conformance-${process.pid}.jsonl`),
      ),
      {
        now: () => '2026-07-16T17:02:00.000Z',
      },
    ),
  validConfig: outboxConfig(
    join(tmpdir(), `echo-brain-outbox-conformance-${process.pid}.jsonl`),
  ),
  invalidConfig: {
    adapter_id: 'jsonl-outbox',
    instance_id: 'Invalid Instance',
    credential_ref: 'env:SECRET_MUST_NOT_APPEAR',
    settings: { path: 'relative/outbox.jsonl', unsupported: true },
  },
});

describe('JSONL outbox delivery surface', () => {
  it('honors cancellation before touching the outbox', async () => {
    const outbox = await temporaryOutbox();
    const surface = new JsonlOutboxDeliverySurface(outboxConfig(outbox.path));
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));

    await expect(
      surface.publish(envelopeFor(surface, 'cancelled'), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
    await expect(stat(outbox.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('durably appends an approved envelope with a stable receipt and private permissions', async () => {
    const outbox = await temporaryOutbox();
    const surface = new JsonlOutboxDeliverySurface(outboxConfig(outbox.path), {
      now: () => '2026-07-16T17:04:00.000Z',
    });
    const envelope = envelopeFor(surface, 'envelope-1');
    const receipt = await surface.publish(envelope);
    const record = JSON.parse(
      (await readFile(outbox.path, 'utf8')).trim(),
    ) as JsonlOutboxRecord;

    expect(receipt).toEqual({
      schema_version: 1,
      envelope_id: 'envelope-1',
      status: 'delivered',
      external_id: expect.stringMatching(/^jsonl-outbox:sha256:[a-f0-9]{64}$/),
      recorded_at: '2026-07-16T17:04:00.000Z',
      retryable: false,
    });
    expect(record).toMatchObject({
      schema_version: 1,
      record_type: 'echo-brain.delivery',
      idempotency_key: envelope.idempotency_key,
      external_id: receipt.external_id,
      recorded_at: receipt.recorded_at,
      envelope,
    });
    expect((await stat(outbox.path)).mode & 0o777).toBe(0o600);
    await expect(stat(`${outbox.path}.lock`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('deduplicates the idempotency key across concurrent adapter instances and restarts', async () => {
    const outbox = await temporaryOutbox();
    const config = outboxConfig(outbox.path);
    const first = new JsonlOutboxDeliverySurface(config, {
      now: () => '2026-07-16T17:04:00.000Z',
    });
    const second = new JsonlOutboxDeliverySurface(config, {
      now: () => '2026-07-16T18:04:00.000Z',
    });
    const [firstReceipt, secondReceipt] = await Promise.all([
      first.publish(envelopeFor(first, 'attempt-1')),
      second.publish(envelopeFor(second, 'attempt-2')),
    ]);
    const restarted = new JsonlOutboxDeliverySurface(config, {
      now: () => '2026-07-17T18:04:00.000Z',
    });
    const restartReceipt = await restarted.publish(
      envelopeFor(restarted, 'attempt-3'),
    );

    expect(secondReceipt).toMatchObject({
      envelope_id: 'attempt-2',
      external_id: firstReceipt.external_id,
      recorded_at: firstReceipt.recorded_at,
    });
    expect(restartReceipt).toMatchObject({
      envelope_id: 'attempt-3',
      external_id: firstReceipt.external_id,
      recorded_at: firstReceipt.recorded_at,
    });
    expect(
      (await readFile(outbox.path, 'utf8')).trim().split('\n'),
    ).toHaveLength(1);
  });

  it('fails closed for symbolic links and malformed existing outboxes', async () => {
    const outbox = await temporaryOutbox();
    const target = join(outbox.directory, 'target.jsonl');
    const link = join(outbox.directory, 'link.jsonl');
    await writeFile(target, '', { mode: 0o600 });
    await symlink(target, link);
    const linked = new JsonlOutboxDeliverySurface(outboxConfig(link));
    expect(await linked.healthCheck()).toMatchObject({ status: 'unavailable' });
    await expect(
      linked.publish(envelopeFor(linked, 'linked')),
    ).rejects.toMatchObject({
      code: 'permanently_rejected',
      retryable: false,
    });

    await writeFile(outbox.path, 'not-json\n', { mode: 0o600 });
    const malformed = new JsonlOutboxDeliverySurface(outboxConfig(outbox.path));
    await expect(
      malformed.publish(envelopeFor(malformed, 'malformed')),
    ).rejects.toMatchObject({
      code: 'permanently_rejected',
      retryable: false,
    });
  });

  it('repairs only an incomplete final line left by an interrupted append', async () => {
    const outbox = await temporaryOutbox();
    const config = outboxConfig(outbox.path);
    const surface = new JsonlOutboxDeliverySurface(config, {
      now: () => '2026-07-16T17:04:00.000Z',
    });
    const first = envelopeFor(surface, 'first', 'delivery:first');
    await surface.publish(first);
    await writeFile(outbox.path, '{"partial":', { flag: 'a', mode: 0o600 });

    const second = envelopeFor(surface, 'second', 'delivery:second');
    await expect(surface.publish(second)).rejects.toMatchObject({
      code: 'unknown_outcome',
      retryable: true,
    });
    await expect(surface.publish(second)).resolves.toMatchObject({
      status: 'delivered',
      envelope_id: 'second',
    });
    const lines = (await readFile(outbox.path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ idempotency_key: 'delivery:first' }),
      expect.objectContaining({ idempotency_key: 'delivery:second' }),
    ]);
  });

  it('preserves and deduplicates a complete final record missing only its newline', async () => {
    const outbox = await temporaryOutbox();
    const surface = new JsonlOutboxDeliverySurface(outboxConfig(outbox.path), {
      now: () => '2026-07-16T17:04:00.000Z',
    });
    const envelope = envelopeFor(surface, 'first', 'delivery:first');
    const first = await surface.publish(envelope);
    const withoutNewline = (await readFile(outbox.path, 'utf8')).trimEnd();
    await writeFile(outbox.path, withoutNewline, { mode: 0o600 });

    await expect(surface.publish(envelope)).resolves.toEqual(first);
    const contents = await readFile(outbox.path, 'utf8');
    expect(contents.endsWith('\n')).toBe(true);
    expect(contents.trim().split('\n')).toHaveLength(1);
  });

  it('returns an explicit terminal rejection for an oversized artifact', async () => {
    const outbox = await temporaryOutbox();
    const surface = new JsonlOutboxDeliverySurface(outboxConfig(outbox.path), {
      now: () => '2026-07-16T17:04:00.000Z',
    });
    const envelope = envelopeFor(surface, 'oversized', 'delivery:oversized');
    envelope.brief = {
      ...envelope.brief,
      decisions: [
        {
          id: 'oversized-decision',
          kind: 'decision',
          text: 'x'.repeat(8 * 1024 * 1024),
          subject: null,
          confidence: null,
          status: 'decided',
          evidence: [
            {
              meeting_id: envelope.brief.meeting.id,
              block_id: 'oversized-block',
              quote: 'x',
            },
          ],
        },
      ],
    };

    await expect(surface.publish(envelope)).resolves.toMatchObject({
      status: 'rejected',
      external_id: null,
      retryable: false,
      message: expect.stringMatching(/may not exceed/),
    });
    expect(await readFile(outbox.path, 'utf8')).toBe('');
  });
});
