import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import { PrivateSlackDmApprovalStagerV1 } from "../../src/private-approval/private-slack-dm-approval-stager-v1.js";
import type { ApprovalWorkflowStageInputV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1";
import { meetingSourceEnvelopeV1, sourceContentSha256V1 } from "@echo-brain/organization-processing/core";
import { applyAuthorityBaselineV10 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import { SqlitePrivateSlackApprovalAssignmentStateV1 } from "../../src/private-approval/sqlite-private-slack-approval-assignment-state-v1.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
const NOW = "2026-09-01T00:00:00.000Z";

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


/** A meeting whose action names its owner, as extraction V10 may propose. */
function withOwnerProposal(owner: string | null, count = 1): ApprovalWorkflowStageInputV1 {
  const signals = Array.from({ length: count }, (_, index) => ({
    id: `action:sha256:${String(index).padStart(64, "0")}`, kind: "action", text: `Send the launch plan ${index + 1}`, subject: null, confidence: null, owner, due_at: null,
    evidence: [{ meeting_id: "meeting-1", block_id: "transcript-1", quote: "Decide the launch." }],
  }));
  return { ...input, decisions: { ...(input as any).decisions, signals } } as unknown as ApprovalWorkflowStageInputV1;
}

async function stageThrough(stageInput: ApprovalWorkflowStageInputV1) {
  let current = {
    ...stageInput.candidate, state: "queued", presentation_external_id: null, frozen_card_sha256: null,
    approved_snapshot_json: null, approved_snapshot_sha256: null, post_started_at: null,
    control_approval_sha256: null, superseded_by_candidate_id: null, superseded_at: null, tombstoned_at: null,
  } as any;
  const authorityDatabase = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV10(authorityDatabase);
  authorityDatabase.pragma("foreign_keys = OFF");
  const source = meetingSourceEnvelopeV1(stageInput.meeting);
  authorityDatabase.prepare(`INSERT INTO authority_metadata (singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at) VALUES (1,'oau_1','org_1','Org','{}',?,?)`).run(NOW, NOW);
  authorityDatabase.prepare(`INSERT INTO authority_principals (principal_id,organization_id,display_name,provisioned_at) VALUES ('prn_1','org_1','Owner',?)`).run(NOW);
  authorityDatabase.prepare(`INSERT INTO authority_memberships (membership_id,organization_id,principal_id,membership_type,status,provisioned_at,revoked_at,revocation_reason,employee_email,employee_email_sha256) VALUES ('mem_1','org_1','prn_1','owner','active',?,NULL,NULL,NULL,NULL)`).run(NOW);
  authorityDatabase.prepare(`INSERT INTO authority_live_source_candidates_v2 (candidate_id,candidate_semantic_sha256,admission_semantic_input_sha256,review_lineage_id,review_input_sha256,review_semantic_sha256,review_policy_id,review_policy_contract_sha256,review_policy_consequence_text,review_policy_consequence_sha256,disposition,source_cursor,meeting_sha256,meeting_json,decisions_sha256,decisions_json,created_at) VALUES ('cnd_1',?,'sha256:${"a".repeat(64)}','rli_1','sha256:${"c".repeat(64)}','sha256:${"d".repeat(64)}','review-policy','sha256:${"e".repeat(64)}','review','sha256:${"f".repeat(64)}','actionable','cursor','sha256:${"1".repeat(64)}','{}','sha256:${"2".repeat(64)}','{}',?)`).run(digest("b"), NOW);
  authorityDatabase.prepare(`INSERT INTO authority_live_source_review_lineage_heads_v2 (review_lineage_id,candidate_id,updated_at) VALUES ('rli_1','cnd_1',?)`).run(NOW);
  authorityDatabase.prepare(`INSERT INTO authority_live_approval_outbox_v2 (candidate_id,approval_id,stage_command_id,state,updated_at) VALUES ('cnd_1','apr_1','pas_1','queued',?)`).run(NOW);
  authorityDatabase.prepare(`INSERT INTO authority_sources_v1 (organization_id,source_id,adapter_id,instance_id,external_id,custody_ref,access_policy_ref,analysis_policy) VALUES ('org_1',?,'granola','granola-1','note-1','org','meeting','automatic')`).run(source.item.source_id);
  authorityDatabase.prepare(`INSERT INTO authority_source_revisions_v1 (organization_id,source_id,revision_id,adapter_version,captured_at,content_sha256,revision_sha256,manifest_json) VALUES ('org_1',?,?,'1',?,'${"0".repeat(64)}',?,'{}')`).run(source.item.source_id, source.revision.revision_id, NOW, sourceContentSha256V1((({ captured_at: _capturedAt, ...immutable }) => immutable)(source.revision)));
  const delivery = new SqlitePrivateSlackApprovalAssignmentStateV1(authorityDatabase, () => NOW);
  const assignment = {
    organization_id: "org_1", candidate: {}, assigned_owner: { principal_id: "prn_1", membership_id: "mem_1" },
    assigned_owner_slack_identity_link: { provider: "slack" as const, external_identity_link_id: "clm_1", external_identity_link_contract_sha256: digest("4"), provider_subject_id: "U01" },
    connection_id: "con_1", connection_contract_sha256: digest("6"), connection_state_sha256: digest("7"),
    dm_channel: { workspace_id: "T01", enterprise_id: null, channel_id: "D01" }, created_at: NOW,
  };
  const prepared: any[] = [];
  const published: any[] = [];
  const stager = new PrivateSlackDmApprovalStagerV1({
    authority: {
      readApprovalDeliveryQuarantine: () => undefined,
      readCandidateByApprovalId: () => current,
      prepareApprovalPost: (received: any) => { prepared.push(received); const created = current.state === "queued"; current = { ...current, state: "posting", frozen_card_sha256: received.frozen_card_sha256, approved_snapshot_sha256: canonicalSha256(received.approved_snapshot), post_started_at: NOW }; return { outbox: current, created }; },
      recordPostedApprovalCard: (received: any) => { current = { ...current, state: "posted", presentation_external_id: received.presentation_external_id }; return current; },
      markControlPlaneStaged: ({ control_approval_sha256 }: any) => { current = { ...current, state: "staged", control_approval_sha256 }; return current; },
      quarantineApprovalDelivery: vi.fn(),
      listPendingApprovalDeliveries: () => [], releaseApprovalPostAttempt: vi.fn(), recordSupersededApprovalCardTombstoned: vi.fn(),
    } as never,
    authority_database: authorityDatabase as never, control_plane_database: {} as never,
    coordinates: { authority_id: "oau_1", organization_id: "org_1", state_lineage_id: "lin_1" }, connection_id: "con_1",
    assignments: {
      readDeliveryV2: (approvalId: string) => delivery.readDeliveryV2(approvalId),
      freezeDeliveryV2: (value: any) => delivery.freezeDeliveryV2(value),
      readCurrent: () => undefined,
      stage: () => ({ assignment, created: true }),
    } as never,
    control_plane: { stage: vi.fn(), stageV2: vi.fn(() => ({ pending_sha256: digest("8") })) },
    poster: {
      openDirectMessage: async () => ({ kind: "opened" as const, channel_id: "D01", user_id: "U01" }),
      postMarker: async () => ({ kind: "posted" as const, provider_message_ts: "123.000001" }), reconcileMarker: async () => ({ kind: "posted" as const, provider_message_ts: "123.000001" }),
      publish: async (received: any) => { published.push(received.card); return { kind: "done" as const }; }, tombstone: vi.fn(),
    },
    resolve_reviewer_target: () => ({ reviewer: { principal_id: "prn_1", membership_id: "mem_1", membership_type: "owner" }, slack_target: { connection: { body: { organization_id: "org_1", connection_id: "con_1", provider_app_id: "A01", provider_bot_id: "B01", provider_bot_user_id: "U02", provider_tenant_id: "T01", provider_enterprise_id: null }, sha256: digest("6") }, connection_state: { body: {}, sha256: digest("7") }, current_slack_identity_link: assignment.assigned_owner_slack_identity_link } }) as never,
    canonical_sha256: canonicalSha256, now: () => NOW,
  });
  const result = await stager.stage(stageInput);
  const pending = delivery.readDeliveryV2("apr_1");
  authorityDatabase.close();
  return { result, prepared, published, pending };
}

describe("private Slack DM approval stager V3 owner proposals", () => {
  it("offers a proposed owner on a V3 card and never puts it in the approved snapshot", async () => {
    const staged = await stageThrough(withOwnerProposal("Participant"));
    expect(staged.result).toEqual({ kind: "staged", stage_id: "apr_1" });
    const card = staged.published[0];
    expect(card).toMatchObject({ schema_version: 3, kind: "echo-private-approval-block-kit-card-v3" });
    const field = card.blocks.find((block: any) => block.block_id?.endsWith("-owner-0-v2"));
    expect(field.element).toMatchObject({ type: "plain_text_input", initial_value: "Participant" });
    const snapshot = staged.prepared[0].approved_snapshot;
    expect(snapshot.approved_payload.brief.actions).toEqual([expect.objectContaining({ text: "Send the launch plan 1", owner: null })]);
    expect(staged.pending?.frozen_card_sha256).toBe(staged.prepared[0].frozen_card_sha256);
  });

  it("keeps the exact V2 card and snapshot when nothing proposes an owner", async () => {
    const plain = await stageThrough(withOwnerProposal(null));
    expect(plain.published[0]).toMatchObject({ schema_version: 2, kind: "echo-private-approval-block-kit-card-v2" });
    // The same brief without proposals commits to the same snapshot either way.
    const proposed = await stageThrough(withOwnerProposal("Participant"));
    expect(canonicalSha256(proposed.prepared[0].approved_snapshot.approved_payload)).toBe(canonicalSha256(plain.prepared[0].approved_snapshot.approved_payload));
    expect(proposed.prepared[0].frozen_card_sha256).not.toBe(plain.prepared[0].frozen_card_sha256);
  });

  it("falls back to the V2 card when owner fields would not fit, recording no owner", async () => {
    const crowded = await stageThrough(withOwnerProposal("Participant", 41));
    expect(crowded.published[0]).toMatchObject({ schema_version: 2 });
    expect(crowded.prepared[0].approved_snapshot.approved_payload.brief.actions.every((action: any) => action.owner === null)).toBe(true);
  });
});
