/**
 * Deliberately offline replay support for the relocation migration.
 *
 * This is not an adapter registration or a production composition.  It gives
 * the migration tests one narrow way to exercise the real core cycle with
 * deterministic, in-memory collaborators and the local structured-text
 * processor.  In particular it must not be used as a route around the
 * authority-owned approval and delivery compositions.
 */
import { createHash } from 'node:crypto';
import {
  approvedBriefDigest,
  deliveryIdempotencyKey,
  meetingProcessingKey,
  runCoreCycle,
  type AdapterConfig,
  type AdapterConfigValidation,
  type AdapterHealth,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  type CoreCycleResult,
  type CoreStateStore,
  type DecisionSet,
  type DecisionBrief,
  type DeliveryEnvelope,
  type DeliveryReceipt,
  type DeliverySurfaceAdapter,
  type MeetingBatch,
  type MeetingDocument,
  type MeetingPullRequest,
  type MeetingSourceAdapter,
  type ResolvedActWriter,
} from '../core/index.js';
import {
  STRUCTURED_TEXT_DECISION_PROCESSOR_ADAPTER_ID,
  createStructuredTextDecisionProcessor,
} from '../adapters/decision-processors/structured-text/structured-text-decision-processor.js';

export const SYNTHETIC_REPLAY_CLOCK = '2026-08-18T00:00:00.000Z';

function decisionApprovalId(processingKey: string): string {
  return createHash('sha256').update(processingKey).digest('hex');
}

export type SyntheticReviewDisposition = 'accept' | 'edit' | 'reject';

export type SyntheticReviewDirective =
  | { readonly disposition: 'accept' }
  | {
      readonly disposition: 'edit';
      readonly instructions: {
        readonly operation: 'replace';
        readonly target: 'decision[0].text';
        readonly replacement: string;
      };
    }
  | { readonly disposition: 'reject' };

export interface SyntheticReplayManifest {
  readonly observations: Readonly<Record<string, SyntheticReviewDirective>>;
}

export interface SyntheticReviewEvent {
  readonly observation_id: string;
  readonly processing_key: string;
  readonly approval_id: string;
  readonly source: {
    readonly adapter_id: string;
    readonly instance_id: string;
    readonly external_id: string;
  };
  readonly decision_type: string;
  readonly disposition: SyntheticReviewDisposition;
  readonly card_id: string;
  readonly resolution_id: string;
  readonly synthetic: true;
  readonly reviewer_capacity_eligible: false;
}

export interface SyntheticReplaySnapshot {
  readonly observation_id: string;
  readonly processing_key: string;
  readonly approval_id: string;
  readonly decision_set: DecisionSet | null;
  readonly approval: ApprovalDecision | null;
  readonly approval_digest: string | null;
  readonly delivery_idempotency_keys: readonly string[];
  readonly result: CoreCycleResult;
}

export interface SyntheticReplayResult {
  readonly snapshots: readonly SyntheticReplaySnapshot[];
  readonly events: readonly SyntheticReviewEvent[];
  readonly delivery_attempts: number;
  readonly unique_deliveries: number;
}

/** Stable manifest key, intentionally independent of generated runtime IDs. */
export function syntheticObservationId(meeting: MeetingDocument): string {
  const source = meeting.provenance;
  return `synthetic-observation:v1:${JSON.stringify([
    source.source.adapter_id,
    source.source.instance_id,
    source.external_id,
    source.canonical_revision,
  ])}`;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex')}`;
}

function syntheticDecisionType(meeting: MeetingDocument): string {
  const value = meeting.context?.['meeting_type'];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('synthetic replay meeting requires context.meeting_type');
  }
  return value;
}

function validConfig(_config: AdapterConfig): AdapterConfigValidation {
  return { ok: true, errors: [] };
}

