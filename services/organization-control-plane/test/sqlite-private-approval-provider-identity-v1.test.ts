import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
  SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
} from "../src/application/person-slack-approval-contracts-v2.js";
import {
  PRIVATE_APPROVAL_PENDING_KIND,
  type PendingPrivateApprovalV1,
} from "../src/application/private-approval-policy-resolution-v1.js";
import { canonicalJson, canonicalSha256 } from "../src/canonical/canonical-json.js";
import {
  PrivateApprovalFinalizationConflictError,
  PrivateApprovalFinalizationDeniedError,
  SqlitePrivateApprovalPersistenceV1,
  type StagePrivateApprovalPendingV1,
  type PrivateApprovalSignedTerminalActionV1,
  type PrivateApprovalSlackCardBindingV1,
} from "../src/persistence/sqlite-private-approval-persistence-v1.js";

const databases: Database.Database[] = [];
const sha = (letter: string) => `sha256:${letter.repeat(64)}` as const;
const now = () => "2026-08-28T00:00:00.000Z";

function setup() {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE organization_tool_connection_contracts (connection_id TEXT, contract_sha256 TEXT, contract_json TEXT);
    CREATE TABLE organization_tool_connection_current_state (connection_id TEXT, connection_contract_sha256 TEXT, state_sha256 TEXT, state_json TEXT, current_status TEXT);
    CREATE TABLE organization_external_human_link_current (external_identity_link_id TEXT, contract_sha256 TEXT, current_status TEXT, provider_issuer TEXT, provider_tenant_kind TEXT, provider_tenant_id TEXT, provider_enterprise_id TEXT, provider_subject_id TEXT, principal_id TEXT, membership_id TEXT);
    CREATE TABLE organization_private_approval_pending_contracts_v2 (
      approval_id TEXT PRIMARY KEY, candidate_id TEXT, organization_id TEXT,
      authority_id TEXT, pending_json TEXT,
      pending_sha256 TEXT, card_binding_json TEXT, card_binding_sha256 TEXT,
      stage_command_id TEXT,
      connection_id TEXT, connection_contract_sha256 TEXT,
      connection_state_sha256 TEXT, external_identity_link_id TEXT,
      external_identity_link_contract_sha256 TEXT, assignee_principal_id TEXT,
      assignee_membership_id TEXT, slack_workspace_id TEXT,
      slack_enterprise_id TEXT, slack_subject_id TEXT, dm_channel_id TEXT,
      provider_message_ts TEXT, card_sha256 TEXT, created_at TEXT
    );
    CREATE TABLE organization_private_approval_signed_action_receipts_v2 (
      provider_receipt_id TEXT PRIMARY KEY, provider_action_key TEXT UNIQUE,
      raw_payload_sha256 TEXT UNIQUE, normalized_receipt_json TEXT,
      normalized_receipt_sha256 TEXT UNIQUE, approval_id TEXT, action_id TEXT,
      action_kind TEXT, received_at TEXT, verified_at TEXT
    );
    CREATE TABLE organization_private_approval_terminal_evidence_v2 (
      approval_id TEXT PRIMARY KEY, resolution_json TEXT, resolution_sha256 TEXT,
      signed_action_receipt_sha256 TEXT UNIQUE, outcome TEXT, audit_event_id TEXT,
      audit_sequence INTEGER, audit_entry_json TEXT, audit_entry_sha256 TEXT,
      predecessor_entry_sha256 TEXT, committed_at TEXT
    );
  `);
  const pending: PendingPrivateApprovalV1 = {
    schema_version: 1, kind: PRIVATE_APPROVAL_PENDING_KIND,
    approval_id: "apr_00000000-0000-4000-8000-000000000001",
    organization_id: "org_00000000-0000-4000-8000-000000000001",
    candidate_sha256: sha("a"), frozen_card_sha256: sha("b"), approved_snapshot_sha256: sha("c"),
    assigned_owner: { principal_id: "prn_00000000-0000-4000-8000-000000000001", membership_id: "mem_00000000-0000-4000-8000-000000000001" },
    assigned_owner_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_00000000-0000-4000-8000-000000000001", external_identity_link_contract_sha256: sha("d"), provider_subject_id: "U01234567" },
  };
  const connection = buildOrganizationToolConnectionContractV2({
    authority_id: "oau_00000000-0000-4000-8000-000000000001", organization_id: pending.organization_id, state_lineage_id: "lineage-1", connection_id: "con_00000000-0000-4000-8000-000000000001", provider_issuer: "https://slack.com", provider_tenant_kind: "workspace", provider_tenant_id: "T01234567", provider_enterprise_id: null, tool_kind: "slack", provider_app_id: "A01234567", provider_bot_id: "B01234567", provider_bot_user_id: "U09876543", required_provider_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES, public_connection_configuration_sha256: sha("f"),
  });
  const connectionSha = canonicalSha256(connection);
  const state = buildOrganizationToolConnectionStateV2({
    connection_id: connection.connection_id, connection_contract_sha256: connectionSha, connection_status: "active", credential_reference_sha256: sha("0"), observed_granted_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES, verification_event_id: "evt_00000000-0000-4000-8000-000000000001", verification_evidence_sha256: sha("1"), verification_revision: 1, verified_at: now(),
  });
  const stateSha = canonicalSha256(state);
  const card: PrivateApprovalSlackCardBindingV1 = { schema_version: 1, kind: "echo-private-approval-slack-card-binding-v1", approval_id: pending.approval_id, connection_id: connection.connection_id, connection_contract_sha256: connectionSha, connection_state_sha256: stateSha, slack_workspace_id: connection.provider_tenant_id, slack_enterprise_id: connection.provider_enterprise_id, slack_subject_id: pending.assigned_owner_slack_identity_link.provider_subject_id, dm_channel_id: "D01234567", provider_message_ts: "1712345678.123456", card_sha256: pending.frozen_card_sha256 };
  database.prepare(`INSERT INTO organization_tool_connection_contracts VALUES (?, ?, ?)`).run(connection.connection_id, connectionSha, canonicalJson(connection));
  database.prepare(`INSERT INTO organization_tool_connection_current_state VALUES (?, ?, ?, ?, 'active')`).run(connection.connection_id, connectionSha, stateSha, canonicalJson(state));
  database.prepare(`INSERT INTO organization_external_human_link_current VALUES (?, ?, 'active', 'https://slack.com', 'workspace', ?, NULL, ?, ?, ?)`).run(pending.assigned_owner_slack_identity_link.external_identity_link_id, pending.assigned_owner_slack_identity_link.external_identity_link_contract_sha256, card.slack_workspace_id, card.slack_subject_id, pending.assigned_owner.principal_id, pending.assigned_owner.membership_id);
  const receipt: PrivateApprovalSignedTerminalActionV1 = {
    schema_version: 1,
    kind: "echo-private-approval-signed-block-action-receipt-v1",
    provider_action_key_sha256: sha("7"),
    request: { request_timestamp: "1800000000", signature_version: "v0", signature_sha256: sha("8"), raw_body_sha256: sha("9") },
    approval_id: pending.approval_id,
    action_id: "echo-private-approval-v1-action",
    action: "approve",
    selected_policy_id: "restricted-reviewer-person-v2",
    comment: null,
    lookup: { api_app_id: "A01234567", workspace_id: card.slack_workspace_id, enterprise_id: null, slack_user_id: card.slack_subject_id, channel_id: card.dm_channel_id, message_ts: card.provider_message_ts, message_user_id: "U09876543", message_app_id: "A01234567", message_bot_id: "B01234567" },
    received_at: now(),
    verified_at: now(),
  };
  const persistence = new SqlitePrivateApprovalPersistenceV1({ database, now, authority_fence: { async withStablePrivateApprovalFence(commit) { return commit({
    approvalIsCurrent: () => true,
    currentMembership: (input) => input.principal_id === pending.assigned_owner.principal_id && input.membership_id === pending.assigned_owner.membership_id ? pending.assigned_owner : undefined,
    reprovePrivateApprovalAuthorization: () => ({
      schema_version: 1,
      kind: "echo-private-approval-authorization-allow-v1",
      approval_id: pending.approval_id,
      organization_id: pending.organization_id,
      candidate_sha256: pending.candidate_sha256,
      frozen_card_sha256: pending.frozen_card_sha256,
      approved_snapshot_sha256: pending.approved_snapshot_sha256,
      authorized_assignee: pending.assigned_owner,
      current_slack_identity_link: pending.assigned_owner_slack_identity_link,
      authorization_proof_sha256: sha("e"),
    }),
  }); } } });
  return { database, pending, card, receipt, persistence };
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("private approval provider identity fence", () => {
  it("stages the pending contract and exact Slack card binding in one durable row", () => {
    const { database, pending, card, persistence } = setup();
    const input: StagePrivateApprovalPendingV1 = {
      stage_command_id: "pas_00000000-0000-4000-8000-000000000001",
      authority_id: "oau_00000000-0000-4000-8000-000000000001",
      candidate_id: "cnd_00000000-0000-4000-8000-000000000001",
      pending,
      card_binding: card,
    };

    expect(persistence.stage(input)).toMatchObject({ idempotent: false, pending, card_binding: card });
    expect(database.prepare(`SELECT pending_json, card_binding_json, dm_channel_id, provider_message_ts FROM organization_private_approval_pending_contracts_v2`).get()).toEqual({
      pending_json: canonicalJson(pending),
      card_binding_json: canonicalJson(card),
      dm_channel_id: card.dm_channel_id,
      provider_message_ts: card.provider_message_ts,
    });
    expect(persistence.stage(input)).toMatchObject({ idempotent: true, pending, card_binding: card });
  });

  it("requires both app claims, bot, and bot-user to match the current connection", () => {
    const { pending, card, receipt, persistence } = setup();
    const reprove = (persistence as unknown as { reproveControlPlaneSlackState(a: PendingPrivateApprovalV1, b: PrivateApprovalSlackCardBindingV1, c: PrivateApprovalSignedTerminalActionV1): void }).reproveControlPlaneSlackState.bind(persistence);
    expect(() => reprove(pending, card, receipt)).not.toThrow();
    for (const lookup of [
      { ...receipt.lookup, api_app_id: "A09999999" },
      { ...receipt.lookup, message_app_id: "A09999999" },
      { ...receipt.lookup, message_bot_id: "B09999999" },
      { ...receipt.lookup, message_user_id: "U09999999" },
    ]) {
      expect(() => reprove(pending, card, { ...receipt, lookup })).toThrow(
        PrivateApprovalFinalizationDeniedError,
      );
    }
  });

  it("types a distinct second signed click for a terminal approval as a conflict", async () => {
    const { database, pending, card, receipt, persistence } = setup();
    persistence.stage({
      stage_command_id: "pas_00000000-0000-4000-8000-000000000001",
      authority_id: "oau_00000000-0000-4000-8000-000000000001",
      candidate_id: "cnd_00000000-0000-4000-8000-000000000001",
      pending,
      card_binding: card,
    });
    persistence.enqueue({ disposition: "resolution", receipt });
    await expect(persistence.finalize(receipt.provider_action_key_sha256)).resolves.toMatchObject({
      signed_action_receipt_sha256: expect.any(String),
    });

    const laterClick = {
      ...receipt,
      provider_action_key_sha256: sha("f"),
      request: { ...receipt.request, signature_sha256: sha("a"), raw_body_sha256: sha("b") },
    };
    persistence.enqueue({ disposition: "resolution", receipt: laterClick });

    await expect(persistence.finalize(laterClick.provider_action_key_sha256)).rejects.toBeInstanceOf(
      PrivateApprovalFinalizationConflictError,
    );
    expect(database.prepare(`SELECT count(*) AS count FROM organization_private_approval_terminal_evidence_v2`).get()).toEqual({ count: 1 });
  });
});
