import {
  isOrganizationProtocolValidationError,
  organizationEnrollmentGrantSha256,
  validateOrganizationAuthorityDescriptor,
  validateOrganizationEnrollmentReceipt,
  validateOrganizationEnrollmentRequest,
  validateOrganizationInstallationAccessState,
  MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
} from '@echo-brain/organization-protocol';
import type { JsonValue } from '@echo-brain/federation-protocol';
import type {
  AcceptedOrganizationRecordV1,
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
  OrganizationPermissionCheckDecisionV1,
  OrganizationPermissionCheckRequestV1,
  OrganizationRecordRejectionCodeV1,
  OrganizationSlackLinkBeginRequestV1,
  OrganizationSlackLinkBeginResponseV1,
  OrganizationSlackLinkCompleteRequestV1,
  OrganizationSlackLinkResultV1,
  ProvisionedOrganizationMembershipV1,
  ProvisionOrganizationMembershipRequestV1,
  RevokeOrganizationSubjectRequestV1,
  RevokedOrganizationInstallationV1,
  RevokedOrganizationMembershipV1,
  SubmitOrganizationRecordEnvelopeRequestV1,
} from './contracts.js';
import { organizationPermissionProviderEventSha256 } from './permission-check-event.js';
import { isCanonicalOrganizationSlackLinkChallengeCode } from './slack-link-challenge-code.js';

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

