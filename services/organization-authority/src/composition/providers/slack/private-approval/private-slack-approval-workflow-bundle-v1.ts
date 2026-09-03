import { join } from "node:path";
import {
  FileOrganizationSecretStore,
  SqliteSlackBotTokenReaderV1,
  SqliteSlackDmApprovalPersistenceV1,
} from "@echo-brain/organization-control-plane/slack-approval-integration-v1";
import { readPrivateAuthoritySlackSigningSecret } from "../../../../adapters/security/private-file-credentials.js";
import { PrivateSlackApprovalCardPosterV1 } from "../../../../processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.js";
import { createPrivateSlackBlockV4RecordWriterV1 } from "../../../../processing/adapters/approval-resolution/slack/private-slack-block-v4-record-writer-v1.js";
import type {
  ApprovalWorkflowBundleV1,
  ApprovalWorkflowContextV1,
} from "../../../approval-workflow-bundle-v1.js";
import { createPrivateSlackApprovalHttpAdapterV1 } from "./private-slack-approval-http-adapter-v1.js";
import { PrivateSlackDmApprovalStagerV1 } from "./private-slack-dm-approval-stager-v1.js";
import { PrivateSlackApprovalTerminalCoordinatorV1 } from "./private-slack-approval-terminal-coordinator-v1.js";
import { createPrivateSlackApprovalInteractionHandlerV1 } from "./private-slack-approval-interaction-handler-v1.js";
import type { PrivateSlackApprovalInteractionRejectionStageV1 } from "./private-slack-approval-interaction-protocol-v1.js";
import { resolveMeetingOwnerPrivateSlackApprovalReviewerV1 } from "./resolve-meeting-owner-private-slack-approval-reviewer-v1.js";
import {
  resolveCurrentPrivateSlackConnectionV1,
  type CurrentPrivateSlackConnectionV1,
} from "./resolve-current-private-slack-connection-v1.js";
import { SqlitePrivateSlackApprovalAssignmentStateV1 } from "./sqlite-private-slack-approval-assignment-state-v1.js";
import { SqlitePrivateSlackApprovalTerminalAuthorityV1 } from "./sqlite-private-slack-approval-terminal-authority-v1.js";
import { SqliteStablePrivateApprovalAuthorityFenceV1 } from "./sqlite-stable-private-approval-authority-fence-v1.js";

export interface PrivateSlackApprovalWorkflowBundleConfigV1 {
  readonly state_directory: string;
  /** Path only. The secret is read only after source admission. */
  readonly signing_secret_file: string;
  readonly connection_id: string;
  /** Provider-specific test seam; production reads the admitted Slack token. */
  readonly poster?: Pick<
    PrivateSlackApprovalCardPosterV1,
    | "openDirectMessage"
    | "postMarker"
    | "reconcileMarker"
    | "publish"
    | "tombstone"
    | "renderTerminal"
  >;
  /** Content-free diagnostic emitted only after Slack HMAC verification. */
  readonly on_rejection?: (event: {
    readonly stage: PrivateSlackApprovalInteractionRejectionStageV1;
  }) => void;
}

interface UnownedApprovalPresentationRowV1 {
  readonly approval_id: string;
  readonly state: string;
}

/**
 * Proves that every outstanding external approval operation belongs to this
 * Slack surface. V3 already has immutable Slack assignment evidence, so this
 * is intentionally a read-only guard rather than a schema migration.
 *
 * Queued approvals are excluded: no external operation has begun and another
 * adapter can safely present them after a controlled restart. A `posting`
 * row is included because a network call may already have happened even when
 * no message timestamp was durably recovered.
 */
function assertPrivateSlackApprovalPresentationOwnershipV1(
  context: ApprovalWorkflowContextV1,
  connection: CurrentPrivateSlackConnectionV1,
): void {
  const unowned = context.authority_database
    .prepare(
      `SELECT outbox.approval_id, outbox.state
         FROM authority_live_approval_outbox_v2 AS outbox
        WHERE (
          outbox.state IN ('posting', 'posted', 'staged')
          OR (
            outbox.state = 'superseded'
            AND outbox.post_started_at IS NOT NULL
            AND outbox.tombstoned_at IS NULL
          )
        )
          AND NOT EXISTS (
            SELECT 1
              FROM authority_private_approval_assignments_v3 AS assignment
             WHERE assignment.approval_id = outbox.approval_id
               AND assignment.candidate_id = outbox.candidate_id
               AND assignment.connection_id = ?
               AND assignment.connection_contract_sha256 = ?
               AND assignment.connection_state_sha256 = ?
          )
        ORDER BY outbox.approval_id
        LIMIT 1`,
    )
    .get(
      connection.connection_id,
      connection.connection_contract_sha256,
      connection.connection_state_sha256,
    ) as UnownedApprovalPresentationRowV1 | undefined;
  if (unowned !== undefined) {
    throw new Error(
      `private Slack approval workflow cannot prove ownership of outstanding ${unowned.state} presentation ${unowned.approval_id}`,
    );
  }
}

