/**
 * Authority-side, stable read fence for a private Slack Block Kit approval.
 *
 * This adapter has no Slack transport and treats provider lookup values as
 * opaque hints. Control Plane proves the live provider presentation; this
 * fence proves only the server-owned Authority commitments in one SQLite
 * transaction before policy resolution is allowed.
 */
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND,
  validatePendingPrivateApprovalV1,
  validatePrivateApprovalSlackCardBindingV1,
  type ApprovalContractSha256,
  type PendingPrivateApprovalV1,
  type PrivateApprovalAuthorityFenceV1,
  type PrivateApprovalAuthorizationAllowV1,
  type PrivateApprovalSlackCardBindingV1,
  type StablePrivateApprovalAuthorityFenceV1,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import type Database from "better-sqlite3";
import {
  privateApprovalAssignmentCapabilitySha256V1,
  type PrivateApprovalCandidateCommitmentV1,
} from "./sqlite-private-approval-assignment-state-v1.js";

const AUTHORIZATION_PROOF_KIND =
  "echo-private-approval-authority-fence-proof-v1" as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

interface CandidateRow {
  readonly candidate_id: string;
  readonly candidate_semantic_sha256: string;
  readonly frozen_card_sha256: string | null;
  readonly approved_snapshot_sha256: string | null;
  readonly outbox_state: string;
  readonly provider_message_ts: string | null;
}

interface AssignmentRow {
  readonly approval_id: string;
  readonly candidate_id: string;
  readonly assignment_version: number;
  readonly assignment_json: string;
  readonly assignment_sha256: string;
  readonly connection_id: string;
  readonly connection_contract_sha256: string;
  readonly connection_state_sha256: string;
  readonly approval_binding_id: string;
  readonly approval_binding_contract_sha256: string;
  readonly external_identity_link_id: string;
  readonly external_identity_link_contract_sha256: string;
  readonly assignee_principal_id: string;
  readonly assignee_membership_id: string;
  readonly slack_workspace_id: string;
  readonly slack_enterprise_id: string | null;
  readonly slack_subject_id: string;
  readonly slack_dm_channel_id: string;
}

interface MetadataRow {
  readonly authority_id: string;
  readonly organization_id: string;
}

