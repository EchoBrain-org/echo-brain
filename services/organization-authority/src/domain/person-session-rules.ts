import { AuthorityOperationError } from "./errors.js";
import { timestampMillis } from "./rules.js";

export const PERSON_LOGIN_GRANT_LIFETIME_MS = 15 * 60 * 1000;
export const OIDC_LOGIN_ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
export const PERSON_ACCESS_CREDENTIAL_LIFETIME_MS = 12 * 60 * 60 * 1000;
export const PERSON_SESSION_HARD_REAUTHENTICATION_MS = 7 * 24 * 60 * 60 * 1000;
export const OIDC_ASSERTION_ISSUED_AT_SKEW_MS = 60 * 1000;
export const PERSON_SESSION_SECRET_BYTES = 32;

export function isCanonicalPersonEmail(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 254 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    !/^[!-~]+$/.test(value)
  ) {
    return false;
  }
  const separator = value.indexOf("@");
  return (
    separator > 0 &&
    separator === value.lastIndexOf("@") &&
    separator < value.length - 1
  );
}

const OPAQUE_FAILURE_MESSAGE = "person authentication failed";

export function personSessionUnauthorized(): AuthorityOperationError {
  return new AuthorityOperationError("unauthorized", OPAQUE_FAILURE_MESSAGE);
}

export function addPersonSessionMilliseconds(
  timestamp: string,
  milliseconds: number,
): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("person session duration is invalid");
  }
  return new Date(
    timestampMillis(timestamp, "person session timestamp") + milliseconds,
  ).toISOString();
}

export function earlierTimestamp(left: string, right: string): string {
  return timestampMillis(left, "person session timestamp") <=
    timestampMillis(right, "person session timestamp")
    ? left
    : right;
}

export function isStrictlyBefore(left: string, right: string): boolean {
  return (
    timestampMillis(left, "person session comparison time") <
    timestampMillis(right, "person session boundary")
  );
}

export function assertSessionRevocationReason(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AuthorityOperationError(
      "invalid_request",
      "session revocation reason is invalid",
    );
  }
}

export function assertOpaqueSubject(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw personSessionUnauthorized();
  }
}
