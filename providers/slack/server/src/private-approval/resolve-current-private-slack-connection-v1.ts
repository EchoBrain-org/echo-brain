import { type ApprovalContractSha256 } from "../organization-control-plane/slack-approval-integration-v1.js";
import { validateOrganizationToolConnectionContractV2, validateOrganizationToolConnectionStateV2 } from "../organization-control-plane/application/organization-tool-connection-contracts-v2.js";
import { readActiveSlackConnectionV1, type StoredSlackConnectionV1 } from "../organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

/** The three immutable coordinates that bind an admitted runtime to one lineage. */
export interface PrivateSlackConnectionCoordinatesV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

/**
 * The minimum provider commitment a private-approval runtime may retain at
 * startup. It deliberately excludes the legacy shared-channel/reaction
 * approval binding and every credential reference.
 */
export interface CurrentPrivateSlackConnectionV1 {
  readonly connection_id: string;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly connection_state_sha256: ApprovalContractSha256;
  readonly provider_app_id: string;
  readonly provider_bot_id: string;
  readonly provider_bot_user_id: string;
  readonly provider_tenant_id: string;
  readonly provider_enterprise_id: string | null;
}

interface ConnectionRow {
  readonly contract_json: string;
  readonly contract_sha256: string;
  readonly state_json: string;
  readonly state_sha256: string;
  readonly current_status: string;
}

function parseCanonical(json: string, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (canonicalJson(value) !== json) {
    throw new Error(`${label} is not canonical`);
  }
  return value;
}

/**
 * Resolves exactly the Slack installation pinned in the onboarding manifest.
 *
 * This is intentionally a read-only startup guard. Missing state and every
 * disagreement are fatal: an admitted runtime must never discover a replacement
 * connection, infer one by tenant, or fall back to the retired shared-channel
 * approval surface.
 */
export function resolveCurrentPrivateSlackConnectionV1(
  database: Database.Database,
  configuredConnectionId: string,
  coordinates: PrivateSlackConnectionCoordinatesV1,
): CurrentPrivateSlackConnectionV1 {
  const row = database
    .prepare(
      `SELECT contract.contract_json, contract.contract_sha256,
              current_state.state_json, current_state.state_sha256,
              current_state.current_status
         FROM organization_tool_connection_contracts AS contract
         JOIN organization_tool_connection_current_state AS current_state
           ON current_state.connection_id = contract.connection_id
          AND current_state.connection_contract_sha256 = contract.contract_sha256
        WHERE contract.connection_id = ?`,
    )
    .get(configuredConnectionId) as ConnectionRow | undefined;
  if (row === undefined) {
    throw new Error("private approval runtime has no configured Slack connection");
  }

  const contract = validateOrganizationToolConnectionContractV2(
    parseCanonical(row.contract_json, "stored private Slack connection contract"),
  );
  const state = validateOrganizationToolConnectionStateV2(
    parseCanonical(row.state_json, "stored private Slack connection state"),
  );
  const contractSha = canonicalSha256(contract);
  const stateSha = canonicalSha256(state);

  if (
    row.current_status !== "active" ||
    contractSha !== row.contract_sha256 ||
    stateSha !== row.state_sha256 ||
    contract.connection_id !== configuredConnectionId ||
    state.connection_id !== contract.connection_id ||
    state.connection_contract_sha256 !== contractSha ||
    state.connection_status !== "active" ||
    contract.tool_kind !== "slack" ||
    contract.authority_id !== coordinates.authority_id ||
    contract.organization_id !== coordinates.organization_id ||
    contract.state_lineage_id !== coordinates.state_lineage_id
  ) {
    throw new Error(
      "private approval runtime configured Slack connection is missing, inactive, or drifted",
    );
  }

  return Object.freeze({
    connection_id: contract.connection_id,
    connection_contract_sha256: contractSha,
    connection_state_sha256: stateSha,
    provider_app_id: contract.provider_app_id,
    provider_bot_id: contract.provider_bot_id,
    provider_bot_user_id: contract.provider_bot_user_id,
    provider_tenant_id: contract.provider_tenant_id,
    provider_enterprise_id: contract.provider_enterprise_id,
  });
}

/** The connection approvals run on now, with the stored row a bot-token source reads. */
export interface ActivePrivateSlackConnectionV1 {
  readonly current: CurrentPrivateSlackConnectionV1;
  readonly stored: StoredSlackConnectionV1;
}

/**
 * With Nango configured, approvals follow the organization's one active
 * connection when it is a Nango connection, so an owner's install takes
 * effect without a restart. Any other state is exactly the pinned legacy
 * check above, failures included.
 */
export function resolveActivePrivateSlackConnectionV1(
  database: Database.Database,
  configuredConnectionId: string,
  coordinates: PrivateSlackConnectionCoordinatesV1,
): ActivePrivateSlackConnectionV1 {
  const active = readActiveSlackConnectionV1(database);
  if (active?.kind !== "nango") {
    const current = resolveCurrentPrivateSlackConnectionV1(database, configuredConnectionId, coordinates);
    if (active?.connection.connection_id !== current.connection_id) {
      throw new Error("private approval runtime configured Slack connection is missing, inactive, or drifted");
    }
    return Object.freeze({ current, stored: active });
  }
  const { connection } = active;
  if (
    connection.tool_kind !== "slack" ||
    connection.authority_id !== coordinates.authority_id ||
    connection.organization_id !== coordinates.organization_id ||
    connection.state_lineage_id !== coordinates.state_lineage_id
  ) {
    throw new Error("private approval runtime active Slack connection is drifted");
  }
  return Object.freeze({
    current: Object.freeze({
      connection_id: connection.connection_id,
      connection_contract_sha256: active.contract_sha256,
      connection_state_sha256: active.state_sha256,
      provider_app_id: connection.provider_app_id,
      provider_bot_id: connection.provider_bot_id,
      provider_bot_user_id: connection.provider_bot_user_id,
      provider_tenant_id: connection.provider_tenant_id,
      provider_enterprise_id: connection.provider_enterprise_id,
    }),
    stored: active,
  });
}

/**
 * The connection a new card is delivered on: an active Nango connection, else
 * the pinned one. Never throws for a missing connection; delivery then finds
 * no current target and stays pending.
 */
export function activePrivateSlackConnectionIdV1(
  database: Database.Database,
  configuredConnectionId: string,
): string {
  const active = readActiveSlackConnectionV1(database);
  return active?.kind === "nango" ? active.connection.connection_id : configuredConnectionId;
}
