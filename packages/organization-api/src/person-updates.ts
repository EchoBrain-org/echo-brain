import { validatePersonQueryText } from './person-query.js';
import { asEnumerableRecord, assertExactKeys, fail } from './validation.js';

/** Retired route. The Authority keeps it reserved against provider adapters. */
export const PERSON_UPDATES_PATH_V1 = '/v1/person/updates';
export const PERSON_UPDATE_TITLE_MAX_BYTES = 200;
export const PERSON_UPDATE_TEXT_MAX_BYTES = 8 * 1024;
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
function object(value: unknown): Record<string, unknown> {
  return asEnumerableRecord(value, 'Person upload');
}
export function validatePersonUploadSearchV1(value: unknown): PersonUploadSearchV1 {
  const r = object(value);
  assertExactKeys(r, ['query', ...(Object.hasOwn(r, 'limit') ? ['limit'] : [])], 'Person upload search');
  const query = validatePersonQueryText(r.query);
  if (Object.hasOwn(r, 'limit') && (!Number.isInteger(r.limit) || (r.limit as number) < 1 || (r.limit as number) > 10)) fail('Person upload search limit must be 1 to 10');
  return { query, limit: (r.limit as number | undefined) ?? 10 };
}
