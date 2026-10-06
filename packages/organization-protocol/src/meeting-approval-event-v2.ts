import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, RESTRICTED_REVIEWER_PERSON_POLICY_ID, organizationMemberReadablePersonPolicyContractSha256, projectMembersReadablePersonPolicyContractSha256, restrictedReviewerPersonPolicyContractSha256 } from './person-content-policy-v2.js';
import { approvedDecisionSnapshotV2Sha256, validateApprovedDecisionSnapshotV2, type ApprovedDecisionSnapshotV2 } from './human-act-record-input-v1.js';
import { assertDigest, canonicalSnapshot } from './validation-support.js';
import { organizationProtocolValidationFailure } from './validation-error.js';
import { MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES } from './record-payload.js';
type V2PolicyId = typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID | typeof PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROJECT_ID = /^prj_[0-9a-f-]{36}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CONSEQUENCE_KEYS = ["schema_version", "kind", "policy_id", "audience_project_ids", "association_project_ids", "share_transcript", "transcript_source"] as const;
const SOURCE_KEYS = ["source_id", "revision_id", "source_sha256"] as const;
const APPROVED_EVENT_KEYS = ["kind", "approved_snapshot", "approved_snapshot_sha256", "policy_id", "policy_contract_sha256", "policy_consequence", "policy_consequence_sha256"] as const;
const REJECTED_EVENT_KEYS = ["kind"] as const;

export interface MeetingApprovalTranscriptSourceV2 {
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: Sha256Digest;
}
export interface MeetingApprovalConsequenceV2 {
  readonly schema_version: 2;
  readonly kind: string;
  readonly policy_id: V2PolicyId;
  readonly audience_project_ids: readonly string[];
  readonly association_project_ids: readonly string[];
  readonly share_transcript: boolean;
  readonly transcript_source: MeetingApprovalTranscriptSourceV2;
}
export interface MeetingApprovedEventV2 {
  readonly kind: "approved"; readonly approved_snapshot: ApprovedDecisionSnapshotV2; readonly approved_snapshot_sha256: Sha256Digest;
  readonly policy_id: V2PolicyId; readonly policy_contract_sha256: Sha256Digest;
  readonly policy_consequence: MeetingApprovalConsequenceV2; readonly policy_consequence_sha256: Sha256Digest;
}
export type MeetingApprovalEventV2 = MeetingApprovedEventV2 | { readonly kind: "rejected" };
function fail(message: string): never { return organizationProtocolValidationFailure(message); }
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const snapshot = canonicalSnapshot(value, label, MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot) || Object.getPrototypeOf(snapshot) !== Object.prototype) fail(`${label} must be a plain object`);
  const actual = Object.keys(snapshot).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has an unexpected shape`);
  return snapshot as Record<string, unknown>;
}
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(`${label} must be a bounded canonical identifier`); return value; }
function digest(value: unknown, label: string): Sha256Digest { if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256 digest`); return value as Sha256Digest; }
function policy(value: unknown, label: string): V2PolicyId {
  if (value !== RESTRICTED_REVIEWER_PERSON_POLICY_ID && value !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID && value !== PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID) fail(`${label} is unsupported`);
  return value;
}
function ids(value: unknown, label: string, required: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 20 || (required && value.length === 0)) fail(`${label} has an invalid project count`);
  const result = value.map((item, index) => {
    const projectId = identifier(item, `${label}[${index}]`);
    if (!PROJECT_ID.test(projectId)) {
      fail(`${label}[${index}] must be a canonical project ID`);
    }
    return projectId;
  });
  if (result.some((id, index) => index > 0 && result[index - 1]! >= id)) fail(`${label} must be sorted and unique`);
  return Object.freeze(result);
}
function source(value: unknown, label: string): MeetingApprovalTranscriptSourceV2 {
  const record = exact(value, SOURCE_KEYS, label);
  return Object.freeze({ source_id: identifier(record.source_id, `${label}.source_id`), revision_id: identifier(record.revision_id, `${label}.revision_id`), source_sha256: digest(record.source_sha256, `${label}.source_sha256`) });
}
export function validateMeetingApprovalConsequenceV2(value: unknown, consequenceKind: string): MeetingApprovalConsequenceV2 {
  const record = exact(value, CONSEQUENCE_KEYS, "Private Slack block approval consequence v2");
  if (record.schema_version !== 2 || record.kind !== consequenceKind) fail("Private Slack block approval consequence v2 has an unsupported envelope");
  const policyId = policy(record.policy_id, "Private Slack block approval consequence v2 policy");
  const audience = ids(record.audience_project_ids, "Private Slack block approval consequence v2 audience projects", policyId === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
  const association = ids(record.association_project_ids, "Private Slack block approval consequence v2 association projects", policyId === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
  if (policyId === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID && (audience.length !== association.length || audience.some((id, index) => id !== association[index]))) fail("Private Slack block approval consequence v2 lean project audience and association must match");
  if (policyId !== PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID && (audience.length !== 0 || association.length !== 0)) fail("Private Slack block approval consequence v2 non-project policy must not carry projects");
  if (typeof record.share_transcript !== "boolean") fail("Private Slack block approval consequence v2 share_transcript must be boolean");
  return Object.freeze({ schema_version: 2, kind: consequenceKind, policy_id: policyId, audience_project_ids: audience, association_project_ids: association, share_transcript: record.share_transcript, transcript_source: source(record.transcript_source, "Private Slack block approval consequence v2 transcript source") });
}
export function meetingApprovalConsequenceV2Sha256(value: MeetingApprovalConsequenceV2, consequenceKind: string): Sha256Digest { return canonicalSha256(validateMeetingApprovalConsequenceV2(value, consequenceKind)); }
function policyContract(policyId: V2PolicyId): Sha256Digest {
  if (policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID) return restrictedReviewerPersonPolicyContractSha256();
  if (policyId === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID) return organizationMemberReadablePersonPolicyContractSha256();
  return projectMembersReadablePersonPolicyContractSha256();
}
export function validateMeetingApprovalEventV2(value: unknown, consequenceKind: string): MeetingApprovalEventV2 {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "rejected") { exact(value, REJECTED_EVENT_KEYS, "Private Slack block rejected event v2"); return Object.freeze({ kind: "rejected" }); }
  const event = exact(value, APPROVED_EVENT_KEYS, "Private Slack block approved event v2"); if (event.kind !== "approved") fail("Private Slack block approval event v2 is unsupported");
  const snapshot = validateApprovedDecisionSnapshotV2(event.approved_snapshot); assertDigest(event.approved_snapshot_sha256, "approved event v2 snapshot digest"); if (event.approved_snapshot_sha256 !== approvedDecisionSnapshotV2Sha256(snapshot)) fail("approved event v2 snapshot digest does not match");
  const policyId = policy(event.policy_id, "approved event v2 policy"); const selectedConsequence = validateMeetingApprovalConsequenceV2(event.policy_consequence, consequenceKind); const consequenceDigest = digest(event.policy_consequence_sha256, "approved event v2 consequence digest");
  if (event.policy_contract_sha256 !== policyContract(policyId) || selectedConsequence.policy_id !== policyId || consequenceDigest !== meetingApprovalConsequenceV2Sha256(selectedConsequence, consequenceKind)) fail("approved event v2 policy consequence is invalid");
  return Object.freeze({ kind: "approved", approved_snapshot: snapshot, approved_snapshot_sha256: event.approved_snapshot_sha256 as Sha256Digest, policy_id: policyId, policy_contract_sha256: event.policy_contract_sha256 as Sha256Digest, policy_consequence: selectedConsequence, policy_consequence_sha256: consequenceDigest });
}
