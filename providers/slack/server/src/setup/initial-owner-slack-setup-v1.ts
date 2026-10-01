import Database from 'better-sqlite3';
import { join } from 'node:path';
import { readActiveSlackConnectionV1 } from '../organization-control-plane/persistence/sqlite-slack-active-connection-v1.js';

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
export function plannedSlackConnectionIsActiveV1(stateDirectory: string): boolean {
  return readControlDatabase(stateDirectory, (database) => readActiveSlackConnectionV1(database) !== undefined);
}

/** Whether the initial owner has an active Slack link in the active connection's workspace. */
export function readInitialOwnerSlackSetupStatusV1(input: {
  readonly state_directory: string;
  readonly principal_id: string;
  readonly membership_id: string;
}): { readonly identity_link_active: boolean } {
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
