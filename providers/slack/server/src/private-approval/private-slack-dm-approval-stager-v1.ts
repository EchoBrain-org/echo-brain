/**
 * Private Slack DM delivery for admitted meeting-processing candidates.
 *
 * The legacy reaction stager deliberately has no part in this path.  In
 * particular, a candidate's extraction-time `review_policy_*` fields remain
 * provenance only: this stager writes a null canonical policy and makes the
 * owner select a policy at the approve click.
 */
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { type ApprovalContractSha256 } from "../organization-control-plane/slack-approval-integration-v1.js";
import { type PendingPrivateApprovalV1 } from "../organization-control-plane/application/slack/private-approval-policy-resolution-v1.js";
import { type PendingPrivateApprovalV2 } from "../organization-control-plane/application/slack/private-approval-policy-resolution-v2.js";
import { type PrivateApprovalSlackCardBindingV1, type StagePrivateApprovalPendingV1, type StagedPrivateApprovalPendingV1 } from "../organization-control-plane/persistence/sqlite-slack-dm-approval-persistence-v1.js";
import { type SlackDmApprovalReviewerTargetCoordinatesV1 } from "../organization-control-plane/persistence/sqlite-slack-dm-approval-reviewer-target-v1.js";
import type Database from "better-sqlite3";
import { buildPrivateSlackApprovalBlockKitCardV1, type PrivateSlackApprovalActionItemV1, type PrivateSlackApprovalDecisionGroupV1, type PrivateSlackApprovalReviewItemV1 } from "./private-slack-approval-block-kit-card-v1.js";
import {
  buildPrivateSlackApprovalBlockKitCardV2,
  buildPrivateSlackApprovalBlockKitCardV3,
  canonicalPrivateSlackApprovalOwnerV3,
  PRIVATE_SLACK_APPROVAL_OWNER_PROPOSALS_MAX_V3,
  type PrivateSlackApprovalBlockKitCardV2,
  type PrivateSlackApprovalBlockKitCardV3,
  type PrivateSlackApprovalEligibleProjectV2,
  type PrivateSlackApprovalOwnerProposalV3,
} from "./private-slack-approval-block-kit-card-v2.js";
import type { PrivateApprovalTranscriptSourceV1 } from "@echo-brain/organization-control-plane/application/private-approval-policy-resolution-core-v2";
import { type PrivateSlackApprovalReviewerTargetResolverInputV1, type PrivateSlackApprovalReviewerTargetResolverV1, type PrivateSlackApprovalReviewerTargetV1 } from "./resolve-private-slack-approval-reviewer-target-v1.js";
import { SqlitePrivateSlackApprovalAssignmentStateV1, type PrivateApprovalAssignmentStateV1 } from "./sqlite-private-slack-approval-assignment-state-v1.js";
import { listPrivateSlackApprovalEligibleProjectsV2 } from "./private-slack-approval-project-eligibility-v2.js";
import { compileDecisionBrief } from "@echo-brain/organization-processing/core/processing/brief";
import {
  meetingSourceEnvelopeV1,
  sourceContentSha256V1,
} from "@echo-brain/organization-processing/core";
import { PrivateSlackApprovalCardPosterV1, type PrivateSlackApprovalCardPresentationV1 } from "../processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.js";
import {
  APPROVAL_DELIVERY_QUARANTINE_REASON_V1,
  type ApprovalWorkflowStageInputV1,
  type ApprovalWorkflowStageResultV1,
  type ApprovalWorkflowStagerV1,
} from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1";
import type { ApprovalWorkflowOutboxV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/approval-workflow-state-v1";
import { ApprovalWorkflowStateV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/approval-workflow-state-v1";
import type { MeetingApprovalJourneyTelemetryPortV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1";

type Digest = ApprovalContractSha256;
type CompiledDecisionBrief = ReturnType<typeof compileDecisionBrief>;
type ReviewSignal =
  | CompiledDecisionBrief["decisions"][number]
  | CompiledDecisionBrief["actions"][number]
  | CompiledDecisionBrief["rationales"][number];

export interface PrivateSlackDmApprovalStagerV1Options {
  readonly authority: ApprovalWorkflowStateV1;
  readonly authority_database: Database.Database;
  readonly control_plane_database: Database.Database;
  readonly coordinates: SlackDmApprovalReviewerTargetCoordinatesV1;
  readonly connection_id: string;
  readonly assignments: SqlitePrivateSlackApprovalAssignmentStateV1;
  readonly control_plane: {
    stage(input: StagePrivateApprovalPendingV1): StagedPrivateApprovalPendingV1;
    stageV2?(input: {
      readonly stage_command_id: string;
      readonly authority_id: string;
      readonly candidate_id: string;
      readonly pending: PendingPrivateApprovalV2;
      readonly card_binding: PrivateApprovalSlackCardBindingV1;
    }): { readonly pending_sha256: Digest };
  };
  readonly poster: Pick<
    PrivateSlackApprovalCardPosterV1,
    "openDirectMessage" | "postMarker" | "reconcileMarker" | "publish" | "tombstone"
  >;
  /** Kept injected so deterministic tests need no global clock. */
  readonly now?: () => string;
  /** Provider-specific reviewer observation plus generic current-identity proof. */
  readonly resolve_reviewer_target: PrivateSlackApprovalReviewerTargetResolverV1;
  /** This is a protocol boundary, not a card-specific hash implementation. */
  readonly canonical_sha256?: (value: unknown) => Digest;
  /** Optional, fail-open staging journey observation. */
  readonly journey_telemetry?: MeetingApprovalJourneyTelemetryPortV1;
}

interface PrivateCardAndSnapshotV1 {
  readonly card: PrivateSlackApprovalCardPresentationV1 & {
    readonly approval_id: string;
  };
  readonly frozen_card_sha256: Digest;
  readonly approved_snapshot: Readonly<Record<string, unknown>>;
  readonly approved_snapshot_sha256: Digest;
}

interface PrivateCardAndSnapshotV2 {
  readonly card: PrivateSlackApprovalBlockKitCardV2 | PrivateSlackApprovalBlockKitCardV3;
  readonly frozen_card_sha256: Digest;
  readonly approved_snapshot: Readonly<Record<string, unknown>>;
  readonly approved_snapshot_sha256: Digest;
  readonly eligible_projects: readonly PrivateSlackApprovalEligibleProjectV2[];
  readonly transcript_source: PrivateApprovalTranscriptSourceV1;
}

/**
 * Read-only input for replaying the frozen Slack review projection.  This is
 * intentionally narrower than staging: it has no reviewer, connection, or
 * persistence authority.
 */
export interface PrivateSlackApprovalCardProjectionInputV1 {
  readonly approval_id: string;
  readonly meeting: ApprovalWorkflowStageInputV1["meeting"];
  readonly decisions: ApprovalWorkflowStageInputV1["decisions"];
}

const MAX_TITLE = 150;

function legacyMeetingTitle(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()
      : "";
  const selected = normalized.length === 0 ? "Meeting approval" : normalized;
  return selected.slice(0, MAX_TITLE).trim();
}

function isExactDisplayText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u0008\u000B-\u001F\u007F]/.test(value)
  );
}

