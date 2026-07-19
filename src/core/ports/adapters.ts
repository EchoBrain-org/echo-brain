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

export interface ApprovalSurfaceAdapter extends Adapter, ApprovalGate {
  readonly identity: AdapterIdentity & { kind: 'approval-surface' };
}

export type AnyAdapter =
  | MeetingSourceAdapter
  | DecisionProcessorAdapter
  | DeliverySurfaceAdapter
  | ApprovalSurfaceAdapter;
