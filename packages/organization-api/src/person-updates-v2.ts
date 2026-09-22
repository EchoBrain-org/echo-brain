import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { validateProjectContextAudienceV1, validateProjectIdV1, type ProjectContextAudienceV1, type ProjectIdV1 } from './project-context-v1.js';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  asRecord,
  assertExactKeys,
  assertOnlyEnumerableDataProperties,
  fail,
} from './validation.js';
import {
  PERSON_UPDATE_TEXT_MAX_BYTES,
  PERSON_UPDATE_TITLE_MAX_BYTES,
  validatePersonUpdateRequestId,
  validatePersonUploadContextId,
  validatePersonUploadSearchV1,
  type PersonUploadMetadataStateV1,
  type PersonUploadSearchV1,
} from './person-updates.js';

export const PERSON_UPDATES_PATH_V2 = '/v2/person/updates';
export type PersonUploadAudienceV2 = ProjectContextAudienceV1;
export interface PersonUpdateSubmitV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-person-update-submit-v2';
  readonly request_id: string;
  readonly title: string;
  readonly text: string;
  /** Association is independent from the content's selected audience. */
  readonly project_id: ProjectIdV1 | null;
  readonly audience: PersonUploadAudienceV2;
}
export interface PersonUpdateReceiptV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-person-update-receipt-v2';
  readonly request_id: string;
  readonly context_id: string;
  readonly received_at: string;
  readonly project_id: ProjectIdV1 | null;
  readonly audience: PersonUploadAudienceV2;
  readonly state: 'received';
}
export type PersonUpdateStatusV2 = Omit<PersonUpdateReceiptV2, 'kind' | 'state'> & {
  readonly kind: 'echo-person-update-status-v2';
  readonly status: 'stored';
  readonly metadata: PersonUploadMetadataStateV1;
};
/** Generic original reads intentionally omit project association coordinates. */
export interface PersonUploadContentV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-person-upload-content-v2';
  readonly context_id: string;
  readonly received_at: string;
  readonly audience: PersonUploadAudienceV2;
  readonly title: string;
  readonly text: string;
}
export type PersonUploadSearchV2 = PersonUploadSearchV1;
export interface PersonUploadSearchResultV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-person-upload-search-v2';
  readonly results: readonly {
    readonly context_id: string;
    readonly received_at: string;
    readonly audience: PersonUploadAudienceV2;
    readonly title: string;
    readonly excerpt: string;
  }[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  assertOnlyEnumerableDataProperties(value, label);
  return asRecord(value, label);
}
function text(value: unknown, label: string, maximum: number, multiline: boolean): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 ||
      Array.from(value).reduce((bytes, point) => { const n = point.codePointAt(0)!; return bytes + (n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4); }, 0) > maximum ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value) ||
      (!multiline && /[\t\r\n]/u.test(value))) fail(`${label} is invalid`);
}
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Person update timestamp is invalid');
}
export function validatePersonUploadAudienceV2(value: unknown): PersonUploadAudienceV2 {
  return validateProjectContextAudienceV1(value);
}
function coordinates(record: Record<string, unknown>): { project_id: ProjectIdV1 | null; audience: PersonUploadAudienceV2 } {
  const project_id = record.project_id === null ? null : validateProjectIdV1(record.project_id, 'Person update project_id');
  return { project_id, audience: validatePersonUploadAudienceV2(record.audience) };
}
function bodyBound(value: unknown, label: string): void {
  if (canonicalJsonBytes(value).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) fail(`${label} exceeds JSON byte bound`);
}
export function validatePersonUpdateSubmitV2(value: unknown): PersonUpdateSubmitV2 {
  const record = object(value, 'Person update');
  assertExactKeys(record, ['schema_version', 'kind', 'request_id', 'title', 'text', 'project_id', 'audience'], 'Person update');
  if (record.schema_version !== 2 || record.kind !== 'echo-person-update-submit-v2') fail('Person update version or kind is unsupported');
  validatePersonUpdateRequestId(record.request_id); text(record.title, 'Person update title', PERSON_UPDATE_TITLE_MAX_BYTES, false); text(record.text, 'Person update text', PERSON_UPDATE_TEXT_MAX_BYTES, true);
  const result = { schema_version: 2 as const, kind: 'echo-person-update-submit-v2' as const, request_id: record.request_id as string, title: record.title as string, text: record.text as string, ...coordinates(record) };
  bodyBound(result, 'Person update'); return result;
}
export function validatePersonUpdateReceiptV2(value: unknown): PersonUpdateReceiptV2 {
  const record = object(value, 'Person update receipt'); assertExactKeys(record, ['schema_version', 'kind', 'request_id', 'context_id', 'received_at', 'project_id', 'audience', 'state'], 'Person update receipt');
  if (record.schema_version !== 2 || record.kind !== 'echo-person-update-receipt-v2' || record.state !== 'received') fail('Person update receipt is invalid');
  validatePersonUpdateRequestId(record.request_id); validatePersonUploadContextId(record.context_id); timestamp(record.received_at);
  const response = { schema_version: 2 as const, kind: 'echo-person-update-receipt-v2' as const, request_id: record.request_id as string, context_id: record.context_id as string, received_at: record.received_at as string, ...coordinates(record), state: 'received' as const };
  bodyBound(response, 'Person update receipt'); return response;
}
export function validatePersonUpdateStatusV2(value: unknown): PersonUpdateStatusV2 {
  const record = object(value, 'Person update status'); assertExactKeys(record, ['schema_version', 'kind', 'request_id', 'context_id', 'received_at', 'project_id', 'audience', 'status', 'metadata'], 'Person update status');
  if (record.schema_version !== 2 || record.kind !== 'echo-person-update-status-v2' || record.status !== 'stored' || !['pending', 'processing', 'ready', 'unavailable'].includes(record.metadata as string)) fail('Person update status is invalid');
  validatePersonUpdateRequestId(record.request_id); validatePersonUploadContextId(record.context_id); timestamp(record.received_at);
  const response = { schema_version: 2 as const, kind: 'echo-person-update-status-v2' as const, request_id: record.request_id as string, context_id: record.context_id as string, received_at: record.received_at as string, ...coordinates(record), status: 'stored' as const, metadata: record.metadata as PersonUploadMetadataStateV1 };
  bodyBound(response, 'Person update status'); return response;
}
export function validatePersonUploadContentV2(value: unknown): PersonUploadContentV2 {
  const record = object(value, 'Person upload content'); assertExactKeys(record, ['schema_version', 'kind', 'context_id', 'received_at', 'audience', 'title', 'text'], 'Person upload content');
  if (record.schema_version !== 2 || record.kind !== 'echo-person-upload-content-v2') fail('Person upload content is invalid');
  validatePersonUploadContextId(record.context_id); timestamp(record.received_at); text(record.title, 'Person upload content title', PERSON_UPDATE_TITLE_MAX_BYTES, false); text(record.text, 'Person upload content text', PERSON_UPDATE_TEXT_MAX_BYTES, true);
  const response = { schema_version: 2 as const, kind: 'echo-person-upload-content-v2' as const, context_id: record.context_id as string, received_at: record.received_at as string, audience: validatePersonUploadAudienceV2(record.audience), title: record.title as string, text: record.text as string };
  bodyBound(response, 'Person upload content'); return response;
}
export function validatePersonUploadSearchV2(value: unknown): PersonUploadSearchV2 { return validatePersonUploadSearchV1(value); }
export function validatePersonUploadSearchResultV2(value: unknown): PersonUploadSearchResultV2 {
  const record = object(value, 'Person upload results'); assertExactKeys(record, ['schema_version', 'kind', 'results'], 'Person upload results');
  if (record.schema_version !== 2 || record.kind !== 'echo-person-upload-search-v2' || !Array.isArray(record.results) || record.results.length > 10) fail('Person upload results are invalid');
  const ids = new Set<string>();
  const results = record.results.map(entry => {
    const item = object(entry, 'Person upload result'); assertExactKeys(item, ['context_id', 'received_at', 'audience', 'title', 'excerpt'], 'Person upload result');
    const context_id = validatePersonUploadContextId(item.context_id); if (ids.has(context_id)) fail('Person upload results contain duplicate IDs'); ids.add(context_id);
    timestamp(item.received_at); text(item.title, 'Person upload result title', PERSON_UPDATE_TITLE_MAX_BYTES, false); text(item.excerpt, 'Person upload result excerpt', 1200, true);
    if ([...(item.excerpt as string)].length > 300) fail('Person upload result excerpt is invalid');
    return { context_id, received_at: item.received_at as string, audience: validatePersonUploadAudienceV2(item.audience), title: item.title as string, excerpt: item.excerpt as string };
  });
  const response = { schema_version: 2 as const, kind: 'echo-person-upload-search-v2' as const, results }; bodyBound(response, 'Person upload results'); return response;
}
