import { ConfluenceProjectMappingStoreV1 } from '@echo-brain/provider-confluence/confluence-project-mapping-store-v1';
import type { PersonLiveConnectorDefinitionV1 } from '../application/ports/person-context-live-runtime-v1.js';
import {
  CONFLUENCE_LIVE_CONNECTOR_V1, CONFLUENCE_SPACES_LIVE_CONNECTOR_V1, openPersonToolLiveRuntimeV1, personToolLiveConnectorsV1,
  type PersonToolLiveConfigurationV1, type PersonToolLiveOpenOptionsV1, type PersonToolLiveRuntimeSeamsV1,
} from './person-live-connector-registry-v1.js';
import { createConfluencePersonConnectionHttpApplicationV1 } from '@echo-brain/provider-confluence/confluence-person-connection-http-application-v1';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { ConfluenceConnectionStoreV1 } from '@echo-brain/provider-confluence/confluence-connection-store-v1';
import { createConfluenceNangoV1, type ConfluenceNangoV1 } from '@echo-brain/provider-confluence/confluence-nango-v1';
import { createConfluencePersonConnectionV1, type ConfluencePersonConnectionV1 } from '@echo-brain/provider-confluence/confluence-person-connection-v1';
import { bindConfluencePersonLiveStateV1 } from './confluence-person-live-state-v1.js';
import type { PersonPageCheckV1 } from '../application/ports/person-source-check-v1.js';
import type { OrganizationPersonToolV4 } from '@echo-brain/organization-api';

/** Explicit selecting configuration, absent until enabled by an operator. */
export type ConfluencePersonLiveConfigurationV1 = PersonToolLiveConfigurationV1;
export type ConfluencePersonLiveRuntimeSeamsV1 = PersonToolLiveRuntimeSeamsV1<ConfluenceNangoV1>;
interface OpenedConfluencePersonLiveRuntimeV1 {
  readonly application: ConfluencePersonConnectionV1;
  readonly connection_http: ProviderHttpApplicationV1;
  /** The Ask source check's page versions and section digests (ADR-0047), read with the caller's own connection. */
  readonly checks: PersonPageCheckV1;
  tools(access_token: string): Promise<readonly OrganizationPersonToolV4[]>;
  close(): void;
}

/** Confluence construction is selected here. Shared Authority composition sees only an optional application. */
export function openConfluencePersonLiveRuntimeV1(options: PersonToolLiveOpenOptionsV1<ConfluenceNangoV1>): OpenedConfluencePersonLiveRuntimeV1 {
  return openPersonToolLiveRuntimeV1(options, { name: 'Confluence', file: 'confluence-person-connections.sqlite',
    bind: database => bindConfluencePersonLiveStateV1({
      database,
      state_directory: options.state_directory,
      cloud_id: options.configuration.cloud_id,
      integration_id: options.configuration.integration_id,
    }),
    build(database, connection) {
      const application = createConfluencePersonConnectionV1({
        store: new ConfluenceConnectionStoreV1(database), project_mappings: new ConfluenceProjectMappingStoreV1(database), ...connection(createConfluenceNangoV1),
      });
      // A failed read rejects, so the check answers its pages unknown.
      const checks: PersonPageCheckV1 = Object.freeze({ kind: 'page', tool_id: 'confluence', external_scope_id: options.configuration.cloud_id,
        versions: (input: Parameters<PersonPageCheckV1['versions']>[0]) => application.pageVersions(input),
        sections: (input: Parameters<PersonPageCheckV1['sections']>[0]) => application.pageSections(input) });
      return { application, connection_http: createConfluencePersonConnectionHttpApplicationV1(application), checks };
    } });
}

/** Confluence's live connectors (research tool contract v1): its pages and, for the V8 answer, its spaces, over one runtime. */
export function confluencePersonLiveConnectorsV1(open: (...parameters: Parameters<PersonLiveConnectorDefinitionV1['open']>) => OpenedConfluencePersonLiveRuntimeV1): readonly PersonLiveConnectorDefinitionV1[] {
  return personToolLiveConnectorsV1({ items: CONFLUENCE_LIVE_CONNECTOR_V1, containers: CONFLUENCE_SPACES_LIVE_CONNECTOR_V1 }, open);
}
