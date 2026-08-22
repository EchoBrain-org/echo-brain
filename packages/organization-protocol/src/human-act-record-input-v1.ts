import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type {
  OrganizationRecordApprovalPayloadV1,
  OrganizationRecordRejectionPayloadV1,
} from "./contracts.js";
import {
  assertOrganizationRecordApprovalPayload,
  assertOrganizationRecordRejectionPayload,
} from "./record-payload.js";
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
  assertDigest,
  assertPositiveSafeInteger,
  canonicalSnapshot,
} from "./validation-support.js";
import { MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES } from "./record-payload.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export const APPROVED_DECISION_SNAPSHOT_V2_KIND =
  "echo-approved-decision-snapshot-v2" as const;
export const HUMAN_ACT_RESOLUTION_REF_V1_KIND =
  "echo-human-act-resolution-ref-v1" as const;
export const HUMAN_ACT_EVENT_COMMITMENT_V1_KIND =
  "echo-human-act-event-commitment-v1" as const;
export const AUTHORITY_HUMAN_ACT_IDEMPOTENCY_V2_KIND =
  "echo-authority-human-act-idempotency-v2" as const;

const APPROVED_DECISION_SNAPSHOT_KEYS = [
  "schema_version",
  "kind",
  "approval_id",
  "staged_content_sha256",
  "final_content_sha256",
  "payload_contract_id",
  "approved_payload",
] as const;
const HUMAN_ACT_RESOLUTION_REF_KEYS = [
  "schema_version",
  "kind",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "approval_id",
  "action",
  "policy_id",
  "policy_contract_sha256",
  "audit_event_id",
  "audit_sequence",
  "audit_entry_sha256",
  "provider_action_kind",
  "provider_action_schema_version",
  "provider_action_sha256",
  "authorization_proof_sha256",
] as const;
const APPROVED_EVENT_KEYS = [
  "kind",
  "approved_snapshot",
  "approved_snapshot_sha256",
  "policy_id",
  "policy_contract_sha256",
  "policy_consequence_text",
  "policy_consequence_sha256",
] as const;
const REJECTED_EVENT_KEYS = [
  "kind",
  "candidate_sha256",
  "approved_snapshot_sha256",
  "frozen_card_sha256",
  "policy_id",
  "policy_contract_sha256",
  "policy_consequence_sha256",
  "action",
  "rejection_payload",
] as const;
const HUMAN_ACT_EVENT_COMMITMENT_KEYS = [
  "schema_version",
  "kind",
  "event",
] as const;
const HUMAN_ACT_IDEMPOTENCY_KEYS = [
  "schema_version",
  "kind",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "approval_id",
  "action",
  "human_act_resolution_ref_sha256",
  "human_act_event_sha256",
] as const;

export type HumanActActionV1 = "approve" | "reject";
export type PersonContentPolicyIdV2 =
  | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID
  | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;

export interface ApprovedDecisionSnapshotV2 {
  readonly schema_version: 2;
  readonly kind: typeof APPROVED_DECISION_SNAPSHOT_V2_KIND;
  readonly approval_id: string;
  /** These opaque frozen commitments are intentionally not re-derived here. */
  readonly staged_content_sha256: Sha256Digest;
  /** These opaque frozen commitments are intentionally not re-derived here. */
  readonly final_content_sha256: Sha256Digest;
  readonly payload_contract_id: "organization-record-approval-payload-v1";
  readonly approved_payload: OrganizationRecordApprovalPayloadV1;
}

export interface HumanActResolutionRefV1 {
  readonly schema_version: 1;
  readonly kind: typeof HUMAN_ACT_RESOLUTION_REF_V1_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: HumanActActionV1;
  readonly policy_id: PersonContentPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: "echo-provider-human-action-v2";
  readonly provider_action_schema_version: 2;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}

export interface ApprovedHumanActEventV1 {
  readonly kind: "approved";
  readonly approved_snapshot: ApprovedDecisionSnapshotV2;
  readonly approved_snapshot_sha256: Sha256Digest;
  readonly policy_id: PersonContentPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly policy_consequence_text: string;
  readonly policy_consequence_sha256: Sha256Digest;
}

