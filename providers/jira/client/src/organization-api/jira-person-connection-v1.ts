import {
  asEnumerableRecord,
  assertExactKeys,
  assertTimestamp,
  fail,
} from "@echo-brain/organization-api/validation";

export const PERSON_JIRA_CONNECT_PATH_V1 = "/v1/person/tools/jira/connect";
export const PERSON_JIRA_STATUS_PATH_V1 = "/v1/person/tools/jira/status";
export const PERSON_JIRA_CANCEL_PATH_V1 = "/v1/person/tools/jira/cancel";
export const PERSON_JIRA_DISCONNECT_PATH_V1 = "/v1/person/tools/jira/disconnect";

export interface PersonJiraCommandV1 {
  readonly schema_version: 1;
}

export interface PersonJiraAttemptV1 extends PersonJiraCommandV1 {
  readonly attempt: string;
}

export interface PersonJiraConnectV1 {
  readonly schema_version: 1;
  readonly attempt: string;
  readonly connect_link: string;
  readonly expires_at: string;
}

export type PersonJiraAttemptFailureReasonV1 =
  | "provider_rejected"
  | "provider_unavailable"
  | "account_mismatch";

export interface PersonJiraAttemptStatusV1 {
  readonly schema_version: 1;
  readonly attempt: string;
  readonly expires_at: string;
  readonly status: "pending" | "complete" | "cancelled" | "expired" | "failed";
  readonly failure_reason: PersonJiraAttemptFailureReasonV1 | null;
}

export interface PersonJiraConnectionStateV1 {
  readonly schema_version: 1;
  readonly connected: boolean;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FAILURE_REASONS = new Set<PersonJiraAttemptFailureReasonV1>([
  "provider_rejected",
  "provider_unavailable",
  "account_mismatch",
]);

function attempt(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    fail(`${label} is invalid`);
  }
}

function connectLink(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    fail(`${label} is invalid`);
  }
}

export function validatePersonJiraCommandV1(value: unknown): PersonJiraCommandV1 {
  const label = "Person Jira command";
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ["schema_version"], label);
  if (record.schema_version !== 1) fail(`${label} version is unsupported`);
  return Object.freeze({ schema_version: 1 });
}

export function validatePersonJiraAttemptV1(value: unknown): PersonJiraAttemptV1 {
  const label = "Person Jira attempt";
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ["schema_version", "attempt"], label);
  if (record.schema_version !== 1) fail(`${label} version is unsupported`);
  attempt(record.attempt, `${label} identifier`);
  return Object.freeze({ schema_version: 1, attempt: record.attempt });
}

export function validatePersonJiraConnectV1(value: unknown): PersonJiraConnectV1 {
  const label = "Person Jira connect response";
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ["schema_version", "attempt", "connect_link", "expires_at"], label);
  if (record.schema_version !== 1) fail(`${label} version is unsupported`);
  attempt(record.attempt, `${label} attempt`);
  connectLink(record.connect_link, `${label} connect link`);
  assertTimestamp(record.expires_at, `${label} expiry`);
  return Object.freeze({
    schema_version: 1,
    attempt: record.attempt,
    connect_link: record.connect_link,
    expires_at: record.expires_at as string,
  });
}

export function validatePersonJiraAttemptStatusV1(
  value: unknown,
): PersonJiraAttemptStatusV1 {
  const label = "Person Jira attempt status";
  const record = asEnumerableRecord(value, label);
  assertExactKeys(
    record,
    ["schema_version", "attempt", "expires_at", "status", "failure_reason"],
    label,
  );
  if (record.schema_version !== 1) fail(`${label} version is unsupported`);
  attempt(record.attempt, `${label} attempt`);
  assertTimestamp(record.expires_at, `${label} expiry`);
  if (
    record.status !== "pending" &&
    record.status !== "complete" &&
    record.status !== "cancelled" &&
    record.status !== "expired" &&
    record.status !== "failed"
  ) {
    fail(`${label} status is invalid`);
  }
  if (record.status === "failed") {
    if (
      typeof record.failure_reason !== "string" ||
      !FAILURE_REASONS.has(record.failure_reason as PersonJiraAttemptFailureReasonV1)
    ) {
      fail(`${label} failure reason is invalid`);
    }
  } else if (record.failure_reason !== null) {
    fail(`${label} failure reason is invalid`);
  }
  return Object.freeze({
    schema_version: 1,
    attempt: record.attempt,
    expires_at: record.expires_at as string,
    status: record.status,
    failure_reason: record.failure_reason as PersonJiraAttemptFailureReasonV1 | null,
  } as PersonJiraAttemptStatusV1);
}

export function validatePersonJiraStateV1(
  value: unknown,
  connected: boolean,
): PersonJiraConnectionStateV1 {
  const label = "Person Jira connection state";
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ["schema_version", "connected"], label);
  if (record.schema_version !== 1 || record.connected !== connected) {
    fail(`${label} is invalid`);
  }
  return Object.freeze({ schema_version: 1, connected });
}
