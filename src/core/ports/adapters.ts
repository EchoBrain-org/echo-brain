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
  ChannelDestination,
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../contracts/delivery.js';
import type {
  MeetingBatch,
  MeetingDocument,
  MeetingPullRequest,
} from '../contracts/meeting.js';

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

export interface CommunicationChannelAdapter extends Adapter {
  readonly identity: AdapterIdentity & { kind: 'communication-channel' };
  readonly destination: ChannelDestination;
  publish(
    envelope: DeliveryEnvelope,
    context?: AdapterOperationContext,
  ): Promise<DeliveryReceipt>;
}

export type AnyAdapter =
  | MeetingSourceAdapter
  | DecisionProcessorAdapter
  | CommunicationChannelAdapter;
