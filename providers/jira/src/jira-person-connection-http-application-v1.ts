import { PERSON_JIRA_PROJECT_READ_PATH_V1, PERSON_JIRA_PROJECT_SET_PATH_V1, validateJiraProjectReadV1, validateJiraProjectSetV1, validateJiraProjectMappingV1 } from '@echo-brain/provider-jira-client/organization-api/jira-project-mapping-v1';
import {
  PERSON_JIRA_CANCEL_PATH_V1,
  PERSON_JIRA_CONNECT_PATH_V1,
  PERSON_JIRA_DISCONNECT_PATH_V1,
  PERSON_JIRA_STATUS_PATH_V1,
  validatePersonJiraAttemptStatusV1,
  validatePersonJiraAttemptV1,
  validatePersonJiraCommandV1,
  validatePersonJiraConnectV1,
  validatePersonJiraStateV1,
} from '@echo-brain/provider-jira-client/organization-api/jira-person-connection-v1';
import {
  type ProviderHttpApplicationV1,
  type ProviderHttpRequestV1,
} from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { JiraPersonConnectionV1 } from './jira-person-connection-v1.js';

export type JiraPersonConnectionHttpPortV1 = Pick<JiraPersonConnectionV1, 'connect' | 'status' | 'cancel' | 'disconnect'> & Partial<Pick<JiraPersonConnectionV1, 'projectRead' | 'projectSet'>>;

const ROUTES = Object.freeze([
  Object.freeze({ route_id: 'jira-connect', method: 'POST' as const, path: PERSON_JIRA_CONNECT_PATH_V1 }),
  Object.freeze({ route_id: 'jira-status', method: 'POST' as const, path: PERSON_JIRA_STATUS_PATH_V1 }),
  Object.freeze({ route_id: 'jira-cancel', method: 'POST' as const, path: PERSON_JIRA_CANCEL_PATH_V1 }),
  Object.freeze({ route_id: 'jira-disconnect', method: 'POST' as const, path: PERSON_JIRA_DISCONNECT_PATH_V1 }),
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
    throw new AuthorityOperationError('invalid_request', 'Jira connection request is invalid');
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.raw_body)) as unknown; }
  catch { throw new AuthorityOperationError('invalid_request', 'Jira connection request is invalid'); }
}
function command(request: ProviderHttpRequestV1) {
  try { return validatePersonJiraCommandV1(json(request)); }
  catch (error) {
    if (error instanceof AuthorityOperationError) throw error;
    throw new AuthorityOperationError('invalid_request', 'Jira connection request is invalid');
  }
}
function attempt(request: ProviderHttpRequestV1) {
  try { return validatePersonJiraAttemptV1(json(request)); }
  catch (error) {
    if (error instanceof AuthorityOperationError) throw error;
    throw new AuthorityOperationError('invalid_request', 'Jira connection request is invalid');
  }
}
/** Provider-owned Person connection ingress. The Authority only mounts this selected adapter. */
export function createJiraPersonConnectionHttpApplicationV1(
  connection: JiraPersonConnectionHttpPortV1,
): ProviderHttpApplicationV1 {
  return Object.freeze({
    routes: Object.freeze([...ROUTES, ...(connection.projectRead === undefined || connection.projectSet === undefined ? [] : [
      Object.freeze({ route_id: 'jira-project-read', method: 'POST' as const, path: PERSON_JIRA_PROJECT_READ_PATH_V1 }),
      Object.freeze({ route_id: 'jira-project-set', method: 'POST' as const, path: PERSON_JIRA_PROJECT_SET_PATH_V1 }),
    ])]),
    async accept(request: ProviderHttpRequestV1) {
      const access_token = token(request);
      switch (request.route_id) {
        case 'jira-project-read':
        case 'jira-project-set': {
          if (connection.projectRead === undefined || connection.projectSet === undefined) throw new AuthorityOperationError('not_found', 'Jira project settings are unavailable');
          let parsed;
          try { parsed = request.route_id === 'jira-project-read' ? validateJiraProjectReadV1(json(request)) : validateJiraProjectSetV1(json(request)); }
          catch { throw new AuthorityOperationError('invalid_request', 'Jira project request is invalid'); }
          const result = validateJiraProjectMappingV1(request.route_id === 'jira-project-read'
            ? connection.projectRead({ access_token, request: parsed })
            : await connection.projectSet({ access_token, request: parsed, ...(request.signal === undefined ? {} : { signal: request.signal }) }));
          if (result.project_id !== parsed.project_id) throw new AuthorityOperationError('invalid_output', 'Jira project response is invalid');
          return Object.freeze({ status: 200 as const, body: result });
        }
        case 'jira-connect': {
          command(request);
          return Object.freeze({ status: 201 as const, body: validatePersonJiraConnectV1(await connection.connect({ access_token, ...(request.signal === undefined ? {} : { signal: request.signal }) })) });
        }
        case 'jira-status': {
          const input = attempt(request);
          const result = validatePersonJiraAttemptStatusV1(await connection.status({ access_token, attempt: input.attempt, ...(request.signal === undefined ? {} : { signal: request.signal }) }));
          if (result.attempt !== input.attempt) throw new AuthorityOperationError('invalid_output', 'Jira connection response is invalid');
          return Object.freeze({ status: 200 as const, body: result });
        }
        case 'jira-cancel': {
          const input = attempt(request);
          const result = validatePersonJiraAttemptStatusV1(await connection.cancel({ access_token, attempt: input.attempt, ...(request.signal === undefined ? {} : { signal: request.signal }) }));
          if (result.attempt !== input.attempt) throw new AuthorityOperationError('invalid_output', 'Jira connection response is invalid');
          return Object.freeze({ status: 200 as const, body: result });
        }
        case 'jira-disconnect': {
          command(request);
          return Object.freeze({ status: 200 as const, body: validatePersonJiraStateV1(await connection.disconnect({ access_token, ...(request.signal === undefined ? {} : { signal: request.signal }) }), false) });
        }
        default: throw new AuthorityOperationError('not_found', 'Jira connection route is unavailable');
      }
    },
  });
}
