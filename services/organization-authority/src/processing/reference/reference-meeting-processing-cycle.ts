import { randomUUID } from 'node:crypto';
import type { ApprovalGate } from '../core/approval/approval-gate.js';
import type { MeetingDocument, MeetingPullRequest } from '../core/contracts/meeting.js';
import {
  assertCanonicalApprovalDecision,
  assertCanonicalDecisionBrief,
  assertCanonicalDecisionSet,
  assertCanonicalMeetingDocument,
  assertCanonicalMeetingBatch,
} from '../core/contracts/validation.js';
import {
  assertDeliveryReceipt,
  createDeliveryEnvelope,
} from '../core/delivery/envelope.js';
import type {
  DeliverySurfaceAdapter,
  DecisionProcessorAdapter,
  MeetingSourceAdapter,
  ResolvedActWriter,
} from '../core/ports/adapters.js';
import type { MeetingProcessingStateStore } from '../core/storage/meeting-processing-state-store.js';
import { compileDecisionBrief } from '../core/processing/brief.js';

export interface ReferenceMeetingProcessingCycleDependencies {
  meetingSource: MeetingSourceAdapter;
  decisionProcessor: DecisionProcessorAdapter;
  deliverySurfaces: readonly DeliverySurfaceAdapter[];
  resolvedActWriter: ResolvedActWriter;
  approvalGate: ApprovalGate;
  state: MeetingProcessingStateStore;
  now?: () => string;
  createId?: () => string;
  signal?: AbortSignal;
  deadlines?: Partial<ReferenceMeetingProcessingCycleDeadlines>;
}

export interface ReferenceMeetingProcessingCycleDeadlines {
  pullMs: number;
  extractMs: number;
  approvalMs: number;
  recordMs: number;
  publishMs: number;
}

const DEFAULT_REFERENCE_MEETING_PROCESSING_CYCLE_DEADLINES: ReferenceMeetingProcessingCycleDeadlines = {
  pullMs: 30_000,
  extractMs: 60_000,
  approvalMs: 30_000,
  recordMs: 30_000,
  publishMs: 30_000,
};

