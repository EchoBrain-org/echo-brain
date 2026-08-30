import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type DurablePrivateApprovalTerminalV1,
} from "@echo-brain/organization-control-plane/slack-approval-integration-v1";
import {
  PrivateSlackBlockV4RecordWriterV1,
  type FrozenPrivateSlackApprovalCandidateV1,
} from "../../../../../src/processing/adapters/approval-resolution/slack/private-slack-block-v4-record-writer-v1.js";

const digest = (text: string): Sha256Digest => canonicalSha256({ text });
const coordinates = {
  authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1",
} as const;

function candidate(): FrozenPrivateSlackApprovalCandidateV1 {
  const approved_snapshot = {
    schema_version: 2 as const, kind: "echo-approved-decision-snapshot-v2" as const,
    approval_id: "approval-1", staged_content_sha256: digest("staged"), final_content_sha256: digest("final"),
    payload_contract_id: "organization-record-approval-payload-v1" as const,
    approved_payload: {
      brief: {
        schema_version: 1, id: "brief-1", meeting: { id: "meeting-1", participants: [] },
        decisions: [{ id: "decision-1", kind: "decision" as const, text: "Ship.", subject: null, confidence: null, evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }], status: "decided" as const }],
        actions: [], rationales: [],
        provenance: { meeting_revision: "revision-1", processor: { kind: "decision-processor" as const, adapter_id: "processor", instance_id: "primary", version: "1.0.0" }, generated_at: "2026-08-20T12:00:00.000Z" },
      },
      source: { adapter_id: "source", instance_id: "primary", external_id: "meeting-1" }, alternatives: [], links: null, reviewed_at: "2026-08-20T12:01:00.000Z", surface: "person-approval",
    },
  };
  return {
    ...coordinates, approval_id: "approval-1", candidate_sha256: digest("candidate"), frozen_card_sha256: digest("card"), approved_snapshot,
    approved_snapshot_sha256: canonicalSha256(approved_snapshot),
    source_provenance: { schema_version: 1, kind: "echo-meeting-source-provenance-v1", ...coordinates, source_adapter_kind: "meeting-source", source_adapter_id: "source", source_adapter_instance_id: "primary", source_adapter_version: "1.0.0", external_id: "meeting-1", canonical_revision: "revision-1", normalizer_version: "1.0.0", source_revision: null },
    processor_provenance: { schema_version: 1, kind: "echo-decision-processor-provenance-v1", ...coordinates, processor_adapter_kind: "decision-processor", processor_adapter_id: "processor", processor_adapter_instance_id: "primary", processor_adapter_version: "1.0.0", processor_contract_sha256: digest("processor") },
  };
}

function terminal(input: FrozenPrivateSlackApprovalCandidateV1, outcome: "approved" | "rejected" = "approved"): DurablePrivateApprovalTerminalV1 {
  const approved = outcome === "approved";
  const policy = RESTRICTED_REVIEWER_PERSON_POLICY_ID;
  const policyContract = RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256;
  const policyConsequence = RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256;
  const approver = { principal_id: "principal-1", membership_id: "membership-1" };
  const link = { provider: "slack" as const, external_identity_link_id: "clm_link-1", external_identity_link_contract_sha256: digest("link"), provider_subject_id: "U123" };
  const proof = digest("proof");
  return {
    outcome,
    signed_action_receipt_sha256: digest("signed-block-action"),
    resolution: {
      schema_version: 1, kind: "echo-private-approval-resolution-v1", command_id: "command-1", approval_id: input.approval_id, organization_id: input.organization_id,
      candidate_sha256: input.candidate_sha256, frozen_card_sha256: input.frozen_card_sha256, approved_snapshot_sha256: input.approved_snapshot_sha256,
      final_approver: approver, current_slack_identity_link: link, authorization_proof_sha256: proof,
      action: approved ? "approve" : "reject", comment: approved ? "looks good" : null,
      canonical_record_policy: approved ? { policy_id: policy, policy_contract_sha256: policyContract, policy_consequence_sha256: policyConsequence, restricted_reader: approver } : null,
    },
    audit: { schema_version: 1, kind: "echo-private-approval-terminal-audit-v1", audit_event_id: "audit-1", audit_sequence: 1, approval_id: input.approval_id, resolution_sha256: digest("resolution"), outcome, predecessor_entry_sha256: null, occurred_at: "2026-08-20T12:02:00.000Z" },
  } as DurablePrivateApprovalTerminalV1;
}

function writer(calls: unknown[]) {
  return new PrivateSlackBlockV4RecordWriterV1({
    append: { append: async (value: unknown) => { calls.push(value); return { outcome: calls.length === 1 ? "appended" : "duplicate", position: 1, envelope_id: "envelope-1", envelope_sha256: digest("envelope"), record_sha256: digest("record"), receipt: {} }; } } as never,
    signer: {} as never, pinned_authority: {} as never, state_lineage_id: coordinates.state_lineage_id,
    now: () => "2026-08-20T12:03:00.000Z", next_envelope_id: () => "envelope-1",
  });
}

describe("private Slack Block Kit V4 record writer", () => {
  it("builds an approved signed-action append and preserves its retry key", async () => {
    const calls: unknown[] = []; const frozen = candidate(); const value = terminal(frozen);
    const recordWriter = writer(calls);
    await recordWriter.appendApproved(value, frozen);
    await recordWriter.appendApproved(value, frozen);
    expect(calls).toHaveLength(2);
    const first = calls[0] as { readonly action: string; readonly authorization_witness: { readonly authorization_allow: { readonly provider_action_sha256: string } }; readonly semantic_idempotency_key: string };
    const second = calls[1] as typeof first;
    expect(first.action).toBe("approve");
    expect(first.authorization_witness.authorization_allow.provider_action_sha256).toBe(value.signed_action_receipt_sha256);
    expect(second.semantic_idempotency_key).toBe(first.semantic_idempotency_key);
  });

  it("refuses reject and frozen candidate drift before append", async () => {
    const calls: unknown[] = []; const frozen = candidate(); const recordWriter = writer(calls);
    await expect(recordWriter.appendApproved(terminal(frozen, "rejected"), frozen)).rejects.toThrow("rejection");
    await expect(recordWriter.appendApproved(terminal(frozen), { ...frozen, frozen_card_sha256: digest("other-card") })).rejects.toThrow("frozen Authority candidate");
    expect(calls).toEqual([]);
  });

  it("supports the organization-member policy commitment", async () => {
    const calls: unknown[] = []; const frozen = candidate(); const value = terminal(frozen);
    const changed = structuredClone(value) as DurablePrivateApprovalTerminalV1;
    const resolution = changed.resolution as typeof changed.resolution & { canonical_record_policy: NonNullable<typeof changed.resolution.canonical_record_policy> };
    resolution.canonical_record_policy = { policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, policy_contract_sha256: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256, policy_consequence_sha256: ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256, restricted_reader: null };
    await writer(calls).appendApproved(changed, frozen);
    expect(calls).toHaveLength(1);
  });
});