export interface RejectedHumanActEventV1 {
  readonly kind: "rejected";
  readonly candidate_sha256: Sha256Digest;
  readonly approved_snapshot_sha256: Sha256Digest;
  readonly frozen_card_sha256: Sha256Digest;
  readonly policy_id: PersonContentPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly policy_consequence_sha256: Sha256Digest;
  readonly action: "reject";
  readonly rejection_payload: OrganizationRecordRejectionPayloadV1;
}

export type HumanActEventV1 =
  | ApprovedHumanActEventV1
  | RejectedHumanActEventV1;

export interface HumanActEventCommitmentV1 {
  readonly schema_version: 1;
  readonly kind: typeof HUMAN_ACT_EVENT_COMMITMENT_V1_KIND;
  readonly event: HumanActEventV1;
}

export interface HumanActIdempotencyV2 {
  readonly schema_version: 2;
  readonly kind: typeof AUTHORITY_HUMAN_ACT_IDEMPOTENCY_V2_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: HumanActActionV1;
  readonly human_act_resolution_ref_sha256: Sha256Digest;
  readonly human_act_event_sha256: Sha256Digest;
}

export interface HumanActRecordInputV1 {
  readonly human_act_resolution_ref: HumanActResolutionRefV1;
  readonly event: HumanActEventV1;
  readonly idempotency: HumanActIdempotencyV2;
}

export interface ValidatedHumanActRecordInputV1 extends HumanActRecordInputV1 {
  readonly human_act_resolution_ref_sha256: Sha256Digest;
  readonly human_act_event_sha256: Sha256Digest;
  readonly semantic_idempotency_key: Sha256Digest;
}

export interface BuildHumanActRecordInputV1 {
  readonly human_act_resolution_ref: HumanActResolutionRefV1;
  readonly event: HumanActEventV1;
}

function fail(message: string): never {
  return organizationProtocolValidationFailure(message);
}

