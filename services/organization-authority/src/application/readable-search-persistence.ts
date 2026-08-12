import { Buffer } from 'node:buffer';
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
  canonicalJson,
  parseCanonicalJson,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import type { JsonValue, Sha256Digest } from '@echo-brain/federation-protocol';
import { addMilliseconds } from '../domain/rules.js';
import {
  READABLE_SEARCH_GENERATION_PUBLISHED_ACTION,
  READABLE_SEARCH_QUERY_AUDIT_OPERATION,
  READABLE_SEARCH_QUERY_AUDIT_RETENTION_DAYS,
} from './ports/authority-repository.js';
import type { AuthorityAuditEntry } from './ports/authority-repository.js';
import type {
  ReadableSearchActiveGenerationPublication,
  ReadableSearchQueryAuditDecision,
  ReadableSearchQueryAuditEntry,
  ReadableSearchQueryAuditReasonCode,
  StoredReadableSearchActiveGeneration,
  StoredReadableSearchQueryAuditEntry,
} from './ports/authority-repository.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALLOW_REASON = 'active_member_with_scoped_policy_paths' as const;
const DENY_REASONS = new Set<ReadableSearchQueryAuditReasonCode>([
  'installation_access_expired',
  'inactive_or_unbound_organization_membership',
  'inactive_or_revoked_installation_enrollment',
]);
const POLICY_IDS = [
  'organization-member-readable-v1',
  'restricted-reviewer-v1',
] as const;

export const READABLE_SEARCH_QUERY_AUDIT_RETENTION_MS =
  READABLE_SEARCH_QUERY_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export class ReadableSearchPersistenceIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReadableSearchPersistenceIntegrityError';
  }
}

function fail(message: string): never {
  throw new ReadableSearchPersistenceIntegrityError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${label} must be a plain JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
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
    fail(`${label} keys are not the exact closed set`);
  }
}

function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail(`${label} must be a canonical sha256 digest`);
  }
  return value as Sha256Digest;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a timestamp`);
  try {
    assertUtcMillisecondTimestamp(value, label);
  } catch (error) {
    throw new ReadableSearchPersistenceIntegrityError(
      `${label} must be a canonical UTC-millisecond timestamp`,
      { cause: error },
    );
  }
  return value;
}

function positivePosition(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function denseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${label} has a sparse slot`);
  }
  return value;
}

function identifier(value: unknown, prefix: string, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith(`${prefix}_`) ||
    !UUID_V4.test(value.slice(prefix.length + 1))
  ) {
    fail(`${label} must be a canonical ${prefix} identifier`);
  }
  return value;
}

function federationId(value: unknown, prefix: 'prn' | 'mem' | 'enr' | 'ins', label: string): string {
  if (typeof value !== 'string') fail(`${label} must be an identifier`);
  try {
    assertFederationId(value, prefix, label);
  } catch (error) {
    throw new ReadableSearchPersistenceIntegrityError(`${label} is invalid`, {
      cause: error,
    });
  }
  return value;
}

function validateHead(value: unknown, label: string): void {
  const head = object(value, label);
  exactKeys(head, ['position', 'record_hash'], label);
  const position = positivePosition(head.position, `${label}.position`);
  if (position === 0) {
    if (head.record_hash !== null) fail(`${label} zero position requires null hash`);
  } else {
    digest(head.record_hash, `${label}.record_hash`);
  }
}

function validatePolicyContracts(value: unknown): void {
  const policies = denseArray(value, 'query audit policy_contracts');
  if (policies.length !== POLICY_IDS.length) {
    fail('query audit policy_contracts must contain the exact two policies');
  }
  for (const [index, policyId] of POLICY_IDS.entries()) {
    const policy = object(policies[index], `query audit policy_contracts/${index}`);
    exactKeys(policy, ['policy_id', 'policy_contract_sha256'], 'query audit policy contract');
    if (policy.policy_id !== policyId) {
      fail('query audit policy_contracts order or policy is invalid');
    }
    digest(policy.policy_contract_sha256, 'query audit policy contract digest');
  }
}

function validateRequester(value: unknown): void {
  const requester = object(value, 'query audit requester');
  exactKeys(
    requester,
    ['principal_id', 'membership_id', 'membership_type', 'enrollment_id', 'installation_id'],
    'query audit requester',
  );
  federationId(requester.principal_id, 'prn', 'query audit requester principal_id');
  federationId(requester.membership_id, 'mem', 'query audit requester membership_id');
  federationId(requester.enrollment_id, 'enr', 'query audit requester enrollment_id');
  federationId(requester.installation_id, 'ins', 'query audit requester installation_id');
  if (requester.membership_type !== 'owner' && requester.membership_type !== 'employee') {
    fail('query audit requester membership_type is invalid');
  }
}

