import { JiraProjectMappingStoreV1 } from '@echo-brain/provider-jira/jira-project-mapping-store-v1';
import type { PersonLiveConnectorDefinitionV1 } from '../application/ports/person-context-live-runtime-v1.js';
import {
  JIRA_LIVE_CONNECTOR_V1, JIRA_PROJECTS_LIVE_CONNECTOR_V1, openPersonToolLiveRuntimeV1, personToolLiveConnectorsV1,
  type PersonToolLiveConfigurationV1, type PersonToolLiveOpenOptionsV1, type PersonToolLiveRuntimeSeamsV1,
} from './person-live-connector-registry-v1.js';
import { createJiraPersonConnectionHttpApplicationV1 } from '@echo-brain/provider-jira/jira-person-connection-http-application-v1';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { JiraConnectionStoreV1 } from '@echo-brain/provider-jira/jira-connection-store-v1';
import { createJiraNangoV1, type JiraNangoV1 } from '@echo-brain/provider-jira/jira-nango-v1';
import { createJiraPersonConnectionV1, type JiraPersonConnectionV1 } from '@echo-brain/provider-jira/jira-person-connection-v1';
import type { TicketOwnerAccountsV1 } from '../application/ports/ticket-owner-accounts-v1.js';
import type { PersonTicketCheckV1 } from '../application/ports/person-source-check-v1.js';
import type { OrganizationPersonToolV4 } from '@echo-brain/organization-api';

/** Explicit selecting configuration, absent until enabled by an operator. */
export type JiraPersonLiveConfigurationV1 = PersonToolLiveConfigurationV1;
export type JiraPersonLiveRuntimeSeamsV1 = PersonToolLiveRuntimeSeamsV1<JiraNangoV1>;
export interface OpenedJiraPersonLiveRuntimeV1 {
  readonly application: JiraPersonConnectionV1;
  readonly connection_http: ProviderHttpApplicationV1;
  /** Assignee accounts for matching impact owners, read with the caller's own connection. */
  readonly owners: TicketOwnerAccountsV1;
  /** The Ask source check's ticket reads (ADR-0047), with the caller's own connection. */
  readonly checks: PersonTicketCheckV1;
  tools(access_token: string): Promise<readonly OrganizationPersonToolV4[]>;
  close(): void;
}

/** Jira construction is selected here. Shared Authority composition sees only an optional application. */
export function openJiraPersonLiveRuntimeV1(options: PersonToolLiveOpenOptionsV1<JiraNangoV1>): OpenedJiraPersonLiveRuntimeV1 {
  // Private like every person provider's file; unlike Confluence's, it carries no lineage binding.
  return openPersonToolLiveRuntimeV1(options, { name: 'Jira', file: 'jira-person-connections.sqlite', build(database, connection) {
    const store = new JiraConnectionStoreV1(database);
    const cloud_id = options.configuration.cloud_id;
    const application = createJiraPersonConnectionV1({ store, project_mappings: new JiraProjectMappingStoreV1(database), ...connection(createJiraNangoV1) });
    const owners: TicketOwnerAccountsV1 = Object.freeze({
      tool_id: 'jira', external_scope_id: cloud_id,
      async assignees(input: Parameters<TicketOwnerAccountsV1['assignees']>[0]): Promise<ReadonlyMap<string, string>> {
        // A failed read, including a malformed page, matches no one.
        try { return await application.assigneeAccounts(input); } catch { return new Map(); }
      },
      people: (accountId: string) => store.peopleForSubject(cloud_id, accountId),
    });
    // A failed read rejects, so the check answers its tickets unknown.
    const checks: PersonTicketCheckV1 = Object.freeze({ kind: 'ticket', tool_id: 'jira', external_scope_id: cloud_id,
      readable: (input: Parameters<PersonTicketCheckV1['readable']>[0]) => application.readableTickets(input) });
    return { application, connection_http: createJiraPersonConnectionHttpApplicationV1(application), owners, checks };
  } });
}

/** Jira's live connectors (research tool contract v1): its issues and, for the V8 answer, its projects, over one runtime. */
export function jiraPersonLiveConnectorsV1(open: (...parameters: Parameters<PersonLiveConnectorDefinitionV1['open']>) => OpenedJiraPersonLiveRuntimeV1): readonly PersonLiveConnectorDefinitionV1[] {
  return personToolLiveConnectorsV1({ items: JIRA_LIVE_CONNECTOR_V1, containers: JIRA_PROJECTS_LIVE_CONNECTOR_V1 }, open);
}
