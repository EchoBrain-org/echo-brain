import {
  canonicalJson,
  canonicalSha256
} from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteAuthorityMeetingProcessingStateV1
} from "../../../../../packages/organization-processing/src/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import {
  createStagingSyntheticMeetingCanaryV1,
  stagingSyntheticMeetingCanaryCursorV1,
} from "../../../../../packages/organization-processing/src/admitted-meeting-processing/staging-synthetic-meeting-canary-v1.js";
import type {
  DecisionSet
} from "../../../../../packages/organization-processing/src/core/index.js";
import { ADVANCED_AT, database, databases, decisions, fixtureCursorPolicy, REVIEW_POLICY, SHA } from "../../../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js";
import type { DurablePrivateApprovalTerminalV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-dm-approval-persistence-v1.js";
import { PrivateSlackApprovalTerminalCoordinatorV1 } from "../../src/private-approval/private-slack-approval-terminal-coordinator-v1.js";
import { SqlitePrivateSlackApprovalAssignmentStateV1 } from "../../src/private-approval/sqlite-private-slack-approval-assignment-state-v1.js";
import { SqlitePrivateSlackApprovalTerminalAuthorityV1 } from "../../src/private-approval/sqlite-private-slack-approval-terminal-authority-v1.js";
afterEach(() => { for (const value of databases.splice(0)) value.close(); });

describe("Slack persisted staging canary", () => {
  it("revalidates, recovers, and finalizes an exact durable staging canary without opening synthetic ingress", async () => {
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      value,
      fixtureCursorPolicy,
      "llm",
      () => ADVANCED_AT,
    );
    const canary = createStagingSyntheticMeetingCanaryV1({
      canary_id: "canary-recovery",
      owner_email: "founder@example.com",
      observed_at: ADVANCED_AT,
    });
    const canaryDecisions: DecisionSet = {
      schema_version: 1,
      meeting_id: canary.id,
      meeting_revision: canary.provenance.canonical_revision,
      processor: decisions.processor,
      generated_at: ADVANCED_AT,
      signals: [{
        id: "canary-decision",
        kind: "decision",
        status: "decided",
        text: "Verify private approval delivery.",
        subject: null,
        confidence: 1,
        evidence: [{ meeting_id: canary.id, block_id: "synthetic-decision" }],
      }],
    };
    const candidateId = "cnd_canary-recovery";
    const approvalId = "apr_canary-recovery";
    const candidateSha256 = canonicalSha256({
      schema_version: 1,
      kind: "echo-clean-live-candidate-v1",
      admission_semantic_input_sha256: SHA,
      meeting: {
        external_id: canary.provenance.external_id,
        canonical_revision: canary.provenance.canonical_revision,
      },
    });
    const cardSha256 = canonicalSha256({ candidateId, card: true });
    const approvedSnapshot = { schema_version: 1, canary: true };
    const approvedSnapshotJson = canonicalJson(approvedSnapshot);
    const approvedSnapshotSha256 = canonicalSha256(approvedSnapshot);

    // The normal live ingress still accepts only the admitted provider.
    await expect(
      state.stageCandidate({
        admission: await state.readAdmission(),
        meeting: canary,
        decisions: canaryDecisions,
        review_policy: REVIEW_POLICY,
      }),
    ).rejects.toThrow(
      "meeting provenance does not match the meeting-source adapter instance",
    );

    // Simulate only the immutable rows that a later writer may have already
    // committed. PR98 intentionally has no public or worker path to create
    // them, so this fixture proves the older reader/recovery contract.
    value.prepare(
      `INSERT INTO authority_live_source_candidates_v2 (
         candidate_id, candidate_semantic_sha256,
         admission_semantic_input_sha256, review_lineage_id,
         review_input_sha256, review_semantic_sha256,
         review_policy_id, review_policy_contract_sha256,
         review_policy_consequence_text, review_policy_consequence_sha256,
         disposition, source_cursor, meeting_sha256, meeting_json,
         decisions_sha256, decisions_json, created_at
       ) VALUES (?, ?, ?, 'rli_canary-recovery', ?, ?, ?, ?, ?, ?,
                 'actionable', ?, ?, ?, ?, ?, ?)`,
    ).run(
      candidateId,
      candidateSha256,
      SHA,
      SHA,
      SHA,
      REVIEW_POLICY.policy_id,
      REVIEW_POLICY.policy_contract_sha256,
      REVIEW_POLICY.policy_consequence_text,
      REVIEW_POLICY.policy_consequence_sha256,
      stagingSyntheticMeetingCanaryCursorV1("canary-recovery"),
      canonicalSha256(canary),
      canonicalJson(canary),
      canonicalSha256(canaryDecisions),
      canonicalJson(canaryDecisions),
      ADVANCED_AT,
    );
    value.prepare(
      `INSERT INTO authority_live_source_review_lineage_heads_v2 (
         review_lineage_id, candidate_id, updated_at
       ) VALUES ('rli_canary-recovery', ?, ?)`,
    ).run(candidateId, ADVANCED_AT);
    value.prepare(
      `INSERT INTO authority_live_approval_outbox_v2 (
         candidate_id, approval_id, stage_command_id, state,
         provider_message_ts, frozen_card_sha256, approved_snapshot_json,
         approved_snapshot_sha256, post_started_at, control_approval_sha256,
         superseded_by_candidate_id, superseded_at, tombstoned_at, updated_at
       ) VALUES (?, ?, 'pas_canary-recovery', 'staged', '1.000001', ?, ?, ?,
                 ?, ?, NULL, NULL, NULL, ?)`,
    ).run(
      candidateId,
      approvalId,
      cardSha256,
      approvedSnapshotJson,
      approvedSnapshotSha256,
      ADVANCED_AT,
      SHA,
      ADVANCED_AT,
    );
    value.prepare(
      `INSERT INTO authority_private_approval_assignments_v3 (
         approval_id, candidate_id, candidate_sha256, frozen_card_sha256,
         approved_snapshot_sha256, connection_id, connection_contract_sha256,
         connection_state_sha256, external_identity_link_id,
         external_identity_link_contract_sha256, assignee_principal_id,
         assignee_membership_id, slack_workspace_id, slack_enterprise_id,
         slack_subject_id, slack_dm_channel_id, created_at
       ) VALUES (?, ?, ?, ?, ?, 'con_canary', ?, ?, 'clm_canary', ?,
                 'prn_test', 'mem_test', 'TCANARY', NULL, 'UCANARY',
                 'DCANARY', ?)`,
    ).run(
      approvalId,
      candidateId,
      candidateSha256,
      cardSha256,
      approvedSnapshotSha256,
      SHA,
      SHA,
      SHA,
      ADVANCED_AT,
    );

    await expect(state.readFrozenCandidateForSourceRevision({
      external_id: canary.provenance.external_id,
      canonical_revision: canary.provenance.canonical_revision,
    })).resolves.toMatchObject({
      candidate_id: candidateId,
      durable_staged_at: ADVANCED_AT,
      admission: {
        source: {
          adapter_id: "synthetic-staging-canary",
          instance_id: "staging",
          version: "1.0.0",
        },
      },
      meeting: canary,
      decisions: canaryDecisions,
    });

    const assignments = new SqlitePrivateSlackApprovalAssignmentStateV1(
      value,
      () => ADVANCED_AT,
    );
    const authority = new SqlitePrivateSlackApprovalTerminalAuthorityV1({
      source: state,
      assignments,
      coordinates: {
        authority_id: "oau_test",
        organization_id: "org_test",
        state_lineage_id: "lineage_test",
      },
    });
    const terminal: DurablePrivateApprovalTerminalV1 = {
      outcome: "rejected",
      signed_action_receipt_sha256: SHA,
      resolution: {
        schema_version: 1,
        kind: "echo-private-approval-resolution-v1",
        command_id: "command-canary-recovery",
        approval_id: approvalId,
        organization_id: "org_test",
        candidate_sha256: candidateSha256,
        frozen_card_sha256: cardSha256,
        approved_snapshot_sha256: approvedSnapshotSha256,
        final_approver: { principal_id: "prn_test", membership_id: "mem_test" },
        current_slack_identity_link: {
          provider: "slack",
          external_identity_link_id: "clm_canary",
          external_identity_link_contract_sha256: SHA,
          provider_subject_id: "UCANARY",
        },
        authorization_proof_sha256: SHA,
        action: "reject",
        comment: null,
        canonical_record_policy: null,
      },
      audit: {
        schema_version: 1,
        kind: "echo-private-approval-terminal-audit-v1",
        audit_event_id: "audit-canary-recovery",
        audit_sequence: 1,
        approval_id: approvalId,
        resolution_sha256: canonicalSha256({ approvalId, resolution: "rejected" }),
        outcome: "rejected",
        predecessor_entry_sha256: null,
        occurred_at: ADVANCED_AT,
      },
    };
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [],
        listDenied: () => [],
        listTerminals: () => [terminal],
        finalize: async () => terminal,
        recordDenied: () => undefined,
      },
      authority,
      record_writer: {
        appendApproved: async () => {
          throw new Error("rejected canary must not append V4");
        },
      },
      poster: { renderTerminal: async () => ({ kind: "done" }) },
    });

    await coordinator.recoverV4Appends(new AbortController().signal);
    expect(assignments.readTerminal(approvalId)).toMatchObject({
      candidate_id: candidateId,
      outcome: "rejected",
      card_render_state: "rendered",
    });
  });
});
