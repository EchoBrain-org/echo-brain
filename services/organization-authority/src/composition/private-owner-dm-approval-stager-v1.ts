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
  type PrivateApprovalTargetResolverInputV1,
  type PrivateApprovalTargetResolverV1,
  type PrivateApprovalTargetV1,
} from "./resolve-private-approval-target-v1.js";
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
  /** Provider-specific owner observation plus generic current-identity proof. */
  readonly resolve_target: PrivateApprovalTargetResolverV1;
  /** This is a protocol boundary, not a card-specific hash implementation. */
  readonly canonical_sha256?: (value: unknown) => Digest;
}

interface PrivateCardAndSnapshotV1 {
  readonly card: PrivateSlackApprovalCardPresentationV1 & {
    readonly approval_id: string;
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

function completeSignalText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u0008\u000B-\u001F\u007F]/.test(value)
  ) {
    throw new Error(`private approval ${label} is not exact displayable text`);
  }
  return value;
}

function frozenApprovalContext(
  brief: ReturnType<typeof compileDecisionBrief>,
): string {
  const signalLines = [
    ...brief.decisions.map(
      (signal) =>
        `Decision (${signal.status}): ${completeSignalText(signal.text, "decision")}`,
    ),
    ...brief.actions.map(
      (signal) =>
        `Action (owner: ${signal.owner === null ? "unassigned" : completeSignalText(signal.owner, "action owner")}; due: ${signal.due_at ?? "none"}): ${completeSignalText(signal.text, "action")}`,
    ),
    ...brief.rationales.map(
      (signal) =>
        `Rationale (supports: ${signal.supports_signal_ids.length === 0 ? "none" : signal.supports_signal_ids.map((id) => completeSignalText(id, "rationale support id")).join(", ")}): ${completeSignalText(signal.text, "rationale")}`,
    ),
  ];
  const context = [
    `Review ${brief.decisions.length} decision${brief.decisions.length === 1 ? "" : "s"}, ${brief.actions.length} action${brief.actions.length === 1 ? "" : "s"}, and ${brief.rationales.length} rationale${brief.rationales.length === 1 ? "" : "s"} from this meeting.`,
    "Frozen content:",
    ...signalLines,
  ].join("\n");
  if (context.length > MAX_CONTEXT) {
    throw new Error(
      "private approval complete frozen signal preview exceeds Slack's section limit",
    );
  }
  return context;
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
  // The active controls must follow a complete projection of the exact brief
  // they authorize. If Slack cannot show every frozen signal, fail before any
  // post attempt is prepared instead of truncating an informed-consent view.
  const approval_context = frozenApprovalContext(brief);
  const card = buildPrivateApprovalBlockKitCardV1({
    schema_version: 1,
    approval_id: input.candidate.approval_id,
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
  target: PrivateApprovalTargetV1,
): boolean {
  const link = target.slack_target.current_slack_identity_link;
  return (
    assignment.organization_id === target.slack_target.connection.body.organization_id &&
    assignment.connection_id === target.slack_target.connection.body.connection_id &&
    assignment.connection_contract_sha256 === target.slack_target.connection.sha256 &&
    assignment.connection_state_sha256 === target.slack_target.connection_state.sha256 &&
    assignment.assigned_owner.principal_id === target.assignee.principal_id &&
    assignment.assigned_owner.membership_id === target.assignee.membership_id &&
    assignment.assigned_owner_slack_identity_link.external_identity_link_id === link.external_identity_link_id &&
    assignment.assigned_owner_slack_identity_link.external_identity_link_contract_sha256 === link.external_identity_link_contract_sha256 &&
    assignment.assigned_owner_slack_identity_link.provider_subject_id === link.provider_subject_id &&
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
  private readonly resolveTarget: PrivateApprovalTargetResolverV1;

  constructor(private readonly options: PrivateOwnerDmApprovalStagerV1Options) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.sha256 = options.canonical_sha256 ?? (canonicalSha256 as (value: unknown) => Digest);
    this.resolveTarget = options.resolve_target;
  }

  async reconcilePendingDeliveries(
    context?: { readonly signal: AbortSignal },
  ): Promise<void> {
    await this.reconcileSuperseded(context);
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
        obsolete.presentation_external_id === null ||
        recovery.provider_message_ts !== obsolete.presentation_external_id
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
          presentation_external_id: recovery.provider_message_ts,
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
    const targetInput: PrivateApprovalTargetResolverInputV1 = {
      meeting: input.meeting,
      authority_database: this.options.authority_database,
      control_plane_database: this.options.control_plane_database,
      coordinates: this.options.coordinates,
      connection_id: this.options.connection_id,
    } as const;
    const target = this.resolveTarget(targetInput);
    if (target === undefined) return { kind: "state_drift" };
    const frozen = buildCardAndSnapshot(input, this.sha256);
    const prepared = this.options.authority.prepareApprovalPost({
      candidate_id: outbox.candidate_id,
      frozen_card_sha256: frozen.frozen_card_sha256,
      approved_snapshot: frozen.approved_snapshot,
    });
    outbox = prepared.outbox;
    if (outbox.state === "superseded") return { kind: "state_drift" };

    const commitment = candidateCommitment(outbox, frozen);
    let assignment = this.options.assignments.readCurrent(commitment);
    if (assignment === undefined) {
      const dm = await this.options.poster.openDirectMessage(
        target.slack_target.current_slack_identity_link.provider_subject_id,
        context?.signal,
      );
      if (dm.kind === "retry_allowed") return { kind: "delivery_pending" };
      // Slack's response is a proof only when it names exactly the verified
      // subject. Anything else is a hard delivery refusal.
      if (dm.user_id !== target.slack_target.current_slack_identity_link.provider_subject_id) {
        return { kind: "state_drift" };
      }
      const staged = this.options.assignments.stage({
        candidate: commitment,
        owner_target: target,
        dm_channel: {
          workspace_id: target.slack_target.connection.body.provider_tenant_id,
          enterprise_id: target.slack_target.connection.body.provider_enterprise_id,
          channel_id: dm.channel_id,
        },
      });
      assignment = staged.assignment;
    }
    if (!assignmentMatchesCurrentTarget(assignment, target)) {
      return { kind: "state_drift" };
    }

    if (outbox.post_started_at === null) return { kind: "state_drift" };
    if (outbox.presentation_external_id === null) {
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
        presentation_external_id: outcome.provider_message_ts,
        frozen_card_sha256: frozen.frozen_card_sha256,
        approved_snapshot: frozen.approved_snapshot,
      });
    }
    if (outbox.state === "superseded") {
      await this.tombstoneKnown(outbox, assignment, context);
      return { kind: "state_drift" };
    }
    if (outbox.presentation_external_id === null || outbox.frozen_card_sha256 === null || outbox.approved_snapshot_sha256 === null) {
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
      assigned_owner: assignment.assigned_owner,
      assigned_owner_slack_identity_link:
        assignment.assigned_owner_slack_identity_link,
    });
    const cardBinding: PrivateApprovalSlackCardBindingV1 = Object.freeze({
      schema_version: 1,
      kind: "echo-private-approval-slack-card-binding-v1",
      approval_id: outbox.approval_id,
      connection_id: assignment.connection_id,
      connection_contract_sha256: assignment.connection_contract_sha256,
      connection_state_sha256: assignment.connection_state_sha256,
      slack_workspace_id: assignment.dm_channel.workspace_id,
      slack_enterprise_id: assignment.dm_channel.enterprise_id,
      slack_subject_id:
        assignment.assigned_owner_slack_identity_link.provider_subject_id,
      dm_channel_id: assignment.dm_channel.channel_id,
      provider_message_ts: outbox.presentation_external_id,
      card_sha256: outbox.frozen_card_sha256 as Digest,
    });
    const staged = this.options.control_plane.stage({
      stage_command_id: outbox.stage_command_id,
      authority_id: this.options.coordinates.authority_id,
      candidate_id: outbox.candidate_id,
      pending,
      card_binding: cardBinding,
    });

    const refreshed = this.options.authority.readCandidateByApprovalId(outbox.approval_id);
    if (refreshed === undefined || refreshed.candidate_id !== outbox.candidate_id) return { kind: "state_drift" };
    if (refreshed.state === "superseded") {
      await this.tombstoneKnown(refreshed, assignment, context);
      return { kind: "state_drift" };
    }
    const currentTarget = this.resolveTarget(targetInput);
    if (
      currentTarget === undefined ||
      !assignmentMatchesCurrentTarget(assignment, currentTarget)
    ) {
      return { kind: "state_drift" };
    }
    const published = await this.options.poster.publish(
      {
        approval_id: refreshed.approval_id,
        dm_channel_id: assignment.dm_channel.channel_id,
        provider_message_ts:
          refreshed.presentation_external_id ?? outbox.presentation_external_id,
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
    if (outbox.presentation_external_id === null || outbox.superseded_by_candidate_id === null) return;
    const result = await this.options.poster.tombstone(
      {
        approval_id: outbox.approval_id,
        successor_id: outbox.superseded_by_candidate_id,
        dm_channel_id: assignment.dm_channel.channel_id,
        provider_message_ts: outbox.presentation_external_id,
      },
      context?.signal,
    );
    if (result.kind === "done") {
      this.options.authority.recordSupersededApprovalCardTombstoned({
        approval_id: outbox.approval_id,
        presentation_external_id: outbox.presentation_external_id,
      });
    }
  }
}
