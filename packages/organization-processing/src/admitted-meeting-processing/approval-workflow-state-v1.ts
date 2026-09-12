import type { DecisionSet, MeetingDocument } from "../core/index.js";
import type { AdmittedMeetingProcessingAdmissionV1, ActionableMeetingProcessingCandidateV1, ApprovalDeliveryQuarantineReasonV1 } from "./meeting-processing-cycle-v1.js";

export interface PostedPrivateApprovalCardV1 {
  readonly candidate_id: string;
  readonly post_started_at: string;
  /** Opaque identifier assigned by the approval presentation provider. */
  readonly presentation_external_id: string;
  readonly frozen_card_sha256: string;
  readonly approved_snapshot: Readonly<Record<string, unknown>>;
}

export interface PreparedPrivateApprovalPostV1 {
  readonly outbox: ApprovalWorkflowOutboxV1;
  /** True only for the transaction that froze the durable post intent. */
  readonly created: boolean;
}

export type ApprovalWorkflowOutboxV1 = ActionableMeetingProcessingCandidateV1 & {
  readonly presentation_external_id: string | null;
  readonly frozen_card_sha256: string | null;
  readonly approved_snapshot_json: string | null;
  readonly approved_snapshot_sha256: string | null;
  readonly post_started_at: string | null;
  readonly control_approval_sha256: string | null;
  readonly superseded_by_candidate_id: string | null;
  readonly superseded_at: string | null;
  readonly tombstoned_at: string | null;
};

export interface ApprovalDeliveryQuarantineV1 {
  readonly candidate_id: string;
  readonly reason_code: ApprovalDeliveryQuarantineReasonV1;
  readonly quarantined_at: string;
}

export interface SupersededPrivateApprovalCardV1 {
  readonly approval_id: string;
  readonly review_lineage_id: string;
  readonly superseded_by_candidate_id: string;
  readonly presentation_external_id: string | null;
  readonly post_started_at: string;
}

export type FrozenMeetingProcessingCandidateForApprovalV1 = ApprovalWorkflowOutboxV1 & {
  readonly admission: AdmittedMeetingProcessingAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
  readonly approved_snapshot: Readonly<Record<string, unknown>> | null;
};

export interface OutstandingApprovalPresentationV1 {
  readonly approval_id: string;
  readonly candidate_id: string;
  readonly state: "posting" | "posted" | "staged" | "superseded";
}

/**
 * Synchronous candidate/presentation calls must begin and end outside the
 * caller's and owner's authority transactions. Commit each authority operation
 * before crossing this port; never await or call back across it while holding
 * a same-file SQLite transaction. Provider fences use their own handle only.
 */
export interface ApprovalWorkflowStateV1 {
  listOutstandingApprovalPresentations(): readonly OutstandingApprovalPresentationV1[];
  listPendingApprovalDeliveries(): readonly FrozenMeetingProcessingCandidateForApprovalV1[];
  listPendingSupersededApprovalCards(): readonly SupersededPrivateApprovalCardV1[];
  recordSupersededApprovalCardTombstoned(input: {
    readonly approval_id: string;
    readonly presentation_external_id: string;
  }): void;
  readCandidateByApprovalId(
    approvalId: string,
  ): ApprovalWorkflowOutboxV1 | undefined;
  readDurableCardStagedAt(approvalId: string): string | null;
  readApprovalDeliveryQuarantine(
    candidateId: string,
  ): ApprovalDeliveryQuarantineV1 | undefined;
  quarantineApprovalDelivery(input: {
    readonly candidate_id: string;
    readonly reason_code: ApprovalDeliveryQuarantineReasonV1;
  }): ApprovalDeliveryQuarantineV1;
  readFrozenCandidateForApproval(
    approvalId: string,
  ): FrozenMeetingProcessingCandidateForApprovalV1 | undefined;
  prepareApprovalPost(input: {
    readonly candidate_id: string;
    readonly frozen_card_sha256: string;
    readonly approved_snapshot: Readonly<Record<string, unknown>>;
  }): PreparedPrivateApprovalPostV1;
  releaseApprovalPostAttempt(input: {
    readonly candidate_id: string;
    readonly post_started_at: string;
  }): ApprovalWorkflowOutboxV1;
  recordPostedApprovalCard(
    input: PostedPrivateApprovalCardV1,
  ): ApprovalWorkflowOutboxV1;
  markControlPlaneStaged(input: {
    readonly candidate_id: string;
    readonly control_approval_sha256: string;
  }): ApprovalWorkflowOutboxV1;
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
    listOutstandingApprovalPresentations: guarded(state.listOutstandingApprovalPresentations.bind(state)),
    listPendingApprovalDeliveries: guarded(state.listPendingApprovalDeliveries.bind(state)),
    listPendingSupersededApprovalCards: guarded(state.listPendingSupersededApprovalCards.bind(state)),
    recordSupersededApprovalCardTombstoned: guarded(state.recordSupersededApprovalCardTombstoned.bind(state)),
    readCandidateByApprovalId: guarded(state.readCandidateByApprovalId.bind(state)),
    readDurableCardStagedAt: guarded(state.readDurableCardStagedAt.bind(state)),
    readApprovalDeliveryQuarantine: guarded(state.readApprovalDeliveryQuarantine.bind(state)),
    quarantineApprovalDelivery: guarded(state.quarantineApprovalDelivery.bind(state)),
    readFrozenCandidateForApproval: guarded(state.readFrozenCandidateForApproval.bind(state)),
    prepareApprovalPost: guarded(state.prepareApprovalPost.bind(state)),
    releaseApprovalPostAttempt: guarded(state.releaseApprovalPostAttempt.bind(state)),
    recordPostedApprovalCard: guarded(state.recordPostedApprovalCard.bind(state)),
    markControlPlaneStaged: guarded(state.markControlPlaneStaged.bind(state)),
  });
}