function fail(message: string, cause?: unknown): never {
  throw new OrganizationApiValidationError(message, { cause });
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

function assertPatternString(
  value: unknown,
  label: string,
  maximumLength: number,
  pattern: RegExp,
): asserts value is string {
  assertString(value, label, maximumLength);
  if (!pattern.test(value)) fail(`${label} is invalid`);
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

function validateIntegrity(
  value: unknown,
  documentLabel = 'access lease request',
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

export function validateOrganizationPermissionCheckRequest(
  value: unknown,
): OrganizationPermissionCheckRequestV1 {
  const label = 'permission check request';
  const record = asRecord(value, label);
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
      'provider',
      'provider_issuer',
      'provider_tenant_kind',
      'provider_tenant_id',
      'provider_enterprise_id',
      'provider_connection_subject_id',
      'provider_connection_bot_id',
      'provider_connection_app_id',
      'provider_subject_kind',
      'provider_subject_id',
      'adapter_kind',
      'adapter_id',
      'adapter_instance_id',
      'adapter_version',
      'action',
      'approval_id',
      'channel_id',
      'message_ts',
      'reaction_name',
      'provider_event_sha256',
      'requested_at',
      'integrity',
    ],
    label,
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-permission-check-request'
  ) {
    fail('permission check request version or kind is unsupported');
  }
  assertId(record.request_id, 'pcr', 'permission check request request_id');
  assertId(record.authority_id, 'oau', 'permission check request authority_id');
  assertDigest(
    record.authority_key_id,
    'permission check request authority_key_id',
  );
  assertId(
    record.organization_id,
    'org',
    'permission check request organization_id',
  );
  assertId(
    record.enrollment_id,
    'enr',
    'permission check request enrollment_id',
  );
  assertId(
    record.installation_id,
    'ins',
    'permission check request installation_id',
  );
  assertDigest(
    record.installation_key_id,
    'permission check request installation_key_id',
  );
  if (
    record.provider !== 'slack' ||
    record.provider_issuer !== 'https://slack.com' ||
    record.provider_tenant_kind !== 'workspace' ||
    record.provider_subject_kind !== 'human_user' ||
    record.adapter_kind !== 'approval-surface'
  ) {
    fail('permission check request provider or adapter kind is unsupported');
  }
  assertPatternString(
    record.provider_tenant_id,
    'permission check request provider_tenant_id',
    128,
    /^T[A-Z0-9]{2,}$/,
  );
  if (record.provider_enterprise_id !== null) {
    assertPatternString(
      record.provider_enterprise_id,
      'permission check request provider_enterprise_id',
      128,
      /^E[A-Z0-9]{2,}$/,
    );
  }
  assertPatternString(
    record.provider_connection_subject_id,
    'permission check request provider_connection_subject_id',
    128,
    /^[UW][A-Z0-9]{2,}$/,
  );
  assertPatternString(
    record.provider_connection_bot_id,
    'permission check request provider_connection_bot_id',
    128,
    /^B[A-Z0-9]{2,}$/,
  );
  if (record.provider_connection_app_id !== null) {
    assertPatternString(
      record.provider_connection_app_id,
      'permission check request provider_connection_app_id',
      128,
      /^A[A-Z0-9]{2,}$/,
    );
  }
  assertPatternString(
    record.provider_subject_id,
    'permission check request provider_subject_id',
    128,
    /^[UW][A-Z0-9]{2,}$/,
  );
  assertString(record.adapter_id, 'permission check request adapter_id', 128);
  assertString(
    record.adapter_instance_id,
    'permission check request adapter_instance_id',
    128,
  );
  assertString(
    record.adapter_version,
    'permission check request adapter_version',
    64,
  );
  if (record.action !== 'approve' && record.action !== 'reject') {
    fail('permission check request action is unsupported');
  }
  assertPatternString(
    record.approval_id,
    'permission check request approval_id',
    256,
    /^[0-9a-f]{64}$/,
  );
  assertString(record.channel_id, 'permission check request channel_id', 128);
  assertPatternString(
    record.message_ts,
    'permission check request message_ts',
    64,
    /^\d{1,16}\.\d{1,16}$/,
  );
  assertPatternString(
    record.reaction_name,
    'permission check request reaction_name',
    64,
    /^[a-z0-9_+-]+$/,
  );
  assertDigest(
    record.provider_event_sha256,
    'permission check request provider_event_sha256',
  );
  const derivedProviderEventSha256 =
    organizationPermissionProviderEventSha256(
      record as unknown as OrganizationPermissionCheckRequestV1,
    );
  if (record.provider_event_sha256 !== derivedProviderEventSha256) {
    fail(
      'permission check request provider_event_sha256 does not match its event',
    );
  }
  assertTimestamp(
    record.requested_at,
    'permission check request requested_at',
  );
  const integrity = validateIntegrity(record.integrity, label);
  if (integrity.key_id !== record.installation_key_id) {
    fail(
      'permission check request signature key does not match installation key',
    );
  }
  return {
    ...record,
    integrity,
  } as unknown as OrganizationPermissionCheckRequestV1;
}

export function validateOrganizationPermissionCheckDecision(
  value: unknown,
): OrganizationPermissionCheckDecisionV1 {
  const label = 'permission check decision';
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      'schema_version',
      'kind',
      'request_sha256',
      'provider_event_sha256',
      'allowed',
      'reason_code',
      'principal_id',
      'membership_id',
      'adapter_binding_id',
      'permission_grant_id',
      'evaluated_at',
    ],
    label,
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-permission-check-decision'
  ) {
    fail('permission check decision version or kind is unsupported');
  }
  assertDigest(record.request_sha256, 'permission check decision request');
  assertDigest(
    record.provider_event_sha256,
    'permission check decision provider event',
  );
  if (typeof record.allowed !== 'boolean') {
    fail('permission check decision allowed must be boolean');
  }
  assertString(record.reason_code, 'permission check decision reason_code', 128);
  if (
    record.principal_id !== null ||
    record.membership_id !== null
  ) {
    assertId(
      record.principal_id,
      'prn',
      'permission check decision principal_id',
    );
    assertId(
      record.membership_id,
      'mem',
      'permission check decision membership_id',
    );
  }
  if (record.adapter_binding_id !== null) {
    assertId(
      record.adapter_binding_id,
      'bnd',
      'permission check decision adapter_binding_id',
    );
  }
  if (record.permission_grant_id !== null) {
    assertId(
      record.permission_grant_id,
      'pgr',
      'permission check decision permission_grant_id',
    );
  }
  if (
    record.allowed &&
    (record.principal_id === null ||
      record.membership_id === null ||
      record.adapter_binding_id === null ||
      record.permission_grant_id === null)
  ) {
    fail('allowed permission check decision requires exact authorization IDs');
  }
  assertTimestamp(
    record.evaluated_at,
    'permission check decision evaluated_at',
  );
  return record as unknown as OrganizationPermissionCheckDecisionV1;
}

