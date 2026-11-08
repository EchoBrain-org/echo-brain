/** One Slack control database for the provider's tests, holding the rows the Authority's own writers store. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach } from "vitest";
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import { applyOrganizationControlBaselineV4, openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import { buildExternalHumanIdentityLinkContractV2, buildOrganizationToolConnectionContractV2, buildOrganizationToolConnectionStateV2 } from "../src/organization-control-plane/application/organization-tool-connection-contracts-v2.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../src/organization-control-plane/application/slack-integration-contracts.js";
import { slackNangoAppPublicConfigurationSha256V1 } from "../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";

export const COORDINATES = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
});
export const CONNECTION_ID = "con_00000000-0000-4000-8000-000000000001";
/** The member whose Slack link `seedSlackIdentityLink` stores unless told otherwise. */
export const OWNER = Object.freeze({
  principal_id: "prn_00000000-0000-4000-8000-000000000001",
  membership_id: "mem_00000000-0000-4000-8000-000000000001",
  membership_type: "owner" as const,
});
const SEEDED_AT = "2026-08-28T00:00:00.000Z";

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A current-user temporary state directory, removed after the test. */
export function slackStateDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "echo-slack-")));
  directories.push(directory);
  return directory;
}

/**
 * The control database at baseline V4 with its metadata row, closed after the test: in memory, or the
 * `integrations.sqlite` the Authority opens in `state_directory`.
 */
export function openSlackControlDatabase(state_directory?: string): Database.Database {
  const database = openOrganizationControlDatabase(state_directory === undefined ? ":memory:" : join(state_directory, "integrations.sqlite"));
  databases.push(database);
  applyOrganizationControlBaselineV4(database);
  database.prepare(`INSERT INTO organization_control_plane_metadata (singleton, control_plane_id, organization_id, authority_id,
    authority_descriptor_sha256, created_at) VALUES (1, 'ocp_00000000-0000-4000-8000-000000000001', ?, ?, ?, ?)`)
    .run(COORDINATES.organization_id, COORDINATES.authority_id, canonicalSha256({ descriptor: "test" }), SEEDED_AT);
  return database;
}

/** Stores a connection contract and its current state under `connection_id` (the contract's own), as given. */
export function insertSlackConnectionRows(
  database: Database.Database,
  input: { readonly contract: { readonly connection_id: string }; readonly state: object; readonly connection_id?: string; readonly current_status?: "active" | "revoked" },
): void {
  const connectionId = input.connection_id ?? input.contract.connection_id;
  const contractSha256 = canonicalSha256(input.contract);
  database.prepare(`INSERT INTO organization_tool_connection_contracts (connection_id, contract_json, contract_sha256, created_at)
    VALUES (?, ?, ?, ?)`).run(connectionId, canonicalJson(input.contract), contractSha256, SEEDED_AT);
  database.prepare(`INSERT INTO organization_tool_connection_current_state (connection_id, connection_contract_sha256, state_json,
    state_sha256, current_status, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(connectionId, contractSha256, canonicalJson(input.state), canonicalSha256(input.state), input.current_status ?? "active", SEEDED_AT);
}

/**
 * The organization's Slack connection as activation stores it, always under CONNECTION_ID, with `contract` and `state`
 * fields overridden. The row's status follows the state's unless `current_status` says otherwise.
 */
export function seedSlackConnection(
  database: Database.Database,
  input: {
    readonly contract?: Partial<Parameters<typeof buildOrganizationToolConnectionContractV2>[0]>;
    readonly state?: Partial<Parameters<typeof buildOrganizationToolConnectionStateV2>[0]>;
    readonly current_status?: "active" | "revoked";
  } = {},
) {
  const contract = buildOrganizationToolConnectionContractV2({
    ...COORDINATES, connection_id: CONNECTION_ID, provider_issuer: "https://slack.com", provider_tenant_kind: "workspace",
    provider_tenant_id: "T01", provider_enterprise_id: null, tool_kind: "slack", provider_app_id: "A01", provider_bot_id: "B01",
    provider_bot_user_id: "U_BOT", required_provider_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1,
    public_connection_configuration_sha256: slackNangoAppPublicConfigurationSha256V1(), ...input.contract,
  });
  const state = buildOrganizationToolConnectionStateV2({
    connection_id: contract.connection_id, connection_contract_sha256: canonicalSha256(contract), connection_status: "active",
    credential_reference_sha256: canonicalSha256({ credential: "opaque" }), observed_granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1,
    verification_event_id: "verify_connection_01", verification_evidence_sha256: canonicalSha256({ connection: "ok" }),
    verification_revision: 1, verified_at: SEEDED_AT, ...input.state,
  });
  insertSlackConnectionRows(database, { contract, state, connection_id: CONNECTION_ID, current_status: input.current_status ?? state.connection_status });
  return { contract, state };
}

/**
 * Stores a Slack identity link as the link workflow does, its contract body and current row: OWNER's in workspace T01
 * unless overridden. `contract_json`, `contract_sha256` and `row_link_id` store another body, digest or row id.
 */
export function seedSlackIdentityLink(
  database: Database.Database,
  input: Partial<Parameters<typeof buildExternalHumanIdentityLinkContractV2>[0]> & {
    readonly current_status?: "active" | "revoked";
    readonly contract_json?: string;
    readonly contract_sha256?: string;
    readonly row_link_id?: string;
  } = {},
) {
  const { current_status = "active", contract_json, contract_sha256, row_link_id, ...fields } = input;
  const link = buildExternalHumanIdentityLinkContractV2({
    ...COORDINATES, external_identity_link_id: "clm_00000000-0000-4000-8000-000000000001", provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace", provider_tenant_id: "T01", provider_enterprise_id: null, provider_subject_id: "U012ABC", ...OWNER,
    verification_event_id: "verify_link_01", verification_evidence_sha256: canonicalSha256({ link: "ok" }), verified_at: SEEDED_AT, ...fields,
  });
  const linkId = row_link_id ?? link.external_identity_link_id;
  const sha256 = contract_sha256 ?? canonicalSha256(link);
  database.prepare(`INSERT INTO organization_external_human_link_contracts (external_identity_link_id, contract_sha256, contract_json,
    created_at) VALUES (?, ?, ?, ?)`).run(linkId, sha256, contract_json ?? canonicalJson(link), SEEDED_AT);
  database.prepare(`INSERT INTO organization_external_human_link_current (external_identity_link_id, contract_sha256, provider_issuer,
    provider_tenant_kind, provider_tenant_id, provider_enterprise_id, provider_subject_id, principal_id, membership_id, current_status,
    updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(linkId, sha256, link.provider_issuer, link.provider_tenant_kind, link.provider_tenant_id, link.provider_enterprise_id,
      link.provider_subject_id, link.principal_id, link.membership_id, current_status, SEEDED_AT);
  return link;
}
