import { createPersonConnectionHttpApplicationV1, personConnectionTokenV1, personConnectionJsonV1, personConnectionCommandV1 } from '@echo-brain/provider-runtime/person-connection-http-application-v1';
import { CONFLUENCE_PERSON_PROVIDER_V1 } from './confluence-validation-v1.js';
import { PERSON_CONFLUENCE_PROJECT_LIST_PATH_V1, PERSON_CONFLUENCE_PROJECT_READ_PATH_V1, PERSON_CONFLUENCE_PROJECT_SET_PATH_V1, PERSON_CONFLUENCE_SPACES_LIST_PATH_V1, validateConfluenceProjectReadV1, validateConfluenceProjectSetV1, validateConfluenceProjectMappingV1, validateConfluenceProjectMappingsV1, validateConfluenceSpaceListV1, validateConfluenceSpacesPageV1 } from '@echo-brain/provider-confluence-client/organization-api/confluence-project-mapping-v1';
import {
  type ProviderHttpApplicationV1,
  type ProviderHttpRequestV1,
} from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { ConfluencePersonConnectionV1 } from './confluence-person-connection-v1.js';

export type ConfluencePersonConnectionHttpPortV1 = Pick<ConfluencePersonConnectionV1, 'connect' | 'status' | 'cancel' | 'disconnect'> & Partial<Pick<ConfluencePersonConnectionV1, 'projectRead' | 'projectSet' | 'projectList' | 'spacesList'>>;

const json = (request: ProviderHttpRequestV1) => personConnectionJsonV1(request, 'Confluence');
/** Provider-owned Person connection ingress. The Authority only mounts this selected adapter. */
export function createConfluencePersonConnectionHttpApplicationV1(
  connection: ConfluencePersonConnectionHttpPortV1,
): ProviderHttpApplicationV1 {
  const shared = createPersonConnectionHttpApplicationV1(connection, CONFLUENCE_PERSON_PROVIDER_V1);
  return Object.freeze({
    routes: Object.freeze([...shared.routes, ...(connection.projectRead === undefined || connection.projectSet === undefined || connection.projectList === undefined ? [] : [
      Object.freeze({ route_id: 'confluence-project-read', method: 'POST' as const, path: PERSON_CONFLUENCE_PROJECT_READ_PATH_V1 }),
      Object.freeze({ route_id: 'confluence-project-set', method: 'POST' as const, path: PERSON_CONFLUENCE_PROJECT_SET_PATH_V1 }),
      Object.freeze({ route_id: 'confluence-project-list', method: 'POST' as const, path: PERSON_CONFLUENCE_PROJECT_LIST_PATH_V1 }),
    ]), ...(connection.spacesList === undefined ? [] : [
      Object.freeze({ route_id: 'confluence-spaces-list', method: 'POST' as const, path: PERSON_CONFLUENCE_SPACES_LIST_PATH_V1 }),
    ])]),
    async accept(request: ProviderHttpRequestV1) {
      const access_token = personConnectionTokenV1(request);
      switch (request.route_id) {
        case 'confluence-project-list': {
          if (connection.projectList === undefined) throw new AuthorityOperationError('not_found', 'Confluence project settings are unavailable');
          personConnectionCommandV1(request, 'Confluence');
          return Object.freeze({ status: 200 as const, body: validateConfluenceProjectMappingsV1(connection.projectList({ access_token })) });
        }
        case 'confluence-spaces-list': {
          if (connection.spacesList === undefined) throw new AuthorityOperationError('not_found', 'Confluence spaces are unavailable');
          let input;
          try { input = validateConfluenceSpaceListV1(json(request)); }
          catch { throw new AuthorityOperationError('invalid_request', 'Confluence spaces request is invalid'); }
          return Object.freeze({ status: 200 as const, body: validateConfluenceSpacesPageV1(await connection.spacesList({ access_token, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(request.signal === undefined ? {} : { signal: request.signal }) })) });
        }
        case 'confluence-project-read':
        case 'confluence-project-set': {
          if (connection.projectRead === undefined || connection.projectSet === undefined) throw new AuthorityOperationError('not_found', 'Confluence project settings are unavailable');
          let parsed;
          try { parsed = request.route_id === 'confluence-project-read' ? validateConfluenceProjectReadV1(json(request)) : validateConfluenceProjectSetV1(json(request)); }
          catch { throw new AuthorityOperationError('invalid_request', 'Confluence project request is invalid'); }
          const result = validateConfluenceProjectMappingV1(request.route_id === 'confluence-project-read'
            ? connection.projectRead({ access_token, request: parsed })
            : await connection.projectSet({ access_token, request: parsed, ...(request.signal === undefined ? {} : { signal: request.signal }) }));
          if (result.project_id !== parsed.project_id) throw new AuthorityOperationError('invalid_output', 'Confluence project response is invalid');
          return Object.freeze({ status: 200 as const, body: result });
        }
        default: return shared.accept(request);
      }
    },
  });
}
