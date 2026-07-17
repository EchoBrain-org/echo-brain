import type { AdapterCursor, MeetingDocument } from '../contracts/meeting.js';
import type { AdapterIdentity } from '../contracts/adapter.js';
import type { DecisionSet } from '../contracts/decision.js';
import type { DeliveryEnvelope, DeliveryReceipt } from '../contracts/delivery.js';
import type { ApprovalDecision } from '../approval/approval-gate.js';

export interface CoreStateStore {
  getSourceCursor(source: AdapterIdentity & { kind: 'meeting-source' }): Promise<AdapterCursor | undefined>;
  setSourceCursor(
    source: AdapterIdentity & { kind: 'meeting-source' },
    cursor: AdapterCursor,
  ): Promise<void>;
  hasProcessed(processingKey: string): Promise<boolean>;
  saveMeeting(meeting: MeetingDocument): Promise<void>;
  getDecisionSet(
    meeting: MeetingDocument,
    processor: AdapterIdentity & { kind: 'decision-processor' },
  ): Promise<DecisionSet | undefined>;
  saveDecisionSet(meeting: MeetingDocument, decisions: DecisionSet): Promise<void>;
  getApproval(processingKey: string): Promise<ApprovalDecision | undefined>;
  saveApproval(processingKey: string, decision: ApprovalDecision): Promise<void>;
  saveDeliveryReceipt(envelope: DeliveryEnvelope, receipt: DeliveryReceipt): Promise<void>;
  markProcessed(processingKey: string): Promise<void>;
}
