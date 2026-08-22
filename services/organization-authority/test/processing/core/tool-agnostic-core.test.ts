import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  assertCanonicalApprovalDecision,
  type AdapterOperationContext,
  runCoreCycle,
  type AdapterConfig,
  type AdapterConfigValidation,
  type AdapterHealth,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  type DeliverySurfaceAdapter,
  type CoreStateStore,
  type DecisionExtractionContext,
  type DecisionProcessorAdapter,
  type DecisionSet,
  type DeliveryEnvelope,
  type DeliveryReceipt,
  type MeetingBatch,
  type MeetingDocument,
  type MeetingPullRequest,
  type MeetingSourceAdapter,
  type ResolvedActWriter,
  meetingProcessingKey,
} from '../../../src/processing/core/index.js';

function canonicalJsonRoundTrip<T>(value: T): T {
  function sortObjectKeys(current: unknown): unknown {
    if (Array.isArray(current)) return current.map(sortObjectKeys);
    if (current === null || typeof current !== 'object') return current;
    const record = current as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortObjectKeys(record[key])]),
    );
  }
  return JSON.parse(JSON.stringify(sortObjectKeys(value))) as T;
}

const meeting: MeetingDocument = {
  schema_version: 1,
  id: 'meeting-1',
  title: 'Weekly product review',
  time: { actual_start_at: '2026-07-16T16:00:00.000Z' },
  capture: {
    state: 'complete',
    components: [{ kind: 'transcript', state: 'available' }],
  },
  participants: [{ id: 'participant-1', display_name: 'Operator' }],
  content: [
    {
      id: 'block-1',
      kind: 'transcript',
      text: 'We decided to ship the adapter contract.',
    },
  ],
  artifacts: [],
  provenance: {
    source: {
      kind: 'meeting-source',
      adapter_id: 'source-alpha',
      instance_id: 'primary',
      version: '1.0.0',
    },
    external_id: 'external-meeting-1',
    canonical_revision: 'revision-1',
    observed_at: '2026-07-16T17:01:00.000Z',
    normalizer_version: '1.0.0',
    source_updated_at: '2026-07-16T17:00:00.000Z',
  },
};

function validConfig(config: AdapterConfig): AdapterConfigValidation {
  return config.adapter_id.length > 0
    ? { ok: true, errors: [] }
    : { ok: false, errors: ['adapter_id is required'] };
}

async function healthy(): Promise<AdapterHealth> {
  return { status: 'healthy', checked_at: '2026-07-16T17:02:00.000Z' };
}

class SourceFake implements MeetingSourceAdapter {
  readonly identity = {
    kind: 'meeting-source' as const,
    adapter_id: 'source-alpha',
    instance_id: 'primary',
    version: '1.0.0',
  };
  readonly requests: MeetingPullRequest[] = [];

  constructor(private readonly returnedMeeting: MeetingDocument = meeting) {}

  validateConfig = validConfig;
  healthCheck = healthy;

  async pull(request: MeetingPullRequest): Promise<MeetingBatch> {
    this.requests.push(request);
    return { meetings: [this.returnedMeeting], next_cursor: 'cursor-2' };
  }
}

class InvalidCursorSource extends SourceFake {
  override async pull(): Promise<MeetingBatch> {
    return {
      meetings: [meeting],
      next_cursor: 42,
    } as unknown as MeetingBatch;
  }
}

class EmptySource extends SourceFake {
  override async pull(request: MeetingPullRequest): Promise<MeetingBatch> {
    this.requests.push(request);
    return { meetings: [], next_cursor: 'cursor-2' };
  }
}

class ProcessorFake implements DecisionProcessorAdapter {
  readonly identity = {
    kind: 'decision-processor' as const,
    adapter_id: 'processor-alpha',
    instance_id: 'primary',
    version: '2.0.0',
  };
  readonly contexts: DecisionExtractionContext[] = [];

  validateConfig = validConfig;
  healthCheck = healthy;

