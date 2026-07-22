import {
  validateOrganizationAuthorityDescriptor,
  validateOrganizationEnrollmentReceipt,
  validateOrganizationEnrollmentRequest,
  validateOrganizationInstallationAccessState,
} from '@echo-brain/organization-protocol';
import type {
  CompleteOrganizationEnrollmentRequestV1,
  CompletedOrganizationEnrollmentV1,
  IssueOrganizationEnrollmentGrantRequestV1,
  IssuedOrganizationEnrollmentGrantV1,
  OrganizationAccessLeaseRequestV1,
  OrganizationAccessLeaseResponseV1,
  OrganizationApiErrorV1,
  OrganizationApiSignedIntegrityV1,
  OrganizationAuthorityDescriptorResponseV1,
  ProvisionedOrganizationMembershipV1,
  ProvisionOrganizationMembershipRequestV1,
  RevokeOrganizationSubjectRequestV1,
  RevokedOrganizationInstallationV1,
  RevokedOrganizationMembershipV1,
} from './contracts.js';

export const MAX_ORGANIZATION_API_BODY_BYTES = 16 * 1024;
export const MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// A 32-byte value encodes to 43 unpadded base64url characters. The final
// character carries four data bits, so its two unused low bits must be zero.
const CANONICAL_BASE64URL_32_BYTES_PATTERN =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

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

function validateInnerDocument<T>(label: string, validate: () => T): T {
  try {
    return validate();
  } catch {
    fail(`${label} is invalid`);
  }
}

function validateMembershipType(value: unknown, label: string): void {
  if (value !== 'owner' && value !== 'employee') {
    fail(`${label} is unsupported`);
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

export function validateCompletedOrganizationEnrollment(
  value: unknown,
): CompletedOrganizationEnrollmentV1 {
  const record = asRecord(value, 'completed enrollment response');
  assertExactKeys(
    record,
    ['enrollment_receipt', 'access_state'],
    'completed enrollment response',
  );
  return {
    enrollment_receipt: validateInnerDocument(
      'completed enrollment response enrollment_receipt',
      () => validateOrganizationEnrollmentReceipt(record.enrollment_receipt),
    ),
    access_state: validateInnerDocument(
      'completed enrollment response access_state',
      () => validateOrganizationInstallationAccessState(record.access_state),
    ),
  };
}

export function validateOrganizationAccessLeaseResponse(
  value: unknown,
): OrganizationAccessLeaseResponseV1 {
  const record = asRecord(value, 'access lease response');
  assertExactKeys(record, ['access_state'], 'access lease response');
  return {
    access_state: validateInnerDocument(
      'access lease response access_state',
      () => validateOrganizationInstallationAccessState(record.access_state),
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

export function validateIssuedOrganizationEnrollmentGrant(
  value: unknown,
): IssuedOrganizationEnrollmentGrantV1 {
  const record = asRecord(value, 'issued enrollment grant response');
  assertExactKeys(
    record,
    [
      'authority_id',
      'authority_pin_sha256',
      'organization_id',
      'principal_id',
      'membership_id',
      'enrollment_grant_base64url',
      'issued_at',
      'expires_at',
    ],
    'issued enrollment grant response',
  );
  assertId(record.authority_id, 'oau', 'grant authority_id');
  assertDigest(record.authority_pin_sha256, 'grant authority pin');
  assertId(record.organization_id, 'org', 'grant organization_id');
  assertId(record.principal_id, 'prn', 'grant principal_id');
  assertId(record.membership_id, 'mem', 'grant membership_id');
  if (
    typeof record.enrollment_grant_base64url !== 'string' ||
    !CANONICAL_BASE64URL_32_BYTES_PATTERN.test(
      record.enrollment_grant_base64url,
    )
  ) {
    fail('enrollment grant must be canonical base64url for 32 bytes');
  }
  assertTimestamp(record.issued_at, 'grant issued_at');
  assertTimestamp(record.expires_at, 'grant expires_at');
  if (
    Date.parse(record.expires_at as string) <=
    Date.parse(record.issued_at as string)
  ) {
    fail('enrollment grant expiry must follow issuance');
  }
  return record as unknown as IssuedOrganizationEnrollmentGrantV1;
}

export function validateRevokedOrganizationInstallation(
  value: unknown,
): RevokedOrganizationInstallationV1 {
  const record = asRecord(value, 'revoked installation response');
  assertExactKeys(
    record,
    ['installation_id', 'access_state'],
    'revoked installation response',
  );
  assertId(record.installation_id, 'ins', 'revoked installation_id');
  const accessState = validateInnerDocument(
    'revoked installation response access_state',
    () => validateOrganizationInstallationAccessState(record.access_state),
  );
  if (accessState.installation_id !== record.installation_id) {
    fail('revoked installation response binds another installation');
  }
  if (accessState.status !== 'revoked') {
    fail('revoked installation response must contain a revoked access state');
  }
  return {
    installation_id: record.installation_id as string,
    access_state: accessState,
  };
}

export function validateRevokedOrganizationMembership(
  value: unknown,
): RevokedOrganizationMembershipV1 {
  const record = asRecord(value, 'revoked membership response');
  assertExactKeys(
    record,
    ['membership', 'installations'],
    'revoked membership response',
  );
  if (!Array.isArray(record.installations)) {
    fail('revoked membership installations must be an array');
  }
  const membership = validateProvisionedOrganizationMembership(
    record.membership,
  );
  if (membership.status !== 'revoked') {
    fail('revoked membership response must contain a revoked membership');
  }
  const installations = record.installations.map((installation) =>
    validateRevokedOrganizationInstallation(installation),
  );
  if (
    new Set(installations.map((installation) => installation.installation_id))
      .size !== installations.length
  ) {
    fail('revoked membership response repeats an installation');
  }
  for (const installation of installations) {
    const state = installation.access_state;
    if (
      state.organization_id !== membership.organization_id ||
      state.principal_id !== membership.principal_id ||
      state.membership_id !== membership.membership_id ||
      state.membership_type !== membership.membership_type
    ) {
      fail(
        'revoked membership response installation belongs to another membership',
      );
    }
  }
  return { membership, installations };
}
