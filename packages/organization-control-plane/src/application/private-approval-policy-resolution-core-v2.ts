/**
 * Versioned extension of the provider-neutral private approval contract.
 *
 * V1 documents are deliberately decoded only by the V1 module. V2 binds the
 * project audience/association and the optional, exact transcript release to
 * the same immutable approval consequence as the selected record policy.
 */
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type ApprovalContractSha256,
  type PersonApprovalPolicyIdV2,
} from "./record-visibility-policy-contracts-v1.js";
import {
  PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
  privateApprovalAssignee,
  privateApprovalComment,
  privateApprovalDigest,
  privateApprovalExactRecord,
  privateApprovalIdentifier,
  privateApprovalInvalid,
  type PrivateApprovalActionV1,
  type PrivateApprovalAssigneeV1,
} from "./private-approval-policy-resolution-core-v1.js";

export const PRIVATE_APPROVAL_PENDING_V2_KIND = "echo-private-approval-pending-v2" as const;
export const PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_V2_KIND =
  "echo-private-approval-authorization-allow-v2" as const;
export const PRIVATE_APPROVAL_RESOLUTION_V2_KIND = "echo-private-approval-resolution-v2" as const;
export const PRIVATE_APPROVAL_PROJECT_SELECTION_MAX = 20;
export { PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS };
const PROJECT_ID = /^prj_[0-9a-f-]{36}$/;

export interface PrivateApprovalTranscriptSourceV1 {
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: ApprovalContractSha256;
}

export interface PrivateApprovalResolutionCommandV2 {
  readonly schema_version: 2;
  readonly command_id: string;
  readonly approval_id: string;
  readonly action: PrivateApprovalActionV1;
  readonly selected_policy_id: PersonApprovalPolicyIdV2 | null;
  /** Card selection: canonical sorted, unique, and bound into the V2 consequence. */
  readonly selected_project_ids: readonly string[];
  /** Default false. A true value releases only the exact committed source below. */
  readonly share_transcript: boolean;
  readonly comment: string | null;
}

export interface PrivateApprovalPolicyBindingV2 {
  readonly policy_id: PersonApprovalPolicyIdV2;
  readonly policy_contract_sha256: ApprovalContractSha256;
  /** Dynamic V2 consequence digest, including project IDs and transcript choice. */
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly restricted_reader: PrivateApprovalAssigneeV1 | null;
  /** Audience and association are distinct durable facts, even when this lean UI seeds both equally. */
  readonly audience_project_ids: readonly string[];
  readonly association_project_ids: readonly string[];
  readonly share_transcript: boolean;
  readonly transcript_source: PrivateApprovalTranscriptSourceV1;
}

/** Exact human choice document hashed into every V2 project/transcript consequence. */
export interface PrivateApprovalPolicyConsequenceV2 {
  readonly schema_version: 2;
  readonly kind: "echo-private-slack-block-approval-consequence-v2";
  readonly policy_id: PersonApprovalPolicyIdV2;
  readonly audience_project_ids: readonly string[];
  readonly association_project_ids: readonly string[];
  readonly share_transcript: boolean;
  readonly transcript_source: PrivateApprovalTranscriptSourceV1;
}

export interface PrivateApprovalResolutionOutcomeV2 {
  readonly command_id: string;
  readonly approval_id: string;
  readonly action: PrivateApprovalActionV1;
  readonly comment: string | null;
  readonly canonical_record_policy: PrivateApprovalPolicyBindingV2 | null;
}

function projectIds(value: unknown, label: string, requireAtLeastOne: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > PRIVATE_APPROVAL_PROJECT_SELECTION_MAX ||
      (requireAtLeastOne && value.length === 0)) {
    privateApprovalInvalid(`${label} must contain ${requireAtLeastOne ? "one to" : "at most"} ${PRIVATE_APPROVAL_PROJECT_SELECTION_MAX} project IDs`);
  }
  const ids = value.map((id, index) => {
    if (typeof id !== "string" || !PROJECT_ID.test(id)) {
      privateApprovalInvalid(`${label}[${index}] must be a canonical project ID`);
    }
    return id;
  });
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    privateApprovalInvalid(`${label} must be sorted and unique`);
  }
  return Object.freeze(ids);
}

export function privateApprovalTranscriptSourceV1(value: unknown, label: string): PrivateApprovalTranscriptSourceV1 {
  const record = privateApprovalExactRecord(value, ["source_id", "revision_id", "source_sha256"], label);
  privateApprovalIdentifier(record.source_id, `${label}.source_id`);
  privateApprovalIdentifier(record.revision_id, `${label}.revision_id`);
  privateApprovalDigest(record.source_sha256, `${label}.source_sha256`);
  return Object.freeze({
    source_id: record.source_id,
    revision_id: record.revision_id,
    source_sha256: record.source_sha256,
  });
}


