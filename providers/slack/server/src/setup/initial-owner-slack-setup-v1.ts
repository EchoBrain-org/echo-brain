import Database from 'better-sqlite3';
import { join } from 'node:path';
import { readActiveSlackConnectionV1 } from '../organization-control-plane/persistence/sqlite-slack-active-connection-v1.js';

// R2b: remove. Kept only so the setup CLI compiles; it describes the removed channel verification.
export interface SafeSlackVerification {
  readonly workspace_id: string;
  readonly enterprise_id: string | null;
  readonly app_id: string;
  readonly bot_id: string;
  readonly bot_user_id: string;
  readonly identity_link_channel_id: string;
  readonly required_scopes: readonly string[];
  readonly identity_link_channel_access: "verified";
  readonly selected_channel_public: true;
  readonly selected_channel_active: true;
  readonly bot_membership_verified: true;
  readonly bot_access_verified: true;
  readonly verified_at: string;
}

// R2b: remove. Kept only so the setup CLI compiles.
export interface ConnectedSlack {
  readonly connection_id: string;
  readonly verification?: SafeSlackVerification;
}

// R2b: remove. The stopped-state Slack bootstrap is gone: an owner sets up Slack in the ECHO app.
export async function connectInitialOwnerSlackV1(_input: {
  readonly state_directory: string; readonly approval_channel_id: string;
  readonly connection_id?: string; readonly read_stdin: () => Promise<string>;
}): Promise<ConnectedSlack> {
  throw new Error("Slack is set up in the ECHO app; the stopped-state Slack connection is removed");
}

function readControlDatabase<T>(stateDirectory: string, read: (database: Database.Database) => T): T {
  const database = new Database(join(stateDirectory, "integrations.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

/**
 * True once the organization's Slack connection, set up in the ECHO app, is
 * active. A connection stored before in-app setup throws.
 */
export function plannedSlackConnectionIsActiveV1(
  stateDirectory: string,
  // R2b: remove. Ignored: the in-app connection has no planned id.
  _connectionId?: string,
): boolean {
  return readControlDatabase(stateDirectory, (database) => readActiveSlackConnectionV1(database) !== undefined);
}

/** Whether the initial owner has an active Slack link in the active connection's workspace. */
export function readInitialOwnerSlackSetupStatusV1(input: {
  readonly state_directory: string;
  readonly principal_id: string;
  readonly membership_id: string;
  // R2b: remove. Ignored: the in-app connection has no planned id.
  readonly connection_id?: string;
  // R2b: remove. Ignored: there is no identity-link channel.
  readonly identity_link_channel_id?: string;
}): {
  readonly identity_link_active: boolean;
  // R2b: remove. Never present: the channel verification it reported is gone.
  readonly verification?: never;
} {
  return readControlDatabase(input.state_directory, (database) => {
    const active = readActiveSlackConnectionV1(database);
    if (active === undefined) return { identity_link_active: false };
    const linked = database.prepare(
      `SELECT 1 FROM organization_external_human_link_current
        WHERE current_status = 'active' AND principal_id = ? AND membership_id = ?
          AND provider_issuer = 'https://slack.com' AND provider_tenant_kind = 'workspace'
          AND provider_tenant_id = ?
          AND COALESCE(provider_enterprise_id, '') = COALESCE(?, '')
        LIMIT 1`,
    ).get(
      input.principal_id,
      input.membership_id,
      active.connection.provider_tenant_id,
      active.connection.provider_enterprise_id,
    );
    return { identity_link_active: linked !== undefined };
  });
}