function parsedCanonical(value: string): unknown | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return canonicalJson(parsed) === value ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function digest(value: unknown): value is ApprovalContractSha256 {
  return typeof value === "string" && SHA256.test(value);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Opens an IMMEDIATE Authority transaction, preventing a candidate head,
 * outbox or membership change between the reproof and the caller's terminal
 * Control Plane commit. The callback receives only read-only proof methods.
 */
export class SqliteStablePrivateApprovalAuthorityFenceV1
  implements StablePrivateApprovalAuthorityFenceV1
{
  constructor(private readonly database: Database.Database) {}

  async withStablePrivateApprovalFence<T>(
    commit: (fence: PrivateApprovalAuthorityFenceV1) => Promise<T> | T,
  ): Promise<T> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = commit(Object.freeze({
        approvalIsCurrent: (
          input: Parameters<PrivateApprovalAuthorityFenceV1["approvalIsCurrent"]>[0],
        ) => this.approvalIsCurrent(input),
        currentMembership: (
          input: Parameters<PrivateApprovalAuthorityFenceV1["currentMembership"]>[0],
        ) => this.currentMembership(input),
        reprovePrivateApprovalAuthorization: (
          input: Parameters<
            PrivateApprovalAuthorityFenceV1["reprovePrivateApprovalAuthorization"]
          >[0],
        ) =>
          this.reprovePrivateApprovalAuthorization(input),
      }));
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        throw new Error(
          "stable private approval Authority fence callback must be synchronous",
        );
      }
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private approvalIsCurrent(input: {
    readonly approval_id: string;
    readonly candidate_sha256: ApprovalContractSha256;
  }): boolean {
    if (!digest(input.candidate_sha256) || typeof input.approval_id !== "string") {
      return false;
    }
    return this.currentCandidate(input.approval_id, input.candidate_sha256) !== undefined;
  }

  private currentMembership(input: {
    readonly principal_id: string;
    readonly membership_id: string;
  }): { readonly principal_id: string; readonly membership_id: string } | undefined {
    const row = this.database
      .prepare(
        `SELECT membership.principal_id, membership.membership_id
           FROM authority_memberships AS membership
           JOIN authority_metadata AS metadata
             ON metadata.singleton = 1
            AND metadata.organization_id = membership.organization_id
           JOIN authority_principals AS principal
             ON principal.principal_id = membership.principal_id
            AND principal.organization_id = metadata.organization_id
          WHERE membership.principal_id = ?
            AND membership.membership_id = ?
            AND membership.status = 'active'`,
      )
      .get(input.principal_id, input.membership_id) as
      | { principal_id: string; membership_id: string }
      | undefined;
    return row === undefined
      ? undefined
      : Object.freeze({
          principal_id: row.principal_id,
          membership_id: row.membership_id,
        });
  }

  private reprovePrivateApprovalAuthorization(input: {
    readonly pending: PendingPrivateApprovalV1;
    readonly card_binding: PrivateApprovalSlackCardBindingV1;
    readonly lookup: unknown;
  }): PrivateApprovalAuthorizationAllowV1 | undefined {
    // Provider lookup values are intentionally unused here. They are only
    // independently reproved by the Control Plane's Slack presentation fence.
    void input.lookup;
    let pending: PendingPrivateApprovalV1;
    let card: PrivateApprovalSlackCardBindingV1;
    try {
      pending = validatePendingPrivateApprovalV1(input.pending);
      card = validatePrivateApprovalSlackCardBindingV1(input.card_binding);
    } catch {
      return undefined;
    }
    if (
      card.approval_id !== pending.approval_id ||
      card.assignment_version !== pending.assignment.assignment_version ||
      card.card_sha256 !== pending.frozen_card_sha256 ||
      card.slack_subject_id !==
        pending.assignment.current_slack_identity_link.provider_subject_id
    ) {
      return undefined;
    }
    const metadata = this.database
      .prepare(
        `SELECT authority_id, organization_id
           FROM authority_metadata WHERE singleton = 1`,
      )
      .get() as MetadataRow | undefined;
    if (metadata === undefined || metadata.organization_id !== pending.organization_id) {
      return undefined;
    }
    const candidate = this.currentCandidate(
      pending.approval_id,
      pending.candidate_sha256,
    );
    if (
      candidate === undefined ||
      candidate.frozen_card_sha256 !== pending.frozen_card_sha256 ||
      candidate.approved_snapshot_sha256 !== pending.approved_snapshot_sha256 ||
      candidate.provider_message_ts !== card.provider_message_ts
    ) {
      return undefined;
    }
    const assignment = this.assignment(pending.approval_id);
    if (assignment === undefined || !this.assignmentMatches(assignment, pending, card)) {
      return undefined;
    }
    const active = this.currentMembership(pending.assignment.current_assignee);
    if (active === undefined) return undefined;

    const candidateCommitment: PrivateApprovalCandidateCommitmentV1 = Object.freeze({
      approval_id: pending.approval_id,
      candidate_id: candidate.candidate_id,
      candidate_sha256: pending.candidate_sha256,
      frozen_card_sha256: pending.frozen_card_sha256,
      approved_snapshot_sha256: pending.approved_snapshot_sha256,
    });
    let expectedCapability: ApprovalContractSha256;
    try {
      expectedCapability = privateApprovalAssignmentCapabilitySha256V1({
        organization_id: metadata.organization_id,
        candidate: candidateCommitment,
        assignment_version: pending.assignment.assignment_version,
        current_assignee: pending.assignment.current_assignee,
        current_slack_identity_link:
          pending.assignment.current_slack_identity_link,
      });
    } catch {
      return undefined;
    }
    if (expectedCapability !== pending.assignment.assignment_capability_sha256) {
      return undefined;
    }
    const proof = canonicalSha256({
      schema_version: 1,
      kind: AUTHORIZATION_PROOF_KIND,
      authority_id: metadata.authority_id,
      organization_id: metadata.organization_id,
      candidate: Object.freeze({
        candidate_id: candidate.candidate_id,
        candidate_semantic_sha256: candidate.candidate_semantic_sha256,
        frozen_card_sha256: candidate.frozen_card_sha256,
        approved_snapshot_sha256: candidate.approved_snapshot_sha256,
        outbox_state: candidate.outbox_state,
        provider_message_ts: candidate.provider_message_ts,
      }),
      assignment: Object.freeze({
        approval_id: assignment.approval_id,
        candidate_id: assignment.candidate_id,
        assignment_json: assignment.assignment_json,
        assignment_sha256: assignment.assignment_sha256,
        connection_id: assignment.connection_id,
        connection_contract_sha256: assignment.connection_contract_sha256,
        connection_state_sha256: assignment.connection_state_sha256,
        approval_binding_id: assignment.approval_binding_id,
        approval_binding_contract_sha256:
          assignment.approval_binding_contract_sha256,
        external_identity_link_id: assignment.external_identity_link_id,
        external_identity_link_contract_sha256:
          assignment.external_identity_link_contract_sha256,
        assignee_principal_id: assignment.assignee_principal_id,
        assignee_membership_id: assignment.assignee_membership_id,
        slack_workspace_id: assignment.slack_workspace_id,
        slack_enterprise_id: assignment.slack_enterprise_id,
        slack_subject_id: assignment.slack_subject_id,
        slack_dm_channel_id: assignment.slack_dm_channel_id,
      }),
      pending,
      card_binding: card,
      active_membership: active,
    }) as ApprovalContractSha256;
    return Object.freeze({
      schema_version: 1,
      kind: PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND,
      approval_id: pending.approval_id,
      organization_id: metadata.organization_id,
      candidate_sha256: pending.candidate_sha256,
      frozen_card_sha256: pending.frozen_card_sha256,
      approved_snapshot_sha256: pending.approved_snapshot_sha256,
      assignment_version: pending.assignment.assignment_version,
      authorized_assignee: active,
      current_slack_identity_link: pending.assignment.current_slack_identity_link,
      assignment_capability_sha256: expectedCapability,
      authorization_proof_sha256: proof,
    });
  }

  private currentCandidate(
    approvalId: string,
    candidateSha256: ApprovalContractSha256,
  ): CandidateRow | undefined {
    return this.database
      .prepare(
        `SELECT candidate.candidate_id, candidate.candidate_semantic_sha256,
                outbox.frozen_card_sha256, outbox.approved_snapshot_sha256,
                outbox.state AS outbox_state, outbox.provider_message_ts
           FROM authority_clean_live_candidates_v1 AS candidate
           JOIN authority_clean_live_approval_outbox_v1 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
           JOIN authority_clean_live_review_lineage_heads_v1 AS head
             ON head.review_lineage_id = candidate.review_lineage_id
          WHERE outbox.approval_id = ?
            AND candidate.candidate_semantic_sha256 = ?
            AND candidate.disposition = 'actionable'
            AND outbox.state != 'superseded'
            AND head.candidate_id = candidate.candidate_id`,
      )
      .get(approvalId, candidateSha256) as CandidateRow | undefined;
  }

  private assignment(approvalId: string): AssignmentRow | undefined {
    return this.database
      .prepare(
        `SELECT approval_id, candidate_id, assignment_version, assignment_json,
                assignment_sha256, connection_id, connection_contract_sha256,
                connection_state_sha256, approval_binding_id,
                approval_binding_contract_sha256, external_identity_link_id,
                external_identity_link_contract_sha256, assignee_principal_id,
                assignee_membership_id, slack_workspace_id, slack_enterprise_id,
                slack_subject_id, slack_dm_channel_id
           FROM authority_private_approval_assignments_v2
          WHERE approval_id = ?`,
      )
      .get(approvalId) as AssignmentRow | undefined;
  }

  private assignmentMatches(
    assignment: AssignmentRow,
    pending: PendingPrivateApprovalV1,
    card: PrivateApprovalSlackCardBindingV1,
  ): boolean {
    const stored = parsedCanonical(assignment.assignment_json);
    return (
      stored !== undefined &&
      digest(assignment.assignment_sha256) &&
      canonicalSha256(stored) === assignment.assignment_sha256 &&
      same(stored, pending.assignment) &&
      assignment.candidate_id === this.currentCandidate(pending.approval_id, pending.candidate_sha256)?.candidate_id &&
      assignment.assignment_version === pending.assignment.assignment_version &&
      assignment.connection_id === card.connection_id &&
      assignment.connection_contract_sha256 === card.connection_contract_sha256 &&
      assignment.connection_state_sha256 === card.connection_state_sha256 &&
      assignment.approval_binding_id === card.approval_surface_binding_id &&
      assignment.approval_binding_contract_sha256 ===
        card.approval_surface_binding_contract_sha256 &&
      assignment.external_identity_link_id ===
        pending.assignment.current_slack_identity_link.external_identity_link_id &&
      assignment.external_identity_link_contract_sha256 ===
        pending.assignment.current_slack_identity_link
          .external_identity_link_contract_sha256 &&
      assignment.assignee_principal_id ===
        pending.assignment.current_assignee.principal_id &&
      assignment.assignee_membership_id ===
        pending.assignment.current_assignee.membership_id &&
      assignment.slack_workspace_id === card.slack_workspace_id &&
      assignment.slack_enterprise_id === card.slack_enterprise_id &&
      assignment.slack_subject_id === card.slack_subject_id &&
      assignment.slack_dm_channel_id === card.dm_channel_id
    );
  }
}
