import { createPersonConnectionHttpApplicationV1, personConnectionTokenV1, personConnectionJsonV1 } from '@echo-brain/provider-runtime/person-connection-http-application-v1';
import { GRANOLA_PERSON_PROVIDER_V1 } from './granola-mcp-v1.js';
import { personMeetingProjectPathsV1, validatePersonMeetingProjectReadV1, validatePersonMeetingProjectSetV1, validatePersonMeetingProjectMappingV1, validatePersonMeetingFolderListV1, validatePersonMeetingFoldersPageV1 } from '@echo-brain/organization-api';
import {
  type ProviderHttpApplicationV1,
  type ProviderHttpRequestV1,
} from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { GranolaPersonConnectionV1 } from './granola-person-connection-v1.js';

export type GranolaPersonConnectionHttpPortV1 = Pick<GranolaPersonConnectionV1, 'connect' | 'status' | 'cancel' | 'disconnect'> & Partial<Pick<GranolaPersonConnectionV1, 'projectRead' | 'projectSet' | 'foldersList'>>;

const { read: PERSON_GRANOLA_PROJECT_READ_PATH_V1, set: PERSON_GRANOLA_PROJECT_SET_PATH_V1, folders: PERSON_GRANOLA_FOLDERS_LIST_PATH_V1 } = personMeetingProjectPathsV1('granola');
const json = (request: ProviderHttpRequestV1) => personConnectionJsonV1(request, 'Granola');
/** Provider-owned Person connection ingress. The Authority only mounts this selected adapter. */
export function createGranolaPersonConnectionHttpApplicationV1(
  connection: GranolaPersonConnectionHttpPortV1,
): ProviderHttpApplicationV1 {
  const shared = createPersonConnectionHttpApplicationV1(connection, GRANOLA_PERSON_PROVIDER_V1);
  return Object.freeze({
    routes: Object.freeze([...shared.routes, ...(connection.projectRead === undefined || connection.projectSet === undefined ? [] : [
      Object.freeze({ route_id: 'granola-project-read', method: 'POST' as const, path: PERSON_GRANOLA_PROJECT_READ_PATH_V1 }),
      Object.freeze({ route_id: 'granola-project-set', method: 'POST' as const, path: PERSON_GRANOLA_PROJECT_SET_PATH_V1 }),
    ]), ...(connection.foldersList === undefined ? [] : [
      Object.freeze({ route_id: 'granola-folders-list', method: 'POST' as const, path: PERSON_GRANOLA_FOLDERS_LIST_PATH_V1 }),
    ])]),
    async accept(request: ProviderHttpRequestV1) {
      const access_token = personConnectionTokenV1(request);
      switch (request.route_id) {
        case 'granola-folders-list': {
          if (connection.foldersList === undefined) throw new AuthorityOperationError('not_found', 'Granola folders are unavailable');
          let input;
          try { input = validatePersonMeetingFolderListV1(json(request)); }
          catch { throw new AuthorityOperationError('invalid_request', 'Granola folders request is invalid'); }
          return Object.freeze({ status: 200 as const, body: validatePersonMeetingFoldersPageV1(await connection.foldersList({ access_token, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(request.signal === undefined ? {} : { signal: request.signal }) })) });
        }
        case 'granola-project-read':
        case 'granola-project-set': {
          if (connection.projectRead === undefined || connection.projectSet === undefined) throw new AuthorityOperationError('not_found', 'Granola project settings are unavailable');
          let parsed;
          try { parsed = request.route_id === 'granola-project-read' ? validatePersonMeetingProjectReadV1(json(request)) : validatePersonMeetingProjectSetV1(json(request)); }
          catch { throw new AuthorityOperationError('invalid_request', 'Granola project request is invalid'); }
          const result = validatePersonMeetingProjectMappingV1(request.route_id === 'granola-project-read'
            ? connection.projectRead({ access_token, request: parsed })
            : await connection.projectSet({ access_token, request: parsed, ...(request.signal === undefined ? {} : { signal: request.signal }) }));
          if (result.project_id !== parsed.project_id) throw new AuthorityOperationError('invalid_output', 'Granola project response is invalid');
          return Object.freeze({ status: 200 as const, body: result });
        }
        default: return shared.accept(request);
      }
    },
  });
}
