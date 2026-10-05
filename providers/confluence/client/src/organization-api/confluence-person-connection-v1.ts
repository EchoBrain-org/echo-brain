import {
  asEnumerableRecord,
  assertExactKeys,
  assertTimestamp,
  fail,
} from "@echo-brain/organization-api/validation";

export const PERSON_CONFLUENCE_CONNECT_PATH_V1 = "/v1/person/tools/confluence/connect";
export const PERSON_CONFLUENCE_STATUS_PATH_V1 = "/v1/person/tools/confluence/status";
export const PERSON_CONFLUENCE_CANCEL_PATH_V1 = "/v1/person/tools/confluence/cancel";
export const PERSON_CONFLUENCE_DISCONNECT_PATH_V1 = "/v1/person/tools/confluence/disconnect";

export interface PersonConfluenceCommandV1 {
  readonly schema_version: 1;
}

export interface PersonConfluenceAttemptV1 extends PersonConfluenceCommandV1 {
  readonly attempt: string;
}

export interface PersonConfluenceConnectV1 {
  readonly schema_version: 1;
  readonly attempt: string;
  readonly connect_link: string;
  readonly expires_at: string;
}

export type PersonConfluenceAttemptFailureReasonV1 =
  | "provider_rejected"
  | "provider_unavailable"
  | "account_mismatch";

export interface PersonConfluenceAttemptStatusV1 {
  readonly schema_version: 1;
  readonly attempt: string;
  readonly expires_at: string;
  readonly status: "pending" | "complete" | "cancelled" | "expired" | "failed";
  readonly failure_reason: PersonConfluenceAttemptFailureReasonV1 | null;
}

export interface PersonConfluenceConnectionStateV1 {
  readonly schema_version: 1;
  readonly connected: boolean;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FAILURE_REASONS = new Set<PersonConfluenceAttemptFailureReasonV1>([
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

export function validatePersonConfluenceCommandV1(value: unknown): PersonConfluenceCommandV1 {
  const label = "Person Confluence command";
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ["schema_version"], label);
  if (record.schema_version !== 1) fail(`${label} version is unsupported`);
  return Object.freeze({ schema_version: 1 });
}

export function validatePersonConfluenceAttemptV1(value: unknown): PersonConfluenceAttemptV1 {
  const label = "Person Confluence attempt";
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ["schema_version", "attempt"], label);
  if (record.schema_version !== 1) fail(`${label} version is unsupported`);
  attempt(record.attempt, `${label} identifier`);
  return Object.freeze({ schema_version: 1, attempt: record.attempt });
}

export function validatePersonConfluenceConnectV1(value: unknown): PersonConfluenceConnectV1 {
  const label = "Person Confluence connect response";
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

export function validatePersonConfluenceAttemptStatusV1(
  value: unknown,
): PersonConfluenceAttemptStatusV1 {
  const label = "Person Confluence attempt status";
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
      !FAILURE_REASONS.has(record.failure_reason as PersonConfluenceAttemptFailureReasonV1)
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
    failure_reason: record.failure_reason as PersonConfluenceAttemptFailureReasonV1 | null,
  } as PersonConfluenceAttemptStatusV1);
}

export function validatePersonConfluenceStateV1(
  value: unknown,
  connected: boolean,
): PersonConfluenceConnectionStateV1 {
  const label = "Person Confluence connection state";
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ["schema_version", "connected"], label);
  if (record.schema_version !== 1 || record.connected !== connected) {
    fail(`${label} is invalid`);
  }
  return Object.freeze({ schema_version: 1, connected });
}
