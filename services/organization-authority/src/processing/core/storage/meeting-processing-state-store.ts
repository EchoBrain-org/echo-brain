import type { AdapterCursor, MeetingDocument } from '../contracts/meeting.js';
import type { AdapterIdentity } from '../contracts/adapter.js';
import type { DecisionSet } from '../contracts/decision.js';
import type { DeliveryEnvelope, DeliveryReceipt } from '../contracts/delivery.js';
import type { ApprovalDecision } from '../approval/approval-gate.js';

/** The atomic pre-record admission result for one canonical meeting. */
export type MeetingPreRecordAdmission = 'saved' | 'excluded';

export interface MeetingProcessingStateStore {
  getSourceCursor(source: AdapterIdentity & { kind: 'meeting-source' }): Promise<AdapterCursor | undefined>;
  setSourceCursor(
    source: AdapterIdentity & { kind: 'meeting-source' },
    cursor: AdapterCursor,
  ): Promise<void>;
  hasProcessed(processingKey: string): Promise<boolean>;
  /**
   * Checks the member-owned ingestion valve and stores the raw meeting at one
   * linearization point. Implementations without a valve always return
   * `saved`; an Authority store must not split the check from the insert.
   */
  admitAndSaveMeeting(
    meeting: MeetingDocument,
    processingKey: string,
  ): Promise<MeetingPreRecordAdmission>;
  getDecisionSet(
    processingKey: string,
    meeting: MeetingDocument,
    processor: AdapterIdentity & { kind: 'decision-processor' },
  ): Promise<DecisionSet | undefined>;
  saveDecisionSet(
    processingKey: string,
    meeting: MeetingDocument,
    decisions: DecisionSet,
  ): Promise<void>;
  getApproval(processingKey: string): Promise<ApprovalDecision | undefined>;
  saveApproval(processingKey: string, decision: ApprovalDecision): Promise<void>;
  saveDeliveryReceipt(
    processingKey: string,
    envelope: DeliveryEnvelope,
    receipt: DeliveryReceipt,
  ): Promise<void>;
  /**
   * Marks either a terminal approval result or a frozen empty decision set as
   * complete. Empty extraction is a durable no-op, not an approval request.
   */
  markProcessed(processingKey: string): Promise<void>;
}
