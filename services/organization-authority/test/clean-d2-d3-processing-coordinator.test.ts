import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
  buildExternalHumanIdentityLinkContractV2,
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
  buildPersonSlackApprovalActionCapabilityV2,
  buildPersonSlackApprovalBindingContractV2,
  type ApprovalContractSha256,
  type PersonApprovalAction,
} from "../../organization-control-plane/src/application/person-slack-approval-contracts-v2.js";
import type {
  PersonSlackApprovalProviderExpectationV2,
  PersonSlackApprovalProviderResultV2,
} from "../../organization-control-plane/src/application/person-slack-approval-finalization-v2.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../../organization-control-plane/src/canonical/canonical-json.js";
import { applyOrganizationControlBaselineV1 } from "../../organization-control-plane/src/persistence/baseline.js";
import { SqlitePersonSlackApprovalFinalizationCoordinatorV2 } from "../../organization-control-plane/src/persistence/sqlite-person-slack-approval-finalization-v2.js";
import {
  stagePersonSlackPendingApprovalV1,
  type StagePersonSlackPendingApprovalCommandV1,
} from "../../organization-control-plane/src/persistence/sqlite-person-slack-pending-approval-v1.js";
import type { CleanV4RecordWriterV1 } from "../src/processing/clean-v1-record/clean-v4-record-writer.js";
import {
  CleanD2ToD3ProcessingCoordinatorV1,
  type CleanD2ToD3AuthorityStateV1,
  type FrozenCleanD2ToD3CandidateV1,
} from "../src/processing/clean-v1-d2-d3/clean-d2-d3-processing-coordinator.js";

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

