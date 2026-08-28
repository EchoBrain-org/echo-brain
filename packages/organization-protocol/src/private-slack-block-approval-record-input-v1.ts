import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  organizationMemberReadablePersonConsequenceSha256,
  organizationMemberReadablePersonPolicyContractSha256,
  restrictedReviewerPersonConsequenceSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from "./person-content-policy-v2.js";
import {
  approvedDecisionSnapshotV2Sha256,
  validateApprovedDecisionSnapshotV2,
  type ApprovedDecisionSnapshotV2,
  type PersonContentPolicyIdV2,
} from "./human-act-record-input-v1.js";
import {
  assertDigest,
  assertPositiveSafeInteger,
  canonicalSnapshot,
} from "./validation-support.js";
import { MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES } from "./record-payload.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

/** A provider action proven from Slack's signed `block_actions` request. */
export const PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND =
  "echo-private-slack-block-approval-resolution-ref-v1" as const;
export const PRIVATE_SLACK_BLOCK_APPROVAL_EVENT_COMMITMENT_V1_KIND =
  "echo-private-slack-block-approval-event-commitment-v1" as const;
export const PRIVATE_SLACK_BLOCK_APPROVAL_IDEMPOTENCY_V1_KIND =
  "echo-private-slack-block-approval-idempotency-v1" as const;
export const SIGNED_SLACK_BLOCK_ACTION_V1_KIND =
  "echo-signed-slack-block-action-v1" as const;
export const PRIVATE_SLACK_BLOCK_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS = 1000;

const REF_KEYS = [
  "schema_version", "kind", "authority_id", "organization_id", "state_lineage_id",
  "command_id", "approval_id", "candidate_sha256", "frozen_card_sha256",
  "approved_snapshot_sha256", "assignment_version", "assignment_capability_sha256",
  "final_approver", "current_slack_identity_link", "action", "selected_policy_id",
  "policy_contract_sha256", "policy_consequence_sha256", "comment", "audit_event_id",
  "audit_sequence", "audit_entry_sha256", "provider_action_kind",
  "provider_action_schema_version", "provider_action_sha256", "authorization_proof_sha256",
] as const;
const ASSIGNEE_KEYS = ["principal_id", "membership_id"] as const;
const SLACK_LINK_KEYS = [
  "provider", "external_identity_link_id", "external_identity_link_contract_sha256",
  "provider_subject_id",
] as const;
const APPROVED_EVENT_KEYS = [
  "kind", "approved_snapshot", "approved_snapshot_sha256", "policy_id",
  "policy_contract_sha256", "policy_consequence_text", "policy_consequence_sha256",
] as const;
const REJECTED_EVENT_KEYS = ["kind"] as const;
const IDEMPOTENCY_KEYS = [
  "schema_version", "kind", "authority_id", "organization_id", "state_lineage_id",
  "command_id", "approval_id", "assignment_version", "action",
  "private_slack_block_approval_resolution_ref_sha256",
  "private_slack_block_approval_event_sha256",
] as const;
const INPUT_KEYS = ["private_slack_block_approval_resolution_ref", "event", "idempotency"] as const;
const BUILD_INPUT_KEYS = ["private_slack_block_approval_resolution_ref", "event"] as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EXTERNAL_IDENTITY_LINK_ID = /^clm_[A-Za-z0-9][A-Za-z0-9._:-]{0,251}$/;
const SLACK_HUMAN_SUBJECT = /^[UW][A-Z0-9]{2,255}$/;
const DISALLOWED_COMMENT_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export type PrivateSlackBlockApprovalActionV1 = "approve" | "reject";

export interface PrivateSlackBlockApprovalAssigneeV1 {
  readonly principal_id: string;
  readonly membership_id: string;
}

export interface PrivateSlackBlockApprovalSlackIdentityLinkV1 {
  readonly provider: "slack";
  readonly external_identity_link_id: string;
  readonly external_identity_link_contract_sha256: Sha256Digest;
  readonly provider_subject_id: string;
}

/**
 * The durable D2/D3 witness for the private path. It contains only the
 * digest of the verified Slack request, never its raw payload or response URL.
 */
