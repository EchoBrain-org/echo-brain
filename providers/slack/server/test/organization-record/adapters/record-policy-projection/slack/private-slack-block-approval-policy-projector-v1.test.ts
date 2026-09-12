import { describe, expect, it } from "vitest";
import type { JsonObject } from "@echo-brain/federation-protocol";
import { ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, RESTRICTED_REVIEWER_PERSON_POLICY_ID } from "../../../../../../../../packages/organization-record/src/organization-record-api-v1.js";
import { SIGNED_SLACK_BLOCK_ACTION_V1_KIND, projectPrivateSlackBlockApprovalPolicyFactsV1, projectPrivateSlackBlockApprovalApproverV1 } from "../../../../../src/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v1.js";
import type {
  PersonPolicyIdV2,
} from "../../../../../../../../packages/organization-record/src/application/person-policy-fact-contracts-v2.js";

const digest = (letter: string): `sha256:${string}` => `sha256:${letter.repeat(64)}`;

function input(
  policy: PersonPolicyIdV2 = RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  action: "approve" | "reject" = "approve",
) {
  const selected = action === "approve" ? policy : null;
  const contract = action === "approve" ? digest("a") : null;
  const event: JsonObject = action === "approve"
    ? { kind: "approved", approved_snapshot: { approved_payload: { brief: { decisions: [{ id: "decision-1", kind: "decision" }], actions: [{ id: "action-1", kind: "action" }], rationales: [{ id: "rationale-1", kind: "rationale" }] } } }, approved_snapshot_sha256: digest("d"), policy_id: selected, policy_contract_sha256: contract, policy_consequence_text: "opaque", policy_consequence_sha256: digest("0") }
    : { kind: "rejected" };
  const ref = {
    schema_version: 1, kind: "echo-private-slack-block-approval-resolution-ref-v1",
    authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1", command_id: "command-1", approval_id: "approval-1",
    candidate_sha256: digest("b"), frozen_card_sha256: digest("c"), approved_snapshot_sha256: digest("d"),
    final_approver: { principal_id: "principal-1", membership_id: "membership-1" },
    current_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_link-1", external_identity_link_contract_sha256: digest("f"), provider_subject_id: "U123" },
    action, selected_policy_id: selected, policy_contract_sha256: contract, policy_consequence_sha256: action === "approve" ? digest("0") : null, comment: "Looks good.",
    audit_event_id: "audit-1", audit_sequence: 1, audit_entry_sha256: digest("1"), provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND, provider_action_schema_version: 1, provider_action_sha256: digest("2"), authorization_proof_sha256: digest("3"),
  };
  return {
    envelope: {
      record_sha256: digest("4"),
      body: {
        authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1",
        human_act_resolution_ref: ref,
        event,
      },
    },
    record_position: 1,
    witness: {
      authorization_allow: { authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1", approval_id: "approval-1", action, final_approver: { principal_id: "principal-1", membership_id: "membership-1" }, selected_policy_id: selected, policy_contract_sha256: contract, provider_action_sha256: digest("2"), decision: "allow" },
      authorization_proof_sha256: digest("3"), provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND, provider_action_schema_version: 1,
      audit_entry: { authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1", audit_event_id: "audit-1", audit_sequence: 1, actor_class: "provider_human", principal_id: "principal-1", membership_id: "membership-1", action, subject_kind: "approval", subject_id: "approval-1", detail_digest: digest("3"), provider_action_sha256: digest("2") },
      audit_entry_sha256: digest("1"),
    },
  };
}

describe("private Slack Block Kit policy projector", () => {
  it("projects the existing restricted and organization-member facts only after the signed action joins to D2", () => {
    const restricted = projectPrivateSlackBlockApprovalPolicyFactsV1(input());
    expect(restricted.policy_fact_outcome).toEqual({ kind: "appended", policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID });
    expect(restricted.facts).toHaveLength(3);
    expect(restricted.facts[0]).toMatchObject({ reviewer_principal_id: "principal-1", reviewer_membership_id: "membership-1", policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID });
    const member = projectPrivateSlackBlockApprovalPolicyFactsV1(input(ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID));
    expect(member.facts[0]).toMatchObject({ policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID });
    expect(member.facts[0]).not.toHaveProperty("reviewer_principal_id");
  });

  it("projects no facts for a valid reject", () => {
    expect(projectPrivateSlackBlockApprovalPolicyFactsV1(input(RESTRICTED_REVIEWER_PERSON_POLICY_ID, "reject"))).toEqual({ facts: [], policy_fact_outcome: { kind: "none" } });
  });

  it("fails closed on reaction type confusion, wrong final actor, policy, authorization digest, or schema", () => {
    const cases = [
      (value: ReturnType<typeof input>) => { (value.envelope.body.human_act_resolution_ref as Record<string, unknown>).provider_action_kind = "echo-provider-human-action-v2"; },
      (value: ReturnType<typeof input>) => { (value.witness.authorization_allow.final_approver as Record<string, unknown>).principal_id = "other-principal"; },
      (value: ReturnType<typeof input>) => { value.witness.authorization_allow.selected_policy_id = ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID; },
      (value: ReturnType<typeof input>) => { value.witness.authorization_proof_sha256 = digest("9"); },
      (value: ReturnType<typeof input>) => { (value.envelope.body.human_act_resolution_ref as Record<string, unknown>).schema_version = 2; },
    ];
    for (const mutate of cases) {
      const candidate = structuredClone(input());
      mutate(candidate);
      expect(() => projectPrivateSlackBlockApprovalPolicyFactsV1(candidate)).toThrow();
    }
  });
});

describe("private Slack Block Kit record approver projection", () => {
  it("derives only the identity from a supported approval without changing the envelope", () => {
    const { envelope } = input();
    const original = structuredClone(envelope);
    const approver = projectPrivateSlackBlockApprovalApproverV1(envelope);
    expect(approver).toEqual({
      authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1",
      approval_id: "approval-1", principal_id: "principal-1", membership_id: "membership-1",
    });
    expect(Object.isFrozen(approver)).toBe(true);
    expect(envelope).toEqual(original);
    expect(projectPrivateSlackBlockApprovalApproverV1(input(RESTRICTED_REVIEWER_PERSON_POLICY_ID, "reject").envelope)).toBeUndefined();
  });

  it("omits unknown, malformed, or mismatched resolutions even when they carry familiar actor fields", () => {
    const cases: Array<(value: ReturnType<typeof input>) => void> = [
      (value) => { value.envelope.body.human_act_resolution_ref.kind = "unknown-resolution-v1"; },
      (value) => { value.envelope.body.human_act_resolution_ref.schema_version = 2; },
      (value) => { Object.assign(value.envelope.body.human_act_resolution_ref, { provider_action_kind: "echo-provider-human-action-v2" }); },
      (value) => { value.envelope.body.human_act_resolution_ref.provider_action_schema_version = 2; },
      (value) => { value.envelope.body.authority_id = "other-authority"; },
      (value) => { value.envelope.body.organization_id = "other-organization"; },
      (value) => { value.envelope.body.state_lineage_id = "other-lineage"; },
      (value) => { value.envelope.body.human_act_resolution_ref.final_approver.principal_id = ""; },
      (value) => { Object.assign(value.envelope.body.human_act_resolution_ref, { final_approver: null }); },
      (value) => { value.envelope.body.human_act_resolution_ref.action = "reject"; },
    ];
    for (const mutate of cases) {
      const candidate = input();
      mutate(candidate);
      expect(projectPrivateSlackBlockApprovalApproverV1(candidate.envelope)).toBeUndefined();
    }
    expect(projectPrivateSlackBlockApprovalApproverV1({})).toBeUndefined();
  });

  it("does not invent an actor for the generic HumanAct reference, which carries none", () => {
    const { envelope } = input();
    expect(projectPrivateSlackBlockApprovalApproverV1({
      ...envelope,
      body: {
        ...envelope.body,
        human_act_resolution_ref: {
          schema_version: 1, kind: "echo-human-act-resolution-ref-v1",
          authority_id: "authority-1", organization_id: "organization-1", state_lineage_id: "lineage-1",
          approval_id: "approval-1", action: "approve",
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID, policy_contract_sha256: digest("a"),
          audit_event_id: "audit-1", audit_sequence: 1, audit_entry_sha256: digest("1"),
          provider_action_kind: "echo-provider-human-action-v2", provider_action_schema_version: 2,
          provider_action_sha256: digest("2"), authorization_proof_sha256: digest("3"),
        },
      },
    })).toBeUndefined();
  });
});
