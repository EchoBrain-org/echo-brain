import {
  canonicalJson,
  canonicalJsonBytes,
} from '@echo-brain/federation-protocol';
import type {
  OrganizationAdminMemberExclusionBreakGlassReadRequestV2,
  OrganizationMemberExclusionListResponseV2,
  OrganizationPersonMemberExclusionListRequestV2,
  OrganizationPersonMemberExclusionSelectorV2,
} from './contracts.js';
import {
  ORGANIZATION_API_ADMIN_MEMBER_EXCLUSION_BREAK_GLASS_PATH,
  ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH,
} from './http.js';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  asRecord,
  assertExactKeys,
  assertId,
  assertOnlyEnumerableDataProperties,
  assertString,
  fail,
} from './validation.js';

const PERSON_REQUEST_KEYS = [
  'schema_version',
  'kind',
  'request_id',
  'authority_id',
  'organization_id',
  'subject_principal_id',
  'http_method',
  'http_path',
  'source_adapter_id',
  'source_instance_id',
] as const;

const ADMIN_REQUEST_KEYS = [
  'schema_version',
  'kind',
  'request_id',
  'authority_id',
  'organization_id',
  'target_principal_id',
  'target_membership_id',
  'http_method',
  'http_path',
  'source_adapter_id',
  'source_instance_id',
] as const;

const RESPONSE_KEYS = [
  'schema_version',
  'kind',
  'authority_id',
  'organization_id',
  'subject_principal_id',
  'membership_id',
  'source_adapter_id',
  'source_instance_id',
  'exclusions',
] as const;

const SOURCE_SELECTOR_KEYS = [
  'scope',
  'source_adapter_id',
  'source_instance_id',
] as const;

const MEETING_SELECTOR_KEYS = [...SOURCE_SELECTOR_KEYS, 'external_id'] as const;

function canonicalSnapshot(value: unknown, label: string): unknown {
  assertOnlyEnumerableDataProperties(value, label);
  let bytes: Uint8Array;
  let snapshot: unknown;
  try {
    bytes = canonicalJsonBytes(value);
    snapshot = JSON.parse(canonicalJson(value)) as unknown;
  } catch (error) {
    fail(`${label} is not canonicalizable`, error);
  }
  if (bytes.byteLength > MAX_ORGANIZATION_API_BODY_BYTES) {
    fail(`${label} exceeds its canonical byte bound`);
  }
  return snapshot;
}

function assertSource(value: Record<string, unknown>, label: string): void {
  assertString(value.source_adapter_id, `${label} source_adapter_id`, 128);
  assertString(value.source_instance_id, `${label} source_instance_id`, 128);
}

function validateSelector(
  value: unknown,
  label: string,
): OrganizationPersonMemberExclusionSelectorV2 {
  const selector = asRecord(value, label);
  if (selector.scope === 'source') {
    assertExactKeys(selector, SOURCE_SELECTOR_KEYS, label);
  } else if (selector.scope === 'meeting') {
    assertExactKeys(selector, MEETING_SELECTOR_KEYS, label);
    if (
      typeof selector.external_id !== 'string' ||
      selector.external_id.length === 0 ||
      selector.external_id.length > 4096 ||
      selector.external_id.includes('\0')
    ) {
      fail(`${label} external_id is invalid`);
    }
  } else {
    fail(`${label} scope is unsupported`);
  }
  assertSource(selector, label);
  return selector as unknown as OrganizationPersonMemberExclusionSelectorV2;
}

export function validateOrganizationPersonMemberExclusionListRequest(
  value: unknown,
): OrganizationPersonMemberExclusionListRequestV2 {
  const label = 'organization Person member exclusion list request';
  const record = asRecord(canonicalSnapshot(value, label), label);
  assertExactKeys(record, PERSON_REQUEST_KEYS, label);
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-person-member-exclusion-list-request' ||
    record.http_method !== 'POST' ||
    record.http_path !== ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH
  ) {
    fail(`${label} version, kind, or HTTP operation is unsupported`);
  }
  assertId(record.request_id, 'mex', `${label} request_id`);
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.subject_principal_id, 'prn', `${label} subject_principal_id`);
  assertSource(record, label);
  return record as unknown as OrganizationPersonMemberExclusionListRequestV2;
}

export function canonicalOrganizationPersonMemberExclusionListRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(
    validateOrganizationPersonMemberExclusionListRequest(value),
  );
}

export function validateOrganizationAdminMemberExclusionBreakGlassReadRequest(
  value: unknown,
): OrganizationAdminMemberExclusionBreakGlassReadRequestV2 {
  const label = 'organization admin member exclusion break-glass read request';
  const record = asRecord(canonicalSnapshot(value, label), label);
  assertExactKeys(record, ADMIN_REQUEST_KEYS, label);
  if (
    record.schema_version !== 2 ||
    record.kind !==
      'echo-organization-admin-member-exclusion-break-glass-read-request' ||
    record.http_method !== 'POST' ||
    record.http_path !==
      ORGANIZATION_API_ADMIN_MEMBER_EXCLUSION_BREAK_GLASS_PATH
  ) {
    fail(`${label} version, kind, or HTTP operation is unsupported`);
  }
  assertId(record.request_id, 'mex', `${label} request_id`);
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.target_principal_id, 'prn', `${label} target_principal_id`);
  assertId(record.target_membership_id, 'mem', `${label} target_membership_id`);
  assertSource(record, label);
  return record as unknown as OrganizationAdminMemberExclusionBreakGlassReadRequestV2;
}

export function canonicalOrganizationAdminMemberExclusionBreakGlassReadRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(
    validateOrganizationAdminMemberExclusionBreakGlassReadRequest(value),
  );
}

export function validateOrganizationMemberExclusionListResponse(
  value: unknown,
): OrganizationMemberExclusionListResponseV2 {
  const label = 'organization member exclusion list response';
  const record = asRecord(canonicalSnapshot(value, label), label);
  assertExactKeys(record, RESPONSE_KEYS, label);
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-member-exclusion-list-response'
  ) {
    fail(`${label} version or kind is unsupported`);
  }
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.subject_principal_id, 'prn', `${label} subject_principal_id`);
  assertId(record.membership_id, 'mem', `${label} membership_id`);
  assertSource(record, label);
  if (!Array.isArray(record.exclusions)) {
    fail(`${label} exclusions must be an array`);
  }
  const exclusions = record.exclusions.map((item, index) => {
    const selector = validateSelector(item, `${label} exclusions[${index}]`);
    if (
      selector.source_adapter_id !== record.source_adapter_id ||
      selector.source_instance_id !== record.source_instance_id
    ) {
      fail(`${label} exclusion belongs to another source`);
    }
    return selector;
  });
  if (new Set(exclusions.map((item) => canonicalJson(item))).size !== exclusions.length) {
    fail(`${label} exclusions contain a duplicate`);
  }
  return {
    ...record,
    exclusions,
  } as unknown as OrganizationMemberExclusionListResponseV2;
}

export function canonicalOrganizationMemberExclusionListResponseBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(validateOrganizationMemberExclusionListResponse(value));
}
