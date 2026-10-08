import type { OrganizationAuthoritySigner } from "@echo-brain/organization-authority-kernel/application/ports/organization-authority-signer";
import type { AppendV4RecordInput, AppendedV4Record } from "@echo-brain/organization-record/organization-record-api-v1";
import type { ApprovalWorkflowStateV1 } from "../admitted-meeting-processing/approval-workflow-state-v1.js";

/**
 * The outcome of one bounded provider terminal-card reconciliation turn.
 * `rendered` means the provider update and its durable rendered marker both
 * completed. `uncertain` deliberately asks the lifecycle to wait for a later
 * normal wake rather than immediately retrying a provider call whose outcome
 * is unknown.
 */
export type ApprovalPresentationReconciliationResultV1 =
  | "rendered"
  | "idle"
  | "uncertain";

/** The approval-only phases used by the shared admitted-processing lifecycle. */
export interface ApprovalWorkflowProcessingV1 {
  recoverV4Appends(signal: AbortSignal): Promise<void>;
  observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void>;
  appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void>;
  /**
   * Reconciles at most a bounded amount of provider presentation work after
   * its durable decision and record work completed. It must never be needed
   * to make an approval terminal or readable fact durable.
   */
  reconcileApprovalPresentations?(
    signal: AbortSignal,
  ): Promise<ApprovalPresentationReconciliationResultV1 | void>;
}

/** Generic Authority resources made available to the selected approval surface. */
export interface ApprovalWorkflowContextV1 {
  readonly state: ApprovalWorkflowStateV1;
  readonly record_append: { append(input: AppendV4RecordInput): Promise<AppendedV4Record> };
  readonly signer: OrganizationAuthoritySigner;
  readonly coordinates: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
  };
  readonly next_envelope_id: () => string;
  /**
   * Optional wake signal. An approval surface calls it after a verified
   * terminal action is durably queued so the runtime can publish it now
   * rather than at the next periodic cycle. Observational: it carries no
   * data, may be a no-op, and its failure never changes the surface's
   * acknowledgement or durable receipt.
   */
  readonly on_terminal_action_queued?: () => void;
}
