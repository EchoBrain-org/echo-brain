import { Buffer } from 'node:buffer';
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from '@echo-brain/federation-protocol';
import type { JsonValue, Sha256Digest } from '@echo-brain/federation-protocol';
import {
  READABLE_SEARCH_QUERY_AUDIT_EXPIRED_ACTION,
  READABLE_SEARCH_QUERY_AUDIT_EXPORT_ACTION,
  READABLE_SEARCH_QUERY_AUDIT_OPERATION,
} from './ports/authority-repository.js';
import type {
  ReadableSearchQueryAuditCommandBinding,
  ReadableSearchQueryAuditControlAction,
  StoredReadableSearchQueryAuditControlEvent,
  StoredReadableSearchQueryAuditEntry,
} from './ports/authority-repository.js';
import { validateStoredReadableSearchQueryAuditEntry } from './readable-search-persistence.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const READABLE_SEARCH_QUERY_AUDIT_EXPORT_COMMAND_KIND =
  'echo-authority-readable-search-query-audit-export-command' as const;
export const READABLE_SEARCH_QUERY_AUDIT_EXPIRY_COMMAND_KIND =
  'echo-authority-readable-search-query-audit-expiry-command' as const;
export const READABLE_SEARCH_QUERY_AUDIT_EXPORT_KIND =
  'echo-authority-readable-search-query-audit-export' as const;
export const READABLE_SEARCH_QUERY_AUDIT_ROW_SET_KIND =
  'echo-authority-readable-search-query-audit-row-set' as const;
export const READABLE_SEARCH_QUERY_AUDIT_OUTPUT_PATH_KIND =
  'readable-search-query-audit-output-path-v1' as const;
export const READABLE_SEARCH_QUERY_AUDIT_COMMAND_MAXIMUM_AGE_MS = 5 * 60 * 1000;
export const READABLE_SEARCH_QUERY_AUDIT_EXPORT_MAXIMUM_RANGE_MS =
  31 * 24 * 60 * 60 * 1000;

export class ReadableSearchQueryAuditMaintenanceIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReadableSearchQueryAuditMaintenanceIntegrityError';
  }
}

function fail(message: string): never {
  throw new ReadableSearchQueryAuditMaintenanceIntegrityError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys are not the exact closed set`);
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a timestamp`);
  try { assertUtcMillisecondTimestamp(value, label); } catch (error) {
    throw new ReadableSearchQueryAuditMaintenanceIntegrityError(`${label} is not canonical UTC-millisecond time`, { cause: error });
  }
  return value;
}