async function healthy(): Promise<AdapterHealth> {
  return { status: 'healthy', checked_at: SYNTHETIC_REPLAY_CLOCK };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function decisionStoreKey(
  meeting: MeetingDocument,
  processor: { adapter_id: string; instance_id: string; version: string },
): string {
  return JSON.stringify([
    meeting.provenance.source.adapter_id,
    meeting.provenance.source.instance_id,
    meeting.provenance.external_id,
    meeting.provenance.canonical_revision,
    processor.adapter_id,
    processor.instance_id,
    processor.version,
  ]);
}

/**
 * A test-only monotonic store.  Values may advance from absent to present, or
 * pending to resolved, but a resolved approval and its decision snapshot never
 * change in place.  Its mutators contain no await points, which makes a single
 * JS event-loop turn the atomic winner selection for competing cycles.
 */
export class SyntheticMonotonicCoreStateStore implements CoreStateStore {
  private readonly cursors = new Map<string, string>();
  private readonly processed = new Set<string>();
  private readonly meetings = new Map<string, MeetingDocument>();
  private readonly decisions = new Map<string, DecisionSet>();
  private readonly approvals = new Map<string, ApprovalDecision>();
  private readonly receipts = new Map<string, DeliveryReceipt>();

  async getSourceCursor(source: MeetingSourceAdapter['identity']): Promise<string | undefined> {
    return this.cursors.get(`${source.adapter_id}:${source.instance_id}`);
  }

  async setSourceCursor(source: MeetingSourceAdapter['identity'], cursor: string): Promise<void> {
    this.cursors.set(`${source.adapter_id}:${source.instance_id}`, cursor);
  }

  async hasProcessed(processingKey: string): Promise<boolean> {
    return this.processed.has(processingKey);
  }

  async admitAndSaveMeeting(
    meeting: MeetingDocument,
    _processingKey: string,
  ): Promise<'saved'> {
    const key = syntheticObservationId(meeting);
    if (!this.meetings.has(key)) this.meetings.set(key, clone(meeting));
    return 'saved';
  }

  async getDecisionSet(
    _processingKey: string,
    meeting: MeetingDocument,
    processor: { adapter_id: string; instance_id: string; version: string },
  ): Promise<DecisionSet | undefined> {
    const decisions = this.decisions.get(decisionStoreKey(meeting, processor));
    return decisions === undefined ? undefined : clone(decisions);
  }

  async saveDecisionSet(
    _processingKey: string,
    meeting: MeetingDocument,
    decisions: DecisionSet,
  ): Promise<void> {
    const key = decisionStoreKey(meeting, decisions.processor);
    if (!this.decisions.has(key)) this.decisions.set(key, clone(decisions));
  }

  async getApproval(processingKey: string): Promise<ApprovalDecision | undefined> {
    const approval = this.approvals.get(processingKey);
    return approval === undefined ? undefined : clone(approval);
  }

  async saveApproval(processingKey: string, decision: ApprovalDecision): Promise<void> {
    const current = this.approvals.get(processingKey);
    if (
      current === undefined ||
      (current.status === 'pending' && decision.status !== 'pending')
    ) {
      this.approvals.set(processingKey, clone(decision));
    }
  }

  async saveDeliveryReceipt(
    _processingKey: string,
    envelope: DeliveryEnvelope,
    receipt: DeliveryReceipt,
  ): Promise<void> {
    if (!this.receipts.has(envelope.idempotency_key)) {
      this.receipts.set(envelope.idempotency_key, clone(receipt));
    }
  }

  async markProcessed(processingKey: string): Promise<void> {
    this.processed.add(processingKey);
  }
}

class SyntheticMeetingSource implements MeetingSourceAdapter {
  readonly identity: MeetingSourceAdapter['identity'];

  constructor(private readonly meetings: readonly MeetingDocument[]) {
    const first = meetings[0];
    if (first === undefined) {
      throw new Error('synthetic replay source requires at least one meeting');
    }
    this.identity = first.provenance.source;
    if (
      meetings.some(
        (meeting) =>
          JSON.stringify(meeting.provenance.source) !==
          JSON.stringify(this.identity),
      )
    ) {
      throw new Error('synthetic replay batch mixes meeting-source identities');
    }
  }

  validateConfig = validConfig;
  healthCheck = healthy;

  async pull(_request: MeetingPullRequest): Promise<MeetingBatch> {
    return { meetings: this.meetings };
  }
}

/** A manifest is a closed world: missing observations fail rather than default. */
export class ManifestSyntheticApprovalGate implements ApprovalGate {
  readonly events: SyntheticReviewEvent[] = [];
  private readonly resolutions = new Map<string, ApprovalDecision>();

  constructor(
    private readonly manifest: SyntheticReplayManifest,
    private readonly now: () => string = () => SYNTHETIC_REPLAY_CLOCK,
  ) {}

  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    const existing = this.resolutions.get(request.processing_key);
    if (existing !== undefined) return existing;
    const observationId = syntheticObservationId(request.meeting);
    const directive = this.manifest.observations[observationId];
    if (directive === undefined) {
      throw new Error(`synthetic replay manifest has no directive for ${observationId}`);
    }
    const cardId = stableId('synthetic-card', request.processing_key);
    const resolutionId = stableId('synthetic-resolution', request.processing_key);
    const decision: ApprovalDecision = directive.disposition === 'reject'
      ? {
          status: 'rejected',
          reviewed_at: this.now(),
          reviewed_by: 'synthetic-reviewer',
          reason: 'synthetic rejection',
          approved_brief: null,
        }
      : {
          status: 'approved',
          reviewed_at: this.now(),
          reviewed_by: 'synthetic-reviewer',
          reason: directive.disposition === 'edit' ? 'synthetic edit' : null,
          approved_brief: directive.disposition === 'edit'
            ? this.applyEdit(request, directive)
            : request.brief,
        };
    this.resolutions.set(request.processing_key, decision);
    this.events.push({
      observation_id: observationId,
      processing_key: request.processing_key,
      approval_id: decisionApprovalId(request.processing_key),
      source: {
        adapter_id: request.meeting.provenance.source.adapter_id,
        instance_id: request.meeting.provenance.source.instance_id,
        external_id: request.meeting.provenance.external_id,
      },
      decision_type: syntheticDecisionType(request.meeting),
      disposition: directive.disposition,
      card_id: cardId,
      resolution_id: resolutionId,
      synthetic: true,
      reviewer_capacity_eligible: false,
    });
    return decision;
  }

  private applyEdit(
    request: ApprovalRequest,
    directive: Extract<SyntheticReviewDirective, { disposition: 'edit' }>,
  ): DecisionBrief {
    const first = request.brief.decisions[0];
    if (first === undefined) {
      throw new Error('synthetic decision-text edit requires decision[0]');
    }
    return {
      ...request.brief,
      // The explicit reviewer edit changes only the declared field. The
      // source evidence stays attached so the resulting brief remains
      // traceable to the immutable meeting snapshot.
      decisions: [
        { ...first, text: directive.instructions.replacement },
        ...request.brief.decisions.slice(1),
      ],
    };
  }
}

