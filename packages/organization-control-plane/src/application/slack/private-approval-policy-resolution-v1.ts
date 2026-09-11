/**
 * Slack-owned half of the private approval V1 resolution contract.
 *
 * This module owns neither delivery nor persistence. It binds the
 * provider-independent core to one exact Slack human: the pending card's
 * assigned owner carries that human's external-identity-link commitment, the
 * transaction-produced allow restates it, and every terminal resolution
 * records it. Its authorization input is a transaction-produced D2 allow
 * result, never a network-deserialized payload; the persistence boundary must
 * fence a new resolution by command_id in the same transaction that
 * revalidates that allow.
 *
 * The persisted field names `assigned_owner_slack_identity_link` and
 * `current_slack_identity_link` are frozen, digested commitments. Do not
 * rename them in place; a different provider needs a versioned contract.
 */

import {
  PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND,
  PRIVATE_APPROVAL_COMMITMENT_KEYS,
  PRIVATE_APPROVAL_PENDING_KIND,
  PRIVATE_APPROVAL_RESOLUTION_KIND,
  privateApprovalAssignee,
  privateApprovalComment,
  privateApprovalCommand,
  privateApprovalCommitment,
  privateApprovalDigest,
  privateApprovalExactRecord,
  privateApprovalIdentifier,
  privateApprovalInvalid,
  privateApprovalPolicyBinding,
  privateApprovalPriorPolicyBinding,
  privateApprovalResolutionMatchesCommand,
  samePrivateApprovalAssignee,
  samePrivateApprovalCommitment,
  type PrivateApprovalActionV1,
  type PrivateApprovalAssigneeV1,
  type PrivateApprovalCommitmentV1,
  type PrivateApprovalPolicyBindingV1,
  type PrivateApprovalResolutionCommandV1,
} from "../private-approval-policy-resolution-core-v1.js";
import type {
  ApprovalContractSha256,
  PersonApprovalPolicyId,
} from "../record-visibility-policy-contracts-v1.js";

export {
  PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND,
  PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
  PRIVATE_APPROVAL_PENDING_KIND,
  PRIVATE_APPROVAL_PRESENTATION_DEFAULT_POLICY_ID,
  PRIVATE_APPROVAL_RESOLUTION_KIND,
  validatePrivateApprovalResolutionCommandV1,
  type PrivateApprovalActionV1,
  type PrivateApprovalAssigneeV1,
  type PrivateApprovalPolicyBindingV1,
  type PrivateApprovalResolutionCommandV1,
} from "../private-approval-policy-resolution-core-v1.js";

/** Exact Slack external-human-link commitment for the assigned human. */
export interface PrivateApprovalSlackIdentityLinkV1 {
  readonly provider: "slack";
  readonly external_identity_link_id: string;
  readonly external_identity_link_contract_sha256: ApprovalContractSha256;
  readonly provider_subject_id: string;
}

export interface PendingPrivateApprovalV1 extends PrivateApprovalCommitmentV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_APPROVAL_PENDING_KIND;
  /** Frozen owner of this private DM card. V1 has no delegation. */
  readonly assigned_owner: PrivateApprovalAssigneeV1;
  readonly assigned_owner_slack_identity_link: PrivateApprovalSlackIdentityLinkV1;
}

/**
 * Transaction-produced authorization allow. Never deserialize this from a
 * Slack/UI request; it must be revalidated inside the authority transaction.
 */
export interface PrivateApprovalAuthorizationAllowV1
  extends PrivateApprovalCommitmentV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND;
  readonly authorized_assignee: PrivateApprovalAssigneeV1;
  readonly current_slack_identity_link: PrivateApprovalSlackIdentityLinkV1;
  readonly authorization_proof_sha256: ApprovalContractSha256;
}

export interface PrivateApprovalResolutionV1 extends PrivateApprovalCommitmentV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_APPROVAL_RESOLUTION_KIND;
  readonly command_id: string;
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

const EXTERNAL_IDENTITY_LINK_ID = /^clm_[A-Za-z0-9][A-Za-z0-9._:-]{0,251}$/;
const SLACK_HUMAN_SUBJECT = /^[UW][A-Z0-9]{2,255}$/;

