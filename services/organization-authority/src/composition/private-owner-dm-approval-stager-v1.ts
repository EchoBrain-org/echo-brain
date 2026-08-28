/**
 * Private owner-DM delivery for the clean live source.
 *
 * The legacy reaction stager deliberately has no part in this path.  In
 * particular, a candidate's extraction-time `review_policy_*` fields remain
 * provenance only: this stager writes a null canonical policy and makes the
 * owner select a policy at the approve click.
 */
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  buildPrivateApprovalSurfaceBindingV1,
  type ApprovalContractSha256,
  type PendingPrivateApprovalV1,
  type PrivateApprovalSlackCardBindingV1,
  type PrivateApprovalSlackTargetCoordinatesV1,
  type StagePrivateApprovalPendingV1,
  type StagedPrivateApprovalPendingV1,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import type Database from "better-sqlite3";
import { buildPrivateApprovalBlockKitCardV1 } from "./private-approval-block-kit-card-v1.js";
import {
  resolveGranolaMeetingOwnerPrivateApprovalTargetV1,
  type GranolaMeetingOwnerPrivateApprovalTargetV1,
} from "./resolve-granola-meeting-owner-private-approval-target-v1.js";
import {
  SqlitePrivateApprovalAssignmentStateV1,
  type PrivateApprovalAssignmentStateV1,
} from "./sqlite-private-approval-assignment-state-v1.js";
import { compileDecisionBrief } from "../processing/core/processing/brief.js";
import {
  PrivateSlackApprovalCardPosterV1,
  type PrivateSlackApprovalCardPresentationV1,
} from "../processing/clean-v1/private-slack-approval-card-poster-v1.js";
import type { CleanApprovalStageInputV1, CleanApprovalStagerV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import {
  SqliteCleanLiveOnlySourceStateV1,
  type CleanLiveApprovalOutboxV1,
} from "../processing/clean-v1/sqlite-live-only-source-state.js";

type Digest = ApprovalContractSha256;

export interface PrivateOwnerDmApprovalStagerV1Options {
  readonly authority: SqliteCleanLiveOnlySourceStateV1;
  readonly authority_database: Database.Database;
  readonly control_plane_database: Database.Database;
  readonly coordinates: PrivateApprovalSlackTargetCoordinatesV1;
  readonly connection_id: string;
  readonly assignments: SqlitePrivateApprovalAssignmentStateV1;
  readonly control_plane: {
    stage(input: StagePrivateApprovalPendingV1): StagedPrivateApprovalPendingV1;
  };
  readonly poster: Pick<
    PrivateSlackApprovalCardPosterV1,
    "openDirectMessage" | "postMarker" | "reconcileMarker" | "publish" | "tombstone"
  >;
  /** Kept injected so deterministic tests need no global clock. */
  readonly now?: () => string;
  /** Injected only for focused proof; production uses the bounded resolver. */
  readonly resolve_target?: (
    input: Parameters<typeof resolveGranolaMeetingOwnerPrivateApprovalTargetV1>[0],
  ) => GranolaMeetingOwnerPrivateApprovalTargetV1 | undefined;
  /** This is a protocol boundary, not a card-specific hash implementation. */
  readonly canonical_sha256?: (value: unknown) => Digest;
}

interface PrivateCardAndSnapshotV1 {
  readonly card: PrivateSlackApprovalCardPresentationV1 & {
    readonly approval_id: string;
    readonly assignment_version: number;
  };
  readonly frozen_card_sha256: Digest;
  readonly approved_snapshot: Readonly<Record<string, unknown>>;
  readonly approved_snapshot_sha256: Digest;
}

const MAX_TITLE = 150;
const MAX_CONTEXT = 3_000;

function displayText(value: unknown, fallback: string, maximum: number): string {
  const normalized =
    typeof value === "string"
      ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()
      : "";
  const selected = normalized.length === 0 ? fallback : normalized;
  return selected.slice(0, maximum).trim();
}

function buildCardAndSnapshot(
  input: CleanApprovalStageInputV1,
  sha256: (value: unknown) => Digest,
): PrivateCardAndSnapshotV1 {
  const brief = compileDecisionBrief(
    `brf_${input.candidate.candidate_semantic_sha256.slice("sha256:".length)}`,
    input.meeting,
    input.decisions,
  );
  const payload = Object.freeze({
    brief,
    source: Object.freeze({
      adapter_id: input.admission.source.adapter_id,
      instance_id: input.admission.source.instance_id,
      external_id: input.meeting.provenance.external_id,
    }),
    alternatives: Object.freeze([]),
    links: null,
    reviewed_at: input.decisions.generated_at,
    surface: "slack-private-owner-dm" as const,
  });
  const approved_snapshot = Object.freeze({
    schema_version: 2 as const,
    kind: "echo-approved-decision-snapshot-v2" as const,
    approval_id: input.candidate.approval_id,
    staged_content_sha256: sha256({ meeting: input.meeting, decisions: input.decisions }),
    final_content_sha256: sha256(payload),
    payload_contract_id: "organization-record-approval-payload-v1" as const,
    approved_payload: payload,
  });
  const approval_context = displayText(
    `Review ${brief.decisions.length} decision${brief.decisions.length === 1 ? "" : "s"} and ${brief.actions.length} action${brief.actions.length === 1 ? "" : "s"} from this meeting.`,
    "Review this meeting's extracted decisions.",
    MAX_CONTEXT,
  );
  const card = buildPrivateApprovalBlockKitCardV1({
    schema_version: 1,
    approval_id: input.candidate.approval_id,
    assignment_version: 1,
    meeting_title: displayText(input.meeting.title, "Meeting approval", MAX_TITLE),
    approval_context,
  });
  const approved_snapshot_sha256 = sha256(approved_snapshot);
  const frozen_card_sha256 = sha256({
    schema_version: 1,
    kind: "echo-private-owner-dm-approval-card-v1",
    card,
    approved_snapshot_sha256,
  });
  return Object.freeze({
    card,
    frozen_card_sha256,
    approved_snapshot,
    approved_snapshot_sha256,
  });
}

function candidateCommitment(
  outbox: CleanLiveApprovalOutboxV1,
  card: PrivateCardAndSnapshotV1,
) {
  return Object.freeze({
    approval_id: outbox.approval_id,
    candidate_id: outbox.candidate_id,
    candidate_sha256: outbox.candidate_semantic_sha256 as Digest,
    frozen_card_sha256: card.frozen_card_sha256,
    approved_snapshot_sha256: card.approved_snapshot_sha256,
  });
}

function assignmentMatchesCurrentTarget(
  assignment: PrivateApprovalAssignmentStateV1,
  target: GranolaMeetingOwnerPrivateApprovalTargetV1,
  surface: ReturnType<typeof buildPrivateApprovalSurfaceBindingV1>,
): boolean {
  const link = target.slack_target.current_slack_identity_link;
  return (
    assignment.organization_id === target.slack_target.connection.body.organization_id &&
    assignment.connection_id === target.slack_target.connection.body.connection_id &&
    assignment.connection_contract_sha256 === target.slack_target.connection.sha256 &&
    assignment.connection_state_sha256 === target.slack_target.connection_state.sha256 &&
    assignment.approval_binding.approval_binding_id === surface.body.approval_surface_binding_id &&
    assignment.approval_binding.approval_binding_contract_sha256 === surface.sha256 &&
    assignment.assignment.current_assignee.principal_id === target.assignee.principal_id &&
    assignment.assignment.current_assignee.membership_id === target.assignee.membership_id &&
    assignment.assignment.current_slack_identity_link.external_identity_link_id === link.external_identity_link_id &&
    assignment.assignment.current_slack_identity_link.external_identity_link_contract_sha256 === link.external_identity_link_contract_sha256 &&
    assignment.assignment.current_slack_identity_link.provider_subject_id === link.provider_subject_id &&
    assignment.dm_channel.workspace_id === target.slack_target.connection.body.provider_tenant_id &&
    assignment.dm_channel.enterprise_id === target.slack_target.connection.body.provider_enterprise_id
  );
}

/**
 * The new private approval staging lane.  Its sequence is intentionally
 * irreversible: freeze -> verified owner DM -> durable assignment -> inert
 * marker -> durable CP pending/card binding -> clickable card -> Authority
 * staged acknowledgement.
 */
export class PrivateOwnerDmApprovalStagerV1 implements CleanApprovalStagerV1 {
  private readonly now: () => string;
  private readonly sha256: (value: unknown) => Digest;
  private readonly resolveTarget: NonNullable<
    PrivateOwnerDmApprovalStagerV1Options["resolve_target"]
  >;

  constructor(private readonly options: PrivateOwnerDmApprovalStagerV1Options) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.sha256 = options.canonical_sha256 ?? (canonicalSha256 as (value: unknown) => Digest);
    this.resolveTarget =
      options.resolve_target ?? resolveGranolaMeetingOwnerPrivateApprovalTargetV1;
  }

  async reconcilePendingDeliveries(
    context?: { readonly signal: AbortSignal },
  ): Promise<void> {
    for (const frozen of this.options.authority.listPendingApprovalDeliveries()) {
      await this.stage(
        { admission: frozen.admission, candidate: frozen, meeting: frozen.meeting, decisions: frozen.decisions },
        context,
      );
    }
  }

  /**
   * Supersession uses the recovery-only assignment reader, never a current
   * authorization capability.  If the stored evidence is incomplete, it
   * remains a durable barrier instead of guessing a Slack channel.
   */
  async reconcileSuperseded(
    context?: { readonly signal: AbortSignal },
  ): Promise<void> {
    for (const obsolete of this.options.authority.listPendingSupersededApprovalCards()) {
      const recovery = this.options.assignments.readForPresentation(
        obsolete.approval_id,
      );
      if (
        recovery === undefined ||
        recovery.source_outbox_state !== "superseded" ||
        obsolete.provider_message_ts === null ||
        recovery.provider_message_ts !== obsolete.provider_message_ts
      ) {
        // An unknown post response cannot be reconciled without the stored DM
        // proof. `readForPresentation` deliberately exposes that proof only
        // after Authority has a canonical provider timestamp, so this remains
        // visibly pending and is never redirected to a shared channel.
        continue;
      }
      const rendered = await this.options.poster.tombstone(
        {
          approval_id: obsolete.approval_id,
          successor_id: obsolete.superseded_by_candidate_id,
          dm_channel_id: recovery.assignment.dm_channel.channel_id,
          provider_message_ts: recovery.provider_message_ts,
        },
        context?.signal,
      );
      if (rendered.kind === "done") {
        this.options.authority.recordSupersededApprovalCardTombstoned({
          approval_id: obsolete.approval_id,
          provider_message_ts: recovery.provider_message_ts,
        });
      }
    }
  }

  async stage(
    input: CleanApprovalStageInputV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<
    | { readonly kind: "staged"; readonly stage_id: string }
    | { readonly kind: "delivery_pending" }
    | { readonly kind: "revoked" }
    | { readonly kind: "state_drift" }
  > {
    let outbox = this.options.authority.readCandidateByApprovalId(input.candidate.approval_id);
    if (outbox === undefined || outbox.candidate_id !== input.candidate.candidate_id) {
      return { kind: "state_drift" };
    }
    if (outbox.state === "superseded") return { kind: "state_drift" };

    // This read-only proof has no external side effect. Resolve it before
    // freezing a post attempt so a missing/deactivated owner cannot leave an
    // avoidable `posting` recovery delay in the Authority outbox.
    const target = this.resolveTarget({
      meeting: input.meeting,
      authority_database: this.options.authority_database,
      control_plane_database: this.options.control_plane_database,
      coordinates: this.options.coordinates,
      connection_id: this.options.connection_id,
    });
    if (target === undefined) return { kind: "state_drift" };
    const frozen = buildCardAndSnapshot(input, this.sha256);
    const prepared = this.options.authority.prepareApprovalPost({
      candidate_id: outbox.candidate_id,
      frozen_card_sha256: frozen.frozen_card_sha256,
      approved_snapshot: frozen.approved_snapshot,
    });
    outbox = prepared.outbox;
    if (outbox.state === "superseded") return { kind: "state_drift" };

    const surface = buildPrivateApprovalSurfaceBindingV1(
      {
        authority_id: this.options.coordinates.authority_id,
        organization_id: this.options.coordinates.organization_id,
        state_lineage_id: this.options.coordinates.state_lineage_id,
        connection_id: target.slack_target.connection.body.connection_id,
        connection_contract_sha256: target.slack_target.connection.sha256,
        connection_state_sha256: target.slack_target.connection_state.sha256,
        provider_app_id: target.slack_target.connection.body.provider_app_id,
        provider_bot_id: target.slack_target.connection.body.provider_bot_id,
        provider_bot_user_id: target.slack_target.connection.body.provider_bot_user_id,
        slack_workspace_id: target.slack_target.connection.body.provider_tenant_id,
        slack_enterprise_id: target.slack_target.connection.body.provider_enterprise_id,
        adapter_id: "slack-block-actions",
        adapter_version: "v1",
        interaction_path: "/v2/integrations/slack/interactions",
        card_schema_version: 1,
        action_namespace: "echo-private-approval-v1",
        supported_policy_ids: [
          "restricted-reviewer-person-v2",
          "organization-member-readable-person-v2",
        ],
      },
      { sha256: this.sha256 },
    );
    const commitment = candidateCommitment(outbox, frozen);
    let assignment = this.options.assignments.readCurrent(commitment);
    if (assignment === undefined) {
      const dm = await this.options.poster.openDirectMessage(
        target.slack_target.current_slack_identity_link.provider_subject_id,
        context?.signal,
      );
      // Slack's response is a proof only when it names exactly the verified
      // subject. Anything else is a hard delivery refusal.
      if (dm.user_id !== target.slack_target.current_slack_identity_link.provider_subject_id) {
        return { kind: "state_drift" };
      }
      const staged = this.options.assignments.stage({
        candidate: commitment,
        owner_target: target,
        approval_binding: {
          approval_binding_id: surface.body.approval_surface_binding_id,
          approval_binding_contract_sha256: surface.sha256,
        },
        dm_channel: {
          workspace_id: target.slack_target.connection.body.provider_tenant_id,
          enterprise_id: target.slack_target.connection.body.provider_enterprise_id,
          channel_id: dm.channel_id,
        },
      });
      assignment = staged.assignment;
    }
    if (!assignmentMatchesCurrentTarget(assignment, target, surface)) {
      return { kind: "state_drift" };
    }

    if (outbox.post_started_at === null) return { kind: "state_drift" };
    if (outbox.provider_message_ts === null) {
      const outcome = prepared.created
        ? await this.options.poster.postMarker(
            { approval_id: outbox.approval_id, dm_channel_id: assignment.dm_channel.channel_id },
            context?.signal,
          )
        : await this.options.poster.reconcileMarker(
            {
              approval_id: outbox.approval_id,
              dm_channel_id: assignment.dm_channel.channel_id,
              post_started_at: outbox.post_started_at,
              reconciliation_started_at: this.now(),
            },
            context?.signal,
          );
      if (outcome.kind === "uncertain") return { kind: "delivery_pending" };
      if (outcome.kind === "retry_allowed") {
        this.options.authority.releaseApprovalPostAttempt({
          candidate_id: outbox.candidate_id,
          post_started_at: outbox.post_started_at,
        });
        return { kind: "delivery_pending" };
      }
      outbox = this.options.authority.recordPostedApprovalCard({
        candidate_id: outbox.candidate_id,
        post_started_at: outbox.post_started_at,
        provider_message_ts: outcome.provider_message_ts,
        frozen_card_sha256: frozen.frozen_card_sha256,
        approved_snapshot: frozen.approved_snapshot,
      });
    }
    if (outbox.state === "superseded") {
      await this.tombstoneKnown(outbox, assignment, context);
      return { kind: "state_drift" };
    }
    if (outbox.provider_message_ts === null || outbox.frozen_card_sha256 === null || outbox.approved_snapshot_sha256 === null) {
      return { kind: "state_drift" };
    }

    const pending: PendingPrivateApprovalV1 = Object.freeze({
      schema_version: 1,
      kind: "echo-private-approval-pending-v1",
      approval_id: outbox.approval_id,
      organization_id: assignment.organization_id,
      candidate_sha256: commitment.candidate_sha256,
      frozen_card_sha256: outbox.frozen_card_sha256 as Digest,
      approved_snapshot_sha256: outbox.approved_snapshot_sha256 as Digest,
      canonical_record_policy_id: null,
      assignment: assignment.assignment,
    });
    const cardBinding: PrivateApprovalSlackCardBindingV1 = Object.freeze({
      schema_version: 1,
      kind: "echo-private-approval-slack-card-binding-v1",
      approval_id: outbox.approval_id,
      assignment_version: assignment.assignment.assignment_version,
      connection_id: assignment.connection_id,
      connection_contract_sha256: assignment.connection_contract_sha256,
      connection_state_sha256: assignment.connection_state_sha256,
      approval_surface_binding_id: assignment.approval_binding.approval_binding_id,
      approval_surface_binding_contract_sha256: assignment.approval_binding.approval_binding_contract_sha256,
      slack_workspace_id: assignment.dm_channel.workspace_id,
      slack_enterprise_id: assignment.dm_channel.enterprise_id,
      slack_subject_id: assignment.assignment.current_slack_identity_link.provider_subject_id,
      dm_channel_id: assignment.dm_channel.channel_id,
      provider_message_ts: outbox.provider_message_ts,
      card_sha256: outbox.frozen_card_sha256 as Digest,
    });
    const staged = this.options.control_plane.stage({
      stage_command_id: outbox.stage_command_id,
      authority_id: this.options.coordinates.authority_id,
      candidate_id: outbox.candidate_id,
      approval_surface_binding: surface,
      pending,
      card_binding: cardBinding,
    });

    const refreshed = this.options.authority.readCandidateByApprovalId(outbox.approval_id);
    if (refreshed === undefined || refreshed.candidate_id !== outbox.candidate_id) return { kind: "state_drift" };
    if (refreshed.state === "superseded") {
      await this.tombstoneKnown(refreshed, assignment, context);
      return { kind: "state_drift" };
    }
    const published = await this.options.poster.publish(
      {
        approval_id: refreshed.approval_id,
        dm_channel_id: assignment.dm_channel.channel_id,
        provider_message_ts: refreshed.provider_message_ts ?? outbox.provider_message_ts,
        card: frozen.card,
      },
      context?.signal,
    );
    if (published.kind === "uncertain") return { kind: "delivery_pending" };
    const durable = this.options.authority.markControlPlaneStaged({
      candidate_id: refreshed.candidate_id,
      control_approval_sha256: staged.pending_sha256,
    });
    if (durable.state === "superseded") {
      await this.tombstoneKnown(durable, assignment, context);
      return { kind: "state_drift" };
    }
    return { kind: "staged", stage_id: durable.approval_id };
  }

  private async tombstoneKnown(
    outbox: CleanLiveApprovalOutboxV1,
    assignment: PrivateApprovalAssignmentStateV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<void> {
    if (outbox.provider_message_ts === null || outbox.superseded_by_candidate_id === null) return;
    const result = await this.options.poster.tombstone(
      {
        approval_id: outbox.approval_id,
        successor_id: outbox.superseded_by_candidate_id,
        dm_channel_id: assignment.dm_channel.channel_id,
        provider_message_ts: outbox.provider_message_ts,
      },
      context?.signal,
    );
    if (result.kind === "done") {
      this.options.authority.recordSupersededApprovalCardTombstoned({
        approval_id: outbox.approval_id,
        provider_message_ts: outbox.provider_message_ts,
      });
    }
  }
}