function assertPlainJsonData(
  value: unknown,
  label: string,
  seen: Set<object> = new Set<object>(),
): void {
  if (value === null) return;
  if (typeof value !== "object") {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      fail(`${label} must contain only JSON data`);
    }
    return;
  }
  if (seen.has(value)) fail(`${label} must not contain a cycle`);
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      fail(`${label} must not contain symbol properties`);
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail(`${label} must be a plain array`);
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes("length")) {
        fail(`${label} must be a dense plain array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          fail(`${label} must contain only enumerable data properties`);
        }
        assertPlainJsonData(descriptor.value, label, seen);
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      fail(`${label} must be a plain object`);
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        fail(`${label} must contain only enumerable data properties`);
      }
      assertPlainJsonData(descriptor.value, label, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  assertPlainJsonData(value, label);
  const snapshot = canonicalSnapshot(
    value,
    label,
    MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
  );
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    fail(`${label} must be a plain object`);
  }
  const record = snapshot as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
  return record;
}

function assertText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    fail(`${label} must be a bounded non-empty string`);
  }
}

function assertAction(value: unknown, label: string): asserts value is HumanActActionV1 {
  if (value !== "approve" && value !== "reject") fail(`${label} is unsupported`);
}

function assertPolicyCommitment(
  policyId: unknown,
  policyContractSha256: unknown,
  policyConsequenceSha256: unknown,
  label: string,
): asserts policyId is PersonContentPolicyIdV2 {
  if (policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
    if (
      policyContractSha256 !== restrictedReviewerPersonPolicyContractSha256() ||
      policyConsequenceSha256 !== restrictedReviewerPersonConsequenceSha256()
    ) {
      fail(`${label} does not match restricted-reviewer Person policy v2`);
    }
    return;
  }
  if (policyId === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID) {
    if (
      policyContractSha256 !== organizationMemberReadablePersonPolicyContractSha256() ||
      policyConsequenceSha256 !== organizationMemberReadablePersonConsequenceSha256()
    ) {
      fail(`${label} does not match organization-member Person policy v2`);
    }
    return;
  }
  fail(`${label} has an unsupported Person policy`);
}

function assertPolicyContract(
  policyId: unknown,
  policyContractSha256: unknown,
  label: string,
): asserts policyId is PersonContentPolicyIdV2 {
  assertDigest(policyContractSha256, `${label} policy contract digest`);
  if (
    (policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID &&
      policyContractSha256 === restrictedReviewerPersonPolicyContractSha256()) ||
    (policyId === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID &&
      policyContractSha256 === organizationMemberReadablePersonPolicyContractSha256())
  ) {
    return;
  }
  fail(`${label} has an unsupported Person policy`);
}

export function validateApprovedDecisionSnapshotV2(
  value: unknown,
): ApprovedDecisionSnapshotV2 {
  const snapshot = exactObject(
    value,
    APPROVED_DECISION_SNAPSHOT_KEYS,
    "Approved decision snapshot v2",
  );
  if (snapshot.schema_version !== 2 || snapshot.kind !== APPROVED_DECISION_SNAPSHOT_V2_KIND) {
    fail("Approved decision snapshot v2 has an unsupported envelope");
  }
  assertText(snapshot.approval_id, "Approved decision snapshot v2 approval_id");
  assertDigest(snapshot.staged_content_sha256, "Approved decision snapshot v2 staged_content_sha256");
  assertDigest(snapshot.final_content_sha256, "Approved decision snapshot v2 final_content_sha256");
  if (snapshot.payload_contract_id !== "organization-record-approval-payload-v1") {
    fail("Approved decision snapshot v2 has an unsupported payload contract");
  }
  assertOrganizationRecordApprovalPayload(
    snapshot.approved_payload,
    "Approved decision snapshot v2 approved_payload",
  );
  return snapshot as unknown as ApprovedDecisionSnapshotV2;
}

export function approvedDecisionSnapshotV2Sha256(
  snapshot: ApprovedDecisionSnapshotV2,
): Sha256Digest {
  return canonicalSha256(validateApprovedDecisionSnapshotV2(snapshot));
}

export function validateHumanActResolutionRefV1(
  value: unknown,
): HumanActResolutionRefV1 {
  const reference = exactObject(
    value,
    HUMAN_ACT_RESOLUTION_REF_KEYS,
    "Human act resolution ref v1",
  );
  if (reference.schema_version !== 1 || reference.kind !== HUMAN_ACT_RESOLUTION_REF_V1_KIND) {
    fail("Human act resolution ref v1 has an unsupported envelope");
  }
  for (const key of [
    "authority_id",
    "organization_id",
    "state_lineage_id",
    "approval_id",
    "audit_event_id",
  ] as const) {
    assertText(reference[key], `Human act resolution ref v1 ${key}`);
  }
  assertAction(reference.action, "Human act resolution ref v1 action");
  assertPolicyContract(
    reference.policy_id,
    reference.policy_contract_sha256,
    "Human act resolution ref v1",
  );
  assertPositiveSafeInteger(reference.audit_sequence, "Human act resolution ref v1 audit_sequence");
  for (const key of [
    "audit_entry_sha256",
    "provider_action_sha256",
    "authorization_proof_sha256",
  ] as const) {
    assertDigest(reference[key], `Human act resolution ref v1 ${key}`);
  }
  if (
    reference.provider_action_kind !== "echo-provider-human-action-v2" ||
    reference.provider_action_schema_version !== 2
  ) {
    fail("Human act resolution ref v1 has an unsupported provider action version");
  }
  return reference as unknown as HumanActResolutionRefV1;
}

export function humanActResolutionRefV1Sha256(
  reference: HumanActResolutionRefV1,
): Sha256Digest {
  return canonicalSha256(validateHumanActResolutionRefV1(reference));
}

export function validateHumanActEventV1(value: unknown): HumanActEventV1 {
  assertPlainJsonData(value, "Human act event v1");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("Human act event v1 must be a plain object");
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "approved") {
    const event = exactObject(value, APPROVED_EVENT_KEYS, "Approved human act event v1");
    const snapshot = validateApprovedDecisionSnapshotV2(event.approved_snapshot);
    assertDigest(event.approved_snapshot_sha256, "Approved human act event v1 approved_snapshot_sha256");
    if (event.approved_snapshot_sha256 !== approvedDecisionSnapshotV2Sha256(snapshot)) {
      fail("Approved human act event v1 approved_snapshot_sha256 does not match snapshot");
    }
    assertPolicyCommitment(
      event.policy_id,
      event.policy_contract_sha256,
      event.policy_consequence_sha256,
      "Approved human act event v1 policy",
    );
    const expectedText =
      event.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID
        ? RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT
        : ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT;
    if (event.policy_consequence_text !== expectedText) {
      fail("Approved human act event v1 policy consequence text does not match policy");
    }
    return event as unknown as ApprovedHumanActEventV1;
  }
  if (kind === "rejected") {
    const event = exactObject(value, REJECTED_EVENT_KEYS, "Rejected human act event v1");
    for (const key of [
      "candidate_sha256",
      "approved_snapshot_sha256",
      "frozen_card_sha256",
    ] as const) {
      assertDigest(event[key], `Rejected human act event v1 ${key}`);
    }
    assertPolicyCommitment(
      event.policy_id,
      event.policy_contract_sha256,
      event.policy_consequence_sha256,
      "Rejected human act event v1 policy",
    );
    if (event.action !== "reject") fail("Rejected human act event v1 action is unsupported");
    assertOrganizationRecordRejectionPayload(
      event.rejection_payload,
      "Rejected human act event v1 rejection_payload",
    );
    return event as unknown as RejectedHumanActEventV1;
  }
  fail("Human act event v1 kind is unsupported");
}

export function validateHumanActEventCommitmentV1(
  value: unknown,
): HumanActEventCommitmentV1 {
  const commitment = exactObject(
    value,
    HUMAN_ACT_EVENT_COMMITMENT_KEYS,
    "Human act event commitment v1",
  );
  if (
    commitment.schema_version !== 1 ||
    commitment.kind !== HUMAN_ACT_EVENT_COMMITMENT_V1_KIND
  ) {
    fail("Human act event commitment v1 has an unsupported envelope");
  }
  return {
    schema_version: 1,
    kind: HUMAN_ACT_EVENT_COMMITMENT_V1_KIND,
    event: validateHumanActEventV1(commitment.event),
  };
}

export function buildHumanActEventCommitmentV1(
  event: HumanActEventV1,
): HumanActEventCommitmentV1 {
  return validateHumanActEventCommitmentV1({
    schema_version: 1,
    kind: HUMAN_ACT_EVENT_COMMITMENT_V1_KIND,
    event,
  });
}

export function humanActEventV1Sha256(event: HumanActEventV1): Sha256Digest {
  return canonicalSha256(buildHumanActEventCommitmentV1(event));
}

export function validateHumanActIdempotencyV2(
  value: unknown,
): HumanActIdempotencyV2 {
  const preimage = exactObject(
    value,
    HUMAN_ACT_IDEMPOTENCY_KEYS,
    "Human act idempotency v2",
  );
  if (
    preimage.schema_version !== 2 ||
    preimage.kind !== AUTHORITY_HUMAN_ACT_IDEMPOTENCY_V2_KIND
  ) {
    fail("Human act idempotency v2 has an unsupported envelope");
  }
  for (const key of [
    "authority_id",
    "organization_id",
    "state_lineage_id",
    "approval_id",
  ] as const) {
    assertText(preimage[key], `Human act idempotency v2 ${key}`);
  }
  assertAction(preimage.action, "Human act idempotency v2 action");
  assertDigest(
    preimage.human_act_resolution_ref_sha256,
    "Human act idempotency v2 human_act_resolution_ref_sha256",
  );
  assertDigest(
    preimage.human_act_event_sha256,
    "Human act idempotency v2 human_act_event_sha256",
  );
  return preimage as unknown as HumanActIdempotencyV2;
}

export function humanActIdempotencyV2Sha256(
  preimage: HumanActIdempotencyV2,
): Sha256Digest {
  return canonicalSha256(validateHumanActIdempotencyV2(preimage));
}

const HUMAN_ACT_RECORD_INPUT_KEYS = [
  "human_act_resolution_ref",
  "event",
  "idempotency",
] as const;
const BUILD_HUMAN_ACT_RECORD_INPUT_KEYS = [
  "human_act_resolution_ref",
  "event",
] as const;

/**
 * The private D3 input join verifies the supplied idempotency body against the
 * closed reference and event bodies, then returns every recomputed digest.
 */
export function validateHumanActRecordInputV1(
  value: unknown,
): ValidatedHumanActRecordInputV1 {
  const input = exactObject(
    value,
    HUMAN_ACT_RECORD_INPUT_KEYS,
    "Human act record input v1",
  );
  const reference = validateHumanActResolutionRefV1(
    input.human_act_resolution_ref,
  );
  const event = validateHumanActEventV1(input.event);
  const idempotency = validateHumanActIdempotencyV2(input.idempotency);
  const referenceSha256 = humanActResolutionRefV1Sha256(reference);
  const eventSha256 = humanActEventV1Sha256(event);
  if (
    idempotency.human_act_resolution_ref_sha256 !== referenceSha256 ||
    idempotency.human_act_event_sha256 !== eventSha256
  ) {
    fail("Human act record input v1 idempotency digests do not match its bodies");
  }
  for (const key of [
    "authority_id",
    "organization_id",
    "state_lineage_id",
    "approval_id",
    "action",
  ] as const) {
    if (idempotency[key] !== reference[key]) {
      fail(`Human act record input v1 idempotency ${key} does not match reference`);
    }
  }
  if (event.kind === "approved") {
    if (reference.action !== "approve") {
      fail("Human act record input v1 approved event does not match reference action");
    }
    if (
      event.policy_id !== reference.policy_id ||
      event.policy_contract_sha256 !== reference.policy_contract_sha256 ||
      event.approved_snapshot.approval_id !== reference.approval_id
    ) {
      fail("Human act record input v1 approved event does not match reference");
    }
  } else {
    if (
      reference.action !== "reject" ||
      event.action !== "reject" ||
      event.policy_id !== reference.policy_id ||
      event.policy_contract_sha256 !== reference.policy_contract_sha256
    ) {
      fail("Human act record input v1 rejected event does not match reference");
    }
  }
  return {
    human_act_resolution_ref: reference,
    event,
    idempotency,
    human_act_resolution_ref_sha256: referenceSha256,
    human_act_event_sha256: eventSha256,
    semantic_idempotency_key: humanActIdempotencyV2Sha256(idempotency),
  };
}

export function buildHumanActRecordInputV1(
  input: BuildHumanActRecordInputV1,
): ValidatedHumanActRecordInputV1 {
  const source = exactObject(
    input,
    BUILD_HUMAN_ACT_RECORD_INPUT_KEYS,
    "Human act record input v1 build input",
  );
  const reference = validateHumanActResolutionRefV1(
    source.human_act_resolution_ref,
  );
  const event = validateHumanActEventV1(source.event);
  const idempotency = validateHumanActIdempotencyV2({
    schema_version: 2,
    kind: AUTHORITY_HUMAN_ACT_IDEMPOTENCY_V2_KIND,
    authority_id: reference.authority_id,
    organization_id: reference.organization_id,
    state_lineage_id: reference.state_lineage_id,
    approval_id: reference.approval_id,
    action: reference.action,
    human_act_resolution_ref_sha256: humanActResolutionRefV1Sha256(reference),
    human_act_event_sha256: humanActEventV1Sha256(event),
  });
  return validateHumanActRecordInputV1({
    human_act_resolution_ref: reference,
    event,
    idempotency,
  });
}
