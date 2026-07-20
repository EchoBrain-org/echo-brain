import type { ApprovalDecision } from '../../../core/approval/approval-gate.js';
import type { CoreStateStore } from '../../../core/storage/core-state-store.js';
import {
  toApprovalDecision,
  type DecisionNodeState,
} from '../../approval/decision-node.js';
import type { DecisionNodeStore } from '../../approval/decision-node-store.js';
import { canonicalJson } from '../foundation/canonical-json.js';
import { DelegatingCoreStateStore } from './delegating-core-state-store.js';
import type { FederatedRecordProjector } from '../record-projector.js';

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
export class ApprovalProjectingCoreStateStore extends DelegatingCoreStateStore {
  constructor(
    delegate: CoreStateStore & { close?: () => void },
    private readonly decisionNodes: DecisionNodeReader,
    private readonly projector: ApprovedRecordProjector,
    private readonly afterProjection?: ApprovedProjectionCommitGate,
  ) {
    super(delegate);
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

}
