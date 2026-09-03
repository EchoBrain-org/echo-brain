import type Database from "better-sqlite3";
import type { OrganizationAuthoritySigner } from "../application/ports/organization-authority-signer.js";
import type { OrganizationRecordAppenderV4 } from "@echo-brain/organization-record/organization-record-api-v1";
import type { ApprovalWorkflowStagerV1 } from "../processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import type { SqliteAuthorityMeetingProcessingStateV1 } from "../processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import type { PrivateApprovalInteractionHttpApplicationV1 } from "../presentation/private-approval-interaction-http-application-v1.js";
import type { MeetingApprovalJourneyTelemetryPortV1 } from "../processing/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1.js";

/** The approval-only phases used by the shared admitted-processing lifecycle. */
export interface ApprovalWorkflowProcessingV1 {
  recoverV4Appends(signal: AbortSignal): Promise<void>;
  observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void>;
  appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void>;
}

/** Generic Authority resources made available to the selected approval surface. */
export interface ApprovalWorkflowContextV1 {
  readonly state: SqliteAuthorityMeetingProcessingStateV1;
  readonly authority_database: Database.Database;
  readonly control_plane_database: Database.Database;
  readonly record_append: OrganizationRecordAppenderV4;
  readonly signer: OrganizationAuthoritySigner;
  readonly coordinates: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
  };
  readonly next_envelope_id: () => string;
  /** Present only in the explicitly configured staging runtime. */
  readonly journey_telemetry?: MeetingApprovalJourneyTelemetryPortV1;
}

export interface ApprovalWorkflowComponentsV1 {
  readonly stager: ApprovalWorkflowStagerV1;
  readonly processing: ApprovalWorkflowProcessingV1;
  /** Omitted only for an approval surface with no inbound interaction route. */
  readonly interaction_ingress?: PrivateApprovalInteractionHttpApplicationV1;
}

/**
 * The active approval surface is selected in composition. Source intake and
 * the shared worker only consume the provider-neutral values returned here.
 */
export interface ApprovalWorkflowBundleV1 {
  /**
   * Fail closed before the worker starts if this surface cannot recover every
   * outstanding external presentation it may need to reconcile, update, or
   * retire. An adapter may take over pristine queued work, but it must not
   * take over a posting, posted, staged, or untombstoned superseded card
   * merely because it was selected in a new configuration.
   *
   * A replacement must supply its own durable ownership proof. Historical
   * approved-record policy projectors are similarly additive: composition
   * must retain every projector needed to read record protocols already
   * appended before a surface is replaced.
   */
  assert_existing_presentations_owned(
    context: ApprovalWorkflowContextV1,
  ): Promise<void>;

  load(
    context: ApprovalWorkflowContextV1,
  ): Promise<ApprovalWorkflowComponentsV1>;
}