  async extract(
    input: MeetingDocument,
    context: DecisionExtractionContext,
  ): Promise<DecisionSet> {
    this.contexts.push(context);
    return {
      schema_version: 1,
      meeting_id: input.id,
      meeting_revision: input.provenance.canonical_revision,
      processor: this.identity,
      generated_at: '2026-07-16T17:03:00.000Z',
      signals: [
        {
          id: 'decision-1',
          kind: 'decision',
          text: 'Ship the adapter contract',
          subject: 'adapter-contract',
          confidence: 0.95,
          status: 'decided',
          evidence: [{ meeting_id: input.id, block_id: 'block-1' }],
        },
        {
          id: 'action-1',
          kind: 'action',
          text: 'Publish the shared conformance suite',
          subject: 'adapter-contract',
          confidence: 0.9,
          owner: 'Operator',
          due_at: null,
          evidence: [{ meeting_id: input.id, block_id: 'block-1' }],
        },
      ],
    };
  }
}

class EmptySignalProcessor extends ProcessorFake {
  override async extract(
    input: MeetingDocument,
    context: DecisionExtractionContext,
  ): Promise<DecisionSet> {
    const result = await super.extract(input, context);
    return { ...result, signals: [] };
  }
}

class InvalidEvidenceProcessor extends ProcessorFake {
  override async extract(
    input: MeetingDocument,
    context: DecisionExtractionContext,
  ): Promise<DecisionSet> {
    const result = await super.extract(input, context);
    return {
      ...result,
      signals: result.signals.map((signal, index) =>
        index === 0
          ? {
              ...signal,
              evidence: [
                {
                  meeting_id: input.id,
                  block_id: 'missing-content-block',
                  quote: 'not present in the meeting',
                },
              ],
            }
          : signal,
      ),
    };
  }
}

class DeliverySurfaceFake implements DeliverySurfaceAdapter {
  readonly identity = {
    kind: 'delivery-surface' as const,
    adapter_id: 'delivery-alpha',
    instance_id: 'team-primary',
    version: '1.0.0',
  };
  readonly destination = {
    adapter_id: this.identity.adapter_id,
    instance_id: this.identity.instance_id,
    external_id: 'destination-1',
  };
  readonly envelopes: DeliveryEnvelope[] = [];
  nextStatus: DeliveryReceipt['status'] = 'delivered';
  nextRetryable: boolean | undefined;

  validateConfig = validConfig;
  healthCheck = healthy;

  async publish(envelope: DeliveryEnvelope): Promise<DeliveryReceipt> {
    this.envelopes.push(envelope);
    return {
      schema_version: 1,
      envelope_id: envelope.id,
      status: this.nextStatus,
      external_id: this.nextStatus === 'delivered' ? 'receipt-1' : null,
      recorded_at: '2026-07-16T17:05:00.000Z',
      retryable: this.nextRetryable ?? this.nextStatus !== 'delivered',
    };
  }
}

class ResolvedActWriterFake implements ResolvedActWriter {
  readonly writes: Parameters<ResolvedActWriter['write']>[0][] = [];
  error: Error | undefined;
  onWrite: (() => void) | undefined;
  async write(input: Parameters<ResolvedActWriter['write']>[0]): Promise<void> {
    this.writes.push(input);
    this.onWrite?.();
    if (this.error !== undefined) throw this.error;
  }
}

class InvalidReceiptDeliverySurface extends DeliverySurfaceFake {
  override async publish(envelope: DeliveryEnvelope): Promise<DeliveryReceipt> {
    this.envelopes.push(envelope);
    return {
      schema_version: 1,
      envelope_id: envelope.id,
      status: 'delivered',
      external_id: null,
      recorded_at: '2026-07-16T17:05:00.000Z',
      retryable: false,
    };
  }
}

class UnauthorizedDeliverySurface extends DeliverySurfaceFake {
  override async publish(envelope: DeliveryEnvelope): Promise<DeliveryReceipt> {
    this.envelopes.push(envelope);
    throw new AdapterError(
      'unauthorized',
      'delivery-surface credentials expired',
      false,
    );
  }
}

