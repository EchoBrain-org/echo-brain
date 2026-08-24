import { canonicalJson, canonicalJsonBytes } from '@echo-brain/federation-protocol';
import type {
  OrganizationPersonReadableSearchRequestV2,
  OrganizationPersonRecentDecisionsRequestV2,
  OrganizationPersonReviewerRecentDecisionsRequestV2,
} from './contracts.js';
import {
  ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
} from './http.js';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  asRecord,
  assertExactKeys,
  assertId,
  assertOnlyEnumerableDataProperties,
  fail,
} from './validation.js';

const PERSON_RECENT_READ_KEYS = [
  'schema_version',
  'kind',
  'request_id',
  'authority_id',
  'organization_id',
  'subject_principal_id',
  'http_method',
  'http_path',
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

function validatePersonReadIdentity(
  record: Record<string, unknown>,
  label: string,
  requestIdPrefix: 'rdr' | 'rrd' | 'osq',
): void {
  assertId(record.request_id, requestIdPrefix, `${label} request_id`);
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(
    record.subject_principal_id,
    'prn',
    `${label} subject_principal_id`,
  );
}

function validatePersonReadOperation(
  record: Record<string, unknown>,
  expectedKind: OrganizationPersonRecentDecisionsRequestV2['kind'],
  expectedPath: OrganizationPersonRecentDecisionsRequestV2['http_path'],
  label: string,
): void {
  if (record.schema_version !== 2 || record.kind !== expectedKind) {
    fail(`${label} version or kind is unsupported`);
  }
  if (record.http_method !== 'POST' || record.http_path !== expectedPath) {
    fail(`${label} HTTP operation is unsupported`);
  }
}

function validateOrganizationPersonReadableSearchQuery(
  value: unknown,
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.normalize('NFC') ||
    value.trim() !== value ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ||
    [...value].length > 240
  ) {
    fail(`${label} is invalid`);
  }
  const terms = new Set<string>();
  for (const run of value.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const term = run.toLowerCase().normalize('NFC');
    if (canonicalJsonBytes(term).byteLength - 2 > 64) {
      fail(`${label} contains an overlong analyzer term`);
    }
    terms.add(term);
  }
  if (terms.size === 0 || terms.size > 16) {
    fail(`${label} must produce from one through sixteen unique terms`);
  }
  return value;
}

export function validateOrganizationPersonRecentDecisionsRequest(
  value: unknown,
): OrganizationPersonRecentDecisionsRequestV2 {
  const label = 'organization Person recent decisions request';
  const record = asRecord(canonicalSnapshot(value, label), label);
  assertExactKeys(record, PERSON_RECENT_READ_KEYS, label);
  validatePersonReadOperation(
    record,
    'echo-organization-person-recent-decisions-request',
    ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
    label,
  );
  validatePersonReadIdentity(record, label, 'rdr');
  return record as unknown as OrganizationPersonRecentDecisionsRequestV2;
}

export function validateOrganizationPersonReviewerRecentDecisionsRequest(
  value: unknown,
): OrganizationPersonReviewerRecentDecisionsRequestV2 {
  const label = 'organization Person reviewer recent decisions request';
  const record = asRecord(canonicalSnapshot(value, label), label);
  assertExactKeys(record, ['subject_principal_id'], label);
  assertId(
    record.subject_principal_id,
    'prn',
    `${label} subject_principal_id`,
  );
  return record as unknown as OrganizationPersonReviewerRecentDecisionsRequestV2;
}

export function validateOrganizationPersonReadableSearchRequest(
  value: unknown,
): OrganizationPersonReadableSearchRequestV2 {
  const label = 'organization Person readable search request';
  const record = asRecord(canonicalSnapshot(value, label), label);
  assertExactKeys(record, ['subject_principal_id', 'query'], label);
  assertId(
    record.subject_principal_id,
    'prn',
    `${label} subject_principal_id`,
  );
  const query = validateOrganizationPersonReadableSearchQuery(
    record.query,
    `${label} query`,
  );
  return { ...record, query } as unknown as OrganizationPersonReadableSearchRequestV2;
}

export function canonicalOrganizationPersonRecentDecisionsRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(
    validateOrganizationPersonRecentDecisionsRequest(value),
  );
}

export function canonicalOrganizationPersonReviewerRecentDecisionsRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(
    validateOrganizationPersonReviewerRecentDecisionsRequest(value),
  );
}

export function canonicalOrganizationPersonReadableSearchRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(
    validateOrganizationPersonReadableSearchRequest(value),
  );
}
