import { validateOrganizationEnrollmentRequest } from '@echo-brain/organization-protocol';
import type {
  CompleteOrganizationEnrollmentRequestV1,
  IssueOrganizationEnrollmentGrantRequestV1,
  OrganizationAccessLeaseRequestV1,
  OrganizationApiSignedIntegrityV1,
  ProvisionOrganizationMembershipRequestV1,
  RevokeOrganizationSubjectRequestV1,
} from './contracts.js';

export const MAX_ORGANIZATION_API_BODY_BYTES = 16 * 1024;
export const MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(message: string): never {
  throw new Error(`organization API: ${message}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
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

function assertExactKeys(
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

function assertString(
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

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertId(value: unknown, prefix: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !value.startsWith(`${prefix}_`) ||
    !UUID_V4_PATTERN.test(value.slice(prefix.length + 1))
  ) {
    fail(`${label} must be a canonical ${prefix} identifier`);
  }
}

function assertTimestamp(
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

function validateIntegrity(value: unknown): OrganizationApiSignedIntegrityV1 {
  const record = asRecord(value, 'access lease request integrity');
  assertExactKeys(
    record,
    [
      'canonicalization',
      'payload_sha256',
      'signature_algorithm',
      'key_id',
      'signature_base64',
    ],
    'access lease request integrity',
  );
  if (record.canonicalization !== 'RFC8785') {
    fail('access lease request canonicalization is unsupported');
  }
  if (record.signature_algorithm !== 'ecdsa-p256-sha256-der-low-s') {
    fail('access lease request signature algorithm is unsupported');
  }
  assertDigest(record.payload_sha256, 'access lease request payload digest');
  assertDigest(record.key_id, 'access lease request integrity key');
  if (
    typeof record.signature_base64 !== 'string' ||
    record.signature_base64.length < 8 ||
    record.signature_base64.length > 256 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(record.signature_base64)
  ) {
    fail('access lease request signature is not bounded base64');
  }
  return record as unknown as OrganizationApiSignedIntegrityV1;
}

export function validateOrganizationAccessLeaseRequest(
  value: unknown,
): OrganizationAccessLeaseRequestV1 {
  const record = asRecord(value, 'access lease request');
  assertExactKeys(
    record,
    [
      'schema_version',
      'kind',
      'request_id',
      'authority_id',
      'authority_key_id',
      'organization_id',
      'enrollment_id',
      'installation_id',
      'installation_key_id',
      'previous_access_state_sha256',
      'requested_at',
      'integrity',
    ],
    'access lease request',
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-access-lease-request'
  ) {
    fail('access lease request version or kind is unsupported');
  }
  assertId(record.request_id, 'alr', 'access lease request request_id');
  assertId(record.authority_id, 'oau', 'access lease request authority_id');
  assertDigest(
    record.authority_key_id,
    'access lease request authority_key_id',
  );
  assertId(
    record.organization_id,
    'org',
    'access lease request organization_id',
  );
  assertId(record.enrollment_id, 'enr', 'access lease request enrollment_id');
  assertId(
    record.installation_id,
    'ins',
    'access lease request installation_id',
  );
  assertDigest(
    record.installation_key_id,
    'access lease request installation_key_id',
  );
  assertDigest(
    record.previous_access_state_sha256,
    'access lease request previous state digest',
  );
  assertTimestamp(record.requested_at, 'access lease request requested_at');
  const integrity = validateIntegrity(record.integrity);
  if (integrity.key_id !== record.installation_key_id) {
    fail('access lease request signature key does not match installation key');
  }
  return {
    ...record,
    integrity,
  } as unknown as OrganizationAccessLeaseRequestV1;
}

export function validateProvisionOrganizationMembershipRequest(
  value: unknown,
): ProvisionOrganizationMembershipRequestV1 {
  const record = asRecord(value, 'membership request');
  assertExactKeys(
    record,
    ['display_name', 'membership_type'],
    'membership request',
  );
  assertString(record.display_name, 'membership display_name', 200);
  if (
    record.membership_type !== 'owner' &&
    record.membership_type !== 'employee'
  ) {
    fail('membership_type is unsupported');
  }
  return record as unknown as ProvisionOrganizationMembershipRequestV1;
}

export function validateIssueOrganizationEnrollmentGrantRequest(
  value: unknown,
): IssueOrganizationEnrollmentGrantRequestV1 {
  const record = asRecord(value, 'enrollment grant request');
  assertExactKeys(record, ['lifetime_seconds'], 'enrollment grant request');
  if (
    !Number.isSafeInteger(record.lifetime_seconds) ||
    (record.lifetime_seconds as number) <= 0 ||
    (record.lifetime_seconds as number) > MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS
  ) {
    fail(
      `enrollment grant lifetime_seconds must be between 1 and ${MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS}`,
    );
  }
  return record as unknown as IssueOrganizationEnrollmentGrantRequestV1;
}

export function validateCompleteOrganizationEnrollmentRequest(
  value: unknown,
): CompleteOrganizationEnrollmentRequestV1 {
  const record = asRecord(value, 'complete enrollment request');
  assertExactKeys(
    record,
    ['enrollment_request'],
    'complete enrollment request',
  );
  try {
    return {
      enrollment_request: validateOrganizationEnrollmentRequest(
        record.enrollment_request,
      ),
    };
  } catch {
    fail('enrollment_request is invalid');
  }
}

export function validateRevokeOrganizationSubjectRequest(
  value: unknown,
): RevokeOrganizationSubjectRequestV1 {
  const record = asRecord(value, 'revocation request');
  assertExactKeys(record, ['reason'], 'revocation request');
  assertString(record.reason, 'revocation reason', 500);
  return record as unknown as RevokeOrganizationSubjectRequestV1;
}
