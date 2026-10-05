import { liveSourceDescriptorV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import type { PersonLiveConnectorDefinitionV1 } from '../application/ports/person-context-live-runtime-v1.js';
import type { PersonTicketLiveRuntimeFactoryV1 } from '../application/ports/person-ticket-live-runtime-v1.js';
import type { PersonPageLiveRuntimeFactoryV1 } from '../application/ports/person-page-live-runtime-v1.js';
import type { PersonSlackLiveRuntimeFactoryV1 } from '../application/ports/person-slack-live-runtime-v1.js';

/** Compatibility inputs; new providers register a definition instead of adding another slot. */
export interface LegacyPersonLiveConnectorsV1 {
  readonly ticket_live_runtime_factory?: PersonTicketLiveRuntimeFactoryV1;
  readonly page_live_runtime_factory?: PersonPageLiveRuntimeFactoryV1;
  readonly slack_live_runtime_factory?: PersonSlackLiveRuntimeFactoryV1;
}

export const LEGACY_TICKET_CONNECTOR_V1 = Object.freeze({
  descriptor: liveSourceDescriptorV2({ source: 'ticket' }),
  scopes: Object.freeze(['global', 'project'] as const), minimum_response_version: 5 as const,
});
export const LEGACY_PAGE_CONNECTOR_V1 = Object.freeze({
  descriptor: liveSourceDescriptorV2({ source: 'page' }),
  scopes: Object.freeze(['global', 'project'] as const), minimum_response_version: 6 as const,
});
export const LEGACY_SLACK_CONNECTOR_V1 = Object.freeze({
  descriptor: liveSourceDescriptorV2({ source: 'slack' }),
  scopes: Object.freeze(['global'] as const), minimum_response_version: 5 as const,
});
export const JIRA_LIVE_CONNECTOR_V1 = Object.freeze({
  ...LEGACY_TICKET_CONNECTOR_V1,
  descriptor: Object.freeze({ ...LEGACY_TICKET_CONNECTOR_V1.descriptor, source_id: 'jira', tool_id: 'jira', description: `${LEGACY_TICKET_CONNECTOR_V1.descriptor.description} Date filters select ticket creation dates.` }),
});
export const CONFLUENCE_LIVE_CONNECTOR_V1 = Object.freeze({
  ...LEGACY_PAGE_CONNECTOR_V1,
  descriptor: Object.freeze({ ...LEGACY_PAGE_CONNECTOR_V1.descriptor, source_id: 'confluence', tool_id: 'confluence', description: `${LEGACY_PAGE_CONNECTOR_V1.descriptor.description} Date filters select page last-modified dates.` }),
});

/** One translation at the boundary; all lifecycle and request code consumes the registry. */
export function personLiveConnectorDefinitionsV1(input: LegacyPersonLiveConnectorsV1 & {
  readonly live_connectors?: readonly PersonLiveConnectorDefinitionV1[];
}): readonly PersonLiveConnectorDefinitionV1[] {
  const entries: PersonLiveConnectorDefinitionV1[] = [
    ...(input.live_connectors ?? []),
    ...(input.ticket_live_runtime_factory === undefined ? [] : [{ ...LEGACY_TICKET_CONNECTOR_V1, open: input.ticket_live_runtime_factory }]),
    ...(input.page_live_runtime_factory === undefined ? [] : [{ ...LEGACY_PAGE_CONNECTOR_V1, open: input.page_live_runtime_factory }]),
    ...(input.slack_live_runtime_factory === undefined ? [] : [{ ...LEGACY_SLACK_CONNECTOR_V1, open: input.slack_live_runtime_factory }]),
  ];
  const routingNames = new Set(['meeting', 'meetings', 'document', 'documents']);
  return Object.freeze(entries.map(entry => {
    const { source_id, selector, kind } = entry.descriptor;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(source_id) || !/^[a-z][a-z0-9_-]{0,63}$/.test(selector) ||
        routingNames.has(source_id) || routingNames.has(selector) ||
        !['ticket', 'page', 'slack_message'].includes(kind) || ![5, 6].includes(entry.minimum_response_version) ||
        (kind === 'page' && entry.minimum_response_version < 6) || entry.scopes.length === 0 ||
        entry.scopes.some(scope => scope !== 'global' && scope !== 'project')) throw new Error('Live connector registration is invalid');
    routingNames.add(source_id); routingNames.add(selector);
    return Object.freeze({ ...entry, descriptor: Object.freeze({ ...entry.descriptor }), scopes: Object.freeze([...entry.scopes]) });
  }));
}