/**
 * The current Slack private-DM approval lane behind the provider-neutral
 * approval-workflow seam. Its ordering and all durable Slack behavior are
 * deliberately unchanged from the V1 admitted composition.
 */
export function createPrivateSlackApprovalWorkflowBundleV1(
  config: PrivateSlackApprovalWorkflowBundleConfigV1,
): ApprovalWorkflowBundleV1 {
  return Object.freeze({
    async assert_existing_presentations_owned(
      context: ApprovalWorkflowContextV1,
    ): Promise<void> {
      const slack = resolveCurrentPrivateSlackConnectionV1(
        context.control_plane_database,
        config.connection_id,
        context.coordinates,
      );
      assertPrivateSlackApprovalPresentationOwnershipV1(
        context,
        slack,
      );
    },
    async load(context: ApprovalWorkflowContextV1) {
      const slack = resolveCurrentPrivateSlackConnectionV1(
        context.control_plane_database,
        config.connection_id,
        context.coordinates,
      );
      const poster =
        config.poster ??
        new PrivateSlackApprovalCardPosterV1(
          new SqliteSlackBotTokenReaderV1(
            context.control_plane_database,
            new FileOrganizationSecretStore(
              join(config.state_directory, "secrets"),
            ),
          ).readBotToken({
            connection_id: slack.connection_id,
            connection_state_sha256: slack.connection_state_sha256,
          }),
        );
      const assignments = new SqlitePrivateSlackApprovalAssignmentStateV1(
        context.authority_database,
      );
      const controlPlane = new SqliteSlackDmApprovalPersistenceV1({
        database: context.control_plane_database,
        authority_fence: new SqliteStablePrivateApprovalAuthorityFenceV1(
          context.authority_database,
        ),
        now: () => new Date().toISOString(),
      });
      const stager = new PrivateSlackDmApprovalStagerV1({
        authority: context.state,
        authority_database: context.authority_database,
        control_plane_database: context.control_plane_database,
        coordinates: context.coordinates,
        connection_id: slack.connection_id,
        assignments,
        control_plane: controlPlane,
        poster,
        resolve_reviewer_target: resolveMeetingOwnerPrivateSlackApprovalReviewerV1,
        ...(context.journey_telemetry === undefined
          ? {}
          : { journey_telemetry: context.journey_telemetry }),
      });
      const recordWriter = await createPrivateSlackBlockV4RecordWriterV1({
        append: context.record_append,
        signer: context.signer,
        state_lineage_id: context.coordinates.state_lineage_id,
        next_envelope_id: context.next_envelope_id,
      });
      const processing = new PrivateSlackApprovalTerminalCoordinatorV1({
        control_plane: controlPlane,
        authority: new SqlitePrivateSlackApprovalTerminalAuthorityV1({
          source: context.state,
          assignments,
          coordinates: context.coordinates,
        }),
        record_writer: recordWriter,
        poster,
        ...(context.journey_telemetry === undefined
          ? {}
          : { journey_telemetry: context.journey_telemetry }),
      });
      const interactions = createPrivateSlackApprovalInteractionHandlerV1({
        signing_secret: readPrivateAuthoritySlackSigningSecret(
          `file:${config.signing_secret_file}`,
        ),
        persistence: controlPlane,
        on_rejection: config.on_rejection,
        ...(context.journey_telemetry === undefined
          ? {}
          : {
              journey_telemetry: context.journey_telemetry,
              read_durable_card_staged_at: (approvalId: string) =>
                context.state.readDurableCardStagedAt(approvalId),
            }),
      });
      return Object.freeze({
        stager,
        processing,
        interaction_ingress:
          createPrivateSlackApprovalHttpAdapterV1(interactions),
      });
    },
  });
}
