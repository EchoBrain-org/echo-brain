import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type PrivateApprovalResolutionV1,
} from "@echo-brain/organization-control-plane/slack-approval-integration-v1";
import { describe, expect, it } from "vitest";
import {
  applyAuthorityBaselineV3,
} from "../../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../../src/adapters/persistence/sqlite/open-authority-database.js";
import type { PrivateSlackApprovalReviewerTargetV1 } from "../../src/composition/resolve-private-slack-approval-reviewer-target-v1.js";
import {
  SqlitePrivateSlackApprovalAssignmentStateV1,
  type PrivateApprovalCandidateCommitmentV1,
  type CanonicalPrivateApprovalV4ReceiptV1,
  type StagePrivateApprovalAssignmentInputV1,
} from "../../src/composition/sqlite-private-slack-approval-assignment-state-v1.js";

const NOW = "2026-08-28T00:00:00.000Z";
const ORGANIZATION_ID = "org_private";
const APPROVAL_ID = "apr_private";
const CANDIDATE_ID = "cnd_private";
const CANDIDATE_SHA256 = canonicalSha256({ candidate: "private" });
const FROZEN_CARD_SHA256 = canonicalSha256({ card: "private" });
const SNAPSHOT_SHA256 = canonicalSha256({});
const CONNECTION_CONTRACT_SHA256 = canonicalSha256({ connection: "contract" });
const CONNECTION_STATE_SHA256 = canonicalSha256({ connection: "state" });
const LINK_CONTRACT_SHA256 = canonicalSha256({ link: "contract" });

