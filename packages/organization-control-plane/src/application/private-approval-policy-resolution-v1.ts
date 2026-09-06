/**
 * Pure, fail-closed resolution contract for the private approval V1 path.
 *
 * This module owns neither delivery nor persistence. Its authorization input
 * is a transaction-produced D2 allow result, never a network-deserialized
 * payload. The persistence boundary must fence a new resolution by command_id
 * in the same transaction that revalidates that allow.
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

/** Exact Slack external-human-link commitment for the assigned human. */
export interface PrivateApprovalSlackIdentityLinkV1 {
  readonly provider: "slack";
  readonly external_identity_link_id: string;
  readonly external_identity_link_contract_sha256: ApprovalContractSha256;
  readonly provider_subject_id: string;
}

export interface PendingPrivateApprovalV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_APPROVAL_PENDING_KIND;
  readonly approval_id: string;
  readonly organization_id: string;
  readonly candidate_sha256: ApprovalContractSha256;
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly approved_snapshot_sha256: ApprovalContractSha256;
  /** Frozen owner of this private DM card. V1 has no delegation. */
  readonly assigned_owner: PrivateApprovalAssigneeV1;
  readonly assigned_owner_slack_identity_link: PrivateApprovalSlackIdentityLinkV1;
}

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

/**
 * Transaction-produced authorization allow. Never deserialize this from a
 * Slack/UI request; it must be revalidated inside the authority transaction.
 */
export interface PrivateApprovalAuthorizationAllowV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND;
  readonly approval_id: string;
  readonly organization_id: string;
  readonly candidate_sha256: ApprovalContractSha256;
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly approved_snapshot_sha256: ApprovalContractSha256;
  readonly authorized_assignee: PrivateApprovalAssigneeV1;
  readonly current_slack_identity_link: PrivateApprovalSlackIdentityLinkV1;
  readonly authorization_proof_sha256: ApprovalContractSha256;
}

export interface PrivateApprovalPolicyBindingV1 {
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly restricted_reader: PrivateApprovalAssigneeV1 | null;
}

export interface PrivateApprovalResolutionV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_APPROVAL_RESOLUTION_KIND;
  readonly command_id: string;
  readonly approval_id: string;
  readonly organization_id: string;
  readonly candidate_sha256: ApprovalContractSha256;
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly approved_snapshot_sha256: ApprovalContractSha256;
  /** Derived exclusively from authorization_allow. */
  readonly final_approver: PrivateApprovalAssigneeV1;
  readonly current_slack_identity_link: PrivateApprovalSlackIdentityLinkV1;
  readonly authorization_proof_sha256: ApprovalContractSha256;
  readonly action: PrivateApprovalActionV1;
  /** Exact human rationale supplied with the durable command. */
  readonly comment: string | null;
  readonly canonical_record_policy: PrivateApprovalPolicyBindingV1 | null;
}

export interface ResolvePrivateApprovalPolicyReplayInputV1 {
  readonly command: PrivateApprovalResolutionCommandV1;
  readonly prior_resolution: PrivateApprovalResolutionV1;
  readonly pending?: never;
  readonly authorization_allow?: never;
}

export interface ResolvePrivateApprovalPolicyUnresolvedInputV1 {
  readonly pending: PendingPrivateApprovalV1;
  readonly command: PrivateApprovalResolutionCommandV1;
  readonly authorization_allow: PrivateApprovalAuthorizationAllowV1;
  readonly prior_resolution?: undefined;
}

/**
 * A durable replay needs only its raw command and stored result. An unresolved
 * command must instead carry the current pending state and server-only allow.
 */
export type ResolvePrivateApprovalPolicyInputV1 =
  | ResolvePrivateApprovalPolicyReplayInputV1
  | ResolvePrivateApprovalPolicyUnresolvedInputV1;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EXTERNAL_IDENTITY_LINK_ID = /^clm_[A-Za-z0-9][A-Za-z0-9._:-]{0,251}$/;