function evidenceReferenceText(
  signal: ReviewSignal,
): string | undefined {
  const evidence = signal.evidence[0];
  if (evidence === undefined || !isExactDisplayText(evidence.block_id)) {
    return undefined;
  }
  return `Transcript block ${evidence.block_id}`;
}

function reviewItem(
  signal: ReviewSignal,
): PrivateSlackApprovalReviewItemV1 | undefined {
  const evidence_reference = evidenceReferenceText(signal);
  if (!isExactDisplayText(signal.text) || evidence_reference === undefined) {
    return undefined;
  }
  return Object.freeze({ text: signal.text, evidence_reference });
}

function frozenReview(
  brief: CompiledDecisionBrief,
): {
  readonly decision_groups: readonly PrivateSlackApprovalDecisionGroupV1[];
  readonly ungrouped_actions?: readonly PrivateSlackApprovalActionItemV1[];
  readonly ungrouped_rationales?: readonly PrivateSlackApprovalReviewItemV1[];
} | undefined {
  const decisionIds = new Set(brief.decisions.map((decision) => decision.id));
  const decision_groups: PrivateSlackApprovalDecisionGroupV1[] = [];

  for (const [index, decision] of brief.decisions.entries()) {
    const item = reviewItem(decision);
    if (item === undefined) return undefined;
    const rationales: PrivateSlackApprovalReviewItemV1[] = [];
    for (const rationale of brief.rationales) {
      if (!rationale.supports_signal_ids.includes(decision.id)) continue;
      const rationaleItem = reviewItem(rationale);
      if (rationaleItem === undefined) return undefined;
      rationales.push(rationaleItem);
    }
    decision_groups.push(Object.freeze({
      id: `decision-group-${index + 1}`,
      decision: Object.freeze({ ...item, status: decision.status }),
      rationales: Object.freeze(rationales),
    }));
  }

  const ungrouped_actions: PrivateSlackApprovalActionItemV1[] = [];
  for (const action of brief.actions) {
    const item = reviewItem(action);
    if (item === undefined) return undefined;
    ungrouped_actions.push(item);
  }

  const ungrouped_rationales: PrivateSlackApprovalReviewItemV1[] = [];
  for (const rationale of brief.rationales) {
    if (rationale.supports_signal_ids.some((id) => decisionIds.has(id))) continue;
    const item = reviewItem(rationale);
    if (item === undefined) return undefined;
    ungrouped_rationales.push(item);
  }

  return Object.freeze({
    decision_groups: Object.freeze(decision_groups),
    ...(ungrouped_actions.length === 0
      ? {}
      : { ungrouped_actions: Object.freeze(ungrouped_actions) }),
    ...(ungrouped_rationales.length === 0
      ? {}
      : { ungrouped_rationales: Object.freeze(ungrouped_rationales) }),
  });
}