/** Idempotent capture is keyed by the core-generated delivery idempotency key. */
export class SyntheticDeliveryCapture implements DeliverySurfaceAdapter {
  readonly identity = {
    kind: 'delivery-surface' as const,
    adapter_id: 'synthetic-delivery-capture',
    instance_id: 'offline',
    version: '1.0.0',
  };
  readonly destination = {
    adapter_id: this.identity.adapter_id,
    instance_id: this.identity.instance_id,
    external_id: 'synthetic-replay',
  };
  readonly envelopes = new Map<string, DeliveryEnvelope>();
  attempts = 0;

  constructor(
    private readonly now: () => string = () => SYNTHETIC_REPLAY_CLOCK,
  ) {}

  validateConfig = validConfig;
  healthCheck = healthy;

  async publish(envelope: DeliveryEnvelope): Promise<DeliveryReceipt> {
    this.attempts += 1;
    if (!this.envelopes.has(envelope.idempotency_key)) {
      this.envelopes.set(envelope.idempotency_key, envelope);
    }
    return {
      schema_version: 1,
      envelope_id: envelope.id,
      status: 'delivered',
      external_id: stableId('synthetic-delivery', envelope.idempotency_key),
      recorded_at: this.now(),
      retryable: false,
    };
  }
}

/** Offline replay still exercises the core resolved-act invariant. */
export class SyntheticResolvedActWriter implements ResolvedActWriter {
  readonly acts = new Map<string, Parameters<ResolvedActWriter['write']>[0]>();
  attempts = 0;

