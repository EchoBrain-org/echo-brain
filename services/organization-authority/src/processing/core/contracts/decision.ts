import type { AdapterIdentity } from './adapter.js';

export interface EvidenceSpan {
  meeting_id: string;
  block_id: string;
  quote?: string;
  started_at?: string;
  ended_at?: string;
}

interface SignalBase {
  id: string;
  text: string;
  subject: string | null;
  confidence: number | null;
  evidence: readonly EvidenceSpan[];
}

export interface DecisionSignal extends SignalBase {
  kind: 'decision';
  status: 'proposed' | 'decided' | 'unresolved';
}

export interface ActionSignal extends SignalBase {
  kind: 'action';
  owner: string | null;
  due_at: string | null;
}

export interface RationaleSignal extends SignalBase {
  kind: 'rationale';
  supports_signal_ids: readonly string[];
}

export type ExtractedSignal = DecisionSignal | ActionSignal | RationaleSignal;

export interface DecisionExtractionContext {
  processor_version: string;
  input_fingerprint: string;
}

export interface DecisionSet {
  schema_version: 1;
  meeting_id: string;
  meeting_revision: string;
  processor: AdapterIdentity & { kind: 'decision-processor' };
  generated_at: string;
  signals: readonly ExtractedSignal[];
}
