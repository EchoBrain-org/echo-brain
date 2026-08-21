import type { DecisionSet } from '../contracts/decision.js';
import type { DecisionBrief } from '../contracts/delivery.js';
import type { MeetingDocument } from '../contracts/meeting.js';
import type { AdapterOperationContext } from '../contracts/adapter.js';

export interface ApprovalRequest {
  processing_key: string;
  meeting: MeetingDocument;
  decisions: DecisionSet;
  brief: DecisionBrief;
  requested_at: string;
}

export type ApprovalDecision =
  | {
      status: 'pending';
      reviewed_at: null;
      reviewed_by: null;
      reason: null;
      approved_brief: null;
    }
  | {
      status: 'approved';
      reviewed_at: string;
      reviewed_by: string;
      reason: string | null;
      approved_brief: DecisionBrief;
    }
  | {
      status: 'rejected';
      reviewed_at: string;
      reviewed_by: string;
      reason: string | null;
      approved_brief: null;
    };

export interface ApprovalGate {
  review(
    request: ApprovalRequest,
    context?: AdapterOperationContext,
  ): Promise<ApprovalDecision>;
}
