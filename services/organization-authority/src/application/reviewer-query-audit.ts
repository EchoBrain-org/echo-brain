import { Buffer } from 'node:buffer';
import {
  assertUtcMillisecondTimestamp,
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import type {
  JsonObject,
  JsonValue,
  Sha256Digest,
} from '@echo-brain/federation-protocol';
import { RESTRICTED_REVIEWER_POLICY_ID } from '@echo-brain/organization-protocol';
import { addMilliseconds } from '../domain/rules.js';
import { reviewerPolicyContractSha256 } from './reviewer-policy-contract.js';
import {
  REVIEWER_QUERY_AUDIT_EXPIRED_ACTION,
  REVIEWER_QUERY_AUDIT_EXPORT_ACTION,
  REVIEWER_QUERY_AUDIT_OPERATION,
  REVIEWER_QUERY_AUDIT_RETENTION_DAYS,
} from './ports/authority-repository.js';
import type {
  ReviewerQueryAuditCommandBinding,
  ReviewerQueryAuditControlAction,
  ReviewerQueryAuditDecision,
  ReviewerQueryAuditReasonCode,
  StoredReviewerQueryAuditControlEvent,
  StoredReviewerQueryAuditEntry,
} from './ports/authority-repository.js';

/**
 * Strict, pure, Authority-local validation for everything the reviewer
 * query-decision audit stores.
 *
 * Nothing here reads or writes storage. Every function either returns the one
 * exact value it accepts or throws: a row that does not reproduce its own
 * canonical bytes, a detail with one extra key, a `retain_until` that is not
 * exactly 180 days after its `occurred_at`, or a receipt whose stored action
 * and detail disagree are all corruption, and corruption is never handed back
 * to a caller as a cast.
 */

export class ReviewerQueryAuditIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReviewerQueryAuditIntegrityError';
  }
}

function fail(message: string): never {
  throw new ReviewerQueryAuditIntegrityError(message);
}

export const REVIEWER_QUERY_AUDIT_RETENTION_MS =
  REVIEWER_QUERY_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_CONTROL_REASON_SCALARS = 240;

const ALLOW_REASON_CODE = 'active_exact_reviewer_membership';
const DENIAL_REASON_CODES = Object.freeze([
  'installation_access_expired',
  'inactive_or_unbound_reviewer_membership',
]);

const DECISION_DETAIL_KIND = 'reviewer-query-decision-audit-detail-v1';
const EXPORT_DETAIL_KIND = 'reviewer-query-audit-export-authorized-detail-v1';
const EXPIRY_DETAIL_KIND = 'reviewer-query-audit-expired-detail-v1';

const ALLOW_DETAIL_KEYS = Object.freeze([
  'schema_version',
  'kind',
  'request_id',
  'request_sha256',
  'requester',
  'decision',
  'reason_code',
  'evaluation_complete',
  'policy_id',
  'policy_contract_sha256',
  'person_state_sha256',
  'record_head',
  'returned_atom_ids',
  'returned_record_hashes',
  'evaluated_at',
  'response_sha256',
]);

const DENIAL_DETAIL_KEYS = Object.freeze([
  'schema_version',
  'kind',
  'request_id',
  'request_sha256',
  'requester',
  'decision',
  'reason_code',
  'evaluation_complete',
  'policy_id',
  'policy_contract_sha256',
  'person_state_sha256',
  'evaluated_at',
  'response_sha256',
]);

const REQUESTER_KEYS = Object.freeze([
  'principal_id',
  'membership_id',
  'enrollment_id',
  'installation_id',
]);

const RECORD_HEAD_KEYS = Object.freeze(['position', 'record_hash']);

const EXPORT_DETAIL_KEYS = Object.freeze([
  'schema_version',
  'kind',
  'command_id',
  'command_sha256',
  'authority_id',
  'organization_id',
  'owner_principal_id',
  'owner_membership_id',
  'reason',
  'from_inclusive',
  'until_exclusive',
  'output_path_sha256',
  'row_count',
  'ordered_rows_sha256',
  'export_sha256',
]);

const EXPIRY_DETAIL_KEYS = Object.freeze([
  'schema_version',
  'kind',
  'command_id',
  'command_sha256',
  'authority_id',
  'organization_id',
  'owner_principal_id',
  'owner_membership_id',
  'reason',
  'retention_days',
  'cutoff',
  'row_count',
  'ordered_rows_sha256',
]);

