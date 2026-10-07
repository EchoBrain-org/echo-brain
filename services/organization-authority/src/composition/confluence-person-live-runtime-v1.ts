import { ConfluenceProjectMappingStoreV1 } from '@echo-brain/provider-confluence/confluence-project-mapping-store-v1';
import type { PersonPageProjectAuthorizationV1 } from '../application/ports/person-page-live-runtime-v1.js';
import { createConfluencePersonConnectionHttpApplicationV1 } from '@echo-brain/provider-confluence/confluence-person-connection-http-application-v1';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { personToolAuthenticationV1 } from './person-tool-authentication-v1.js';
import { ConfluenceConnectionStoreV1 } from '@echo-brain/provider-confluence/confluence-connection-store-v1';
import { createConfluenceNangoV1, type ConfluenceNangoV1 } from '@echo-brain/provider-confluence/confluence-nango-v1';
import { createConfluencePersonConnectionV1, type ConfluencePersonConnectionV1 } from '@echo-brain/provider-confluence/confluence-person-connection-v1';
import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { bindConfluencePersonLiveStateV1 } from './confluence-person-live-state-v1.js';
import { assertPrivatePersonProviderDatabaseV1 } from './person-provider-state-v1.js';
import type { PersonIdentitySessionApplication } from '../application/person-identity-sessions.js';
import type { OrganizationPersonToolV4 } from '@echo-brain/organization-api';

/** ADR-0026 permits person-bound live reads; runtime selection remains explicit. */
export const CONFLUENCE_PERSON_LIVE_RELEASE_APPROVED_V1 = true;

/** Explicit selecting configuration, absent until enabled by an operator. */
export interface ConfluencePersonLiveConfigurationV1 {
  readonly enabled: true;
  readonly cloud_id: string;
  readonly integration_id: string;
  readonly nango_authorization: () => string;
}
export interface ConfluencePersonLiveRuntimeSeamsV1 {
  readonly database?: Database.Database;
  readonly nango?: ConfluenceNangoV1;
  readonly fetch?: typeof fetch;
}
export interface OpenedConfluencePersonLiveRuntimeV1 {
  readonly application: ConfluencePersonConnectionV1;
  readonly connection_http: ProviderHttpApplicationV1;
  tools(access_token: string): Promise<readonly OrganizationPersonToolV4[]>;
  close(): void;
}

/** Confluence construction is selected here. Shared Authority composition sees only an optional application. */
export function openConfluencePersonLiveRuntimeV1(options: {
  readonly state_directory: string;
  readonly sessions: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>;
  readonly configuration: ConfluencePersonLiveConfigurationV1;
  readonly seams?: ConfluencePersonLiveRuntimeSeamsV1;
  readonly authorize_project?: PersonPageProjectAuthorizationV1;
}): OpenedConfluencePersonLiveRuntimeV1 {
  if (options.configuration.enabled !== true) throw new Error('Confluence live evidence is not enabled');
  const owned = options.seams?.database === undefined;
  const databasePath = join(options.state_directory, 'confluence-person-connections.sqlite');
  if (owned) assertPrivatePersonProviderDatabaseV1(databasePath);
  const database = options.seams?.database ?? new Database(databasePath);
  try {
    if (owned) chmodSync(databasePath, 0o600);
    if (owned) bindConfluencePersonLiveStateV1({
      database,
      state_directory: options.state_directory,
      cloud_id: options.configuration.cloud_id,
      integration_id: options.configuration.integration_id,
    });
    if (database.inTransaction) throw new Error('Confluence connection store must own its transaction boundary');
    database.pragma('busy_timeout = 5000');
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    const transport = options.seams?.fetch ?? fetch;
    const application = createConfluencePersonConnectionV1({
      store: new ConfluenceConnectionStoreV1(database),
      project_mappings: new ConfluenceProjectMappingStoreV1(database),
      ...(options.authorize_project === undefined ? {} : { authorize_project: options.authorize_project }),
      nango: options.seams?.nango ?? createConfluenceNangoV1({ integration_id: options.configuration.integration_id, authorization: options.configuration.nango_authorization, fetch: transport }),
      cloud_id: options.configuration.cloud_id,
      fetch: transport,
      authenticate: personToolAuthenticationV1(options.sessions),
    });
    return Object.freeze({
      application, connection_http: createConfluencePersonConnectionHttpApplicationV1(application),
      async tools(access_token: string): Promise<readonly OrganizationPersonToolV4[]> {
        return Object.freeze([application.tool({ access_token })]);
      },
      close() { if (owned) database.close(); },
    });
  } catch (error) { if (owned) database.close(); throw error; }
}
