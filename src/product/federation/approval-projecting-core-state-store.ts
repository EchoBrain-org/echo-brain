import type { ApprovalDecision } from '../../core/approval/approval-gate.js';
import type { AdapterIdentity } from '../../core/contracts/adapter.js';
import type { DecisionSet } from '../../core/contracts/decision.js';
import type {
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../../core/contracts/delivery.js';
import type {
  AdapterCursor,
  MeetingDocument,
} from '../../core/contracts/meeting.js';
import type { CoreStateStore } from '../../core/storage/core-state-store.js';
import {
  toApprovalDecision,
  type DecisionNodeState,
} from '../approval/decision-node.js';
import type { DecisionNodeStore } from '../approval/decision-node-store.js';
import { canonicalJson } from './canonical-json.js';
import type { FederatedRecordProjector } from './record-projector.js';

type DecisionNodeReader = Pick<DecisionNodeStore, 'getState'>;
type ApprovedRecordProjector = Pick<
  FederatedRecordProjector,
  'projectApproved'
>;
type ProjectedApprovalGroup = Awaited<
  ReturnType<ApprovedRecordProjector['projectApproved']>
>;

export type ApprovedProjectionCommitGate = (
  state: DecisionNodeState,
  projected: ProjectedApprovalGroup,
) => Promise<void>;

function fail(message: string): never {
  throw new Error(`approved record projection gate failed: ${message}`);
}

function exactApprovalMatch(
  cached: ApprovalDecision,
  node: DecisionNodeState,
): boolean {
  return canonicalJson(cached) === canonicalJson(toApprovalDecision(node));
}

/**
 * Additive state-store gate for seed-grade approval projection.
 *
 * The core cycle re-reads an approval after every monotonic save. That makes
 * `getApproval` the single path through which both newly resolved and cached
 * approvals can reach delivery. An approved value is therefore withheld until
 * its immutable decision-node projection has been appended idempotently.
 */
export class ApprovalProjectingCoreStateStore implements CoreStateStore {
  constructor(
    private readonly delegate: CoreStateStore & { close?: () => void },
    private readonly decisionNodes: DecisionNodeReader,
    private readonly projector: ApprovedRecordProjector,
    private readonly afterProjection?: ApprovedProjectionCommitGate,
  ) {}

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
    const cached = await this.delegate.getApproval(processingKey);
    if (cached?.status !== 'approved') return cached;

    const node = await this.decisionNodes.getState(processingKey);
    if (node === undefined) {
      fail(`approved cache has no decision node (${processingKey})`);
    }
    if (node.processing_key !== processingKey) {
      fail(`decision node processing key diverges (${processingKey})`);
    }
    if (!exactApprovalMatch(cached, node)) {
      fail(`approved cache diverges from decision node (${processingKey})`);
    }

    const projected = await this.projector.projectApproved(node);
    await this.afterProjection?.(node, projected);
    return cached;
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
