import type {
  Adapter,
  AdapterIdentity,
  AdapterOperationContext,
} from '../contracts/adapter.js';
import type {
  DecisionExtractionContext,
  DecisionSet,
} from '../contracts/decision.js';
import type {
  DeliveryDestination,
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../contracts/delivery.js';
import type {
  MeetingBatch,
  MeetingDocument,
  MeetingPullRequest,
} from '../contracts/meeting.js';
import type { ApprovalGate } from '../approval/approval-gate.js';
import type { ApprovalDecision } from '../approval/approval-gate.js';
import type { AdapterOperationContext as OperationContext } from '../contracts/adapter.js';

export interface MeetingSourceAdapter extends Adapter {
  readonly identity: AdapterIdentity & { kind: 'meeting-source' };
  pull(
    request: MeetingPullRequest,
    context?: AdapterOperationContext,
  ): Promise<MeetingBatch>;
}

export interface DecisionProcessorAdapter extends Adapter {
  readonly identity: AdapterIdentity & { kind: 'decision-processor' };
  extract(
    meeting: MeetingDocument,
    context: DecisionExtractionContext,
    operation?: AdapterOperationContext,
  ): Promise<DecisionSet>;
}

export interface DeliverySurfaceAdapter extends Adapter {
  readonly identity: AdapterIdentity & { kind: 'delivery-surface' };
  readonly destination: DeliveryDestination;
  publish(
    envelope: DeliveryEnvelope,
    context?: AdapterOperationContext,
  ): Promise<DeliveryReceipt>;
}

/**
 * The one Authority-owned act performed for a resolved terminal decision.
 * It intentionally precedes all delivery surfaces, so a human-readable
 * delivery can never become the only durable representation of an approval
 * or rejection.
 */
export interface ResolvedActWriter {
  write(
    input: {
      readonly processing_key: string;
      readonly meeting: MeetingDocument;
      readonly decisions: DecisionSet;
      readonly decision: Exclude<ApprovalDecision, { status: 'pending' }>;
    },
    context?: OperationContext,
  ): Promise<void>;
}

export interface ApprovalSurfaceAdapter extends Adapter, ApprovalGate {
  readonly identity: AdapterIdentity & { kind: 'approval-surface' };
}
