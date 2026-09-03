import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { StagedPrivateApprovalPendingV1 } from "@echo-brain/organization-control-plane/slack-approval-integration-v1";
import { describe, expect, it, vi } from "vitest";
import {
  PrivateSlackDmApprovalStagerV1,
  projectPrivateSlackApprovalCardV1,
} from "../../../../../src/composition/providers/slack/private-approval/private-slack-dm-approval-stager-v1.js";
import type { ApprovalWorkflowStageInputV1 } from "../../../../../src/processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import type { SqliteAuthorityMeetingProcessingStateV1 } from "../../../../../src/processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";

const DIGEST = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
type Sha256 = `sha256:${string}`;
const NOW = "2026-08-28T00:00:00.000Z";

interface CapturedCard {
  readonly text: string;
  readonly blocks: readonly unknown[];
}

const input = {
  admission: {
    source: { adapter_id: "granola", instance_id: "granola-1", version: "1", cursor: "granola:v1:live:x", cutoff_at: NOW },
    processor: { adapter_id: "llm", instance_id: "llm-1", version: "1", configuration_sha256: DIGEST("a") },
  },
  candidate: {
    candidate_id: "cnd_1", candidate_semantic_sha256: DIGEST("b"), review_lineage_id: "rli_1", review_input_sha256: DIGEST("c"), review_semantic_sha256: DIGEST("d"),
    review_policy_id: "organization-member-readable-person-v2", review_policy_contract_sha256: DIGEST("e"), review_policy_consequence_text: "legacy policy must not be used", review_policy_consequence_sha256: DIGEST("f"),
    disposition: "actionable", approval_id: "apr_1", stage_command_id: "psc_1", state: "queued",
  },
  meeting: {
    id: "meeting-1", title: "Quarterly planning", participants: [{ id: "participant-1", display_name: "Meeting participant" }], content: [{ id: "transcript-1", kind: "transcript", text: "The decision was made.", speaker_participant_id: "participant-1" }], artifacts: [], capture: { state: "complete", components: [] },
    provenance: { external_id: "note-1", canonical_revision: "rev-1", source: { kind: "meeting-source", adapter_id: "granola", instance_id: "granola-1", version: "1" }, observed_at: NOW, normalizer_version: "1" }, extensions: {}, schema_version: 1,
  },
  decisions: { schema_version: 1, meeting_id: "meeting-1", meeting_revision: "rev-1", generated_at: NOW, processor: { kind: "decision-processor", adapter_id: "llm", instance_id: "llm-1", version: "1" }, signals: [] },
} as unknown as ApprovalWorkflowStageInputV1;

function outbox(state: "queued" | "posting" | "posted" | "staged" = "queued") {
  return {
    ...input.candidate,
    state,
    presentation_external_id: state === "queued" || state === "posting" ? null : "123.000001",
    frozen_card_sha256: state === "queued" ? null : DIGEST("1"),
    approved_snapshot_json: state === "queued" ? null : "{}",
    approved_snapshot_sha256: state === "queued" ? null : DIGEST("2"),
    post_started_at: state === "queued" ? null : NOW,
    control_approval_sha256: state === "staged" ? DIGEST("3") : null,
    superseded_by_candidate_id: null,
    superseded_at: null,
    tombstoned_at: null,
  };
}

function topLevelBlocksByType(
  card: CapturedCard,
  type: string,
): readonly Readonly<Record<string, unknown>>[] {
  return card.blocks.filter((block): block is Readonly<Record<string, unknown>> =>
    block !== null &&
    typeof block === "object" &&
    !Array.isArray(block) &&
    (block as Readonly<Record<string, unknown>>).type === type
  );
}