const SLACK_HUMAN_SUBJECT = /^[UW][A-Z0-9]{2,255}$/;
const DISALLOWED_COMMENT_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
type UnknownRecord = Record<string, unknown>;

function invalid(detail: string): never {
  throw new Error(`private approval policy resolution ${detail}`);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(`${label} must not contain symbol keys`);
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
      invalid(`${label} field ${key} must be an enumerable data property`);
    }
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`${label} has an unexpected shape`);
  }
  return value as UnknownRecord;
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    invalid(`${label} must be a bounded canonical identifier`);
  }
}

function digest(
  value: unknown,
  label: string,
): asserts value is ApprovalContractSha256 {
  if (typeof value !== "string" || !SHA256.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest`);
  }
}

/**
 * Commands are a durable audit surface. Empty or non-canonical comment text
 * therefore has no representation: callers must send null instead.
 */
function comment(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    invalid(`${label} must be a string or null`);
  }
  if (value.length > PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS) {
    invalid(
      `${label} exceeds ${PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS} UTF-16 code units`,
    );
  }
  if (value.trim().length === 0) {
    invalid(`${label} must use null for an empty or whitespace-only comment`);
  }
  if (value !== value.trim()) {
    invalid(`${label} must be canonically trimmed`);
  }
  if (DISALLOWED_COMMENT_CONTROL.test(value)) {
    invalid(`${label} contains a disallowed control character`);
  }
  return value;
}

function assignee(value: unknown, label: string): PrivateApprovalAssigneeV1 {
  const record = exactRecord(value, ["principal_id", "membership_id"], label);
  identifier(record.principal_id, `${label}.principal_id`);
  identifier(record.membership_id, `${label}.membership_id`);
  return Object.freeze({
    principal_id: record.principal_id,
    membership_id: record.membership_id,
  });
}

function sameAssignee(
  left: PrivateApprovalAssigneeV1,
  right: PrivateApprovalAssigneeV1,
): boolean {
  return (
    left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id
  );
}

function slackLink(
  value: unknown,
  label: string,
): PrivateApprovalSlackIdentityLinkV1 {
  const record = exactRecord(
    value,
    [
      "provider",
      "external_identity_link_id",
      "external_identity_link_contract_sha256",
      "provider_subject_id",
    ],
    label,
  );
  if (record.provider !== "slack") invalid(`${label}.provider must be slack`);
  if (
    typeof record.external_identity_link_id !== "string" ||
    !EXTERNAL_IDENTITY_LINK_ID.test(record.external_identity_link_id)
  ) {
    invalid(`${label}.external_identity_link_id must be a canonical clm identifier`);
  }
  digest(
    record.external_identity_link_contract_sha256,
    `${label}.external_identity_link_contract_sha256`,
  );
  if (
    typeof record.provider_subject_id !== "string" ||
    !SLACK_HUMAN_SUBJECT.test(record.provider_subject_id)
  ) {
    invalid(`${label}.provider_subject_id must be a canonical Slack U or W subject`);
  }
  return Object.freeze({
    provider: "slack",
    external_identity_link_id: record.external_identity_link_id,
    external_identity_link_contract_sha256:
      record.external_identity_link_contract_sha256,
    provider_subject_id: record.provider_subject_id,
  });
}

function sameSlackIdentityLink(
  left: PrivateApprovalSlackIdentityLinkV1,
  right: PrivateApprovalSlackIdentityLinkV1,
): boolean {
  return (
    left.provider === right.provider &&
    left.external_identity_link_id === right.external_identity_link_id &&
    left.external_identity_link_contract_sha256 ===
      right.external_identity_link_contract_sha256 &&
    left.provider_subject_id === right.provider_subject_id
  );
}

function pending(value: unknown): PendingPrivateApprovalV1 {
  const record = exactRecord(
    value,
    [
      "schema_version",
      "kind",
      "approval_id",
      "organization_id",
      "candidate_sha256",
      "frozen_card_sha256",
      "approved_snapshot_sha256",
      "assigned_owner",
      "assigned_owner_slack_identity_link",
    ],
    "pending approval",
  );
  if (record.schema_version !== 1) invalid("pending approval schema_version must be 1");
  if (record.kind !== PRIVATE_APPROVAL_PENDING_KIND) {
    invalid(`pending approval kind must be ${PRIVATE_APPROVAL_PENDING_KIND}`);
  }
  identifier(record.approval_id, "pending approval approval_id");
  identifier(record.organization_id, "pending approval organization_id");
  digest(record.candidate_sha256, "pending approval candidate_sha256");
  digest(record.frozen_card_sha256, "pending approval frozen_card_sha256");
  digest(record.approved_snapshot_sha256, "pending approval approved_snapshot_sha256");
  return Object.freeze({
    schema_version: 1,
    kind: PRIVATE_APPROVAL_PENDING_KIND,
    approval_id: record.approval_id,
    organization_id: record.organization_id,
    candidate_sha256: record.candidate_sha256,
    frozen_card_sha256: record.frozen_card_sha256,
    approved_snapshot_sha256: record.approved_snapshot_sha256,
    assigned_owner: assignee(record.assigned_owner, "pending approval assigned_owner"),
    assigned_owner_slack_identity_link: slackLink(
      record.assigned_owner_slack_identity_link,
      "pending approval assigned_owner_slack_identity_link",
    ),
  });
}

function command(value: unknown): PrivateApprovalResolutionCommandV1 {
  const record = exactRecord(
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
  if (record.schema_version !== 1) invalid("approval command schema_version must be 1");
  identifier(record.command_id, "approval command command_id");
  identifier(record.approval_id, "approval command approval_id");
  if (record.action !== "approve" && record.action !== "reject") {
    invalid("approval command action must be approve or reject");
  }
  if (
    record.selected_policy_id !== null &&
    record.selected_policy_id !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID &&
    record.selected_policy_id !== RESTRICTED_REVIEWER_PERSON_POLICY_ID
  ) {
    invalid("approval command selected_policy_id is unsupported");
  }
  if (record.action === "approve" && record.selected_policy_id === null) {
    invalid("approval command approve requires an explicit selected_policy_id");
  }
  if (record.action === "reject" && record.selected_policy_id !== null) {
    invalid("approval command reject must not select a policy");
  }
  return Object.freeze({
    schema_version: 1,
    command_id: record.command_id,
    approval_id: record.approval_id,
    action: record.action,
    selected_policy_id: record.selected_policy_id,
    comment: comment(record.comment, "approval command comment"),
  });
}

function authorization(value: unknown): PrivateApprovalAuthorizationAllowV1 {
  const record = exactRecord(
    value,
    [
      "schema_version",
      "kind",
      "approval_id",
      "organization_id",
      "candidate_sha256",
      "frozen_card_sha256",
      "approved_snapshot_sha256",
      "authorized_assignee",
      "current_slack_identity_link",
      "authorization_proof_sha256",
    ],
    "authorization allow",
  );
  if (record.schema_version !== 1) invalid("authorization allow schema_version must be 1");
  if (record.kind !== PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND) {
    invalid(`authorization allow kind must be ${PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND}`);
  }
  identifier(record.approval_id, "authorization allow approval_id");
  identifier(record.organization_id, "authorization allow organization_id");
  digest(record.candidate_sha256, "authorization allow candidate_sha256");
  digest(record.frozen_card_sha256, "authorization allow frozen_card_sha256");
  digest(record.approved_snapshot_sha256, "authorization allow approved_snapshot_sha256");
  digest(record.authorization_proof_sha256, "authorization allow authorization_proof_sha256");
  return Object.freeze({
    schema_version: 1,
    kind: PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND,
    approval_id: record.approval_id,
    organization_id: record.organization_id,
    candidate_sha256: record.candidate_sha256,
    frozen_card_sha256: record.frozen_card_sha256,
    approved_snapshot_sha256: record.approved_snapshot_sha256,
    authorized_assignee: assignee(
      record.authorized_assignee,
      "authorization allow authorized_assignee",
    ),
    current_slack_identity_link: slackLink(
      record.current_slack_identity_link,
      "authorization allow current_slack_identity_link",
    ),
    authorization_proof_sha256: record.authorization_proof_sha256,
  });
}

function authorizationMatches(
  allow: PrivateApprovalAuthorizationAllowV1,
  current: PendingPrivateApprovalV1,
): boolean {
  return (
    allow.approval_id === current.approval_id &&
    allow.organization_id === current.organization_id &&
    allow.candidate_sha256 === current.candidate_sha256 &&
    allow.frozen_card_sha256 === current.frozen_card_sha256 &&
    allow.approved_snapshot_sha256 === current.approved_snapshot_sha256 &&
    sameAssignee(allow.authorized_assignee, current.assigned_owner) &&
    sameSlackIdentityLink(
      allow.current_slack_identity_link,
      current.assigned_owner_slack_identity_link,
    )
  );
}

function policy(
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

function build(
  current: PendingPrivateApprovalV1,
  request: PrivateApprovalResolutionCommandV1,
  allow: PrivateApprovalAuthorizationAllowV1,
): PrivateApprovalResolutionV1 {
  const finalApprover = Object.freeze({ ...allow.authorized_assignee });
  return Object.freeze({
    schema_version: 1,
    kind: PRIVATE_APPROVAL_RESOLUTION_KIND,
    command_id: request.command_id,
    approval_id: current.approval_id,
    organization_id: current.organization_id,
    candidate_sha256: current.candidate_sha256,
    frozen_card_sha256: current.frozen_card_sha256,
    approved_snapshot_sha256: current.approved_snapshot_sha256,
    final_approver: finalApprover,
    current_slack_identity_link: Object.freeze({
      ...allow.current_slack_identity_link,
    }),
    authorization_proof_sha256: allow.authorization_proof_sha256,
    action: request.action,
    comment: request.comment,
    canonical_record_policy:
      request.action === "approve"
        ? policy(request.selected_policy_id as PersonApprovalPolicyId, finalApprover)
        : null,
  });
}

function samePolicy(
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
        sameAssignee(left.restricted_reader, right.restricted_reader)))
  );
}

function priorPolicy(
  value: unknown,
  approver: PrivateApprovalAssigneeV1,
): PrivateApprovalPolicyBindingV1 | null {
  if (value === null) return null;
  const record = exactRecord(
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
    invalid("prior resolution canonical_record_policy policy_id is unsupported");
  }
  digest(
    record.policy_contract_sha256,
    "prior resolution canonical_record_policy policy_contract_sha256",
  );
  digest(
    record.policy_consequence_sha256,
    "prior resolution canonical_record_policy policy_consequence_sha256",
  );
  const restrictedReader =
    record.restricted_reader === null
      ? null
      : assignee(
          record.restricted_reader,
          "prior resolution canonical_record_policy restricted_reader",
        );
  const expected = policy(record.policy_id, approver);
  if (
    !samePolicy(
      Object.freeze({
        policy_id: record.policy_id,
        policy_contract_sha256: record.policy_contract_sha256,
        policy_consequence_sha256: record.policy_consequence_sha256,
        restricted_reader: restrictedReader,
      }),
      expected,
    )
  ) {
    invalid("prior resolution canonical_record_policy is invalid");
  }
  return expected;
}

function prior(value: unknown): PrivateApprovalResolutionV1 {
  const record = exactRecord(
    value,
    [
      "schema_version",
      "kind",
      "command_id",
      "approval_id",
      "organization_id",
      "candidate_sha256",
      "frozen_card_sha256",
      "approved_snapshot_sha256",
      "final_approver",
      "current_slack_identity_link",
      "authorization_proof_sha256",
      "action",
      "comment",
      "canonical_record_policy",
    ],
    "prior resolution",
  );
  if (record.schema_version !== 1 || record.kind !== PRIVATE_APPROVAL_RESOLUTION_KIND) {
    invalid("prior resolution has an unsupported schema or kind");
  }
  identifier(record.command_id, "prior resolution command_id");
  identifier(record.approval_id, "prior resolution approval_id");
  identifier(record.organization_id, "prior resolution organization_id");
  digest(record.candidate_sha256, "prior resolution candidate_sha256");
  digest(record.frozen_card_sha256, "prior resolution frozen_card_sha256");
  digest(record.approved_snapshot_sha256, "prior resolution approved_snapshot_sha256");
  digest(record.authorization_proof_sha256, "prior resolution authorization_proof_sha256");
  if (record.action !== "approve" && record.action !== "reject") {
    invalid("prior resolution action is unsupported");
  }
  const finalApprover = assignee(record.final_approver, "prior resolution final_approver");
  const recordPolicy = priorPolicy(record.canonical_record_policy, finalApprover);
  if (record.action === "approve" && recordPolicy === null) {
    invalid("prior approval resolution must bind a policy");
  }
  if (record.action === "reject" && recordPolicy !== null) {
    invalid("prior rejection resolution must not bind a policy");
  }
  return Object.freeze({
    schema_version: 1,
    kind: PRIVATE_APPROVAL_RESOLUTION_KIND,
    command_id: record.command_id,
    approval_id: record.approval_id,
    organization_id: record.organization_id,
    candidate_sha256: record.candidate_sha256,
    frozen_card_sha256: record.frozen_card_sha256,
    approved_snapshot_sha256: record.approved_snapshot_sha256,
    final_approver: finalApprover,
    current_slack_identity_link: slackLink(
      record.current_slack_identity_link,
      "prior resolution current_slack_identity_link",
    ),
    authorization_proof_sha256: record.authorization_proof_sha256,
    action: record.action,
    comment: comment(record.comment, "prior resolution comment"),
    canonical_record_policy: recordPolicy,
  });
}

function priorMatchesCommand(
  durable: PrivateApprovalResolutionV1,
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

/**
 * Validates and defensively freezes the commitment which may be staged before
 * an approval card is delivered.  Staging deliberately does not synthesize an
 * authorization allow: a provider action must still cross the stable fence.
 */
export function validatePendingPrivateApprovalV1(
  value: unknown,
): PendingPrivateApprovalV1 {
  return pending(value);
}

/** Validates the normalized, server-owned terminal command shape. */
export function validatePrivateApprovalResolutionCommandV1(
  value: unknown,
): PrivateApprovalResolutionCommandV1 {
  return command(value);
}

/** Validates immutable terminal evidence before an exact durable replay. */
export function validatePrivateApprovalResolutionV1(
  value: unknown,
): PrivateApprovalResolutionV1 {
  return prior(value);
}

/** Validates the server-only authorization proof before terminal persistence. */
export function validatePrivateApprovalAuthorizationAllowV1(
  value: unknown,
): PrivateApprovalAuthorizationAllowV1 {
  return authorization(value);
}

/**
 * Resolve one explicit approval or rejection. Exact durable retries are
 * returned before consulting current state; otherwise the current pending
 * owner and server-revalidated authorization allow must match exactly.
 */
export function resolvePrivateApprovalPolicyV1(
  input: ResolvePrivateApprovalPolicyInputV1,
): PrivateApprovalResolutionV1 {
  const request = command(input.command);
  if ("prior_resolution" in input && input.prior_resolution !== undefined) {
    const durable = prior(input.prior_resolution);
    if (!priorMatchesCommand(durable, request)) {
      invalid("approval command command_id conflicts with prior resolution");
    }
    return durable;
  }
  const current = pending(input.pending);
  const allow = authorization(input.authorization_allow);
  if (request.approval_id !== current.approval_id) {
    invalid("approval command approval_id does not match the pending approval");
  }
  if (!authorizationMatches(allow, current)) {
    invalid("authorization allow does not match the pending owner");
  }
  return build(current, request, allow);
}
