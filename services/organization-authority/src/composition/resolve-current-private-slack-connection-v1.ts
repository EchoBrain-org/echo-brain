import {
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
  type ApprovalContractSha256,
} from "@echo-brain/organization-control-plane/slack-approval-runtime-v1";
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

/** The three immutable coordinates that bind a live runtime to one lineage. */
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
 * disagreement are fatal: a live runtime must never discover a replacement
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
    throw new Error("private live runtime has no configured Slack connection");
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
      "private live runtime configured Slack connection is missing, inactive, or drifted",
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
