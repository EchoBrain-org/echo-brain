import type { PersonToolHostV1 } from "@echo-brain/organization-api";
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
  type PersonJiraAttemptStatusV1,
  type PersonJiraConnectV1,
  type PersonJiraConnectionStateV1,
} from "../organization-api/jira-person-connection-v1.js";

const JIRA_TOOL_TIMEOUT_MS = 75_000;
const JIRA_TOOL_MAXIMUM_RESPONSE_BYTES = 8_192;

/** Uses the host session for every request, preserving its current-account checks. */
export class JiraPersonClientV1 {
  constructor(private readonly host: PersonToolHostV1) {}

  connect(): Promise<PersonJiraConnectV1> {
    return this.host.withToolSession(async (session) => {
      const body = validatePersonJiraCommandV1({ schema_version: 1 });
      return session.transport.json({
        path: PERSON_JIRA_CONNECT_PATH_V1,
        body,
        validate_request: validatePersonJiraCommandV1,
        validate_response: validatePersonJiraConnectV1,
        maximum_response_bytes: JIRA_TOOL_MAXIMUM_RESPONSE_BYTES,
        timeout_ms: JIRA_TOOL_TIMEOUT_MS,
      });
    });
  }

  status(attempt: string): Promise<PersonJiraAttemptStatusV1> {
    return this.attempt(PERSON_JIRA_STATUS_PATH_V1, attempt);
  }

  cancel(attempt: string): Promise<PersonJiraAttemptStatusV1> {
    return this.attempt(PERSON_JIRA_CANCEL_PATH_V1, attempt);
  }

  disconnect(): Promise<PersonJiraConnectionStateV1> {
    return this.host.withToolSession(async (session) => {
      const body = validatePersonJiraCommandV1({ schema_version: 1 });
      return session.transport.json({
        path: PERSON_JIRA_DISCONNECT_PATH_V1,
        body,
        validate_request: validatePersonJiraCommandV1,
        validate_response: (value) => validatePersonJiraStateV1(value, false),
        maximum_response_bytes: JIRA_TOOL_MAXIMUM_RESPONSE_BYTES,
        timeout_ms: JIRA_TOOL_TIMEOUT_MS,
      });
    });
  }

  private attempt(
    path: string,
    attempt: string,
  ): Promise<PersonJiraAttemptStatusV1> {
    return this.host.withToolSession(async (session) => {
      const body = validatePersonJiraAttemptV1({ schema_version: 1, attempt });
      return session.transport.json({
        path,
        body,
        validate_request: validatePersonJiraAttemptV1,
        validate_response: (value) => {
          const response = validatePersonJiraAttemptStatusV1(value);
          if (response.attempt !== attempt) {
            throw new Error("Jira attempt response did not match the requested attempt");
          }
          return response;
        },
        maximum_response_bytes: JIRA_TOOL_MAXIMUM_RESPONSE_BYTES,
        timeout_ms: JIRA_TOOL_TIMEOUT_MS,
      });
    });
  }
}
