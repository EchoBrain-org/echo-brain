import type { AdapterIdentity } from './adapter.js';
import type { ActionSignal, DecisionSignal, RationaleSignal } from './decision.js';
import type { JsonObject } from './json.js';
import type { MeetingParticipant, MeetingTime } from './meeting.js';

export interface DecisionBrief {
  schema_version: 1;
  id: string;
  meeting: {
    id: string;
    title?: string;
    time?: MeetingTime;
    participants: readonly MeetingParticipant[];
  };
  decisions: readonly DecisionSignal[];
  actions: readonly ActionSignal[];
  rationales: readonly RationaleSignal[];
  provenance: {
    meeting_revision: string;
    processor: AdapterIdentity & { kind: 'decision-processor' };
    generated_at: string;
  };
}

export interface DeliveryDestination {
  adapter_id: string;
  instance_id: string;
  external_id: string;
  metadata?: Readonly<JsonObject>;
}

export interface DeliveryEnvelope {
  schema_version: 1;
  id: string;
  idempotency_key: string;
  destination: DeliveryDestination;
  brief: DecisionBrief;
  approved_at: string;
}

export interface DeliveryReceipt {
  schema_version: 1;
  envelope_id: string;
  status: 'delivered' | 'rejected' | 'failed' | 'unknown';
  external_id: string | null;
  recorded_at: string;
  retryable: boolean;
  message?: string;
}
