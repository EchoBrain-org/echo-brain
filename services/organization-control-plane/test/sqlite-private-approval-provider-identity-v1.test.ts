import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPrivateApprovalSurfaceBindingV1,
} from "../src/application/private-approval-surface-binding-v1.js";
import {
  PRIVATE_APPROVAL_PENDING_KIND,
  type PendingPrivateApprovalV1,
} from "../src/application/private-approval-policy-resolution-v1.js";
import { canonicalJson, canonicalSha256 } from "../src/canonical/canonical-json.js";
import {
  PrivateApprovalFinalizationDeniedError,
  SqlitePrivateApprovalPersistenceV1,
  type PrivateApprovalSignedTerminalActionV1,
  type PrivateApprovalSlackCardBindingV1,
} from "../src/persistence/sqlite-private-approval-persistence-v1.js";

const databases: Database.Database[] = [];
const sha = (letter: string) => `sha256:${letter.repeat(64)}` as const;
const codec = Object.freeze({ sha256: canonicalSha256 });
const now = () => "2026-08-28T00:00:00.000Z";

function setup() {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE organization_tool_connection_current_state (connection_id TEXT, connection_contract_sha256 TEXT, state_sha256 TEXT, current_status TEXT);
    CREATE TABLE organization_private_approval_surface_binding_contracts_v2 (approval_binding_id TEXT, contract_sha256 TEXT, contract_json TEXT);
    CREATE TABLE organization_private_approval_surface_binding_current_v2 (approval_binding_id TEXT, contract_sha256 TEXT, connection_state_sha256 TEXT, current_status TEXT);
    CREATE TABLE organization_external_human_link_current (external_identity_link_id TEXT, contract_sha256 TEXT, current_status TEXT, provider_issuer TEXT, provider_tenant_kind TEXT, provider_tenant_id TEXT, provider_enterprise_id TEXT, provider_subject_id TEXT, principal_id TEXT, membership_id TEXT);
  `);
  const pending: PendingPrivateApprovalV1 = {
    schema_version: 1, kind: PRIVATE_APPROVAL_PENDING_KIND,
    approval_id: "apr_00000000-0000-4000-8000-000000000001",
    organization_id: "org_00000000-0000-4000-8000-000000000001",
    candidate_sha256: sha("a"), frozen_card_sha256: sha("b"), approved_snapshot_sha256: sha("c"), canonical_record_policy_id: null,
    assignment: { schema_version: 1, assignment_version: 1, current_assignee: { principal_id: "prn_00000000-0000-4000-8000-000000000001", membership_id: "mem_00000000-0000-4000-8000-000000000001" }, current_slack_identity_link: { provider: "slack", external_identity_link_id: "clm_00000000-0000-4000-8000-000000000001", external_identity_link_contract_sha256: sha("d"), provider_subject_id: "U01234567" }, assignment_capability_sha256: sha("e") },
  };
  const surface = buildPrivateApprovalSurfaceBindingV1({
    authority_id: "oau_00000000-0000-4000-8000-000000000001", organization_id: pending.organization_id, state_lineage_id: "lineage-1", connection_id: "con_00000000-0000-4000-8000-000000000001", connection_contract_sha256: sha("f"), connection_state_sha256: sha("0"), provider_app_id: "A01234567", provider_bot_id: "B01234567", provider_bot_user_id: "U09876543", slack_workspace_id: "T01234567", slack_enterprise_id: null, adapter_id: "slack-block-actions", adapter_version: "v1", interaction_path: "/v2/integrations/slack/interactions", card_schema_version: 1, action_namespace: "echo-private-approval-v1", supported_policy_ids: ["restricted-reviewer-person-v2", "organization-member-readable-person-v2"],
  }, codec);
  const card: PrivateApprovalSlackCardBindingV1 = { schema_version: 1, kind: "echo-private-approval-slack-card-binding-v1", approval_id: pending.approval_id, assignment_version: 1, connection_id: surface.body.connection_id, connection_contract_sha256: surface.body.connection_contract_sha256, connection_state_sha256: surface.body.connection_state_sha256, approval_surface_binding_id: surface.body.approval_surface_binding_id, approval_surface_binding_contract_sha256: surface.sha256, slack_workspace_id: surface.body.slack_workspace_id, slack_enterprise_id: null, slack_subject_id: pending.assignment.current_slack_identity_link.provider_subject_id, dm_channel_id: "D01234567", provider_message_ts: "1712345678.123456", card_sha256: pending.frozen_card_sha256 };
  database.prepare(`INSERT INTO organization_tool_connection_current_state VALUES (?, ?, ?, 'active')`).run(card.connection_id, card.connection_contract_sha256, card.connection_state_sha256);
  database.prepare(`INSERT INTO organization_private_approval_surface_binding_contracts_v2 VALUES (?, ?, ?)`).run(surface.body.approval_surface_binding_id, surface.sha256, canonicalJson(surface.body));
  database.prepare(`INSERT INTO organization_private_approval_surface_binding_current_v2 VALUES (?, ?, ?, 'active')`).run(surface.body.approval_surface_binding_id, surface.sha256, card.connection_state_sha256);
  database.prepare(`INSERT INTO organization_external_human_link_current VALUES (?, ?, 'active', 'https://slack.com', 'workspace', ?, NULL, ?, ?, ?)`).run(pending.assignment.current_slack_identity_link.external_identity_link_id, pending.assignment.current_slack_identity_link.external_identity_link_contract_sha256, card.slack_workspace_id, card.slack_subject_id, pending.assignment.current_assignee.principal_id, pending.assignment.current_assignee.membership_id);
  const receipt = {
    approval_id: pending.approval_id, assignment_version: 1,
    lookup: { api_app_id: "A01234567", workspace_id: card.slack_workspace_id, enterprise_id: null, slack_user_id: card.slack_subject_id, channel_id: card.dm_channel_id, message_ts: card.provider_message_ts, message_user_id: "U09876543", message_app_id: "A01234567", message_bot_id: "B01234567" },
  } as PrivateApprovalSignedTerminalActionV1;
  const persistence = new SqlitePrivateApprovalPersistenceV1({ database, now, authority_fence: { async withStablePrivateApprovalFence(commit) { return commit({ approvalIsCurrent: () => true, currentMembership: () => undefined, reprovePrivateApprovalAuthorization: () => undefined }); } } });
  return { pending, card, receipt, persistence };
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("private approval provider identity fence", () => {
  it("requires both app claims, bot, and bot-user to match the surface", () => {
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
});
