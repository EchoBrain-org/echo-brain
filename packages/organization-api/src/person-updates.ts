import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { validatePersonQueryText } from './person-query.js';
import { asRecord, assertExactKeys, assertOnlyEnumerableDataProperties, fail, MAX_ORGANIZATION_API_BODY_BYTES } from './validation.js';

export const PERSON_UPDATES_PATH_V1 = '/v1/person/updates';
export const PERSON_UPDATE_TITLE_MAX_BYTES = 200;
export const PERSON_UPDATE_TEXT_MAX_BYTES = 8 * 1024;
export type PersonUploadVisibilityV1 = 'only_me' | 'team';

/** A bounded text transport, not a taxonomy or canonical shape for uploaded context. */
export interface PersonUpdateSubmitV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-update-submit-v1';
  readonly request_id: string;
  readonly title: string;
  readonly text: string;
  readonly visibility?: PersonUploadVisibilityV1;
}
export interface PersonUpdateReceiptV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-update-receipt-v1';
  readonly request_id: string;
  readonly context_id: string;
  readonly received_at: string;
  readonly visibility: PersonUploadVisibilityV1;
  readonly state: 'received';
}
export type PersonUploadMetadataStateV1 = 'pending' | 'processing' | 'ready' | 'unavailable';
export type PersonUpdateStatusV1 = Omit<PersonUpdateReceiptV1, 'kind' | 'state'> & {
  readonly kind: 'echo-person-update-status-v1';
  readonly status: 'stored';
  readonly metadata: PersonUploadMetadataStateV1;
};
export interface PersonUploadContentV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-upload-content-v1';
  readonly context_id: string;
  readonly received_at: string;
  readonly visibility: PersonUploadVisibilityV1;
  readonly title: string;
  readonly text: string;
}
export interface PersonUploadSearchV1 { readonly query: string; readonly limit?: number }
export interface PersonUploadSearchResultV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-upload-search-v1';
  readonly results: readonly {
    readonly context_id: string;
    readonly received_at: string;
    readonly visibility: PersonUploadVisibilityV1;
    readonly title: string;
    readonly excerpt: string;
  }[];
}

