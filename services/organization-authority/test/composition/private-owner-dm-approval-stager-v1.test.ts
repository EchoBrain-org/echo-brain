import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { StagedPrivateApprovalPendingV1 } from "@echo-brain/organization-control-plane/clean-runtime-v1";
import { describe, expect, it, vi } from "vitest";
import { PrivateOwnerDmApprovalStagerV1 } from "../../src/composition/private-owner-dm-approval-stager-v1.js";
import type { CleanApprovalStageInputV1 } from "../../src/processing/clean-v1/live-only-source-cycle.js";
import type { SqliteCleanLiveOnlySourceStateV1 } from "../../src/processing/clean-v1/sqlite-live-only-source-state.js";

const DIGEST = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
type Sha256 = `sha256:${string}`;
const NOW = "2026-08-28T00:00:00.000Z";

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
    id: "meeting-1", title: "Quarterly planning", participants: [], content: [], artifacts: [], capture: { state: "complete", components: [] },
    provenance: { external_id: "note-1", canonical_revision: "rev-1", source: { kind: "meeting-source", adapter_id: "granola", instance_id: "granola-1", version: "1" }, observed_at: NOW, normalizer_version: "1" }, extensions: {}, schema_version: 1,
  },
  decisions: { schema_version: 1, meeting_id: "meeting-1", meeting_revision: "rev-1", generated_at: NOW, processor: { kind: "decision-processor", adapter_id: "llm", instance_id: "llm-1", version: "1" }, signals: [] },
} as unknown as CleanApprovalStageInputV1;

