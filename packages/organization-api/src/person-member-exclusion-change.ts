import {
  canonicalJson,
  canonicalJsonBytes,
} from '@echo-brain/federation-protocol';
import type {
  OrganizationPersonMemberExclusionChangeRequestV2,
  OrganizationPersonMemberExclusionSelectorV2,
} from './contracts.js';
import { ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH } from './http.js';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  asRecord,
  assertExactKeys,
  assertId,
  assertOnlyEnumerableDataProperties,
  assertString,
  fail,
} from './validation.js';

const REQUEST_KEYS = [
  'schema_version',
  'kind',
  'request_id',
  'authority_id',
  'organization_id',
  'subject_principal_id',
  'http_method',
  'http_path',
  'excluded',
  'selector',
] as const;

const SOURCE_SELECTOR_KEYS = [
  'scope',
  'source_adapter_id',
  'source_instance_id',
] as const;

const MEETING_SELECTOR_KEYS = [
  ...SOURCE_SELECTOR_KEYS,
  'external_id',
] as const;

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

/**
 * Provider-owned meeting IDs are opaque. Keep their bytes exact: unlike a
 * display string they are not trimmed, case-folded, or Unicode-normalized.
 * NUL alone is refused because SQLite text length and comparison semantics do
 * not give it the same durable bound as the surrounding contract.
 */
function assertOpaqueExternalId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('\0')
  ) {
    fail(`${label} is invalid`);
  }
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
    assertOpaqueExternalId(selector.external_id, `${label} external_id`);
  } else {
    fail(`${label} scope is unsupported`);
  }
  assertString(selector.source_adapter_id, `${label} source_adapter_id`, 128);
  assertString(selector.source_instance_id, `${label} source_instance_id`, 128);
  return selector as unknown as OrganizationPersonMemberExclusionSelectorV2;
}

export function validateOrganizationPersonMemberExclusionChangeRequest(
  value: unknown,
): OrganizationPersonMemberExclusionChangeRequestV2 {
  const label = 'organization Person member exclusion change request';
  const record = asRecord(canonicalSnapshot(value, label), label);
  assertExactKeys(record, REQUEST_KEYS, label);
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-person-member-exclusion-change-request'
  ) {
    fail(`${label} version or kind is unsupported`);
  }
  if (
    record.http_method !== 'POST' ||
    record.http_path !== ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH
  ) {
    fail(`${label} HTTP operation is unsupported`);
  }
  assertId(record.request_id, 'mex', `${label} request_id`);
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(
    record.subject_principal_id,
    'prn',
    `${label} subject_principal_id`,
  );
  if (typeof record.excluded !== 'boolean') {
    fail(`${label} excluded must be a boolean`);
  }
  const selector = validateSelector(record.selector, `${label} selector`);
  return {
    ...record,
    selector,
  } as unknown as OrganizationPersonMemberExclusionChangeRequestV2;
}

export function canonicalOrganizationPersonMemberExclusionChangeRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(
    validateOrganizationPersonMemberExclusionChangeRequest(value),
  );
}
