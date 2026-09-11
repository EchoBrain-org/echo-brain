/**
 * Provider-independent half of the private approval V1 resolution contract.
 *
 * It owns the durable command shape, verified Authority assignees, the
 * commitment identity every private approval record carries, the policy
 * binding a human selects, and exact durable-replay matching. It knows no
 * provider: the proof that a specific external human acted is validated by
 * the provider-owned module that composes this one.
 */

import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type ApprovalContractSha256,
  type PersonApprovalPolicyId,
} from "./record-visibility-policy-contracts-v1.js";

export const PRIVATE_APPROVAL_PENDING_KIND =
  "echo-private-approval-pending-v1" as const;
export const PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND =
  "echo-private-approval-authorization-allow-v1" as const;
export const PRIVATE_APPROVAL_RESOLUTION_KIND =
  "echo-private-approval-resolution-v1" as const;
export const PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS = 1000;

/** Presentation default only. Approve commands must still choose explicitly. */
export const PRIVATE_APPROVAL_PRESENTATION_DEFAULT_POLICY_ID =
  RESTRICTED_REVIEWER_PERSON_POLICY_ID;

export type PrivateApprovalActionV1 = "approve" | "reject";

/** Exact, verified Authority identity. */
export interface PrivateApprovalAssigneeV1 {
  readonly principal_id: string;
  readonly membership_id: string;
}

/** The commitment identity shared by pending, allow, and resolution records. */
export interface PrivateApprovalCommitmentV1 {
  readonly approval_id: string;
  readonly organization_id: string;
  readonly candidate_sha256: ApprovalContractSha256;
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly approved_snapshot_sha256: ApprovalContractSha256;
}

export const PRIVATE_APPROVAL_COMMITMENT_KEYS = Object.freeze([
  "approval_id",
  "organization_id",
  "candidate_sha256",
  "frozen_card_sha256",
  "approved_snapshot_sha256",
] as const);

/**
 * Raw human command. It intentionally carries no actor identity or authority
 * claim: those arrive only through the server-revalidated authorization allow.
 */
export interface PrivateApprovalResolutionCommandV1 {
  readonly schema_version: 1;
  readonly command_id: string;
  readonly approval_id: string;
  readonly action: PrivateApprovalActionV1;
  readonly selected_policy_id: PersonApprovalPolicyId | null;
  /** Optional human rationale, normalized at the interaction boundary. */
  readonly comment: string | null;
}

export interface PrivateApprovalPolicyBindingV1 {
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly restricted_reader: PrivateApprovalAssigneeV1 | null;
}

/** The provider-independent fields of one durable resolution. */
export interface PrivateApprovalResolutionOutcomeV1 {
  readonly command_id: string;
  readonly approval_id: string;
  readonly action: PrivateApprovalActionV1;
  readonly comment: string | null;
  readonly canonical_record_policy: PrivateApprovalPolicyBindingV1 | null;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DISALLOWED_COMMENT_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
export type PrivateApprovalUnknownRecord = Record<string, unknown>;

export function privateApprovalInvalid(detail: string): never {
  throw new Error(`private approval policy resolution ${detail}`);
}

export function privateApprovalExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): PrivateApprovalUnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    privateApprovalInvalid(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    privateApprovalInvalid(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    privateApprovalInvalid(`${label} must not contain symbol keys`);
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      privateApprovalInvalid(`${label} field ${key} must be an enumerable data property`);
    }
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    privateApprovalInvalid(`${label} has an unexpected shape`);
  }
  return value as PrivateApprovalUnknownRecord;
}

export function privateApprovalIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    privateApprovalInvalid(`${label} must be a bounded canonical identifier`);
  }
}

export function privateApprovalDigest(
  value: unknown,
  label: string,
): asserts value is ApprovalContractSha256 {
  if (typeof value !== "string" || !SHA256.test(value)) {
    privateApprovalInvalid(`${label} must be a lowercase SHA-256 digest`);
  }
}

/**
 * Commands are a durable audit surface. Empty or non-canonical comment text
 * therefore has no representation: callers must send null instead.
 */
