import Database from 'better-sqlite3';
import { join } from 'node:path';
import { captureCommand } from '@echo-brain/organization-authority-kernel/composition/capture-stopped-state-command';
import { runSlackConnectionSetupCli } from '../organization-control-plane/composition/slack-connection-setup-cli.js';
import { SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES } from '../organization-control-plane/application/slack-integration-contracts.js';
export interface SafeSlackVerification {
  readonly workspace_id: string;
  readonly enterprise_id: string | null;
  readonly app_id: string;
  readonly bot_id: string;
  readonly bot_user_id: string;
  /** Temporary public channel used solely by initial-owner identity linking. */
  readonly identity_link_channel_id: string;
  readonly required_scopes: readonly string[];
  readonly identity_link_channel_access: "verified";
  readonly selected_channel_public: true;
  readonly selected_channel_active: true;
  readonly bot_membership_verified: true;
  readonly bot_access_verified: true;
  readonly verified_at: string;
}
export interface ConnectedSlack {
  readonly connection_id: string;
  readonly verification?: SafeSlackVerification;
}
export async function connectInitialOwnerSlackV1(input: {
  readonly state_directory: string; readonly approval_channel_id: string;
  readonly connection_id?: string; readonly read_stdin: () => Promise<string>;
}): Promise<ConnectedSlack> {
    const result = await captureCommand((stdout) =>
      runSlackConnectionSetupCli(
        [
          "--state-dir",
          input.state_directory,
          "--approval-channel-id",
          input.approval_channel_id,
          ...(input.connection_id === undefined
            ? []
            : ["--connection-id", input.connection_id]),
        ],
        { stdout, read_stdin: input.read_stdin },
      ),
    );
    for (const field of [
      "provider_tenant_id",
      "provider_app_id",
      "provider_bot_id",
      "provider_bot_user_id",
      "approval_channel_id",
      "verified_at",
    ] as const) {
      if (typeof result[field] !== "string") {
        throw new Error("Slack connection did not return safe verification details");
      }
    }
    if (
      result.provider_enterprise_id !== null &&
      typeof result.provider_enterprise_id !== "string"
    ) {
      throw new Error("Slack connection did not return safe verification details");
    }
    if (
      !Array.isArray(result.required_scopes) ||
      result.required_scopes.length !== SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES.length ||
      result.required_scopes.some(
        (scope, index) => scope !== SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES[index],
      ) ||
      result.selected_channel_public !== true ||
      result.selected_channel_active !== true ||
      result.bot_membership_verified !== true ||
      result.bot_access_verified !== true
    ) {
      throw new Error("Slack connection did not return complete channel verification");
    }
    if (input.connection_id === undefined) {
      throw new Error(
        "organization setup Slack connection requires a planned connection ID",
      );
    }
    return Object.freeze({
      connection_id: input.connection_id,
      verification: Object.freeze({
        workspace_id: result.provider_tenant_id as string,
        enterprise_id: result.provider_enterprise_id as string | null,
        app_id: result.provider_app_id as string,
        bot_id: result.provider_bot_id as string,
        bot_user_id: result.provider_bot_user_id as string,
        identity_link_channel_id: result.approval_channel_id as string,
        required_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
        identity_link_channel_access: "verified" as const,
        selected_channel_public: true,
        selected_channel_active: true,
        bot_membership_verified: true,
        bot_access_verified: true,
        verified_at: result.verified_at as string,
      }),
    });
}

