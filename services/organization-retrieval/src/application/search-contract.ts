import {
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_MEMBER_POLICY_ID,
  READABLE_SEARCH_ANALYZER_ID,
  READABLE_SEARCH_CONTRACT_ID,
  RESTRICTED_REVIEWER_POLICY_ID,
  type ReadableSearchAnalyzerDescriptor,
  type ReadableSearchPolicyId,
  ReadableSearchValidationError,
} from './contracts.js';
import { assertReadableSearchDigest, assertReadableSearchIdentifier } from './validation.js';

const ORGANIZATION_MEMBER_READABLE_WITNESS =
  'You may read this item because it was explicitly approved for current active owner or employee members, including members admitted after approval, and your membership is active.' as const;
const RESTRICTED_REVIEWER_WITNESS =
  'You may read this item because it records you as the approving reviewer and that exact reviewer membership is currently active.' as const;

/**
 * Bound into the immutable retrieval contract only.  Request validation,
 * response construction, and HTTP error presentation are API/Authority work.
 */
const RETRIEVAL_CONTRACT_ERROR_BYTES = Object.freeze({
  invalid_request: '{"error":{"code":"invalid_request","message":"request is invalid"}}',
  unauthorized: '{"error":{"code":"unauthorized","message":"authorization failed"}}',
  not_found: '{"error":{"code":"not_found","message":"resource was not found"}}',
  unavailable: '{"error":{"code":"unavailable","message":"service is temporarily unavailable"}}',
  internal_error: '{"error":{"code":"internal_error","message":"authority operation failed"}}',
});

export interface ReadableSearchAnalyzerContractV1 {
  readonly schema_version: 1;
  readonly kind: 'readable-search-analyzer-contract-v1';
  readonly analyzer_id: typeof READABLE_SEARCH_ANALYZER_ID;
  readonly input_normalization: 'NFC';
  readonly tokenization: 'maximal-ecmascript-unicode-Letter-or-Number-runs';
  readonly case_mapping: 'locale-independent-String.prototype.toLowerCase';
  readonly output_normalization: 'NFC';
  readonly query_term_deduplication: 'first-occurrence-wins';
  readonly query_zero_terms: 'reject';
  readonly document_term_occurrences: 'retain-for-frequency';
  readonly document_overlong_term_policy: 'omit';
  readonly document_zero_postings: 'retain-document';
  readonly indexed_field: 'exact-atom-text-only';
  readonly match: 'any-unique-query-term';
  readonly score: 'sum-matched-term-frequency';
  readonly order: readonly ['score-desc', 'log-position-desc', 'atom-order-asc', 'atom-id-asc'];
  readonly maximum_query_scalars: 240;
  readonly maximum_query_terms: 16;
  readonly maximum_query_term_utf8_bytes: 64;
  readonly analyzer_source_sha256: Sha256Digest;
}

export interface ReadableSearchRetrievalContractV1 {
  readonly schema_version: 1;
  readonly kind: 'permission-aware-readable-search-contract-v1';
  readonly contract_id: typeof READABLE_SEARCH_CONTRACT_ID;
  readonly request: {
    readonly schema_version: 1;
    readonly kind: 'echo-organization-readable-search-request';
    readonly request_id_prefix: 'osq';
    readonly http_method: 'POST';
    readonly http_path: '/v1/readable-search';
    readonly maximum_canonical_bytes: 16384;
    readonly maximum_age_source: 'configured-access_request_maximum_age_ms';
  };
  readonly query: {
    readonly normalization: 'NFC';
    readonly trimmed: true;
    readonly single_line: true;
    readonly control_free: true;
    readonly maximum_unicode_scalars: 240;
  };
  readonly analyzer_id: typeof READABLE_SEARCH_ANALYZER_ID;
  readonly analyzer_contract_sha256: Sha256Digest;
  readonly policies: readonly [ReadableSearchContractPolicy, ReadableSearchContractPolicy];
  readonly response: {
    readonly schema_version: 1;
    readonly top_level_keys: readonly ['schema_version', 'contract_id', 'items'];
    readonly item_keys: readonly ['kind', 'text', 'policy_id', 'witness'];
    readonly item_kinds: readonly ['decision', 'action', 'rationale'];
    readonly maximum_items: 10;
    readonly maximum_canonical_bytes: 61440;
    readonly ranking: readonly ['score-desc', 'log-position-desc', 'atom-order-asc', 'atom-id-asc'];
    readonly scores_exposed: false;
    readonly pagination: false;
  };
  readonly error_bytes: typeof RETRIEVAL_CONTRACT_ERROR_BYTES;
  readonly audit: { readonly operation: 'permission.readable_search_decided'; readonly retention_days: 180 };
}

export interface ReadableSearchContractPolicy {
  readonly policy_id: ReadableSearchPolicyId;
  readonly policy_contract_sha256: Sha256Digest;
  readonly witness: string;
}

function policyPair(input: {
  readonly organization_member_policy_contract_sha256: Sha256Digest;
  readonly restricted_reviewer_policy_contract_sha256: Sha256Digest;
}): readonly [ReadableSearchContractPolicy, ReadableSearchContractPolicy] {
  return Object.freeze([
    Object.freeze({
      policy_id: ORGANIZATION_MEMBER_POLICY_ID,
      policy_contract_sha256: assertReadableSearchDigest(input.organization_member_policy_contract_sha256, 'organization member policy contract'),
      witness: ORGANIZATION_MEMBER_READABLE_WITNESS,
    }),
    Object.freeze({
      policy_id: RESTRICTED_REVIEWER_POLICY_ID,
      policy_contract_sha256: assertReadableSearchDigest(input.restricted_reviewer_policy_contract_sha256, 'reviewer policy contract'),
      witness: RESTRICTED_REVIEWER_WITNESS,
    }),
  ]);
}

