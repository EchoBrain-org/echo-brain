import {
  canonicalJson,
  canonicalJsonBytes,
  canonicalSha256,
  createSignedDocumentWithKey,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from '@echo-brain/federation-protocol';
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from '@echo-brain/federation-protocol';
import type { CanonicalPayloadSigner } from '@echo-brain/organization-protocol';
import type {
  OrganizationReadableSearchRequestPayloadV1,
  OrganizationReadableSearchRequestV1,
  OrganizationReadableSearchResponseV1,
  OrganizationReadableSearchResultItemV1,
} from './contracts.js';
import { ORGANIZATION_API_READABLE_SEARCH_PATH } from './http.js';
import {
  asRecord,
  assertExactKeys,
  assertDigest,
  assertId,
  assertOnlyEnumerableDataProperties,
  assertTimestamp,
  fail,
  validateIntegrity,
} from './validation.js';

export const ORGANIZATION_READABLE_SEARCH_CONTRACT_ID =
  'permission-aware-readable-search-v1' as const;
export const MAX_ORGANIZATION_READABLE_SEARCH_REQUEST_BYTES = 16 * 1024;
export const MAX_ORGANIZATION_READABLE_SEARCH_RESPONSE_BYTES = 60 * 1024;
export const MAX_ORGANIZATION_READABLE_SEARCH_ITEMS = 10;
export const MAX_ORGANIZATION_READABLE_SEARCH_QUERY_SCALARS = 240;
export const ORGANIZATION_MEMBER_READABLE_SEARCH_WITNESS =
  'You may read this item because it was explicitly approved for current active owner or employee members, including members admitted after approval, and your membership is active.' as const;
export const RESTRICTED_REVIEWER_READABLE_SEARCH_WITNESS =
  'You may read this item because it records you as the approving reviewer and that exact reviewer membership is currently active.' as const;

const ITEM_KINDS = new Set(['decision', 'action', 'rationale']);

function validateQuery(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.normalize('NFC') ||
    value.trim() !== value ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ||
    [...value].length > MAX_ORGANIZATION_READABLE_SEARCH_QUERY_SCALARS
  ) {
    fail(`${label} is invalid`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail(`${label} is invalid`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`${label} is invalid`);
    }
  }
  return value;
}

/** Shared internally by the installation- and Person-authenticated requests. */
export function validateOrganizationReadableSearchQuery(
  value: unknown,
  label: string,
): string {
  const query = validateQuery(value, label);
  const observed = new Set<string>();
  for (const run of query.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const term = run.toLowerCase().normalize('NFC');
    // Analyzer terms are only Unicode Letter/Number runs, so their canonical
    // JSON encoding adds exactly the two surrounding quote bytes.
    if (canonicalJsonBytes(term).byteLength - 2 > 64) {
      fail(`${label} contains an overlong analyzer term`);
    }
    observed.add(term);
  }
  if (observed.size === 0 || observed.size > 16) {
    fail(`${label} must produce from one through sixteen unique terms`);
  }
  return query;
}