/**
 * The brief an approval commits to. Extraction may propose action owners, but
 * a proposal is never approved content: only an owner the approver confirms
 * in the signed action is recorded (ADR-0021). Briefs with no proposals are
 * returned unchanged, so their snapshots keep their exact bytes.
 */
function withoutProposedOwners(brief: CompiledDecisionBrief): CompiledDecisionBrief {
  if (brief.actions.every((action) => action.owner === null)) return brief;
  return Object.freeze({
    ...brief,
    actions: Object.freeze(brief.actions.map((action) => action.owner === null ? action : Object.freeze({ ...action, owner: null }))),
  });
}

/** The actions whose owner extraction proposed, as a V3 card offers them. */
function ownerProposals(brief: CompiledDecisionBrief): readonly PrivateSlackApprovalOwnerProposalV3[] {
  const proposals: PrivateSlackApprovalOwnerProposalV3[] = [];
  for (const [action_index, action] of brief.actions.entries()) {
    if (action.owner === null || !isExactDisplayText(action.text)) continue;
    let owner: string | null;
    try { owner = canonicalPrivateSlackApprovalOwnerV3(action.owner); } catch { owner = null; }
    if (owner !== null) proposals.push(Object.freeze({ action_index, action_text: action.text, owner }));
  }
  return Object.freeze(proposals);
}

function isCardLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("private approval Block Kit card ");
}

/**
 * Projects the same complete approval card used by staging without performing
 * any I/O. `undefined` means the exact DecisionSet cannot be safely rendered
 * within the card's frozen limits.
 */
export function projectPrivateSlackApprovalCardV1(
  input: PrivateSlackApprovalCardProjectionInputV1,
): ReturnType<typeof buildPrivateSlackApprovalBlockKitCardV1> | undefined {
  const brief = compileDecisionBrief(
    "brf_replay",
    input.meeting,
    input.decisions,
  );
  return projectCompiledCardV1(input.approval_id, input.meeting.title, brief);
}