describe("private Slack DM approval stager V1", () => {
  it("binds null policy before publishing one verified-owner DM card", async () => {
    const operations: string[] = [];
    const journeyTelemetry = {
      beginStageForApproval: vi.fn(() => ({ journey_id: "journey-1", stage: "meeting_approval_staging", attempt: 1, started: { observed_at: NOW, monotonic_ms: 1 } })),
      markCardStaged: vi.fn(() => operations.push("journey-card-staged")),
      succeedStage: vi.fn((_: unknown, result: { outcome?: string }) => operations.push(`journey-${result.outcome}`)),
      failStage: vi.fn(),
    };
    const reviewedInput = {
      ...input,
      decisions: {
        ...input.decisions,
        signals: [
          {
            id: "decision-1", kind: "decision", text: "Keep the owner-only default.",
            subject: null, confidence: 0.9, evidence: [{ meeting_id: "meeting-1", block_id: "transcript-1", quote: "The decision was made." }], status: "decided",
          },
          {
            id: "decision-2", kind: "decision", text: "Keep the launch gated.",
            subject: null, confidence: 0.9, evidence: [{ meeting_id: "meeting-1", block_id: "transcript-1" }], status: "proposed",
          },
          {
            id: "action-1", kind: "action", text: "Rehearse the private Slack approval flow.",
            subject: null, confidence: 0.8, evidence: [{ meeting_id: "meeting-1", block_id: "transcript-1" }], owner: "Audrey", due_at: "2026-09-01T00:00:00.000Z",
          },
          {
            id: "rationale-1", kind: "rationale", text: "The owner must choose visibility before release.",
            subject: null, confidence: 0.7, evidence: [{ meeting_id: "meeting-1", block_id: "transcript-1" }], supports_signal_ids: ["decision-1"],
          },
          {
            id: "rationale-2", kind: "rationale", text: "The follow-up context was not linked to a decision.",
            subject: null, confidence: 0.7, evidence: [{ meeting_id: "meeting-1", block_id: "transcript-1" }], supports_signal_ids: [],
          },
          {
            id: "rationale-3", kind: "rationale", text: "The second decision still needs validation.",
            subject: null, confidence: 0.7, evidence: [{ meeting_id: "meeting-1", block_id: "transcript-1" }], supports_signal_ids: ["decision-2"],
          },
        ],
      },
    } as unknown as ApprovalWorkflowStageInputV1;
    let current = outbox();
    let preparedSnapshot: unknown;
    let publishedCard: {
      readonly text: string;
      readonly blocks: readonly unknown[];
    } | undefined;
    let assignment = {
      organization_id: "org_1",
      candidate: {},
      assigned_owner: { principal_id: "prn_1", membership_id: "mem_1" },
      assigned_owner_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_1", external_identity_link_contract_sha256: DIGEST("4"), provider_subject_id: "U01" },
      connection_id: "con_1", connection_contract_sha256: DIGEST("6"), connection_state_sha256: DIGEST("7"),
      dm_channel: { workspace_id: "T01", enterprise_id: null, channel_id: "D01" }, created_at: NOW,
    };
    let ownerLinked = false;
    const authority = {
      readApprovalDeliveryQuarantine: () => undefined,
      readCandidateByApprovalId: () => current,
      prepareApprovalPost: (received: { frozen_card_sha256: Sha256; approved_snapshot: unknown }) => {
        operations.push("freeze");
        preparedSnapshot = received.approved_snapshot;
        current = { ...outbox("posting"), frozen_card_sha256: received.frozen_card_sha256, approved_snapshot_sha256: canonicalSha256(received.approved_snapshot) as Sha256 };
        return { outbox: current, created: true };
      },
      recordPostedApprovalCard: (received: { frozen_card_sha256: Sha256; approved_snapshot: unknown; presentation_external_id: string }) => {
        operations.push("marker-durable");
        current = { ...current, state: "posted", presentation_external_id: received.presentation_external_id, frozen_card_sha256: received.frozen_card_sha256, approved_snapshot_sha256: canonicalSha256(received.approved_snapshot) as Sha256 };
        return current;
      },
      markControlPlaneStaged: ({ control_approval_sha256 }: { control_approval_sha256: Sha256 }) => {
        operations.push("authority-staged");
        current = { ...current, state: "staged", control_approval_sha256 };
        return current;
      },
      listPendingApprovalDeliveries: () => [],
      releaseApprovalPostAttempt: vi.fn(), recordSupersededApprovalCardTombstoned: vi.fn(),
    };
    const stage = vi.fn((received: { pending: object; card_binding: { dm_channel_id: string } }) => {
      operations.push("cp-pending");
      expect(received.card_binding.dm_channel_id).toBe("D01");
      return { pending_sha256: DIGEST("3") } as StagedPrivateApprovalPendingV1;
    });
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: authority as unknown as SqliteAuthorityMeetingProcessingStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: {
        readCurrent: () => undefined,
        stage: () => {
          operations.push("assignment");
          return { assignment, created: true };
        },
      } as never,
      control_plane: { stage },
      poster: {
        openDirectMessage: async (user: string) => { operations.push("open-dm"); expect(user).toBe("U01"); return { kind: "opened" as const, channel_id: "D01", user_id: "U01" }; },
        postMarker: async () => { operations.push("marker"); return { kind: "posted" as const, provider_message_ts: "123.000001" }; },
        reconcileMarker: vi.fn(),
        publish: async (received) => { operations.push("publish"); publishedCard = received.card; return { kind: "done" as const }; },
        tombstone: vi.fn(),
      },
      resolve_reviewer_target: () => ownerLinked ? ({
        reviewer: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" },
        slack_target: {
          connection: { body: { organization_id: "org_1", connection_id: "con_1", provider_app_id: "A01", provider_bot_id: "B01", provider_bot_user_id: "U02", provider_tenant_id: "T01", provider_enterprise_id: null }, sha256: DIGEST("6") },
          connection_state: { body: {}, sha256: DIGEST("7") },
          current_slack_identity_link: assignment.assigned_owner_slack_identity_link,
        },
      }) as never : undefined,
      canonical_sha256: canonicalSha256,
      now: () => NOW,
      journey_telemetry: journeyTelemetry as never,
    });

    await expect(stager.stage(reviewedInput)).resolves.toEqual({
      kind: "delivery_pending",
    });
    expect(operations).toEqual(["journey-delivery_pending"]);

    ownerLinked = true;
    await expect(stager.stage(reviewedInput)).resolves.toEqual({ kind: "staged", stage_id: "apr_1" });
    expect(operations).toEqual([
      "journey-delivery_pending", "freeze", "open-dm", "assignment", "marker", "marker-durable", "cp-pending", "publish", "authority-staged", "journey-card-staged", "journey-staged",
    ]);
    expect(journeyTelemetry.beginStageForApproval).toHaveBeenCalledTimes(2);
    expect(journeyTelemetry.beginStageForApproval).toHaveBeenNthCalledWith(
      1,
      "apr_1",
      "meeting_approval_staging",
    );
    expect(journeyTelemetry.markCardStaged).toHaveBeenCalledWith("apr_1");
    expect(stage).toHaveBeenCalledOnce();
    expect(JSON.stringify(preparedSnapshot)).toContain("Keep the owner-only default.");
    expect(preparedSnapshot).toMatchObject({
      schema_version: 2,
      kind: "echo-approved-decision-snapshot-v2",
      payload_contract_id: "organization-record-approval-payload-v1",
    });
    if (publishedCard === undefined) throw new Error("expected a published approval card");
    const actionsIndex = publishedCard.blocks.findIndex(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        (block as Readonly<Record<string, unknown>>).type === "actions",
    );
    expect(actionsIndex).toBeGreaterThan(0);
    const informedContent = JSON.stringify(publishedCard.blocks.slice(0, actionsIndex));
    const decisionGroups = topLevelBlocksByType(publishedCard, "container");
    expect(decisionGroups).toHaveLength(3);
    const decisionGroup = JSON.stringify(decisionGroups[0]);
    const secondDecisionGroup = JSON.stringify(decisionGroups[1]);
    const otherItems = JSON.stringify(decisionGroups[2]);
    expect(decisionGroup).toContain("1 · Keep the owner-only default.");
    expect(decisionGroup).toContain("*Decision*");
    expect(decisionGroup).toContain("Keep the owner-only default.");
    expect(decisionGroup).toContain('"subtitle":{"type":"mrkdwn","text":"1 why"');
    expect(decisionGroup).toContain("*Why*");
    expect(decisionGroup).toContain("The owner must choose visibility before release.");
    expect(decisionGroup).not.toContain("The second decision still needs validation.");
    expect(decisionGroup).not.toContain("The follow-up context was not linked to a decision.");
    expect(secondDecisionGroup).toContain("2 · Keep the launch gated.");
    expect(secondDecisionGroup).toContain("Keep the launch gated.");
    expect(secondDecisionGroup).toContain("The second decision still needs validation.");
    expect(secondDecisionGroup).not.toContain("The owner must choose visibility before release.");
    expect(otherItems).toContain("Next steps and context");
    expect(otherItems).toContain("*Next steps*");
    expect(otherItems).toContain("Rehearse the private Slack approval flow.");
    expect(otherItems).not.toContain("Due:");
    expect(otherItems).toContain("*Additional context*");
    expect(otherItems).toContain("The follow-up context was not linked to a decision.");
    expect(informedContent).not.toContain("Transcript block transcript-1");
    expect(informedContent).not.toContain("maker:");
    expect(informedContent).not.toContain("The decision was made.");
    expect(informedContent).not.toContain("owner: Audrey");
    expect(publishedCard.text).toContain("Keep the owner-only default.");
    expect(publishedCard.text).not.toContain("maker:");
    expect(publishedCard.text).not.toContain("Due:");
    expect(publishedCard.text).toContain("Transcript block transcript-1");
    expect(publishedCard.text).not.toContain("owner: Audrey");
    expect(publishedCard.text).toContain("The owner must choose visibility before release.");
    expect(publishedCard.text).toContain("The follow-up context was not linked to a decision.");
    expect(publishedCard.text).toContain("Raw transcript and rejected suggestions are not released.");
    expect(JSON.stringify(preparedSnapshot)).toContain(
      '"due_at":"2026-09-01T00:00:00.000Z"',
    );
    expect(JSON.stringify(publishedCard.blocks.slice(actionsIndex))).toContain("Approve");
    expect(
      projectPrivateSlackApprovalCardV1({
        approval_id: "apr_1",
        meeting: reviewedInput.meeting,
        decisions: reviewedInput.decisions,
      }),
    ).toEqual(publishedCard);
  });

  it("durably quarantines an approval package that cannot fit before provider I/O", async () => {
    const prepareApprovalPost = vi.fn();
    const openDirectMessage = vi.fn();
    const postMarker = vi.fn();
    const publish = vi.fn();
    const controlPlaneStage = vi.fn();
    const quarantineApprovalDelivery = vi.fn(() => ({
      candidate_id: input.candidate.candidate_id,
      reason_code: "approval_package_unrepresentable" as const,
      quarantined_at: NOW,
    }));
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: {
        readApprovalDeliveryQuarantine: () => undefined,
        readCandidateByApprovalId: () => outbox(),
        prepareApprovalPost,
        quarantineApprovalDelivery,
      } as unknown as SqliteAuthorityMeetingProcessingStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: { readCurrent: vi.fn(), stage: vi.fn() } as never,
      control_plane: { stage: controlPlaneStage },
      poster: {
        openDirectMessage, postMarker, reconcileMarker: vi.fn(), publish, tombstone: vi.fn(),
      },
      resolve_reviewer_target: () => ({
        reviewer: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" },
        slack_target: {
          connection: { body: { organization_id: "org_1", connection_id: "con_1", provider_app_id: "A01", provider_bot_id: "B01", provider_bot_user_id: "U02", provider_tenant_id: "T01", provider_enterprise_id: null }, sha256: DIGEST("6") },
          connection_state: { body: {}, sha256: DIGEST("7") },
          current_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_1", external_identity_link_contract_sha256: DIGEST("4"), provider_subject_id: "U01" },
        },
      }) as never,
      canonical_sha256: canonicalSha256,
    });

    for (const [id, text] of [
      ["decision-too-large", "x".repeat(3_000)],
      ["decision-with-control", "cannot\u0000display"],
    ] as const) {
      const unrepresentableInput = {
        ...input,
        decisions: {
          ...input.decisions,
          signals: [{
            id, kind: "decision", text,
            subject: null, confidence: null,
            evidence: [{ meeting_id: "meeting-1", block_id: "transcript-1" }],
            status: "decided",
          }],
        },
      } as unknown as ApprovalWorkflowStageInputV1;
      await expect(stager.stage(unrepresentableInput)).resolves.toEqual({
        kind: "quarantined",
        reason_code: "approval_package_unrepresentable",
      });
    }
    expect(quarantineApprovalDelivery).toHaveBeenCalledTimes(2);
    expect(quarantineApprovalDelivery).toHaveBeenLastCalledWith({
      candidate_id: input.candidate.candidate_id,
      reason_code: "approval_package_unrepresentable",
    });
    expect(prepareApprovalPost).not.toHaveBeenCalled();
    expect(openDirectMessage).not.toHaveBeenCalled();
    expect(postMarker).not.toHaveBeenCalled();
    expect(controlPlaneStage).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps target loss after CP staging as state drift before publishing the full card", async () => {
    let current = outbox();
    let ownerIsCurrent = true;
    const journeyTelemetry = {
      beginStageForApproval: vi.fn(() => ({ journey_id: "journey-1", stage: "meeting_approval_staging", attempt: 1, started: { observed_at: NOW, monotonic_ms: 1 } })),
      markCardStaged: vi.fn(),
      succeedStage: vi.fn(),
      failStage: vi.fn(),
    };
    const assignment = {
      organization_id: "org_1",
      candidate: {},
      assigned_owner: { principal_id: "prn_1", membership_id: "mem_1" },
      assigned_owner_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_1", external_identity_link_contract_sha256: DIGEST("4"), provider_subject_id: "U01" },
      connection_id: "con_1", connection_contract_sha256: DIGEST("6"), connection_state_sha256: DIGEST("7"),
      dm_channel: { workspace_id: "T01", enterprise_id: null, channel_id: "D01" }, created_at: NOW,
    };
    const target = {
      reviewer: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" },
      slack_target: {
        connection: { body: { organization_id: "org_1", connection_id: "con_1", provider_app_id: "A01", provider_bot_id: "B01", provider_bot_user_id: "U02", provider_tenant_id: "T01", provider_enterprise_id: null }, sha256: DIGEST("6") },
        connection_state: { body: {}, sha256: DIGEST("7") },
        current_slack_identity_link: assignment.assigned_owner_slack_identity_link,
      },
    };
    const publish = vi.fn(async () => ({ kind: "done" as const }));
    const markControlPlaneStaged = vi.fn(({ control_approval_sha256 }: { control_approval_sha256: Sha256 }) => {
      current = { ...current, state: "staged", control_approval_sha256 };
      return current;
    });
    const controlPlaneStage = vi.fn(() => {
      // Models membership or identity-link revocation after durable CP staging.
      ownerIsCurrent = false;
      return { pending_sha256: DIGEST("3") } as StagedPrivateApprovalPendingV1;
    });
    const resolveTarget = vi.fn(() => (ownerIsCurrent ? target : undefined) as never);
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: {
        readApprovalDeliveryQuarantine: () => undefined,
        readCandidateByApprovalId: () => current,
        prepareApprovalPost: (received: { frozen_card_sha256: Sha256; approved_snapshot: unknown }) => {
          current = { ...outbox("posting"), frozen_card_sha256: received.frozen_card_sha256, approved_snapshot_sha256: canonicalSha256(received.approved_snapshot) as Sha256 };
          return { outbox: current, created: true };
        },
        recordPostedApprovalCard: (received: { frozen_card_sha256: Sha256; approved_snapshot: unknown; presentation_external_id: string }) => {
          current = { ...current, state: "posted", presentation_external_id: received.presentation_external_id, frozen_card_sha256: received.frozen_card_sha256, approved_snapshot_sha256: canonicalSha256(received.approved_snapshot) as Sha256 };
          return current;
        },
        markControlPlaneStaged,
        releaseApprovalPostAttempt: vi.fn(), recordSupersededApprovalCardTombstoned: vi.fn(),
      } as unknown as SqliteAuthorityMeetingProcessingStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: { readCurrent: () => undefined, stage: () => ({ assignment, created: true }) } as never,
      control_plane: { stage: controlPlaneStage },
      poster: {
        openDirectMessage: async () => ({ kind: "opened" as const, channel_id: "D01", user_id: "U01" }),
        postMarker: async () => ({ kind: "posted" as const, provider_message_ts: "123.000001" }),
        reconcileMarker: vi.fn(), publish, tombstone: vi.fn(),
      },
      resolve_reviewer_target: resolveTarget,
      canonical_sha256: canonicalSha256,
      now: () => NOW,
      journey_telemetry: journeyTelemetry as never,
    });

    await expect(stager.stage(input)).resolves.toEqual({ kind: "state_drift" });
    expect(resolveTarget).toHaveBeenCalledTimes(2);
    expect(controlPlaneStage).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(markControlPlaneStaged).not.toHaveBeenCalled();
    expect(journeyTelemetry.failStage).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Error),
      { failure_class: "invalid_contract", retryable: false },
    );
  });

  it("keeps a queued candidate pending when owner proof is absent", async () => {
    const openDirectMessage = vi.fn();
    const prepareApprovalPost = vi.fn();
    const authority = {
      readApprovalDeliveryQuarantine: () => undefined,
      readCandidateByApprovalId: () => outbox(),
      prepareApprovalPost,
    };
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: authority as unknown as SqliteAuthorityMeetingProcessingStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: {} as never, control_plane: {} as never,
      poster: { openDirectMessage, postMarker: vi.fn(), reconcileMarker: vi.fn(), publish: vi.fn(), tombstone: vi.fn() },
      resolve_reviewer_target: () => undefined,
      canonical_sha256: canonicalSha256,
    });
    await expect(stager.stage(input)).resolves.toEqual({ kind: "delivery_pending" });
    expect(prepareApprovalPost).not.toHaveBeenCalled();
    expect(openDirectMessage).not.toHaveBeenCalled();
  });

  it("keeps a frozen delivery pending when Slack defers opening the DM", async () => {
    const assignmentStage = vi.fn();
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: {
        readApprovalDeliveryQuarantine: () => undefined,
        readCandidateByApprovalId: () => outbox(),
        prepareApprovalPost: () => ({ outbox: outbox("posting"), created: true }),
      } as unknown as SqliteAuthorityMeetingProcessingStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: { readCurrent: () => undefined, stage: assignmentStage } as never,
      control_plane: {} as never,
      poster: {
        openDirectMessage: async () => ({ kind: "retry_allowed" as const }),
        postMarker: vi.fn(), reconcileMarker: vi.fn(), publish: vi.fn(), tombstone: vi.fn(),
      },
      resolve_reviewer_target: () => ({
        reviewer: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" },
        slack_target: {
          connection: { body: { organization_id: "org_1", connection_id: "con_1", provider_app_id: "A01", provider_bot_id: "B01", provider_bot_user_id: "U02", provider_tenant_id: "T01", provider_enterprise_id: null }, sha256: DIGEST("6") },
          connection_state: { body: {}, sha256: DIGEST("7") },
          current_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_1", external_identity_link_contract_sha256: DIGEST("4"), provider_subject_id: "U01" },
        },
      }) as never,
      canonical_sha256: canonicalSha256,
    });

    await expect(stager.stage(input)).resolves.toEqual({ kind: "delivery_pending" });
    expect(assignmentStage).not.toHaveBeenCalled();
  });

  it("closes a thrown delivery error then preserves the original error", async () => {
    const expected = new Error("Slack transport failed");
    const journeyTelemetry = {
      beginStageForApproval: vi.fn(() => ({ journey_id: "journey-1", stage: "meeting_approval_staging", attempt: 1, started: { observed_at: NOW, monotonic_ms: 1 } })),
      markCardStaged: vi.fn(),
      succeedStage: vi.fn(),
      failStage: vi.fn(),
    };
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: {
        readApprovalDeliveryQuarantine: () => undefined,
        readCandidateByApprovalId: () => outbox(),
        prepareApprovalPost: () => ({ outbox: outbox("posting"), created: true }),
      } as unknown as SqliteAuthorityMeetingProcessingStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: { readCurrent: () => undefined } as never,
      control_plane: {} as never,
      poster: {
        openDirectMessage: async () => { throw expected; },
        postMarker: vi.fn(), reconcileMarker: vi.fn(), publish: vi.fn(), tombstone: vi.fn(),
      },
      resolve_reviewer_target: () => ({
        reviewer: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" },
        slack_target: {
          connection: { body: { organization_id: "org_1", connection_id: "con_1", provider_app_id: "A01", provider_bot_id: "B01", provider_bot_user_id: "U02", provider_tenant_id: "T01", provider_enterprise_id: null }, sha256: DIGEST("6") },
          connection_state: { body: {}, sha256: DIGEST("7") },
          current_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_1", external_identity_link_contract_sha256: DIGEST("4"), provider_subject_id: "U01" },
        },
      }) as never,
      canonical_sha256: canonicalSha256,
      journey_telemetry: journeyTelemetry as never,
    });

    await expect(stager.stage(input)).rejects.toBe(expected);
    expect(journeyTelemetry.failStage).toHaveBeenCalledWith(expect.anything(), expected);
  });

  it("preserves delivery result when the optional observer throws", async () => {
    const journeyTelemetry = {
      beginStageForApproval: vi.fn(() => ({ journey_id: "journey-1", stage: "meeting_approval_staging", attempt: 1, started: { observed_at: NOW, monotonic_ms: 1 } })),
      markCardStaged: vi.fn(),
      succeedStage: vi.fn(() => { throw new Error("observer unavailable"); }),
      failStage: vi.fn(),
    };
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: {
        readApprovalDeliveryQuarantine: () => undefined,
        readCandidateByApprovalId: () => outbox(),
      } as unknown as SqliteAuthorityMeetingProcessingStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: {} as never, control_plane: {} as never,
      poster: { openDirectMessage: vi.fn(), postMarker: vi.fn(), reconcileMarker: vi.fn(), publish: vi.fn(), tombstone: vi.fn() },
      resolve_reviewer_target: () => undefined,
      canonical_sha256: canonicalSha256,
      journey_telemetry: journeyTelemetry as never,
    });

    await expect(stager.stage(input)).resolves.toEqual({ kind: "delivery_pending" });
    expect(journeyTelemetry.succeedStage).toHaveBeenCalledWith(
      expect.anything(),
      { outcome: "delivery_pending" },
    );
  });

  it("uses immutable presentation evidence to tombstone a superseded private DM", async () => {
    const tombstone = vi.fn(async () => ({ kind: "done" as const }));
    const recorded = vi.fn();
    const recovery = {
      assignment: {
        organization_id: "org_1", candidate: {}, assigned_owner: {}, assigned_owner_slack_identity_link: {}, connection_id: "con_1",
        connection_contract_sha256: DIGEST("a"), connection_state_sha256: DIGEST("b"),
        dm_channel: { workspace_id: "T01", enterprise_id: null, channel_id: "D01" }, created_at: NOW,
      },
      provider_message_ts: "123.000001",
      source_outbox_state: "superseded" as const,
    };
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: {
        listPendingApprovalDeliveries: () => [],
        listPendingSupersededApprovalCards: () => [{
          approval_id: "apr_old", review_lineage_id: "rli_1", successor_id: "ignored",
          superseded_by_candidate_id: "cnd_new", presentation_external_id: "123.000001", post_started_at: NOW,
        }],
        recordSupersededApprovalCardTombstoned: recorded,
      } as unknown as SqliteAuthorityMeetingProcessingStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: { readForPresentation: () => recovery } as never,
      control_plane: {} as never,
      poster: { openDirectMessage: vi.fn(), postMarker: vi.fn(), reconcileMarker: vi.fn(), publish: vi.fn(), tombstone },
      resolve_reviewer_target: () => undefined,
    });
    await stager.reconcilePendingDeliveries();
    expect(tombstone).toHaveBeenCalledWith({
      approval_id: "apr_old", successor_id: "cnd_new", dm_channel_id: "D01", provider_message_ts: "123.000001",
    }, undefined);
    expect(recorded).toHaveBeenCalledWith({ approval_id: "apr_old", presentation_external_id: "123.000001" });
  });

  it("leaves a superseded unknown marker pending when no presentation proof exists", async () => {
    const tombstone = vi.fn();
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: {
        listPendingSupersededApprovalCards: () => [{
          approval_id: "apr_unknown", review_lineage_id: "rli_1", successor_id: "ignored",
          superseded_by_candidate_id: "cnd_new", presentation_external_id: null, post_started_at: NOW,
        }],
        recordSupersededApprovalCardTombstoned: vi.fn(),
      } as unknown as SqliteAuthorityMeetingProcessingStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: { readForPresentation: () => undefined } as never,
      control_plane: {} as never,
      poster: { openDirectMessage: vi.fn(), postMarker: vi.fn(), reconcileMarker: vi.fn(), publish: vi.fn(), tombstone },
      resolve_reviewer_target: () => undefined,
    });
    await expect(stager.reconcileSuperseded()).resolves.toBeUndefined();
    expect(tombstone).not.toHaveBeenCalled();
  });
});
