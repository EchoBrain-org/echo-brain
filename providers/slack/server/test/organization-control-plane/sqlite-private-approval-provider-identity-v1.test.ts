import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../src/organization-control-plane/application/slack-integration-contracts.js";
import Database from "better-sqlite3";
import { applyAuthorityBaselineV10 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { SqliteStablePrivateApprovalAuthorityFenceV1 } from "../../src/private-approval/sqlite-stable-private-approval-authority-fence-v1.js";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, canonicalSha256 } from "../../../../../packages/organization-control-plane/src/canonical/canonical-json.js";
import { buildOrganizationToolConnectionContractV2, buildOrganizationToolConnectionStateV2 } from "../../src/organization-control-plane/application/organization-tool-connection-contracts-v2.js";
import { PRIVATE_APPROVAL_PENDING_KIND, type PendingPrivateApprovalV1 } from "../../src/organization-control-plane/application/slack/private-approval-policy-resolution-v1.js";
import { PrivateApprovalFinalizationConflictError, PrivateApprovalFinalizationDeniedError, PrivateApprovalSignedActionConflictError, SqliteSlackDmApprovalPersistenceV1, type PrivateApprovalSignedTerminalActionV1, type PrivateApprovalSlackCardBindingV1, type StagePrivateApprovalPendingV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-dm-approval-persistence-v1.js";

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
    authority_id: "oau_00000000-0000-4000-8000-000000000001", organization_id: pending.organization_id, state_lineage_id: "lineage-1", connection_id: "con_00000000-0000-4000-8000-000000000001", provider_issuer: "https://slack.com", provider_tenant_kind: "workspace", provider_tenant_id: "T01234567", provider_enterprise_id: null, tool_kind: "slack", provider_app_id: "A01234567", provider_bot_id: "B01234567", provider_bot_user_id: "U09876543", required_provider_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, public_connection_configuration_sha256: sha("f"),
  });
  const connectionSha = canonicalSha256(connection);
  const state = buildOrganizationToolConnectionStateV2({
    connection_id: connection.connection_id, connection_contract_sha256: connectionSha, connection_status: "active", credential_reference_sha256: sha("0"), observed_granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, verification_event_id: "evt_00000000-0000-4000-8000-000000000001", verification_evidence_sha256: sha("1"), verification_revision: 1, verified_at: now(),
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
  const persistence = new SqliteSlackDmApprovalPersistenceV1({ database, now, authority_fence: { async withStablePrivateApprovalFence(commit) { return commit({
    approvalIsCurrent: () => true,
    currentMembership: (input) => input.principal_id === pending.assigned_owner.principal_id && input.membership_id === pending.assigned_owner.membership_id ? pending.assigned_owner : undefined,
    revalidatePrivateApprovalAuthorization: () => ({
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
    const revalidate = (persistence as unknown as { revalidateControlPlaneSlackState(a: PendingPrivateApprovalV1, b: PrivateApprovalSlackCardBindingV1, c: PrivateApprovalSignedTerminalActionV1): void }).revalidateControlPlaneSlackState.bind(persistence);
    expect(() => revalidate(pending, card, receipt)).not.toThrow();
    for (const lookup of [
      { ...receipt.lookup, api_app_id: "A09999999" },
      { ...receipt.lookup, message_app_id: "A09999999" },
      { ...receipt.lookup, message_bot_id: "B09999999" },
      { ...receipt.lookup, message_user_id: "U09999999" },
    ]) {
      expect(() => revalidate(pending, card, { ...receipt, lookup })).toThrow(
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

  it("denies an archived or changed project before V2 approval and replays accepted approval after archive", async () => {
    const { database, pending: v1, card } = setup();
    const project = "prj_00000000-0000-4000-8000-000000000001";
    const grant = { project_id: project, project_membership_id: "pgm_00000000-0000-4000-8000-000000000001" };
    const pending = {
      ...v1, schema_version: 2 as const, kind: "echo-private-approval-pending-v2" as const,
      eligible_projects: [{ ...grant, name: "Project" }],
      transcript_source: { source_id: "src_00000000-0000-4000-8000-000000000001", revision_id: "rev_00000000-0000-4000-8000-000000000001", source_sha256: sha("f") },
    };
    const authorityDatabase = new Database(":memory:");
    databases.push(authorityDatabase);
    applyAuthorityBaselineV10(authorityDatabase);
    authorityDatabase.pragma("foreign_keys = OFF");
    authorityDatabase.prepare(`INSERT INTO authority_metadata(singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at)
      VALUES(1,'oau_fixture',?,'Fixture','{}',?,?)`).run(pending.organization_id, now(), now());
    authorityDatabase.prepare(`INSERT INTO authority_principals(principal_id,organization_id,display_name,provisioned_at)
      VALUES(?,?,'Owner',?)`).run(pending.assigned_owner.principal_id, pending.organization_id, now());
    authorityDatabase.prepare(`INSERT INTO authority_memberships(membership_id,organization_id,principal_id,membership_type,status,provisioned_at)
      VALUES(?,?,?,'owner','active',?)`).run(pending.assigned_owner.membership_id, pending.organization_id, pending.assigned_owner.principal_id, now());
    authorityDatabase.prepare(`INSERT INTO authority_projects_v1(project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type)
      VALUES(?,?,'Project',?,?,?,'owner')`).run(project, pending.organization_id, now(), pending.assigned_owner.principal_id, pending.assigned_owner.membership_id);
    authorityDatabase.prepare(`INSERT INTO authority_project_memberships_v1(project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at)
      VALUES(?,?,?,?,?,'owner','lead','active',?)`).run(grant.project_membership_id, project, pending.organization_id, pending.assigned_owner.principal_id, pending.assigned_owner.membership_id, now());
    const realFence = new SqliteStablePrivateApprovalAuthorityFenceV1(authorityDatabase);
    let grants: readonly typeof grant[] | undefined = [grant];
    const store = new SqliteSlackDmApprovalPersistenceV1({ database, now, authority_fence: {
      withStablePrivateApprovalFence: async (commit) => realFence.withStablePrivateApprovalFence((stable) => {
        const result = commit({
        approvalIsCurrent: () => true, currentMembership: () => pending.assigned_owner,
        currentProjectMemberships: (input) => stable.currentProjectMemberships?.(input) === undefined ? undefined : grants,
        revalidatePrivateApprovalAuthorization: () => ({ schema_version: 2 as const, kind: "echo-private-approval-authorization-allow-v2" as const, approval_id: pending.approval_id, organization_id: pending.organization_id, candidate_sha256: pending.candidate_sha256, frozen_card_sha256: pending.frozen_card_sha256, approved_snapshot_sha256: pending.approved_snapshot_sha256, authorized_assignee: pending.assigned_owner, current_slack_identity_link: pending.assigned_owner_slack_identity_link, authorization_proof_sha256: sha("e") }),
      });
        expect(result).not.toHaveProperty("then");
        return result;
      }),
    } });
    store.stageV2({ stage_command_id: "pas_00000000-0000-4000-8000-000000000002", authority_id: "oau_00000000-0000-4000-8000-000000000001", candidate_id: "cnd_00000000-0000-4000-8000-000000000002", pending, card_binding: card });
    const receipt = { schema_version: 2 as const, kind: "echo-private-approval-signed-block-action-receipt-v2" as const, provider_action_key_sha256: sha("6"), request: { request_timestamp: "1800000000", signature_version: "v0" as const, signature_sha256: sha("8"), raw_body_sha256: sha("6") }, approval_id: pending.approval_id, action_id: "echo-private-approval-v2-action", action: "approve" as const, selected_policy_id: "project-members-readable-person-v1" as const, selected_project_ids: [project], share_transcript: true, comment: null, lookup: { api_app_id: "A01234567", workspace_id: card.slack_workspace_id, enterprise_id: null, slack_user_id: card.slack_subject_id, channel_id: card.dm_channel_id, message_ts: card.provider_message_ts, message_user_id: "U09876543", message_app_id: "A01234567", message_bot_id: "B01234567" }, received_at: now(), verified_at: now() };
    expect(store.enqueueV2(receipt)).toMatchObject({ idempotent: false });
    expect(store.enqueueV2({ ...receipt, received_at: "2026-08-28T00:01:00.000Z", verified_at: "2026-08-28T00:01:00.000Z" })).toMatchObject({ idempotent: true });
    expect(() => store.enqueueV2({ ...receipt, share_transcript: false })).toThrow(PrivateApprovalSignedActionConflictError);
    grants = [{ project_id: project, project_membership_id: "pgm_00000000-0000-4000-8000-000000000099" }];
    await expect(store.finalize(receipt.provider_action_key_sha256)).rejects.toBeInstanceOf(PrivateApprovalFinalizationDeniedError);
    grants = undefined;
    await expect(store.finalize(receipt.provider_action_key_sha256)).rejects.toBeInstanceOf(PrivateApprovalFinalizationDeniedError);
    grants = [grant];
    authorityDatabase.prepare("UPDATE authority_projects_v1 SET status='archived' WHERE project_id=?").run(project);
    await expect(store.finalize(receipt.provider_action_key_sha256)).rejects.toBeInstanceOf(PrivateApprovalFinalizationDeniedError);
    expect(store.listTerminals()).toHaveLength(0);
    authorityDatabase.prepare("UPDATE authority_projects_v1 SET status='active' WHERE project_id=?").run(project);
    const terminal = await store.finalize(receipt.provider_action_key_sha256);
    expect(terminal).toMatchObject({ resolution: { schema_version: 2, selected_project_ids: [project], share_transcript: true } });
    authorityDatabase.prepare("UPDATE authority_projects_v1 SET status='archived' WHERE project_id=?").run(project);
    await expect(store.finalize(receipt.provider_action_key_sha256)).resolves.toEqual(terminal);
    grants = undefined;
    await expect(store.finalize(receipt.provider_action_key_sha256)).resolves.toEqual(terminal);
    expect(store.listTerminals()).toHaveLength(1);
  });

  it("finalizes a V3 receipt into a resolution that records only the owners the approver kept or entered", async () => {
    const { database, pending: v1, card } = setup();
    const pending = {
      ...v1, schema_version: 2 as const, kind: "echo-private-approval-pending-v2" as const, eligible_projects: [],
      transcript_source: { source_id: "src_00000000-0000-4000-8000-000000000001", revision_id: "rev_00000000-0000-4000-8000-000000000001", source_sha256: sha("f") },
    };
    const store = new SqliteSlackDmApprovalPersistenceV1({ database, now, authority_fence: { withStablePrivateApprovalFence: async (commit) => commit({
      approvalIsCurrent: () => true, currentMembership: () => pending.assigned_owner, currentProjectMemberships: () => [],
      revalidatePrivateApprovalAuthorization: () => ({ schema_version: 2 as const, kind: "echo-private-approval-authorization-allow-v2" as const, approval_id: pending.approval_id, organization_id: pending.organization_id, candidate_sha256: pending.candidate_sha256, frozen_card_sha256: pending.frozen_card_sha256, approved_snapshot_sha256: pending.approved_snapshot_sha256, authorized_assignee: pending.assigned_owner, current_slack_identity_link: pending.assigned_owner_slack_identity_link, authorization_proof_sha256: sha("e") }),
    }) } });
    store.stageV2({ stage_command_id: "pas_00000000-0000-4000-8000-000000000003", authority_id: "oau_00000000-0000-4000-8000-000000000001", candidate_id: "cnd_00000000-0000-4000-8000-000000000003", pending, card_binding: card });
    const receipt = { schema_version: 3 as const, kind: "echo-private-approval-signed-block-action-receipt-v3" as const, provider_action_key_sha256: sha("7"), request: { request_timestamp: "1800000000", signature_version: "v0" as const, signature_sha256: sha("8"), raw_body_sha256: sha("7") }, approval_id: pending.approval_id, action_id: "echo-private-approval-v2-action", action: "approve" as const, selected_policy_id: "organization-member-readable-person-v2" as const, selected_project_ids: [], share_transcript: false, comment: null, action_owners: [{ action_index: 0, owner: "Jules" }, { action_index: 2, owner: null }], lookup: { api_app_id: "A01234567", workspace_id: card.slack_workspace_id, enterprise_id: null, slack_user_id: card.slack_subject_id, channel_id: card.dm_channel_id, message_ts: card.provider_message_ts, message_user_id: "U09876543", message_app_id: "A01234567", message_bot_id: "B01234567" }, received_at: now(), verified_at: now() };
    expect(store.enqueueV3(receipt)).toMatchObject({ idempotent: false, receipt: { schema_version: 3, action_owners: receipt.action_owners } });
    expect(store.enqueueV3({ ...receipt, received_at: "2026-08-28T00:01:00.000Z", verified_at: "2026-08-28T00:01:00.000Z" })).toMatchObject({ idempotent: true });
    // A different owner is a different signed action.
    expect(() => store.enqueueV3({ ...receipt, action_owners: [{ action_index: 0, owner: "Priya" }] })).toThrow(PrivateApprovalSignedActionConflictError);
    const terminal = await store.finalize(receipt.provider_action_key_sha256);
    expect(terminal.resolution).toMatchObject({ schema_version: 3, kind: "echo-private-approval-resolution-v3", action: "approve", action_owners: [{ action_index: 0, owner: "Jules" }] });
    await expect(store.finalize(receipt.provider_action_key_sha256)).resolves.toEqual(terminal);
    expect(store.listTerminals()).toEqual([terminal]);
  });
});
