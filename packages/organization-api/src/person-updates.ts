import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { validatePersonQueryText } from './person-query.js';
import { asRecord, assertExactKeys, assertOnlyEnumerableDataProperties, fail, MAX_ORGANIZATION_API_BODY_BYTES } from './validation.js';

/** Retired route. The Authority keeps it reserved against provider adapters. */
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
export type PersonUploadMetadataStateV1 = 'pending' | 'processing' | 'ready' | 'unavailable';
export interface PersonUploadSearchV1 { readonly query: string; readonly limit?: number }

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
export function validatePersonUploadSearchV1(value: unknown): PersonUploadSearchV1 {
  const r = object(value);
  assertExactKeys(r, ['query', ...(Object.hasOwn(r, 'limit') ? ['limit'] : [])], 'Person upload search');
  const query = validatePersonQueryText(r.query);
  if (Object.hasOwn(r, 'limit') && (!Number.isInteger(r.limit) || (r.limit as number) < 1 || (r.limit as number) > 10)) fail('Person upload search limit must be 1 to 10');
  return { query, limit: (r.limit as number | undefined) ?? 10 };
}