function validateSlackLinkRequestIdentity(
  record: Record<string, unknown>,
  label: string,
  requestPrefix: 'slb' | 'slc',
): OrganizationApiSignedIntegrityV1 {
  assertId(record.request_id, requestPrefix, `${label} request_id`);
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertDigest(record.authority_key_id, `${label} authority_key_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.enrollment_id, 'enr', `${label} enrollment_id`);
  assertId(record.installation_id, 'ins', `${label} installation_id`);
  assertDigest(record.installation_key_id, `${label} installation_key_id`);
  assertTimestamp(record.requested_at, `${label} requested_at`);
  const integrity = validateIntegrity(record.integrity, label);
  if (integrity.key_id !== record.installation_key_id) {
    fail(`${label} signature key does not match installation key`);
  }
  return integrity;
}

export function validateOrganizationSlackLinkBeginRequest(
  value: unknown,
): OrganizationSlackLinkBeginRequestV1 {
  const label = 'Slack link begin request';
  const record = asRecord(value, label);
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
      'challenge_code_sha256',
      'requested_at',
      'integrity',
    ],
    label,
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-slack-link-begin-request'
  ) {
    fail('Slack link begin request version or kind is unsupported');
  }
  assertDigest(
    record.challenge_code_sha256,
    'Slack link begin request challenge_code_sha256',
  );
  const integrity = validateSlackLinkRequestIdentity(record, label, 'slb');
  return {
    ...record,
    integrity,
  } as unknown as OrganizationSlackLinkBeginRequestV1;
}

export function validateOrganizationSlackLinkCompleteRequest(
  value: unknown,
): OrganizationSlackLinkCompleteRequestV1 {
  const label = 'Slack link complete request';
  const record = asRecord(value, label);
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
      'challenge_attempt_id',
      'challenge_message_ts',
      'challenge_code',
      'expected_provider_subject_id',
      'adapter_id',
      'adapter_instance_id',
      'adapter_version',
      'requested_at',
      'integrity',
    ],
    label,
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-slack-link-complete-request'
  ) {
    fail('Slack link complete request version or kind is unsupported');
  }
  assertId(
    record.challenge_attempt_id,
    'cat',
    'Slack link complete request challenge_attempt_id',
  );
  assertPatternString(
    record.challenge_message_ts,
    'Slack link complete request challenge_message_ts',
    64,
    /^\d{1,16}\.\d{1,16}$/,
  );
  if (!isCanonicalOrganizationSlackLinkChallengeCode(record.challenge_code)) {
    fail(
      'Slack link complete request challenge_code must be canonical unpadded base64url for exactly 32 bytes',
    );
  }
  assertPatternString(
    record.expected_provider_subject_id,
    'Slack link complete request expected_provider_subject_id',
    128,
    /^[UW][A-Z0-9]{2,}$/,
  );
  if (record.adapter_id !== 'slack-reactions') {
    fail('Slack link complete request adapter_id is unsupported');
  }
  assertPatternString(
    record.adapter_instance_id,
    'Slack link complete request adapter_instance_id',
    128,
    /^[a-z][a-z0-9-]{0,127}$/,
  );
  assertPatternString(
    record.adapter_version,
    'Slack link complete request adapter_version',
    64,
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/,
  );
  const integrity = validateSlackLinkRequestIdentity(record, label, 'slc');
  return {
    ...record,
    integrity,
  } as unknown as OrganizationSlackLinkCompleteRequestV1;
}

export function validateOrganizationSlackLinkBeginResponse(
  value: unknown,
): OrganizationSlackLinkBeginResponseV1 {
  const label = 'Slack link begin response';
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      'schema_version',
      'kind',
      'challenge_attempt_id',
      'provider',
      'provider_tenant_id',
      'channel_id',
      'challenge_message_ts',
      'expires_at',
    ],
    label,
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-slack-link-begin-response' ||
    record.provider !== 'slack'
  ) {
    fail('Slack link begin response version, kind, or provider is unsupported');
  }
  assertId(
    record.challenge_attempt_id,
    'cat',
    'Slack link begin response challenge_attempt_id',
  );
  assertPatternString(
    record.provider_tenant_id,
    'Slack link begin response provider_tenant_id',
    128,
    /^T[A-Z0-9]{2,}$/,
  );
  assertPatternString(
    record.channel_id,
    'Slack link begin response channel_id',
    128,
    /^C[A-Z0-9]{2,}$/,
  );
  assertPatternString(
    record.challenge_message_ts,
    'Slack link begin response challenge_message_ts',
    64,
    /^\d{1,16}\.\d{1,16}$/,
  );
  assertTimestamp(record.expires_at, 'Slack link begin response expires_at');
  return record as unknown as OrganizationSlackLinkBeginResponseV1;
}

export function validateOrganizationSlackLinkResult(
  value: unknown,
): OrganizationSlackLinkResultV1 {
  const label = 'Slack link result';
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      'schema_version',
      'kind',
      'identity_link_id',
      'connection_id',
      'adapter_binding_id',
      'organization_id',
      'principal_id',
      'membership_id',
      'installation_id',
      'provider',
      'provider_tenant_id',
      'provider_subject_id',
      'channel_id',
      'linked_at',
      'identity_link_created',
      'adapter_binding_created',
      'permission_grants_created',
    ],
    label,
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-slack-link-result' ||
    record.provider !== 'slack'
  ) {
    fail('Slack link result version, kind, or provider is unsupported');
  }
  assertId(record.identity_link_id, 'clm', 'Slack link result identity_link_id');
  assertId(record.connection_id, 'con', 'Slack link result connection_id');
  assertId(
    record.adapter_binding_id,
    'bnd',
    'Slack link result adapter_binding_id',
  );
  assertId(record.organization_id, 'org', 'Slack link result organization_id');
  assertId(record.principal_id, 'prn', 'Slack link result principal_id');
  assertId(record.membership_id, 'mem', 'Slack link result membership_id');
  assertId(record.installation_id, 'ins', 'Slack link result installation_id');
  assertPatternString(
    record.provider_tenant_id,
    'Slack link result provider_tenant_id',
    128,
    /^T[A-Z0-9]{2,}$/,
  );
  assertPatternString(
    record.provider_subject_id,
    'Slack link result provider_subject_id',
    128,
    /^[UW][A-Z0-9]{2,}$/,
  );
  assertPatternString(
    record.channel_id,
    'Slack link result channel_id',
    128,
    /^C[A-Z0-9]{2,}$/,
  );
  assertTimestamp(record.linked_at, 'Slack link result linked_at');
  if (
    typeof record.identity_link_created !== 'boolean' ||
    typeof record.adapter_binding_created !== 'boolean'
  ) {
    fail('Slack link result creation flags must be boolean');
  }
  if (record.permission_grants_created !== 0) {
    fail('Slack link result permission_grants_created must be zero');
  }
  return record as unknown as OrganizationSlackLinkResultV1;
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
  return {
    enrollment_request: validateInnerDocument(
      'enrollment_request',
      () =>
        validateOrganizationEnrollmentRequest(record.enrollment_request),
    ),
  };
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
  return validateUniquePage(
    value,
    'membership page',
    validateOrganizationMembershipSummary,
    'membership_id',
    'a membership',
    'organization_id',
  );
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
  return validateUniquePage(
    value,
    'installation page',
    validateOrganizationInstallationSummary,
    'installation_id',
    'an installation',
    'organization_id',
  );
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
  return validateUniquePage(
    value,
    'enrollment grant page',
    validateOrganizationEnrollmentGrantSummary,
    'enrollment_grant_sha256',
    'a grant',
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

/**
 * The exact byte cost of wrapping a canonical envelope in the request DTO:
 * `{"record_envelope":` is 19 bytes and the closing `}` is one more. The
 * wrapper is the compact form both this package's client and the route's
 * `JSON.stringify` produce; no whitespace is ever inserted between them.
 */
export const ORGANIZATION_RECORD_ENVELOPE_WRAPPER_BYTES =
  '{"record_envelope":}'.length;

/**
 * The record ingest route is the one exemption to the shared body limit: an
 * approved brief with verbatim evidence spans routinely exceeds 16 KiB. It
 * bounds raw bytes before JSON parsing, and only on that route.
 *
 * Two different limits with two different jobs, and they are deliberately not
 * the same number:
 *
 * - `MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES` (256 KiB) bounds the *canonical
 *   envelope* — the signed document itself, measured in RFC 8785 bytes. That is
 *   the durable contract: it is what the protocol validator enforces and what
 *   the log stores.
 * - This limit bounds the *raw HTTP request body*, which is that envelope
 *   already wrapped in `{"record_envelope": ...}`. Setting the two equal would
 *   make the documented 256 KiB envelope unsendable, because its wrapper is 20
 *   bytes longer than the thing the contract measures.
 *
 * So the raw cap is exactly the document cap plus the wrapper, and nothing
 * more: an envelope one canonical byte over the document cap is still refused,
 * just semantically (`record_envelope_invalid` / `record_envelope_too_large`
 * from the validator) rather than by a raw byte count that cannot tell an
 * oversize envelope from an oversize wrapper. The shared
 * `MAX_ORGANIZATION_API_BODY_BYTES` is untouched on every other route.
 */
export const MAX_ORGANIZATION_RECORD_API_BODY_BYTES =
  MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES +
  ORGANIZATION_RECORD_ENVELOPE_WRAPPER_BYTES;

export const ORGANIZATION_RECORD_PERMANENT_REJECTION_CODES = [
  'record_authorization_invalid',
  'record_envelope_invalid',
  'record_envelope_too_large',
  'record_idempotency_conflict',
  'record_signature_invalid',
] as const satisfies readonly OrganizationRecordRejectionCodeV1[];

/**
 * A terminal outcome is decided by an exact code, never by matching message
 * text. Anything else -- an expired lease, a transport fault -- leaves the
 * frozen envelope retryable instead of writing a permanent-rejection slot.
 */
export function isOrganizationRecordPermanentRejectionCode(
  value: unknown,
): value is OrganizationRecordRejectionCodeV1 {
  return (
    typeof value === 'string' &&
    (
      ORGANIZATION_RECORD_PERMANENT_REJECTION_CODES as readonly string[]
    ).includes(value)
  );
}

export function validateSubmitOrganizationRecordEnvelopeRequest(
  value: unknown,
): SubmitOrganizationRecordEnvelopeRequestV1 {
  const record = asRecord(value, 'record submission request');
  assertExactKeys(record, ['record_envelope'], 'record submission request');
  return {
    // The API owns only the DTO wrapper. The Authority is the single owner of
    // envelope schema, canonical-size, authority-binding, and signature
    // validation before append.
    record_envelope:
      record.record_envelope as SubmitOrganizationRecordEnvelopeRequestV1['record_envelope'],
  };
}

export function validateAcceptedOrganizationRecord(
  value: unknown,
): AcceptedOrganizationRecordV1 {
  const record = asRecord(value, 'accepted record response');
  assertExactKeys(record, ['record_receipt'], 'accepted record response');
  return {
    // The API owns only the DTO wrapper. Clients validate and verify the
    // protocol receipt against their pinned authority and submitted envelope.
    record_receipt:
      record.record_receipt as AcceptedOrganizationRecordV1['record_receipt'],
  };
}