/** Hashes released source bytes supplied by the release process, never a path. */
export function readableSearchSourceBytesSha256(sourceBytes: Uint8Array): Sha256Digest {
  if (sourceBytes.byteLength === 0) throw new ReadableSearchValidationError('analyzer source bytes are empty');
  return sha256Digest(Buffer.from(sourceBytes));
}

export function createReadableSearchAnalyzerContract(input: {
  readonly analyzer_source_sha256: Sha256Digest;
}): ReadableSearchAnalyzerContractV1 {
  return Object.freeze({
    schema_version: 1,
    kind: 'readable-search-analyzer-contract-v1',
    analyzer_id: READABLE_SEARCH_ANALYZER_ID,
    input_normalization: 'NFC',
    tokenization: 'maximal-ecmascript-unicode-Letter-or-Number-runs',
    case_mapping: 'locale-independent-String.prototype.toLowerCase',
    output_normalization: 'NFC',
    query_term_deduplication: 'first-occurrence-wins',
    query_zero_terms: 'reject',
    document_term_occurrences: 'retain-for-frequency',
    document_overlong_term_policy: 'omit',
    document_zero_postings: 'retain-document',
    indexed_field: 'exact-atom-text-only',
    match: 'any-unique-query-term',
    score: 'sum-matched-term-frequency',
    order: Object.freeze(['score-desc', 'log-position-desc', 'atom-order-asc', 'atom-id-asc'] as const),
    maximum_query_scalars: 240,
    maximum_query_terms: 16,
    maximum_query_term_utf8_bytes: 64,
    analyzer_source_sha256: assertReadableSearchDigest(input.analyzer_source_sha256, 'analyzer_source_sha256'),
  });
}

export function readableSearchAnalyzerContractSha256(input: {
  readonly analyzer_source_sha256: Sha256Digest;
}): Sha256Digest {
  return canonicalSha256(createReadableSearchAnalyzerContract(input));
}

/**
 * Build callers supply release evidence as a digest or bytes. This helper does
 * not read a mutable source path, so a serving process cannot accidentally
 * turn a worktree file into a contract input.
 */
export function createReadableSearchAnalyzerDescriptor(input: {
  readonly analyzer_source_sha256: Sha256Digest;
  readonly node_version: string;
  readonly unicode_version: string;
  readonly icu_version: string;
}): ReadableSearchAnalyzerDescriptor {
  const analyzerSource = assertReadableSearchDigest(input.analyzer_source_sha256, 'analyzer_source_sha256');
  return Object.freeze({
    analyzer_id: READABLE_SEARCH_ANALYZER_ID,
    analyzer_contract_sha256: readableSearchAnalyzerContractSha256({ analyzer_source_sha256: analyzerSource }),
    analyzer_source_sha256: analyzerSource,
    node_version: assertReadableSearchIdentifier(input.node_version, 'node_version'),
    unicode_version: assertReadableSearchIdentifier(input.unicode_version, 'unicode_version'),
    icu_version: assertReadableSearchIdentifier(input.icu_version, 'icu_version'),
  });
}

export function createReadableSearchRetrievalContract(input: {
  readonly analyzer_contract_sha256: Sha256Digest;
  readonly organization_member_policy_contract_sha256: Sha256Digest;
  readonly restricted_reviewer_policy_contract_sha256: Sha256Digest;
}): ReadableSearchRetrievalContractV1 {
  return Object.freeze({
    schema_version: 1,
    kind: 'permission-aware-readable-search-contract-v1',
    contract_id: READABLE_SEARCH_CONTRACT_ID,
    request: Object.freeze({
      schema_version: 1, kind: 'echo-organization-readable-search-request', request_id_prefix: 'osq',
      http_method: 'POST', http_path: '/v1/readable-search', maximum_canonical_bytes: 16384,
      maximum_age_source: 'configured-access_request_maximum_age_ms',
    }),
    query: Object.freeze({ normalization: 'NFC', trimmed: true, single_line: true, control_free: true, maximum_unicode_scalars: 240 }),
    analyzer_id: READABLE_SEARCH_ANALYZER_ID,
    analyzer_contract_sha256: assertReadableSearchDigest(input.analyzer_contract_sha256, 'analyzer_contract_sha256'),
    policies: policyPair(input),
    response: Object.freeze({
      schema_version: 1,
      top_level_keys: Object.freeze(['schema_version', 'contract_id', 'items'] as const),
      item_keys: Object.freeze(['kind', 'text', 'policy_id', 'witness'] as const),
      item_kinds: Object.freeze(['decision', 'action', 'rationale'] as const),
      maximum_items: 10, maximum_canonical_bytes: 61440,
      ranking: Object.freeze(['score-desc', 'log-position-desc', 'atom-order-asc', 'atom-id-asc'] as const),
      scores_exposed: false, pagination: false,
    }),
    error_bytes: RETRIEVAL_CONTRACT_ERROR_BYTES,
    audit: Object.freeze({ operation: 'permission.readable_search_decided', retention_days: 180 }),
  });
}

export function readableSearchRetrievalContractSha256(input: {
  readonly analyzer_contract_sha256: Sha256Digest;
  readonly organization_member_policy_contract_sha256: Sha256Digest;
  readonly restricted_reviewer_policy_contract_sha256: Sha256Digest;
}): Sha256Digest {
  return canonicalSha256(createReadableSearchRetrievalContract(input));
}
