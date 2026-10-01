import { canonicalJson, canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../adapters/slack/slack-app-manifest-provider-v1.js";
import { validateOrganizationToolConnectionContractV2, validateOrganizationToolConnectionStateV2, type OrganizationToolConnectionContractV2, type OrganizationToolConnectionStateV2 } from "../application/organization-tool-connection-contracts-v2.js";
import type Database from "better-sqlite3";

/**
 * The public configuration every Nango-kind connection commits to. A legacy
 * bot-token-and-channel connection commits to its own channel configuration.
 */
export function slackNangoAppPublicConfigurationSha256V1(): `sha256:${string}` {
  return canonicalSha256({
    kind: "echo-slack-nango-app-public-configuration-v1",
    recipe_version: 1,
  });
}

/** "nango": token from the Nango connection; "legacy": local bot-token secret. */
export type SlackConnectionKindV1 = "nango" | "legacy";

export interface StoredSlackConnectionV1 {
  readonly kind: SlackConnectionKindV1;
  readonly connection: OrganizationToolConnectionContractV2;
  readonly contract_sha256: `sha256:${string}`;
  readonly state: OrganizationToolConnectionStateV2;
  readonly state_sha256: `sha256:${string}`;
}

function parseCanonical(json: string): unknown {
  const value = JSON.parse(json) as unknown;
  if (canonicalJson(value) !== json) {
    throw new Error("stored Slack connection body is not canonical");
  }
  return value;
}

function connectionKind(
  connection: OrganizationToolConnectionContractV2,
): SlackConnectionKindV1 {
  const scopes = connection.required_provider_scopes;
  return connection.public_connection_configuration_sha256 ===
    slackNangoAppPublicConfigurationSha256V1() &&
    scopes.length === SLACK_PRIVATE_APP_BOT_SCOPES_V1.length &&
    scopes.every((scope, index) => scope === SLACK_PRIVATE_APP_BOT_SCOPES_V1[index])
    ? "nango"
    : "legacy";
}

/** Reads the one active connection after proving its digest chain. */
export function readActiveSlackConnectionV1(
  database: Database.Database,
): StoredSlackConnectionV1 | undefined {
  const row = database
    .prepare(
      `SELECT contract.contract_json, contract.contract_sha256,
              current_state.state_json, current_state.state_sha256
       FROM organization_tool_connection_current_state AS current_state
       JOIN organization_tool_connection_contracts AS contract
         ON contract.connection_id = current_state.connection_id
        AND contract.contract_sha256 = current_state.connection_contract_sha256
       WHERE current_state.current_status = 'active'`,
    )
    .get() as
    | {
        contract_json: string;
        contract_sha256: `sha256:${string}`;
        state_json: string;
        state_sha256: `sha256:${string}`;
      }
    | undefined;
  if (row === undefined) return undefined;
  const connection = validateOrganizationToolConnectionContractV2(
    parseCanonical(row.contract_json),
  );
  const state = validateOrganizationToolConnectionStateV2(
    parseCanonical(row.state_json),
  );
  if (
    canonicalSha256(connection) !== row.contract_sha256 ||
    canonicalSha256(state) !== row.state_sha256 ||
    state.connection_contract_sha256 !== row.contract_sha256 ||
    state.connection_status !== "active"
  ) {
    throw new Error("stored Slack connection digest chain is invalid");
  }
  return Object.freeze({
    kind: connectionKind(connection),
    connection,
    contract_sha256: row.contract_sha256,
    state,
    state_sha256: row.state_sha256,
  });
}

/** Approval cards bound to this connection that have no terminal evidence yet. */
export function outstandingPrivateApprovalCountV1(
  database: Database.Database,
  connectionId: string,
): number {
  return database
    .prepare(
      `SELECT count(*)
       FROM organization_private_approval_pending_contracts_v2 AS pending
       WHERE pending.connection_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM organization_private_approval_terminal_evidence_v2 AS terminal
           WHERE terminal.approval_id = pending.approval_id
         )`,
    )
    .pluck()
    .get(connectionId) as number;
}

/** Refuses a write whose coordinates are not this control plane's. */
export function assertSlackConnectionMetadataV1(
  database: Database.Database,
  input: { readonly authority_id: string; readonly organization_id: string },
): void {
  const metadata = database
    .prepare(
      `SELECT authority_id, organization_id
       FROM organization_control_plane_metadata WHERE singleton = 1`,
    )
    .get() as { authority_id: string; organization_id: string } | undefined;
  if (
    metadata === undefined ||
    metadata.authority_id !== input.authority_id ||
    metadata.organization_id !== input.organization_id
  ) {
    throw new Error(
      "Slack connection coordinates do not match control metadata",
    );
  }
}

/**
 * Inserts one new active connection: the immutable contract and its current
 * state. The caller owns the surrounding `BEGIN IMMEDIATE` transaction and
 * must already have revoked any previously active connection.
 */
export function insertActiveSlackConnectionV1(
  database: Database.Database,
  input: {
    readonly connection: OrganizationToolConnectionContractV2;
    readonly state: OrganizationToolConnectionStateV2;
    readonly now: string;
  },
): void {
  const connectionSha256 = canonicalSha256(input.connection);
  if (
    input.state.connection_id !== input.connection.connection_id ||
    input.state.connection_contract_sha256 !== connectionSha256
  ) {
    throw new Error("Slack connection state does not bind its contract");
  }
  database
    .prepare(
      `INSERT INTO organization_tool_connection_contracts
       (connection_id, contract_json, contract_sha256, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.connection.connection_id,
      canonicalJson(input.connection),
      connectionSha256,
      input.now,
    );
  database
    .prepare(
      `INSERT INTO organization_tool_connection_current_state
       (connection_id, connection_contract_sha256, state_json, state_sha256,
        current_status, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      input.connection.connection_id,
      connectionSha256,
      canonicalJson(input.state),
      canonicalSha256(input.state),
      input.now,
    );
}
