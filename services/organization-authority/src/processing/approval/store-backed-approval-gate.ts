import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '../core/index.js';
import {
  toApprovalDecision,
  type DecisionNodeState,
} from './decision-node.js';

/** The create-once request capability the gate needs from durable storage. */
export interface DecisionNodeRequestStore {
  ensureRequested(request: ApprovalRequest): Promise<DecisionNodeState>;
}

/**
 * Manual-mode approval gate: stage the request as a decision node and report
 * its current folded state. Resolution happens out of band through any
 * surface that writes to the same store (CLI today, others later).
 */
export class StoreBackedApprovalGate implements ApprovalGate {
  constructor(private readonly store: DecisionNodeRequestStore) {}

  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    return toApprovalDecision(await this.store.ensureRequested(request));
  }
}