export function plannedSlackConnectionIsActiveV1(stateDirectory: string, connectionId: string): boolean {
    const database = new Database(join(stateDirectory, "integrations.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return (database
        .prepare(
          "SELECT 1 FROM organization_tool_connection_current_state " +
            "WHERE connection_id = ? AND current_status = 'active' LIMIT 1",
        )
        .get(connectionId) !== undefined);
    } finally {
      database.close();
    }
}
export function readInitialOwnerSlackSetupStatusV1(input: {
  readonly state_directory: string; readonly connection_id: string; readonly principal_id: string;
  readonly membership_id: string; readonly identity_link_channel_id: string;
}): { readonly identity_link_active: boolean; readonly verification?: SafeSlackVerification } {
    const control = new Database(join(input.state_directory, "integrations.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const initialOwnerSlackIdentityLinkActive = control.prepare(
        `SELECT 1 FROM organization_external_human_link_current AS link
          JOIN organization_tool_connection_contracts AS connection
            ON connection.connection_id = ?
          JOIN organization_tool_connection_current_state AS connection_state
            ON connection_state.connection_id = connection.connection_id
          WHERE link.current_status = 'active' AND link.principal_id = ?
            AND link.membership_id = ? AND link.provider_issuer = 'https://slack.com'
            AND link.provider_tenant_id = json_extract(connection.contract_json, '$.provider_tenant_id')
            AND COALESCE(link.provider_enterprise_id, '') =
                COALESCE(json_extract(connection.contract_json, '$.provider_enterprise_id'), '')
            AND connection_state.current_status = 'active'
          LIMIT 1`,
      ).get(
        input.connection_id,
        input.principal_id,
        input.membership_id,
      ) !== undefined;
      const slackProofRow = control.prepare(
        `SELECT json_extract(connection.contract_json, '$.provider_tenant_id') AS workspace_id,
                json_extract(connection.contract_json, '$.provider_enterprise_id') AS enterprise_id,
                json_extract(connection.contract_json, '$.provider_app_id') AS app_id,
                json_extract(connection.contract_json, '$.provider_bot_id') AS bot_id,
                json_extract(connection.contract_json, '$.provider_bot_user_id') AS bot_user_id,
                json_extract(state.state_json, '$.observed_granted_scopes') AS observed_scopes_json,
                json_extract(state.state_json, '$.verified_at') AS verified_at
           FROM organization_tool_connection_contracts AS connection
           JOIN organization_tool_connection_current_state AS state
             ON state.connection_id = connection.connection_id
            AND state.connection_contract_sha256 = connection.contract_sha256
          WHERE connection.connection_id = ? AND state.current_status = 'active'
          LIMIT 1`,
      ).get(input.connection_id) as
        | {
            readonly workspace_id: unknown;
            readonly enterprise_id: unknown;
            readonly app_id: unknown;
            readonly bot_id: unknown;
            readonly bot_user_id: unknown;
            readonly observed_scopes_json: unknown;
            readonly verified_at: unknown;
          }
        | undefined;
      let requiredScopesObserved = false;
      try {
        const scopes = JSON.parse(
          typeof slackProofRow?.observed_scopes_json === "string"
            ? slackProofRow.observed_scopes_json
            : "null",
        ) as unknown;
        requiredScopesObserved =
          Array.isArray(scopes) &&
          SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES.every((scope) =>
            scopes.includes(scope),
          );
      } catch {}
      const slackVerification =
        slackProofRow !== undefined &&
        requiredScopesObserved &&
        typeof slackProofRow.workspace_id === "string" &&
        (slackProofRow.enterprise_id === null ||
          typeof slackProofRow.enterprise_id === "string") &&
        typeof slackProofRow.app_id === "string" &&
        typeof slackProofRow.bot_id === "string" &&
        typeof slackProofRow.bot_user_id === "string" &&
        typeof slackProofRow.verified_at === "string"
          ? Object.freeze({
              workspace_id: slackProofRow.workspace_id,
              enterprise_id: slackProofRow.enterprise_id,
              app_id: slackProofRow.app_id,
              bot_id: slackProofRow.bot_id,
              bot_user_id: slackProofRow.bot_user_id,
              identity_link_channel_id: input.identity_link_channel_id,
              required_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
              identity_link_channel_access: "verified" as const,
              selected_channel_public: true as const,
              selected_channel_active: true as const,
              bot_membership_verified: true as const,
              bot_access_verified: true as const,
              verified_at: slackProofRow.verified_at,
            })
          : undefined;

      return { identity_link_active: initialOwnerSlackIdentityLinkActive, ...(slackVerification === undefined ? {} : { verification: slackVerification }) };
    } finally { control.close(); }
}