function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${label} must be a canonical sha256 digest`);
  return value as Sha256Digest;
}

function federation(value: unknown, prefix: 'oau' | 'org' | 'prn' | 'mem', label: string): string {
  if (typeof value !== 'string') fail(`${label} must be an identifier`);
  try { assertFederationId(value, prefix, label); } catch (error) {
    throw new ReadableSearchQueryAuditMaintenanceIntegrityError(`${label} is invalid`, { cause: error });
  }
  return value;
}

function commandId(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('sqa_') || !UUID_V4.test(value.slice(4))) {
    fail('readable search query audit command_id must be a canonical sqa identifier');
  }
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC') ||
      value.trim() !== value || /[\r\n\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || [...value].length > 240) {
    fail('readable search query audit reason is invalid');
  }
  return value;
}

export interface ReadableSearchQueryAuditCommandCommonV1 {
  readonly schema_version: 1;
  readonly command_id: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly owner_principal_id: string;
  readonly owner_membership_id: string;
  readonly requested_at: string;
  readonly reason: string;
}

export interface ReadableSearchQueryAuditExportCommandV1 extends ReadableSearchQueryAuditCommandCommonV1 {
  readonly kind: typeof READABLE_SEARCH_QUERY_AUDIT_EXPORT_COMMAND_KIND;
  readonly from_inclusive: string;
  readonly until_exclusive: string;
  readonly output_path_sha256: Sha256Digest;
}

export interface ReadableSearchQueryAuditExpiryCommandV1 extends ReadableSearchQueryAuditCommandCommonV1 {
  readonly kind: typeof READABLE_SEARCH_QUERY_AUDIT_EXPIRY_COMMAND_KIND;
}

export type ReadableSearchQueryAuditMaintenanceCommandV1 =
  | ReadableSearchQueryAuditExportCommandV1
  | ReadableSearchQueryAuditExpiryCommandV1;

const COMMON_COMMAND_KEYS = [
  'schema_version', 'kind', 'command_id', 'authority_id', 'organization_id',
  'owner_principal_id', 'owner_membership_id', 'requested_at', 'reason',
] as const;

function commandCommon(record: Record<string, unknown>): ReadableSearchQueryAuditCommandCommonV1 {
  if (record.schema_version !== 1) fail('readable search query audit command schema_version is invalid');
  return Object.freeze({
    schema_version: 1,
    command_id: commandId(record.command_id),
    authority_id: federation(record.authority_id, 'oau', 'readable search query audit authority_id'),
    organization_id: federation(record.organization_id, 'org', 'readable search query audit organization_id'),
    owner_principal_id: federation(record.owner_principal_id, 'prn', 'readable search query audit owner_principal_id'),
    owner_membership_id: federation(record.owner_membership_id, 'mem', 'readable search query audit owner_membership_id'),
    requested_at: timestamp(record.requested_at, 'readable search query audit requested_at'),
    reason: reason(record.reason),
  });
}

/** Validates one exact stopped-only command and detaches it from caller input. */
export function validateReadableSearchQueryAuditMaintenanceCommand(value: unknown): ReadableSearchQueryAuditMaintenanceCommandV1 {
  const record = object(value, 'readable search query audit maintenance command');
  if (record.kind === READABLE_SEARCH_QUERY_AUDIT_EXPORT_COMMAND_KIND) {
    exactKeys(record, [...COMMON_COMMAND_KEYS, 'from_inclusive', 'until_exclusive', 'output_path_sha256'], 'readable search query audit export command');
    const fromInclusive = timestamp(record.from_inclusive, 'readable search query audit export from_inclusive');
    const untilExclusive = timestamp(record.until_exclusive, 'readable search query audit export until_exclusive');
    const range = Date.parse(untilExclusive) - Date.parse(fromInclusive);
    if (range <= 0 || range > READABLE_SEARCH_QUERY_AUDIT_EXPORT_MAXIMUM_RANGE_MS) fail('readable search query audit export range must be positive and at most 31 days');
    return Object.freeze({ ...commandCommon(record), kind: READABLE_SEARCH_QUERY_AUDIT_EXPORT_COMMAND_KIND, from_inclusive: fromInclusive, until_exclusive: untilExclusive, output_path_sha256: digest(record.output_path_sha256, 'readable search query audit output_path_sha256') });
  }
  if (record.kind === READABLE_SEARCH_QUERY_AUDIT_EXPIRY_COMMAND_KIND) {
    exactKeys(record, COMMON_COMMAND_KEYS, 'readable search query audit expiry command');
    return Object.freeze({ ...commandCommon(record), kind: READABLE_SEARCH_QUERY_AUDIT_EXPIRY_COMMAND_KIND });
  }
  fail('readable search query audit command kind is not governed');
}

export function readableSearchQueryAuditMaintenanceCommandSha256(command: ReadableSearchQueryAuditMaintenanceCommandV1): Sha256Digest {
  return canonicalSha256(validateReadableSearchQueryAuditMaintenanceCommand(command) as unknown as JsonValue);
}

export function readableSearchQueryAuditCommandBinding(command: ReadableSearchQueryAuditMaintenanceCommandV1): ReadableSearchQueryAuditCommandBinding {
  return Object.freeze({ command_id: command.command_id, action: command.kind === READABLE_SEARCH_QUERY_AUDIT_EXPORT_COMMAND_KIND ? READABLE_SEARCH_QUERY_AUDIT_EXPORT_ACTION : READABLE_SEARCH_QUERY_AUDIT_EXPIRED_ACTION, command_sha256: readableSearchQueryAuditMaintenanceCommandSha256(command) });
}

export function assertReadableSearchQueryAuditCommandFresh(command: ReadableSearchQueryAuditMaintenanceCommandV1, observedAt: string): void {
  const age = Date.parse(timestamp(observedAt, 'readable search query audit maintenance observed_at')) - Date.parse(command.requested_at);
  if (age < 0 || age > READABLE_SEARCH_QUERY_AUDIT_COMMAND_MAXIMUM_AGE_MS) fail('readable search query audit maintenance command is outside its freshness window');
}

export function readableSearchQueryAuditOutputPathSha256(normalizedAbsolutePath: string): Sha256Digest {
  if (typeof normalizedAbsolutePath !== 'string' || normalizedAbsolutePath.length === 0) fail('readable search query audit output path is invalid');
  return canonicalSha256({ schema_version: 1, kind: READABLE_SEARCH_QUERY_AUDIT_OUTPUT_PATH_KIND, absolute_path: normalizedAbsolutePath });
}

export interface ReadableSearchQueryAuditExportRowV1 {
  readonly audit_sequence: number; readonly occurred_at: string; readonly retain_until: string;
  readonly operation: typeof READABLE_SEARCH_QUERY_AUDIT_OPERATION;
  readonly decision: 'allow' | 'deny'; readonly reason_code: string; readonly detail: JsonValue;
}

export interface ReadableSearchQueryAuditExportDocumentV1 {
  readonly schema_version: 1; readonly kind: typeof READABLE_SEARCH_QUERY_AUDIT_EXPORT_KIND;
  readonly authority_id: string; readonly organization_id: string;
  readonly from_inclusive: string; readonly until_exclusive: string;
  readonly rows: readonly ReadableSearchQueryAuditExportRowV1[];
}

function exportRows(rows: readonly StoredReadableSearchQueryAuditEntry[]): readonly ReadableSearchQueryAuditExportRowV1[] {
  let previous = 0;
  return Object.freeze(rows.map((row) => {
    const valid = validateStoredReadableSearchQueryAuditEntry({
      audit_sequence: row.audit_sequence,
      occurred_at: row.occurred_at,
      retain_until: row.retain_until,
      operation: row.operation,
      decision: row.decision,
      reason_code: row.reason_code,
      detail_json: canonicalJson(row.detail),
    });
    if (valid.audit_sequence <= previous) fail('readable search query audit export rows are not strictly ordered');
    previous = valid.audit_sequence;
    return Object.freeze({ audit_sequence: valid.audit_sequence, occurred_at: valid.occurred_at, retain_until: valid.retain_until, operation: valid.operation, decision: valid.decision, reason_code: valid.reason_code, detail: valid.detail });
  }));
}

export function readableSearchQueryAuditOrderedRowsSha256(rows: readonly StoredReadableSearchQueryAuditEntry[]): Sha256Digest {
  return canonicalSha256({ schema_version: 1, kind: READABLE_SEARCH_QUERY_AUDIT_ROW_SET_KIND, rows: exportRows(rows) });
}

export function readableSearchQueryAuditExportDocument(command: ReadableSearchQueryAuditExportCommandV1, rows: readonly StoredReadableSearchQueryAuditEntry[]): ReadableSearchQueryAuditExportDocumentV1 {
  const valid = validateReadableSearchQueryAuditMaintenanceCommand(command);
  if (valid.kind !== READABLE_SEARCH_QUERY_AUDIT_EXPORT_COMMAND_KIND) fail('readable search query audit export requires an export command');
  return Object.freeze({ schema_version: 1, kind: READABLE_SEARCH_QUERY_AUDIT_EXPORT_KIND, authority_id: valid.authority_id, organization_id: valid.organization_id, from_inclusive: valid.from_inclusive, until_exclusive: valid.until_exclusive, rows: exportRows(rows) });
}

export function readableSearchQueryAuditExportBytes(document: ReadableSearchQueryAuditExportDocumentV1): Buffer {
  return Buffer.from(canonicalJson(document as unknown as JsonValue), 'utf8');
}

const CONTROL_DETAIL_COMMON_KEYS = [
  'schema_version', 'kind', 'command_id', 'command_sha256', 'authority_id',
  'organization_id', 'owner_principal_id', 'owner_membership_id', 'reason',
] as const;
const EXPORT_DETAIL_KEYS = [...CONTROL_DETAIL_COMMON_KEYS, 'from_inclusive', 'until_exclusive', 'output_path_sha256', 'row_count', 'ordered_rows_sha256', 'export_sha256'] as const;
const EXPIRY_DETAIL_KEYS = [...CONTROL_DETAIL_COMMON_KEYS, 'retention_days', 'cutoff', 'row_count', 'ordered_rows_sha256'] as const;

function controlAction(value: unknown): ReadableSearchQueryAuditControlAction {
  if (value !== READABLE_SEARCH_QUERY_AUDIT_EXPORT_ACTION && value !== READABLE_SEARCH_QUERY_AUDIT_EXPIRED_ACTION) fail('readable search query audit control action is invalid');
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative safe integer`);
  return value as number;
}

