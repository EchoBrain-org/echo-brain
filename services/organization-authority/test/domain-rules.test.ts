import { describe, expect, it } from 'vitest';
import {
  MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS,
  MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS,
  MAX_AUTHORITY_ENROLLMENT_GRANT_LIFETIME_SECONDS,
  addMilliseconds,
  assertConfiguredLeaseTtl,
  assertConfiguredRequestAge,
  assertDisplayName,
  assertFreshAccessRequest,
  assertGrantLifetimeSeconds,
  assertMembershipType,
  assertRevocationReason,
  timestampMillis,
} from '../src/domain/rules.js';

describe('organization authority domain rules', () => {
  it('performs timestamp arithmetic only on canonical UTC milliseconds', () => {
    expect(timestampMillis('2026-07-22T00:00:00.000Z', 'fixture')).toBe(
      Date.parse('2026-07-22T00:00:00.000Z'),
    );
    expect(addMilliseconds('2026-07-22T00:00:00.000Z', 1_500)).toBe(
      '2026-07-22T00:00:01.500Z',
    );
    expect(() => timestampMillis('2026-07-22T00:00:00Z', 'fixture')).toThrow();
  });

  it.each([
    [assertConfiguredLeaseTtl, MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS],
    [assertConfiguredRequestAge, MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS],
  ] as const)(
    'accepts the configured bound and rejects unsafe values',
    (rule, maximum) => {
      expect(() => rule(1)).not.toThrow();
      expect(() => rule(maximum)).not.toThrow();
      for (const value of [0, -1, maximum + 1, 1.5, Number.NaN]) {
        expect(() => rule(value)).toThrow();
      }
    },
  );

  it('bounds enrollment grant lifetime with a domain error', () => {
    expect(() =>
      assertGrantLifetimeSeconds(
        MAX_AUTHORITY_ENROLLMENT_GRANT_LIFETIME_SECONDS,
      ),
    ).not.toThrow();
    expect(() => assertGrantLifetimeSeconds(0)).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('accepts either clock direction at the access-request boundary', () => {
    const now = '2026-07-22T00:05:00.000Z';
    expect(() =>
      assertFreshAccessRequest('2026-07-22T00:00:00.000Z', now, 5 * 60 * 1000),
    ).not.toThrow();
    expect(() =>
      assertFreshAccessRequest('2026-07-22T00:10:00.001Z', now, 5 * 60 * 1000),
    ).toThrowError(expect.objectContaining({ code: 'unauthorized' }));
  });

  it('validates membership vocabulary independently of transport DTOs', () => {
    expect(() => assertDisplayName('Echo Team')).not.toThrow();
    expect(() => assertMembershipType('owner')).not.toThrow();
    expect(() => assertMembershipType('employee')).not.toThrow();
    expect(() => assertRevocationReason('Device retired')).not.toThrow();
    expect(() => assertDisplayName(' Echo Team')).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() => assertMembershipType('admin' as 'owner')).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() => assertRevocationReason('')).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });
});
