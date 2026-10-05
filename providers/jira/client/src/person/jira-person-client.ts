import { PERSON_JIRA_PROJECT_READ_PATH_V1, PERSON_JIRA_PROJECT_SET_PATH_V1, validateJiraProjectReadV1, validateJiraProjectSetV1, validateJiraProjectMappingV1, type JiraProjectSetV1, type JiraProjectMappingV1 } from '../organization-api/jira-project-mapping-v1.js';
import { PersonToolConnectionClientV1, PERSON_TOOL_SMALL_RESPONSE_MAX_BYTES_V1, type PersonToolHostV1 } from "@echo-brain/organization-api";
import {
  PERSON_JIRA_CONNECT_PATH_V1,
  PERSON_JIRA_STATUS_PATH_V1,
  PERSON_JIRA_CANCEL_PATH_V1,
  PERSON_JIRA_DISCONNECT_PATH_V1,
} from "../organization-api/jira-person-connection-v1.js";

const JIRA_TOOL_TIMEOUT_MS = 75_000;

export class JiraPersonClientV1 extends PersonToolConnectionClientV1 {
  constructor(host: PersonToolHostV1) {
    super(host, "Jira", {
      connect: PERSON_JIRA_CONNECT_PATH_V1,
      status: PERSON_JIRA_STATUS_PATH_V1,
      cancel: PERSON_JIRA_CANCEL_PATH_V1,
      disconnect: PERSON_JIRA_DISCONNECT_PATH_V1,
    });
  }

  projectRead(project_id: string): Promise<JiraProjectMappingV1> {
    return this.projectRequest(PERSON_JIRA_PROJECT_READ_PATH_V1, validateJiraProjectReadV1({ schema_version: 1, project_id }), validateJiraProjectReadV1);
  }
  projectSet(request: JiraProjectSetV1): Promise<JiraProjectMappingV1> {
    return this.projectRequest(PERSON_JIRA_PROJECT_SET_PATH_V1, validateJiraProjectSetV1(request), validateJiraProjectSetV1);
  }
  private projectRequest(path: string, body: { readonly project_id: string }, validate_request: (value: unknown) => unknown): Promise<JiraProjectMappingV1> {
    return this.host.withToolSession(session => session.transport.json({ path, body, validate_request, validate_response: value => {
      const result = validateJiraProjectMappingV1(value);
      if (result.project_id !== body.project_id) throw new Error('Jira project response did not match the requested project');
      return result;
    }, maximum_response_bytes: PERSON_TOOL_SMALL_RESPONSE_MAX_BYTES_V1, timeout_ms: JIRA_TOOL_TIMEOUT_MS }));
  }

}