class HangingDeliverySurface extends DeliverySurfaceFake {
  observedSignal: AbortSignal | undefined;
  private announceStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.announceStarted = resolve;
  });

  override async publish(
    envelope: DeliveryEnvelope,
    context?: AdapterOperationContext,
  ): Promise<DeliveryReceipt> {
    this.envelopes.push(envelope);
    this.observedSignal = context?.signal;
    this.announceStarted();
    return await new Promise<DeliveryReceipt>(() => undefined);
  }
}

class GateFake implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];

  constructor(
    private readonly status: Exclude<ApprovalDecision['status'], 'pending'>,
  ) {}

  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return this.status === 'approved'
      ? {
          status: 'approved',
          reviewed_at: '2026-07-16T17:04:00.000Z',
          reviewed_by: 'reviewer-1',
          reason: null,
          approved_brief: request.brief,
        }
      : {
          status: 'rejected',
          reviewed_at: '2026-07-16T17:04:00.000Z',
          reviewed_by: 'reviewer-1',
          reason: 'needs revision',
          approved_brief: null,
        };
  }
}

class PendingGateFake implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];

  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return {
      status: 'pending',
      reviewed_at: null,
      reviewed_by: null,
      reason: null,
      approved_brief: null,
    };
  }
}

class InvalidRejectedGate implements ApprovalGate {
  async review(): Promise<ApprovalDecision> {
    return {
      status: 'rejected',
      reviewed_at: null,
      reviewed_by: null,
      reason: null,
      approved_brief: null,
    } as unknown as ApprovalDecision;
  }
}

class InvalidApprovedBriefGate implements ApprovalGate {
  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    return {
      status: 'approved',
      reviewed_at: '2026-07-16T17:04:00.000Z',
      reviewed_by: 'reviewer-1',
      reason: null,
      approved_brief: {
        ...request.brief,
        actions: null,
      },
    } as unknown as ApprovalDecision;
  }
}

class StateFake implements CoreStateStore {
  cursor: string | undefined = 'cursor-1';
  meetingAdmission: 'saved' | 'excluded' = 'saved';
  readonly processed = new Set<string>();
  readonly meetings: MeetingDocument[] = [];
  readonly decisions: DecisionSet[] = [];
  readonly decisionEntries: Array<{
    meeting: MeetingDocument;
    decisions: DecisionSet;
  }> = [];
  readonly approvals: ApprovalDecision[] = [];
  readonly approvalsByKey = new Map<string, ApprovalDecision>();
  readonly receipts: DeliveryReceipt[] = [];

  async getSourceCursor(): Promise<string | undefined> {
    return this.cursor;
  }

  async setSourceCursor(
    _source: MeetingSourceAdapter['identity'],
    cursor: string,
  ): Promise<void> {
    this.cursor = cursor;
  }

  async hasProcessed(processingKey: string): Promise<boolean> {
    return this.processed.has(processingKey);
  }

  async admitAndSaveMeeting(
    value: MeetingDocument,
    _processingKey: string,
  ): Promise<'saved' | 'excluded'> {
    if (this.meetingAdmission === 'excluded') return 'excluded';
    this.meetings.push(value);
    return 'saved';
  }

  async saveDecisionSet(
    _processingKey: string,
    meeting: MeetingDocument,
    value: DecisionSet,
  ): Promise<void> {
    this.decisions.push(value);
    this.decisionEntries.push({ meeting, decisions: value });
  }

  async getDecisionSet(
    _processingKey: string,
    meeting: MeetingDocument,
    processor: DecisionProcessorAdapter['identity'],
  ): Promise<DecisionSet | undefined> {
    return this.decisionEntries.find(
      (entry) =>
        entry.meeting.provenance.source.adapter_id ===
          meeting.provenance.source.adapter_id &&
        entry.meeting.provenance.source.instance_id ===
          meeting.provenance.source.instance_id &&
        entry.meeting.provenance.external_id ===
          meeting.provenance.external_id &&
        entry.meeting.provenance.canonical_revision ===
          meeting.provenance.canonical_revision &&
        entry.decisions.processor.adapter_id === processor.adapter_id &&
        entry.decisions.processor.instance_id === processor.instance_id &&
        entry.decisions.processor.version === processor.version,
    )?.decisions;
  }

