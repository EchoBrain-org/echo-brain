import {
  validatePersonToolCommandV1,
  validatePersonToolAttemptV1,
  validatePersonToolConnectV1,
  validatePersonToolAttemptStatusV1,
  validatePersonToolStateV1,
  type PersonToolCommandV1 as PersonConfluenceCommandV1,
  type PersonToolAttemptV1 as PersonConfluenceAttemptV1,
  type PersonToolConnectV1 as PersonConfluenceConnectV1,
  type PersonToolAttemptStatusV1 as PersonConfluenceAttemptStatusV1,
  type PersonToolConnectionStateV1 as PersonConfluenceConnectionStateV1,
  type PersonToolAttemptFailureReasonV1 as PersonConfluenceAttemptFailureReasonV1,
} from "@echo-brain/organization-api";

export type { PersonConfluenceCommandV1, PersonConfluenceAttemptV1, PersonConfluenceConnectV1, PersonConfluenceAttemptStatusV1, PersonConfluenceConnectionStateV1, PersonConfluenceAttemptFailureReasonV1 };

export const PERSON_CONFLUENCE_CONNECT_PATH_V1 = "/v1/person/tools/confluence/connect";
export const PERSON_CONFLUENCE_STATUS_PATH_V1 = "/v1/person/tools/confluence/status";
export const PERSON_CONFLUENCE_CANCEL_PATH_V1 = "/v1/person/tools/confluence/cancel";
export const PERSON_CONFLUENCE_DISCONNECT_PATH_V1 = "/v1/person/tools/confluence/disconnect";

export const validatePersonConfluenceCommandV1 = (value: unknown): PersonConfluenceCommandV1 => validatePersonToolCommandV1(value, "Confluence");
export const validatePersonConfluenceAttemptV1 = (value: unknown): PersonConfluenceAttemptV1 => validatePersonToolAttemptV1(value, "Confluence");
export const validatePersonConfluenceConnectV1 = (value: unknown): PersonConfluenceConnectV1 => validatePersonToolConnectV1(value, "Confluence");
export const validatePersonConfluenceAttemptStatusV1 = (value: unknown): PersonConfluenceAttemptStatusV1 => validatePersonToolAttemptStatusV1(value, "Confluence");
export const validatePersonConfluenceStateV1 = (value: unknown, connected: boolean): PersonConfluenceConnectionStateV1 => validatePersonToolStateV1(value, connected, "Confluence");
