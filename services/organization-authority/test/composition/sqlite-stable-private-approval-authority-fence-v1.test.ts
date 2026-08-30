import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  PRIVATE_APPROVAL_PENDING_KIND,
  type PendingPrivateApprovalV1,
  type PrivateApprovalSlackCardBindingV1,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import { describe, expect, it } from "vitest";
import { applyAuthorityBaselineV3 } from "../../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../../src/adapters/persistence/sqlite/open-authority-database.js";
import type { PrivateSlackApprovalReviewerTargetV1 } from "../../src/composition/resolve-private-slack-approval-reviewer-target-v1.js";
import {
  SqlitePrivateSlackApprovalAssignmentStateV1,
  type PrivateApprovalCandidateCommitmentV1,
} from "../../src/composition/sqlite-private-slack-approval-assignment-state-v1.js";
import { SqliteStablePrivateApprovalAuthorityFenceV1 } from "../../src/composition/sqlite-stable-private-approval-authority-fence-v1.js";

const NOW = "2026-08-28T00:00:00.000Z";
const ORGANIZATION_ID = "org_private";
const AUTHORITY_ID = "oau_private";
const APPROVAL_ID = "apr_private";
const CANDIDATE_ID = "cnd_private";
const CANDIDATE_SHA256 = canonicalSha256({ candidate: "private" });
const FROZEN_CARD_SHA256 = canonicalSha256({ card: "private" });
const SNAPSHOT = { snapshot: "private" };
const SNAPSHOT_SHA256 = canonicalSha256(SNAPSHOT);
const CONNECTION_CONTRACT_SHA256 = canonicalSha256({ connection: "contract" });
const CONNECTION_STATE_SHA256 = canonicalSha256({ connection: "state" });
const LINK_CONTRACT_SHA256 = canonicalSha256({ link: "contract" });
const MESSAGE_TS = "1724803200.000001";

function candidate(): PrivateApprovalCandidateCommitmentV1 {
  return {
    approval_id: APPROVAL_ID,
    candidate_id: CANDIDATE_ID,
    candidate_sha256: CANDIDATE_SHA256,
    frozen_card_sha256: FROZEN_CARD_SHA256,
    approved_snapshot_sha256: SNAPSHOT_SHA256,
  };
}

