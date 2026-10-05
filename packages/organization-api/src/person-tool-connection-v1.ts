import {
  asEnumerableRecord,
  assertExactKeys,
  assertTimestamp,
  fail,
} from "./validation.js";

/** Closed consent-attempt shapes shared by tools using this connection flow. */
export interface PersonToolCommandV1 {
  readonly schema_version: 1;
}

export interface PersonToolAttemptV1 extends PersonToolCommandV1 {
  readonly attempt: string;
}

export interface PersonToolConnectV1 {
  readonly schema_version: 1;
  readonly attempt: string;
  readonly connect_link: string;
  readonly expires_at: string;
}

export type PersonToolAttemptFailureReasonV1 =
  | "provider_rejected"
  | "provider_unavailable"
  | "account_mismatch";

export interface PersonToolAttemptStatusV1 {
  readonly schema_version: 1;
  readonly attempt: string;
  readonly expires_at: string;
  readonly status: "pending" | "complete" | "cancelled" | "expired" | "failed";
  readonly failure_reason: PersonToolAttemptFailureReasonV1 | null;
}

export interface PersonToolConnectionStateV1 {
  readonly schema_version: 1;
  readonly connected: boolean;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FAILURE_REASONS = new Set<PersonToolAttemptFailureReasonV1>([
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
  const Url = (globalThis as unknown as {
    URL?: new (input: string) => {
      protocol: string;
      hostname: string;
      username: string;
      password: string;
      hash: string;
    };
  }).URL;
  if (Url === undefined) fail(`${label} is invalid`);
  let url: InstanceType<typeof Url>;
  try {
    url = new Url(value);
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

export function validatePersonToolCommandV1(value: unknown, display_name: string): PersonToolCommandV1 {
  const label = `Person ${display_name} command`;
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ["schema_version"], label);
  if (record.schema_version !== 1) fail(`${label} version is unsupported`);
  return Object.freeze({ schema_version: 1 });
}

export function validatePersonToolAttemptV1(value: unknown, display_name: string): PersonToolAttemptV1 {
  const label = `Person ${display_name} attempt`;
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ["schema_version", "attempt"], label);
  if (record.schema_version !== 1) fail(`${label} version is unsupported`);
  attempt(record.attempt, `${label} identifier`);
  return Object.freeze({ schema_version: 1, attempt: record.attempt });
}

export function validatePersonToolConnectV1(value: unknown, display_name: string): PersonToolConnectV1 {
  const label = `Person ${display_name} connect response`;
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

export function validatePersonToolAttemptStatusV1(
  value: unknown,
  display_name: string,
): PersonToolAttemptStatusV1 {
  const label = `Person ${display_name} attempt status`;
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
      !FAILURE_REASONS.has(record.failure_reason as PersonToolAttemptFailureReasonV1)
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
    failure_reason: record.failure_reason as PersonToolAttemptFailureReasonV1 | null,
  } as PersonToolAttemptStatusV1);
}

export function validatePersonToolStateV1(
  value: unknown,
  connected: boolean,
  display_name: string,
): PersonToolConnectionStateV1 {
  const label = `Person ${display_name} connection state`;
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ["schema_version", "connected"], label);
  if (record.schema_version !== 1 || record.connected !== connected) {
    fail(`${label} is invalid`);
  }
  return Object.freeze({ schema_version: 1, connected });
}