function validateAlignedArrays(value: Record<string, unknown>): void {
  const ids = denseArray(value.returned_atom_ids, 'query audit returned_atom_ids');
  const hashes = denseArray(value.returned_record_hashes, 'query audit returned_record_hashes');
  const policies = denseArray(value.returned_policy_ids, 'query audit returned_policy_ids');
  if (ids.length !== hashes.length || ids.length !== policies.length) {
    fail('query audit returned arrays are not aligned');
  }
  for (let index = 0; index < ids.length; index += 1) {
    digest(ids[index], `query audit returned_atom_ids/${index}`);
    digest(hashes[index], `query audit returned_record_hashes/${index}`);
    if (!POLICY_IDS.includes(policies[index] as (typeof POLICY_IDS)[number])) {
      fail(`query audit returned_policy_ids/${index} is invalid`);
    }
  }
}

const COMMON_DETAIL_KEYS = [
  'schema_version',
  'kind',
  'request_id',
  'request_sha256',
  'requester',
  'decision',
  'reason_code',
  'evaluation_complete',
  'retrieval_contract_sha256',
  'policy_contracts',
  'person_state_sha256',
  'evaluated_at',
  'response_sha256',
] as const;

export function readableSearchQueryAuditRetainUntil(occurredAt: string): string {
  timestamp(occurredAt, 'readable search query audit occurred_at');
  return addMilliseconds(occurredAt, READABLE_SEARCH_QUERY_AUDIT_RETENTION_MS);
}

/** Validates the exact allow/deny audit detail without opening storage. */
export function validateReadableSearchQueryAuditDetail(
  value: unknown,
): JsonValue {
  const detail = object(value, 'readable search query audit detail');
  const allow = detail.decision === 'allow';
  exactKeys(
    detail,
    allow
      ? [...COMMON_DETAIL_KEYS, 'scope_binding_sha256', 'generation', 'record_head', 'returned_atom_ids', 'returned_record_hashes', 'returned_policy_ids']
      : COMMON_DETAIL_KEYS,
    'readable search query audit detail',
  );
  if (detail.schema_version !== 1 || detail.kind !== 'readable-search-query-decision-audit-detail-v1') {
    fail('readable search query audit detail version or kind is invalid');
  }
  identifier(detail.request_id, 'osq', 'query audit request_id');
  digest(detail.request_sha256, 'query audit request_sha256');
  validateRequester(detail.requester);
  if (detail.evaluation_complete !== true) fail('query audit evaluation_complete is invalid');
  digest(detail.retrieval_contract_sha256, 'query audit retrieval_contract_sha256');
  validatePolicyContracts(detail.policy_contracts);
  digest(detail.person_state_sha256, 'query audit person_state_sha256');
  timestamp(detail.evaluated_at, 'query audit evaluated_at');
  digest(detail.response_sha256, 'query audit response_sha256');
  if (allow) {
    if (detail.reason_code !== ALLOW_REASON) fail('query audit allow reason is invalid');
    digest(detail.scope_binding_sha256, 'query audit scope_binding_sha256');
    const generation = object(detail.generation, 'query audit generation');
    exactKeys(generation, ['generation_id', 'manifest_sha256'], 'query audit generation');
    digest(generation.generation_id, 'query audit generation_id');
    digest(generation.manifest_sha256, 'query audit manifest_sha256');
    validateHead(detail.record_head, 'query audit record_head');
    validateAlignedArrays(detail);
  } else {
    if (detail.decision !== 'deny' || !DENY_REASONS.has(detail.reason_code as ReadableSearchQueryAuditReasonCode)) {
      fail('query audit denial decision or reason is invalid');
    }
  }
  return detail as JsonValue;
}

export function readableSearchQueryAuditDetailJson(
  entry: Pick<ReadableSearchQueryAuditEntry, 'decision' | 'reason_code' | 'response_bytes'> & { occurred_at: string },
  detail: JsonValue,
): string {
  const validated = validateReadableSearchQueryAuditDetail(detail);
  const record = object(validated, 'readable search query audit detail');
  if (record.decision !== entry.decision || record.reason_code !== entry.reason_code) {
    fail('query audit detail decision differs from entry');
  }
  if (record.evaluated_at !== entry.occurred_at) {
    fail('query audit detail evaluated_at differs from transaction time');
  }
  if (!(entry.response_bytes instanceof Uint8Array) || entry.response_bytes.byteLength === 0) {
    fail('query audit requires nonempty prepared response bytes');
  }
  if (record.response_sha256 !== sha256Digest(Buffer.from(entry.response_bytes))) {
    fail('query audit detail response_sha256 differs from prepared bytes');
  }
  return canonicalJson(validated);
}

