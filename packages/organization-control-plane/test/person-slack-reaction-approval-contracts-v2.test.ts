import { describe, expect, it } from "vitest";
import {
  canonicalSha256,
  sha256Digest,
} from "../src/canonical/canonical-json.js";
import * as d2 from "../src/application/person-slack-reaction-approval-contracts-v2.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT as protocolMemberText,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT as protocolReviewerText,
  organizationMemberReadablePersonPolicyContract as protocolMemberPolicy,
  restrictedReviewerPersonPolicyContract as protocolReviewerPolicy,
} from "../../../packages/organization-protocol/src/person-content-policy-v2.js";

const AUTHORITY_ID = "oau_11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "org_22222222-2222-4222-8222-222222222222";
const LINEAGE_ID = "lin_33333333-3333-4333-8333-333333333333";
const CONNECTION_ID = "con_44444444-4444-4444-8444-444444444444";
const LINK_ID = "idm_55555555-5555-4555-8555-555555555555";
const PRINCIPAL_ID = "prn_66666666-6666-4666-8666-666666666666";
const MEMBERSHIP_ID = "mem_77777777-7777-4777-8777-777777777777";
const BINDING_ID = "bnd_88888888-8888-4888-8888-888888888888";
const CAPABILITY_ID = "cap_99999999-9999-4999-8999-999999999999";
const APPROVAL_ID = "apr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUDIT_EVENT_ID = "aud_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERIFIED_AT = "2026-08-20T12:00:00.000Z";
const OBSERVED_AT = "2026-08-20T12:01:00.000Z";
const EVALUATED_AT = "2026-08-20T12:01:01.000Z";
const OCCURRED_AT = "2026-08-20T12:01:02.000Z";

const coordinates = {
  authority_id: AUTHORITY_ID,
  organization_id: ORGANIZATION_ID,
  state_lineage_id: LINEAGE_ID,
} as const;

const providerTenant = {
  provider_issuer: "https://slack.com",
  provider_tenant_kind: "workspace",
  provider_tenant_id: "T12345678",
  provider_enterprise_id: "E12345678",
} as const;

const providerTool = { ...providerTenant, tool_kind: "slack" } as const;
const adapter = {
  approval_adapter_kind: "approval-surface",
  approval_adapter_id: "slack-reactions",
  approval_adapter_instance_id: "ada_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  approval_adapter_version: "2.0.0",
} as const;

function digest(label: string): d2.ApprovalContractSha256 {
  return canonicalSha256({ label });
}

function policyValues(policyId: d2.PersonApprovalPolicyId): {
  readonly contract: d2.ApprovalContractSha256;
  readonly consequence: d2.ApprovalContractSha256;
} {
  return policyId === d2.ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID
    ? {
        contract: d2.ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
        consequence: d2.ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
      }
    : {
        contract: d2.RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
        consequence: d2.RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
      };
}

interface Fixture {
  readonly set: d2.ProviderHumanActionContractSetV2;
  readonly bodies: readonly object[];
}

