import { fail } from './validation.js';

export const PERSON_UPDATE_TITLE_MAX_BYTES = 200;
export const PERSON_UPDATE_TEXT_MAX_BYTES = 8 * 1024;
export type PersonUploadMetadataStateV1 = 'pending' | 'processing' | 'ready' | 'unavailable';

export function validatePersonUpdateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail('Person update request_id must be a lowercase UUID v4');
  return value;
}
export function validatePersonUploadContextId(value: unknown): string {
  if (typeof value !== 'string' || !/^ctx_[0-9a-f]{64}$/.test(value)) fail('Person upload context_id is invalid');
  return value;
}
