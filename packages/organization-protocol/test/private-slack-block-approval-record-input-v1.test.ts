import { describe, expect, it } from "vitest";
import {
  organizationMemberReadablePersonConsequenceSha256,
  organizationMemberReadablePersonPolicyContractSha256,
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  restrictedReviewerPersonConsequenceSha256,
  restrictedReviewerPersonPolicyContractSha256,
  SIGNED_SLACK_BLOCK_ACTION_V1_KIND,
  buildPrivateSlackBlockApprovalRecordInputV1,
  privateSlackBlockApprovalResolutionRefV1Sha256,
  validatePrivateSlackBlockApprovalRecordInputV1,
  validatePrivateSlackBlockApprovalResolutionRefV1,
} from "../src/index.js";
import {
  APPROVED_DECISION_SNAPSHOT_V2_KIND,
  approvedDecisionSnapshotV2Sha256,
} from "../src/human-act-record-input-v1.js";
import {
  decisionProcessorProvenanceV1Sha256,
  meetingSourceProvenanceV1Sha256,
  validateOrganizationRecordEnvelopeBodyV4,
} from "../src/record-envelope-v4.js";

const digest = (letter: string): `sha256:${string}` =>
  `sha256:${letter.repeat(64)}`;

function snapshot(): Record<string, unknown> {
  return {
    schema_version: 2,
    kind: APPROVED_DECISION_SNAPSHOT_V2_KIND,
    approval_id: "approval-1",
    staged_content_sha256: digest("a"),
    final_content_sha256: digest("b"),
    payload_contract_id: "organization-record-approval-payload-v1",
    approved_payload: {
      brief: {
        schema_version: 1, id: "brief-1", meeting: { id: "meeting-1", participants: [] },
        decisions: [{ id: "decision-1", kind: "decision", text: "Ship.", subject: null, confidence: null, evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }], status: "decided" }],
        actions: [], rationales: [],
        provenance: { meeting_revision: "revision-1", processor: { kind: "decision-processor", adapter_id: "structured-text", instance_id: "default", version: "1.0.0" }, generated_at: "2026-08-20T12:00:00.000Z" },
      },
      source: { adapter_id: "meeting-source", instance_id: "primary", external_id: "meeting-1" },
      alternatives: [], links: null, reviewed_at: "2026-08-20T12:01:00.000Z", surface: "person-approval",
    },
  };
}

function reference(action: "approve" | "reject" = "approve"): Record<string, unknown> {
  const selected = action === "approve";
  return {
    schema_version: 1,
    kind: PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND,
    authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1",
    command_id: "command-1", approval_id: "approval-1",
    candidate_sha256: digest("c"), frozen_card_sha256: digest("d"),
    approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(snapshot() as never),
    final_approver: { principal_id: "principal-1", membership_id: "membership-1" },
    current_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_link-1", external_identity_link_contract_sha256: digest("f"), provider_subject_id: "U123" },
    action,
    selected_policy_id: selected ? RESTRICTED_REVIEWER_PERSON_POLICY_ID : null,
    policy_contract_sha256: selected ? restrictedReviewerPersonPolicyContractSha256() : null,
    policy_consequence_sha256: selected ? restrictedReviewerPersonConsequenceSha256() : null,
    comment: "Ship after legal review.",
    audit_event_id: "audit-1", audit_sequence: 1, audit_entry_sha256: digest("0"),
    provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND,
    provider_action_schema_version: 1, provider_action_sha256: digest("1"), authorization_proof_sha256: digest("2"),
  };
}

function event(policy = RESTRICTED_REVIEWER_PERSON_POLICY_ID): Record<string, unknown> {
  const frozen = snapshot();
  return {
    kind: "approved", approved_snapshot: frozen,
    approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(frozen as never),
    policy_id: policy,
    policy_contract_sha256: policy === RESTRICTED_REVIEWER_PERSON_POLICY_ID ? restrictedReviewerPersonPolicyContractSha256() : organizationMemberReadablePersonPolicyContractSha256(),
    policy_consequence_text: policy === RESTRICTED_REVIEWER_PERSON_POLICY_ID ? RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT : ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
    policy_consequence_sha256: policy === RESTRICTED_REVIEWER_PERSON_POLICY_ID ? restrictedReviewerPersonConsequenceSha256() : organizationMemberReadablePersonConsequenceSha256(),
  };
}

