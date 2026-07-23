import {
  organizationEnrollmentGrantSha256,
  validateOrganizationAuthorityDescriptor,
  validateOrganizationEnrollmentReceipt,
  validateOrganizationEnrollmentRequest,
  validateOrganizationInstallationAccessState,
} from '@echo-brain/organization-protocol';
import type { JsonValue } from '@echo-brain/federation-protocol';
import type {
  CompleteOrganizationEnrollmentRequestV1,
  CompletedOrganizationEnrollmentV1,
  IssueOrganizationEnrollmentGrantRequestV1,
  IssuedOrganizationEnrollmentGrantV1,
  OrganizationAccessLeaseRequestV1,
  OrganizationAccessLeaseResponseV1,
  OrganizationAdminOverviewCountsV1,
  OrganizationAdminOverviewV1,
  OrganizationApiErrorV1,
  OrganizationApiSignedIntegrityV1,
  OrganizationAuditEntrySummaryV1,
  OrganizationAuditPageV1,
  OrganizationAuthorityDescriptorResponseV1,
  OrganizationEnrollmentGrantPageV1,
  OrganizationEnrollmentGrantSummaryV1,
  OrganizationEnrollmentInvitationV1,
  OrganizationInstallationPageV1,
  OrganizationInstallationSummaryV1,
  OrganizationMembershipPageV1,
  OrganizationMembershipSummaryV1,
  ProvisionedOrganizationMembershipV1,
  ProvisionOrganizationMembershipRequestV1,
  RevokeOrganizationSubjectRequestV1,
  RevokedOrganizationInstallationV1,
  RevokedOrganizationMembershipV1,
} from './contracts.js';

export const MAX_ORGANIZATION_API_BODY_BYTES = 16 * 1024;
export const MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
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

export function validateIssueOrganizationEnrollmentGrantRequest(
  value: unknown,
): IssueOrganizationEnrollmentGrantRequestV1 {
  const record = asRecord(value, 'enrollment grant request');
  assertExactKeys(
    record,
    ['command_id', 'enrollment_grant_sha256', 'lifetime_seconds'],
    'enrollment grant request',
  );
  assertId(record.command_id, 'adm', 'enrollment grant command_id');
  assertDigest(
    record.enrollment_grant_sha256,
    'enrollment grant request digest',
  );
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
      'enrollment_grant_sha256',
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
  assertDigest(record.enrollment_grant_sha256, 'enrollment grant digest');
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

function decodeEnrollmentGrant(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length !== 43 ||
    !BASE64URL_PATTERN.test(value) ||
    !BASE64URL_THREE_CHARACTER_TAIL_PATTERN.test(value.at(-1)!)
  ) {
    fail('invitation enrollment grant must be canonical 32-byte base64url');
  }
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const output = new Uint8Array(32);
  let accumulator = 0;
  let bitCount = 0;
  let outputIndex = 0;
  for (const character of value) {
    const sextet = alphabet.indexOf(character);
    if (sextet < 0) {
      fail('invitation enrollment grant must be canonical 32-byte base64url');
    }
    accumulator = (accumulator << 6) | sextet;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      if (outputIndex >= output.length) {
        fail('invitation enrollment grant must be canonical 32-byte base64url');
      }
      output[outputIndex] = (accumulator >> bitCount) & 0xff;
      outputIndex += 1;
      accumulator &= (1 << bitCount) - 1;
    }
  }
  if (outputIndex !== output.length || bitCount !== 2 || accumulator !== 0) {
    fail('invitation enrollment grant must be canonical 32-byte base64url');
  }
  return output;
}

