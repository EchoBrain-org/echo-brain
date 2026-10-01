import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { JiraConnectionStoreV1 } from '@echo-brain/provider-jira/jira-connection-store-v1';
import { createJiraNangoV1, type JiraNangoV1 } from '@echo-brain/provider-jira/jira-nango-v1';
import { createJiraPersonConnectionV1, type JiraPersonConnectionV1 } from '@echo-brain/provider-jira/jira-person-connection-v1';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import type { PersonIdentitySessionApplication } from '../application/person-identity-sessions.js';

/** Remains false while ADR-0025 is proposed. Recording acceptance requires a reviewed change. */
export const JIRA_PERSON_LIVE_RELEASE_APPROVED_V1 = false;

/** Explicit selecting configuration, absent until ADR-0025 is accepted and enabled by an operator. */
export interface JiraPersonLiveConfigurationV1 {
  readonly enabled: true;
  readonly cloud_id: string;
  readonly integration_id: string;
  readonly nango_authorization: () => string;
}
export interface JiraPersonLiveRuntimeSeamsV1 {
  readonly database?: Database.Database;
  readonly nango?: JiraNangoV1;
  readonly fetch?: typeof fetch;
}
export interface OpenedJiraPersonLiveRuntimeV1 {
  readonly application: JiraPersonConnectionV1;
  close(): void;
}

/** Jira construction is selected here. Shared Authority composition sees only an optional application. */
export function openJiraPersonLiveRuntimeV1(options: {
  readonly state_directory: string;
  readonly sessions: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>;
  readonly configuration: JiraPersonLiveConfigurationV1;
  readonly seams?: JiraPersonLiveRuntimeSeamsV1;
}): OpenedJiraPersonLiveRuntimeV1 {
  if (options.configuration.enabled !== true) throw new Error('Jira live evidence is not enabled');
  const owned = options.seams?.database === undefined;
  const database = options.seams?.database ?? new Database(join(options.state_directory, 'jira-person-connections.sqlite'));
  try {
    if (database.inTransaction) throw new Error('Jira connection store must own its transaction boundary');
    database.pragma('busy_timeout = 5000');
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    const transport = options.seams?.fetch ?? fetch;
    const application = createJiraPersonConnectionV1({
      store: new JiraConnectionStoreV1(database),
      nango: options.seams?.nango ?? createJiraNangoV1({ integration_id: options.configuration.integration_id, authorization: options.configuration.nango_authorization, fetch: transport }),
      cloud_id: options.configuration.cloud_id,
      fetch: transport,
      authenticate(access_token) {
        const authorization = options.sessions.authenticateAccess({ access_token });
        // checked_at changes on every lookup. Pin the actual session and membership state instead.
        return Object.freeze({
          organization_id: authorization.organization_id,
          principal_id: authorization.principal_id,
          membership_id: authorization.membership_id,
          authorization_sha256: canonicalSha256({
            identity_binding_id: authorization.identity_binding_id,
            session_family_id: authorization.session_family_id,
            access_credential_sha256: authorization.access_credential_sha256,
            person_state_sha256: authorization.person_state_sha256,
            session_state_sha256: authorization.session_state_sha256,
          }),
        });
      },
    });
    return Object.freeze({ application, close() { if (owned) database.close(); } });
  } catch (error) { if (owned) database.close(); throw error; }
}