export function validateReadableSearchActiveGenerationPublication(
  value: ReadableSearchActiveGenerationPublication,
): ReadableSearchActiveGenerationPublication {
  try {
    assertFederationId(value.organization_id, 'org', 'readable search organization_id');
  } catch (error) {
    throw new ReadableSearchPersistenceIntegrityError('readable search organization_id is invalid', { cause: error });
  }
  digest(value.generation_id, 'readable search generation_id');
  digest(value.manifest_sha256, 'readable search manifest_sha256');
  digest(value.retrieval_contract_sha256, 'readable search retrieval_contract_sha256');
  const position = positivePosition(value.record_head_position, 'readable search record_head_position');
  if (position === 0) {
    if (value.record_head_hash !== null) fail('readable search zero head requires null hash');
  } else {
    digest(value.record_head_hash, 'readable search record_head_hash');
  }
  return Object.freeze({ ...value });
}

export interface ReadableSearchGenerationPublishedAuditDetail {
  readonly schema_version: 1;
  readonly kind: 'readable-search-generation-published-audit-v1';
  readonly organization_id: string;
  readonly publication: ReadableSearchActiveGenerationPublication;
  readonly prior_generation: {
    readonly generation_id: Sha256Digest;
    readonly manifest_sha256: Sha256Digest;
  } | null;
  readonly published_at: string;
}

/** Validates the closed, content-free publication receipt before it is stored. */
export function validateReadableSearchGenerationPublishedAuditDetail(
  value: unknown,
): ReadableSearchGenerationPublishedAuditDetail {
  const detail = object(value, 'readable search generation published audit detail');
  exactKeys(
    detail,
    ['schema_version', 'kind', 'organization_id', 'publication', 'prior_generation', 'published_at'],
    'readable search generation published audit detail',
  );
  if (
    detail.schema_version !== 1 ||
    detail.kind !== 'readable-search-generation-published-audit-v1'
  ) {
    fail('readable search generation published audit detail version or kind is invalid');
  }
  const organizationId = detail.organization_id;
  if (typeof organizationId !== 'string') {
    fail('readable search generation published audit organization_id is invalid');
  }
  try {
    assertFederationId(organizationId, 'org', 'readable search generation published audit organization_id');
  } catch (error) {
    throw new ReadableSearchPersistenceIntegrityError(
      'readable search generation published audit organization_id is invalid',
      { cause: error },
    );
  }
  const publicationValue = object(
    detail.publication,
    'readable search generation published audit publication',
  );
  exactKeys(
    publicationValue,
    [
      'organization_id',
      'generation_id',
      'manifest_sha256',
      'retrieval_contract_sha256',
      'record_head_position',
      'record_head_hash',
    ],
    'readable search generation published audit publication',
  );
  const publication = validateReadableSearchActiveGenerationPublication({
    organization_id: publicationValue.organization_id as string,
    generation_id: publicationValue.generation_id as Sha256Digest,
    manifest_sha256: publicationValue.manifest_sha256 as Sha256Digest,
    retrieval_contract_sha256: publicationValue.retrieval_contract_sha256 as Sha256Digest,
    record_head_position: publicationValue.record_head_position as number,
    record_head_hash: publicationValue.record_head_hash as Sha256Digest | null,
  });
  if (publication.organization_id !== organizationId) {
    fail('readable search generation published audit publication organization differs');
  }
  let prior: ReadableSearchGenerationPublishedAuditDetail['prior_generation'];
  if (detail.prior_generation === null) {
    prior = null;
  } else {
    const priorValue = object(
      detail.prior_generation,
      'readable search generation published audit prior_generation',
    );
    exactKeys(
      priorValue,
      ['generation_id', 'manifest_sha256'],
      'readable search generation published audit prior_generation',
    );
    prior = Object.freeze({
      generation_id: digest(
        priorValue.generation_id,
        'readable search generation published audit prior generation_id',
      ),
      manifest_sha256: digest(
        priorValue.manifest_sha256,
        'readable search generation published audit prior manifest_sha256',
      ),
    });
  }
  return Object.freeze({
    schema_version: 1,
    kind: 'readable-search-generation-published-audit-v1',
    organization_id: organizationId,
    publication,
    prior_generation: prior,
    published_at: timestamp(
      detail.published_at,
      'readable search generation published audit published_at',
    ),
  });
}

