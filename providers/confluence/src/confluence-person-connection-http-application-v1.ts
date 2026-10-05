import { PERSON_CONFLUENCE_PROJECT_LIST_PATH_V1, PERSON_CONFLUENCE_PROJECT_READ_PATH_V1, PERSON_CONFLUENCE_PROJECT_SET_PATH_V1, PERSON_CONFLUENCE_SPACES_LIST_PATH_V1, validateConfluenceProjectReadV1, validateConfluenceProjectSetV1, validateConfluenceProjectMappingV1, validateConfluenceProjectMappingsV1, validateConfluenceSpaceListV1, validateConfluenceSpacesPageV1 } from '@echo-brain/provider-confluence-client/organization-api/confluence-project-mapping-v1';
import {
  PERSON_CONFLUENCE_CANCEL_PATH_V1,
  PERSON_CONFLUENCE_CONNECT_PATH_V1,
  PERSON_CONFLUENCE_DISCONNECT_PATH_V1,
  PERSON_CONFLUENCE_STATUS_PATH_V1,
  validatePersonConfluenceAttemptStatusV1,
  validatePersonConfluenceAttemptV1,
  validatePersonConfluenceCommandV1,
  validatePersonConfluenceConnectV1,
  validatePersonConfluenceStateV1,
} from '@echo-brain/provider-confluence-client/organization-api/confluence-person-connection-v1';
import {
  type ProviderHttpApplicationV1,
  type ProviderHttpRequestV1,
} from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { ConfluencePersonConnectionV1 } from './confluence-person-connection-v1.js';

export type ConfluencePersonConnectionHttpPortV1 = Pick<ConfluencePersonConnectionV1, 'connect' | 'status' | 'cancel' | 'disconnect'> & Partial<Pick<ConfluencePersonConnectionV1, 'projectRead' | 'projectSet' | 'projectList' | 'spacesList'>>;

const ROUTES = Object.freeze([
  Object.freeze({ route_id: 'confluence-connect', method: 'POST' as const, path: PERSON_CONFLUENCE_CONNECT_PATH_V1 }),
  Object.freeze({ route_id: 'confluence-status', method: 'POST' as const, path: PERSON_CONFLUENCE_STATUS_PATH_V1 }),
  Object.freeze({ route_id: 'confluence-cancel', method: 'POST' as const, path: PERSON_CONFLUENCE_CANCEL_PATH_V1 }),
  Object.freeze({ route_id: 'confluence-disconnect', method: 'POST' as const, path: PERSON_CONFLUENCE_DISCONNECT_PATH_V1 }),
]);

function token(request: ProviderHttpRequestV1): string {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ') || header.length === 7) {
    throw new AuthorityOperationError('unauthorized', 'person authentication failed');
  }
  return header.slice(7);
}
function json(request: ProviderHttpRequestV1): unknown {
  if (request.content_type === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.content_type)) {
    throw new AuthorityOperationError('invalid_request', 'Confluence connection request is invalid');
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.raw_body)) as unknown; }
  catch { throw new AuthorityOperationError('invalid_request', 'Confluence connection request is invalid'); }
}
function command(request: ProviderHttpRequestV1) {
  try { return validatePersonConfluenceCommandV1(json(request)); }
  catch (error) {
    if (error instanceof AuthorityOperationError) throw error;
    throw new AuthorityOperationError('invalid_request', 'Confluence connection request is invalid');
  }
}
function attempt(request: ProviderHttpRequestV1) {
  try { return validatePersonConfluenceAttemptV1(json(request)); }
  catch (error) {
    if (error instanceof AuthorityOperationError) throw error;
    throw new AuthorityOperationError('invalid_request', 'Confluence connection request is invalid');
  }
}
/** Provider-owned Person connection ingress. The Authority only mounts this selected adapter. */
export function createConfluencePersonConnectionHttpApplicationV1(
  connection: ConfluencePersonConnectionHttpPortV1,
): ProviderHttpApplicationV1 {
  return Object.freeze({
    routes: Object.freeze([...ROUTES, ...(connection.projectRead === undefined || connection.projectSet === undefined || connection.projectList === undefined ? [] : [
      Object.freeze({ route_id: 'confluence-project-read', method: 'POST' as const, path: PERSON_CONFLUENCE_PROJECT_READ_PATH_V1 }),
      Object.freeze({ route_id: 'confluence-project-set', method: 'POST' as const, path: PERSON_CONFLUENCE_PROJECT_SET_PATH_V1 }),
      Object.freeze({ route_id: 'confluence-project-list', method: 'POST' as const, path: PERSON_CONFLUENCE_PROJECT_LIST_PATH_V1 }),
    ]), ...(connection.spacesList === undefined ? [] : [
      Object.freeze({ route_id: 'confluence-spaces-list', method: 'POST' as const, path: PERSON_CONFLUENCE_SPACES_LIST_PATH_V1 }),
    ])]),
    async accept(request: ProviderHttpRequestV1) {
      const access_token = token(request);
      switch (request.route_id) {
        case 'confluence-project-list': {
          if (connection.projectList === undefined) throw new AuthorityOperationError('not_found', 'Confluence project settings are unavailable');
          command(request);
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
        case 'confluence-connect': {
          command(request);
          return Object.freeze({ status: 201 as const, body: validatePersonConfluenceConnectV1(await connection.connect({ access_token, ...(request.signal === undefined ? {} : { signal: request.signal }) })) });
        }
        case 'confluence-status': {
          const input = attempt(request);
          const result = validatePersonConfluenceAttemptStatusV1(await connection.status({ access_token, attempt: input.attempt, ...(request.signal === undefined ? {} : { signal: request.signal }) }));
          if (result.attempt !== input.attempt) throw new AuthorityOperationError('invalid_output', 'Confluence connection response is invalid');
          return Object.freeze({ status: 200 as const, body: result });
        }
        case 'confluence-cancel': {
          const input = attempt(request);
          const result = validatePersonConfluenceAttemptStatusV1(await connection.cancel({ access_token, attempt: input.attempt, ...(request.signal === undefined ? {} : { signal: request.signal }) }));
          if (result.attempt !== input.attempt) throw new AuthorityOperationError('invalid_output', 'Confluence connection response is invalid');
          return Object.freeze({ status: 200 as const, body: result });
        }
        case 'confluence-disconnect': {
          command(request);
          return Object.freeze({ status: 200 as const, body: validatePersonConfluenceStateV1(await connection.disconnect({ access_token, ...(request.signal === undefined ? {} : { signal: request.signal }) }), false) });
        }
        default: throw new AuthorityOperationError('not_found', 'Confluence connection route is unavailable');
      }
    },
  });
}