export interface PrivateSlackBlockApprovalResolutionRefV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly command_id: string;
  readonly approval_id: string;
  readonly candidate_sha256: Sha256Digest;
  readonly frozen_card_sha256: Sha256Digest;
  readonly approved_snapshot_sha256: Sha256Digest;
  readonly assignment_version: number;
  readonly assignment_capability_sha256: Sha256Digest;
  readonly final_approver: PrivateSlackBlockApprovalAssigneeV1;
  readonly current_slack_identity_link: PrivateSlackBlockApprovalSlackIdentityLinkV1;
  readonly action: PrivateSlackBlockApprovalActionV1;
  /** Explicit selection for approve, null for reject. */
  readonly selected_policy_id: PersonContentPolicyIdV2 | null;
  readonly policy_contract_sha256: Sha256Digest | null;
  readonly policy_consequence_sha256: Sha256Digest | null;
  readonly comment: string | null;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: typeof SIGNED_SLACK_BLOCK_ACTION_V1_KIND;
  readonly provider_action_schema_version: 1;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}

export interface PrivateSlackBlockApprovedEventV1 {
  readonly kind: "approved";
  readonly approved_snapshot: ApprovedDecisionSnapshotV2;
  readonly approved_snapshot_sha256: Sha256Digest;
  readonly policy_id: PersonContentPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly policy_consequence_text: string;
  readonly policy_consequence_sha256: Sha256Digest;
}

export interface PrivateSlackBlockRejectedEventV1 {
  /** A rejection is auditable in the resolution ref, but releases no facts. */
  readonly kind: "rejected";
}

export type PrivateSlackBlockApprovalEventV1 =
  | PrivateSlackBlockApprovedEventV1
  | PrivateSlackBlockRejectedEventV1;

export interface PrivateSlackBlockApprovalEventCommitmentV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_SLACK_BLOCK_APPROVAL_EVENT_COMMITMENT_V1_KIND;
  readonly event: PrivateSlackBlockApprovalEventV1;
}

export interface PrivateSlackBlockApprovalIdempotencyV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_SLACK_BLOCK_APPROVAL_IDEMPOTENCY_V1_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly command_id: string;
  readonly approval_id: string;
  readonly assignment_version: number;
  readonly action: PrivateSlackBlockApprovalActionV1;
  readonly private_slack_block_approval_resolution_ref_sha256: Sha256Digest;
  readonly private_slack_block_approval_event_sha256: Sha256Digest;
}

export interface PrivateSlackBlockApprovalRecordInputV1 {
  readonly private_slack_block_approval_resolution_ref: PrivateSlackBlockApprovalResolutionRefV1;
  readonly event: PrivateSlackBlockApprovalEventV1;
  readonly idempotency: PrivateSlackBlockApprovalIdempotencyV1;
}

/** The validated record input is the versioned private human-action witness. */
export interface ValidatedPrivateSlackBlockApprovalRecordInputV1
  extends PrivateSlackBlockApprovalRecordInputV1 {
  readonly private_slack_block_approval_resolution_ref_sha256: Sha256Digest;
  readonly private_slack_block_approval_event_sha256: Sha256Digest;
  readonly semantic_idempotency_key: Sha256Digest;
}

export interface BuildPrivateSlackBlockApprovalRecordInputV1 {
  readonly private_slack_block_approval_resolution_ref: PrivateSlackBlockApprovalResolutionRefV1;
  readonly event: PrivateSlackBlockApprovalEventV1;
}

function fail(message: string): never {
  return organizationProtocolValidationFailure(message);
}

function assertPlainJsonData(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (typeof value !== "object") fail(`${label} must contain only JSON data`);
  if (seen.has(value)) fail(`${label} must not contain a cycle`);
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol properties`);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a plain array`);
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes("length")) fail(`${label} must be a dense plain array`);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) fail(`${label} must contain only enumerable data properties`);
        assertPlainJsonData(descriptor.value, label, seen);
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label} must contain only enumerable data properties`);
      assertPlainJsonData(descriptor.value, `${label}.${key}`, seen);
    }
  } finally { seen.delete(value); }
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  assertPlainJsonData(value, label);
  const snapshot = canonicalSnapshot(value, label, MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) fail(`${label} must be a plain object`);
  const record = snapshot as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has an unexpected shape`);
  return record;
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(`${label} must be a bounded canonical identifier`);
}

function action(value: unknown, label: string): asserts value is PrivateSlackBlockApprovalActionV1 {
  if (value !== "approve" && value !== "reject") fail(`${label} is unsupported`);
}