/** The Slack proof: one canonical U/W human bound to one exact link contract. */
function slackLink(
  value: unknown,
  label: string,
): PrivateApprovalSlackIdentityLinkV1 {
  const record = privateApprovalExactRecord(
    value,
    [
      "provider",
      "external_identity_link_id",
      "external_identity_link_contract_sha256",
      "provider_subject_id",
    ],
    label,
  );
  if (record.provider !== "slack") {
    privateApprovalInvalid(`${label}.provider must be slack`);
  }
  if (
    typeof record.external_identity_link_id !== "string" ||
    !EXTERNAL_IDENTITY_LINK_ID.test(record.external_identity_link_id)
  ) {
    privateApprovalInvalid(
      `${label}.external_identity_link_id must be a canonical clm identifier`,
    );
  }
  privateApprovalDigest(
    record.external_identity_link_contract_sha256,
    `${label}.external_identity_link_contract_sha256`,
  );
  if (
    typeof record.provider_subject_id !== "string" ||
    !SLACK_HUMAN_SUBJECT.test(record.provider_subject_id)
  ) {
    privateApprovalInvalid(
      `${label}.provider_subject_id must be a canonical Slack U or W subject`,
    );
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
  const label = "pending approval";
  const record = privateApprovalExactRecord(
    value,
    [
      "schema_version",
      "kind",
      ...PRIVATE_APPROVAL_COMMITMENT_KEYS,
      "assigned_owner",
      "assigned_owner_slack_identity_link",
    ],
    label,
  );
  if (record.schema_version !== 1) {
    privateApprovalInvalid(`${label} schema_version must be 1`);
  }
  if (record.kind !== PRIVATE_APPROVAL_PENDING_KIND) {
    privateApprovalInvalid(`${label} kind must be ${PRIVATE_APPROVAL_PENDING_KIND}`);
  }
  return Object.freeze({
    schema_version: 1,
    kind: PRIVATE_APPROVAL_PENDING_KIND,
    ...privateApprovalCommitment(record, label),
    assigned_owner: privateApprovalAssignee(
      record.assigned_owner,
      `${label} assigned_owner`,
    ),
    assigned_owner_slack_identity_link: slackLink(
      record.assigned_owner_slack_identity_link,
      `${label} assigned_owner_slack_identity_link`,
    ),
  });
}

function authorization(value: unknown): PrivateApprovalAuthorizationAllowV1 {
  const label = "authorization allow";
  const record = privateApprovalExactRecord(
    value,
    [
      "schema_version",
      "kind",
      ...PRIVATE_APPROVAL_COMMITMENT_KEYS,
      "authorized_assignee",
      "current_slack_identity_link",
      "authorization_proof_sha256",
    ],
    label,
  );
  if (record.schema_version !== 1) {
    privateApprovalInvalid(`${label} schema_version must be 1`);
  }
  if (record.kind !== PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND) {
    privateApprovalInvalid(
      `${label} kind must be ${PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND}`,
    );
  }
  const commitment = privateApprovalCommitment(record, label);
  privateApprovalDigest(
    record.authorization_proof_sha256,
    `${label} authorization_proof_sha256`,
  );
  return Object.freeze({
    schema_version: 1,
    kind: PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND,
    ...commitment,
    authorized_assignee: privateApprovalAssignee(
      record.authorized_assignee,
      `${label} authorized_assignee`,
    ),
    current_slack_identity_link: slackLink(
      record.current_slack_identity_link,
      `${label} current_slack_identity_link`,
    ),
    authorization_proof_sha256: record.authorization_proof_sha256,
  });
}

function authorizationMatches(
  allow: PrivateApprovalAuthorizationAllowV1,
  current: PendingPrivateApprovalV1,
): boolean {
  return (
    samePrivateApprovalCommitment(allow, current) &&
    samePrivateApprovalAssignee(allow.authorized_assignee, current.assigned_owner) &&
    sameSlackIdentityLink(
      allow.current_slack_identity_link,
      current.assigned_owner_slack_identity_link,
    )
  );
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
        ? privateApprovalPolicyBinding(
            request.selected_policy_id as PersonApprovalPolicyId,
            finalApprover,
          )
        : null,
  });
}

function prior(value: unknown): PrivateApprovalResolutionV1 {
  const label = "prior resolution";
  const record = privateApprovalExactRecord(
    value,
    [
      "schema_version",
      "kind",
      "command_id",
      ...PRIVATE_APPROVAL_COMMITMENT_KEYS,
      "final_approver",
      "current_slack_identity_link",
      "authorization_proof_sha256",
      "action",
      "comment",
      "canonical_record_policy",
    ],
    label,
  );
  if (record.schema_version !== 1 || record.kind !== PRIVATE_APPROVAL_RESOLUTION_KIND) {
    privateApprovalInvalid(`${label} has an unsupported schema or kind`);
  }
  privateApprovalIdentifier(record.command_id, `${label} command_id`);
  const commitment = privateApprovalCommitment(record, label);
  privateApprovalDigest(
    record.authorization_proof_sha256,
    `${label} authorization_proof_sha256`,
  );
  if (record.action !== "approve" && record.action !== "reject") {
    privateApprovalInvalid(`${label} action is unsupported`);
  }
  const finalApprover = privateApprovalAssignee(
    record.final_approver,
    `${label} final_approver`,
  );
  const recordPolicy = privateApprovalPriorPolicyBinding(
    record.canonical_record_policy,
    finalApprover,
  );
  if (record.action === "approve" && recordPolicy === null) {
    privateApprovalInvalid("prior approval resolution must bind a policy");
  }
  if (record.action === "reject" && recordPolicy !== null) {
    privateApprovalInvalid("prior rejection resolution must not bind a policy");
  }
  return Object.freeze({
    schema_version: 1,
    kind: PRIVATE_APPROVAL_RESOLUTION_KIND,
    command_id: record.command_id,
    ...commitment,
    final_approver: finalApprover,
    current_slack_identity_link: slackLink(
      record.current_slack_identity_link,
      `${label} current_slack_identity_link`,
    ),
    authorization_proof_sha256: record.authorization_proof_sha256,
    action: record.action,
    comment: privateApprovalComment(record.comment, `${label} comment`),
    canonical_record_policy: recordPolicy,
  });
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
  const request = privateApprovalCommand(input.command);
  if ("prior_resolution" in input && input.prior_resolution !== undefined) {
    const durable = prior(input.prior_resolution);
    if (!privateApprovalResolutionMatchesCommand(durable, request)) {
      privateApprovalInvalid("approval command command_id conflicts with prior resolution");
    }
    return durable;
  }
  const current = pending(input.pending);
  const allow = authorization(input.authorization_allow);
  if (request.approval_id !== current.approval_id) {
    privateApprovalInvalid("approval command approval_id does not match the pending approval");
  }
  if (!authorizationMatches(allow, current)) {
    privateApprovalInvalid("authorization allow does not match the pending owner");
  }
  return build(current, request, allow);
}