describe("private Slack Block Kit approval D3 witness v1", () => {
  it("closes a signed block-action approval with the frozen owner and selected policy", () => {
    const built = buildPrivateSlackBlockApprovalRecordInputV1({
      private_slack_block_approval_resolution_ref: reference() as never,
      event: event() as never,
    });
    expect(built.private_slack_block_approval_resolution_ref.provider_action_kind).toBe(SIGNED_SLACK_BLOCK_ACTION_V1_KIND);
    expect(built.private_slack_block_approval_resolution_ref.final_approver).toEqual({ principal_id: "principal-1", membership_id: "membership-1" });
    expect(built.private_slack_block_approval_resolution_ref.comment).toBe("Ship after legal review.");
    expect(built.semantic_idempotency_key).toBe(
      privateSlackBlockApprovalResolutionRefV1Sha256(
        built.private_slack_block_approval_resolution_ref,
      ),
    );
    expect(validatePrivateSlackBlockApprovalRecordInputV1({
      private_slack_block_approval_resolution_ref: built.private_slack_block_approval_resolution_ref,
      event: built.event,
    }).semantic_idempotency_key).toBe(built.semantic_idempotency_key);
  });

  it("requires an explicit, exact policy only for approval and records no policy for reject", () => {
    expect(() => validatePrivateSlackBlockApprovalResolutionRefV1({ ...reference(), selected_policy_id: null })).toThrow();
    expect(() => validatePrivateSlackBlockApprovalResolutionRefV1({ ...reference(), policy_contract_sha256: digest("9") })).toThrow();
    const rejected = buildPrivateSlackBlockApprovalRecordInputV1({
      private_slack_block_approval_resolution_ref: { ...reference("reject"), comment: null } as never,
      event: { kind: "rejected" },
    });
    expect(rejected.event).toEqual({ kind: "rejected" });
  });

  it("rejects reactions, a changed actor, wrong snapshots, and mismatched action digests", () => {
    expect(() => validatePrivateSlackBlockApprovalResolutionRefV1({ ...reference(), provider_action_kind: "echo-provider-human-action-v2" })).toThrow();
    expect(() => validatePrivateSlackBlockApprovalResolutionRefV1({ ...reference(), final_approver: { principal_id: "other", membership_id: "membership-1" }, policy_consequence_sha256: digest("8") })).toThrow();
    expect(() => buildPrivateSlackBlockApprovalRecordInputV1({ private_slack_block_approval_resolution_ref: reference() as never, event: { ...event(), approved_snapshot_sha256: digest("7") } as never })).toThrow();
  });

  it("admits the new witness as a V4 envelope body without changing the legacy path", () => {
    const built = buildPrivateSlackBlockApprovalRecordInputV1({
      private_slack_block_approval_resolution_ref: reference() as never,
      event: event() as never,
    });
    const source = {
      schema_version: 1 as const, kind: "echo-meeting-source-provenance-v1" as const,
      authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1",
      source_adapter_kind: "meeting-source" as const, source_adapter_id: "meeting-source", source_adapter_instance_id: "primary", source_adapter_version: "1.0.0", external_id: "meeting-1", canonical_revision: "revision-1", normalizer_version: "1.0.0", source_revision: null,
    };
    const processor = {
      schema_version: 1 as const, kind: "echo-decision-processor-provenance-v1" as const,
      authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1",
      processor_adapter_kind: "decision-processor" as const, processor_adapter_id: "structured-text", processor_adapter_instance_id: "default", processor_adapter_version: "1.0.0", processor_contract_sha256: digest("9"),
    };
    expect(validateOrganizationRecordEnvelopeBodyV4({
      schema_version: 4, kind: "echo-organization-record-envelope-v4", envelope_id: "envelope-1",
      authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1",
      semantic_idempotency_key: built.semantic_idempotency_key, issued_at: "2026-08-20T12:03:00.000Z", predecessor_position: null, predecessor_record_sha256: null,
      human_act_resolution_ref: built.private_slack_block_approval_resolution_ref,
      source_provenance: source, source_provenance_sha256: meetingSourceProvenanceV1Sha256(source),
      processor_provenance: processor, processor_provenance_sha256: decisionProcessorProvenanceV1Sha256(processor), event: built.event,
    }).human_act_resolution_ref.kind).toBe(PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND);
  });
});