function snapshot(): Record<string, unknown> {
  return {
    schema_version: 2,
    kind: "echo-approved-decision-snapshot-v2",
    approval_id: "apr_founder",
    staged_content_sha256: digest("staged"),
    final_content_sha256: digest("final"),
    payload_contract_id: "organization-record-approval-payload-v1",
    approved_payload: {
      brief: {
        schema_version: 1,
        id: "brief_founder",
        meeting: { id: "meeting_founder", participants: [] },
        decisions: [
          {
            id: "decision_founder",
            kind: "decision",
            text: "Ship the clean migration.",
            subject: null,
            confidence: null,
            evidence: [{ meeting_id: "meeting_founder", block_id: "block_1" }],
            status: "decided",
          },
        ],
        actions: [],
        rationales: [],
        provenance: {
          meeting_revision: "revision_1",
          processor: {
            kind: "decision-processor",
            adapter_id: "llm",
            instance_id: "founder-llm",
            version: "1.3.0",
          },
          generated_at: NOW,
        },
      },
      source: {
        adapter_id: "granola",
        instance_id: "founder-granola",
        external_id: "external_founder",
      },
      alternatives: [],
      links: null,
      reviewed_at: NOW,
      surface: "person-approval",
    },
  };
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
    required_provider_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    public_connection_configuration_sha256: digest("configuration"),
  });
  const connectionSha = canonicalSha256(connection);
  const state = buildOrganizationToolConnectionStateV2({
    connection_id: connection.connection_id,
    connection_contract_sha256: connectionSha,
    connection_status: "active",
    credential_reference_sha256: digest("credential"),
    observed_granted_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    verification_event_id: "verify_founder",
    verification_evidence_sha256: digest("verification"),
    verification_revision: 1,
    verified_at: NOW,
  });
  const stateSha = canonicalSha256(state);
  database
    .prepare(
      `INSERT INTO organization_tool_connection_contracts (connection_id, contract_json, contract_sha256, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(
      connection.connection_id,
      canonicalJson(connection),
      connectionSha,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO organization_tool_connection_current_state (connection_id, connection_contract_sha256, state_json, state_sha256, current_status, updated_at) VALUES (?, ?, ?, ?, 'active', ?)`,
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
      `INSERT INTO organization_external_human_link_contracts (external_identity_link_id, contract_sha256, contract_json, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(link.external_identity_link_id, linkSha, canonicalJson(link), NOW);
  database
    .prepare(
      `INSERT INTO organization_external_human_link_current (external_identity_link_id, contract_sha256, provider_issuer, provider_tenant_kind, provider_tenant_id, provider_enterprise_id, provider_subject_id, principal_id, membership_id, current_status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
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

  const binding = buildPersonSlackApprovalBindingContractV2({
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
      `INSERT INTO organization_approval_binding_contracts (approval_binding_id, contract_json, contract_sha256, connection_id, created_at) VALUES (?, ?, ?, ?, ?)`,
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
      `INSERT INTO organization_approval_binding_current (approval_binding_id, contract_sha256, current_status, updated_at) VALUES (?, ?, 'active', ?)`,
    )
    .run(binding.approval_binding_id, bindingSha, NOW);
  for (const candidateAction of ["approve", "reject"] as const) {
    const capability = buildPersonSlackApprovalActionCapabilityV2({
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
        `INSERT INTO organization_approval_action_capability_contracts (action_capability_id, contract_json, contract_sha256, approval_binding_id, external_identity_link_id, policy_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
        `INSERT INTO organization_approval_action_capability_current (action_capability_id, contract_sha256, current_status, updated_at) VALUES (?, ?, 'active', ?)`,
      )
      .run(capability.action_capability_id, capabilitySha, NOW);
  }

  const approvedSnapshot = snapshot();
  const command: StagePersonSlackPendingApprovalCommandV1 = {
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
      approved_snapshot_sha256: canonicalSha256(approvedSnapshot),
    },
  };
  stagePersonSlackPendingApprovalV1({ database, command, now: () => NOW });
  const coordinator = new SqlitePersonSlackApprovalFinalizationCoordinatorV2({
    database,
    authority_fence: {
      async withStablePersonSlackApprovalFence(commit) {
        return commit({
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
  const provider = {
    observeApprovalReaction: async (
      expectation: PersonSlackApprovalProviderExpectationV2,
      expectation_sha256: ApprovalContractSha256,
    ): Promise<PersonSlackApprovalProviderResultV2> => ({
      kind: "observed",
      expectation_sha256,
      provider_actor_subject: "UFOUNDER",
      observed_reaction:
        action === "approve"
          ? expectation.approve_reaction
          : expectation.reject_reaction,
      observed_action: action,
      provider_response_evidence_sha256: digest(`observed:${action}`),
      observed_at: OBSERVED,
    }),
  };
  return { database, command, coordinator, provider, approvedSnapshot };
}

function frozenCandidate(
  approvedSnapshot: Record<string, unknown>,
): FrozenCleanD2ToD3CandidateV1 {
  return {
    candidate_id: "cnd_founder",
    candidate_semantic_sha256: digest("candidate"),
    approval_id: "apr_founder",
    frozen_card_sha256: digest("frozen-card"),
    approved_snapshot: approvedSnapshot,
    approved_snapshot_sha256: canonicalSha256(approvedSnapshot),
    control_approval_sha256: digest("control"),
    admission: {
      source: {
        adapter_id: "granola",
        instance_id: "founder-granola",
        version: "1.0.0",
        cursor: "granola:v1:live:1",
        cutoff_at: NOW,
      },
      processor: {
        adapter_id: "llm",
        instance_id: "founder-llm",
        version: "1.3.0",
        configuration_sha256: digest("llm"),
      },
    },
    meeting: {
      schema_version: 1,
      id: "meeting_founder",
      provenance: {
        source: {
          kind: "meeting-source",
          adapter_id: "granola",
          instance_id: "founder-granola",
          version: "1.0.0",
        },
        external_id: "external_founder",
        canonical_revision: "revision_1",
        observed_at: NOW,
        normalizer_version: "1.0.0",
      },
      capture: { state: "complete", components: [] },
      participants: [],
      content: [],
      artifacts: [],
    },
    decisions: {
      schema_version: 1,
      meeting_id: "meeting_founder",
      meeting_revision: "revision_1",
      processor: {
        kind: "decision-processor",
        adapter_id: "llm",
        instance_id: "founder-llm",
        version: "1.3.0",
      },
      generated_at: NOW,
      signals: [],
    },
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("clean D2 to D3 processing coordinator", () => {
  it.each(["approve", "reject"] as const)(
    "finalizes %s and does not duplicate its V4 append after restart",
    async (action) => {
      const fixture = setup(action);
      const candidate = frozenCandidate(fixture.approvedSnapshot);
      let recorded = false;
      const inputs: unknown[] = [];
      const authority: CleanD2ToD3AuthorityStateV1 = {
        async listStagedApprovalIds() {
          return recorded ? [] : [candidate.approval_id];
        },
        async readFrozenCandidateForApproval() {
          return candidate;
        },
        async recordV4Receipt() {
          recorded = true;
        },
      };
      const record_writer = {
        appendFinalized: async (input: unknown) => {
          inputs.push(input);
          return {
            outcome: "appended",
            position: 1,
            envelope_id: "rec_1",
            envelope_sha256: digest("envelope"),
            record_sha256: digest("record"),
            receipt: { receipt: "ok" },
          };
        },
      } as unknown as CleanV4RecordWriterV1;
      const make = () =>
        new CleanD2ToD3ProcessingCoordinatorV1({
          authority,
          finalization: {
            coordinator: fixture.coordinator,
            observer: fixture.provider,
            codec: { sha256: canonicalSha256 },
            ids: {
              next: (kind) =>
                `${kind === "audit_event" ? "aud" : "cor"}_founder`,
            },
            now: () => COMMITTED,
          },
          record_writer,
        });
      const signal = new AbortController().signal;
      const first = make();
      await first.observeAndFinalizePendingApprovals(signal);
      await first.appendFinalizedApprovalsToV4(signal);
      await make().recoverV4Appends(signal);
      expect(inputs).toHaveLength(1);
      expect(
        (inputs[0] as { human_act_record_input: { event: { kind: string } } })
          .human_act_record_input.event.kind,
      ).toBe(action === "approve" ? "approved" : "rejected");
    },
  );
});
