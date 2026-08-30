import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  SLACK_REACTION_APPROVAL_REQUIRED_PROVIDER_SCOPES,
  buildExternalHumanIdentityLinkContractV2,
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
  buildPersonSlackReactionApprovalActionCapabilityV2,
  buildPersonSlackReactionApprovalBindingContractV2,
  type ApprovalContractSha256,
  type PersonApprovalAction,
} from "../src/application/person-slack-reaction-approval-contracts-v2.js";
import {
  finalizePersonSlackReactionApprovalV2,
  type PersonSlackReactionApprovalProviderExpectationV2,
  type PersonSlackReactionApprovalProviderResultV2,
} from "../src/application/person-slack-reaction-approval-finalization-v2.js";
import { SlackReactionApprovalObserverV1 } from "../src/adapters/slack/slack-reaction-approval-observer-v1.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../src/canonical/canonical-json.js";
import { applyOrganizationControlBaselineV1 } from "../src/persistence/baseline.js";
import { SqlitePersonSlackReactionApprovalFinalizationCoordinatorV2 } from "../src/persistence/sqlite-person-slack-reaction-approval-finalization-v2.js";
import {
  PersonSlackReactionApprovalPendingConflictError,
  stagePersonSlackReactionApprovalPendingV1,
  type StagePersonSlackReactionApprovalPendingCommandV1,
} from "../src/persistence/sqlite-person-slack-reaction-approval-pending-v1.js";

const COORDINATES = {
  authority_id: "oau_founder",
  organization_id: "org_founder",
  state_lineage_id: "lin_founder",
} as const;
const NOW = "2026-08-22T12:00:00.000Z";
const OBSERVED = "2026-08-22T12:01:00.000Z";
const COMMITTED = "2026-08-22T12:02:00.000Z";
const databases: Database.Database[] = [];

function digest(label: string): ApprovalContractSha256 {
  return canonicalSha256({ label });
}

