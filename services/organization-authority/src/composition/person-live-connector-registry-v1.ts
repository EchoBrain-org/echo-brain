import { liveSourceDescriptorV2, type EvidenceSourceCapabilitiesV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import { WORKSPACE_MINIMUM_RESPONSE_VERSION_V1 } from '@echo-brain/organization-authority-kernel/shared/workspace-evidence-v1';
import type { PersonLiveConnectorDefinitionV1 } from '../application/ports/person-context-live-runtime-v1.js';

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
/** Jira projects, Confluence spaces and Slack channels are listed and searched by key and name: no filters, dates or links. */
export const TOOL_CONTAINER_CAPABILITIES_V1: EvidenceSourceCapabilitiesV1 = Object.freeze({
  filters: Object.freeze({}), dates: Object.freeze({}), any_date: false, links: Object.freeze([]),
});

export const LEGACY_TICKET_CONNECTOR_V1 = Object.freeze({
  descriptor: liveSourceDescriptorV2({ source: 'ticket' }),
  scopes: Object.freeze(['global', 'project'] as const), minimum_response_version: 5 as const,
});
export const LEGACY_PAGE_CONNECTOR_V1 = Object.freeze({
  descriptor: liveSourceDescriptorV2({ source: 'page' }),
  scopes: Object.freeze(['global', 'project'] as const), minimum_response_version: 6 as const,
});
/** Descriptions say what a source holds; its capabilities say how it filters (research tool contract v1). */
export const JIRA_LIVE_CONNECTOR_V1 = Object.freeze({
  ...LEGACY_TICKET_CONNECTOR_V1,
  descriptor: Object.freeze({ ...LEGACY_TICKET_CONNECTOR_V1.descriptor, source_id: 'jira', tool_id: 'jira', capabilities: JIRA_ISSUE_CAPABILITIES_V1,
    description: "Jira issues the asker can see with their own Jira account: each issue's key, title, status, assignee and due date, its description, and the issues linked to it." }),
});
export const CONFLUENCE_LIVE_CONNECTOR_V1 = Object.freeze({
  ...LEGACY_PAGE_CONNECTOR_V1,
  descriptor: Object.freeze({ ...LEGACY_PAGE_CONNECTOR_V1.descriptor, source_id: 'confluence', tool_id: 'confluence', capabilities: CONFLUENCE_PAGE_CAPABILITIES_V1,
    description: "Confluence pages the asker can see with their own Confluence account: each page's title and status, and its text section by section." }),
});

/** A connected tool's containers (research tool contract v1), which only the V8 answer can cite. */
function toolContainerConnectorV1(source_id: string, tool_id: string, description: string) {
  return Object.freeze({
    descriptor: Object.freeze({ source_id, kind: 'tool_container' as const, selector: source_id, tool_id, metadata_only_list: false, description, capabilities: TOOL_CONTAINER_CAPABILITIES_V1 }),
    scopes: Object.freeze(['global', 'project'] as const), minimum_response_version: WORKSPACE_MINIMUM_RESPONSE_VERSION_V1,
  });
}
export const JIRA_PROJECTS_LIVE_CONNECTOR_V1 = toolContainerConnectorV1('jira_projects', 'jira',
  "Jira projects the asker can see with their own Jira account: each project's key, name and link, and the ECHO projects mapped to it.");
export const CONFLUENCE_SPACES_LIVE_CONNECTOR_V1 = toolContainerConnectorV1('confluence_spaces', 'confluence',
  "Confluence spaces the asker can see with their own Confluence account: each space's key, name and link, and the ECHO projects mapped to it.");

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
        !['ticket', 'page', 'slack_message', 'tool_container'].includes(kind) || ![5, 6, 8].includes(entry.minimum_response_version) ||
        (kind === 'page' && entry.minimum_response_version < 6) ||
        // A tool container cites only in the V8 answer, and says what it can do (research tool contract v1).
        (kind === 'tool_container' && (entry.minimum_response_version < WORKSPACE_MINIMUM_RESPONSE_VERSION_V1 || entry.descriptor.capabilities === undefined)) ||
        entry.scopes.length === 0 ||
        entry.scopes.some(scope => scope !== 'global' && scope !== 'project')) throw new Error('Live connector registration is invalid');
    routingNames.add(source_id); routingNames.add(selector);
    return Object.freeze({ ...entry, descriptor: Object.freeze({ ...entry.descriptor }), scopes: Object.freeze([...entry.scopes]) });
  }));
}