function fixture(
  action: d2.PersonApprovalAction = "approve",
  policyId: d2.PersonApprovalPolicyId = d2.RESTRICTED_REVIEWER_PERSON_POLICY_ID,
): Fixture {
  const policy = policyValues(policyId);
  const observedReaction = action === "approve" ? "white_check_mark" : "x";
  const connection = d2.buildOrganizationToolConnectionContractV2({
    ...coordinates,
    connection_id: CONNECTION_ID,
    ...providerTool,
    provider_app_id: "A12345678",
    provider_bot_id: "B12345678",
    provider_bot_user_id: "U87654321",
    required_provider_scopes: d2.SLACK_REACTION_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    public_connection_configuration_sha256: digest("public connection"),
  });
  const connectionContractSha256 = canonicalSha256(connection);
  const connectionState = d2.buildOrganizationToolConnectionStateV2({
    connection_id: CONNECTION_ID,
    connection_contract_sha256: connectionContractSha256,
    connection_status: "active",
    credential_reference_sha256: digest("credential reference"),
    observed_granted_scopes: d2.SLACK_REACTION_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    verification_event_id: "vev_connection",
    verification_evidence_sha256: digest("connection verification"),
    verification_revision: 1,
    verified_at: VERIFIED_AT,
  });
  const connectionStateSha256 = canonicalSha256(connectionState);
  const externalHumanLink = d2.buildExternalHumanIdentityLinkContractV2({
    ...coordinates,
    external_identity_link_id: LINK_ID,
    ...providerTenant,
    provider_subject_id: "U12345678",
    principal_id: PRINCIPAL_ID,
    membership_id: MEMBERSHIP_ID,
    membership_type: "employee",
    verification_event_id: "vev_human_link",
    verification_evidence_sha256: digest("human link verification"),
    verified_at: VERIFIED_AT,
  });
  const externalHumanLinkContractSha256 = canonicalSha256(externalHumanLink);
  const approvalBinding = d2.buildPersonSlackReactionApprovalBindingContractV2({
    ...coordinates,
    approval_binding_id: BINDING_ID,
    connection_id: CONNECTION_ID,
    connection_contract_sha256: connectionContractSha256,
    ...adapter,
    approval_channel_id: "C12345678",
    approve_reaction: "white_check_mark",
    reject_reaction: "x",
    supported_policy_actions: [
      {
        policy_id: d2.ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        policy_contract_sha256:
          d2.ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
        actions: ["approve", "reject"],
      },
      {
        policy_id: d2.RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        policy_contract_sha256:
          d2.RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
        actions: ["approve", "reject"],
      },
    ],
  });
  const approvalBindingContractSha256 = canonicalSha256(approvalBinding);
  const actionCapability = d2.buildPersonSlackReactionApprovalActionCapabilityV2({
    ...coordinates,
    action_capability_id: CAPABILITY_ID,
    approval_binding_id: BINDING_ID,
    approval_binding_contract_sha256: approvalBindingContractSha256,
    external_identity_link_id: LINK_ID,
    principal_id: PRINCIPAL_ID,
    membership_id: MEMBERSHIP_ID,
    membership_type: "employee",
    policy_id: policyId,
    policy_contract_sha256: policy.contract,
    action,
  });
  const actionCapabilityContractSha256 = canonicalSha256(actionCapability);
  const providerObservation = d2.buildSlackProviderObservationV2({
    ...coordinates,
    ...providerTool,
    connection_id: CONNECTION_ID,
    connection_contract_sha256: connectionContractSha256,
    connection_state_sha256: connectionStateSha256,
    ...adapter,
    provider_object_kind: "slack_message_reaction",
    approval_channel_id: "C12345678",
    provider_message_ts: "1755691200.000100",
    provider_actor_subject: "U12345678",
    observed_reaction: observedReaction,
    observed_action: action,
    provider_response_evidence_sha256: digest("provider response"),
    observed_at: OBSERVED_AT,
  });
  const providerObservationSha256 = canonicalSha256(providerObservation);
  const providerMessage = d2.buildSlackProviderApprovalMessageV2({
    ...coordinates,
    audit_event_id: AUDIT_EVENT_ID,
    ...providerTool,
    connection_id: CONNECTION_ID,
    connection_contract_sha256: connectionContractSha256,
    connection_state_sha256: connectionStateSha256,
    provider_app_id: "A12345678",
    provider_bot_id: "B12345678",
    provider_bot_user_id: "U87654321",
    approval_binding_id: BINDING_ID,
    approval_binding_contract_sha256: approvalBindingContractSha256,
    ...adapter,
    approval_channel_id: "C12345678",
    provider_message_ts: "1755691200.000100",
    provider_actor_subject: "U12345678",
    observed_reaction: observedReaction,
    approval_id: APPROVAL_ID,
    policy_id: policyId,
    policy_contract_sha256: policy.contract,
    frozen_card_sha256: digest("frozen card"),
    approved_snapshot_sha256: digest("approved snapshot"),
    policy_consequence_sha256: policy.consequence,
    approve_reaction: "white_check_mark",
    reject_reaction: "x",
    observed_at: OBSERVED_AT,
    provider_observation_sha256: providerObservationSha256,
  });
  const providerMessageSha256 = canonicalSha256(providerMessage);
  const providerAction = d2.buildSlackProviderHumanActionV2({
    ...coordinates,
    ...providerTool,
    connection_id: CONNECTION_ID,
    connection_contract_sha256: connectionContractSha256,
    connection_state_sha256: connectionStateSha256,
    approval_binding_id: BINDING_ID,
    approval_binding_contract_sha256: approvalBindingContractSha256,
    ...adapter,
    external_identity_link_id: LINK_ID,
    external_identity_link_contract_sha256: externalHumanLinkContractSha256,
    principal_id: PRINCIPAL_ID,
    membership_id: MEMBERSHIP_ID,
    membership_type: "employee",
    action_capability_id: CAPABILITY_ID,
    action_capability_contract_sha256: actionCapabilityContractSha256,
    provider_object_kind: "slack_message_reaction",
    approval_channel_id: "C12345678",
    provider_message_ts: "1755691200.000100",
    provider_actor_subject: "U12345678",
    action,
    approval_id: APPROVAL_ID,
    policy_id: policyId,
    policy_contract_sha256: policy.contract,
    policy_consequence_sha256: policy.consequence,
    frozen_card_sha256: providerMessage.frozen_card_sha256,
    approved_snapshot_sha256: providerMessage.approved_snapshot_sha256,
    provider_message_sha256: providerMessageSha256,
    provider_observation_sha256: providerObservationSha256,
    observed_at: OBSERVED_AT,
  });
  const providerActionSha256 = canonicalSha256(providerAction);
  const authorizationAllow = d2.buildProviderHumanAuthorizationAllowV2({
    ...coordinates,
    approval_id: APPROVAL_ID,
    action,
    policy_id: policyId,
    policy_contract_sha256: policy.contract,
    principal_id: PRINCIPAL_ID,
    membership_id: MEMBERSHIP_ID,
    membership_type: "employee",
    action_capability_id: CAPABILITY_ID,
    action_capability_contract_sha256: actionCapabilityContractSha256,
    provider_observation_sha256: providerObservationSha256,
    provider_message_sha256: providerMessageSha256,
    provider_action_sha256: providerActionSha256,
    frozen_card_sha256: providerMessage.frozen_card_sha256,
    decision: "allow",
    evaluated_at: EVALUATED_AT,
  });
  const authorizationProofSha256 = canonicalSha256(authorizationAllow);
  const auditEntry = d2.buildProviderHumanIntegrationAuditEntryV2({
    ...coordinates,
    audit_event_id: AUDIT_EVENT_ID,
    audit_sequence: 1,
    actor_class: "provider_human",
    external_identity_link_id: LINK_ID,
    connection_id: CONNECTION_ID,
    approval_binding_id: BINDING_ID,
    action_capability_id: CAPABILITY_ID,
    principal_id: PRINCIPAL_ID,
    membership_id: MEMBERSHIP_ID,
    action,
    subject_kind: "approval",
    subject_id: APPROVAL_ID,
    event_digest: providerObservationSha256,
    detail_digest: authorizationProofSha256,
    provider_message_sha256: providerMessageSha256,
    provider_action_sha256: providerActionSha256,
    correlation_id: "cor_human_action",
    occurred_at: OCCURRED_AT,
    predecessor_entry_sha256: null,
  });
  const set: d2.ProviderHumanActionContractSetV2 = {
    connection,
    connection_contract_sha256: connectionContractSha256,
    connection_state: connectionState,
    connection_state_sha256: connectionStateSha256,
    external_human_link: externalHumanLink,
    external_identity_link_contract_sha256: externalHumanLinkContractSha256,
    approval_binding: approvalBinding,
    approval_binding_contract_sha256: approvalBindingContractSha256,
    action_capability: actionCapability,
    action_capability_contract_sha256: actionCapabilityContractSha256,
    provider_observation: providerObservation,
    provider_observation_sha256: providerObservationSha256,
    provider_message: providerMessage,
    provider_message_sha256: providerMessageSha256,
    provider_action: providerAction,
    provider_action_sha256: providerActionSha256,
    authorization_allow: authorizationAllow,
    authorization_proof_sha256: authorizationProofSha256,
    audit_entry: auditEntry,
    audit_entry_sha256: canonicalSha256(auditEntry),
  };
  return {
    set,
    bodies: [
      connection,
      connectionState,
      externalHumanLink,
      approvalBinding,
      actionCapability,
      providerObservation,
      providerMessage,
      providerAction,
      authorizationAllow,
      auditEntry,
    ],
  };
}

