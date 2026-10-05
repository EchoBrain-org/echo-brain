import {
  validatePersonToolCommandV1,
  validatePersonToolAttemptV1,
  validatePersonToolConnectV1,
  validatePersonToolAttemptStatusV1,
  validatePersonToolStateV1,
  type PersonToolCommandV1 as PersonJiraCommandV1,
  type PersonToolAttemptV1 as PersonJiraAttemptV1,
  type PersonToolConnectV1 as PersonJiraConnectV1,
  type PersonToolAttemptStatusV1 as PersonJiraAttemptStatusV1,
  type PersonToolConnectionStateV1 as PersonJiraConnectionStateV1,
  type PersonToolAttemptFailureReasonV1 as PersonJiraAttemptFailureReasonV1,
} from "@echo-brain/organization-api";

export type { PersonJiraCommandV1, PersonJiraAttemptV1, PersonJiraConnectV1, PersonJiraAttemptStatusV1, PersonJiraConnectionStateV1, PersonJiraAttemptFailureReasonV1 };

export const PERSON_JIRA_CONNECT_PATH_V1 = "/v1/person/tools/jira/connect";
export const PERSON_JIRA_STATUS_PATH_V1 = "/v1/person/tools/jira/status";
export const PERSON_JIRA_CANCEL_PATH_V1 = "/v1/person/tools/jira/cancel";
export const PERSON_JIRA_DISCONNECT_PATH_V1 = "/v1/person/tools/jira/disconnect";

export const validatePersonJiraCommandV1 = (value: unknown): PersonJiraCommandV1 => validatePersonToolCommandV1(value, "Jira");
export const validatePersonJiraAttemptV1 = (value: unknown): PersonJiraAttemptV1 => validatePersonToolAttemptV1(value, "Jira");
export const validatePersonJiraConnectV1 = (value: unknown): PersonJiraConnectV1 => validatePersonToolConnectV1(value, "Jira");
export const validatePersonJiraAttemptStatusV1 = (value: unknown): PersonJiraAttemptStatusV1 => validatePersonToolAttemptStatusV1(value, "Jira");
export const validatePersonJiraStateV1 = (value: unknown, connected: boolean): PersonJiraConnectionStateV1 => validatePersonToolStateV1(value, connected, "Jira");
