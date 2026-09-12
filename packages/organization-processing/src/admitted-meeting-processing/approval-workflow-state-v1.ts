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

/** Candidate and presentation capabilities consumed by approval workflows. */
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
export function bindApprovalWorkflowStateV1(state: ApprovalWorkflowStateV1): ApprovalWorkflowStateV1 {
  return Object.freeze({
    listOutstandingApprovalPresentations: state.listOutstandingApprovalPresentations.bind(state),
    listPendingApprovalDeliveries: state.listPendingApprovalDeliveries.bind(state),
    listPendingSupersededApprovalCards: state.listPendingSupersededApprovalCards.bind(state),
    recordSupersededApprovalCardTombstoned: state.recordSupersededApprovalCardTombstoned.bind(state),
    readCandidateByApprovalId: state.readCandidateByApprovalId.bind(state),
    readDurableCardStagedAt: state.readDurableCardStagedAt.bind(state),
    readApprovalDeliveryQuarantine: state.readApprovalDeliveryQuarantine.bind(state),
    quarantineApprovalDelivery: state.quarantineApprovalDelivery.bind(state),
    readFrozenCandidateForApproval: state.readFrozenCandidateForApproval.bind(state),
    prepareApprovalPost: state.prepareApprovalPost.bind(state),
    releaseApprovalPostAttempt: state.releaseApprovalPostAttempt.bind(state),
    recordPostedApprovalCard: state.recordPostedApprovalCard.bind(state),
    markControlPlaneStaged: state.markControlPlaneStaged.bind(state),
  });
}