/** Validates an immutable generic-audit receipt's exact detail bytes. */
export function validateReadableSearchQueryAuditControlDetail(input: { action: ReadableSearchQueryAuditControlAction; subject_id: string; occurred_at: string }, value: unknown): JsonValue {
  const detail = object(value, 'readable search query audit control detail');
  const exportAction = input.action === READABLE_SEARCH_QUERY_AUDIT_EXPORT_ACTION;
  exactKeys(detail, exportAction ? EXPORT_DETAIL_KEYS : EXPIRY_DETAIL_KEYS, 'readable search query audit control detail');
  if (detail.schema_version !== 1 || detail.kind !== (exportAction ? 'readable-search-query-audit-export-authorized-detail-v1' : 'readable-search-query-audit-expired-detail-v1')) fail('readable search query audit control detail version or kind is invalid');
  commandId(detail.command_id); digest(detail.command_sha256, 'readable search query audit command_sha256');
  federation(detail.authority_id, 'oau', 'readable search query audit control authority_id');
  federation(detail.organization_id, 'org', 'readable search query audit control organization_id');
  federation(detail.owner_principal_id, 'prn', 'readable search query audit control owner_principal_id');
  const owner = federation(detail.owner_membership_id, 'mem', 'readable search query audit control owner_membership_id');
  if (owner !== input.subject_id) fail('readable search query audit control subject differs from owner');
  reason(detail.reason); positive(detail.row_count, 'readable search query audit control row_count'); digest(detail.ordered_rows_sha256, 'readable search query audit ordered_rows_sha256');
  if (exportAction) {
    timestamp(detail.from_inclusive, 'readable search query audit control from_inclusive'); timestamp(detail.until_exclusive, 'readable search query audit control until_exclusive');
    digest(detail.output_path_sha256, 'readable search query audit output_path_sha256'); digest(detail.export_sha256, 'readable search query audit export_sha256');
  } else {
    if (detail.retention_days !== 180) fail('readable search query audit retention_days is invalid');
    if (timestamp(detail.cutoff, 'readable search query audit cutoff') !== input.occurred_at) fail('readable search query audit cutoff differs from receipt time');
  }
  return detail as JsonValue;
}

