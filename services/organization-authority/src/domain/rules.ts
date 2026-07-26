import { assertUtcMillisecondTimestamp } from '@echo-brain/federation-protocol';
import type { OrganizationMembershipTypeV1 } from '@echo-brain/organization-protocol';
import { AuthorityOperationError } from './errors.js';

export const MAX_AUTHORITY_ENROLLMENT_GRANT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
export const MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS = 5 * 60 * 1000;
export const MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS = 5 * 60 * 1000;

export function timestampMillis(value: string, label: string): number {
  assertUtcMillisecondTimestamp(value, label);
  return Date.parse(value);
}

export function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(
    timestampMillis(value, 'authority timestamp') + milliseconds,
  ).toISOString();
}

export function assertConfiguredLeaseTtl(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS
  ) {
    throw new Error(
      `active lease TTL must be between 1 and ${MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS} milliseconds`,
    );
  }
}

export function assertConfiguredRequestAge(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS
  ) {
    throw new Error(
      `access request age must be between 1 and ${MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS} milliseconds`,
    );
  }
}

export function assertGrantLifetimeSeconds(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_AUTHORITY_ENROLLMENT_GRANT_LIFETIME_SECONDS
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      `enrollment grant lifetime must be between 1 and ${MAX_AUTHORITY_ENROLLMENT_GRANT_LIFETIME_SECONDS} seconds`,
    );
  }
}

export function assertFreshAccessRequest(
  requestedAt: string,
  now: string,
  maximumAgeMs: number,
): void {
  const difference = Math.abs(
    timestampMillis(requestedAt, 'access lease requested_at') -
      timestampMillis(now, 'authority access request time'),
  );
  if (difference > maximumAgeMs) {
    throw new AuthorityOperationError(
      'unauthorized',
      'access lease request is outside the accepted time window',
    );
  }
}

export function assertDisplayName(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      'membership display name is invalid',
    );
  }
}

export function assertMembershipType(
  value: OrganizationMembershipTypeV1,
): void {
  if (value !== 'owner' && value !== 'employee') {
    throw new AuthorityOperationError(
      'invalid_request',
      'membership type is unsupported',
    );
  }
}

export function assertRevocationReason(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 500 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      'revocation reason is invalid',
    );
  }
}