function fixture() {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV3(database);
  database.pragma("foreign_keys = OFF");
  database
    .prepare(
      `INSERT INTO authority_metadata
         (singleton, authority_id, organization_id, organization_display_name,
          descriptor_json, created_at, last_observed_at)
       VALUES (1, 'authority_private', ?, 'Private', '{}', ?, ?)`,
    )
    .run(ORGANIZATION_ID, NOW, NOW);
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
         (candidate_id, approval_id, stage_command_id, state,
          provider_message_ts, frozen_card_sha256, approved_snapshot_json,
          approved_snapshot_sha256, post_started_at, updated_at)
       VALUES (?, ?, 'pas_private', 'posted', '1.000001', ?, '{}', ?, ?, ?)`,
    )
    .run(CANDIDATE_ID, APPROVAL_ID, FROZEN_CARD_SHA256, SNAPSHOT_SHA256, NOW, NOW);
  return database;
}

function supersede(database: ReturnType<typeof fixture>): void {
  database
    .prepare(
      `INSERT INTO authority_live_source_candidates_v2 (
         candidate_id, candidate_semantic_sha256,
         admission_semantic_input_sha256, review_lineage_id,
         review_input_sha256, review_semantic_sha256, review_policy_id,
         review_policy_contract_sha256, review_policy_consequence_text,
         review_policy_consequence_sha256, disposition, source_cursor,
         meeting_sha256, meeting_json, decisions_sha256, decisions_json, created_at
       ) VALUES ('cnd_successor', ?, ?, 'rli_private', ?, ?, 'review-policy', ?,
                 'review', ?, 'actionable', 'granola:v1:live:successor', ?,
                 '{"successor":true}', ?, '{"successor":true}', ?)`,
    )
    .run(
      canonicalSha256({ candidate: "successor" }),
      canonicalSha256({ admission: "successor" }),
      canonicalSha256({ review_input: "successor" }),
      canonicalSha256({ review_semantic: "successor" }),
      canonicalSha256({ review_contract: "successor" }),
      canonicalSha256({ review_consequence: "successor" }),
      canonicalSha256({ meeting: "successor" }),
      canonicalSha256({ decisions: "successor" }),
      NOW,
    );
  database
    .prepare(
      `UPDATE authority_live_source_review_lineage_heads_v2
          SET candidate_id = 'cnd_successor', updated_at = ?
        WHERE review_lineage_id = 'rli_private'`,
    )
    .run(NOW);
  database
    .prepare(
      `UPDATE authority_live_approval_outbox_v2
          SET state = 'superseded', superseded_by_candidate_id = 'cnd_successor',
              superseded_at = ?, updated_at = ?
        WHERE approval_id = ?`,
    )
    .run(NOW, NOW, APPROVAL_ID);
}

function candidate(): PrivateApprovalCandidateCommitmentV1 {
  return {
    approval_id: APPROVAL_ID,
    candidate_id: CANDIDATE_ID,
    candidate_sha256: CANDIDATE_SHA256,
    frozen_card_sha256: FROZEN_CARD_SHA256,
    approved_snapshot_sha256: SNAPSHOT_SHA256,
  };
}

function input(
  overrides: Partial<StagePrivateApprovalAssignmentInputV1> = {},
): StagePrivateApprovalAssignmentInputV1 {
  return {
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
    ...overrides,
  };
}

function rejection(): PrivateApprovalResolutionV1 {
  return {
    schema_version: 1,
    kind: "echo-private-approval-resolution-v1",
    command_id: "cmd_reject",
    approval_id: APPROVAL_ID,
    organization_id: ORGANIZATION_ID,
    candidate_sha256: CANDIDATE_SHA256,
    frozen_card_sha256: FROZEN_CARD_SHA256,
    approved_snapshot_sha256: SNAPSHOT_SHA256,
    final_approver: { principal_id: "prn_owner", membership_id: "mem_owner" },
    current_slack_identity_link: {
      provider: "slack",
      external_identity_link_id: "clm_owner",
      external_identity_link_contract_sha256: LINK_CONTRACT_SHA256,
      provider_subject_id: "UOWNER",
    },
    authorization_proof_sha256: canonicalSha256({ authorization: "reject" }),
    action: "reject",
    comment: "Not ready",
    canonical_record_policy: null,
  };
}

function approval(): PrivateApprovalResolutionV1 {
  return {
    ...rejection(),
    command_id: "cmd_approve",
    action: "approve",
    canonical_record_policy: {
      policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      policy_contract_sha256: RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
      policy_consequence_sha256: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
      restricted_reader: {
        principal_id: "prn_owner",
        membership_id: "mem_owner",
      },
    },
  };
}

function approvedReceipt(): CanonicalPrivateApprovalV4ReceiptV1 {
  const recordSha256 = canonicalSha256({ record: "approved" });
  const body = {
    schema_version: 2 as const,
    kind: "echo-organization-record-receipt-v2" as const,
    authority_id: "authority_private",
    organization_id: ORGANIZATION_ID,
    state_lineage_id: "lineage_private",
    envelope_id: "envelope_private",
    semantic_idempotency_key: canonicalSha256({ idempotency: "approved" }),
    event_kind: "approved" as const,
    record_position: 1,
    record_sha256: recordSha256,
    predecessor_record_sha256: null,
    record_head_position: 1,
    record_head_sha256: recordSha256,
    issued_at: NOW,
    policy_fact_outcome: {
      kind: "appended" as const,
      policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    },
  };
  return {
    body,
    receipt_sha256: canonicalSha256(body),
    signing_key_descriptor: {},
    signature: "opaque-v4-receipt-signature",
  };
}

describe("SQLite private approval assignment state v1", () => {
  it("stages one immutable current-owner assignment and replays only exact input", () => {
    const database = fixture();
    try {
      const state = new SqlitePrivateSlackApprovalAssignmentStateV1(database, () => NOW);
      const first = state.stage(input());
      expect(first.created).toBe(true);
      expect(first.assignment.assigned_owner).toEqual({
        principal_id: "prn_owner",
        membership_id: "mem_owner",
      });
      expect(state.stage(input())).toEqual({
        assignment: first.assignment,
        created: false,
      });
      expect(state.readCurrent(candidate())).toEqual(first.assignment);
      expect(() =>
        state.stage(
          input({
            dm_channel: {
              workspace_id: "TPRIVATE",
              enterprise_id: null,
              channel_id: "DDIFFERENT",
            },
          }),
        ),
      ).toThrow(/immutable assignment/);
    } finally {
      database.close();
    }
  });

  it("fails closed before assignment creation for a stale source candidate", () => {
    const database = fixture();
    try {
      const state = new SqlitePrivateSlackApprovalAssignmentStateV1(database, () => NOW);
      expect(() =>
        state.stage(
          input({
            candidate: {
              ...candidate(),
              candidate_sha256: canonicalSha256({ candidate: "stale" }),
            },
          }),
        ),
      ).toThrow(/candidate is not current/);
      expect(
        database
          .prepare("SELECT count(*) AS count FROM authority_private_approval_assignments_v3")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("fails closed when a stored direct owner identifier is corrupted", () => {
    const database = fixture();
    try {
      const state = new SqlitePrivateSlackApprovalAssignmentStateV1(database, () => NOW);
      state.stage(input());
      database.exec(
        "DROP TRIGGER authority_private_approval_assignments_v3_immutable_update",
      );
      database
        .prepare(
          `UPDATE authority_private_approval_assignments_v3
              SET assignee_principal_id = 'prn_💥'
            WHERE approval_id = ?`,
        )
        .run(APPROVAL_ID);
      expect(() => state.readCurrent(candidate())).toThrow(
        /stored assignee principal id must be a bounded canonical identifier/,
      );
    } finally {
      database.close();
    }
  });

  it("reconstructs a superseded card only for presentation, and refuses corrupted frozen evidence", () => {
    const database = fixture();
    try {
      const state = new SqlitePrivateSlackApprovalAssignmentStateV1(database, () => NOW);
      const staged = state.stage(input()).assignment;
      supersede(database);
      expect(state.readCurrent(candidate())).toBeUndefined();
      expect(state.readForPresentation(APPROVAL_ID)).toEqual({
        assignment: staged,
        provider_message_ts: "1.000001",
        source_outbox_state: "superseded",
      });
      database.exec(
        "DROP TRIGGER authority_live_approval_outbox_v2_ordered_transition",
      );
      database
        .prepare(
          `UPDATE authority_live_approval_outbox_v2
              SET frozen_card_sha256 = ?
            WHERE approval_id = ?`,
        )
        .run(canonicalSha256({ card: "corrupt" }), APPROVAL_ID);
      expect(() => state.readForPresentation(APPROVAL_ID)).toThrow(
        /stored assignment differs from its candidate commitment/,
      );
    } finally {
      database.close();
    }
  });

  it("records and replays a rejection without a V4 receipt, then advances only the card projection", () => {
    const database = fixture();
    try {
      const state = new SqlitePrivateSlackApprovalAssignmentStateV1(database, () => NOW);
      state.stage(input());
      const durable = state.recordTerminal({
        candidate_id: CANDIDATE_ID,
        resolution: rejection(),
      });
      expect(durable).toMatchObject({
        outcome: "rejected",
        v4_receipt: null,
        card_render_state: "unrendered",
      });
      expect(
        state.recordTerminal({
          candidate_id: CANDIDATE_ID,
          resolution: rejection(),
        }),
      ).toEqual(durable);
      expect(state.markTerminalCardRendered(APPROVAL_ID)).toMatchObject({
        card_render_state: "rendered",
        card_rendered_at: NOW,
      });
      expect(state.markTerminalCardRendered(APPROVAL_ID)).toMatchObject({
        card_render_state: "rendered",
        card_rendered_at: NOW,
      });
    } finally {
      database.close();
    }
  });

  it("completes a terminal committed before supersession from frozen evidence", () => {
    const database = fixture();
    try {
      const state = new SqlitePrivateSlackApprovalAssignmentStateV1(database, () => NOW);
      state.stage(input());
      // Finalization is fenced while this candidate is current. A later
      // source revision must not strand its already durable terminal.
      supersede(database);
      expect(
        state.recordTerminal({
          candidate_id: CANDIDATE_ID,
          resolution: rejection(),
        }),
      ).toMatchObject({
        outcome: "rejected",
        card_render_state: "unrendered",
      });
    } finally {
      database.close();
    }
  });

  it("records an approved V4 receipt after supersession from the same frozen tuple", () => {
    const database = fixture();
    try {
      const state = new SqlitePrivateSlackApprovalAssignmentStateV1(database, () => NOW);
      state.stage(input());
      supersede(database);
      expect(
        state.recordTerminal({
          candidate_id: CANDIDATE_ID,
          resolution: approval(),
          v4_receipt: approvedReceipt(),
        }),
      ).toMatchObject({
        outcome: "approved",
        v4_receipt: approvedReceipt(),
      });
    } finally {
      database.close();
    }
  });

  it("requires and preserves one canonical V4 receipt for approval", () => {
    const database = fixture();
    try {
      const state = new SqlitePrivateSlackApprovalAssignmentStateV1(database, () => NOW);
      state.stage(input());
      const resolution = approval();
      expect(() =>
        state.recordTerminal({ candidate_id: CANDIDATE_ID, resolution }),
      ).toThrow(/V4 receipt/);
      const receipt = approvedReceipt();
      expect(
        state.recordTerminal({
          candidate_id: CANDIDATE_ID,
          resolution,
          v4_receipt: receipt,
        }),
      ).toMatchObject({
        outcome: "approved",
        v4_receipt: receipt,
      });
    } finally {
      database.close();
    }
  });
});
