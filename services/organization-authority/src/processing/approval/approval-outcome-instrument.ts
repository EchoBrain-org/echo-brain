import type {
  AdapterOperationContext,
  ApprovalDecision,
  ApprovalGate,
  ApprovalRequest,
} from '../core/index.js';
import { approvedBriefDigest } from '../core/delivery/envelope.js';

export type ApprovalOutcome = 'accept' | 'edit' | 'reject';

/**
 * Declares whether a resolved review may contribute to reviewer-capacity
 * evidence. The caller must provide both facts explicitly whenever an
 * instrument is installed; there is deliberately no default classification.
 */
export interface ApprovalOutcomeClassification {
  readonly synthetic: boolean;
  readonly reviewer_capacity_eligible: boolean;
}

export interface ApprovalOutcomeSourceLocator {
  readonly adapter_id: string;
  readonly instance_id: string;
  readonly external_id: string;
}

/** One normalized fact emitted after an approval gate resolves a candidate. */
export interface ApprovalOutcomeEvent {
  readonly schema_version: 1;
  readonly processing_key: string;
  readonly meeting_id: string;
  readonly meeting_revision: string;
  readonly source: ApprovalOutcomeSourceLocator;
  /** Copied from the canonical meeting context, never inferred from content. */
  readonly decision_type: string;
  readonly outcome: ApprovalOutcome;
  readonly requested_brief_sha256: string;
  readonly approved_brief_sha256: string | null;
  readonly reviewed_at: string;
  readonly reviewed_by: string;
  readonly synthetic: boolean;
  readonly reviewer_capacity_eligible: boolean;
}

export interface ApprovalOutcomeInstrument {
  record(
    event: ApprovalOutcomeEvent,
    context?: AdapterOperationContext,
  ): Promise<void>;
}

type ResolvedApprovalDecision = Exclude<
  ApprovalDecision,
  { readonly status: 'pending' }
>;

interface RecordedResolution {
  readonly decision: ResolvedApprovalDecision;
  event: ApprovalOutcomeEvent | undefined;
  recorded: boolean;
}

function assertClassification(
  classification: ApprovalOutcomeClassification,
): void {
  if (
    typeof classification.synthetic !== 'boolean' ||
    typeof classification.reviewer_capacity_eligible !== 'boolean'
  ) {
    throw new Error(
      'approval outcome classification requires explicit boolean synthetic and reviewer_capacity_eligible fields',
    );
  }
  if (
    classification.synthetic &&
    classification.reviewer_capacity_eligible
  ) {
    throw new Error(
      'synthetic approval outcomes cannot be reviewer-capacity eligible',
    );
  }
}

function decisionType(request: ApprovalRequest): string {
  const value = request.meeting.context?.meeting_type;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      'resolved approval outcome requires meeting.context.meeting_type',
    );
  }
  return value;
}

function outcomeEvent(
  request: ApprovalRequest,
  decision: ResolvedApprovalDecision,
  classification: ApprovalOutcomeClassification,
): ApprovalOutcomeEvent {
  const requestedDigest = approvedBriefDigest(request.brief);
  const approvedDigest =
    decision.status === 'approved'
      ? approvedBriefDigest(decision.approved_brief)
      : null;
  const event: ApprovalOutcomeEvent = {
    schema_version: 1,
    processing_key: request.processing_key,
    meeting_id: request.meeting.id,
    meeting_revision: request.meeting.provenance.canonical_revision,
    source: Object.freeze({
      adapter_id: request.meeting.provenance.source.adapter_id,
      instance_id: request.meeting.provenance.source.instance_id,
      external_id: request.meeting.provenance.external_id,
    }),
    decision_type: decisionType(request),
    outcome:
      decision.status === 'rejected'
        ? 'reject'
        : approvedDigest === requestedDigest
          ? 'accept'
          : 'edit',
    requested_brief_sha256: requestedDigest,
    approved_brief_sha256: approvedDigest,
    reviewed_at: decision.reviewed_at,
    reviewed_by: decision.reviewed_by,
    synthetic: classification.synthetic,
    reviewer_capacity_eligible:
      classification.reviewer_capacity_eligible,
  };
  return Object.freeze(event);
}

/**
 * Decorates any approval gate with normalized resolved-outcome recording.
 *
 * Concurrent calls for the same processing key share one gate operation and
 * one instrument call. A resolved value is retained for this process lifetime
 * so later duplicate calls cannot emit again. This is intentionally only an
 * in-process guarantee: durable cross-process uniqueness belongs in the
 * instrument's storage boundary.
 *
 * A failed instrument call rejects the review and leaves the resolved value
 * unrecorded. The next call retries that same event without asking the
 * underlying gate to resolve the candidate again.
 */
export class InstrumentedApprovalGate implements ApprovalGate {
  private readonly active = new Map<string, Promise<ApprovalDecision>>();
  private readonly resolved = new Map<string, RecordedResolution>();
  private readonly classification: ApprovalOutcomeClassification;

  constructor(
    private readonly gate: ApprovalGate,
    private readonly instrument: ApprovalOutcomeInstrument,
    classification: ApprovalOutcomeClassification,
  ) {
    assertClassification(classification);
    this.classification = Object.freeze({ ...classification });
  }

  async review(
    request: ApprovalRequest,
    context?: AdapterOperationContext,
  ): Promise<ApprovalDecision> {
    const current = this.active.get(request.processing_key);
    if (current !== undefined) return await current;

    const operation = this.resolveAndRecord(request, context);
    this.active.set(request.processing_key, operation);
    try {
      return await operation;
    } finally {
      if (this.active.get(request.processing_key) === operation) {
        this.active.delete(request.processing_key);
      }
    }
  }

  private async resolveAndRecord(
    request: ApprovalRequest,
    context: AdapterOperationContext | undefined,
  ): Promise<ApprovalDecision> {
    let resolution = this.resolved.get(request.processing_key);
    if (resolution === undefined) {
      const decision = await this.gate.review(request, context);
      if (decision.status === 'pending') return decision;
      resolution = {
        decision: structuredClone(decision),
        event: undefined,
        recorded: false,
      };
      this.resolved.set(request.processing_key, resolution);
    }

    if (!resolution.recorded) {
      resolution.event ??= outcomeEvent(
        request,
        resolution.decision,
        this.classification,
      );
      await this.instrument.record(resolution.event, context);
      resolution.recorded = true;
    }
    return structuredClone(resolution.decision);
  }
}

export function instrumentApprovalGate(
  gate: ApprovalGate,
  instrument: ApprovalOutcomeInstrument,
  classification: ApprovalOutcomeClassification,
): ApprovalGate {
  return new InstrumentedApprovalGate(gate, instrument, classification);
}