function without(body: object, key: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([field]) => field !== key),
  );
}

function changed<T extends object>(
  body: T,
  change: Record<string, unknown>,
): T {
  return { ...body, ...change };
}

describe("Person Slack reaction approval D2 contracts", () => {
  it("keeps the local policy seed bytes identical to the accepted protocol candidate", () => {
    const localMember =
      d2.buildOrganizationMemberReadablePersonPolicyContractV2();
    const localReviewer = d2.buildRestrictedReviewerPersonPolicyContractV2();
    expect(localMember).toEqual(protocolMemberPolicy());
    expect(localReviewer).toEqual(protocolReviewerPolicy());
    expect(d2.ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT).toBe(
      protocolMemberText,
    );
    expect(d2.RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT).toBe(
      protocolReviewerText,
    );
    expect(
      sha256Digest(d2.ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT),
    ).toBe(d2.ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256);
    expect(sha256Digest(d2.RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT)).toBe(
      d2.RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
    );
    expect(canonicalSha256(localMember)).toBe(
      d2.ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
    );
    expect(canonicalSha256(localReviewer)).toBe(
      d2.RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
    );
  });

  it.each([
    ["approve", d2.RESTRICTED_REVIEWER_PERSON_POLICY_ID],
    ["reject", d2.RESTRICTED_REVIEWER_PERSON_POLICY_ID],
    ["approve", d2.ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID],
    ["reject", d2.ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID],
  ] as const)("builds one exact %s chain for %s", (action, policyId) => {
    const { set } = fixture(action, policyId);
    const semantic = d2.buildProviderHumanSemanticActionInputV1(set);
    const recovery = d2.buildProviderHumanActionRecoveryKey(set);
    const durable = d2.buildProviderHumanActionDurableResult(set);
    expect(semantic).toEqual({
      schema_version: 1,
      kind: d2.PROVIDER_HUMAN_SEMANTIC_ACTION_INPUT_KIND,
      ...coordinates,
      approval_id: APPROVAL_ID,
      action,
      provider_action_sha256: set.provider_action_sha256,
    });
    expect(recovery).toEqual({
      audit_event_id: AUDIT_EVENT_ID,
      audit_sequence: 1,
      audit_entry_sha256: set.audit_entry_sha256,
      provider_action_sha256: set.provider_action_sha256,
      authorization_proof_sha256: set.authorization_proof_sha256,
    });
    expect(durable).toEqual({
      approval_id: APPROVAL_ID,
      action,
      policy_id: policyId,
      policy_contract_sha256: policyValues(policyId).contract,
      authorization_proof_sha256: set.authorization_proof_sha256,
      locator: recovery,
    });
    expect(Object.isFrozen(semantic)).toBe(true);
    expect(Object.isFrozen(recovery)).toBe(true);
    expect(Object.isFrozen(durable)).toBe(true);
    expect(set.provider_message.audit_event_id).toBe(AUDIT_EVENT_ID);
  });

  it("rejects missing, extra, reordered, and unsupported body variants", () => {
    const { set } = fixture();
    expect(() =>
      d2.validateOrganizationToolConnectionContractV2({
        ...set.connection,
        required_provider_scopes:
          set.connection.required_provider_scopes.slice(1),
      }),
    ).toThrow(/exact Slack approval scope set/);
    expect(() =>
      d2.validateOrganizationToolConnectionStateV2({
        ...set.connection_state,
        verification_revision: 0,
      }),
    ).toThrow(/positive safe integer/);
    expect(() =>
      d2.validateExternalHumanIdentityLinkContractV2({
        ...set.external_human_link,
        connection_id: CONNECTION_ID,
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      d2.validateExternalHumanIdentityLinkContractV2(
        without(set.external_human_link, "verification_event_id"),
      ),
    ).toThrow(/unexpected shape/);
    expect(() =>
      d2.validatePersonSlackReactionApprovalBindingContractV2({
        ...set.approval_binding,
        supported_policy_actions: [
          set.approval_binding.supported_policy_actions[1],
          set.approval_binding.supported_policy_actions[0],
        ],
      }),
    ).toThrow(/policy_id/);
    expect(() =>
      d2.validatePersonSlackReactionApprovalActionCapabilityV2({
        ...set.action_capability,
        policy_contract_sha256: digest("wrong policy"),
      }),
    ).toThrow(/policy_contract_sha256/);
    expect(() =>
      d2.validateSlackProviderObservationV2({
        ...set.provider_observation,
        message_presentation_sha256: digest("unowned presentation"),
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      d2.validateSlackProviderApprovalMessageV2(
        without(set.provider_message, "audit_event_id"),
      ),
    ).toThrow(/unexpected shape/);
    expect(() =>
      d2.validateSlackProviderHumanActionV2(
        without(
          set.provider_action,
          "external_identity_link_contract_sha256",
        ),
      ),
    ).toThrow(/unexpected shape/);
    expect(() =>
      d2.validateProviderHumanAuthorizationAllowV2({
        ...set.authorization_allow,
        decision: "deny",
      }),
    ).toThrow(/must be allow/);
    expect(() =>
      d2.validateProviderHumanIntegrationAuditEntryV2({
        ...set.audit_entry,
        audit_sequence: 2,
      }),
    ).toThrow(/predecessor/);
    expect(() =>
      d2.validateProviderHumanIntegrationAuditEntryV2({
        ...set.audit_entry,
        predecessor_entry_sha256: digest("unexpected genesis predecessor"),
      }),
    ).toThrow(/genesis/);
    expect(() =>
      d2.validateProviderHumanActionRecoveryKey({
        ...d2.buildProviderHumanActionRecoveryKey(set),
        kind: "unaccepted-wrapper",
      }),
    ).toThrow(/unexpected shape/);
  });

  it("rejects valid individual bodies that do not form one identity chain", () => {
    const { set } = fixture();
    const attempts: readonly {
      readonly label: string;
      readonly set: d2.ProviderHumanActionContractSetV2;
    }[] = [
      {
        label: "revoked connection",
        set: {
          ...set,
          connection_state: changed(set.connection_state, {
            connection_status: "revoked",
          }),
        },
      },
      {
        label: "missing required provider scope",
        set: {
          ...set,
          connection_state: changed(set.connection_state, {
            observed_granted_scopes:
              set.connection_state.observed_granted_scopes.slice(1),
          }),
        },
      },
      {
        label: "cross-tenant link",
        set: {
          ...set,
          external_human_link: changed(set.external_human_link, {
            provider_tenant_id: "T_DIFFERENT",
          }),
        },
      },
      {
        label: "cross-enterprise link",
        set: {
          ...set,
          external_human_link: changed(set.external_human_link, {
            provider_enterprise_id: null,
          }),
        },
      },
      {
        label: "different linked provider subject",
        set: {
          ...set,
          external_human_link: changed(set.external_human_link, {
            provider_subject_id: "U_DIFFERENT",
          }),
        },
      },
      {
        label: "different external link digest",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            external_identity_link_contract_sha256: digest("different link"),
          }),
        },
      },
      {
        label: "different adapter instance",
        set: {
          ...set,
          provider_observation: changed(set.provider_observation, {
            approval_adapter_instance_id: "ada_different",
          }),
        },
      },
      {
        label: "different adapter version",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            approval_adapter_version: "2.0.1",
          }),
        },
      },
      {
        label: "different binding ID",
        set: {
          ...set,
          provider_message: changed(set.provider_message, {
            approval_binding_id: "bnd_different",
          }),
        },
      },
      {
        label: "different binding digest",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            approval_binding_contract_sha256: digest("different binding"),
          }),
        },
      },
      {
        label: "different capability ID",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            action_capability_id: "cap_different",
          }),
        },
      },
      {
        label: "different capability digest",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            action_capability_contract_sha256: digest("different capability"),
          }),
        },
      },
      {
        label: "different membership tenure",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            membership_id: "mem_different",
          }),
        },
      },
      {
        label: "different membership type",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            membership_type: "owner",
          }),
        },
      },
      {
        label: "different policy family",
        set: {
          ...set,
          action_capability: changed(set.action_capability, {
            policy_id: d2.ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
            policy_contract_sha256:
              d2.ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
          }),
        },
      },
      {
        label: "different policy consequence",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            policy_consequence_sha256:
              d2.ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
          }),
        },
      },
      {
        label: "different approval channel",
        set: {
          ...set,
          provider_observation: changed(set.provider_observation, {
            approval_channel_id: "C_DIFFERENT",
          }),
        },
      },
      {
        label: "different mapped reaction",
        set: {
          ...set,
          provider_observation: changed(set.provider_observation, {
            observed_reaction: "x",
          }),
        },
      },
      {
        label: "different frozen card",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            frozen_card_sha256: digest("different card"),
          }),
        },
      },
      {
        label: "different approved snapshot",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            approved_snapshot_sha256: digest("different snapshot"),
          }),
        },
      },
      {
        label: "different provider actor",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            provider_actor_subject: "U_DIFFERENT",
          }),
        },
      },
      {
        label: "different provider object",
        set: {
          ...set,
          provider_observation: changed(set.provider_observation, {
            provider_object_kind: "different_object",
          }),
        },
      },
      {
        label: "different provider message coordinate",
        set: {
          ...set,
          provider_message: changed(set.provider_message, {
            provider_message_ts: "1755691200.000200",
          }),
        },
      },
      {
        label: "different provider application",
        set: {
          ...set,
          provider_message: changed(set.provider_message, {
            provider_app_id: "A_DIFFERENT",
          }),
        },
      },
      {
        label: "different Person principal",
        set: {
          ...set,
          provider_action: changed(set.provider_action, {
            principal_id: "prn_different",
          }),
        },
      },
      {
        label: "different authorization action digest",
        set: {
          ...set,
          authorization_allow: changed(set.authorization_allow, {
            provider_action_sha256: digest("different action"),
          }),
        },
      },
      {
        label: "different audit event ID",
        set: {
          ...set,
          audit_entry: changed(set.audit_entry, {
            audit_event_id: "aud_different",
          }),
        },
      },
      {
        label: "different audit event digest",
        set: {
          ...set,
          audit_entry: changed(set.audit_entry, {
            event_digest: digest("different observation"),
          }),
        },
      },
      {
        label: "different audit detail digest",
        set: {
          ...set,
          audit_entry: changed(set.audit_entry, {
            detail_digest: digest("different authorization"),
          }),
        },
      },
      {
        label: "different current-state digest",
        set: {
          ...set,
          connection_state_sha256: digest("different state"),
        },
      },
    ];
    for (const attempt of attempts) {
      expect(
        () => d2.buildProviderHumanSemanticActionInputV1(attempt.set),
        attempt.label,
      ).toThrow();
    }
  });

  it("keeps forbidden identity domains and the deferred D3 kind out of every D2 result", () => {
    const { set, bodies } = fixture();
    const values: unknown[] = [
      ...bodies,
      d2.buildProviderHumanSemanticActionInputV1(set),
      d2.buildProviderHumanActionRecoveryKey(set),
      d2.buildProviderHumanActionDurableResult(set),
    ];
    const forbidden = new Set([
      "installation",
      "enrollment",
      "lease",
      "delivery",
      "destination",
      "source",
      "processor",
      "read",
      "model",
    ]);
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${path}/${index}`));
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
          for (const token of key.toLowerCase().split(/[_-]/u)) {
            expect(forbidden.has(token), `${path}/${key}`).toBe(false);
          }
          visit(entry, `${path}/${key}`);
        }
        return;
      }
      if (typeof value === "string") {
        // Slack's accepted provider scope set contains `channels:read` and
        // `users:read`; those provider permissions are not ECHO read identity.
        if (
          d2.SLACK_REACTION_APPROVAL_REQUIRED_PROVIDER_SCOPES.includes(
            value as (typeof d2.SLACK_REACTION_APPROVAL_REQUIRED_PROVIDER_SCOPES)[number],
          )
        ) {
          return;
        }
        for (const token of value.toLowerCase().split(/[^a-z0-9]+/u)) {
          expect(forbidden.has(token), path).toBe(false);
        }
      }
    };
    values.forEach((value, index) => visit(value, `$/${index}`));
    expect(JSON.stringify(values)).not.toContain(
      "echo-human-act-resolution-ref-v1",
    );
    expect(Object.keys(d2.buildProviderHumanActionRecoveryKey(set))).toEqual([
      "audit_event_id",
      "audit_sequence",
      "audit_entry_sha256",
      "provider_action_sha256",
      "authorization_proof_sha256",
    ]);
  });
});
