import type Database from "better-sqlite3";
import type { OrganizationAuthoritySigner } from "../application/ports/runtime-ports.js";
import type { OrganizationRecordAppenderV4 } from "@echo-brain/organization-record/new-lineage-v1";
import type { CleanApprovalStagerV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import type { SqliteCleanLiveOnlySourceStateV1 } from "../processing/clean-v1/sqlite-live-only-source-state.js";
import type { PrivateApprovalInteractionHttpApplicationV1 } from "../presentation/private-approval-interaction-http-application-v1.js";

/** The approval-only phases used by the shared live processing lifecycle. */
export interface CleanApprovalProcessingV1 {
  recoverV4Appends(signal: AbortSignal): Promise<void>;
  observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void>;
  appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void>;
}

/** Generic Authority resources made available to the selected approval surface. */
export interface CleanApprovalRuntimeContextV1 {
  readonly state: SqliteCleanLiveOnlySourceStateV1;
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
}

export interface OpenedCleanApprovalRuntimeV1 {
  readonly stager: CleanApprovalStagerV1;
  readonly processing: CleanApprovalProcessingV1;
  /** Omitted only for an approval surface with no inbound interaction route. */
  readonly interaction_ingress?: PrivateApprovalInteractionHttpApplicationV1;
}

/**
 * The active approval surface is selected in composition. Source intake and
 * the shared worker only consume the provider-neutral values returned here.
 */
export interface CleanApprovalRuntimeBundleV1 {
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
    context: CleanApprovalRuntimeContextV1,
  ): Promise<void>;

  open(
    context: CleanApprovalRuntimeContextV1,
  ): Promise<OpenedCleanApprovalRuntimeV1>;
}