function abortReason(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${label} was cancelled`);
}

async function runBounded<T>(
  label: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal?.aborted === true) throw abortReason(parentSignal, label);
  const controller = new AbortController();
  const onParentAbort = () =>
    controller.abort(abortReason(parentSignal!, label));
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAborted = () => reject(abortReason(controller.signal, label));
    if (controller.signal.aborted) rejectAborted();
    else controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export interface ReferenceMeetingProcessingCycleFailure {
  meeting_id: string;
  stage: 'processing' | 'approval' | 'record' | 'delivery';
  message: string;
}

export interface ReferenceMeetingProcessingCycleDeadLetter {
  meeting_id: string;
  delivery_surface_adapter_id: string;
  delivery_surface_instance_id: string;
  message: string;
}

export interface ReferenceMeetingProcessingCycleResult {
  ok: boolean;
  meetings_seen: number;
  meetings_processed: number;
  meetings_skipped: number;
  meetings_no_signals: number;
  meetings_pending: number;
  meetings_rejected: number;
  meetings_dead_lettered: number;
  deliveries: number;
  cursor_advanced: boolean;
  failures: readonly ReferenceMeetingProcessingCycleFailure[];
  dead_letters: readonly ReferenceMeetingProcessingCycleDeadLetter[];
}

export function referenceMeetingProcessingKey(
  meeting: MeetingDocument,
  processor: DecisionProcessorAdapter,
): string {
  const source = meeting.provenance;
  const identity = processor.identity;
  return `processing:v2:${JSON.stringify([
    source.source.adapter_id,
    source.source.instance_id,
    source.source.version,
    source.external_id,
    source.canonical_revision,
    source.normalizer_version,
    source.source_revision ?? null,
    identity.adapter_id,
    identity.instance_id,
    identity.version,
  ])}`;
}

function assertMeetingSource(
  meeting: MeetingDocument,
  source: MeetingSourceAdapter,
): void {
  assertCanonicalMeetingDocument(meeting, source.identity);
}

function assertProcessorResult(
  meeting: MeetingDocument,
  processor: DecisionProcessorAdapter,
  result: Awaited<ReturnType<DecisionProcessorAdapter['extract']>>,
): void {
  assertCanonicalDecisionSet(result, meeting, processor.identity);
}

export async function runReferenceMeetingProcessingCycle(
  dependencies: ReferenceMeetingProcessingCycleDependencies,
  request: MeetingPullRequest = {},
): Promise<ReferenceMeetingProcessingCycleResult> {
  if (dependencies.deliverySurfaces.length === 0) {
    throw new Error('at least one delivery-surface adapter is required');
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const createId = dependencies.createId ?? randomUUID;
  const deadlines = {
    ...DEFAULT_REFERENCE_MEETING_PROCESSING_CYCLE_DEADLINES,
    ...dependencies.deadlines,
  };
  if (
    Object.values(deadlines).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error('core cycle deadlines must be positive integer milliseconds');
  }
  const storedCursor = await dependencies.state.getSourceCursor(dependencies.meetingSource.identity);
  const batch = await runBounded(
    'meeting-source pull',
    deadlines.pullMs,
    dependencies.signal,
    async (signal) =>
      await dependencies.meetingSource.pull(
        {
          ...request,
          cursor: request.cursor ?? storedCursor,
        },
        { signal },
      ),
  );
  assertCanonicalMeetingBatch(batch);
  const failures: ReferenceMeetingProcessingCycleFailure[] = [];
  const deadLetters: ReferenceMeetingProcessingCycleDeadLetter[] = [];
  let meetingsProcessed = 0;
  let meetingsSkipped = 0;
  let meetingsNoSignals = 0;
  let meetingsPending = 0;
  let meetingsRejected = 0;
  let meetingsDeadLettered = 0;
  let deliveries = 0;

  for (const meeting of batch.meetings) {
    const processingKey = referenceMeetingProcessingKey(meeting, dependencies.decisionProcessor);
    if (await dependencies.state.hasProcessed(processingKey)) {
      meetingsSkipped += 1;
      continue;
    }
    let stage: ReferenceMeetingProcessingCycleFailure['stage'] = 'processing';
    try {
      assertMeetingSource(meeting, dependencies.meetingSource);
      if (
        (await dependencies.state.admitAndSaveMeeting(
          meeting,
          processingKey,
        )) ===
        'excluded'
      ) {
        meetingsSkipped += 1;
        continue;
      }
      let decisions = await dependencies.state.getDecisionSet(
        processingKey,
        meeting,
        dependencies.decisionProcessor.identity,
      );
      if (decisions === undefined) {
        decisions = await runBounded(
          'decision-processor extraction',
          deadlines.extractMs,
          dependencies.signal,
          async (signal) =>
            await dependencies.decisionProcessor.extract(
              meeting,
              {
                processor_version:
                  dependencies.decisionProcessor.identity.version,
                input_fingerprint: processingKey,
              },
              { signal },
            ),
        );
        assertProcessorResult(meeting, dependencies.decisionProcessor, decisions);
        await dependencies.state.saveDecisionSet(
          processingKey,
          meeting,
          decisions,
        );
      }
      assertProcessorResult(meeting, dependencies.decisionProcessor, decisions);
      if (decisions.signals.length === 0) {
        await dependencies.state.markProcessed(processingKey);
        meetingsSkipped += 1;
        meetingsNoSignals += 1;
        continue;
      }
      const brief = compileDecisionBrief(createId(), meeting, decisions);
      assertCanonicalDecisionBrief(brief, {
        meeting,
        processor: dependencies.decisionProcessor.identity,
        decisions,
      });
      stage = 'approval';
      let approval = await dependencies.state.getApproval(processingKey);
      if (approval === undefined || approval.status === 'pending') {
        const reviewed = await runBounded(
          'approval review',
          deadlines.approvalMs,
          dependencies.signal,
          async (signal) =>
            await dependencies.approvalGate.review(
              {
                processing_key: processingKey,
                meeting,
                decisions,
                brief,
                requested_at: now(),
              },
              { signal },
            ),
        );
        assertCanonicalApprovalDecision(reviewed, {
          meeting,
          processor: dependencies.decisionProcessor.identity,
          decisions,
        });
        await dependencies.state.saveApproval(processingKey, reviewed);
        // Re-read after the monotonic save so concurrent cycles use the same
        // winning resolved snapshot instead of diverging across delivery surfaces.
        approval =
          (await dependencies.state.getApproval(processingKey)) ?? reviewed;
      }
      assertCanonicalApprovalDecision(approval, {
        meeting,
        processor: dependencies.decisionProcessor.identity,
        decisions,
      });
      if (approval.status === 'pending') {
        meetingsPending += 1;
        continue;
      }
      stage = 'record';
      await runBounded(
        'resolved-act write',
        deadlines.recordMs,
        dependencies.signal,
        async (signal) =>
          await dependencies.resolvedActWriter.write(
            {
              processing_key: processingKey,
              meeting,
              decisions,
              decision: approval,
            },
            { signal },
          ),
      );
      if (approval.status === 'rejected') {
        meetingsRejected += 1;
        await dependencies.state.markProcessed(processingKey);
        continue;
      }
      stage = 'delivery';
      let retryableDeliveryFailed = false;
      let terminalDeliveryFailed = false;
      for (const deliverySurface of dependencies.deliverySurfaces) {
        const envelope = createDeliveryEnvelope(
          createId(),
          processingKey,
          deliverySurface,
          approval.approved_brief,
          approval.reviewed_at,
        );
        try {
          const receipt = await runBounded(
            'delivery-surface publish',
            deadlines.publishMs,
            dependencies.signal,
            async (signal) =>
              await deliverySurface.publish(envelope, { signal }),
          );
          assertDeliveryReceipt(envelope, receipt);
          await dependencies.state.saveDeliveryReceipt(
            processingKey,
            envelope,
            receipt,
          );
          if (receipt.status !== 'delivered') {
            const message =
              receipt.message ?? `delivery ended with status ${receipt.status}`;
            if (receipt.status === 'rejected' && !receipt.retryable) {
              terminalDeliveryFailed = true;
              deadLetters.push({
                meeting_id: meeting.id,
                delivery_surface_adapter_id:
                  deliverySurface.identity.adapter_id,
                delivery_surface_instance_id:
                  deliverySurface.identity.instance_id,
                message,
              });
            } else {
              retryableDeliveryFailed = true;
              failures.push({
                meeting_id: meeting.id,
                stage: 'delivery',
                message,
              });
            }
          } else {
            deliveries += 1;
          }
        } catch (error) {
          // A thrown adapter error can represent auth, configuration, transport,
          // or an unknown outcome. None of those prove that this particular
          // artifact reached a terminal state. Adapters must return an explicit
          // non-retryable `rejected` receipt to dead-letter an artifact safely.
          retryableDeliveryFailed = true;
          failures.push({
            meeting_id: meeting.id,
            stage: 'delivery',
            message: (error as Error).message,
          });
        }
      }
      if (!retryableDeliveryFailed) {
        await dependencies.state.markProcessed(processingKey);
        if (terminalDeliveryFailed) meetingsDeadLettered += 1;
        else meetingsProcessed += 1;
      }
    } catch (error) {
      failures.push({
        meeting_id: meeting.id,
        stage,
        message: (error as Error).message,
      });
    }
  }

  let cursorAdvanced = false;
  if (
    failures.length === 0 &&
    meetingsPending === 0 &&
    batch.next_cursor !== undefined
  ) {
    await dependencies.state.setSourceCursor(dependencies.meetingSource.identity, batch.next_cursor);
    cursorAdvanced = true;
  }
  return {
    ok: failures.length === 0 && deadLetters.length === 0,
    meetings_seen: batch.meetings.length,
    meetings_processed: meetingsProcessed,
    meetings_skipped: meetingsSkipped,
    meetings_no_signals: meetingsNoSignals,
    meetings_pending: meetingsPending,
    meetings_rejected: meetingsRejected,
    meetings_dead_lettered: meetingsDeadLettered,
    deliveries,
    cursor_advanced: cursorAdvanced,
    failures,
    dead_letters: deadLetters,
  };
}
