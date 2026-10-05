import { createPersonConnectionHttpApplicationV1, personConnectionTokenV1, personConnectionJsonV1 } from '@echo-brain/provider-runtime/person-connection-http-application-v1';
import { JIRA_PERSON_PROVIDER_V1 } from './jira-validation-v1.js';
import { PERSON_JIRA_PROJECT_READ_PATH_V1, PERSON_JIRA_PROJECT_SET_PATH_V1, validateJiraProjectReadV1, validateJiraProjectSetV1, validateJiraProjectMappingV1 } from '@echo-brain/provider-jira-client/organization-api/jira-project-mapping-v1';
import {
  type ProviderHttpApplicationV1,
  type ProviderHttpRequestV1,
} from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { JiraPersonConnectionV1 } from './jira-person-connection-v1.js';

export type JiraPersonConnectionHttpPortV1 = Pick<JiraPersonConnectionV1, 'connect' | 'status' | 'cancel' | 'disconnect'> & Partial<Pick<JiraPersonConnectionV1, 'projectRead' | 'projectSet'>>;

const json = (request: ProviderHttpRequestV1) => personConnectionJsonV1(request, 'Jira');
/** Provider-owned Person connection ingress. The Authority only mounts this selected adapter. */
export function createJiraPersonConnectionHttpApplicationV1(
  connection: JiraPersonConnectionHttpPortV1,
): ProviderHttpApplicationV1 {
  const shared = createPersonConnectionHttpApplicationV1(connection, JIRA_PERSON_PROVIDER_V1);
  return Object.freeze({
    routes: Object.freeze([...shared.routes, ...(connection.projectRead === undefined || connection.projectSet === undefined ? [] : [
      Object.freeze({ route_id: 'jira-project-read', method: 'POST' as const, path: PERSON_JIRA_PROJECT_READ_PATH_V1 }),
      Object.freeze({ route_id: 'jira-project-set', method: 'POST' as const, path: PERSON_JIRA_PROJECT_SET_PATH_V1 }),
    ])]),
    async accept(request: ProviderHttpRequestV1) {
      const access_token = personConnectionTokenV1(request);
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
        default: return shared.accept(request);
      }
    },
  });
}