export function validatePersonUpdateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail('Person update request_id must be a lowercase UUID v4');
  return value;
}
export function validatePersonUploadContextId(value: unknown): string {
  if (typeof value !== 'string' || !/^ctx_[0-9a-f]{64}$/.test(value)) fail('Person upload context_id is invalid');
  return value;
}
export function validatePersonUploadVisibilityV1(value: unknown): PersonUploadVisibilityV1 {
  if (value !== 'only_me' && value !== 'team') fail('Person upload visibility must be only_me or team');
  return value;
}
function text(value: unknown, maximum: number, multiline: boolean): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 ||
      Array.from(value).reduce((bytes, point) => { const n = point.codePointAt(0)!; return bytes + (n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4); }, 0) > maximum ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) ||
      (!multiline && /[\t\r\n]/u.test(value)) || /[\uD800-\uDFFF]/u.test(value)) fail('Person update text is invalid');
}
function timestamp(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Person update timestamp is invalid');
}
function object(value: unknown): Record<string, unknown> {
  assertOnlyEnumerableDataProperties(value, 'Person upload');
  return asRecord(value, 'Person upload');
}
export function validatePersonUpdateSubmitV1(value: unknown): PersonUpdateSubmitV1 {
  const r = object(value);
  assertExactKeys(r, ['schema_version', 'kind', 'request_id', 'title', 'text', ...(Object.hasOwn(r, 'visibility') ? ['visibility'] : [])], 'Person update');
  if (r.schema_version !== 1 || r.kind !== 'echo-person-update-submit-v1') fail('Person update version or kind is unsupported');
  validatePersonUpdateRequestId(r.request_id);
  text(r.title, PERSON_UPDATE_TITLE_MAX_BYTES, false); text(r.text, PERSON_UPDATE_TEXT_MAX_BYTES, true);
  const visibility = Object.hasOwn(r, 'visibility') ? validatePersonUploadVisibilityV1(r.visibility) : 'only_me';
  const result = { schema_version: 1 as const, kind: 'echo-person-update-submit-v1' as const, request_id: r.request_id as string, title: r.title, text: r.text, visibility };
  if (canonicalJsonBytes(result).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) fail('Person update exceeds JSON byte bound');
  return result;
}
function coordinates(r: Record<string, unknown>): void {
  if (r.schema_version !== 1) fail('Person upload version is invalid');
  validatePersonUploadContextId(r.context_id); timestamp(r.received_at); validatePersonUploadVisibilityV1(r.visibility);
}
export function validatePersonUpdateReceiptV1(value: unknown): PersonUpdateReceiptV1 {
  const r = object(value);
  assertExactKeys(r, ['schema_version', 'kind', 'request_id', 'context_id', 'received_at', 'visibility', 'state'], 'Person update receipt');
  coordinates(r); validatePersonUpdateRequestId(r.request_id);
  if (r.kind !== 'echo-person-update-receipt-v1' || r.state !== 'received') fail('Person update receipt is invalid');
  return { ...r } as unknown as PersonUpdateReceiptV1;
}
export function validatePersonUpdateStatusV1(value: unknown): PersonUpdateStatusV1 {
  const r = object(value);
  assertExactKeys(r, ['schema_version', 'kind', 'request_id', 'context_id', 'received_at', 'visibility', 'status', 'metadata'], 'Person update status');
  coordinates(r); validatePersonUpdateRequestId(r.request_id);
  if (r.kind !== 'echo-person-update-status-v1' || r.status !== 'stored' || !['pending', 'processing', 'ready', 'unavailable'].includes(r.metadata as string)) fail('Person update status is invalid');
  return { ...r } as unknown as PersonUpdateStatusV1;
}
export function validatePersonUploadContentV1(value: unknown): PersonUploadContentV1 {
  const r = object(value);
  assertExactKeys(r, ['schema_version', 'kind', 'context_id', 'received_at', 'visibility', 'title', 'text'], 'Person upload content');
  coordinates(r);
  if (r.kind !== 'echo-person-upload-content-v1') fail('Person upload content is invalid');
  text(r.title, PERSON_UPDATE_TITLE_MAX_BYTES, false); text(r.text, PERSON_UPDATE_TEXT_MAX_BYTES, true);
  return { ...r } as unknown as PersonUploadContentV1;
}
export function validatePersonUploadSearchV1(value: unknown): PersonUploadSearchV1 {
  const r = object(value);
  assertExactKeys(r, ['query', ...(Object.hasOwn(r, 'limit') ? ['limit'] : [])], 'Person upload search');
  const query = validatePersonQueryText(r.query);
  if (Object.hasOwn(r, 'limit') && (!Number.isInteger(r.limit) || (r.limit as number) < 1 || (r.limit as number) > 10)) fail('Person upload search limit must be 1 to 10');
  return { query, limit: (r.limit as number | undefined) ?? 10 };
}
export function validatePersonUploadSearchResultV1(value: unknown): PersonUploadSearchResultV1 {
  const r = object(value);
  assertExactKeys(r, ['schema_version', 'kind', 'results'], 'Person upload results');
  if (r.schema_version !== 1 || r.kind !== 'echo-person-upload-search-v1' || !Array.isArray(r.results) || r.results.length > 10) fail('Person upload results are invalid');
  const ids = new Set<string>();
  for (const entry of r.results) {
    const item = object(entry);
    assertExactKeys(item, ['context_id', 'received_at', 'visibility', 'title', 'excerpt'], 'Person upload result');
    const id = validatePersonUploadContextId(item.context_id);
    if (ids.has(id)) fail('Person upload results contain duplicate IDs'); ids.add(id);
    timestamp(item.received_at); validatePersonUploadVisibilityV1(item.visibility);
    text(item.title, PERSON_UPDATE_TITLE_MAX_BYTES, false);
    if (typeof item.excerpt !== 'string' || [...item.excerpt].length > 300) fail('Person upload excerpt is invalid');
    text(item.excerpt, 1200, true);
  }
  return { ...r } as unknown as PersonUploadSearchResultV1;
}