  async getApproval(
    processingKey: string,
  ): Promise<ApprovalDecision | undefined> {
    return this.approvalsByKey.get(processingKey);
  }

  async saveApproval(
    processingKey: string,
    value: ApprovalDecision,
  ): Promise<void> {
    this.approvals.push(value);
    const current = this.approvalsByKey.get(processingKey);
    if (
      current === undefined ||
      (current.status === 'pending' && value.status !== 'pending')
    ) {
      this.approvalsByKey.set(processingKey, value);
    }
  }

  async saveDeliveryReceipt(
    _processingKey: string,
    _envelope: DeliveryEnvelope,
    receipt: DeliveryReceipt,
  ): Promise<void> {
    this.receipts.push(receipt);
  }

  async markProcessed(processingKey: string): Promise<void> {
    this.processed.add(processingKey);
  }
}

function cycleInput(
  overrides: Partial<Parameters<typeof runCoreCycle>[0]> = {},
): Parameters<typeof runCoreCycle>[0] {
  return {
    meetingSource: new SourceFake(),
    decisionProcessor: new ProcessorFake(),
    deliverySurfaces: [new DeliverySurfaceFake()],
    resolvedActWriter: new ResolvedActWriterFake(),
    approvalGate: new GateFake('approved'),
    state: new StateFake(),
    ...overrides,
  };
}