export function validateOrganizationReadableSearchRequest(
  value: unknown,
): OrganizationReadableSearchRequestV1 {
  const label = 'organization readable search request';
  assertOnlyEnumerableDataProperties(value, label);
  let canonical: Uint8Array;
  let snapshot: unknown;
  try {
    canonical = canonicalJsonBytes(value);
    if (canonical.byteLength > MAX_ORGANIZATION_READABLE_SEARCH_REQUEST_BYTES) {
      fail(`${label} exceeds its canonical byte bound`);
    }
    snapshot = JSON.parse(canonicalJson(value)) as unknown;
  } catch (error) {
    fail(`${label} is not canonicalizable`, error);
  }
  const record = asRecord(snapshot, label);
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
      'http_method',
      'http_path',
      'query',
      'requested_at',
      'integrity',
    ],
    label,
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-readable-search-request'
  ) {
    fail(`${label} version or kind is unsupported`);
  }
  assertId(record.request_id, 'osq', `${label} request_id`);
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertDigest(record.authority_key_id, `${label} authority_key_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.enrollment_id, 'enr', `${label} enrollment_id`);
  assertId(record.installation_id, 'ins', `${label} installation_id`);
  assertDigest(record.installation_key_id, `${label} installation_key_id`);
  if (
    record.http_method !== 'POST' ||
    record.http_path !== ORGANIZATION_API_READABLE_SEARCH_PATH
  ) {
    fail(`${label} HTTP operation is unsupported`);
  }
  const query = validateOrganizationReadableSearchQuery(
    record.query,
    `${label} query`,
  );
  assertTimestamp(record.requested_at, `${label} requested_at`);
  const integrity = validateIntegrity(record.integrity, label);
  if (integrity.key_id !== record.installation_key_id) {
    fail(`${label} signature key does not match installation key`);
  }
  return { ...record, query, integrity } as unknown as OrganizationReadableSearchRequestV1;
}

/**
 * The closed request's exact RFC8785 wire representation. Presentation uses
 * this API-owned helper to refuse decoded-equivalent whitespace or key order.
 */
export function canonicalOrganizationReadableSearchRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(validateOrganizationReadableSearchRequest(value));
}

export function verifyOrganizationReadableSearchRequest(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationReadableSearchRequestV1 {
  const request = validateOrganizationReadableSearchRequest(value);
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (
    request.installation_key_id !== installationSigningKey.key_id ||
    request.integrity.key_id !== installationSigningKey.key_id
  ) {
    throw new Error(
      'organization API: readable search request does not match the installation key',
    );
  }
  verifySignedDocument(request, publicKey, installationSigningKey.key_id);
  return request;
}

export function organizationReadableSearchRequestSha256(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationReadableSearchRequest(value, installationSigningKey),
  );
}

export interface CreateOrganizationReadableSearchRequestInput {
  request_id: string;
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
  query: string;
  requested_at: string;
}

export async function createOrganizationReadableSearchRequest(
  input: CreateOrganizationReadableSearchRequestInput,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationReadableSearchRequestV1> {
  verifyP256SigningKeyDescriptor(input.installation_signing_key);
  const payload: OrganizationReadableSearchRequestPayloadV1 = {
    schema_version: 1,
    kind: 'echo-organization-readable-search-request',
    request_id: input.request_id,
    authority_id: input.authority_id,
    authority_key_id: input.authority_key_id,
    organization_id: input.organization_id,
    enrollment_id: input.enrollment_id,
    installation_id: input.installation_id,
    installation_key_id: input.installation_signing_key.key_id,
    http_method: 'POST',
    http_path: ORGANIZATION_API_READABLE_SEARCH_PATH,
    query: validateOrganizationReadableSearchQuery(
      input.query,
      'organization readable search request query',
    ),
    requested_at: input.requested_at,
  };
  const document = await createSignedDocumentWithKey(
    payload,
    input.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationReadableSearchRequest(
    document,
    input.installation_signing_key,
  );
}

function validateItem(
  value: unknown,
  index: number,
): OrganizationReadableSearchResultItemV1 {
  const label = `organization readable search response items[${index}]`;
  const record = asRecord(value, label);
  assertExactKeys(record, ['kind', 'text', 'policy_id', 'witness'], label);
  if (typeof record.kind !== 'string' || !ITEM_KINDS.has(record.kind)) {
    fail(`${label} kind is unsupported`);
  }
  // Admission limits content to the same exact 240-scalar display grammar.
  const text = validateQuery(record.text, `${label} text`);
  if (
    (record.policy_id === 'organization-member-readable-v1' &&
      record.witness !== ORGANIZATION_MEMBER_READABLE_SEARCH_WITNESS) ||
    (record.policy_id === 'restricted-reviewer-v1' &&
      record.witness !== RESTRICTED_REVIEWER_READABLE_SEARCH_WITNESS) ||
    (record.policy_id !== 'organization-member-readable-v1' &&
      record.policy_id !== 'restricted-reviewer-v1')
  ) {
    fail(`${label} policy or witness is unsupported`);
  }
  return { ...record, text } as unknown as OrganizationReadableSearchResultItemV1;
}

export function validateOrganizationReadableSearchResponse(
  value: unknown,
): OrganizationReadableSearchResponseV1 {
  const label = 'organization readable search response';
  assertOnlyEnumerableDataProperties(value, label);
  const record = asRecord(value, label);
  assertExactKeys(record, ['schema_version', 'contract_id', 'items'], label);
  if (
    record.schema_version !== 1 ||
    record.contract_id !== ORGANIZATION_READABLE_SEARCH_CONTRACT_ID ||
    !Array.isArray(record.items) ||
    record.items.length > MAX_ORGANIZATION_READABLE_SEARCH_ITEMS ||
    Object.keys(record.items).length !== record.items.length
  ) {
    fail(`${label} identity or item array is invalid`);
  }
  const items = record.items.map((item, index) => validateItem(item, index));
  const response: OrganizationReadableSearchResponseV1 = {
    schema_version: 1,
    contract_id: ORGANIZATION_READABLE_SEARCH_CONTRACT_ID,
    items,
  };
  if (
    canonicalJsonBytes(response).byteLength >
    MAX_ORGANIZATION_READABLE_SEARCH_RESPONSE_BYTES
  ) {
    fail(`${label} exceeds its canonical byte limit`);
  }
  return response;
}
