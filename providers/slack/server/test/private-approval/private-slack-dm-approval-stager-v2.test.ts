import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import { PrivateSlackDmApprovalStagerV1 } from "../../src/private-approval/private-slack-dm-approval-stager-v1.js";
import type { ApprovalWorkflowStageInputV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1";
import { meetingSourceEnvelopeV1, sourceContentSha256V1 } from "@echo-brain/organization-processing/core";
import { applyAuthorityBaselineV12 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import { SqlitePrivateSlackApprovalAssignmentStateV1 } from "../../src/private-approval/sqlite-private-slack-approval-assignment-state-v1.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
const NOW = "2026-09-01T00:00:00.000Z";
const PROJECT = "prj_11111111-1111-4111-8111-111111111111";
const PROJECT_MEMBERSHIP = "pgm_22222222-2222-4222-8222-222222222222";

const input = {
  admission: {
    source: { adapter_id: "granola", instance_id: "granola-1", version: "1", cursor: "cursor", cutoff_at: NOW },
    processor: { adapter_id: "llm", instance_id: "llm-1", version: "1", configuration_sha256: digest("a") },
  },
  candidate: {
    candidate_id: "cnd_1", candidate_semantic_sha256: digest("b"), review_lineage_id: "rli_1", review_input_sha256: digest("c"), review_semantic_sha256: digest("d"),
    review_policy_id: "organization-member-readable-person-v2", review_policy_contract_sha256: digest("e"), review_policy_consequence_text: "legacy", review_policy_consequence_sha256: digest("f"),
    disposition: "actionable", approval_id: "apr_1", stage_command_id: "psc_1", state: "queued",
  },
  meeting: {
    id: "meeting-1", title: "Project review", participants: [{ id: "participant-1", display_name: "Participant" }], content: [{ id: "transcript-1", kind: "transcript", text: "Decide the launch.", speaker_participant_id: "participant-1" }], artifacts: [], capture: { state: "complete", components: [] },
    provenance: { external_id: "note-1", canonical_revision: "revision-1", source: { kind: "meeting-source", adapter_id: "granola", instance_id: "granola-1", version: "1" }, observed_at: NOW, normalizer_version: "1" }, extensions: {}, schema_version: 1,
  },
  decisions: { schema_version: 1, meeting_id: "meeting-1", meeting_revision: "revision-1", generated_at: NOW, processor: { kind: "decision-processor", adapter_id: "llm", instance_id: "llm-1", version: "1" }, signals: [] },
} as unknown as ApprovalWorkflowStageInputV1;

describe("private Slack DM approval stager V2", () => {
  it("fails closed before provider I/O when a real meeting has no retained source revision", async () => {
    const database = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV12(database);
    const prepareApprovalPost = vi.fn();
    const poster = {
      openDirectMessage: vi.fn(), postMarker: vi.fn(), reconcileMarker: vi.fn(),
      publish: vi.fn(), tombstone: vi.fn(),
    };
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: {
        readApprovalDeliveryQuarantine: () => undefined,
        readCandidateByApprovalId: () => ({ ...input.candidate, state: "queued", presentation_external_id: null, frozen_card_sha256: null, approved_snapshot_json: null, approved_snapshot_sha256: null, post_started_at: null, control_approval_sha256: null, superseded_by_candidate_id: null, superseded_at: null, tombstoned_at: null }),
        prepareApprovalPost,
        listPendingApprovalDeliveries: () => [], listPendingSupersededApprovalCards: () => [],
        recordSupersededApprovalCardTombstoned: vi.fn(), releaseApprovalPostAttempt: vi.fn(),
      } as never,
      authority_database: database, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: () => "con_1",
      assignments: { readDeliveryV2: () => undefined, freezeDeliveryV2: vi.fn(), readCurrent: vi.fn(), stage: vi.fn() } as never,
      control_plane: { stage: vi.fn(), stageV2: vi.fn() }, poster,
      resolve_reviewer_target: () => ({ reviewer: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" }, slack_target: { connection: { body: { organization_id: "org_1", connection_id: "con_1", provider_app_id: "A01", provider_bot_id: "B01", provider_bot_user_id: "U02", provider_tenant_id: "T01", provider_enterprise_id: null }, sha256: digest("6") }, connection_state: { body: {}, sha256: digest("7") }, current_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_1", external_identity_link_contract_sha256: digest("4"), provider_subject_id: "U01" } } }) as never,
      canonical_sha256: canonicalSha256, now: () => NOW,
    });
    try {
      await expect(stager.stage(input)).resolves.toEqual({ kind: "state_drift" });
      expect(prepareApprovalPost).not.toHaveBeenCalled();
      expect(poster.openDirectMessage).not.toHaveBeenCalled();
      expect(poster.postMarker).not.toHaveBeenCalled();
      expect(poster.publish).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it("freezes active grants and the retained source before Slack I/O, then retries from that frozen pending contract", async () => {
    const operations: string[] = [];
    let current = {
      ...input.candidate, state: "queued", presentation_external_id: null, frozen_card_sha256: null,
      approved_snapshot_json: null, approved_snapshot_sha256: null, post_started_at: null,
      control_approval_sha256: null, superseded_by_candidate_id: null, superseded_at: null, tombstoned_at: null,
    } as any;
    const authorityDatabase = openAuthorityDatabase(":memory:");
    applyAuthorityBaselineV12(authorityDatabase);
    authorityDatabase.pragma("foreign_keys = OFF");
    const source = meetingSourceEnvelopeV1(input.meeting);
    authorityDatabase.prepare(`INSERT INTO authority_metadata (singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at) VALUES (1,'oau_1','org_1','Org','{}',?,?)`).run(NOW, NOW);
    authorityDatabase.prepare(`INSERT INTO authority_principals (principal_id,organization_id,display_name,provisioned_at) VALUES ('prn_1','org_1','Owner',?)`).run(NOW);
    authorityDatabase.prepare(`INSERT INTO authority_memberships (membership_id,organization_id,principal_id,membership_type,status,provisioned_at,revoked_at,revocation_reason,employee_email,employee_email_sha256) VALUES ('mem_1','org_1','prn_1','owner','active',?,NULL,NULL,NULL,NULL)`).run(NOW);
    authorityDatabase.prepare(`INSERT INTO authority_live_source_candidates_v2 (candidate_id,candidate_semantic_sha256,admission_semantic_input_sha256,review_lineage_id,review_input_sha256,review_semantic_sha256,review_policy_id,review_policy_contract_sha256,review_policy_consequence_text,review_policy_consequence_sha256,disposition,source_cursor,meeting_sha256,meeting_json,decisions_sha256,decisions_json,created_at) VALUES ('cnd_1',?,'sha256:${"a".repeat(64)}','rli_1','sha256:${"c".repeat(64)}','sha256:${"d".repeat(64)}','review-policy','sha256:${"e".repeat(64)}','review','sha256:${"f".repeat(64)}','actionable','cursor','sha256:${"1".repeat(64)}','{}','sha256:${"2".repeat(64)}','{}',?)`).run(digest("b"), NOW);
    authorityDatabase.prepare(`INSERT INTO authority_live_source_review_lineage_heads_v2 (review_lineage_id,candidate_id,updated_at) VALUES ('rli_1','cnd_1',?)`).run(NOW);
    authorityDatabase.prepare(`INSERT INTO authority_live_approval_outbox_v2 (candidate_id,approval_id,stage_command_id,state,updated_at) VALUES ('cnd_1','apr_1','pas_1','queued',?)`).run(NOW);
    authorityDatabase.prepare(`INSERT INTO authority_sources_v1 (organization_id,source_id,adapter_id,instance_id,external_id,custody_ref,access_policy_ref,analysis_policy) VALUES ('org_1',?,'granola','granola-1','note-1','org','meeting','automatic')`).run(source.item.source_id);
    authorityDatabase.prepare(`INSERT INTO authority_source_revisions_v1 (organization_id,source_id,revision_id,adapter_version,captured_at,content_sha256,revision_sha256,manifest_json) VALUES ('org_1',?,?,'1',?,'${"0".repeat(64)}',?,'{}')`).run(source.item.source_id, source.revision.revision_id, NOW, sourceContentSha256V1((({ captured_at: _capturedAt, ...immutable }) => immutable)(source.revision)));
    authorityDatabase.prepare(`INSERT INTO authority_projects_v1 (project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type) VALUES (?,'org_1','Launch',?,'prn_1','mem_1','owner')`).run(PROJECT, NOW);
    authorityDatabase.prepare(`INSERT INTO authority_project_memberships_v1 (project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at,revoked_at) VALUES (?,?,'org_1','prn_1','mem_1','owner','lead','active',?,NULL)`).run(PROJECT_MEMBERSHIP, PROJECT, NOW);
    // An active grant in an archived project must not become a new card choice.
    const archivedProject = "prj_33333333-3333-4333-8333-333333333333";
    authorityDatabase.prepare(`INSERT INTO authority_projects_v1 (project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type,status) VALUES (?,'org_1','Archived launch',?,'prn_1','mem_1','owner','archived')`).run(archivedProject, NOW);
    authorityDatabase.prepare(`INSERT INTO authority_project_memberships_v1 (project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at) VALUES ('pgm_44444444-4444-4444-8444-444444444444',?,'org_1','prn_1','mem_1','owner','lead','active',?)`).run(archivedProject, NOW);
    const frozenDelivery = new SqlitePrivateSlackApprovalAssignmentStateV1(authorityDatabase, () => NOW);
    let deliveryReader = frozenDelivery;
    let frozenPending: any;
    const assignment = {
      organization_id: "org_1", candidate: {}, assigned_owner: { principal_id: "prn_1", membership_id: "mem_1" },
      assigned_owner_slack_identity_link: { provider: "slack" as const, external_identity_link_id: "clm_1", external_identity_link_contract_sha256: digest("4"), provider_subject_id: "U01" },
      connection_id: "con_1", connection_contract_sha256: digest("6"), connection_state_sha256: digest("7"),
      dm_channel: { workspace_id: "T01", enterprise_id: null, channel_id: "D01" }, created_at: NOW,
    };
    const authority = {
      readApprovalDeliveryQuarantine: () => undefined,
      readCandidateByApprovalId: () => current,
      prepareApprovalPost: (received: any) => {
        operations.push("prepare");
        const created = current.state === "queued";
        current = { ...current, state: "posting", frozen_card_sha256: received.frozen_card_sha256, approved_snapshot_sha256: canonicalSha256(received.approved_snapshot), post_started_at: NOW };
        return { outbox: current, created };
      },
      recordPostedApprovalCard: (received: any) => {
        current = { ...current, state: "posted", presentation_external_id: received.presentation_external_id };
        return current;
      },
      markControlPlaneStaged: ({ control_approval_sha256 }: any) => {
        current = { ...current, state: "staged", control_approval_sha256 };
        return current;
      },
      listPendingApprovalDeliveries: () => [], releaseApprovalPostAttempt: vi.fn(), recordSupersededApprovalCardTombstoned: vi.fn(),
    };
    const stageV2 = vi.fn(() => ({ pending_sha256: digest("8") }));
    let retryDirectMessage = true;
    let recipientChanged = false;
    const stager = new PrivateSlackDmApprovalStagerV1({
      authority: authority as never, authority_database: authorityDatabase as never, control_plane_database: {} as never,
      coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: () => "con_1",
      assignments: {
        readDeliveryV2: (approvalId: string) => deliveryReader.readDeliveryV2(approvalId),
        freezeDeliveryV2: (delivery: any) => { operations.push("freeze-v2"); frozenPending = frozenDelivery.freezeDeliveryV2(delivery); return frozenPending; },
        readCurrent: () => undefined,
        stage: () => ({ assignment, created: true }),
      } as never,
      control_plane: { stage: vi.fn(), stageV2 },
      poster: {
        openDirectMessage: async () => { operations.push("open-dm"); if (retryDirectMessage) return { kind: "retry_allowed" as const }; return { kind: "opened" as const, channel_id: "D01", user_id: "U01" }; },
        postMarker: async () => ({ kind: "posted" as const, provider_message_ts: "123.000001" }), reconcileMarker: async () => ({ kind: "posted" as const, provider_message_ts: "123.000001" }),
        publish: async (received: any) => { operations.push("publish"); expect(JSON.stringify(received.card.blocks)).toContain("share-transcript-v1"); return { kind: "done" as const }; }, tombstone: vi.fn(),
      },
      resolve_reviewer_target: () => ({ reviewer: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" }, slack_target: { connection: { body: { organization_id: "org_1", connection_id: "con_1", provider_app_id: "A01", provider_bot_id: "B01", provider_bot_user_id: "U02", provider_tenant_id: "T01", provider_enterprise_id: null }, sha256: digest("6") }, connection_state: { body: {}, sha256: digest("7") }, current_slack_identity_link: recipientChanged ? { ...assignment.assigned_owner_slack_identity_link, provider_subject_id: "U03" } : assignment.assigned_owner_slack_identity_link } }) as never,
      canonical_sha256: canonicalSha256, now: () => NOW,
    });

    await expect(stager.stage(input)).resolves.toEqual({ kind: "delivery_pending" });
    expect(operations.indexOf("freeze-v2")).toBeLessThan(operations.indexOf("open-dm"));
    expect(operations).not.toContain("prepare");
    expect(frozenPending).toMatchObject({ schema_version: 2, eligible_projects: [{ project_id: PROJECT, project_membership_id: PROJECT_MEMBERSHIP }], transcript_source: { revision_id: "revision-1", source_sha256: `sha256:${sourceContentSha256V1((({ captured_at: _capturedAt, ...immutable }) => immutable)(meetingSourceEnvelopeV1(input.meeting).revision))}` } });

    expect(frozenPending.eligible_projects).toHaveLength(1);
    // Preserve the exact displayed choices on retry; the tap-time fence decides
    // whether a previously displayed choice can still admit a new approval.
    authorityDatabase.prepare("UPDATE authority_projects_v1 SET status='archived' WHERE project_id=?").run(PROJECT);
    const providerOperations = operations.length;
    recipientChanged = true;
    await expect(stager.stage(input)).resolves.toEqual({ kind: "state_drift" });
    expect(operations).toHaveLength(providerOperations);
    recipientChanged = false;

    // A delivery retry uses a new real assignment-store instance. Its stored
    // contract is the only V2 source of eligible projects and transcript.
    const restarted = new SqlitePrivateSlackApprovalAssignmentStateV1(authorityDatabase, () => NOW);
    deliveryReader = restarted;
    retryDirectMessage = false;
    await expect(stager.stage(input)).resolves.toEqual({ kind: "staged", stage_id: "apr_1" });
    expect(stageV2).toHaveBeenCalledWith(expect.objectContaining({ pending: frozenPending }));
    expect(restarted.readDeliveryV2("apr_1")).toEqual(frozenPending);
    authorityDatabase.close();
  });
});
