/**
 * V2 record codec for project-scoped private Slack approvals.
 *
 * It is intentionally a separate registry branch: V1 bytes retain their
 * historical decoder and do not gain project or transcript semantics.
 */
import type { RecordInputCodecV4 } from "@echo-brain/organization-protocol";
import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  organizationMemberReadablePersonPolicyContractSha256,
  projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from "@echo-brain/organization-protocol";
import {
  approvedDecisionSnapshotV2Sha256,
  assertDigest,
  assertPositiveSafeInteger,
  canonicalSnapshot,
  organizationProtocolValidationFailure,
  validateApprovedDecisionSnapshotV2,
  type ApprovedDecisionSnapshotV2,
} from "@echo-brain/organization-protocol/record-codec-support-v4";
import { MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES } from "@echo-brain/organization-protocol";
import type { PersonContentPolicyIdV2 } from "@echo-brain/organization-protocol";

export const PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND =
  "echo-private-slack-block-approval-resolution-ref-v2" as const;
export const PRIVATE_SLACK_BLOCK_APPROVAL_CONSEQUENCE_V2_KIND =
  "echo-private-slack-block-approval-consequence-v2" as const;
export const PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_V2_FIELD =
  "private_slack_block_approval_resolution_ref_v2" as const;
export const PRIVATE_SLACK_BLOCK_APPROVAL_PROJECT_SELECTION_MAX = 20;

type V2PolicyId = PersonContentPolicyIdV2 | typeof PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
type Action = "approve" | "reject";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROJECT_ID = /^prj_[0-9a-f-]{36}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REF_KEYS = [
  "schema_version", "kind", "authority_id", "organization_id", "state_lineage_id", "command_id", "approval_id",
  "candidate_sha256", "frozen_card_sha256", "approved_snapshot_sha256", "final_approver", "current_slack_identity_link",
  "action", "selected_policy_id", "policy_contract_sha256", "policy_consequence_sha256", "comment", "audit_event_id",
  "audit_sequence", "audit_entry_sha256", "provider_action_kind", "provider_action_schema_version", "provider_action_sha256",
  "authorization_proof_sha256", "audience_project_ids", "association_project_ids", "share_transcript", "transcript_source",
] as const;
const CONSEQUENCE_KEYS = ["schema_version", "kind", "policy_id", "audience_project_ids", "association_project_ids", "share_transcript", "transcript_source"] as const;
const SOURCE_KEYS = ["source_id", "revision_id", "source_sha256"] as const;
const ASSIGNEE_KEYS = ["principal_id", "membership_id"] as const;
const LINK_KEYS = ["provider", "external_identity_link_id", "external_identity_link_contract_sha256", "provider_subject_id"] as const;
const INPUT_KEYS = [PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_V2_FIELD, "event"] as const;
const APPROVED_EVENT_KEYS = ["kind", "approved_snapshot", "approved_snapshot_sha256", "policy_id", "policy_contract_sha256", "policy_consequence", "policy_consequence_sha256"] as const;
const REJECTED_EVENT_KEYS = ["kind"] as const;

