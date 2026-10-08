import type { DecisionSet, MeetingDocument } from "../core/index.js";
import type { AdmittedMeetingProcessingAdmissionV1, ActionableMeetingProcessingCandidateV1 } from "./meeting-processing-cycle-v1.js";

export type ApprovalWorkflowOutboxV1 = ActionableMeetingProcessingCandidateV1 & {
  readonly approved_snapshot_json: string | null;
  readonly approved_snapshot_sha256: string | null;
  /** Parsed suggested_projects_json (sorted, unique, at most 20); set together with the snapshot. */
  readonly suggested_project_ids: readonly string[] | null;
  readonly superseded_by_candidate_id: string | null;
  readonly superseded_at: string | null;
};

export type FrozenMeetingProcessingCandidateForApprovalV1 = ApprovalWorkflowOutboxV1 & {
  readonly admission: AdmittedMeetingProcessingAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
  readonly approved_snapshot: Readonly<Record<string, unknown>> | null;
};

export interface FreezeApprovalProposalInputV1 {
  readonly candidate_id: string;
  readonly approved_snapshot: Readonly<Record<string, unknown>>;
  /** Strictly ascending, at most 20. */
  readonly suggested_project_ids: readonly string[];
}

export interface ListPendingApprovalDeliveriesOptionsV1 {
  /** Default 25, clamped to 1..100. */
  readonly limit?: number;
  /** Restrict to one personal source. */
  readonly source_key?: string;
}

/**
 * Synchronous candidate/proposal calls must begin and end outside the
 * caller's and owner's authority transactions. Commit each authority operation
 * before crossing this port; never await or call back across it while holding
 * a same-file SQLite transaction.
 */
export interface ApprovalWorkflowStateV1 {
  /** Queued, actionable lineage heads whose reviewer membership is active, oldest first, revalidated. */
  listPendingApprovalDeliveries(options?: ListPendingApprovalDeliveriesOptionsV1): readonly FrozenMeetingProcessingCandidateForApprovalV1[];
  readCandidateByApprovalId(approvalId: string): ApprovalWorkflowOutboxV1 | undefined;
  readFrozenCandidateForApproval(approvalId: string): FrozenMeetingProcessingCandidateForApprovalV1 | undefined;
  /**
   * queued -> staged in one guarded UPDATE; staged with the same snapshot bytes returns as is (suggestions
   * stay as first frozen); staged with other bytes throws; superseded returns as is.
   */
  freezeProposal(input: FreezeApprovalProposalInputV1): ApprovalWorkflowOutboxV1;
}

/** Clamps a pending-delivery page size to 1..100 (default 25). */
export function pendingApprovalDeliveryLimitV1(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 25;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

/** Expose only the named capabilities, without the backing store object. */
export function bindApprovalWorkflowStateV1(
  state: ApprovalWorkflowStateV1,
  assertTransactionIdle: () => void,
): ApprovalWorkflowStateV1 {
  function guarded<Args extends unknown[], Result>(operation: (...args: Args) => Result) {
    return (...args: Args): Result => {
      assertTransactionIdle();
      return operation(...args);
    };
  }
  return Object.freeze({
    listPendingApprovalDeliveries: guarded(state.listPendingApprovalDeliveries.bind(state)),
    readCandidateByApprovalId: guarded(state.readCandidateByApprovalId.bind(state)),
    readFrozenCandidateForApproval: guarded(state.readFrozenCandidateForApproval.bind(state)),
    freezeProposal: guarded(state.freezeProposal.bind(state)),
  });
}
