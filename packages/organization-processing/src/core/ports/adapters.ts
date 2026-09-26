import type {
  Adapter,
  AdapterIdentity,
  AdapterOperationContext,
} from "../contracts/adapter.js";
import type {
  DecisionExtractionContext,
  DecisionSet,
} from "../contracts/decision.js";
import type {
  MeetingBatch,
  MeetingDocument,
  MeetingPullRequest,
} from "../contracts/meeting.js";

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
