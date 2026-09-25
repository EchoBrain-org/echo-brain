import {
  isOrganizationProtocolValidationError,
  validateOrganizationAuthorityDescriptor,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationApiErrorV1,
  OrganizationAuthorityDescriptorResponseV1,
} from './contracts.js';

export const MAX_ORGANIZATION_API_BODY_BYTES = 16 * 1024;
export const MAX_ORGANIZATION_API_CURSOR_CHARACTERS = 512;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class OrganizationApiValidationError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`organization API: ${detail}`, options);
    this.name = 'OrganizationApiValidationError';
  }
}

export function isOrganizationApiValidationError(
  value: unknown,
): value is OrganizationApiValidationError {
  return value instanceof OrganizationApiValidationError;
}

/**
 * The shared primitives below are exported for sibling validators inside this
 * package only. `index.ts` re-exports none of them, so the published API
 * surface is unchanged.
 */
export function fail(message: string, cause?: unknown): never {
  throw new OrganizationApiValidationError(message, { cause });
}

export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${label} must be a plain object`);
  }
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!('value' in descriptor)) fail(`${label} must not contain accessors`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(`${label} must not contain symbol properties`);
  }
  return value as Record<string, unknown>;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
}

/**
 * Reviewer wire families are closed recursively. Reject in-memory properties
 * that RFC 8785 would otherwise omit instead of validating a different
 * apparent object. This is opt-in so landed schema-v1 snapshot semantics stay
 * unchanged.
 */
export function assertOnlyEnumerableDataProperties(
  value: unknown,
  label: string,
  seen: Set<object> = new Set<object>(),
): void {
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) fail(`${label} must not contain a cycle`);
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      fail(`${label} must not contain symbol properties`);
    }
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes('length')) {
        fail(`${label} must contain only dense array elements`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        ) {
          fail(`${label} must contain only enumerable data properties`);
        }
        assertOnlyEnumerableDataProperties(descriptor.value, label, seen);
      }
      return;
    }
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!('value' in descriptor) || descriptor.enumerable !== true) {
        fail(`${label} must contain only enumerable data properties`);
      }
      assertOnlyEnumerableDataProperties(descriptor.value, label, seen);
    }
  } finally {
    seen.delete(value);
  }
}

export function assertString(
  value: unknown,
  label: string,
  maximumLength: number,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${label} is invalid`);
  }
}

export function assertPatternString(
  value: unknown,
  label: string,
  maximumLength: number,
  pattern: RegExp,
): asserts value is string {
  assertString(value, label, maximumLength);
  if (!pattern.test(value)) fail(`${label} is invalid`);
}

export function assertDigest(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail(`${label} must be a canonical SHA-256 digest`);
  }
}

export function assertId(value: unknown, prefix: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !value.startsWith(`${prefix}_`) ||
    !UUID_V4_PATTERN.test(value.slice(prefix.length + 1))
  ) {
    fail(`${label} must be a canonical ${prefix} identifier`);
  }
}

export function assertTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    fail(`${label} must be a UTC millisecond timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} is not a real UTC timestamp`);
  }
}

function validateInnerDocument<T>(label: string, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (isOrganizationProtocolValidationError(error)) {
      fail(`${label} is invalid`, error);
    }
    throw error;
  }
}

export function validateOrganizationAuthorityDescriptorResponse(
  value: unknown,
): OrganizationAuthorityDescriptorResponseV1 {
  const record = asRecord(value, 'authority descriptor response');
  assertExactKeys(
    record,
    ['authority_descriptor'],
    'authority descriptor response',
  );
  return {
    authority_descriptor: validateInnerDocument(
      'authority descriptor response authority_descriptor',
      () =>
        validateOrganizationAuthorityDescriptor(record.authority_descriptor),
    ),
  };
}

export function validateOrganizationApiError(
  value: unknown,
): OrganizationApiErrorV1 {
  const envelope = asRecord(value, 'error response');
  assertExactKeys(envelope, ['error'], 'error response');
  const error = asRecord(envelope.error, 'error response error');
  assertExactKeys(error, ['code', 'message'], 'error response error');
  assertString(error.code, 'error response code', 100);
  if (!/^[a-z][a-z0-9_]*$/.test(error.code as string)) {
    fail('error response code is invalid');
  }
  assertString(error.message, 'error response message', 1000);
  return {
    error: {
      code: error.code as string,
      message: error.message as string,
    },
  };
}

export function validateOrganizationAuthorityOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    fail('invitation authority base URL is invalid');
  }
  const Url = (
    globalThis as unknown as {
      URL?: new (input: string) => {
        protocol: string;
        hostname: string;
        username: string;
        password: string;
        pathname: string;
        search: string;
        hash: string;
        origin: string;
      };
    }
  ).URL;
  if (Url === undefined) {
    fail('invitation authority base URL is invalid');
  }
  let url: InstanceType<typeof Url>;
  try {
    url = new Url(value);
  } catch {
    fail('invitation authority base URL is invalid');
  }
  if (
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
      )) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== url.origin
  ) {
    fail(
      'invitation authority base URL must be one bare HTTPS origin or development loopback HTTP origin',
    );
  }
  return value;
}