function comment(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > PRIVATE_SLACK_BLOCK_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS || value.trim().length === 0 || value !== value.trim() || DISALLOWED_COMMENT_CONTROL.test(value)) {
    fail("Private Slack block approval comment must be bounded canonical text or null");
  }
  return value;
}

function assignee(value: unknown, label: string): PrivateSlackBlockApprovalAssigneeV1 {
  const record = exactObject(value, ASSIGNEE_KEYS, label);
  identifier(record.principal_id, `${label} principal_id`);
  identifier(record.membership_id, `${label} membership_id`);
  return Object.freeze({ principal_id: record.principal_id, membership_id: record.membership_id });
}

function slackLink(value: unknown): PrivateSlackBlockApprovalSlackIdentityLinkV1 {
  const record = exactObject(value, SLACK_LINK_KEYS, "Private Slack block approval identity link");
  if (record.provider !== "slack") fail("Private Slack block approval identity link provider is unsupported");
  if (typeof record.external_identity_link_id !== "string" || !EXTERNAL_IDENTITY_LINK_ID.test(record.external_identity_link_id)) fail("Private Slack block approval identity link ID is invalid");
  assertDigest(record.external_identity_link_contract_sha256, "Private Slack block approval identity link digest");
  if (typeof record.provider_subject_id !== "string" || !SLACK_HUMAN_SUBJECT.test(record.provider_subject_id)) fail("Private Slack block approval identity link subject is invalid");
  return Object.freeze({ provider: "slack", external_identity_link_id: record.external_identity_link_id, external_identity_link_contract_sha256: record.external_identity_link_contract_sha256, provider_subject_id: record.provider_subject_id });
}

function policyCommitment(policyId: unknown, contract: unknown, consequence: unknown, label: string): asserts policyId is PersonContentPolicyIdV2 {
  assertDigest(contract, `${label} policy contract digest`);
  assertDigest(consequence, `${label} policy consequence digest`);
  if (policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID && contract === restrictedReviewerPersonPolicyContractSha256() && consequence === restrictedReviewerPersonConsequenceSha256()) return;
  if (policyId === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID && contract === organizationMemberReadablePersonPolicyContractSha256() && consequence === organizationMemberReadablePersonConsequenceSha256()) return;
  fail(`${label} has an unsupported Person policy`);
}

export function validatePrivateSlackBlockApprovalResolutionRefV1(value: unknown): PrivateSlackBlockApprovalResolutionRefV1 {
  const ref = exactObject(value, REF_KEYS, "Private Slack block approval resolution ref v1");
  if (ref.schema_version !== 1 || ref.kind !== PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND) fail("Private Slack block approval resolution ref v1 has an unsupported envelope");
  for (const key of ["authority_id", "organization_id", "state_lineage_id", "command_id", "approval_id", "audit_event_id"] as const) identifier(ref[key], `Private Slack block approval resolution ref v1 ${key}`);
  for (const key of ["candidate_sha256", "frozen_card_sha256", "approved_snapshot_sha256", "assignment_capability_sha256", "audit_entry_sha256", "provider_action_sha256", "authorization_proof_sha256"] as const) assertDigest(ref[key], `Private Slack block approval resolution ref v1 ${key}`);
  assertPositiveSafeInteger(ref.assignment_version, "Private Slack block approval resolution ref v1 assignment_version");
  assertPositiveSafeInteger(ref.audit_sequence, "Private Slack block approval resolution ref v1 audit_sequence");
  action(ref.action, "Private Slack block approval resolution ref v1 action");
  if (ref.provider_action_kind !== SIGNED_SLACK_BLOCK_ACTION_V1_KIND || ref.provider_action_schema_version !== 1) fail("Private Slack block approval resolution ref v1 must name a signed Slack block action");
  const finalApprover = assignee(ref.final_approver, "Private Slack block approval final approver");
  const link = slackLink(ref.current_slack_identity_link);
  if (ref.action === "approve") {
    policyCommitment(ref.selected_policy_id, ref.policy_contract_sha256, ref.policy_consequence_sha256, "Private Slack block approval resolution ref v1");
  } else if (ref.selected_policy_id !== null || ref.policy_contract_sha256 !== null || ref.policy_consequence_sha256 !== null) {
    fail("Private Slack block approval rejection must not select a policy");
  }
  return Object.freeze({
    schema_version: 1, kind: PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND,
    authority_id: ref.authority_id as string, organization_id: ref.organization_id as string, state_lineage_id: ref.state_lineage_id as string,
    command_id: ref.command_id as string, approval_id: ref.approval_id as string,
    candidate_sha256: ref.candidate_sha256 as Sha256Digest, frozen_card_sha256: ref.frozen_card_sha256 as Sha256Digest, approved_snapshot_sha256: ref.approved_snapshot_sha256 as Sha256Digest,
    assignment_version: ref.assignment_version, assignment_capability_sha256: ref.assignment_capability_sha256 as Sha256Digest,
    final_approver: finalApprover, current_slack_identity_link: link,
    action: ref.action as PrivateSlackBlockApprovalActionV1, selected_policy_id: ref.selected_policy_id as PersonContentPolicyIdV2 | null,
    policy_contract_sha256: ref.policy_contract_sha256 as Sha256Digest | null, policy_consequence_sha256: ref.policy_consequence_sha256 as Sha256Digest | null,
    comment: comment(ref.comment), audit_event_id: ref.audit_event_id as string, audit_sequence: ref.audit_sequence as number,
    audit_entry_sha256: ref.audit_entry_sha256 as Sha256Digest,
    provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND, provider_action_schema_version: 1,
    provider_action_sha256: ref.provider_action_sha256 as Sha256Digest, authorization_proof_sha256: ref.authorization_proof_sha256 as Sha256Digest,
  });
}