function outbox(state: "queued" | "posting" | "posted" | "staged" = "queued") {
  return {
    ...input.candidate,
    state,
    provider_message_ts: state === "queued" || state === "posting" ? null : "123.000001",
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

describe("private owner-DM approval stager V1", () => {
  it("binds null policy before publishing one verified-owner DM card", async () => {
    const operations: string[] = [];
    let current = outbox();
    let assignment = {
      organization_id: "org_1",
      candidate: {},
      assigned_owner: { principal_id: "prn_1", membership_id: "mem_1" },
      assigned_owner_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_1", external_identity_link_contract_sha256: DIGEST("4"), provider_subject_id: "U01" },
      connection_id: "con_1", connection_contract_sha256: DIGEST("6"), connection_state_sha256: DIGEST("7"),
      dm_channel: { workspace_id: "T01", enterprise_id: null, channel_id: "D01" }, created_at: NOW,
    };
    const authority = {
      readCandidateByApprovalId: () => current,
      prepareApprovalPost: (received: { frozen_card_sha256: Sha256; approved_snapshot: unknown }) => {
        operations.push("freeze");
        current = { ...outbox("posting"), frozen_card_sha256: received.frozen_card_sha256, approved_snapshot_sha256: canonicalSha256(received.approved_snapshot) as Sha256 };
        return { outbox: current, created: true };
      },
      recordPostedApprovalCard: (received: { frozen_card_sha256: Sha256; approved_snapshot: unknown; provider_message_ts: string }) => {
        operations.push("marker-durable");
        current = { ...current, state: "posted", provider_message_ts: received.provider_message_ts, frozen_card_sha256: received.frozen_card_sha256, approved_snapshot_sha256: canonicalSha256(received.approved_snapshot) as Sha256 };
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
    const stager = new PrivateOwnerDmApprovalStagerV1({
      authority: authority as unknown as SqliteCleanLiveOnlySourceStateV1,
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
        publish: async () => { operations.push("publish"); return { kind: "done" as const }; },
        tombstone: vi.fn(),
      },
      resolve_target: () => ({
        assignee: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" },
        slack_target: {
          connection: { body: { organization_id: "org_1", connection_id: "con_1", provider_app_id: "A01", provider_bot_id: "B01", provider_bot_user_id: "U02", provider_tenant_id: "T01", provider_enterprise_id: null }, sha256: DIGEST("6") },
          connection_state: { body: {}, sha256: DIGEST("7") },
          current_slack_identity_link: assignment.assigned_owner_slack_identity_link,
        },
      }) as never,
      canonical_sha256: canonicalSha256,
      now: () => NOW,
    });

    await expect(stager.stage(input)).resolves.toEqual({ kind: "staged", stage_id: "apr_1" });
    expect(operations).toEqual([
      "freeze", "open-dm", "assignment", "marker", "marker-durable", "cp-pending", "publish", "authority-staged",
    ]);
    expect(stage).toHaveBeenCalledOnce();
  });

  it("reproves the owner after CP staging before publishing the full card", async () => {
    let current = outbox();
    let ownerIsCurrent = true;
    const assignment = {
      organization_id: "org_1",
      candidate: {},
      assigned_owner: { principal_id: "prn_1", membership_id: "mem_1" },
      assigned_owner_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_1", external_identity_link_contract_sha256: DIGEST("4"), provider_subject_id: "U01" },
      connection_id: "con_1", connection_contract_sha256: DIGEST("6"), connection_state_sha256: DIGEST("7"),
      dm_channel: { workspace_id: "T01", enterprise_id: null, channel_id: "D01" }, created_at: NOW,
    };
    const target = {
      assignee: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" },
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
    const stager = new PrivateOwnerDmApprovalStagerV1({
      authority: {
        readCandidateByApprovalId: () => current,
        prepareApprovalPost: (received: { frozen_card_sha256: Sha256; approved_snapshot: unknown }) => {
          current = { ...outbox("posting"), frozen_card_sha256: received.frozen_card_sha256, approved_snapshot_sha256: canonicalSha256(received.approved_snapshot) as Sha256 };
          return { outbox: current, created: true };
        },
        recordPostedApprovalCard: (received: { frozen_card_sha256: Sha256; approved_snapshot: unknown; provider_message_ts: string }) => {
          current = { ...current, state: "posted", provider_message_ts: received.provider_message_ts, frozen_card_sha256: received.frozen_card_sha256, approved_snapshot_sha256: canonicalSha256(received.approved_snapshot) as Sha256 };
          return current;
        },
        markControlPlaneStaged,
        releaseApprovalPostAttempt: vi.fn(), recordSupersededApprovalCardTombstoned: vi.fn(),
      } as unknown as SqliteCleanLiveOnlySourceStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: { readCurrent: () => undefined, stage: () => ({ assignment, created: true }) } as never,
      control_plane: { stage: controlPlaneStage },
      poster: {
        openDirectMessage: async () => ({ kind: "opened" as const, channel_id: "D01", user_id: "U01" }),
        postMarker: async () => ({ kind: "posted" as const, provider_message_ts: "123.000001" }),
        reconcileMarker: vi.fn(), publish, tombstone: vi.fn(),
      },
      resolve_target: resolveTarget,
      canonical_sha256: canonicalSha256,
      now: () => NOW,
    });

    await expect(stager.stage(input)).resolves.toEqual({ kind: "state_drift" });
    expect(resolveTarget).toHaveBeenCalledTimes(2);
    expect(controlPlaneStage).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(markControlPlaneStaged).not.toHaveBeenCalled();
  });

  it("does not open or publish a fallback when owner proof is absent", async () => {
    const openDirectMessage = vi.fn();
    const authority = { readCandidateByApprovalId: () => outbox(), prepareApprovalPost: () => ({ outbox: outbox("posting"), created: true }) };
    const stager = new PrivateOwnerDmApprovalStagerV1({
      authority: authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: {} as never, control_plane: {} as never,
      poster: { openDirectMessage, postMarker: vi.fn(), reconcileMarker: vi.fn(), publish: vi.fn(), tombstone: vi.fn() },
      resolve_target: () => undefined,
      canonical_sha256: canonicalSha256,
    });
    await expect(stager.stage(input)).resolves.toEqual({ kind: "state_drift" });
    expect(openDirectMessage).not.toHaveBeenCalled();
  });

  it("keeps a frozen delivery pending when Slack defers opening the DM", async () => {
    const assignmentStage = vi.fn();
    const stager = new PrivateOwnerDmApprovalStagerV1({
      authority: {
        readCandidateByApprovalId: () => outbox(),
        prepareApprovalPost: () => ({ outbox: outbox("posting"), created: true }),
      } as unknown as SqliteCleanLiveOnlySourceStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: { readCurrent: () => undefined, stage: assignmentStage } as never,
      control_plane: {} as never,
      poster: {
        openDirectMessage: async () => ({ kind: "retry_allowed" as const }),
        postMarker: vi.fn(), reconcileMarker: vi.fn(), publish: vi.fn(), tombstone: vi.fn(),
      },
      resolve_target: () => ({
        assignee: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" },
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
    const stager = new PrivateOwnerDmApprovalStagerV1({
      authority: {
        listPendingApprovalDeliveries: () => [],
        listPendingSupersededApprovalCards: () => [{
          approval_id: "apr_old", review_lineage_id: "rli_1", successor_id: "ignored",
          superseded_by_candidate_id: "cnd_new", provider_message_ts: "123.000001", post_started_at: NOW,
        }],
        recordSupersededApprovalCardTombstoned: recorded,
      } as unknown as SqliteCleanLiveOnlySourceStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: { readForPresentation: () => recovery } as never,
      control_plane: {} as never,
      poster: { openDirectMessage: vi.fn(), postMarker: vi.fn(), reconcileMarker: vi.fn(), publish: vi.fn(), tombstone },
    });
    await stager.reconcilePendingDeliveries();
    expect(tombstone).toHaveBeenCalledWith({
      approval_id: "apr_old", successor_id: "cnd_new", dm_channel_id: "D01", provider_message_ts: "123.000001",
    }, undefined);
    expect(recorded).toHaveBeenCalledWith({ approval_id: "apr_old", provider_message_ts: "123.000001" });
  });

  it("leaves a superseded unknown marker pending when no presentation proof exists", async () => {
    const tombstone = vi.fn();
    const stager = new PrivateOwnerDmApprovalStagerV1({
      authority: {
        listPendingSupersededApprovalCards: () => [{
          approval_id: "apr_unknown", review_lineage_id: "rli_1", successor_id: "ignored",
          superseded_by_candidate_id: "cnd_new", provider_message_ts: null, post_started_at: NOW,
        }],
        recordSupersededApprovalCardTombstoned: vi.fn(),
      } as unknown as SqliteCleanLiveOnlySourceStateV1,
      authority_database: {} as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
      assignments: { readForPresentation: () => undefined } as never,
      control_plane: {} as never,
      poster: { openDirectMessage: vi.fn(), postMarker: vi.fn(), reconcileMarker: vi.fn(), publish: vi.fn(), tombstone },
    });
    await expect(stager.reconcileSuperseded()).resolves.toBeUndefined();
    expect(tombstone).not.toHaveBeenCalled();
  });
});