function setup(action: PersonApprovalAction) {
  const database = new Database(":memory:");
  databases.push(database);
  applyOrganizationControlBaselineV1(database);
  const connection = buildOrganizationToolConnectionContractV2({
    ...COORDINATES,
    connection_id: "con_founder",
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: "T_FOUND",
    provider_enterprise_id: null,
    tool_kind: "slack",
    provider_app_id: "A_FOUND",
    provider_bot_id: "B_FOUND",
    provider_bot_user_id: "U_BOT",
    required_provider_scopes: SLACK_REACTION_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    public_connection_configuration_sha256: digest("configuration"),
  });
  const connectionSha = canonicalSha256(connection);
  const state = buildOrganizationToolConnectionStateV2({
    connection_id: connection.connection_id,
    connection_contract_sha256: connectionSha,
    connection_status: "active",
    credential_reference_sha256: digest("credential"),
    observed_granted_scopes: SLACK_REACTION_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    verification_event_id: "verify_founder",
    verification_evidence_sha256: digest("verification"),
    verification_revision: 1,
    verified_at: NOW,
  });
  const stateSha = canonicalSha256(state);
  database
    .prepare(
      `INSERT INTO organization_tool_connection_contracts
       (connection_id, contract_json, contract_sha256, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(
      connection.connection_id,
      canonicalJson(connection),
      connectionSha,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO organization_tool_connection_current_state
       (connection_id, connection_contract_sha256, state_json, state_sha256, current_status, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      connection.connection_id,
      connectionSha,
      canonicalJson(state),
      stateSha,
      NOW,
    );

  const link = buildExternalHumanIdentityLinkContractV2({
    ...COORDINATES,
    external_identity_link_id: "clm_founder",
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: "T_FOUND",
    provider_enterprise_id: null,
    provider_subject_id: "UFOUNDER",
    principal_id: "prn_founder",
    membership_id: "mem_founder",
    membership_type: "owner",
    verification_event_id: "verify_link",
    verification_evidence_sha256: digest("link"),
    verified_at: NOW,
  });
  const linkSha = canonicalSha256(link);
  database
    .prepare(
      `INSERT INTO organization_external_human_link_contracts
       (external_identity_link_id, contract_sha256, contract_json, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(link.external_identity_link_id, linkSha, canonicalJson(link), NOW);
  database
    .prepare(
      `INSERT INTO organization_external_human_link_current
       (external_identity_link_id, contract_sha256, provider_issuer, provider_tenant_kind,
        provider_tenant_id, provider_enterprise_id, provider_subject_id, principal_id,
        membership_id, current_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      link.external_identity_link_id,
      linkSha,
      link.provider_issuer,
      link.provider_tenant_kind,
      link.provider_tenant_id,
      link.provider_enterprise_id,
      link.provider_subject_id,
      link.principal_id,
      link.membership_id,
      NOW,
    );

  const binding = buildPersonSlackReactionApprovalBindingContractV2({
    ...COORDINATES,
    approval_binding_id: "bnd_founder",
    connection_id: connection.connection_id,
    connection_contract_sha256: connectionSha,
    approval_adapter_kind: "approval-surface",
    approval_adapter_id: "slack-reactions",
    approval_adapter_instance_id: "founder-approval",
    approval_adapter_version: "1.0.0",
    approval_channel_id: "C_FOUND",
    approve_reaction: "white_check_mark",
    reject_reaction: "x",
    supported_policy_actions: [
      {
        policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        policy_contract_sha256:
          ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
        actions: ["approve", "reject"],
      },
      {
        policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        policy_contract_sha256:
          RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
        actions: ["approve", "reject"],
      },
    ],
  });
  const bindingSha = canonicalSha256(binding);
  database
    .prepare(
      `INSERT INTO organization_approval_binding_contracts
       (approval_binding_id, contract_json, contract_sha256, connection_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      binding.approval_binding_id,
      canonicalJson(binding),
      bindingSha,
      connection.connection_id,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO organization_approval_binding_current
       (approval_binding_id, contract_sha256, current_status, updated_at)
       VALUES (?, ?, 'active', ?)`,
    )
    .run(binding.approval_binding_id, bindingSha, NOW);
  for (const candidateAction of ["approve", "reject"] as const) {
    const capability = buildPersonSlackReactionApprovalActionCapabilityV2({
      ...COORDINATES,
      action_capability_id: `cap_founder_${candidateAction}`,
      approval_binding_id: binding.approval_binding_id,
      approval_binding_contract_sha256: bindingSha,
      external_identity_link_id: link.external_identity_link_id,
      principal_id: link.principal_id,
      membership_id: link.membership_id,
      membership_type: "owner",
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      policy_contract_sha256:
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
      action: candidateAction,
    });
    const capabilitySha = canonicalSha256(capability);
    database
      .prepare(
        `INSERT INTO organization_approval_action_capability_contracts
         (action_capability_id, contract_json, contract_sha256, approval_binding_id,
          external_identity_link_id, policy_id, action, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        capability.action_capability_id,
        canonicalJson(capability),
        capabilitySha,
        binding.approval_binding_id,
        link.external_identity_link_id,
        capability.policy_id,
        candidateAction,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO organization_approval_action_capability_current
         (action_capability_id, contract_sha256, current_status, updated_at)
         VALUES (?, ?, 'active', ?)`,
      )
      .run(capability.action_capability_id, capabilitySha, NOW);
  }

  const command: StagePersonSlackReactionApprovalPendingCommandV1 = {
    command_id: "pas_founder",
    approval: {
      ...COORDINATES,
      approval_id: "apr_founder",
      status: "pending",
      connection_id: connection.connection_id,
      connection_contract_sha256: connectionSha,
      approval_binding_id: binding.approval_binding_id,
      approval_binding_contract_sha256: bindingSha,
      approval_channel_id: binding.approval_channel_id,
      provider_message_ts: "1724112000.000100",
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      policy_contract_sha256:
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
      policy_consequence_sha256:
        ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
      frozen_card_sha256: digest("frozen-card"),
      approved_snapshot_sha256: digest("snapshot"),
    },
  };
  stagePersonSlackReactionApprovalPendingV1({ database, command, now: () => NOW });
  const coordinator = new SqlitePersonSlackReactionApprovalFinalizationCoordinatorV2({
    database,
    authority_fence: {
      async withStablePersonSlackReactionApprovalFence(commit) {
        return commit({
          approvalIsCurrent: () => true,
          currentMembership: ({ principal_id, membership_id }) =>
            principal_id === link.principal_id &&
            membership_id === link.membership_id
              ? {
                  principal_id: link.principal_id,
                  membership_id: link.membership_id,
                  membership_type: "owner",
                }
              : undefined,
        });
      },
    },
  });
  let calls = 0;
  const provider = {
    observeApprovalReaction: async (
      expectation: PersonSlackReactionApprovalProviderExpectationV2,
      expectationSha256: ApprovalContractSha256,
    ): Promise<PersonSlackReactionApprovalProviderResultV2> => {
      calls += 1;
      return {
        kind: "observed",
        expectation_sha256: expectationSha256,
        provider_actor_subject: "UFOUNDER",
        observed_reaction:
          action === "approve"
            ? expectation.approve_reaction
            : expectation.reject_reaction,
        observed_action: action,
        provider_response_evidence_sha256: digest(`observed:${action}`),
        observed_at: OBSERVED,
      };
    },
  };
  return { database, command, coordinator, provider, calls: () => calls };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Person Slack reaction approval staging", () => {
  it.each(["approve", "reject"] as const)(
    "commits and exactly replays a founder %s reaction",
    async (action) => {
      const fixture = setup(action);
      const ids = { value: 0 };
      const input = {
        command: { approval_id: fixture.command.approval.approval_id },
        coordinator: fixture.coordinator,
        provider: fixture.provider,
        codec: { sha256: canonicalSha256 },
        ids: {
          next: (kind: "audit_event" | "correlation") =>
            `${kind === "audit_event" ? "aud" : "cor"}_${++ids.value}`,
        },
        now: () => COMMITTED,
      };
      const first = await finalizePersonSlackReactionApprovalV2(input);
      expect(first).toMatchObject({ kind: "resolved", value: { action } });
      const replay = await finalizePersonSlackReactionApprovalV2(input);
      expect(replay).toEqual(first);
      expect(fixture.calls()).toBe(1);
      expect(
        fixture.database
          .prepare(
            "SELECT count(*) AS count FROM organization_provider_human_action_evidence",
          )
          .get(),
      ).toEqual({ count: 1 });
    },
  );

  it("stages exact commands once and rejects changed command or approval input", () => {
    const fixture = setup("approve");
    const first = stagePersonSlackReactionApprovalPendingV1({
      database: fixture.database,
      command: fixture.command,
      now: () => NOW,
    });
    expect(first.idempotent).toBe(true);
    expect(() =>
      stagePersonSlackReactionApprovalPendingV1({
        database: fixture.database,
        command: {
          ...fixture.command,
          approval: {
            ...fixture.command.approval,
            frozen_card_sha256: digest("changed"),
          },
        },
        now: () => NOW,
      }),
    ).toThrow(PersonSlackReactionApprovalPendingConflictError);
    expect(() =>
      stagePersonSlackReactionApprovalPendingV1({
        database: fixture.database,
        command: {
          ...fixture.command,
          command_id: "pas_second",
          approval: {
            ...fixture.command.approval,
            approved_snapshot_sha256: digest("changed"),
          },
        },
        now: () => NOW,
      }),
    ).toThrow(PersonSlackReactionApprovalPendingConflictError);
  });
});

describe("Slack reaction approval observer", () => {
  const expectation = {
    schema_version: 2,
    kind: "echo-person-slack-provider-expectation-v2",
    ...COORDINATES,
    approval_id: "apr_founder",
    connection_id: "con_founder",
    connection_contract_sha256: digest("connection"),
    connection_state_sha256: digest("state"),
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: "T_FOUND",
    provider_enterprise_id: null,
    tool_kind: "slack",
    provider_app_id: "A_FOUND",
    provider_bot_id: "B_FOUND",
    provider_bot_user_id: "U_BOT",
    approval_binding_id: "bnd_founder",
    approval_binding_contract_sha256: digest("binding"),
    approval_adapter_kind: "approval-surface",
    approval_adapter_id: "slack-reactions",
    approval_adapter_instance_id: "founder-approval",
    approval_adapter_version: "1.0.0",
    approval_channel_id: "C_FOUND",
    provider_message_ts: "1724112000.000100",
    approve_reaction: "white_check_mark",
    reject_reaction: "x",
    policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    policy_contract_sha256:
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
    policy_consequence_sha256:
      ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
    frozen_card_sha256: digest("card"),
    approved_snapshot_sha256: digest("snapshot"),
  } as const;

  it("observes one matching reaction without a live provider", async () => {
    let authorization = "";
    const observer = new SlackReactionApprovalObserverV1({
      token_reader: { readBotToken: () => "private-token" },
      now: () => OBSERVED,
      fetch: async (_url, init) => {
        authorization = String(
          (init?.headers as Record<string, string>).authorization,
        );
        return new Response(
          JSON.stringify({
            ok: true,
            message: {
              ts: expectation.provider_message_ts,
              reactions: [{ name: "white_check_mark", users: ["UFOUNDER"] }],
            },
          }),
        );
      },
    });
    await expect(
      observer.observeApprovalReaction(expectation, digest("expectation")),
    ).resolves.toMatchObject({
      kind: "observed",
      observed_action: "approve",
      provider_actor_subject: "UFOUNDER",
    });
    expect(authorization).toBe("Bearer private-token");
  });

  it("does not choose between conflicting reactions", async () => {
    const observer = new SlackReactionApprovalObserverV1({
      token_reader: { readBotToken: () => "private-token" },
      now: () => OBSERVED,
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            message: {
              ts: expectation.provider_message_ts,
              reactions: [
                { name: "white_check_mark", users: ["UFOUNDER"] },
                { name: "x", users: ["UFOUNDER"] },
              ],
            },
          }),
        ),
    });
    await expect(
      observer.observeApprovalReaction(expectation, digest("expectation")),
    ).resolves.toEqual({
      kind: "not_resolved",
      reason: "conflicting_reactions",
    });
  });
});
