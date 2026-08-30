import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  type ApprovalContractSha256,
  type PersonApprovalPolicyId,
} from "../application/person-slack-reaction-approval-contracts-v2.js";
import type { ReprovedFrozenPersonSlackReactionApprovalV2 } from "../application/person-slack-reaction-approval-finalization-v2.js";
import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import type Database from "better-sqlite3";

const COMMAND_KIND = "echo-person-slack-pending-approval-command-v1" as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const APPROVAL_ID = /^apr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/;
const COMMAND_ID = /^pas_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/;

export interface StagePersonSlackReactionApprovalPendingCommandV1 {
  readonly command_id: string;
  readonly approval: ReprovedFrozenPersonSlackReactionApprovalV2;
}

export interface StagedPersonSlackReactionApprovalPendingV1 {
  readonly command_id: string;
  readonly command_semantic_sha256: ApprovalContractSha256;
  readonly approval: ReprovedFrozenPersonSlackReactionApprovalV2;
  readonly approval_sha256: ApprovalContractSha256;
  readonly idempotent: boolean;
}

export class PersonSlackReactionApprovalPendingConflictError extends Error {
  constructor(message = "pending Person Slack reaction approval command conflicts") {
    super(message);
    this.name = "PersonSlackReactionApprovalPendingConflictError";
  }
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pending Person Slack reaction approval is invalid");
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new Error("pending Person Slack reaction approval is invalid");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("pending Person Slack reaction approval has unexpected fields");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    throw new Error(`pending Person Slack reaction approval ${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): ApprovalContractSha256 {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`pending Person Slack reaction approval ${label} is invalid`);
  }
  return value as ApprovalContractSha256;
}

function policyCommitment(
  policy: PersonApprovalPolicyId,
): readonly [ApprovalContractSha256, ApprovalContractSha256] {
  return policy === "organization-member-readable-person-v2"
    ? [
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
        ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
      ]
    : [
        RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
        RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
      ];
}

/** Validates only the frozen tuple consumed by the finalization primitive. */
export function validateReprovedPersonSlackPendingApprovalV1(
  value: unknown,
): ReprovedFrozenPersonSlackReactionApprovalV2 {
  const record = exact(value, [
    "authority_id",
    "organization_id",
    "state_lineage_id",
    "approval_id",
    "status",
    "connection_id",
    "connection_contract_sha256",
    "approval_binding_id",
    "approval_binding_contract_sha256",
    "approval_channel_id",
    "provider_message_ts",
    "policy_id",
    "policy_contract_sha256",
    "policy_consequence_sha256",
    "frozen_card_sha256",
    "approved_snapshot_sha256",
  ]);
  for (const field of [
    "authority_id",
    "organization_id",
    "state_lineage_id",
    "connection_id",
    "approval_binding_id",
    "approval_channel_id",
    "provider_message_ts",
  ]) {
    text(record[field], field);
  }
  const approvalId = text(record.approval_id, "approval_id");
  if (!APPROVAL_ID.test(approvalId) || record.status !== "pending") {
    throw new Error("pending Person Slack reaction approval identity is invalid");
  }
  const policy = record.policy_id;
  if (
    policy !== "organization-member-readable-person-v2" &&
    policy !== "restricted-reviewer-person-v2"
  ) {
    throw new Error("pending Person Slack reaction approval policy is invalid");
  }
  for (const field of [
    "connection_contract_sha256",
    "approval_binding_contract_sha256",
    "policy_contract_sha256",
    "policy_consequence_sha256",
    "frozen_card_sha256",
    "approved_snapshot_sha256",
  ]) {
    digest(record[field], field);
  }
  const [policyContract, policyConsequence] = policyCommitment(policy);
  if (
    record.policy_contract_sha256 !== policyContract ||
    record.policy_consequence_sha256 !== policyConsequence
  ) {
    throw new Error(
      "pending Person Slack reaction approval policy commitment is invalid",
    );
  }
  return Object.freeze({
    ...record,
  }) as unknown as ReprovedFrozenPersonSlackReactionApprovalV2;
}

function commandSemantic(
  approval: ReprovedFrozenPersonSlackReactionApprovalV2,
): ApprovalContractSha256 {
  return canonicalSha256({ kind: COMMAND_KIND, approval });
}

function result(
  commandId: string,
  semantic: ApprovalContractSha256,
  approval: ReprovedFrozenPersonSlackReactionApprovalV2,
  approvalSha256: ApprovalContractSha256,
  idempotent: boolean,
): StagedPersonSlackReactionApprovalPendingV1 {
  return Object.freeze({
    command_id: commandId,
    command_semantic_sha256: semantic,
    approval,
    approval_sha256: approvalSha256,
    idempotent,
  });
}

function storedApproval(row: {
  approval_json: string;
  approval_sha256: string;
}): {
  approval: ReprovedFrozenPersonSlackReactionApprovalV2;
  sha256: ApprovalContractSha256;
} {
  const parsed = JSON.parse(row.approval_json) as unknown;
  if (
    canonicalJson(parsed) !== row.approval_json ||
    canonicalSha256(parsed) !== row.approval_sha256
  ) {
    throw new Error("stored pending Person Slack reaction approval digest is invalid");
  }
  return {
    approval: validateReprovedPersonSlackPendingApprovalV1(parsed),
    sha256: row.approval_sha256 as ApprovalContractSha256,
  };
}

/**
 * Stores the minimum immutable approval commitment set. A duplicate command
 * returns the same tuple; changing a command or approval ID fails closed.
 */
export function stagePersonSlackReactionApprovalPendingV1(input: {
  readonly database: Database.Database;
  readonly command: StagePersonSlackReactionApprovalPendingCommandV1;
  readonly now: () => string;
}): StagedPersonSlackReactionApprovalPendingV1 {
  if (!COMMAND_ID.test(input.command.command_id)) {
    throw new Error("pending Person Slack reaction approval command_id is invalid");
  }
  const approval = validateReprovedPersonSlackPendingApprovalV1(
    input.command.approval,
  );
  const semantic = commandSemantic(approval);
  const approvalSha256 = canonicalSha256(approval);

  input.database.exec("BEGIN IMMEDIATE");
  try {
    const priorCommand = input.database
      .prepare(
        `SELECT command_semantic_sha256, approval_json, approval_sha256
         FROM organization_person_slack_pending_approval_commands AS command
         JOIN organization_person_slack_pending_approvals AS approval
           ON approval.approval_id = command.approval_id
         WHERE command.command_id = ?`,
      )
      .get(input.command.command_id) as
      | {
          command_semantic_sha256: string;
          approval_json: string;
          approval_sha256: string;
        }
      | undefined;
    if (priorCommand !== undefined) {
      const prior = storedApproval(priorCommand);
      if (
        priorCommand.command_semantic_sha256 !== semantic ||
        prior.sha256 !== approvalSha256
      ) {
        throw new PersonSlackReactionApprovalPendingConflictError();
      }
      input.database.exec("COMMIT");
      return result(
        input.command.command_id,
        semantic,
        prior.approval,
        prior.sha256,
        true,
      );
    }

    const priorApproval = input.database
      .prepare(
        `SELECT approval_json, approval_sha256
         FROM organization_person_slack_pending_approvals WHERE approval_id = ?`,
      )
      .get(approval.approval_id) as
      { approval_json: string; approval_sha256: string } | undefined;
    if (priorApproval !== undefined) {
      const prior = storedApproval(priorApproval);
      if (prior.sha256 !== approvalSha256) {
        throw new PersonSlackReactionApprovalPendingConflictError(
          "pending Person Slack reaction approval ID already names a different approval",
        );
      }
      input.database
        .prepare(
          `INSERT INTO organization_person_slack_pending_approval_commands
           (command_id, command_semantic_sha256, approval_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          input.command.command_id,
          semantic,
          approval.approval_id,
          input.now(),
        );
      input.database.exec("COMMIT");
      return result(
        input.command.command_id,
        semantic,
        prior.approval,
        prior.sha256,
        true,
      );
    }

    const now = input.now();
    input.database
      .prepare(
        `INSERT INTO organization_person_slack_pending_approvals
         (approval_id, approval_json, approval_sha256, connection_id,
          approval_binding_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.approval_id,
        canonicalJson(approval),
        approvalSha256,
        approval.connection_id,
        approval.approval_binding_id,
        now,
      );
    input.database
      .prepare(
        `INSERT INTO organization_person_slack_pending_approval_commands
         (command_id, command_semantic_sha256, approval_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.command.command_id, semantic, approval.approval_id, now);
    input.database.exec("COMMIT");
    return result(
      input.command.command_id,
      semantic,
      approval,
      approvalSha256,
      false,
    );
  } catch (error) {
    try {
      input.database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
