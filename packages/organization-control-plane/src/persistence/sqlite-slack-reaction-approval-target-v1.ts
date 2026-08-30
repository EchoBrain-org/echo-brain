import {
  validateExternalHumanIdentityLinkContractV2,
  validateOrganizationToolConnectionContractV2,
} from "../application/person-slack-reaction-approval-contracts-v2.js";
import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import type { VerifiedOrganizationControlStateV1 } from "./verified-organization-control-state-v1.js";
import type Database from "better-sqlite3";

const APPROVE_REACTION = "white_check_mark";
const REJECT_REACTION = "x";

export interface SlackReactionApprovalTargetSelectionV1 {
  readonly connection_id: string;
  readonly approval_channel_id: string;
}

export interface SelectedOwnerSlackReactionApprovalTargetV1 {
  readonly connection_id: string;
  readonly external_identity_link_id: string;
}

function parseCanonical(json: string): unknown {
  const value = JSON.parse(json) as unknown;
  if (canonicalJson(value) !== json) {
    throw new Error(
      "approval activation found non-canonical stored state",
    );
  }
  return value;
}

function slackConnectionConfigurationSha256(approvalChannelId: string) {
  return canonicalSha256({
    approval_adapter_id: "slack-reactions",
    approval_channel_id: approvalChannelId,
    approve_reaction: APPROVE_REACTION,
    kind: "echo-clean-slack-connection-public-configuration-v1",
    reject_reaction: REJECT_REACTION,
  });
}

/** Revalidates the exact current owner link against the one active Slack connection. */
export function selectCurrentOwnerSlackReactionApprovalTargetV1(
  database: Database.Database,
  state: VerifiedOrganizationControlStateV1,
  flags: SlackReactionApprovalTargetSelectionV1,
  owner: { readonly principal_id: string; readonly membership_id: string },
): SelectedOwnerSlackReactionApprovalTargetV1 {
  const connectionRow = database
    .prepare(
      `SELECT contract.contract_json, contract.contract_sha256
       FROM organization_tool_connection_contracts AS contract
       JOIN organization_tool_connection_current_state AS current_state
         ON current_state.connection_id = contract.connection_id
        AND current_state.connection_contract_sha256 = contract.contract_sha256
       WHERE contract.connection_id = ? AND current_state.current_status = 'active'`,
    )
    .get(flags.connection_id) as
    | { readonly contract_json: string; readonly contract_sha256: string }
    | undefined;
  if (connectionRow === undefined) {
    throw new Error(
      "approval activation requires the active Slack connection",
    );
  }
  const connection = validateOrganizationToolConnectionContractV2(
    parseCanonical(connectionRow.contract_json),
  );
  if (
    canonicalSha256(connection) !== connectionRow.contract_sha256 ||
    connection.authority_id !== state.authority_id ||
    connection.organization_id !== state.organization_id ||
    connection.state_lineage_id !== state.state_lineage_id ||
    connection.connection_id !== flags.connection_id ||
    connection.tool_kind !== "slack" ||
    connection.public_connection_configuration_sha256 !==
      slackConnectionConfigurationSha256(flags.approval_channel_id)
  ) {
    throw new Error(
      "approval activation connection is not the selected Slack surface",
    );
  }
  const links = database
    .prepare(
      `SELECT contract.contract_json, contract.contract_sha256
       FROM organization_external_human_link_current AS current_link
       JOIN organization_external_human_link_contracts AS contract
         ON contract.external_identity_link_id = current_link.external_identity_link_id
        AND contract.contract_sha256 = current_link.contract_sha256
       WHERE current_link.current_status = 'active'
         AND current_link.principal_id = ?
         AND current_link.membership_id = ?
         AND current_link.provider_issuer = 'https://slack.com'
         AND current_link.provider_tenant_kind = 'workspace'
         AND current_link.provider_tenant_id = ?
         AND (current_link.provider_enterprise_id IS ?
              OR current_link.provider_enterprise_id = ?)
       ORDER BY current_link.external_identity_link_id ASC`,
    )
    .all(
      owner.principal_id,
      owner.membership_id,
      connection.provider_tenant_id,
      connection.provider_enterprise_id,
      connection.provider_enterprise_id,
    ) as Array<{
    readonly contract_json: string;
    readonly contract_sha256: string;
  }>;
  if (links.length !== 1 || links[0] === undefined) {
    throw new Error(
      "reaction approval activation requires one current owner Slack identity link",
    );
  }
  const link = validateExternalHumanIdentityLinkContractV2(
    parseCanonical(links[0].contract_json),
  );
  if (
    canonicalSha256(link) !== links[0].contract_sha256 ||
    link.authority_id !== state.authority_id ||
    link.organization_id !== state.organization_id ||
    link.state_lineage_id !== state.state_lineage_id ||
    link.principal_id !== owner.principal_id ||
    link.membership_id !== owner.membership_id ||
    link.membership_type !== "owner" ||
    link.provider_tenant_id !== connection.provider_tenant_id ||
    link.provider_enterprise_id !== connection.provider_enterprise_id
  ) {
    throw new Error(
      "Slack-reaction approval activation owner Slack identity link is invalid",
    );
  }
  return Object.freeze({
    connection_id: connection.connection_id,
    external_identity_link_id: link.external_identity_link_id,
  });
}