function asObject(value: unknown, label: string): Record<string, unknown> {
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

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} keys are not exactly the closed set`);
  }
}

function assertLiteral(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) fail(`${label} is not its fixed value`);
}

function assertIdentifier(value: unknown, prefix: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !value.startsWith(`${prefix}_`) ||
    !UUID_V4_PATTERN.test(value.slice(prefix.length + 1))
  ) {
    fail(`${label} must be a canonical ${prefix} identifier`);
  }
}

function assertDigest(value: unknown, label: string): void {
  if (typeof value !== 'string' || !SHA256_DIGEST_PATTERN.test(value)) {
    fail(`${label} must be a canonical sha256 digest`);
  }
}

function assertTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string timestamp`);
  try {
    assertUtcMillisecondTimestamp(value, label);
  } catch (error) {
    throw new ReviewerQueryAuditIntegrityError(
      `${label} must be a UTC millisecond timestamp`,
      { cause: error },
    );
  }
  return value;
}

function assertSafeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function assertPositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function assertDenseDigestArray(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${label} has a sparse slot`);
    assertDigest(value[index], `${label}/${index}`);
  }
  return value as readonly string[];
}

/** C0 controls and DEL, matching the landed Authority reason convention. */
function containsControlCharacter(value: string): boolean {
  for (const scalar of value) {
    const code = scalar.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertControlReason(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const scalars = [...value];
  if (
    value.normalize('NFC') !== value ||
    value.trim() !== value ||
    containsControlCharacter(value) ||
    scalars.length < 1 ||
    scalars.length > MAX_CONTROL_REASON_SCALARS
  ) {
    fail(`${label} is not a canonical single-line control reason`);
  }
  return value;
}

/**
 * The digest of the exact prepared response bytes.
 *
 * The bytes themselves are never stored and never returned: they exist only for
 * as long as it takes to prove that the digest the row is about to record is
 * the digest of what the caller actually prepared.
 */
function assertPreparedResponseDigest(
  responseBytes: unknown,
  label: string,
): Sha256Digest {
  if (
    !ArrayBuffer.isView(responseBytes) ||
    !(responseBytes instanceof Uint8Array)
  ) {
    fail(`${label} requires the exact prepared response bytes`);
  }
  if (responseBytes.byteLength === 0) {
    fail(`${label} prepared response bytes are empty`);
  }
  return sha256Digest(Buffer.from(responseBytes));
}

function assertControlAction(
  value: unknown,
  label: string,
): ReviewerQueryAuditControlAction {
  if (
    value !== REVIEWER_QUERY_AUDIT_EXPORT_ACTION &&
    value !== REVIEWER_QUERY_AUDIT_EXPIRED_ACTION
  ) {
    fail(`${label} is not a governed control action`);
  }
  return value as ReviewerQueryAuditControlAction;
}

interface ReviewerQueryAuditDecisionCodes {
  readonly decision: ReviewerQueryAuditDecision;
  readonly reason_code: ReviewerQueryAuditReasonCode;
}

function assertReasonCodeBinding(
  decision: unknown,
  reasonCode: unknown,
  label: string,
): ReviewerQueryAuditDecisionCodes {
  if (decision === 'allow') {
    if (reasonCode !== ALLOW_REASON_CODE) {
      fail(`${label} allow reason is not the one allow reason`);
    }
  } else if (decision === 'deny') {
    if (
      typeof reasonCode !== 'string' ||
      !DENIAL_REASON_CODES.includes(reasonCode)
    ) {
      fail(`${label} denial reason is not a closed denial reason`);
    }
  } else {
    fail(`${label} decision is not allow or deny`);
  }
  return {
    decision: decision as ReviewerQueryAuditDecision,
    reason_code: reasonCode as ReviewerQueryAuditReasonCode,
  };
}

/** `occurred_at + 180 days`, to the exact millisecond, never truncated. */
export function reviewerQueryAuditRetainUntil(occurredAt: string): string {
  assertTimestamp(occurredAt, 'reviewer query audit occurred_at');
  return addMilliseconds(occurredAt, REVIEWER_QUERY_AUDIT_RETENTION_MS);
}

export interface ReviewerQueryAuditDecisionBinding {
  readonly decision: ReviewerQueryAuditDecision;
  readonly reason_code: ReviewerQueryAuditReasonCode;
  /** The one transaction-owned time. `evaluated_at` must equal it exactly. */
  readonly occurred_at: string;
}

/**
 * What an append must state, as opposed to what a stored row can be re-read
 * against.
 *
 * A readback cannot re-derive `response_sha256`, because the bytes were never
 * stored. An append can and must: the exact prepared bytes are the only thing
 * that makes the recorded digest a fact rather than a caller's claim.
 */
export interface ReviewerQueryAuditAppendBinding
  extends ReviewerQueryAuditDecisionBinding {
  readonly response_bytes: Uint8Array;
}

/**
 * The exact online allow or denial detail.
 *
 * A denial omits `record_head`, `returned_atom_ids`, and
 * `returned_record_hashes` entirely rather than storing them empty, so the
 * closed key set itself is what proves a denial carries no result evidence.
 */
export function validateReviewerQueryAuditDecisionDetail(
  binding: ReviewerQueryAuditDecisionBinding,
  detail: unknown,
): JsonObject {
  const label = 'reviewer query audit detail';
  const occurredAt = assertTimestamp(
    binding.occurred_at,
    'reviewer query audit occurred_at',
  );
  const bound = assertReasonCodeBinding(
    binding.decision,
    binding.reason_code,
    'reviewer query audit',
  );
  const record = asObject(detail, label);
  assertExactKeys(
    record,
    bound.decision === 'allow' ? ALLOW_DETAIL_KEYS : DENIAL_DETAIL_KEYS,
    label,
  );
  assertLiteral(record.schema_version, 1, `${label} schema_version`);
  assertLiteral(record.kind, DECISION_DETAIL_KIND, `${label} kind`);
  assertIdentifier(record.request_id, 'rrd', `${label} request_id`);
  assertDigest(record.request_sha256, `${label} request_sha256`);

  const requester = asObject(record.requester, `${label} requester`);
  assertExactKeys(requester, REQUESTER_KEYS, `${label} requester`);
  assertIdentifier(
    requester.principal_id,
    'prn',
    `${label} requester principal_id`,
  );
  assertIdentifier(
    requester.membership_id,
    'mem',
    `${label} requester membership_id`,
  );
  assertIdentifier(
    requester.enrollment_id,
    'enr',
    `${label} requester enrollment_id`,
  );
  assertIdentifier(
    requester.installation_id,
    'ins',
    `${label} requester installation_id`,
  );

  // The stored columns and the stored detail must name the same decision. A row
  // whose columns say deny and whose detail says allow is corruption, not a
  // decision to interpret.
  assertLiteral(record.decision, bound.decision, `${label} decision`);
  assertLiteral(record.reason_code, bound.reason_code, `${label} reason_code`);
  assertLiteral(
    record.evaluation_complete,
    true,
    `${label} evaluation_complete`,
  );
  assertLiteral(
    record.policy_id,
    RESTRICTED_REVIEWER_POLICY_ID,
    `${label} policy_id`,
  );
  // The contract digest is the one fixed value, not merely a well-shaped
  // digest: a decision recorded under some other contract is not a decision
  // this Authority can account for. V1 has exactly one contract, so this holds
  // on append and on readback alike. A later contract version must widen this
  // to the closed set of contracts this Authority has ever decided under,
  // otherwise rows written before the bump stop reading back at all.
  assertDigest(record.policy_contract_sha256, `${label} policy_contract_sha256`);
  assertLiteral(
    record.policy_contract_sha256,
    reviewerPolicyContractSha256(),
    `${label} policy_contract_sha256`,
  );
  assertDigest(record.person_state_sha256, `${label} person_state_sha256`);
  assertLiteral(
    assertTimestamp(record.evaluated_at, `${label} evaluated_at`),
    occurredAt,
    `${label} evaluated_at`,
  );
  assertDigest(record.response_sha256, `${label} response_sha256`);

  if (bound.decision === 'deny') {
    return {
      schema_version: 1,
      kind: DECISION_DETAIL_KIND,
      request_id: record.request_id as string,
      request_sha256: record.request_sha256 as string,
      requester: {
        principal_id: requester.principal_id as string,
        membership_id: requester.membership_id as string,
        enrollment_id: requester.enrollment_id as string,
        installation_id: requester.installation_id as string,
      },
      decision: bound.decision,
      reason_code: bound.reason_code,
      evaluation_complete: true,
      policy_id: RESTRICTED_REVIEWER_POLICY_ID,
      policy_contract_sha256: record.policy_contract_sha256 as string,
      person_state_sha256: record.person_state_sha256 as string,
      evaluated_at: occurredAt,
      response_sha256: record.response_sha256 as string,
    };
  }

  const head = asObject(record.record_head, `${label} record_head`);
  assertExactKeys(head, RECORD_HEAD_KEYS, `${label} record_head`);
  const position = assertSafeCount(
    head.position,
    `${label} record_head position`,
  );
  if ((position === 0) !== (head.record_hash === null)) {
    fail(`${label} record_head position and record_hash disagree`);
  }
  if (position > 0) {
    assertDigest(head.record_hash, `${label} record_head record_hash`);
  }
  const atomIds = assertDenseDigestArray(
    record.returned_atom_ids,
    `${label} returned_atom_ids`,
  );
  const recordHashes = assertDenseDigestArray(
    record.returned_record_hashes,
    `${label} returned_record_hashes`,
  );
  if (atomIds.length !== recordHashes.length) {
    fail(`${label} returned item references are not aligned`);
  }
  return {
    schema_version: 1,
    kind: DECISION_DETAIL_KIND,
    request_id: record.request_id as string,
    request_sha256: record.request_sha256 as string,
    requester: {
      principal_id: requester.principal_id as string,
      membership_id: requester.membership_id as string,
      enrollment_id: requester.enrollment_id as string,
      installation_id: requester.installation_id as string,
    },
    decision: bound.decision,
    reason_code: bound.reason_code,
    evaluation_complete: true,
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
    policy_contract_sha256: record.policy_contract_sha256 as string,
    person_state_sha256: record.person_state_sha256 as string,
    record_head: {
      position,
      record_hash: (head.record_hash ?? null) as string | null,
    },
    returned_atom_ids: [...atomIds],
    returned_record_hashes: [...recordHashes],
    evaluated_at: occurredAt,
    response_sha256: record.response_sha256 as string,
  };
}

/**
 * The exact canonical bytes for one validated detail.
 *
 * Re-encoding the validated value and comparing it with the stored bytes is
 * what makes "canonical detail_json" a fact rather than an assumption: key
 * order, number form, and string escapes must all agree.
 */
function canonicalDetailJson(detail: JsonObject, label: string): string {
  try {
    return canonicalJson(detail);
  } catch (error) {
    throw new ReviewerQueryAuditIntegrityError(
      `${label} is not canonicalizable`,
      { cause: error },
    );
  }
}

/**
 * The exact bytes to store for one online decision.
 *
 * This is the only way a decision row is produced, and it cannot be reached
 * without the prepared response bytes, so every stored `response_sha256` is the
 * digest of a response that actually exists.
 */
export function reviewerQueryAuditDecisionDetailJson(
  binding: ReviewerQueryAuditAppendBinding,
  detail: unknown,
): string {
  const label = 'reviewer query audit detail';
  const responseSha256 = assertPreparedResponseDigest(
    binding.response_bytes,
    label,
  );
  const validated = validateReviewerQueryAuditDecisionDetail(binding, detail);
  assertLiteral(
    validated['response_sha256'],
    responseSha256,
    `${label} response_sha256`,
  );
  return canonicalDetailJson(validated, label);
}

export interface RawReviewerQueryAuditRow {
  readonly audit_sequence: unknown;
  readonly occurred_at: unknown;
  readonly retain_until: unknown;
  readonly operation: unknown;
  readonly decision: unknown;
  readonly reason_code: unknown;
  readonly detail_json: unknown;
}

/** One stored reviewer query row, or a throw. There is no partial acceptance. */
export function validateStoredReviewerQueryAuditRow(
  row: RawReviewerQueryAuditRow,
): StoredReviewerQueryAuditEntry {
  const label = 'stored reviewer query audit row';
  const auditSequence = assertPositiveSafeInteger(
    row.audit_sequence,
    `${label} audit_sequence`,
  );
  const occurredAt = assertTimestamp(row.occurred_at, `${label} occurred_at`);
  const retainUntil = assertTimestamp(
    row.retain_until,
    `${label} retain_until`,
  );
  if (retainUntil !== reviewerQueryAuditRetainUntil(occurredAt)) {
    fail(
      `${label} retain_until is not exactly its Authority-computed retention`,
    );
  }
  assertLiteral(
    row.operation,
    REVIEWER_QUERY_AUDIT_OPERATION,
    `${label} operation`,
  );
  const bound = assertReasonCodeBinding(row.decision, row.reason_code, label);
  if (typeof row.detail_json !== 'string') {
    fail(`${label} detail_json must be text`);
  }
  let parsed: JsonValue;
  try {
    parsed = parseCanonicalJson(row.detail_json);
  } catch (error) {
    throw new ReviewerQueryAuditIntegrityError(
      `${label} detail_json is not canonical JSON`,
      { cause: error },
    );
  }
  const detail = validateReviewerQueryAuditDecisionDetail(
    {
      decision: bound.decision,
      reason_code: bound.reason_code,
      occurred_at: occurredAt,
    },
    parsed,
  );
  if (canonicalDetailJson(detail, `${label} detail`) !== row.detail_json) {
    fail(`${label} detail_json is not the canonical encoding of its detail`);
  }
  return {
    audit_sequence: auditSequence,
    occurred_at: occurredAt,
    retain_until: retainUntil,
    operation: REVIEWER_QUERY_AUDIT_OPERATION,
    decision: bound.decision,
    reason_code: bound.reason_code,
    detail,
  };
}

export function assertReviewerQueryAuditCommandId(value: unknown): string {
  assertIdentifier(value, 'qac', 'reviewer query audit command_id');
  return value as string;
}

export interface ReviewerQueryAuditControlBinding {
  readonly action: ReviewerQueryAuditControlAction;
  readonly subject_id: string;
  /** The one transaction-owned time the receipt is stamped with. */
  readonly occurred_at: string;
}

/** The exact export-authorized or expired control detail. */
export function validateReviewerQueryAuditControlDetail(
  binding: ReviewerQueryAuditControlBinding,
  detail: unknown,
): JsonObject {
  const label = 'reviewer query audit control detail';
  const occurredAt = assertTimestamp(
    binding.occurred_at,
    'reviewer query audit control occurred_at',
  );
  assertIdentifier(
    binding.subject_id,
    'mem',
    'reviewer query audit control subject_id',
  );
  const action = assertControlAction(
    binding.action,
    'reviewer query audit control action',
  );
  const isExport = action === REVIEWER_QUERY_AUDIT_EXPORT_ACTION;
  const record = asObject(detail, label);
  assertExactKeys(
    record,
    isExport ? EXPORT_DETAIL_KEYS : EXPIRY_DETAIL_KEYS,
    label,
  );
  assertLiteral(record.schema_version, 1, `${label} schema_version`);
  assertLiteral(
    record.kind,
    isExport ? EXPORT_DETAIL_KIND : EXPIRY_DETAIL_KIND,
    `${label} kind`,
  );
  assertReviewerQueryAuditCommandId(record.command_id);
  assertDigest(record.command_sha256, `${label} command_sha256`);
  assertIdentifier(record.authority_id, 'oau', `${label} authority_id`);
  assertIdentifier(record.organization_id, 'org', `${label} organization_id`);
  assertIdentifier(
    record.owner_principal_id,
    'prn',
    `${label} owner_principal_id`,
  );
  assertIdentifier(
    record.owner_membership_id,
    'mem',
    `${label} owner_membership_id`,
  );
  // The generic receipt's subject is the owner membership. A receipt whose
  // subject and detail disagree names two different owners.
  assertLiteral(
    record.owner_membership_id,
    binding.subject_id,
    `${label} owner_membership_id`,
  );
  assertControlReason(record.reason, `${label} reason`);
  const rowCount = assertSafeCount(record.row_count, `${label} row_count`);
  assertDigest(record.ordered_rows_sha256, `${label} ordered_rows_sha256`);

  if (isExport) {
    const from = assertTimestamp(
      record.from_inclusive,
      `${label} from_inclusive`,
    );
    const until = assertTimestamp(
      record.until_exclusive,
      `${label} until_exclusive`,
    );
    if (!(from < until)) fail(`${label} range is not positive`);
    assertDigest(record.output_path_sha256, `${label} output_path_sha256`);
    assertDigest(record.export_sha256, `${label} export_sha256`);
    return {
      schema_version: 1,
      kind: EXPORT_DETAIL_KIND,
      command_id: record.command_id as string,
      command_sha256: record.command_sha256 as string,
      authority_id: record.authority_id as string,
      organization_id: record.organization_id as string,
      owner_principal_id: record.owner_principal_id as string,
      owner_membership_id: record.owner_membership_id as string,
      reason: record.reason as string,
      from_inclusive: from,
      until_exclusive: until,
      output_path_sha256: record.output_path_sha256 as string,
      row_count: rowCount,
      ordered_rows_sha256: record.ordered_rows_sha256 as string,
      export_sha256: record.export_sha256 as string,
    };
  }
  assertLiteral(
    record.retention_days,
    REVIEWER_QUERY_AUDIT_RETENTION_DAYS,
    `${label} retention_days`,
  );
  // Expiry accepts no caller-selected cutoff: its cutoff is the receipt's own
  // transaction-owned time, so the two must be the same instant.
  assertLiteral(
    assertTimestamp(record.cutoff, `${label} cutoff`),
    occurredAt,
    `${label} cutoff`,
  );
  return {
    schema_version: 1,
    kind: EXPIRY_DETAIL_KIND,
    command_id: record.command_id as string,
    command_sha256: record.command_sha256 as string,
    authority_id: record.authority_id as string,
    organization_id: record.organization_id as string,
    owner_principal_id: record.owner_principal_id as string,
    owner_membership_id: record.owner_membership_id as string,
    reason: record.reason as string,
    retention_days: REVIEWER_QUERY_AUDIT_RETENTION_DAYS,
    cutoff: occurredAt,
    row_count: rowCount,
    ordered_rows_sha256: record.ordered_rows_sha256 as string,
  };
}

export function reviewerQueryAuditControlDetailJson(
  binding: ReviewerQueryAuditControlBinding,
  detail: unknown,
): string {
  return canonicalDetailJson(
    validateReviewerQueryAuditControlDetail(binding, detail),
    'reviewer query audit control detail',
  );
}

export interface RawReviewerQueryAuditControlRow {
  readonly audit_sequence: unknown;
  readonly occurred_at: unknown;
  readonly actor_kind: unknown;
  readonly action: unknown;
  readonly subject_id: unknown;
  readonly detail_json: unknown;
}

/**
 * One stored generic control receipt, or a throw.
 *
 * The baseline generic audit has no entry id and no entry hash, and A does not
 * invent one: this exact stored row is the maintenance receipt, so it is
 * validated in full every time it is read back or looked up.
 */
export function validateStoredReviewerQueryAuditControlEvent(
  row: RawReviewerQueryAuditControlRow,
): StoredReviewerQueryAuditControlEvent {
  const label = 'stored reviewer query audit control event';
  const auditSequence = assertPositiveSafeInteger(
    row.audit_sequence,
    `${label} audit_sequence`,
  );
  const occurredAt = assertTimestamp(row.occurred_at, `${label} occurred_at`);
  assertLiteral(row.actor_kind, 'admin', `${label} actor_kind`);
  const action = assertControlAction(row.action, `${label} action`);
  assertIdentifier(row.subject_id, 'mem', `${label} subject_id`);
  if (typeof row.detail_json !== 'string') {
    fail(`${label} detail_json must be text`);
  }
  let parsed: JsonValue;
  try {
    parsed = parseCanonicalJson(row.detail_json);
  } catch (error) {
    throw new ReviewerQueryAuditIntegrityError(
      `${label} detail_json is not canonical JSON`,
      { cause: error },
    );
  }
  const detail = validateReviewerQueryAuditControlDetail(
    {
      action,
      subject_id: row.subject_id as string,
      occurred_at: occurredAt,
    },
    parsed,
  );
  if (canonicalDetailJson(detail, `${label} detail`) !== row.detail_json) {
    fail(`${label} detail_json is not the canonical encoding of its detail`);
  }
  // The receipt is the stored row, so it carries the stored bytes. Parsing
  // happened above only to prove those bytes are the one canonical detail this
  // action allows; the parse itself is not the receipt.
  return {
    audit_sequence: auditSequence,
    occurred_at: occurredAt,
    actor_kind: 'admin',
    action,
    subject_id: row.subject_id as string,
    detail_json: row.detail_json,
  };
}

/**
 * The command identity a validated stored receipt accounts for.
 *
 * It is read back out of the receipt's own stored bytes rather than tracked
 * alongside them, so a comparison against a command binding is a comparison
 * against what is actually on disk.
 */
export function reviewerQueryAuditControlCommandBinding(
  event: StoredReviewerQueryAuditControlEvent,
): { action: ReviewerQueryAuditControlAction; command_id: string; command_sha256: Sha256Digest } {
  const label = 'stored reviewer query audit control event';
  let parsed: JsonValue;
  try {
    parsed = parseCanonicalJson(event.detail_json);
  } catch (error) {
    throw new ReviewerQueryAuditIntegrityError(
      `${label} detail_json is not canonical JSON`,
      { cause: error },
    );
  }
  const record = asObject(parsed, `${label} detail`);
  const commandId = assertReviewerQueryAuditCommandId(record['command_id']);
  assertDigest(record['command_sha256'], `${label} command_sha256`);
  return {
    action: event.action,
    command_id: commandId,
    command_sha256: record['command_sha256'] as Sha256Digest,
  };
}

/** One governed command's closed identity, or a throw. */
export function validateReviewerQueryAuditCommandBinding(
  binding: ReviewerQueryAuditCommandBinding,
): ReviewerQueryAuditCommandBinding {
  const label = 'reviewer query audit command binding';
  const commandId = assertReviewerQueryAuditCommandId(binding.command_id);
  const action = assertControlAction(binding.action, `${label} action`);
  assertDigest(binding.command_sha256, `${label} command_sha256`);
  return {
    command_id: commandId,
    action,
    command_sha256: binding.command_sha256,
  };
}

export const REVIEWER_QUERY_AUDIT_EXPORT_COMMAND_KIND =
  'echo-authority-reviewer-query-audit-export-command' as const;
export const REVIEWER_QUERY_AUDIT_EXPIRY_COMMAND_KIND =
  'echo-authority-reviewer-query-audit-expiry-command' as const;
export const REVIEWER_QUERY_AUDIT_EXPORT_KIND =
  'echo-authority-reviewer-query-audit-export' as const;
export const REVIEWER_QUERY_AUDIT_ROW_SET_KIND =
  'echo-authority-reviewer-query-audit-row-set' as const;
export const REVIEWER_QUERY_AUDIT_OUTPUT_PATH_KIND =
  'reviewer-query-audit-output-path-v1' as const;

export const REVIEWER_QUERY_AUDIT_COMMAND_MAXIMUM_AGE_MS = 5 * 60 * 1000;
export const REVIEWER_QUERY_AUDIT_EXPORT_MAXIMUM_RANGE_MS =
  31 * 24 * 60 * 60 * 1000;

const EXPORT_COMMAND_KEYS = Object.freeze([
  'schema_version',
  'kind',
  'command_id',
  'authority_id',
  'organization_id',
  'owner_principal_id',
  'owner_membership_id',
  'requested_at',
  'reason',
  'from_inclusive',
  'until_exclusive',
  'output_path_sha256',
]);

const EXPIRY_COMMAND_KEYS = Object.freeze([
  'schema_version',
  'kind',
  'command_id',
  'authority_id',
  'organization_id',
  'owner_principal_id',
  'owner_membership_id',
  'requested_at',
  'reason',
]);

export interface ReviewerQueryAuditCommandCommonV1 {
  readonly schema_version: 1;
  readonly command_id: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly owner_principal_id: string;
  readonly owner_membership_id: string;
  readonly requested_at: string;
  readonly reason: string;
}

export interface ReviewerQueryAuditExportCommandV1
  extends ReviewerQueryAuditCommandCommonV1 {
  readonly kind: typeof REVIEWER_QUERY_AUDIT_EXPORT_COMMAND_KIND;
  readonly from_inclusive: string;
  readonly until_exclusive: string;
  readonly output_path_sha256: Sha256Digest;
}

export interface ReviewerQueryAuditExpiryCommandV1
  extends ReviewerQueryAuditCommandCommonV1 {
  readonly kind: typeof REVIEWER_QUERY_AUDIT_EXPIRY_COMMAND_KIND;
}

export type ReviewerQueryAuditMaintenanceCommandV1 =
  | ReviewerQueryAuditExportCommandV1
  | ReviewerQueryAuditExpiryCommandV1;

function validateReviewerQueryAuditCommandCommon(
  record: Record<string, unknown>,
  label: string,
): ReviewerQueryAuditCommandCommonV1 {
  assertLiteral(record.schema_version, 1, `${label} schema_version`);
  const commandId = assertReviewerQueryAuditCommandId(record.command_id);
  assertIdentifier(record.authority_id, 'oau', `${label} authority_id`);
  assertIdentifier(record.organization_id, 'org', `${label} organization_id`);
  assertIdentifier(
    record.owner_principal_id,
    'prn',
    `${label} owner_principal_id`,
  );
  assertIdentifier(
    record.owner_membership_id,
    'mem',
    `${label} owner_membership_id`,
  );
  const requestedAt = assertTimestamp(
    record.requested_at,
    `${label} requested_at`,
  );
  const reason = assertControlReason(record.reason, `${label} reason`);
  return {
    schema_version: 1,
    command_id: commandId,
    authority_id: record.authority_id as string,
    organization_id: record.organization_id as string,
    owner_principal_id: record.owner_principal_id as string,
    owner_membership_id: record.owner_membership_id as string,
    requested_at: requestedAt,
    reason,
  };
}

/** The two exact stopped-state command documents, detached from caller input. */
export function validateReviewerQueryAuditMaintenanceCommand(
  value: unknown,
): ReviewerQueryAuditMaintenanceCommandV1 {
  const label = 'reviewer query audit maintenance command';
  const record = asObject(value, label);
  const kind = record.kind;
  if (kind === REVIEWER_QUERY_AUDIT_EXPORT_COMMAND_KIND) {
    assertExactKeys(record, EXPORT_COMMAND_KEYS, label);
    const common = validateReviewerQueryAuditCommandCommon(record, label);
    const fromInclusive = assertTimestamp(
      record.from_inclusive,
      `${label} from_inclusive`,
    );
    const untilExclusive = assertTimestamp(
      record.until_exclusive,
      `${label} until_exclusive`,
    );
    const range = Date.parse(untilExclusive) - Date.parse(fromInclusive);
    if (range <= 0 || range > REVIEWER_QUERY_AUDIT_EXPORT_MAXIMUM_RANGE_MS) {
      fail(`${label} export range must be positive and at most 31 days`);
    }
    assertDigest(record.output_path_sha256, `${label} output_path_sha256`);
    return Object.freeze({
      ...common,
      kind,
      from_inclusive: fromInclusive,
      until_exclusive: untilExclusive,
      output_path_sha256: record.output_path_sha256 as Sha256Digest,
    });
  }
  if (kind === REVIEWER_QUERY_AUDIT_EXPIRY_COMMAND_KIND) {
    assertExactKeys(record, EXPIRY_COMMAND_KEYS, label);
    return Object.freeze({
      ...validateReviewerQueryAuditCommandCommon(record, label),
      kind,
    });
  }
  fail(`${label} kind is not a governed reviewer query audit command`);
}

export function reviewerQueryAuditMaintenanceCommandSha256(
  command: ReviewerQueryAuditMaintenanceCommandV1,
): Sha256Digest {
  return canonicalSha256(
    validateReviewerQueryAuditMaintenanceCommand(command) as unknown as JsonValue,
  );
}

export function reviewerQueryAuditCommandBinding(
  command: ReviewerQueryAuditMaintenanceCommandV1,
): ReviewerQueryAuditCommandBinding {
  return {
    command_id: command.command_id,
    action:
      command.kind === REVIEWER_QUERY_AUDIT_EXPORT_COMMAND_KIND
        ? REVIEWER_QUERY_AUDIT_EXPORT_ACTION
        : REVIEWER_QUERY_AUDIT_EXPIRED_ACTION,
    command_sha256: reviewerQueryAuditMaintenanceCommandSha256(command),
  };
}

/** First executions only: retries are authorized by their stored receipt. */
export function assertReviewerQueryAuditCommandFresh(
  command: ReviewerQueryAuditMaintenanceCommandV1,
  observedAt: string,
): void {
  const now = assertTimestamp(
    observedAt,
    'reviewer query audit maintenance observed_at',
  );
  const age = Date.parse(now) - Date.parse(command.requested_at);
  if (age < 0 || age > REVIEWER_QUERY_AUDIT_COMMAND_MAXIMUM_AGE_MS) {
    fail('reviewer query audit maintenance command is outside its freshness window');
  }
}

export function reviewerQueryAuditOutputPathSha256(
  normalizedAbsolutePath: string,
): Sha256Digest {
  if (typeof normalizedAbsolutePath !== 'string' || normalizedAbsolutePath.length === 0) {
    fail('reviewer query audit output path must be a non-empty string');
  }
  return canonicalSha256({
    schema_version: 1,
    kind: REVIEWER_QUERY_AUDIT_OUTPUT_PATH_KIND,
    absolute_path: normalizedAbsolutePath,
  });
}

export interface ReviewerQueryAuditExportRowV1 {
  readonly audit_sequence: number;
  readonly occurred_at: string;
  readonly retain_until: string;
  readonly operation: typeof REVIEWER_QUERY_AUDIT_OPERATION;
  readonly decision: ReviewerQueryAuditDecision;
  readonly reason_code: ReviewerQueryAuditReasonCode;
  readonly detail: JsonValue;
}

export interface ReviewerQueryAuditExportDocumentV1 {
  readonly schema_version: 1;
  readonly kind: typeof REVIEWER_QUERY_AUDIT_EXPORT_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly from_inclusive: string;
  readonly until_exclusive: string;
  readonly rows: readonly ReviewerQueryAuditExportRowV1[];
}

function reviewerQueryAuditExportRows(
  rows: readonly StoredReviewerQueryAuditEntry[],
): readonly ReviewerQueryAuditExportRowV1[] {
  let previous = 0;
  return Object.freeze(
    rows.map((row) => {
      const validated = validateStoredReviewerQueryAuditRow({
        ...row,
        detail_json: canonicalJson(row.detail),
      });
      if (validated.audit_sequence <= previous) {
        fail('reviewer query audit export rows are not strictly ordered');
      }
      previous = validated.audit_sequence;
      return Object.freeze({
        audit_sequence: validated.audit_sequence,
        occurred_at: validated.occurred_at,
        retain_until: validated.retain_until,
        operation: validated.operation,
        decision: validated.decision,
        reason_code: validated.reason_code,
        detail: validated.detail,
      });
    }),
  );
}

export function reviewerQueryAuditOrderedRowsSha256(
  rows: readonly StoredReviewerQueryAuditEntry[],
): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: REVIEWER_QUERY_AUDIT_ROW_SET_KIND,
    rows: reviewerQueryAuditExportRows(rows),
  });
}

export function reviewerQueryAuditExportDocument(
  command: ReviewerQueryAuditExportCommandV1,
  rows: readonly StoredReviewerQueryAuditEntry[],
): ReviewerQueryAuditExportDocumentV1 {
  const validated = validateReviewerQueryAuditMaintenanceCommand(command);
  if (validated.kind !== REVIEWER_QUERY_AUDIT_EXPORT_COMMAND_KIND) {
    fail('reviewer query audit export requires an export command');
  }
  return Object.freeze({
    schema_version: 1,
    kind: REVIEWER_QUERY_AUDIT_EXPORT_KIND,
    authority_id: validated.authority_id,
    organization_id: validated.organization_id,
    from_inclusive: validated.from_inclusive,
    until_exclusive: validated.until_exclusive,
    rows: reviewerQueryAuditExportRows(rows),
  });
}

export function reviewerQueryAuditExportBytes(
  document: ReviewerQueryAuditExportDocumentV1,
): Buffer {
  return Buffer.from(canonicalJson(document as unknown as JsonValue), 'utf8');
}
