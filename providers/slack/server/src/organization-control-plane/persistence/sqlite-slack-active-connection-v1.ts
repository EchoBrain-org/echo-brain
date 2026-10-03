import { canonicalJson, canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import { validateOrganizationToolConnectionContractV2, validateOrganizationToolConnectionStateV2, type OrganizationToolConnectionContractV2, type OrganizationToolConnectionStateV2 } from "../application/organization-tool-connection-contracts-v2.js";
import type Database from "better-sqlite3";

/** The public configuration every organization Slack connection commits to: the ECHO app recipe. */
export function slackNangoAppPublicConfigurationSha256V1(): `sha256:${string}` {
  return canonicalSha256({
    kind: "echo-slack-nango-app-public-configuration-v1",
    recipe_version: 1,
  });
}

/** The organization's one active connection: the ECHO app installed through Nango. */
export interface StoredSlackConnectionV1 {
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

/** The three immutable coordinates that bind a runtime to one lineage. */
export interface SlackConnectionCoordinatesV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

/**
 * Reads the one active connection after proving its digest chain. A
 * connection stored by the removed bot-token-and-channel setup commits to
 * another configuration: it is refused, never served. With `coordinates`, a
 * connection of another Authority, organization or lineage is refused too.
 */
export function readActiveSlackConnectionV1(
  database: Database.Database,
  coordinates?: SlackConnectionCoordinatesV1,
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
  const body = parseCanonical(row.contract_json);
  if (
    typeof body === "object" && body !== null &&
    (body as { readonly public_connection_configuration_sha256?: unknown })
      .public_connection_configuration_sha256 !== slackNangoAppPublicConfigurationSha256V1()
  ) {
    throw new Error("stored Slack connection predates in-app setup; install this release's host tooling, then run replace-rehearsal");
  }
  const connection = validateOrganizationToolConnectionContractV2(body);
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
  if (
    coordinates !== undefined &&
    (connection.authority_id !== coordinates.authority_id ||
      connection.organization_id !== coordinates.organization_id ||
      connection.state_lineage_id !== coordinates.state_lineage_id)
  ) {
    throw new Error("stored Slack connection is drifted");
  }
  return Object.freeze({
    connection,
    contract_sha256: row.contract_sha256,
    state,
    state_sha256: row.state_sha256,
  });
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
 * must already have proven that no connection is active.
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