describe('tool-agnostic core cycle', () => {
  it('does not resume across source, normalizer, or source-revision identity changes', () => {
    const processor = new ProcessorFake();
    const baseline = meetingProcessingKey(meeting, processor);
    const variants: MeetingDocument[] = [
      {
        ...meeting,
        provenance: {
          ...meeting.provenance,
          source: { ...meeting.provenance.source, version: '1.0.1' },
        },
      },
      {
        ...meeting,
        provenance: { ...meeting.provenance, normalizer_version: '1.0.1' },
      },
      {
        ...meeting,
        provenance: { ...meeting.provenance, source_revision: 'provider-revision-2' },
      },
    ];
    for (const variant of variants) {
      expect(meetingProcessingKey(variant, processor)).not.toBe(baseline);
    }
  });

  it('rejects a malformed source batch before writing core state', async () => {
    const state = new StateFake();
    await expect(
      runCoreCycle(cycleInput({
        meetingSource: new InvalidCursorSource(),
        state,
      })),
    ).rejects.toThrow(/next_cursor/);
    expect(state.meetings).toHaveLength(0);
    expect(state.cursor).toBe('cursor-1');
  });

  it('advances an empty source batch without downstream writes', async () => {
    const source = new EmptySource();
    const processor = new ProcessorFake();
    const surface = new DeliverySurfaceFake();
    const gate = new GateFake('approved');
    const state = new StateFake();

    const result = await runCoreCycle(cycleInput({
      meetingSource: source,
      decisionProcessor: processor,
      deliverySurfaces: [surface],
      approvalGate: gate,
      state,
    }));

    expect(result).toMatchObject({
      ok: true,
      meetings_seen: 0,
      deliveries: 0,
      cursor_advanced: true,
    });
    expect(source.requests).toEqual([{ cursor: 'cursor-1' }]);
    expect(state.cursor).toBe('cursor-2');
    expect(state.meetings).toEqual([]);
    expect(state.decisions).toEqual([]);
    expect(state.approvals).toEqual([]);
    expect(state.receipts).toEqual([]);
    expect(state.processed.size).toBe(0);
    expect(processor.contexts).toEqual([]);
    expect(gate.requests).toEqual([]);
    expect(surface.envelopes).toEqual([]);
  });

  it('advances past an excluded meeting without retaining or processing it', async () => {
    const processor = new ProcessorFake();
    const gate = new GateFake('approved');
    const surface = new DeliverySurfaceFake();
    const state = new StateFake();
    state.meetingAdmission = 'excluded';

    const result = await runCoreCycle(cycleInput({
      decisionProcessor: processor,
      approvalGate: gate,
      deliverySurfaces: [surface],
      state,
    }));

    expect(result).toMatchObject({
      ok: true,
      meetings_seen: 1,
      meetings_processed: 0,
      meetings_skipped: 1,
      meetings_no_signals: 0,
      cursor_advanced: true,
    });
    expect(state.cursor).toBe('cursor-2');
    expect(state.meetings).toEqual([]);
    expect(state.decisions).toEqual([]);
    expect(state.approvals).toEqual([]);
    expect(state.receipts).toEqual([]);
    expect(state.processed.size).toBe(0);
    expect(processor.contexts).toEqual([]);
    expect(gate.requests).toEqual([]);
    expect(surface.envelopes).toEqual([]);
  });

  it('does not count an already-processed replay as an empty decision set', async () => {
    const processor = new ProcessorFake();
    const gate = new GateFake('approved');
    const surface = new DeliverySurfaceFake();
    const state = new StateFake();
    state.processed.add(meetingProcessingKey(meeting, processor));

    const result = await runCoreCycle(cycleInput({
      decisionProcessor: processor,
      approvalGate: gate,
      deliverySurfaces: [surface],
      state,
    }));

    expect(result).toMatchObject({
      ok: true,
      meetings_seen: 1,
      meetings_processed: 0,
      meetings_skipped: 1,
      meetings_no_signals: 0,
      cursor_advanced: true,
    });
    expect(processor.contexts).toEqual([]);
    expect(gate.requests).toEqual([]);
    expect(surface.envelopes).toEqual([]);
  });

  it('terminally skips an empty decision set without requesting approval', async () => {
    const processor = new EmptySignalProcessor();
    const gate = new GateFake('approved');
    const surface = new DeliverySurfaceFake();
    const state = new StateFake();

    const result = await runCoreCycle(cycleInput({
      decisionProcessor: processor,
      approvalGate: gate,
      deliverySurfaces: [surface],
      state,
    }));

    expect(result).toMatchObject({
      ok: true,
      meetings_seen: 1,
      meetings_processed: 0,
      meetings_skipped: 1,
      meetings_no_signals: 1,
      meetings_pending: 0,
      deliveries: 0,
      cursor_advanced: true,
    });
    expect(state.cursor).toBe('cursor-2');
    expect(state.decisions).toHaveLength(1);
    expect(state.processed.size).toBe(1);
    expect(state.approvals).toEqual([]);
    expect(gate.requests).toEqual([]);
    expect(surface.envelopes).toEqual([]);
  });

  it('processes an approved revision and stores an idempotent delivery receipt', async () => {
    const source = new SourceFake();
    const processor = new ProcessorFake();
    const surface = new DeliverySurfaceFake();
    const state = new StateFake();
    const result = await runCoreCycle(cycleInput({
      meetingSource: source,
      decisionProcessor: processor,
      deliverySurfaces: [surface],
      state,
      now: () => '2026-07-16T17:03:30.000Z',
      createId: (() => {
        let id = 0;
        return () => `generated-${++id}`;
      })(),
    }));

    expect(result).toMatchObject({
      ok: true,
      meetings_seen: 1,
      meetings_processed: 1,
      deliveries: 1,
      cursor_advanced: true,
    });
    expect(source.requests).toEqual([{ cursor: 'cursor-1' }]);
    expect(state.cursor).toBe('cursor-2');
    expect(state.meetings).toEqual([meeting]);
    expect(state.decisions).toHaveLength(1);
    expect(state.receipts).toHaveLength(1);
    expect(surface.envelopes[0]!.brief.decisions[0]!.text).toBe(
      'Ship the adapter contract',
    );
    const deliveryParts = JSON.parse(
      surface.envelopes[0]!.idempotency_key.slice('delivery:v1:'.length),
    ) as string[];
    const processingParts = JSON.parse(
      deliveryParts[0]!.slice('processing:v2:'.length),
    ) as string[];
    expect(processingParts.slice(0, 5)).toEqual([
      'source-alpha',
      'primary',
      '1.0.0',
      'external-meeting-1',
      'revision-1',
    ]);
  });

  it('records a rejection without publishing', async () => {
    const surface = new DeliverySurfaceFake();
    const state = new StateFake();
    const writer = new ResolvedActWriterFake();
    const result = await runCoreCycle(cycleInput({
      deliverySurfaces: [surface],
      approvalGate: new GateFake('rejected'),
      state,
      resolvedActWriter: writer,
    }));

    expect(result).toMatchObject({
      ok: true,
      meetings_rejected: 1,
      deliveries: 0,
    });
    expect(surface.envelopes).toHaveLength(0);
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]!.decision.status).toBe('rejected');
    expect(state.processed.size).toBe(1);
  });

  it('writes the resolved act once before every approved delivery surface', async () => {
    const events: string[] = [];
    const writer = new ResolvedActWriterFake();
    writer.onWrite = () => events.push('record');
    const first = new DeliverySurfaceFake();
    const second = new DeliverySurfaceFake();
    const originalFirst = first.publish.bind(first);
    const originalSecond = second.publish.bind(second);
    first.publish = async (envelope) => {
      events.push('first');
      return await originalFirst(envelope);
    };
    second.publish = async (envelope) => {
      events.push('second');
      return await originalSecond(envelope);
    };
    const result = await runCoreCycle(cycleInput({
      deliverySurfaces: [first, second],
      resolvedActWriter: writer,
    }));
    expect(result.deliveries).toBe(2);
    expect(writer.writes).toHaveLength(1);
    expect(events).toEqual(['record', 'first', 'second']);
  });

  it('keeps the act nonterminal and cursor pinned when canonical writing fails', async () => {
    const state = new StateFake();
    const surface = new DeliverySurfaceFake();
    const writer = new ResolvedActWriterFake();
    writer.error = new Error('record append unavailable');
    const result = await runCoreCycle(cycleInput({
      state,
      deliverySurfaces: [surface],
      resolvedActWriter: writer,
    }));
    expect(result).toMatchObject({ ok: false, cursor_advanced: false });
    expect(result.failures[0]).toMatchObject({ stage: 'record' });
    expect(surface.envelopes).toHaveLength(0);
    expect(state.processed.size).toBe(0);
    expect(state.cursor).toBe('cursor-1');
  });

  it('keeps the source cursor pinned while manual approval is pending', async () => {
    const surface = new DeliverySurfaceFake();
    const state = new StateFake();
    const result = await runCoreCycle(cycleInput({
      deliverySurfaces: [surface],
      approvalGate: new PendingGateFake(),
      state,
    }));

    expect(result).toMatchObject({
      ok: true,
      meetings_pending: 1,
      meetings_processed: 0,
      deliveries: 0,
      cursor_advanced: false,
    });
    expect(surface.envelopes).toHaveLength(0);
    expect(state.processed.size).toBe(0);
    expect(state.cursor).toBe('cursor-1');
  });

  it('reuses the persisted decision set while a pending approval resumes', async () => {
    const source = new SourceFake();
    const processor = new ProcessorFake();
    const surface = new DeliverySurfaceFake();
    const state = new StateFake();
    await runCoreCycle(cycleInput({
      meetingSource: source,
      decisionProcessor: processor,
      deliverySurfaces: [surface],
      approvalGate: new PendingGateFake(),
      state,
    }));
    const resumed = await runCoreCycle(cycleInput({
      meetingSource: source,
      decisionProcessor: processor,
      deliverySurfaces: [surface],
      state,
    }));

    expect(processor.contexts).toHaveLength(1);
    expect(state.decisions).toHaveLength(1);
    expect(resumed).toMatchObject({ meetings_processed: 1, deliveries: 1 });
  });

  it('resumes a canonicalized approval while preserving participant order', async () => {
    const sourceMeeting: MeetingDocument = {
      ...meeting,
      time: {
        timezone: 'America/Los_Angeles',
        actual_start_at: '2026-07-16T16:00:00.000Z',
      },
      participants: [
        ...meeting.participants,
        { id: 'participant-2', display_name: 'Reviewer' },
      ],
    };
    const source = new SourceFake(sourceMeeting);
    const processor = new ProcessorFake();
    const surface = new DeliverySurfaceFake();
    const state = new StateFake();
    const gate = new PendingGateFake();
    await runCoreCycle(cycleInput({
      meetingSource: source,
      decisionProcessor: processor,
      deliverySurfaces: [surface],
      approvalGate: gate,
      state,
    }));
    const request = gate.requests[0]!;
    const approval = canonicalJsonRoundTrip<ApprovalDecision>({
      status: 'approved',
      reviewed_at: '2026-07-16T17:04:00.000Z',
      reviewed_by: 'reviewer-1',
      reason: null,
      approved_brief: request.brief,
    });
    const validationContext = {
      meeting: sourceMeeting,
      processor: processor.identity,
      decisions: state.decisions[0]!,
    };

    expect(Object.keys(approval.approved_brief!.meeting.time!)).not.toEqual(
      Object.keys(sourceMeeting.time!),
    );
    expect(() =>
      assertCanonicalApprovalDecision(approval, validationContext),
    ).not.toThrow();
    expect(() => assertCanonicalApprovalDecision({
      ...approval,
      approved_brief: {
        ...approval.approved_brief!,
        meeting: {
          ...approval.approved_brief!.meeting,
          participants: [
            ...approval.approved_brief!.meeting.participants,
          ].reverse(),
        },
      },
    }, validationContext)).toThrow(/meeting snapshot/);
    state.approvalsByKey.set(
      meetingProcessingKey(sourceMeeting, processor),
      approval,
    );

    const resumed = await runCoreCycle(cycleInput({
      meetingSource: source,
      decisionProcessor: processor,
      deliverySurfaces: [surface],
      approvalGate: gate,
      state,
    }));

    expect(gate.requests).toHaveLength(1);
    expect(resumed).toMatchObject({
      ok: true,
      meetings_processed: 1,
      deliveries: 1,
      cursor_advanced: true,
    });
  });

  it('does not mark or advance a revision whose delivery is unresolved', async () => {
    const surface = new DeliverySurfaceFake();
    surface.nextStatus = 'unknown';
    const state = new StateFake();
    const result = await runCoreCycle(cycleInput({
      deliverySurfaces: [surface],
      state,
    }));

    expect(result).toMatchObject({ ok: false, cursor_advanced: false });
    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'delivery', meeting_id: 'meeting-1' }),
    ]);
    expect(state.processed.size).toBe(0);
    expect(state.cursor).toBe('cursor-1');
    expect(state.receipts[0]!.status).toBe('unknown');
  });

  it('rejects processor evidence that cannot be resolved to the canonical meeting', async () => {
    const state = new StateFake();
    const result = await runCoreCycle(cycleInput({
      decisionProcessor: new InvalidEvidenceProcessor(),
      state,
    }));

    expect(result).toMatchObject({ ok: false, cursor_advanced: false });
    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'processing', meeting_id: 'meeting-1' }),
    ]);
    expect(state.decisions).toHaveLength(0);
    expect(state.processed.size).toBe(0);
  });

  it('fails closed on a logically invalid delivered receipt', async () => {
    const state = new StateFake();
    const result = await runCoreCycle(cycleInput({
      deliverySurfaces: [new InvalidReceiptDeliverySurface()],
      state,
    }));

    expect(result).toMatchObject({ ok: false, cursor_advanced: false });
    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'delivery', meeting_id: 'meeting-1' }),
    ]);
    expect(state.receipts).toHaveLength(0);
    expect(state.processed.size).toBe(0);
  });

  it('does not mark a revision from a malformed rejected approval', async () => {
    const state = new StateFake();
    const result = await runCoreCycle(cycleInput({
      approvalGate: new InvalidRejectedGate(),
      state,
    }));

    expect(result).toMatchObject({ ok: false, cursor_advanced: false });
    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'approval', meeting_id: 'meeting-1' }),
    ]);
    expect(state.processed.size).toBe(0);
  });

  it('does not publish a malformed approved brief', async () => {
    const state = new StateFake();
    const surface = new DeliverySurfaceFake();
    const result = await runCoreCycle(cycleInput({
      deliverySurfaces: [surface],
      approvalGate: new InvalidApprovedBriefGate(),
      state,
    }));

    expect(result).toMatchObject({ ok: false, cursor_advanced: false });
    expect(result.failures).toEqual([
      expect.objectContaining({ stage: 'approval', meeting_id: 'meeting-1' }),
    ]);
    expect(surface.envelopes).toHaveLength(0);
    expect(state.processed.size).toBe(0);
  });

  it('pins auth and configuration errors instead of misclassifying them as dead letters', async () => {
    const state = new StateFake();
    const result = await runCoreCycle(cycleInput({
      deliverySurfaces: [new UnauthorizedDeliverySurface()],
      state,
    }));

    expect(result).toMatchObject({
      ok: false,
      cursor_advanced: false,
      meetings_dead_lettered: 0,
      dead_letters: [],
    });
    expect(state.processed.size).toBe(0);
  });

  it('bounds a non-settling delivery-surface operation and aborts its adapter context', async () => {
    const surface = new HangingDeliverySurface();
    const state = new StateFake();
    const result = await runCoreCycle(cycleInput({
      deliverySurfaces: [surface],
      state,
      deadlines: { publishMs: 5 },
    }));

    expect(result).toMatchObject({ ok: false, cursor_advanced: false });
    expect(result.failures[0]?.message).toMatch(/timed out/);
    expect(surface.observedSignal?.aborted).toBe(true);
    expect(state.processed.size).toBe(0);
  });

  it('propagates host cancellation into an active adapter operation', async () => {
    const surface = new HangingDeliverySurface();
    const controller = new AbortController();
    const cycle = runCoreCycle(cycleInput({
      deliverySurfaces: [surface],
      state: new StateFake(),
      signal: controller.signal,
    }));
    await surface.started;
    controller.abort(new Error('test shutdown'));
    const result = await cycle;

    expect(result).toMatchObject({ ok: false, cursor_advanced: false });
    expect(result.failures[0]?.message).toBe('test shutdown');
    expect(surface.observedSignal?.aborted).toBe(true);
  });

  it('reuses one persisted approved snapshot and delivery key across retries', async () => {
    const surface = new DeliverySurfaceFake();
    const gate = new GateFake('approved');
    const state = new StateFake();
    surface.nextStatus = 'unknown';
    await runCoreCycle(cycleInput({
      deliverySurfaces: [surface],
      approvalGate: gate,
      state,
    }));
    surface.nextStatus = 'delivered';
    const resumed = await runCoreCycle(cycleInput({
      deliverySurfaces: [surface],
      approvalGate: gate,
      state,
    }));

    expect(gate.requests).toHaveLength(1);
    expect(surface.envelopes).toHaveLength(2);
    expect(surface.envelopes[1]!.brief).toEqual(surface.envelopes[0]!.brief);
    expect(surface.envelopes[1]!.idempotency_key).toBe(
      surface.envelopes[0]!.idempotency_key,
    );
    expect(resumed).toMatchObject({ ok: true, meetings_processed: 1 });
  });

  it('dead-letters a permanent delivery rejection and advances the batch', async () => {
    const surface = new DeliverySurfaceFake();
    surface.nextStatus = 'rejected';
    surface.nextRetryable = false;
    const state = new StateFake();
    const result = await runCoreCycle(cycleInput({
      deliverySurfaces: [surface],
      state,
    }));

    expect(result).toMatchObject({
      ok: false,
      meetings_dead_lettered: 1,
      meetings_processed: 0,
      cursor_advanced: true,
      failures: [],
      dead_letters: [
        {
          meeting_id: 'meeting-1',
          delivery_surface_adapter_id: 'delivery-alpha',
          delivery_surface_instance_id: 'team-primary',
        },
      ],
    });
    expect(state.processed.size).toBe(1);
    expect(state.cursor).toBe('cursor-2');
  });
});