function fixture(): {
  readonly database: ReturnType<typeof openAuthorityDatabase>;
  readonly pending: PendingPrivateApprovalV1;
  readonly card: PrivateApprovalSlackCardBindingV1;
} {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV3(database);
  database.pragma("foreign_keys = OFF");
  database
    .prepare(
      `INSERT INTO authority_metadata
         (singleton, authority_id, organization_id, organization_display_name,
          descriptor_json, created_at, last_observed_at)
       VALUES (1, ?, ?, 'Private', '{}', ?, ?)`,
    )
    .run(AUTHORITY_ID, ORGANIZATION_ID, NOW, NOW);
  database
    .prepare(
      `INSERT INTO authority_principals
         (principal_id, organization_id, display_name, provisioned_at)
       VALUES ('prn_owner', ?, 'Owner', ?)`,
    )
    .run(ORGANIZATION_ID, NOW);
  database
    .prepare(
      `INSERT INTO authority_memberships
         (membership_id, organization_id, principal_id, membership_type,
          status, provisioned_at, revoked_at, revocation_reason,
          employee_email, employee_email_sha256)
       VALUES ('mem_owner', ?, 'prn_owner', 'owner', 'active', ?, NULL, NULL,
               NULL, NULL)`,
    )
    .run(ORGANIZATION_ID, NOW);
  database
    .prepare(
      `INSERT INTO authority_live_source_candidates_v2 (
         candidate_id, candidate_semantic_sha256,
         admission_semantic_input_sha256, review_lineage_id,
         review_input_sha256, review_semantic_sha256, review_policy_id,
         review_policy_contract_sha256, review_policy_consequence_text,
         review_policy_consequence_sha256, disposition, source_cursor,
         meeting_sha256, meeting_json, decisions_sha256, decisions_json, created_at
       ) VALUES (?, ?, ?, 'rli_private', ?, ?, 'review-policy', ?, 'review', ?,
                 'actionable', 'granola:v1:live:private', ?, '{}', ?, '{}', ?)`,
    )
    .run(
      CANDIDATE_ID,
      CANDIDATE_SHA256,
      canonicalSha256({ admission: "private" }),
      canonicalSha256({ review_input: "private" }),
      canonicalSha256({ review_semantic: "private" }),
      canonicalSha256({ review_contract: "private" }),
      canonicalSha256({ review_consequence: "private" }),
      canonicalSha256({ meeting: "private" }),
      canonicalSha256({ decisions: "private" }),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO authority_live_source_review_lineage_heads_v2
         (review_lineage_id, candidate_id, updated_at)
       VALUES ('rli_private', ?, ?)`,
    )
    .run(CANDIDATE_ID, NOW);
  database
    .prepare(
      `INSERT INTO authority_live_approval_outbox_v2
         (candidate_id, approval_id, stage_command_id, state, updated_at)
       VALUES (?, ?, 'pas_private', 'queued', ?)`,
    )
    .run(CANDIDATE_ID, APPROVAL_ID, NOW);
  const assignments = new SqlitePrivateSlackApprovalAssignmentStateV1(database, () => NOW);
  const staged = assignments.stage({
    candidate: candidate(),
    reviewer_target: {
      reviewer: {
        principal_id: "prn_owner",
        membership_id: "mem_owner",
        membership_type: "owner",
      },
      slack_target: {
        connection: {
          body: {
            organization_id: ORGANIZATION_ID,
            connection_id: "con_private",
            provider_tenant_id: "TPRIVATE",
            provider_enterprise_id: null,
          },
          sha256: CONNECTION_CONTRACT_SHA256,
        },
        connection_state: { sha256: CONNECTION_STATE_SHA256 },
        current_slack_identity_link: {
          provider: "slack",
          external_identity_link_id: "clm_owner",
          external_identity_link_contract_sha256: LINK_CONTRACT_SHA256,
          provider_subject_id: "UOWNER",
        },
      },
    } as unknown as PrivateSlackApprovalReviewerTargetV1,
    dm_channel: {
      workspace_id: "TPRIVATE",
      enterprise_id: null,
      channel_id: "DPRIVATE",
    },
  });
  database
    .prepare(
      `UPDATE authority_live_approval_outbox_v2
          SET state = 'posting', frozen_card_sha256 = ?,
              approved_snapshot_json = ?, approved_snapshot_sha256 = ?,
              post_started_at = ?
        WHERE approval_id = ?`,
    )
    .run(FROZEN_CARD_SHA256, canonicalJson(SNAPSHOT), SNAPSHOT_SHA256, NOW, APPROVAL_ID);
  database
    .prepare(
      `UPDATE authority_live_approval_outbox_v2
          SET state = 'posted', provider_message_ts = ?
        WHERE approval_id = ?`,
    )
    .run(MESSAGE_TS, APPROVAL_ID);
  const pending: PendingPrivateApprovalV1 = {
    schema_version: 1,
    kind: PRIVATE_APPROVAL_PENDING_KIND,
    approval_id: APPROVAL_ID,
    organization_id: ORGANIZATION_ID,
    candidate_sha256: CANDIDATE_SHA256,
    frozen_card_sha256: FROZEN_CARD_SHA256,
    approved_snapshot_sha256: SNAPSHOT_SHA256,
    assigned_owner: staged.assignment.assigned_owner,
    assigned_owner_slack_identity_link:
      staged.assignment.assigned_owner_slack_identity_link,
  };
  const card: PrivateApprovalSlackCardBindingV1 = {
    schema_version: 1,
    kind: "echo-private-approval-slack-card-binding-v1",
    approval_id: APPROVAL_ID,
    connection_id: "con_private",
    connection_contract_sha256: CONNECTION_CONTRACT_SHA256,
    connection_state_sha256: CONNECTION_STATE_SHA256,
    slack_workspace_id: "TPRIVATE",
    slack_enterprise_id: null,
    slack_subject_id: "UOWNER",
    dm_channel_id: "DPRIVATE",
    provider_message_ts: MESSAGE_TS,
    card_sha256: FROZEN_CARD_SHA256,
  };
  return { database, pending, card };
}

function lookup() {
  return {
    api_app_id: "AWRONG",
    workspace_id: "TWRONG",
    enterprise_id: null,
    slack_user_id: "UWRONG",
    channel_id: "DWRONG",
    message_ts: "1.1",
    message_user_id: "UWRONG",
    message_app_id: "AWRONG",
    message_bot_id: "BWRONG",
  };
}

describe("SQLite stable private approval Authority fence v1", () => {
  it("reproves all Authority-owned commitments under one stable transaction", async () => {
    const { database, pending, card } = fixture();
    try {
      const fence = new SqliteStablePrivateApprovalAuthorityFenceV1(database);
      const first = await fence.withStablePrivateApprovalFence((stable) => {
        expect(database.inTransaction).toBe(true);
        expect(
          stable.approvalIsCurrent({
            approval_id: APPROVAL_ID,
            candidate_sha256: CANDIDATE_SHA256,
          }),
        ).toBe(true);
        expect(stable.currentMembership({ principal_id: "prn_owner", membership_id: "mem_owner" })).toEqual({
          principal_id: "prn_owner",
          membership_id: "mem_owner",
        });
        // Deliberately mismatched provider hints cannot introduce an Authority
        // actor. They are checked only by the Control Plane presentation fence.
        return stable.reprovePrivateApprovalAuthorization({
          pending,
          card_binding: card,
          lookup: lookup(),
        });
      });
      expect(database.inTransaction).toBe(false);
      expect(first).toMatchObject({
        approval_id: APPROVAL_ID,
        organization_id: ORGANIZATION_ID,
        authorized_assignee: { principal_id: "prn_owner", membership_id: "mem_owner" },
        current_slack_identity_link: pending.assigned_owner_slack_identity_link,
      });
      const second = await fence.withStablePrivateApprovalFence((stable) =>
        stable.reprovePrivateApprovalAuthorization({
          pending,
          card_binding: card,
          lookup: lookup(),
        }),
      );
      expect(second?.authorization_proof_sha256).toBe(
        first?.authorization_proof_sha256,
      );
      await expect(
        fence.withStablePrivateApprovalFence(() => Promise.resolve(undefined)),
      ).rejects.toThrow("callback must be synchronous");
      expect(database.inTransaction).toBe(false);
    } finally {
      database.close();
    }
  });

  it("fails closed on stale membership, candidate, and private-card commitments", async () => {
    const { database, pending, card } = fixture();
    try {
      const fence = new SqliteStablePrivateApprovalAuthorityFenceV1(database);
      await fence.withStablePrivateApprovalFence((stable) => {
        expect(
          stable.approvalIsCurrent({
            approval_id: APPROVAL_ID,
            candidate_sha256: canonicalSha256({ candidate: "other" }),
          }),
        ).toBe(false);
        expect(stable.currentMembership({ principal_id: "prn_owner", membership_id: "mem_other" })).toBeUndefined();
        expect(
          stable.reprovePrivateApprovalAuthorization({
            pending,
            card_binding: { ...card, dm_channel_id: "DDIFFERENT" },
            lookup: lookup(),
          }),
        ).toBeUndefined();
      });
      database
        .prepare(
          `UPDATE authority_memberships
              SET status = 'revoked', revoked_at = ?, revocation_reason = 'test'
            WHERE membership_id = 'mem_owner'`,
        )
        .run(NOW);
      await expect(
        fence.withStablePrivateApprovalFence((stable) =>
          stable.reprovePrivateApprovalAuthorization({
            pending,
            card_binding: card,
            lookup: lookup(),
          }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      database.close();
    }
  });
});
