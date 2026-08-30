import {
  isOrganizationProtocolValidationError,
  validateOrganizationAuthorityDescriptor,
} from '@echo-brain/organization-protocol';
import type { JsonValue } from '@echo-brain/federation-protocol';
import type {
  OrganizationAdminOverviewCountsV1,
  OrganizationAdminOverviewV1,
  OrganizationApiErrorV1,
  OrganizationApiSignedIntegrityV1,
  OrganizationAuditEntrySummaryV1,
  OrganizationAuditPageV1,
  OrganizationAuthorityDescriptorResponseV1,
  OrganizationMembershipPageV1,
  OrganizationMembershipSummaryV1,
  ProvisionedOrganizationMembershipV1,
  ProvisionOrganizationMembershipRequestV1,
  RevokeOrganizationMembershipRequestV1,
} from './contracts.js';

export const MAX_ORGANIZATION_API_BODY_BYTES = 16 * 1024;
export const MAX_ORGANIZATION_API_PAGE_ITEMS = 100;
export const MAX_ORGANIZATION_API_CURSOR_CHARACTERS = 512;
export const MAX_ORGANIZATION_AUDIT_DETAIL_NODES = 256;
export const MAX_ORGANIZATION_AUDIT_DETAIL_DEPTH = 8;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64URL_TWO_CHARACTER_TAIL_PATTERN = /^[AQgw]$/;
const BASE64URL_THREE_CHARACTER_TAIL_PATTERN = /^[AEIMQUYcgkosw048]$/;

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

function assertNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
}

function validatePageCursor(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ORGANIZATION_API_CURSOR_CHARACTERS ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    fail(`${label} must be null or bounded canonical base64url`);
  }
  const remainder = value.length % 4;
  const finalCharacter = value.at(-1)!;
  if (
    (remainder === 2 &&
      !BASE64URL_TWO_CHARACTER_TAIL_PATTERN.test(finalCharacter)) ||
    (remainder === 3 &&
      !BASE64URL_THREE_CHARACTER_TAIL_PATTERN.test(finalCharacter))
  ) {
    fail(`${label} must be null or bounded canonical base64url`);
  }
  return value;
}

function validateJsonValue(
  value: unknown,
  label: string,
  state: { nodes: number },
  depth = 0,
): JsonValue {
  state.nodes += 1;
  if (
    state.nodes > MAX_ORGANIZATION_AUDIT_DETAIL_NODES ||
    depth > MAX_ORGANIZATION_AUDIT_DETAIL_DEPTH
  ) {
    fail(`${label} exceeds its structural bounds`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 4096) fail(`${label} contains an oversized string`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(value).length !== value.length
    ) {
      fail(`${label} must be a dense JSON array`);
    }
    const result: JsonValue[] = [];
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !('value' in descriptor)) {
        fail(`${label} must be a dense JSON array`);
      }
      result.push(
        validateJsonValue(
          descriptor.value,
          `${label}[${index}]`,
          state,
          depth + 1,
        ),
      );
    }
    return result;
  }
  const record = asRecord(value, label);
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const [key, item] of Object.entries(record)) {
    if (key.length === 0 || key.length > 200) {
      fail(`${label} contains an invalid object key`);
    }
    result[key] = validateJsonValue(item, `${label}.${key}`, state, depth + 1);
  }
  return result;
}