function projectCompiledCardV1(
  approvalId: string,
  meetingTitle: unknown,
  brief: CompiledDecisionBrief,
): ReturnType<typeof buildPrivateSlackApprovalBlockKitCardV1> | undefined {
  const review = frozenReview(brief);
  if (review === undefined) return undefined;
  try {
    return buildPrivateSlackApprovalBlockKitCardV1({
      schema_version: 1,
      approval_id: approvalId,
      meeting_title: legacyMeetingTitle(meetingTitle),
      ...review,
    });
  } catch (error) {
    if (isCardLimitError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Shared approved bytes; each card version adds its own presentation commitment. */
function buildApprovalSnapshot(
  input: ApprovalWorkflowStageInputV1,
  sha256: (value: unknown) => Digest,
) {
  const brief = compileDecisionBrief(
    `brf_${input.candidate.candidate_semantic_sha256.slice("sha256:".length)}`,
    input.meeting,
    input.decisions,
  );
  const payload = Object.freeze({
    brief: withoutProposedOwners(brief),
    source: Object.freeze({
      // The immutable meeting envelope is the provenance authority, even
      // when its source differs from the current admission context.
      adapter_id: input.meeting.provenance.source.adapter_id,
      instance_id: input.meeting.provenance.source.instance_id,
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
  return { brief, approved_snapshot };
}

function buildCardAndSnapshot(
  input: ApprovalWorkflowStageInputV1,
  sha256: (value: unknown) => Digest,
): PrivateCardAndSnapshotV1 | undefined {
  const { brief, approved_snapshot } = buildApprovalSnapshot(input, sha256);
  // The active controls must follow a complete projection of the exact brief
  // they authorize. An unrepresentable candidate is durably quarantined before
  // any post attempt instead of truncating an informed-consent view.
  const card = projectCompiledCardV1(input.candidate.approval_id, input.meeting.title, brief);
  if (card === undefined) return undefined;
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

/**
 * V2 freezes the choices displayed to the reviewer and the exact retained
 * source revision into the pre-post card commitment.  The source hash comes
 * from Authority's revision manifest, never a meeting object reconstructed
 * by this delivery adapter.
 */
function buildCardAndSnapshotV2(
  input: ApprovalWorkflowStageInputV1,
  sha256: (value: unknown) => Digest,
  eligibility: readonly PrivateSlackApprovalEligibleProjectV2[],
  transcriptSource: PrivateApprovalTranscriptSourceV1,
): PrivateCardAndSnapshotV2 | undefined {
  const { brief, approved_snapshot } = buildApprovalSnapshot(input, sha256);
  const review = frozenReview(brief);
  if (review === undefined) return undefined;
  const base = {
    approval_id: input.candidate.approval_id,
    meeting_title: legacyMeetingTitle(input.meeting.title),
    eligible_projects: eligibility,
    ...review,
  };
  // A card that cannot fit an owner field per proposal falls back to the V2
  // card: those proposals are simply not offered, so nothing is recorded.
  const proposals = ownerProposals(brief);
  let card: PrivateSlackApprovalBlockKitCardV2 | PrivateSlackApprovalBlockKitCardV3 | undefined;
  if (proposals.length > 0 && proposals.length <= PRIVATE_SLACK_APPROVAL_OWNER_PROPOSALS_MAX_V3) {
    try {
      card = buildPrivateSlackApprovalBlockKitCardV3({ schema_version: 3, ...base, owner_proposals: proposals });
    } catch (error) {
      if (!isCardLimitError(error)) throw error;
    }
  }
  if (card === undefined) {
    try {
      card = buildPrivateSlackApprovalBlockKitCardV2({ schema_version: 2, ...base });
    } catch (error) {
      // V1 review errors raised inside the V2 build are the same card limit.
      if (isCardLimitError(error)) return undefined;
      throw error;
    }
  }
  const approved_snapshot_sha256 = sha256(approved_snapshot);
  const frozen_card_sha256 = sha256({
    schema_version: card.schema_version,
    kind: card.schema_version === 3 ? "echo-private-owner-dm-approval-card-v3" : "echo-private-owner-dm-approval-card-v2",
    card,
    eligible_projects: eligibility,
    transcript_source: transcriptSource,
    approved_snapshot_sha256,
  });
  return Object.freeze({
    card,
    frozen_card_sha256,
    approved_snapshot,
    approved_snapshot_sha256,
    eligible_projects: Object.freeze([...eligibility]),
    transcript_source: Object.freeze({ ...transcriptSource }),
  });
}

function retainedTranscriptSourceV2(
  database: Database.Database,
  organizationId: string,
  meeting: ApprovalWorkflowStageInputV1["meeting"],
): PrivateApprovalTranscriptSourceV1 | undefined {
  const source = meetingSourceEnvelopeV1(meeting);
  const row = database.prepare(`SELECT revision_sha256
    FROM authority_source_revisions_v1
    WHERE organization_id=? AND source_id=? AND revision_id=?`).get(
    organizationId,
    source.item.source_id,
    source.revision.revision_id,
  ) as { readonly revision_sha256?: unknown } | undefined;
  if (
    row === undefined ||
    typeof row.revision_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.revision_sha256) ||
    row.revision_sha256 !== sourceContentSha256V1(
      (({ captured_at: _capturedAt, ...immutable }) => immutable)(source.revision),
    )
  ) return undefined;
  return Object.freeze({
    source_id: source.item.source_id,
    revision_id: source.revision.revision_id,
    source_sha256: `sha256:${row.revision_sha256}` as Digest,
  });
}

function candidateCommitment(
  outbox: ApprovalWorkflowOutboxV1,
  card: Pick<PrivateCardAndSnapshotV1 | PrivateCardAndSnapshotV2, "frozen_card_sha256" | "approved_snapshot_sha256">,
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
  target: PrivateSlackApprovalReviewerTargetV1,
): boolean {
  const link = target.slack_target.current_slack_identity_link;
  return (
    assignment.organization_id === target.slack_target.connection.body.organization_id &&
    assignment.connection_id === target.slack_target.connection.body.connection_id &&
    assignment.connection_contract_sha256 === target.slack_target.connection.sha256 &&
    assignment.connection_state_sha256 === target.slack_target.connection_state.sha256 &&
    assignment.assigned_owner.principal_id === target.reviewer.principal_id &&
    assignment.assigned_owner.membership_id === target.reviewer.membership_id &&
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
export class PrivateSlackDmApprovalStagerV1 implements ApprovalWorkflowStagerV1 {
  private readonly now: () => string;
  private readonly sha256: (value: unknown) => Digest;
  private readonly resolveReviewerTarget: PrivateSlackApprovalReviewerTargetResolverV1;

  constructor(private readonly options: PrivateSlackDmApprovalStagerV1Options) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.sha256 = options.canonical_sha256 ?? (canonicalSha256 as (value: unknown) => Digest);
    this.resolveReviewerTarget = options.resolve_reviewer_target;
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
    input: ApprovalWorkflowStageInputV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<ApprovalWorkflowStageResultV1> {
    const attempt = this.beginApprovalStaging(input.candidate.approval_id);
    try {
      const result = await this.stageInternal(input, context);
      this.closeApprovalStaging(attempt, input.candidate.approval_id, result);
      return result;
    } catch (error) {
      this.failApprovalStaging(attempt, error);
      throw error;
    }
  }

  private async stageInternal(
    input: ApprovalWorkflowStageInputV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<ApprovalWorkflowStageResultV1> {
    const existingQuarantine =
      this.options.authority.readApprovalDeliveryQuarantine(
        input.candidate.candidate_id,
      );
    if (existingQuarantine !== undefined) {
      return {
        kind: "quarantined",
        reason_code: existingQuarantine.reason_code,
      };
    }
    let outbox = this.options.authority.readCandidateByApprovalId(input.candidate.approval_id);
    if (outbox === undefined || outbox.candidate_id !== input.candidate.candidate_id) {
      return { kind: "state_drift" };
    }
    if (outbox.state === "superseded") return { kind: "state_drift" };

    const targetInput: PrivateSlackApprovalReviewerTargetResolverInputV1 = {
      meeting: input.meeting,
      authority_database: this.options.authority_database,
      control_plane_database: this.options.control_plane_database,
      coordinates: this.options.coordinates,
      connection_id: this.options.connection_id,
    } as const;
    let target: PrivateSlackApprovalReviewerTargetV1 | undefined;
    let pendingV2: PendingPrivateApprovalV2 | undefined;
    let frozen: PrivateCardAndSnapshotV1 | PrivateCardAndSnapshotV2;
    // Test V1 adapters lack this capability. The production assignment adapter
    // always has it, so every queued production candidate enters V2.
    const deliveryV2 = this.options.assignments as unknown as {
      readonly readDeliveryV2?: (approvalId: string) => PendingPrivateApprovalV2 | undefined;
      readonly freezeDeliveryV2?: (input: {
        readonly approval_id: string;
        readonly candidate_id: string;
        readonly candidate_sha256: Digest;
        readonly contract: PendingPrivateApprovalV2;
      }) => PendingPrivateApprovalV2;
    };
    const v2DeliverySupported =
      deliveryV2.readDeliveryV2 !== undefined ||
      deliveryV2.freezeDeliveryV2 !== undefined;
    const existingV2 = v2DeliverySupported
      ? deliveryV2.readDeliveryV2?.(outbox.approval_id)
      : undefined;
    if (existingV2 !== undefined || (v2DeliverySupported && outbox.state === "queued" && deliveryV2.freezeDeliveryV2 !== undefined)) {
      // This read-only proof precedes the only V2 delivery write. A missing
      // owner leaves the durable candidate queued without freezing a card.
      target = this.resolveReviewerTarget(targetInput);
      if (target === undefined) return { kind: "delivery_pending" };
      if (existingV2 !== undefined) {
        pendingV2 = existingV2;
      } else {
        const transcriptSource = retainedTranscriptSourceV2(
          this.options.authority_database,
          target.slack_target.connection.body.organization_id,
          input.meeting,
        );
        if (transcriptSource === undefined) return { kind: "state_drift" };
        const eligibility = listPrivateSlackApprovalEligibleProjectsV2({
          database: this.options.authority_database,
          organization_id: target.slack_target.connection.body.organization_id,
          reviewer: target.reviewer,
        });
        const initial = buildCardAndSnapshotV2(
          input,
          this.sha256,
          eligibility,
          transcriptSource,
        );
        if (initial === undefined) {
          const quarantine = this.options.authority.quarantineApprovalDelivery({
            candidate_id: outbox.candidate_id,
            reason_code: APPROVAL_DELIVERY_QUARANTINE_REASON_V1,
          });
          return { kind: "quarantined", reason_code: quarantine.reason_code };
        }
        if (deliveryV2.freezeDeliveryV2 === undefined) return { kind: "state_drift" };
        pendingV2 = deliveryV2.freezeDeliveryV2({
          approval_id: outbox.approval_id,
          candidate_id: outbox.candidate_id,
          candidate_sha256: outbox.candidate_semantic_sha256 as Digest,
          contract: Object.freeze({
            schema_version: 2,
            kind: "echo-private-approval-pending-v2",
            approval_id: outbox.approval_id,
            organization_id: target.slack_target.connection.body.organization_id,
            candidate_sha256: outbox.candidate_semantic_sha256 as Digest,
            frozen_card_sha256: initial.frozen_card_sha256,
            approved_snapshot_sha256: initial.approved_snapshot_sha256,
            assigned_owner: Object.freeze({
              principal_id: target.reviewer.principal_id,
              membership_id: target.reviewer.membership_id,
            }),
            assigned_owner_slack_identity_link:
              target.slack_target.current_slack_identity_link,
            eligible_projects: initial.eligible_projects,
            transcript_source: initial.transcript_source,
          }),
        });
      }
      // Reprove both fresh and resumed cards against the persisted contract.
      const rebuilt = buildCardAndSnapshotV2(
        input,
        this.sha256,
        pendingV2.eligible_projects,
        pendingV2.transcript_source,
      );
      if (
        rebuilt === undefined ||
        rebuilt.frozen_card_sha256 !== pendingV2.frozen_card_sha256 ||
        rebuilt.approved_snapshot_sha256 !== pendingV2.approved_snapshot_sha256
      ) return { kind: "state_drift" };
      frozen = rebuilt;
    } else {
      // Retain exact V1 delivery behavior for every pre-V2 pending outbox.
      const legacy = buildCardAndSnapshot(input, this.sha256);
      if (legacy === undefined) {
        const quarantine = this.options.authority.quarantineApprovalDelivery({
          candidate_id: outbox.candidate_id,
          reason_code: APPROVAL_DELIVERY_QUARANTINE_REASON_V1,
        });
        return { kind: "quarantined", reason_code: quarantine.reason_code };
      }
      frozen = legacy;
      target = this.resolveReviewerTarget(targetInput);
      if (target === undefined) return { kind: "delivery_pending" };
    }
    // Both branches prove a current private target before any Slack side effect.
    if (target === undefined) return { kind: "delivery_pending" };
    if (
      pendingV2 !== undefined && (
        pendingV2.assigned_owner.principal_id !== target.reviewer.principal_id ||
        pendingV2.assigned_owner.membership_id !== target.reviewer.membership_id ||
        pendingV2.assigned_owner_slack_identity_link.external_identity_link_id !== target.slack_target.current_slack_identity_link.external_identity_link_id ||
        pendingV2.assigned_owner_slack_identity_link.external_identity_link_contract_sha256 !== target.slack_target.current_slack_identity_link.external_identity_link_contract_sha256 ||
        pendingV2.assigned_owner_slack_identity_link.provider_subject_id !== target.slack_target.current_slack_identity_link.provider_subject_id
      )
    ) return { kind: "state_drift" };
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
        reviewer_target: target,
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

    const pending: PendingPrivateApprovalV1 | PendingPrivateApprovalV2 = pendingV2 ?? Object.freeze({
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
    if (
      pending.schema_version === 2 && (
        pending.organization_id !== assignment.organization_id ||
        pending.approval_id !== outbox.approval_id ||
        pending.candidate_sha256 !== commitment.candidate_sha256 ||
        pending.frozen_card_sha256 !== outbox.frozen_card_sha256 ||
        pending.approved_snapshot_sha256 !== outbox.approved_snapshot_sha256 ||
        pending.assigned_owner.principal_id !== assignment.assigned_owner.principal_id ||
        pending.assigned_owner.membership_id !== assignment.assigned_owner.membership_id ||
        pending.assigned_owner_slack_identity_link.external_identity_link_id !== assignment.assigned_owner_slack_identity_link.external_identity_link_id ||
        pending.assigned_owner_slack_identity_link.external_identity_link_contract_sha256 !== assignment.assigned_owner_slack_identity_link.external_identity_link_contract_sha256 ||
        pending.assigned_owner_slack_identity_link.provider_subject_id !== assignment.assigned_owner_slack_identity_link.provider_subject_id
      )
    ) return { kind: "state_drift" };
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
    const staged = pending.schema_version === 1
      ? this.options.control_plane.stage({
          stage_command_id: outbox.stage_command_id,
          authority_id: this.options.coordinates.authority_id,
          candidate_id: outbox.candidate_id,
          pending,
          card_binding: cardBinding,
        })
      : (() => {
          if (this.options.control_plane.stageV2 === undefined) {
            throw new Error("private approval V2 staging persistence is not configured");
          }
          return this.options.control_plane.stageV2({
            stage_command_id: outbox.stage_command_id,
            authority_id: this.options.coordinates.authority_id,
            candidate_id: outbox.candidate_id,
            pending,
            card_binding: cardBinding,
          });
        })();

    const refreshed = this.options.authority.readCandidateByApprovalId(outbox.approval_id);
    if (refreshed === undefined || refreshed.candidate_id !== outbox.candidate_id) return { kind: "state_drift" };
    if (refreshed.state === "superseded") {
      await this.tombstoneKnown(refreshed, assignment, context);
      return { kind: "state_drift" };
    }
    const currentTarget = this.resolveReviewerTarget(targetInput);
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

  private beginApprovalStaging(approval_id: string) {
    try {
      return this.options.journey_telemetry?.beginStageForApproval(
        approval_id,
        "meeting_approval_staging",
      ) ?? null;
    } catch {
      return null;
    }
  }

  private closeApprovalStaging(
    attempt: ReturnType<MeetingApprovalJourneyTelemetryPortV1["beginStageForApproval"]>,
    approval_id: string,
    result: ApprovalWorkflowStageResultV1,
  ): void {
    try {
      switch (result.kind) {
        case "staged":
          // This durable timestamp begins the human wait. It must follow the
          // Authority acknowledgement, never merely successful Slack publish.
          this.options.journey_telemetry?.markCardStaged(approval_id);
          this.options.journey_telemetry?.succeedStage(attempt, { outcome: "staged" });
          return;
        case "delivery_pending":
          this.options.journey_telemetry?.succeedStage(attempt, { outcome: "delivery_pending" });
          return;
        case "quarantined":
          this.options.journey_telemetry?.succeedStage(attempt, { outcome: "quarantined" });
          return;
        case "state_drift":
          this.options.journey_telemetry?.failStage(
            attempt,
            new Error("approval staging state drift"),
            { failure_class: "invalid_contract", retryable: false },
          );
          return;
        case "revoked":
          this.options.journey_telemetry?.failStage(
            attempt,
            new Error("approval staging authorization revoked"),
            { failure_class: "authorization", retryable: false },
          );
          return;
      }
    } catch {
      // Observation is never permitted to alter approval delivery.
    }
  }

  private failApprovalStaging(
    attempt: ReturnType<MeetingApprovalJourneyTelemetryPortV1["beginStageForApproval"]>,
    error: unknown,
  ): void {
    try {
      this.options.journey_telemetry?.failStage(attempt, error);
    } catch {
      // Observation is never permitted to alter approval delivery.
    }
  }

  private async tombstoneKnown(
    outbox: ApprovalWorkflowOutboxV1,
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
