import { JiraProjectMappingStoreV1 } from '@echo-brain/provider-jira/jira-project-mapping-store-v1';
import type { PersonContextProjectAuthorizationV1, PersonContextProjectNamesV1, PersonLiveConnectorDefinitionV1 } from '../application/ports/person-context-live-runtime-v1.js';
import { JIRA_LIVE_CONNECTOR_V1, JIRA_PROJECTS_LIVE_CONNECTOR_V1, personToolLiveConnectorsV1 } from './person-live-connector-registry-v1.js';
import { createJiraPersonConnectionHttpApplicationV1 } from '@echo-brain/provider-jira/jira-person-connection-http-application-v1';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { personToolAuthenticationV1 } from './person-tool-authentication-v1.js';
import { JiraConnectionStoreV1 } from '@echo-brain/provider-jira/jira-connection-store-v1';
import { createJiraNangoV1, type JiraNangoV1 } from '@echo-brain/provider-jira/jira-nango-v1';
import { createJiraPersonConnectionV1, type JiraPersonConnectionV1 } from '@echo-brain/provider-jira/jira-person-connection-v1';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import type { PersonIdentitySessionApplication } from '../application/person-identity-sessions.js';
import type { TicketOwnerAccountsV1 } from '../application/ports/ticket-owner-accounts-v1.js';
import type { OrganizationPersonToolV4 } from '@echo-brain/organization-api';

/** Explicit selecting configuration, absent until enabled by an operator. */
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
  readonly connection_http: ProviderHttpApplicationV1;
  /** Assignee accounts for matching impact owners, read with the caller's own connection. */
  readonly owners: TicketOwnerAccountsV1;
  tools(access_token: string): Promise<readonly OrganizationPersonToolV4[]>;
  close(): void;
}

/** Jira construction is selected here. Shared Authority composition sees only an optional application. */
export function openJiraPersonLiveRuntimeV1(options: {
  readonly state_directory: string;
  readonly sessions: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>;
  readonly configuration: JiraPersonLiveConfigurationV1;
  readonly seams?: JiraPersonLiveRuntimeSeamsV1;
  readonly authorize_project?: PersonContextProjectAuthorizationV1;
  /** Lets a Jira project's container item name the ECHO projects mapped to it (research tool contract v1). */
  readonly project_names?: PersonContextProjectNamesV1;
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
    const store = new JiraConnectionStoreV1(database);
    const cloud_id = options.configuration.cloud_id;
    const application = createJiraPersonConnectionV1({
      store,
      project_mappings: new JiraProjectMappingStoreV1(database),
      ...(options.authorize_project === undefined ? {} : { authorize_project: options.authorize_project }),
      ...(options.project_names === undefined ? {} : { project_names: options.project_names }),
      nango: options.seams?.nango ?? createJiraNangoV1({ integration_id: options.configuration.integration_id, authorization: options.configuration.nango_authorization, fetch: transport }),
      cloud_id,
      fetch: transport,
      authenticate: personToolAuthenticationV1(options.sessions),
    });
    const owners: TicketOwnerAccountsV1 = Object.freeze({
      tool_id: 'jira', external_scope_id: cloud_id,
      async assignees(input: Parameters<TicketOwnerAccountsV1['assignees']>[0]): Promise<ReadonlyMap<string, string>> {
        // A failed read, including a malformed page, matches no one.
        try { return await application.assigneeAccounts(input); } catch { return new Map(); }
      },
      people: (accountId: string) => store.peopleForSubject(cloud_id, accountId),
    });
    return Object.freeze({
      application, connection_http: createJiraPersonConnectionHttpApplicationV1(application), owners,
      async tools(access_token: string): Promise<readonly OrganizationPersonToolV4[]> {
        return Object.freeze([application.tool({ access_token })]);
      },
      close() { if (owned) database.close(); },
    });
  } catch (error) { if (owned) database.close(); throw error; }
}

/** Jira's live connectors (research tool contract v1): its issues and, for the V8 answer, its projects, over one runtime. */
export function jiraPersonLiveConnectorsV1(open: (...parameters: Parameters<PersonLiveConnectorDefinitionV1['open']>) => OpenedJiraPersonLiveRuntimeV1): readonly PersonLiveConnectorDefinitionV1[] {
  return personToolLiveConnectorsV1({ items: JIRA_LIVE_CONNECTOR_V1, containers: JIRA_PROJECTS_LIVE_CONNECTOR_V1 }, open);
}