export function privateApprovalComment(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    privateApprovalInvalid(`${label} must be a string or null`);
  }
  if (value.length > PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS) {
    privateApprovalInvalid(
      `${label} exceeds ${PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS} UTF-16 code units`,
    );
  }
  if (value.trim().length === 0) {
    privateApprovalInvalid(`${label} must use null for an empty or whitespace-only comment`);
  }
  if (value !== value.trim()) {
    privateApprovalInvalid(`${label} must be canonically trimmed`);
  }
  if (DISALLOWED_COMMENT_CONTROL.test(value)) {
    privateApprovalInvalid(`${label} contains a disallowed control character`);
  }
  return value;
}

export function privateApprovalAssignee(
  value: unknown,
  label: string,
): PrivateApprovalAssigneeV1 {
  const record = privateApprovalExactRecord(
    value,
    ["principal_id", "membership_id"],
    label,
  );
  privateApprovalIdentifier(record.principal_id, `${label}.principal_id`);
  privateApprovalIdentifier(record.membership_id, `${label}.membership_id`);
  return Object.freeze({
    principal_id: record.principal_id,
    membership_id: record.membership_id,
  });
}

export function samePrivateApprovalAssignee(
  left: PrivateApprovalAssigneeV1,
  right: PrivateApprovalAssigneeV1,
): boolean {
  return (
    left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id
  );
}

/** Validates the shared commitment fields already present on an exact record. */
export function privateApprovalCommitment(
  record: PrivateApprovalUnknownRecord,
  label: string,
): PrivateApprovalCommitmentV1 {
  privateApprovalIdentifier(record.approval_id, `${label} approval_id`);
  privateApprovalIdentifier(record.organization_id, `${label} organization_id`);
  privateApprovalDigest(record.candidate_sha256, `${label} candidate_sha256`);
  privateApprovalDigest(record.frozen_card_sha256, `${label} frozen_card_sha256`);
  privateApprovalDigest(
    record.approved_snapshot_sha256,
    `${label} approved_snapshot_sha256`,
  );
  return Object.freeze({
    approval_id: record.approval_id,
    organization_id: record.organization_id,
    candidate_sha256: record.candidate_sha256,
    frozen_card_sha256: record.frozen_card_sha256,
    approved_snapshot_sha256: record.approved_snapshot_sha256,
  });
}

export function samePrivateApprovalCommitment(
  left: PrivateApprovalCommitmentV1,
  right: PrivateApprovalCommitmentV1,
): boolean {
  return (
    left.approval_id === right.approval_id &&
    left.organization_id === right.organization_id &&
    left.candidate_sha256 === right.candidate_sha256 &&
    left.frozen_card_sha256 === right.frozen_card_sha256 &&
    left.approved_snapshot_sha256 === right.approved_snapshot_sha256
  );
}

export function privateApprovalCommand(
  value: unknown,
): PrivateApprovalResolutionCommandV1 {
  const record = privateApprovalExactRecord(
    value,
    [
      "schema_version",
      "command_id",
      "approval_id",
      "action",
      "selected_policy_id",
      "comment",
    ],
    "approval command",
  );
  if (record.schema_version !== 1) {
    privateApprovalInvalid("approval command schema_version must be 1");
  }
  privateApprovalIdentifier(record.command_id, "approval command command_id");
  privateApprovalIdentifier(record.approval_id, "approval command approval_id");
  if (record.action !== "approve" && record.action !== "reject") {
    privateApprovalInvalid("approval command action must be approve or reject");
  }
  if (
    record.selected_policy_id !== null &&
    record.selected_policy_id !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID &&
    record.selected_policy_id !== RESTRICTED_REVIEWER_PERSON_POLICY_ID
  ) {
    privateApprovalInvalid("approval command selected_policy_id is unsupported");
  }
  if (record.action === "approve" && record.selected_policy_id === null) {
    privateApprovalInvalid("approval command approve requires an explicit selected_policy_id");
  }
  if (record.action === "reject" && record.selected_policy_id !== null) {
    privateApprovalInvalid("approval command reject must not select a policy");
  }
  return Object.freeze({
    schema_version: 1,
    command_id: record.command_id,
    approval_id: record.approval_id,
    action: record.action,
    selected_policy_id: record.selected_policy_id,
    comment: privateApprovalComment(record.comment, "approval command comment"),
  });
}