  async write(input: Parameters<ResolvedActWriter['write']>[0]): Promise<void> {
    this.attempts += 1;
    const existing = this.acts.get(input.processing_key);
    if (
      existing !== undefined &&
      JSON.stringify(existing.decision) !== JSON.stringify(input.decision)
    ) {
      throw new Error('synthetic resolved act changed after its first write');
    }
    if (existing === undefined) this.acts.set(input.processing_key, clone(input));
  }
}

export interface SyntheticReplayHarness {
  readonly state: SyntheticMonotonicCoreStateStore;
  readonly gate: ManifestSyntheticApprovalGate;
  readonly delivery: SyntheticDeliveryCapture;
  run(meetings: readonly MeetingDocument[]): Promise<SyntheticReplayResult>;
}

export interface SyntheticReplayHarnessOptions {
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly processorInstanceId?: string;
}

export function createSyntheticReplayHarness(
  manifest: SyntheticReplayManifest,
  options: SyntheticReplayHarnessOptions = {},
): SyntheticReplayHarness {
  const state = new SyntheticMonotonicCoreStateStore();
  let ids = 0;
  const createId =
    options.createId ??
    (() => `synthetic-id-${String(++ids).padStart(6, '0')}`);
  const now = options.now ?? (() => SYNTHETIC_REPLAY_CLOCK);
  const gate = new ManifestSyntheticApprovalGate(manifest, now);
  const delivery = new SyntheticDeliveryCapture(now);
  const resolvedActWriter = new SyntheticResolvedActWriter();
  const processor = createStructuredTextDecisionProcessor(
    {
      adapter_id: STRUCTURED_TEXT_DECISION_PROCESSOR_ADAPTER_ID,
      instance_id: options.processorInstanceId ?? 'synthetic-replay',
      settings: {},
    },
    { now },
  );

  return {
    state,
    gate,
    delivery,
    async run(meetings: readonly MeetingDocument[]): Promise<SyntheticReplayResult> {
      const snapshots: SyntheticReplaySnapshot[] = [];
      for (const meeting of meetings) {
        const result = await runCoreCycle({
          meetingSource: new SyntheticMeetingSource([meeting]),
          decisionProcessor: processor,
          deliverySurfaces: [delivery],
          resolvedActWriter,
          approvalGate: gate,
          state,
          now,
          createId,
        });
        const observationId = syntheticObservationId(meeting);
        const processingKey = meetingProcessingKey(meeting, processor);
        const approvalId = decisionApprovalId(processingKey);
        const decisions = await state.getDecisionSet(
          processingKey,
          meeting,
          processor.identity,
        );
        const approval = await state.getApproval(processingKey);
        const deliveryKey =
          approval?.status === 'approved'
            ? deliveryIdempotencyKey(
                processingKey,
                delivery,
                approval.approved_brief,
              )
            : null;
        snapshots.push({
          observation_id: observationId,
          processing_key: processingKey,
          approval_id: approvalId,
          decision_set: decisions ?? null,
          approval: approval ?? null,
          approval_digest:
            approval?.status === 'approved'
              ? approvedBriefDigest(approval.approved_brief)
              : null,
          delivery_idempotency_keys:
            deliveryKey !== null && delivery.envelopes.has(deliveryKey)
              ? [deliveryKey]
              : [],
          result,
        });
      }
      return {
        snapshots,
        events: [...gate.events],
        delivery_attempts: delivery.attempts,
        unique_deliveries: delivery.envelopes.size,
      };
    },
  };
}