function validatePage<T>(
  value: unknown,
  label: string,
  validateItem: (item: unknown) => T,
): { items: T[]; next_cursor: string | null } {
  const record = asRecord(value, label);
  assertExactKeys(record, ['items', 'next_cursor'], label);
  if (!Array.isArray(record.items)) fail(`${label} items must be an array`);
  if (record.items.length > MAX_ORGANIZATION_API_PAGE_ITEMS) {
    fail(`${label} exceeds the maximum page size`);
  }
  if (
    Object.getOwnPropertySymbols(record.items).length !== 0 ||
    Object.keys(record.items).length !== record.items.length
  ) {
    fail(`${label} items must be a dense array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(record.items);
  const items: T[] = [];
  for (let index = 0; index < record.items.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)) {
      fail(`${label} items must be a dense array`);
    }
    items.push(validateItem(descriptor.value));
  }
  return {
    items,
    next_cursor: validatePageCursor(record.next_cursor, `${label} next_cursor`),
  };
}

function validateUniquePage<T>(
  value: unknown,
  label: string,
  validateItem: (item: unknown) => T,
  identity: keyof T,
  itemLabel: string,
  organization: keyof T | null,
): { items: T[]; next_cursor: string | null } {
  const page = validatePage(value, label, validateItem);
  if (
    new Set(page.items.map((item) => item[identity])).size !==
    page.items.length
  ) {
    fail(`${label} repeats ${itemLabel}`);
  }
  if (
    organization !== null &&
    new Set(page.items.map((item) => item[organization])).size > 1
  ) {
    fail(`${label} crosses organizations`);
  }
  return page;
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

function validateMembershipType(value: unknown, label: string): void {
  if (value !== 'owner' && value !== 'employee') {
    fail(`${label} is unsupported`);
  }
}

export function validateSignedRequestIntegrity(
  value: unknown,
  documentLabel = 'signed request',
): OrganizationApiSignedIntegrityV1 {
  const label = `${documentLabel} integrity`;
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      'canonicalization',
      'payload_sha256',
      'signature_algorithm',
      'key_id',
      'signature_base64',
    ],
    label,
  );
  if (record.canonicalization !== 'RFC8785') {
    fail(`${documentLabel} canonicalization is unsupported`);
  }
  if (record.signature_algorithm !== 'ecdsa-p256-sha256-der-low-s') {
    fail(`${documentLabel} signature algorithm is unsupported`);
  }
  assertDigest(record.payload_sha256, `${documentLabel} payload digest`);
  assertDigest(record.key_id, `${documentLabel} integrity key`);
  if (
    typeof record.signature_base64 !== 'string' ||
    record.signature_base64.length < 8 ||
    record.signature_base64.length > 256 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(record.signature_base64)
  ) {
    fail(`${documentLabel} signature is not bounded base64`);
  }
  return record as unknown as OrganizationApiSignedIntegrityV1;
}

export function validateProvisionOrganizationMembershipRequest(
  value: unknown,
): ProvisionOrganizationMembershipRequestV1 {
  const record = asRecord(value, 'membership request');
  assertExactKeys(
    record,
    ['command_id', 'display_name', 'membership_type'],
    'membership request',
  );
  assertId(record.command_id, 'adm', 'membership command_id');
  assertString(record.display_name, 'membership display_name', 200);
  if (
    record.membership_type !== 'owner' &&
    record.membership_type !== 'employee'
  ) {
    fail('membership_type is unsupported');
  }
  return record as unknown as ProvisionOrganizationMembershipRequestV1;
}

export function validateRevokeOrganizationMembershipRequest(
  value: unknown,
): RevokeOrganizationMembershipRequestV1 {
  const record = asRecord(value, 'membership revocation request');
  assertExactKeys(record, ['reason'], 'membership revocation request');
  assertString(record.reason, 'membership revocation reason', 500);
  return record as unknown as RevokeOrganizationMembershipRequestV1;
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

export function validateProvisionedOrganizationMembership(
  value: unknown,
): ProvisionedOrganizationMembershipV1 {
  const record = asRecord(value, 'provisioned membership response');
  assertExactKeys(
    record,
    [
      'organization_id',
      'principal_id',
      'membership_id',
      'display_name',
      'membership_type',
      'status',
      'provisioned_at',
      'revoked_at',
    ],
    'provisioned membership response',
  );
  assertId(record.organization_id, 'org', 'membership organization_id');
  assertId(record.principal_id, 'prn', 'membership principal_id');
  assertId(record.membership_id, 'mem', 'membership membership_id');
  assertString(record.display_name, 'membership display_name', 200);
  validateMembershipType(record.membership_type, 'membership_type');
  assertTimestamp(record.provisioned_at, 'membership provisioned_at');
  if (record.status === 'active') {
    if (record.revoked_at !== null) {
      fail('active membership must not have a revoked_at timestamp');
    }
  } else if (record.status === 'revoked') {
    assertTimestamp(record.revoked_at, 'membership revoked_at');
    if (
      Date.parse(record.revoked_at as string) <
      Date.parse(record.provisioned_at as string)
    ) {
      fail('membership revocation predates provisioning');
    }
  } else {
    fail('membership status is unsupported');
  }
  return record as unknown as ProvisionedOrganizationMembershipV1;
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

function validateOrganizationAdminOverviewCounts(
  value: unknown,
): OrganizationAdminOverviewCountsV1 {
  const record = asRecord(value, 'admin overview counts');
  const keys = [
    'memberships',
    'active_memberships',
    'revoked_memberships',
    'installations',
    'active_installations',
    'revoked_installations',
    'enrollment_grants',
    'pending_enrollment_grants',
    'consumed_enrollment_grants',
    'expired_enrollment_grants',
    'audit_entries',
  ] as const;
  assertExactKeys(record, keys, 'admin overview counts');
  for (const key of keys) {
    assertNonNegativeInteger(record[key], `admin overview ${key}`);
  }
  if (
    record.memberships !==
    (record.active_memberships as number) +
      (record.revoked_memberships as number)
  ) {
    fail('admin overview membership counts are inconsistent');
  }
  if (
    record.installations !==
    (record.active_installations as number) +
      (record.revoked_installations as number)
  ) {
    fail('admin overview installation counts are inconsistent');
  }
  if (
    record.enrollment_grants !==
    (record.pending_enrollment_grants as number) +
      (record.consumed_enrollment_grants as number) +
      (record.expired_enrollment_grants as number)
  ) {
    fail('admin overview enrollment grant counts are inconsistent');
  }
  return record as unknown as OrganizationAdminOverviewCountsV1;
}

export function validateOrganizationAdminOverview(
  value: unknown,
): OrganizationAdminOverviewV1 {
  const record = asRecord(value, 'admin overview response');
  assertExactKeys(
    record,
    [
      'organization_id',
      'organization_display_name',
      'authority_id',
      'authority_pin_sha256',
      'created_at',
      'last_observed_at',
      'counts',
    ],
    'admin overview response',
  );
  assertId(record.organization_id, 'org', 'admin overview organization_id');
  assertString(
    record.organization_display_name,
    'admin overview organization_display_name',
    200,
  );
  assertId(record.authority_id, 'oau', 'admin overview authority_id');
  assertDigest(record.authority_pin_sha256, 'admin overview authority pin');
  assertTimestamp(record.created_at, 'admin overview created_at');
  assertTimestamp(record.last_observed_at, 'admin overview last_observed_at');
  if (
    Date.parse(record.last_observed_at as string) <
    Date.parse(record.created_at as string)
  ) {
    fail('admin overview last_observed_at predates creation');
  }
  return {
    organization_id: record.organization_id as string,
    organization_display_name: record.organization_display_name as string,
    authority_id: record.authority_id as string,
    authority_pin_sha256:
      record.authority_pin_sha256 as OrganizationAdminOverviewV1['authority_pin_sha256'],
    created_at: record.created_at as string,
    last_observed_at: record.last_observed_at as string,
    counts: validateOrganizationAdminOverviewCounts(record.counts),
  };
}

export function validateOrganizationMembershipSummary(
  value: unknown,
): OrganizationMembershipSummaryV1 {
  const record = asRecord(value, 'membership summary');
  assertExactKeys(
    record,
    [
      'organization_id',
      'principal_id',
      'membership_id',
      'display_name',
      'membership_type',
      'status',
      'provisioned_at',
      'revoked_at',
      'revocation_reason',
    ],
    'membership summary',
  );
  assertId(record.organization_id, 'org', 'membership organization_id');
  assertId(record.principal_id, 'prn', 'membership principal_id');
  assertId(record.membership_id, 'mem', 'membership membership_id');
  assertString(record.display_name, 'membership display_name', 200);
  validateMembershipType(record.membership_type, 'membership_type');
  assertTimestamp(record.provisioned_at, 'membership provisioned_at');
  if (record.status === 'active') {
    if (record.revoked_at !== null || record.revocation_reason !== null) {
      fail('active membership must not contain revocation fields');
    }
  } else if (record.status === 'revoked') {
    assertTimestamp(record.revoked_at, 'membership revoked_at');
    assertString(record.revocation_reason, 'membership revocation_reason', 500);
    if (
      Date.parse(record.revoked_at as string) <
      Date.parse(record.provisioned_at as string)
    ) {
      fail('membership revocation predates provisioning');
    }
  } else {
    fail('membership status is unsupported');
  }
  return record as unknown as OrganizationMembershipSummaryV1;
}

export function validateOrganizationMembershipPage(
  value: unknown,
): OrganizationMembershipPageV1 {
  return validateUniquePage(
    value,
    'membership page',
    validateOrganizationMembershipSummary,
    'membership_id',
    'a membership',
    'organization_id',
  );
}

export function validateOrganizationAuditEntrySummary(
  value: unknown,
): OrganizationAuditEntrySummaryV1 {
  const record = asRecord(value, 'audit entry summary');
  assertExactKeys(
    record,
    [
      'audit_sequence',
      'occurred_at',
      'actor_kind',
      'action',
      'subject_id',
      'detail',
    ],
    'audit entry summary',
  );
  assertPositiveInteger(record.audit_sequence, 'audit sequence');
  assertTimestamp(record.occurred_at, 'audit occurred_at');
  if (
    record.actor_kind !== 'admin' &&
    record.actor_kind !== 'enrollment_grant' &&
    record.actor_kind !== 'installation'
  ) {
    fail('audit actor_kind is unsupported');
  }
  assertString(record.action, 'audit action', 100);
  if (!/^[a-z][a-z0-9_.]*$/.test(record.action as string)) {
    fail('audit action is invalid');
  }
  assertString(record.subject_id, 'audit subject_id', 200);
  return {
    audit_sequence: record.audit_sequence as number,
    occurred_at: record.occurred_at as string,
    actor_kind:
      record.actor_kind as OrganizationAuditEntrySummaryV1['actor_kind'],
    action: record.action as string,
    subject_id: record.subject_id as string,
    detail: validateJsonValue(record.detail, 'audit detail', { nodes: 0 }),
  };
}

export function validateOrganizationAuditPage(
  value: unknown,
): OrganizationAuditPageV1 {
  return validateUniquePage(
    value,
    'audit page',
    validateOrganizationAuditEntrySummary,
    'audit_sequence',
    'an audit entry',
    null,
  );
}
