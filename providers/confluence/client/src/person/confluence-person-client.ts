import { PERSON_CONFLUENCE_PROJECT_READ_PATH_V1, PERSON_CONFLUENCE_PROJECT_SET_PATH_V1, PERSON_CONFLUENCE_PROJECT_LIST_PATH_V1, PERSON_CONFLUENCE_SPACES_LIST_PATH_V1, validateConfluenceProjectReadV1, validateConfluenceProjectSetV1, validateConfluenceProjectMappingV1, validateConfluenceProjectMappingsV1, validateConfluenceSpaceListV1, validateConfluenceSpacesPageV1, type ConfluenceSpaceListV1, type ConfluenceSpacesPageV1, type ConfluenceProjectSetV1, type ConfluenceProjectMappingV1, type ConfluenceProjectMappingsV1 } from '../organization-api/confluence-project-mapping-v1.js';
import { PersonToolConnectionClientV1, PERSON_TOOL_SMALL_RESPONSE_MAX_BYTES_V1, PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1, type PersonToolHostV1 } from "@echo-brain/organization-api";
import {
  PERSON_CONFLUENCE_CONNECT_PATH_V1,
  PERSON_CONFLUENCE_STATUS_PATH_V1,
  PERSON_CONFLUENCE_CANCEL_PATH_V1,
  PERSON_CONFLUENCE_DISCONNECT_PATH_V1,
} from "../organization-api/confluence-person-connection-v1.js";

const CONFLUENCE_TOOL_TIMEOUT_MS = 75_000;

export class ConfluencePersonClientV1 extends PersonToolConnectionClientV1 {
  constructor(host: PersonToolHostV1) {
    super(host, "Confluence", {
      connect: PERSON_CONFLUENCE_CONNECT_PATH_V1,
      status: PERSON_CONFLUENCE_STATUS_PATH_V1,
      cancel: PERSON_CONFLUENCE_CANCEL_PATH_V1,
      disconnect: PERSON_CONFLUENCE_DISCONNECT_PATH_V1,
    });
  }

  projectRead(project_id: string): Promise<ConfluenceProjectMappingV1> {
    return this.projectRequest(PERSON_CONFLUENCE_PROJECT_READ_PATH_V1, validateConfluenceProjectReadV1({ schema_version: 1, project_id }), validateConfluenceProjectReadV1);
  }
  projectSet(request: ConfluenceProjectSetV1): Promise<ConfluenceProjectMappingV1> {
    return this.projectRequest(PERSON_CONFLUENCE_PROJECT_SET_PATH_V1, validateConfluenceProjectSetV1(request), validateConfluenceProjectSetV1);
  }
  projectList(): Promise<ConfluenceProjectMappingsV1> {
    // 100 mappings with 20 maximum-width space IDs serialize to 66,333 bytes.
    return this.host.withToolSession(session => session.transport.json({ path: PERSON_CONFLUENCE_PROJECT_LIST_PATH_V1, body: { schema_version: 1 }, validate_request: value => { if (typeof value !== 'object' || value === null || (value as { schema_version?: unknown }).schema_version !== 1) throw new Error('Confluence project list request is invalid'); return { schema_version: 1 as const }; }, validate_response: validateConfluenceProjectMappingsV1, maximum_response_bytes: PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1, timeout_ms: CONFLUENCE_TOOL_TIMEOUT_MS }));
  }
  spaces(input: ConfluenceSpaceListV1): Promise<ConfluenceSpacesPageV1> {
    // 20 spaces at six JSON bytes per key/name code unit plus cursor: 66,563 bytes.
    return this.host.withToolSession(session => session.transport.json({ path: PERSON_CONFLUENCE_SPACES_LIST_PATH_V1, body: validateConfluenceSpaceListV1(input), validate_request: validateConfluenceSpaceListV1, validate_response: validateConfluenceSpacesPageV1, maximum_response_bytes: PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1, timeout_ms: CONFLUENCE_TOOL_TIMEOUT_MS }));
  }
  private projectRequest(path: string, body: { readonly project_id: string }, validate_request: (value: unknown) => unknown): Promise<ConfluenceProjectMappingV1> {
    return this.host.withToolSession(session => session.transport.json({ path, body, validate_request, validate_response: value => {
      const result = validateConfluenceProjectMappingV1(value);
      if (result.project_id !== body.project_id) throw new Error('Confluence project response did not match the requested project');
      return result;
    }, maximum_response_bytes: PERSON_TOOL_SMALL_RESPONSE_MAX_BYTES_V1, timeout_ms: CONFLUENCE_TOOL_TIMEOUT_MS }));
  }

}