export function privateSlackBlockApprovalResolutionRefV1Sha256(value: PrivateSlackBlockApprovalResolutionRefV1): Sha256Digest {
  return canonicalSha256(validatePrivateSlackBlockApprovalResolutionRefV1(value));
}

export function validatePrivateSlackBlockApprovalEventV1(value: unknown): PrivateSlackBlockApprovalEventV1 {
  assertPlainJsonData(value, "Private Slack block approval event v1");
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("Private Slack block approval event v1 must be a plain object");
  if ((value as Record<string, unknown>).kind === "rejected") {
    exactObject(value, REJECTED_EVENT_KEYS, "Private Slack block rejected event v1");
    return Object.freeze({ kind: "rejected" });
  }
  const event = exactObject(value, APPROVED_EVENT_KEYS, "Private Slack block approved event v1");
  if (event.kind !== "approved") fail("Private Slack block approval event v1 kind is unsupported");
  const snapshot = validateApprovedDecisionSnapshotV2(event.approved_snapshot);
  assertDigest(event.approved_snapshot_sha256, "Private Slack block approved event snapshot digest");
  if (event.approved_snapshot_sha256 !== approvedDecisionSnapshotV2Sha256(snapshot)) fail("Private Slack block approved event snapshot digest does not match snapshot");
  policyCommitment(event.policy_id, event.policy_contract_sha256, event.policy_consequence_sha256, "Private Slack block approved event");
  const expectedText = event.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID ? RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT : ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT;
  if (event.policy_consequence_text !== expectedText) fail("Private Slack block approved event consequence text does not match policy");
  return Object.freeze({ kind: "approved", approved_snapshot: snapshot, approved_snapshot_sha256: event.approved_snapshot_sha256 as Sha256Digest, policy_id: event.policy_id as PersonContentPolicyIdV2, policy_contract_sha256: event.policy_contract_sha256 as Sha256Digest, policy_consequence_text: expectedText, policy_consequence_sha256: event.policy_consequence_sha256 as Sha256Digest });
}

export function privateSlackBlockApprovalEventV1Sha256(value: PrivateSlackBlockApprovalEventV1): Sha256Digest {
  return canonicalSha256({ schema_version: 1, kind: PRIVATE_SLACK_BLOCK_APPROVAL_EVENT_COMMITMENT_V1_KIND, event: validatePrivateSlackBlockApprovalEventV1(value) });
}

