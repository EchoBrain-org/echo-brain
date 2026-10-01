import { type ApprovalContractSha256 } from "../organization-control-plane/slack-approval-integration-v1.js";
import { readActiveSlackConnectionV1, type StoredSlackConnectionV1 } from "../organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import type Database from "better-sqlite3";

/** The three immutable coordinates that bind an admitted runtime to one lineage. */
export interface PrivateSlackConnectionCoordinatesV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

/**
 * The minimum provider commitment a private-approval runtime retains: the
 * connection's identity and digests, never a credential reference.
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

/** The connection approvals run on now, with the stored row a bot-token source reads. */
export interface ActivePrivateSlackConnectionV1 {
  readonly current: CurrentPrivateSlackConnectionV1;
  readonly stored: StoredSlackConnectionV1;
}

/**
 * Approvals follow the organization's one active connection, the ECHO app
 * installed through Nango, read at each use. A missing connection, one in
 * another lineage, and one stored before in-app setup all fail closed.
 */
export function resolveActivePrivateSlackConnectionV1(
  database: Database.Database,
  coordinates: PrivateSlackConnectionCoordinatesV1,
): ActivePrivateSlackConnectionV1 {
  const active = readActiveSlackConnectionV1(database);
  if (active === undefined) {
    throw new Error("private approval runtime has no active Slack connection");
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