export function validateOrganizationEnrollmentInvitation(
  value: unknown,
): OrganizationEnrollmentInvitationV1 {
  const record = asRecord(value, 'organization enrollment invitation');
  assertExactKeys(
    record,
    [
      'schema_version',
      'kind',
      'status',
      'authority_base_url',
      'authority_id',
      'authority_pin_sha256',
      'authority_pin_verification',
      'organization_id',
      'membership_id',
      'command_id',
      'enrollment_grant_sha256',
      'enrollment_grant_base64url',
      'lifetime_seconds',
      'issued',
    ],
    'organization enrollment invitation',
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-enrollment-invitation'
  ) {
    fail('organization enrollment invitation identity is unsupported');
  }
  if (record.status !== 'pending_registration' && record.status !== 'issued') {
    fail('organization enrollment invitation status is unsupported');
  }
  const authorityBaseUrl = validateOrganizationAuthorityOrigin(
    record.authority_base_url,
  );
  assertId(record.authority_id, 'oau', 'invitation authority_id');
  assertDigest(record.authority_pin_sha256, 'invitation authority pin');
  if (record.authority_pin_verification !== 'independent_pin_required') {
    fail('invitation must require independent authority PIN verification');
  }
  assertId(record.organization_id, 'org', 'invitation organization_id');
  assertId(record.membership_id, 'mem', 'invitation membership_id');
  assertId(record.command_id, 'adm', 'invitation command_id');
  assertDigest(
    record.enrollment_grant_sha256,
    'invitation enrollment grant digest',
  );
  assertPositiveInteger(record.lifetime_seconds, 'invitation lifetime');
  if (
    (record.lifetime_seconds as number) > MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS
  ) {
    fail('invitation lifetime exceeds the maximum');
  }
  const enrollmentGrant = decodeEnrollmentGrant(
    record.enrollment_grant_base64url,
  );
  if (
    organizationEnrollmentGrantSha256(enrollmentGrant) !==
    record.enrollment_grant_sha256
  ) {
    fail('invitation enrollment grant digest does not match its bytes');
  }
  let issued: IssuedOrganizationEnrollmentGrantV1 | null;
  if (record.status === 'pending_registration') {
    if (record.issued !== null) {
      fail('pending invitation cannot contain an issuance result');
    }
    issued = null;
  } else {
    if (record.issued === null) {
      fail('issued invitation requires an issuance result');
    }
    issued = validateIssuedOrganizationEnrollmentGrant(record.issued);
    if (
      issued.authority_id !== record.authority_id ||
      issued.authority_pin_sha256 !== record.authority_pin_sha256 ||
      issued.organization_id !== record.organization_id ||
      issued.membership_id !== record.membership_id ||
      issued.enrollment_grant_sha256 !== record.enrollment_grant_sha256
    ) {
      fail('invitation issuance result does not match its invitation');
    }
    if (
      Date.parse(issued.expires_at) - Date.parse(issued.issued_at) !==
      (record.lifetime_seconds as number) * 1000
    ) {
      fail('invitation issuance lifetime does not match its intent');
    }
  }
  return {
    schema_version: 1,
    kind: 'echo-organization-enrollment-invitation',
    status: record.status,
    authority_base_url: authorityBaseUrl,
    authority_id: record.authority_id as string,
    authority_pin_sha256:
      record.authority_pin_sha256 as OrganizationEnrollmentInvitationV1['authority_pin_sha256'],
    authority_pin_verification: 'independent_pin_required',
    organization_id: record.organization_id as string,
    membership_id: record.membership_id as string,
    command_id: record.command_id as string,
    enrollment_grant_sha256:
      record.enrollment_grant_sha256 as OrganizationEnrollmentInvitationV1['enrollment_grant_sha256'],
    enrollment_grant_base64url: record.enrollment_grant_base64url as string,
    lifetime_seconds: record.lifetime_seconds as number,
    issued,
  };
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
  const page = validatePage(
    value,
    'membership page',
    validateOrganizationMembershipSummary,
  );
  if (
    new Set(page.items.map((item) => item.membership_id)).size !==
    page.items.length
  ) {
    fail('membership page repeats a membership');
  }
  if (new Set(page.items.map((item) => item.organization_id)).size > 1) {
    fail('membership page crosses organizations');
  }
  return page;
}

