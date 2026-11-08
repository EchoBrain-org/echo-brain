import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { OrganizationPersonToolV4, PersonToolContainerCitationV1 } from '@echo-brain/organization-api';
import type { EvidenceSourceCapabilitiesV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import type { PersonIdentitySessionApplication } from '../application/person-identity-sessions.js';
import type {
  OpenedPersonLiveConnectorV1, PersonContextLiveApplicationV1, PersonContextProjectAuthorizationV1, PersonContextProjectNamesV1, PersonLiveConnectorDefinitionV1,
} from '../application/ports/person-context-live-runtime-v1.js';
import { openPersonProviderDatabaseV1 } from './person-provider-state-v1.js';
import { personToolAuthenticationV1 } from './person-tool-authentication-v1.js';

/**
 * What each connector's sources can do (research tool contract v1), beside their descriptors. Each reader applies
 * exactly the dates its source declares, and a window on any of them where `any_date` says so; the registry's test holds
 * every reader to its declaration.
 */
export const JIRA_ISSUE_CAPABILITIES_V1: EvidenceSourceCapabilitiesV1 = Object.freeze({
  filters: Object.freeze({}),
  dates: Object.freeze({
    created: 'when the issue was created; every issue has it',
    updated: 'when the issue last changed; every issue has it',
    due: 'when the issue is due; only issues with a due date have it',
  }),
  any_date: true,
  links: Object.freeze([]),
});
export const CONFLUENCE_PAGE_CAPABILITIES_V1: EvidenceSourceCapabilitiesV1 = Object.freeze({
  filters: Object.freeze({}),
  dates: Object.freeze({
    created: 'when the page was created; every page has it',
    updated: 'when the page was last edited; every page has it',
  }),
  any_date: true,
  links: Object.freeze([]),
});
/** Jira projects and Confluence spaces are listed and searched by key and name: no filters, dates or links. */
const TOOL_CONTAINER_CAPABILITIES_V1: EvidenceSourceCapabilitiesV1 = Object.freeze({
  filters: Object.freeze({}), dates: Object.freeze({}), any_date: false, links: Object.freeze([]),
});

/** Descriptions say what a source holds; its capabilities say how it filters (research tool contract v1). */
export const JIRA_LIVE_CONNECTOR_V1 = Object.freeze({
  descriptor: Object.freeze({ source_id: 'jira', kind: 'ticket' as const, selector: 'tickets',
    description: "Jira issues the asker can see with their own Jira account: each issue's key, title, status, assignee and due date, its description, and the issues linked to it.",
    metadata_only_list: true, tool_id: 'jira', capabilities: JIRA_ISSUE_CAPABILITIES_V1 }),
  scopes: Object.freeze(['global', 'project'] as const),
});
export const CONFLUENCE_LIVE_CONNECTOR_V1 = Object.freeze({
  descriptor: Object.freeze({ source_id: 'confluence', kind: 'page' as const, selector: 'pages',
    description: "Confluence pages the asker can see with their own Confluence account: each page's title and status, and its text section by section.",
    metadata_only_list: true, tool_id: 'confluence', capabilities: CONFLUENCE_PAGE_CAPABILITIES_V1 }),
  scopes: Object.freeze(['global', 'project'] as const),
});

/** A connected tool's containers (research tool contract v1), which only the V8 answer can cite. */
function toolContainerConnectorV1(source_id: string, tool_id: string, description: string) {
  return Object.freeze({
    descriptor: Object.freeze({ source_id, kind: 'tool_container' as const, selector: source_id, tool_id, metadata_only_list: false, description, capabilities: TOOL_CONTAINER_CAPABILITIES_V1 }),
    scopes: Object.freeze(['global', 'project'] as const),
  });
}
export const JIRA_PROJECTS_LIVE_CONNECTOR_V1 = toolContainerConnectorV1('jira_projects', 'jira',
  "Jira projects the asker can see with their own Jira account: each project's key, name and link, and the ECHO projects mapped to it.");
export const CONFLUENCE_SPACES_LIVE_CONNECTOR_V1 = toolContainerConnectorV1('confluence_spaces', 'confluence',
  "Confluence spaces the asker can see with their own Confluence account: each space's key, name and link, and the ECHO projects mapped to it.");

type OpenParametersV1 = Parameters<PersonLiveConnectorDefinitionV1['open']>;
/**
 * One runtime behind a tool's registrations (research tool contract v1): its items and its containers. The first
 * registration to open it opens it, each registration gets its own close, and the last to close closes it. Every
 * registration must open with the same authentication, project grants and project names.
 */
function sharePersonLiveRuntimeV1<R extends { close(): void }>(open: (...parameters: OpenParametersV1) => R): (...parameters: OpenParametersV1) => { readonly runtime: R; close(): void } {
  let shared: { readonly runtime: R; readonly parameters: OpenParametersV1; holders: number } | undefined;
  return (...parameters) => {
    if (shared !== undefined) {
      const opened = shared.parameters;
      for (let index = 0; index < Math.max(parameters.length, opened.length); index += 1) {
        if (parameters[index] !== opened[index]) throw new Error('Live connectors sharing a runtime must open with the same authority');
      }
    }
    const current = shared ??= { runtime: open(...parameters), parameters, holders: 0 };
    current.holders += 1;
    let closed = false;
    return Object.freeze({ runtime: current.runtime, close() {
      if (closed) return;
      closed = true;
      current.holders -= 1;
      if (current.holders > 0) return;
      if (shared === current) shared = undefined;
      current.runtime.close();
    } });
  };
}

/** A connected tool's runtime: its connection, which reads its items and containers, its routes and the person's link to it. */
type PersonToolLiveRuntimeV1 = Pick<OpenedPersonLiveConnectorV1, 'owners' | 'checks' | 'close'> & Required<Pick<OpenedPersonLiveConnectorV1, 'connection_http' | 'tools'>> & {
  readonly application: OpenedPersonLiveConnectorV1['application'] & { containerSource: PersonContextLiveApplicationV1<PersonToolContainerCitationV1>['source'] };
};

/**
 * A tool's live connectors (research tool contract v1): its items and, for the V8 answer, its containers, over one runtime
 * that `open` opens. The tool, its connection routes, its assignee accounts and its Ask source checks are the items
 * connector's alone, so the person's tools and routes list each once.
 */
export function personToolLiveConnectorsV1<R extends PersonToolLiveRuntimeV1>(connectors: {
  readonly items: Omit<PersonLiveConnectorDefinitionV1, 'open'>; readonly containers: Omit<PersonLiveConnectorDefinitionV1, 'open'>;
}, open: (...parameters: OpenParametersV1) => R): readonly PersonLiveConnectorDefinitionV1[] {
  const share = sharePersonLiveRuntimeV1(open);
  return Object.freeze([
    Object.freeze({ ...connectors.items, open: (...parameters: OpenParametersV1) => {
      const { runtime, close } = share(...parameters);
      return Object.freeze({ application: runtime.application, connection_http: runtime.connection_http, ...(runtime.owners === undefined ? {} : { owners: runtime.owners }),
        ...(runtime.checks === undefined ? {} : { checks: runtime.checks }),
        tools: (access_token: string) => runtime.tools(access_token), close });
    } }),
    Object.freeze({ ...connectors.containers, open: (...parameters: OpenParametersV1) => {
      const { runtime, close } = share(...parameters);
      return Object.freeze({ application: Object.freeze({ source: (input: Parameters<R['application']['containerSource']>[0]) => runtime.application.containerSource(input) }), close });
    } }),
  ]);
}

/** A connected tool's explicit selecting configuration (Jira, Confluence), absent until enabled by an operator. */
export interface PersonToolLiveConfigurationV1 {
  readonly enabled: true;
  readonly cloud_id: string;
  readonly integration_id: string;
  readonly nango_authorization: () => string;
}
/** What tests and the staging rehearsal supply in place of the tool's own database, Nango client and fetch. */
export interface PersonToolLiveRuntimeSeamsV1<N> {
  readonly database?: Database.Database;
  readonly nango?: N;
  readonly fetch?: typeof fetch;
}
export interface PersonToolLiveOpenOptionsV1<N> {
  readonly state_directory: string;
  readonly sessions: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>;
  readonly configuration: PersonToolLiveConfigurationV1;
  readonly seams?: PersonToolLiveRuntimeSeamsV1<N>;
  readonly authorize_project?: PersonContextProjectAuthorizationV1;
  /** Lets a tool's container item name the ECHO projects mapped to it (research tool contract v1). */
  readonly project_names?: PersonContextProjectNamesV1;
}

/**
 * One tool's live runtime, opened the same way for every tool: its private provider database in the state directory
 * (`bind` is the tool's lineage binding where it keeps one), then `build`, which constructs the tool's connection from
 * `connection(createNango)`, the options every tool's connection takes in the same order. The person's link to the tool
 * is the connection's own; closing closes the database. A failed build closes it too.
 */
export function openPersonToolLiveRuntimeV1<N, B extends { readonly application: { tool(input: { readonly access_token: string }): OrganizationPersonToolV4 }; readonly connection_http: ProviderHttpApplicationV1 }>(
  options: PersonToolLiveOpenOptionsV1<N>, tool: {
    readonly name: string; readonly file: string; readonly bind?: (database: Database.Database) => void;
    readonly build: (database: Database.Database, connection: (createNango: (input: { readonly integration_id: string; readonly authorization: () => string; readonly fetch: typeof fetch }) => N) => {
      readonly authorize_project?: PersonContextProjectAuthorizationV1; readonly project_names?: PersonContextProjectNamesV1;
      readonly nango: N; readonly cloud_id: string; readonly fetch: typeof fetch; readonly authenticate: ReturnType<typeof personToolAuthenticationV1>;
    }) => B;
  },
): B & { tools(access_token: string): Promise<readonly OrganizationPersonToolV4[]>; close(): void } {
  if (options.configuration.enabled !== true) throw new Error(`${tool.name} live evidence is not enabled`);
  const opened = openPersonProviderDatabaseV1(join(options.state_directory, tool.file),
    options.seams?.database !== undefined ? { supplied: options.seams.database } : tool.bind === undefined ? {} : { bind: tool.bind });
  try {
    const transport = options.seams?.fetch ?? fetch;
    const built = tool.build(opened.database, createNango => ({
      ...(options.authorize_project === undefined ? {} : { authorize_project: options.authorize_project }),
      ...(options.project_names === undefined ? {} : { project_names: options.project_names }),
      nango: options.seams?.nango ?? createNango({ integration_id: options.configuration.integration_id, authorization: options.configuration.nango_authorization, fetch: transport }),
      cloud_id: options.configuration.cloud_id,
      fetch: transport,
      authenticate: personToolAuthenticationV1(options.sessions),
    }));
    return Object.freeze({
      ...built,
      async tools(access_token: string): Promise<readonly OrganizationPersonToolV4[]> {
        return Object.freeze([built.application.tool({ access_token })]);
      },
      close() { opened.close(); },
    });
  } catch (error) { opened.close(); throw error; }
}

/** One translation at the boundary; all lifecycle and request code consumes the registry. */
export function personLiveConnectorDefinitionsV1(input: {
  readonly live_connectors?: readonly PersonLiveConnectorDefinitionV1[];
}): readonly PersonLiveConnectorDefinitionV1[] {
  const entries = input.live_connectors ?? [];
  const routingNames = new Set(['meeting', 'meetings', 'document', 'documents']);
  return Object.freeze(entries.map(entry => {
    const { source_id, selector, kind } = entry.descriptor;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(source_id) || !/^[a-z][a-z0-9_-]{0,63}$/.test(selector) ||
        routingNames.has(source_id) || routingNames.has(selector) ||
        !['ticket', 'page', 'tool_container'].includes(kind) ||
        // A tool container says what it can do (research tool contract v1).
        (kind === 'tool_container' && entry.descriptor.capabilities === undefined) ||
        entry.scopes.length === 0 ||
        entry.scopes.some(scope => scope !== 'global' && scope !== 'project')) throw new Error('Live connector registration is invalid');
    routingNames.add(source_id); routingNames.add(selector);
    return Object.freeze({ ...entry, descriptor: Object.freeze({ ...entry.descriptor }), scopes: Object.freeze([...entry.scopes]) });
  }));
}