export function readableSearchQueryAuditControlDetailJson(input: { action: ReadableSearchQueryAuditControlAction; subject_id: string; occurred_at: string }, detail: JsonValue): string {
  return canonicalJson(validateReadableSearchQueryAuditControlDetail(input, detail));
}

export function validateStoredReadableSearchQueryAuditControlEvent(value: unknown): StoredReadableSearchQueryAuditControlEvent {
  const row = object(value, 'stored readable search query audit control event');
  exactKeys(row, ['audit_sequence', 'occurred_at', 'actor_kind', 'action', 'subject_id', 'detail_json'], 'stored readable search query audit control event');
  const action = controlAction(row.action); const occurredAt = timestamp(row.occurred_at, 'stored readable search query audit control occurred_at');
  if (row.actor_kind !== 'admin') fail('stored readable search query audit control actor_kind is invalid');
  const subjectId = federation(row.subject_id, 'mem', 'stored readable search query audit control subject_id');
  if (typeof row.detail_json !== 'string') fail('stored readable search query audit control detail_json must be text');
  let detail: JsonValue;
  try { detail = parseCanonicalJson(row.detail_json) as JsonValue; } catch (error) { throw new ReadableSearchQueryAuditMaintenanceIntegrityError('stored readable search query audit control detail_json is not canonical JSON', { cause: error }); }
  if (canonicalJson(validateReadableSearchQueryAuditControlDetail({ action, subject_id: subjectId, occurred_at: occurredAt }, detail)) !== row.detail_json) fail('stored readable search query audit control detail_json changed its canonical bytes');
  return Object.freeze({ audit_sequence: positive(row.audit_sequence, 'stored readable search query audit control audit_sequence'), occurred_at: occurredAt, actor_kind: 'admin', action, subject_id: subjectId, detail_json: row.detail_json });
}

export function readableSearchQueryAuditControlCommandBinding(event: StoredReadableSearchQueryAuditControlEvent): ReadableSearchQueryAuditCommandBinding {
  const detail = object(parseCanonicalJson(event.detail_json), 'stored readable search query audit control detail');
  return Object.freeze({ action: event.action, command_id: commandId(detail.command_id), command_sha256: digest(detail.command_sha256, 'stored readable search query audit control command_sha256') });
}

export function validateReadableSearchQueryAuditCommandBinding(binding: ReadableSearchQueryAuditCommandBinding): ReadableSearchQueryAuditCommandBinding {
  return Object.freeze({ command_id: commandId(binding.command_id), action: controlAction(binding.action), command_sha256: digest(binding.command_sha256, 'readable search query audit command binding digest') });
}