export function validateOrganizationInstallationSummary(
  value: unknown,
): OrganizationInstallationSummaryV1 {
  const record = asRecord(value, 'installation summary');
  assertExactKeys(
    record,
    [
      'organization_id',
      'principal_id',
      'membership_id',
      'enrollment_id',
      'installation_id',
      'installation_key_id',
      'status',
      'enrolled_at',
      'revoked_at',
      'revocation_kind',
      'revocation_reason',
      'current_access_sequence',
      'current_access_status',
      'current_access_valid_until',
    ],
    'installation summary',
  );
  assertId(record.organization_id, 'org', 'installation organization_id');
  assertId(record.principal_id, 'prn', 'installation principal_id');
  assertId(record.membership_id, 'mem', 'installation membership_id');
  assertId(record.enrollment_id, 'enr', 'installation enrollment_id');
  assertId(record.installation_id, 'ins', 'installation installation_id');
  assertDigest(record.installation_key_id, 'installation key_id');
  assertTimestamp(record.enrolled_at, 'installation enrolled_at');
  assertPositiveInteger(
    record.current_access_sequence,
    'installation current_access_sequence',
  );
  if (record.status === 'active') {
    if (
      record.revoked_at !== null ||
      record.revocation_kind !== null ||
      record.revocation_reason !== null
    ) {
      fail('active installation must not contain revocation fields');
    }
  } else if (record.status === 'revoked') {
    assertTimestamp(record.revoked_at, 'installation revoked_at');
    if (
      record.revocation_kind !== 'membership_revoked' &&
      record.revocation_kind !== 'installation_revoked'
    ) {
      fail('installation revocation_kind is unsupported');
    }
    assertString(
      record.revocation_reason,
      'installation revocation_reason',
      500,
    );
    if (
      Date.parse(record.revoked_at as string) <
      Date.parse(record.enrolled_at as string)
    ) {
      fail('installation revocation predates enrollment');
    }
  } else {
    fail('installation status is unsupported');
  }
  if (record.current_access_status === 'active') {
    assertTimestamp(
      record.current_access_valid_until,
      'installation current_access_valid_until',
    );
  } else if (record.current_access_status === 'revoked') {
    if (record.current_access_valid_until !== null) {
      fail('revoked installation access must not have a valid_until');
    }
  } else {
    fail('installation current_access_status is unsupported');
  }
  if (record.current_access_status !== record.status) {
    fail('installation and current access statuses are inconsistent');
  }
  return record as unknown as OrganizationInstallationSummaryV1;
}

export function validateOrganizationInstallationPage(
  value: unknown,
): OrganizationInstallationPageV1 {
  const page = validatePage(
    value,
    'installation page',
    validateOrganizationInstallationSummary,
  );
  if (
    new Set(page.items.map((item) => item.installation_id)).size !==
    page.items.length
  ) {
    fail('installation page repeats an installation');
  }
  if (new Set(page.items.map((item) => item.organization_id)).size > 1) {
    fail('installation page crosses organizations');
  }
  return page;
}

export function validateOrganizationEnrollmentGrantSummary(
  value: unknown,
): OrganizationEnrollmentGrantSummaryV1 {
  const record = asRecord(value, 'enrollment grant summary');
  assertExactKeys(
    record,
    [
      'organization_id',
      'principal_id',
      'membership_id',
      'enrollment_grant_sha256',
      'issued_at',
      'expires_at',
      'consumed_at',
      'status',
    ],
    'enrollment grant summary',
  );
  assertId(record.organization_id, 'org', 'grant organization_id');
  assertId(record.principal_id, 'prn', 'grant principal_id');
  assertId(record.membership_id, 'mem', 'grant membership_id');
  assertDigest(record.enrollment_grant_sha256, 'enrollment grant digest');
  assertTimestamp(record.issued_at, 'grant issued_at');
  assertTimestamp(record.expires_at, 'grant expires_at');
  if (
    Date.parse(record.expires_at as string) <=
    Date.parse(record.issued_at as string)
  ) {
    fail('enrollment grant expiry must follow issuance');
  }
  if (record.status === 'consumed') {
    assertTimestamp(record.consumed_at, 'grant consumed_at');
    const consumed = Date.parse(record.consumed_at as string);
    if (
      consumed < Date.parse(record.issued_at as string) ||
      consumed >= Date.parse(record.expires_at as string)
    ) {
      fail('enrollment grant consumption is outside its lifetime');
    }
  } else if (record.status === 'pending' || record.status === 'expired') {
    if (record.consumed_at !== null) {
      fail('unconsumed enrollment grant must not have consumed_at');
    }
  } else {
    fail('enrollment grant status is unsupported');
  }
  return record as unknown as OrganizationEnrollmentGrantSummaryV1;
}

export function validateOrganizationEnrollmentGrantPage(
  value: unknown,
): OrganizationEnrollmentGrantPageV1 {
  const page = validatePage(
    value,
    'enrollment grant page',
    validateOrganizationEnrollmentGrantSummary,
  );
  if (
    new Set(page.items.map((item) => item.enrollment_grant_sha256)).size !==
    page.items.length
  ) {
    fail('enrollment grant page repeats a grant');
  }
  if (new Set(page.items.map((item) => item.organization_id)).size > 1) {
    fail('enrollment grant page crosses organizations');
  }
  return page;
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
  const page = validatePage(
    value,
    'audit page',
    validateOrganizationAuditEntrySummary,
  );
  if (
    new Set(page.items.map((item) => item.audit_sequence)).size !==
    page.items.length
  ) {
    fail('audit page repeats an audit entry');
  }
  return page;
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