/** Closed, content-free receipt for an active-generation pointer transition. */
export function createReadableSearchGenerationPublishedAudit(
  input: {
    readonly publication: ReadableSearchActiveGenerationPublication;
    readonly prior_generation: StoredReadableSearchActiveGeneration | null;
    readonly published_at: string;
  },
): AuthorityAuditEntry {
  const publication = validateReadableSearchActiveGenerationPublication(input.publication);
  const publishedAt = timestamp(input.published_at, 'readable search generation published_at');
  const prior = input.prior_generation === null
    ? null
    : validateStoredReadableSearchActiveGeneration(input.prior_generation);
  const detail = validateReadableSearchGenerationPublishedAuditDetail({
    schema_version: 1,
    kind: 'readable-search-generation-published-audit-v1',
    organization_id: publication.organization_id,
    publication,
    prior_generation: prior === null ? null : Object.freeze({
      generation_id: prior.generation_id,
      manifest_sha256: prior.manifest_sha256,
    }),
    published_at: publishedAt,
  });
  const detailJson: JsonValue = {
    schema_version: detail.schema_version,
    kind: detail.kind,
    organization_id: detail.organization_id,
    publication: {
      organization_id: detail.publication.organization_id,
      generation_id: detail.publication.generation_id,
      manifest_sha256: detail.publication.manifest_sha256,
      retrieval_contract_sha256: detail.publication.retrieval_contract_sha256,
      record_head_position: detail.publication.record_head_position,
      record_head_hash: detail.publication.record_head_hash,
    },
    prior_generation: detail.prior_generation === null ? null : {
      generation_id: detail.prior_generation.generation_id,
      manifest_sha256: detail.prior_generation.manifest_sha256,
    },
    published_at: detail.published_at,
  };
  return Object.freeze({
    occurred_at: publishedAt,
    actor_kind: 'admin',
    action: READABLE_SEARCH_GENERATION_PUBLISHED_ACTION,
    subject_id: publication.organization_id,
    detail: detailJson,
  });
}

export function validateStoredReadableSearchActiveGeneration(
  value: unknown,
): StoredReadableSearchActiveGeneration {
  const row = object(value, 'stored readable search active generation');
  exactKeys(row, ['organization_id', 'generation_id', 'manifest_sha256', 'retrieval_contract_sha256', 'record_head_position', 'record_head_hash', 'published_at'], 'stored readable search active generation');
  const published = validateReadableSearchActiveGenerationPublication({
    organization_id: row.organization_id as string,
    generation_id: row.generation_id as Sha256Digest,
    manifest_sha256: row.manifest_sha256 as Sha256Digest,
    retrieval_contract_sha256: row.retrieval_contract_sha256 as Sha256Digest,
    record_head_position: row.record_head_position as number,
    record_head_hash: row.record_head_hash as Sha256Digest | null,
  });
  return Object.freeze({ ...published, published_at: timestamp(row.published_at, 'stored readable search published_at') });
}

export function validateStoredReadableSearchQueryAuditEntry(
  value: unknown,
): StoredReadableSearchQueryAuditEntry {
  const row = object(value, 'stored readable search query audit entry');
  exactKeys(row, ['audit_sequence', 'occurred_at', 'retain_until', 'operation', 'decision', 'reason_code', 'detail_json'], 'stored readable search query audit entry');
  if (!Number.isSafeInteger(row.audit_sequence) || (row.audit_sequence as number) <= 0) fail('stored query audit sequence is invalid');
  const occurredAt = timestamp(row.occurred_at, 'stored query audit occurred_at');
  const retainUntil = timestamp(row.retain_until, 'stored query audit retain_until');
  if (retainUntil !== readableSearchQueryAuditRetainUntil(occurredAt)) fail('stored query audit retention is invalid');
  if (row.operation !== READABLE_SEARCH_QUERY_AUDIT_OPERATION) fail('stored query audit operation is invalid');
  if (row.decision !== 'allow' && row.decision !== 'deny') fail('stored query audit decision is invalid');
  if (typeof row.reason_code !== 'string' || typeof row.detail_json !== 'string') fail('stored query audit fields are invalid');
  let detail: JsonValue;
  try {
    detail = parseCanonicalJson(row.detail_json) as JsonValue;
  } catch (error) {
    throw new ReadableSearchPersistenceIntegrityError('stored query audit detail is not canonical JSON', { cause: error });
  }
  if (canonicalJson(detail) !== row.detail_json) fail('stored query audit detail changed its canonical bytes');
  validateReadableSearchQueryAuditDetail(detail);
  const detailRecord = object(detail, 'stored query audit detail');
  if (detailRecord.decision !== row.decision || detailRecord.reason_code !== row.reason_code || detailRecord.evaluated_at !== occurredAt) {
    fail('stored query audit detail differs from row');
  }
  return Object.freeze({
    audit_sequence: row.audit_sequence as number,
    occurred_at: occurredAt,
    retain_until: retainUntil,
    operation: READABLE_SEARCH_QUERY_AUDIT_OPERATION,
    decision: row.decision as ReadableSearchQueryAuditDecision,
    reason_code: row.reason_code as ReadableSearchQueryAuditReasonCode,
    detail,
  });
}