export function privateApprovalPolicyBinding(
  policyId: PersonApprovalPolicyId,
  approver: PrivateApprovalAssigneeV1,
): PrivateApprovalPolicyBindingV1 {
  if (policyId === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID) {
    return Object.freeze({
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      policy_contract_sha256:
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
      policy_consequence_sha256:
        ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
      restricted_reader: null,
    });
  }
  return Object.freeze({
    policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    policy_contract_sha256: RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
    policy_consequence_sha256: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
    restricted_reader: approver,
  });
}

export function samePrivateApprovalPolicyBinding(
  left: PrivateApprovalPolicyBindingV1 | null,
  right: PrivateApprovalPolicyBindingV1 | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.policy_id === right.policy_id &&
    left.policy_contract_sha256 === right.policy_contract_sha256 &&
    left.policy_consequence_sha256 === right.policy_consequence_sha256 &&
    ((left.restricted_reader === null && right.restricted_reader === null) ||
      (left.restricted_reader !== null &&
        right.restricted_reader !== null &&
        samePrivateApprovalAssignee(left.restricted_reader, right.restricted_reader)))
  );
}

/** Revalidates a durable policy binding against the approver it must name. */
export function privateApprovalPriorPolicyBinding(
  value: unknown,
  approver: PrivateApprovalAssigneeV1,
): PrivateApprovalPolicyBindingV1 | null {
  if (value === null) return null;
  const record = privateApprovalExactRecord(
    value,
    [
      "policy_id",
      "policy_contract_sha256",
      "policy_consequence_sha256",
      "restricted_reader",
    ],
    "prior resolution canonical_record_policy",
  );
  if (
    record.policy_id !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID &&
    record.policy_id !== RESTRICTED_REVIEWER_PERSON_POLICY_ID
  ) {
    privateApprovalInvalid("prior resolution canonical_record_policy policy_id is unsupported");
  }
  privateApprovalDigest(
    record.policy_contract_sha256,
    "prior resolution canonical_record_policy policy_contract_sha256",
  );
  privateApprovalDigest(
    record.policy_consequence_sha256,
    "prior resolution canonical_record_policy policy_consequence_sha256",
  );
  const restrictedReader =
    record.restricted_reader === null
      ? null
      : privateApprovalAssignee(
          record.restricted_reader,
          "prior resolution canonical_record_policy restricted_reader",
        );
  const expected = privateApprovalPolicyBinding(record.policy_id, approver);
  if (
    !samePrivateApprovalPolicyBinding(
      Object.freeze({
        policy_id: record.policy_id,
        policy_contract_sha256: record.policy_contract_sha256,
        policy_consequence_sha256: record.policy_consequence_sha256,
        restricted_reader: restrictedReader,
      }),
      expected,
    )
  ) {
    privateApprovalInvalid("prior resolution canonical_record_policy is invalid");
  }
  return expected;
}

/** An exact durable retry must restate the command it already answered. */
export function privateApprovalResolutionMatchesCommand(
  durable: PrivateApprovalResolutionOutcomeV1,
  request: PrivateApprovalResolutionCommandV1,
): boolean {
  return (
    durable.command_id === request.command_id &&
    durable.approval_id === request.approval_id &&
    durable.action === request.action &&
    durable.comment === request.comment &&
    ((request.action === "reject" &&
      request.selected_policy_id === null &&
      durable.canonical_record_policy === null) ||
      (request.action === "approve" &&
        request.selected_policy_id !== null &&
        durable.canonical_record_policy?.policy_id === request.selected_policy_id))
  );
}

/** Validates the normalized, server-owned terminal command shape. */
export function validatePrivateApprovalResolutionCommandV1(
  value: unknown,
): PrivateApprovalResolutionCommandV1 {
  return privateApprovalCommand(value);
}