function validateIdempotency(value: unknown): PrivateSlackBlockApprovalIdempotencyV1 {
  const item = exactObject(value, IDEMPOTENCY_KEYS, "Private Slack block approval idempotency v1");
  if (item.schema_version !== 1 || item.kind !== PRIVATE_SLACK_BLOCK_APPROVAL_IDEMPOTENCY_V1_KIND) fail("Private Slack block approval idempotency v1 has an unsupported envelope");
  for (const key of ["authority_id", "organization_id", "state_lineage_id", "command_id", "approval_id"] as const) identifier(item[key], `Private Slack block approval idempotency v1 ${key}`);
  assertPositiveSafeInteger(item.assignment_version, "Private Slack block approval idempotency v1 assignment_version");
  action(item.action, "Private Slack block approval idempotency v1 action");
  assertDigest(item.private_slack_block_approval_resolution_ref_sha256, "Private Slack block approval idempotency v1 resolution digest");
  assertDigest(item.private_slack_block_approval_event_sha256, "Private Slack block approval idempotency v1 event digest");
  return item as unknown as PrivateSlackBlockApprovalIdempotencyV1;
}

export function privateSlackBlockApprovalIdempotencyV1Sha256(value: PrivateSlackBlockApprovalIdempotencyV1): Sha256Digest {
  return canonicalSha256(validateIdempotency(value));
}

export function validatePrivateSlackBlockApprovalRecordInputV1(value: unknown): ValidatedPrivateSlackBlockApprovalRecordInputV1 {
  const input = exactObject(value, INPUT_KEYS, "Private Slack block approval record input v1");
  const ref = validatePrivateSlackBlockApprovalResolutionRefV1(input.private_slack_block_approval_resolution_ref);
  const event = validatePrivateSlackBlockApprovalEventV1(input.event);
  const idempotency = validateIdempotency(input.idempotency);
  const refSha256 = privateSlackBlockApprovalResolutionRefV1Sha256(ref);
  const eventSha256 = privateSlackBlockApprovalEventV1Sha256(event);
  if (idempotency.private_slack_block_approval_resolution_ref_sha256 !== refSha256 || idempotency.private_slack_block_approval_event_sha256 !== eventSha256) fail("Private Slack block approval idempotency digests do not match its bodies");
  for (const key of ["authority_id", "organization_id", "state_lineage_id", "command_id", "approval_id", "assignment_version", "action"] as const) if (idempotency[key] !== ref[key]) fail(`Private Slack block approval idempotency ${key} does not match resolution`);
  if (event.kind === "approved") {
    if (ref.action !== "approve" || ref.selected_policy_id !== event.policy_id || ref.policy_contract_sha256 !== event.policy_contract_sha256 || ref.policy_consequence_sha256 !== event.policy_consequence_sha256 || ref.approved_snapshot_sha256 !== event.approved_snapshot_sha256 || event.approved_snapshot.approval_id !== ref.approval_id) fail("Private Slack block approved event does not match resolution");
  } else if (ref.action !== "reject") {
    fail("Private Slack block rejected event does not match resolution action");
  }
  return Object.freeze({ private_slack_block_approval_resolution_ref: ref, event, idempotency, private_slack_block_approval_resolution_ref_sha256: refSha256, private_slack_block_approval_event_sha256: eventSha256, semantic_idempotency_key: privateSlackBlockApprovalIdempotencyV1Sha256(idempotency) });
}

export function buildPrivateSlackBlockApprovalRecordInputV1(value: BuildPrivateSlackBlockApprovalRecordInputV1): ValidatedPrivateSlackBlockApprovalRecordInputV1 {
  const input = exactObject(value, BUILD_INPUT_KEYS, "Private Slack block approval record input v1 build input");
  const ref = validatePrivateSlackBlockApprovalResolutionRefV1(input.private_slack_block_approval_resolution_ref);
  const event = validatePrivateSlackBlockApprovalEventV1(input.event);
  return validatePrivateSlackBlockApprovalRecordInputV1({
    private_slack_block_approval_resolution_ref: ref,
    event,
    idempotency: {
      schema_version: 1, kind: PRIVATE_SLACK_BLOCK_APPROVAL_IDEMPOTENCY_V1_KIND,
      authority_id: ref.authority_id, organization_id: ref.organization_id, state_lineage_id: ref.state_lineage_id,
      command_id: ref.command_id, approval_id: ref.approval_id, assignment_version: ref.assignment_version, action: ref.action,
      private_slack_block_approval_resolution_ref_sha256: privateSlackBlockApprovalResolutionRefV1Sha256(ref),
      private_slack_block_approval_event_sha256: privateSlackBlockApprovalEventV1Sha256(event),
    },
  });
}
