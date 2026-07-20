import type { ApprovalDecision } from '../../../core/approval/approval-gate.js';
import type { AdapterIdentity } from '../../../core/contracts/adapter.js';
import type { DecisionSet } from '../../../core/contracts/decision.js';
import type {
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../../../core/contracts/delivery.js';
import type {
  AdapterCursor,
  MeetingDocument,
} from '../../../core/contracts/meeting.js';
import type { CoreStateStore } from '../../../core/storage/core-state-store.js';

export type CloseableCoreStateStore = CoreStateStore & {
  close?: () => void;
};

/** Shared transparent methods for product-layer state-store decorators. */
export class DelegatingCoreStateStore implements CoreStateStore {
  constructor(protected readonly delegate: CloseableCoreStateStore) {}

  async getSourceCursor(
    source: AdapterIdentity & { kind: 'meeting-source' },
  ): Promise<AdapterCursor | undefined> {
    return await this.delegate.getSourceCursor(source);
  }

  async setSourceCursor(
    source: AdapterIdentity & { kind: 'meeting-source' },
    cursor: AdapterCursor,
  ): Promise<void> {
    await this.delegate.setSourceCursor(source, cursor);
  }

  async hasProcessed(processingKey: string): Promise<boolean> {
    return await this.delegate.hasProcessed(processingKey);
  }

  async saveMeeting(meeting: MeetingDocument): Promise<void> {
    await this.delegate.saveMeeting(meeting);
  }

  async getDecisionSet(
    meeting: MeetingDocument,
    processor: AdapterIdentity & { kind: 'decision-processor' },
  ): Promise<DecisionSet | undefined> {
    return await this.delegate.getDecisionSet(meeting, processor);
  }

  async saveDecisionSet(
    meeting: MeetingDocument,
    decisions: DecisionSet,
  ): Promise<void> {
    await this.delegate.saveDecisionSet(meeting, decisions);
  }

  async getApproval(
    processingKey: string,
  ): Promise<ApprovalDecision | undefined> {
    return await this.delegate.getApproval(processingKey);
  }

  async saveApproval(
    processingKey: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.delegate.saveApproval(processingKey, decision);
  }

  async saveDeliveryReceipt(
    envelope: DeliveryEnvelope,
    receipt: DeliveryReceipt,
  ): Promise<void> {
    await this.delegate.saveDeliveryReceipt(envelope, receipt);
  }

  async markProcessed(processingKey: string): Promise<void> {
    await this.delegate.markProcessed(processingKey);
  }

  close(): void {
    this.delegate.close?.();
  }
}