export interface PrivateSlackBlockApprovalTranscriptSourceV2 {
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: Sha256Digest;
}
export interface PrivateSlackBlockApprovalConsequenceV2 {
  readonly schema_version: 2;
  readonly kind: typeof PRIVATE_SLACK_BLOCK_APPROVAL_CONSEQUENCE_V2_KIND;
  readonly policy_id: V2PolicyId;
  readonly audience_project_ids: readonly string[];
  readonly association_project_ids: readonly string[];
  readonly share_transcript: boolean;
  readonly transcript_source: PrivateSlackBlockApprovalTranscriptSourceV2;
}
export interface PrivateSlackBlockApprovalResolutionRefV2 {
  readonly schema_version: 2;
  readonly kind: typeof PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND;
  readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string;
  readonly command_id: string; readonly approval_id: string;
  readonly candidate_sha256: Sha256Digest; readonly frozen_card_sha256: Sha256Digest; readonly approved_snapshot_sha256: Sha256Digest;
  readonly final_approver: { readonly principal_id: string; readonly membership_id: string };
  readonly current_slack_identity_link: { readonly provider: "slack"; readonly external_identity_link_id: string; readonly external_identity_link_contract_sha256: Sha256Digest; readonly provider_subject_id: string };
  readonly action: Action; readonly selected_policy_id: V2PolicyId | null;
  readonly policy_contract_sha256: Sha256Digest | null; readonly policy_consequence_sha256: Sha256Digest | null;
  readonly comment: string | null; readonly audit_event_id: string; readonly audit_sequence: number; readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: "echo-signed-slack-block-action-v1"; readonly provider_action_schema_version: 1;
  readonly provider_action_sha256: Sha256Digest; readonly authorization_proof_sha256: Sha256Digest;
  readonly audience_project_ids: readonly string[]; readonly association_project_ids: readonly string[];
  readonly share_transcript: boolean; readonly transcript_source: PrivateSlackBlockApprovalTranscriptSourceV2;
}
export interface PrivateSlackBlockApprovedEventV2 {
  readonly kind: "approved"; readonly approved_snapshot: ApprovedDecisionSnapshotV2; readonly approved_snapshot_sha256: Sha256Digest;
  readonly policy_id: V2PolicyId; readonly policy_contract_sha256: Sha256Digest;
  readonly policy_consequence: PrivateSlackBlockApprovalConsequenceV2; readonly policy_consequence_sha256: Sha256Digest;
}
export type PrivateSlackBlockApprovalEventV2 = PrivateSlackBlockApprovedEventV2 | { readonly kind: "rejected" };
export interface PrivateSlackBlockApprovalRecordInputV2 { readonly private_slack_block_approval_resolution_ref_v2: PrivateSlackBlockApprovalResolutionRefV2; readonly event: PrivateSlackBlockApprovalEventV2; }
export interface ValidatedPrivateSlackBlockApprovalRecordInputV2 extends PrivateSlackBlockApprovalRecordInputV2 { readonly semantic_idempotency_key: Sha256Digest; }

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
  if (!Array.isArray(value) || value.length > PRIVATE_SLACK_BLOCK_APPROVAL_PROJECT_SELECTION_MAX || (required && value.length === 0)) fail(`${label} has an invalid project count`);
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
function source(value: unknown, label: string): PrivateSlackBlockApprovalTranscriptSourceV2 {
  const record = exact(value, SOURCE_KEYS, label);
  return Object.freeze({ source_id: identifier(record.source_id, `${label}.source_id`), revision_id: identifier(record.revision_id, `${label}.revision_id`), source_sha256: digest(record.source_sha256, `${label}.source_sha256`) });
}
function consequence(value: unknown): PrivateSlackBlockApprovalConsequenceV2 {
  const record = exact(value, CONSEQUENCE_KEYS, "Private Slack block approval consequence v2");
  if (record.schema_version !== 2 || record.kind !== PRIVATE_SLACK_BLOCK_APPROVAL_CONSEQUENCE_V2_KIND) fail("Private Slack block approval consequence v2 has an unsupported envelope");
  const policyId = policy(record.policy_id, "Private Slack block approval consequence v2 policy");
  const audience = ids(record.audience_project_ids, "Private Slack block approval consequence v2 audience projects", policyId === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
  const association = ids(record.association_project_ids, "Private Slack block approval consequence v2 association projects", policyId === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
  if (policyId === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID && (audience.length !== association.length || audience.some((id, index) => id !== association[index]))) fail("Private Slack block approval consequence v2 lean project audience and association must match");
  if (policyId !== PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID && (audience.length !== 0 || association.length !== 0)) fail("Private Slack block approval consequence v2 non-project policy must not carry projects");
  if (typeof record.share_transcript !== "boolean") fail("Private Slack block approval consequence v2 share_transcript must be boolean");
  return Object.freeze({ schema_version: 2, kind: PRIVATE_SLACK_BLOCK_APPROVAL_CONSEQUENCE_V2_KIND, policy_id: policyId, audience_project_ids: audience, association_project_ids: association, share_transcript: record.share_transcript, transcript_source: source(record.transcript_source, "Private Slack block approval consequence v2 transcript source") });
}
export function privateSlackBlockApprovalConsequenceV2Sha256(value: PrivateSlackBlockApprovalConsequenceV2): Sha256Digest { return canonicalSha256(consequence(value)); }
function policyContract(policyId: V2PolicyId): Sha256Digest {
  if (policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID) return restrictedReviewerPersonPolicyContractSha256();
  if (policyId === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID) return organizationMemberReadablePersonPolicyContractSha256();
  return projectMembersReadablePersonPolicyContractSha256();
}
export function validatePrivateSlackBlockApprovalResolutionRefV2(value: unknown): PrivateSlackBlockApprovalResolutionRefV2 {
  const ref = exact(value, REF_KEYS, "Private Slack block approval resolution ref v2");
  if (ref.schema_version !== 2 || ref.kind !== PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND || ref.provider_action_kind !== "echo-signed-slack-block-action-v1" || ref.provider_action_schema_version !== 1) fail("Private Slack block approval resolution ref v2 has an unsupported envelope");
  for (const key of ["authority_id", "organization_id", "state_lineage_id", "command_id", "approval_id", "audit_event_id"] as const) identifier(ref[key], `resolution v2 ${key}`);
  for (const key of ["candidate_sha256", "frozen_card_sha256", "approved_snapshot_sha256", "audit_entry_sha256", "provider_action_sha256", "authorization_proof_sha256"] as const) digest(ref[key], `resolution v2 ${key}`);
  assertPositiveSafeInteger(ref.audit_sequence, "resolution v2 audit_sequence");
  const approver = exact(ref.final_approver, ASSIGNEE_KEYS, "resolution v2 final approver"); identifier(approver.principal_id, "resolution v2 final approver principal"); identifier(approver.membership_id, "resolution v2 final approver membership");
  const link = exact(ref.current_slack_identity_link, LINK_KEYS, "resolution v2 Slack identity link");
  if (link.provider !== "slack") fail("resolution v2 Slack identity link provider is unsupported"); for (const key of ["external_identity_link_id", "provider_subject_id"] as const) identifier(link[key], `resolution v2 identity ${key}`); digest(link.external_identity_link_contract_sha256, "resolution v2 identity digest");
  if (ref.action !== "approve" && ref.action !== "reject") fail("resolution v2 action is unsupported");
  const selected = ref.selected_policy_id === null ? null : policy(ref.selected_policy_id, "resolution v2 selected policy");
  const audience = ids(ref.audience_project_ids, "resolution v2 audience projects", selected === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
  const association = ids(ref.association_project_ids, "resolution v2 association projects", selected === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
  if (selected === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID && (audience.length !== association.length || audience.some((id, index) => id !== association[index]))) fail("resolution v2 project audience and association must match");
  if (selected !== PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID && (audience.length !== 0 || association.length !== 0)) fail("resolution v2 non-project policy must not carry projects");
  if (typeof ref.share_transcript !== "boolean") fail("resolution v2 share_transcript must be boolean");
  if (ref.action === "approve") { if (selected === null || ref.policy_contract_sha256 !== policyContract(selected)) fail("resolution v2 approved policy is invalid"); digest(ref.policy_consequence_sha256, "resolution v2 consequence digest"); }
  else if (selected !== null || ref.policy_contract_sha256 !== null || ref.policy_consequence_sha256 !== null || audience.length !== 0 || association.length !== 0 || ref.share_transcript !== false) fail("resolution v2 rejection carries approval choices");
  if (ref.comment !== null && (typeof ref.comment !== "string" || ref.comment.trim() !== ref.comment || ref.comment.trim().length === 0 || ref.comment.length > 1000)) fail("resolution v2 comment is invalid");
  return Object.freeze({ schema_version: 2, kind: PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND, authority_id: ref.authority_id as string, organization_id: ref.organization_id as string, state_lineage_id: ref.state_lineage_id as string, command_id: ref.command_id as string, approval_id: ref.approval_id as string, candidate_sha256: ref.candidate_sha256 as Sha256Digest, frozen_card_sha256: ref.frozen_card_sha256 as Sha256Digest, approved_snapshot_sha256: ref.approved_snapshot_sha256 as Sha256Digest, final_approver: Object.freeze({ principal_id: approver.principal_id as string, membership_id: approver.membership_id as string }), current_slack_identity_link: Object.freeze({ provider: "slack", external_identity_link_id: link.external_identity_link_id as string, external_identity_link_contract_sha256: link.external_identity_link_contract_sha256 as Sha256Digest, provider_subject_id: link.provider_subject_id as string }), action: ref.action, selected_policy_id: selected, policy_contract_sha256: ref.policy_contract_sha256 as Sha256Digest | null, policy_consequence_sha256: ref.policy_consequence_sha256 as Sha256Digest | null, comment: ref.comment as string | null, audit_event_id: ref.audit_event_id as string, audit_sequence: ref.audit_sequence as number, audit_entry_sha256: ref.audit_entry_sha256 as Sha256Digest, provider_action_kind: "echo-signed-slack-block-action-v1", provider_action_schema_version: 1, provider_action_sha256: ref.provider_action_sha256 as Sha256Digest, authorization_proof_sha256: ref.authorization_proof_sha256 as Sha256Digest, audience_project_ids: audience, association_project_ids: association, share_transcript: ref.share_transcript, transcript_source: source(ref.transcript_source, "resolution v2 transcript source") });
}
export function privateSlackBlockApprovalResolutionRefV2Sha256(value: PrivateSlackBlockApprovalResolutionRefV2): Sha256Digest { return canonicalSha256(validatePrivateSlackBlockApprovalResolutionRefV2(value)); }
export function validatePrivateSlackBlockApprovalEventV2(value: unknown): PrivateSlackBlockApprovalEventV2 {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "rejected") { exact(value, REJECTED_EVENT_KEYS, "Private Slack block rejected event v2"); return Object.freeze({ kind: "rejected" }); }
  const event = exact(value, APPROVED_EVENT_KEYS, "Private Slack block approved event v2"); if (event.kind !== "approved") fail("Private Slack block approval event v2 is unsupported");
  const snapshot = validateApprovedDecisionSnapshotV2(event.approved_snapshot); assertDigest(event.approved_snapshot_sha256, "approved event v2 snapshot digest"); if (event.approved_snapshot_sha256 !== approvedDecisionSnapshotV2Sha256(snapshot)) fail("approved event v2 snapshot digest does not match");
  const policyId = policy(event.policy_id, "approved event v2 policy"); const selectedConsequence = consequence(event.policy_consequence); const consequenceDigest = digest(event.policy_consequence_sha256, "approved event v2 consequence digest");
  if (event.policy_contract_sha256 !== policyContract(policyId) || selectedConsequence.policy_id !== policyId || consequenceDigest !== privateSlackBlockApprovalConsequenceV2Sha256(selectedConsequence)) fail("approved event v2 policy consequence is invalid");
  return Object.freeze({ kind: "approved", approved_snapshot: snapshot, approved_snapshot_sha256: event.approved_snapshot_sha256 as Sha256Digest, policy_id: policyId, policy_contract_sha256: event.policy_contract_sha256 as Sha256Digest, policy_consequence: selectedConsequence, policy_consequence_sha256: consequenceDigest });
}
export function validatePrivateSlackBlockApprovalRecordInputV2(value: unknown): ValidatedPrivateSlackBlockApprovalRecordInputV2 {
  const input = exact(value, INPUT_KEYS, "Private Slack block approval record input v2"); const ref = validatePrivateSlackBlockApprovalResolutionRefV2(input[PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_V2_FIELD]); const event = validatePrivateSlackBlockApprovalEventV2(input.event);
  if (event.kind === "approved") { const c = event.policy_consequence; if (ref.action !== "approve" || ref.selected_policy_id !== event.policy_id || ref.policy_contract_sha256 !== event.policy_contract_sha256 || ref.policy_consequence_sha256 !== event.policy_consequence_sha256 || ref.approved_snapshot_sha256 !== event.approved_snapshot_sha256 || ref.approval_id !== event.approved_snapshot.approval_id || ref.share_transcript !== c.share_transcript || ref.transcript_source.source_id !== c.transcript_source.source_id || ref.transcript_source.revision_id !== c.transcript_source.revision_id || ref.transcript_source.source_sha256 !== c.transcript_source.source_sha256 || ref.audience_project_ids.length !== c.audience_project_ids.length || ref.audience_project_ids.some((id, index) => id !== c.audience_project_ids[index]) || ref.association_project_ids.length !== c.association_project_ids.length || ref.association_project_ids.some((id, index) => id !== c.association_project_ids[index])) fail("Private Slack block approved event v2 does not match resolution"); }
  else if (ref.action !== "reject") fail("Private Slack block rejected event v2 does not match resolution");
  return Object.freeze({ private_slack_block_approval_resolution_ref_v2: ref, event, semantic_idempotency_key: privateSlackBlockApprovalResolutionRefV2Sha256(ref) });
}
export function buildPrivateSlackBlockApprovalRecordInputV2(value: PrivateSlackBlockApprovalRecordInputV2): ValidatedPrivateSlackBlockApprovalRecordInputV2 { return validatePrivateSlackBlockApprovalRecordInputV2(value); }
export const PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2: RecordInputCodecV4 = Object.freeze({ input_reference_field: PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_V2_FIELD, reference_kind: PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND, reference_schema_version: 2, validateInput(value: unknown) { const input = validatePrivateSlackBlockApprovalRecordInputV2(value); return { human_act_resolution_ref: input.private_slack_block_approval_resolution_ref_v2, event: input.event, semantic_idempotency_key: input.semantic_idempotency_key }; }, fromReference(reference: unknown, event: unknown) { const input = validatePrivateSlackBlockApprovalRecordInputV2({ private_slack_block_approval_resolution_ref_v2: reference, event }); return { human_act_resolution_ref: input.private_slack_block_approval_resolution_ref_v2, event: input.event, semantic_idempotency_key: input.semantic_idempotency_key }; } });
