import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '../../core/index.js';
import { toApprovalDecision } from './decision-node.js';
import type { DecisionNodeStore } from './decision-node-store.js';

/**
 * Manual-mode approval gate: stage the request as a decision node and report
 * its current folded state. Resolution happens out of band through any
 * surface that writes to the same store (CLI today, others later).
 */
export class StoreBackedApprovalGate implements ApprovalGate {
  constructor(private readonly store: DecisionNodeStore) {}

  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    return toApprovalDecision(await this.store.ensureRequested(request));
  }
}
