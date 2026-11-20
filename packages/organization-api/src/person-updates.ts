import { fail, MAX_ORGANIZATION_API_BODY_BYTES } from './validation.js';

/** A note has no size of its own: its submit request is held to the one Person request body bound. */
export const PERSON_UPDATE_REQUEST_MAX_BYTES_V1 = MAX_ORGANIZATION_API_BODY_BYTES;
/** An opened note or imported meeting's text comes a page of at most 8 KiB at a time, with a cursor for the rest. */
export const PERSON_OPEN_TEXT_PAGE_MAX_BYTES_V1 = 8 * 1024;
export type PersonUploadMetadataStateV1 = 'pending' | 'processing' | 'ready' | 'unavailable';

export function validatePersonUpdateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail('Person update request_id must be a lowercase UUID v4');
  return value;
}
export function validatePersonUploadContextId(value: unknown): string {
  if (typeof value !== 'string' || !/^ctx_[0-9a-f]{64}$/.test(value)) fail('Person upload context_id is invalid');
  return value;
}