export function validatePrivateApprovalResolutionCommandV2(value: unknown): PrivateApprovalResolutionCommandV2 {
  const record = privateApprovalExactRecord(value, [
    "schema_version", "command_id", "approval_id", "action", "selected_policy_id",
    "selected_project_ids", "share_transcript", "comment",
  ], "approval command v2");
  if (record.schema_version !== 2) privateApprovalInvalid("approval command v2 schema_version must be 2");
  privateApprovalIdentifier(record.command_id, "approval command v2 command_id");
  privateApprovalIdentifier(record.approval_id, "approval command v2 approval_id");
  if (record.action !== "approve" && record.action !== "reject") privateApprovalInvalid("approval command v2 action is unsupported");
  if (record.selected_policy_id !== null && record.selected_policy_id !== RESTRICTED_REVIEWER_PERSON_POLICY_ID &&
      record.selected_policy_id !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID && record.selected_policy_id !== PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID) {
    privateApprovalInvalid("approval command v2 selected_policy_id is unsupported");
  }
  if (typeof record.share_transcript !== "boolean") privateApprovalInvalid("approval command v2 share_transcript must be boolean");
  const projectPolicy = record.selected_policy_id === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
  const ids = projectIds(record.selected_project_ids, "approval command v2 selected_project_ids", projectPolicy);
  if (record.action === "approve" && record.selected_policy_id === null) privateApprovalInvalid("approval command v2 approve requires a policy");
  if (record.action === "reject" && (record.selected_policy_id !== null || ids.length !== 0 || record.share_transcript !== false)) {
    privateApprovalInvalid("approval command v2 reject must not select policy, projects, or transcript sharing");
  }
  if (!projectPolicy && ids.length !== 0) privateApprovalInvalid("approval command v2 only the project policy may select projects");
  return Object.freeze({ schema_version: 2, command_id: record.command_id, approval_id: record.approval_id,
    action: record.action, selected_policy_id: record.selected_policy_id, selected_project_ids: ids,
    share_transcript: record.share_transcript, comment: privateApprovalComment(record.comment, "approval command v2 comment") });
}

/** Builds the durable binding after the provider has revalidated the selected frozen grants. */
export function privateApprovalPolicyBindingV2(input: {
  readonly policy_id: PersonApprovalPolicyIdV2;
  readonly approver: PrivateApprovalAssigneeV1;
  readonly audience_project_ids: readonly string[];
  readonly association_project_ids: readonly string[];
  readonly share_transcript: boolean;
  readonly transcript_source: PrivateApprovalTranscriptSourceV1;
  readonly policy_consequence_sha256: ApprovalContractSha256;
}): PrivateApprovalPolicyBindingV2 {
  const approver = privateApprovalAssignee(input.approver, "V2 policy approver");
  if (input.policy_id !== PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID && input.policy_id !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID && input.policy_id !== RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
    privateApprovalInvalid("V2 policy ID is unsupported");
  }
  const audience = projectIds(input.audience_project_ids, "V2 policy audience_project_ids", input.policy_id === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
  const association = projectIds(input.association_project_ids, "V2 policy association_project_ids", input.policy_id === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
  if (input.policy_id === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID &&
      (audience.length !== association.length || audience.some((id, index) => id !== association[index]))) {
    privateApprovalInvalid("V2 project policy requires the lean audience and association selections to match");
  }
  if (input.policy_id !== PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID && (audience.length !== 0 || association.length !== 0)) {
    privateApprovalInvalid("V2 non-project policy must not carry project IDs");
  }
  if (typeof input.share_transcript !== "boolean") privateApprovalInvalid("V2 policy share_transcript must be boolean");
  privateApprovalDigest(input.policy_consequence_sha256, "V2 policy consequence digest");
  const source = privateApprovalTranscriptSourceV1(input.transcript_source, "V2 policy transcript_source");
  if (input.policy_id === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID) return Object.freeze({
    policy_id: input.policy_id, policy_contract_sha256: PROJECT_MEMBERS_READABLE_PERSON_POLICY_CONTRACT_SHA256,
    policy_consequence_sha256: input.policy_consequence_sha256, restricted_reader: null,
    audience_project_ids: audience, association_project_ids: association,
    share_transcript: input.share_transcript, transcript_source: source,
  });
  if (input.policy_id === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID) return Object.freeze({
    policy_id: input.policy_id, policy_contract_sha256: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
    policy_consequence_sha256: input.policy_consequence_sha256, restricted_reader: null,
    audience_project_ids: audience, association_project_ids: association,
    share_transcript: input.share_transcript, transcript_source: source,
  });
  return Object.freeze({
    policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID, policy_contract_sha256: RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
    policy_consequence_sha256: input.policy_consequence_sha256, restricted_reader: approver,
    audience_project_ids: audience, association_project_ids: association,
    share_transcript: input.share_transcript, transcript_source: source,
  });
}
