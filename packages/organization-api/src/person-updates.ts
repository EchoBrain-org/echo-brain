import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { asRecord, assertExactKeys, assertOnlyEnumerableDataProperties, fail, MAX_ORGANIZATION_API_BODY_BYTES } from './validation.js';

export const PERSON_UPDATES_PATH_V1 = '/v1/person/updates';
export const PERSON_UPDATE_TITLE_MAX_BYTES = 200;
export const PERSON_UPDATE_TEXT_MAX_BYTES = 8 * 1024;

export interface PersonUpdateSubmitV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-update-submit-v1';
  readonly request_id: string;
  readonly title: string;
  readonly text: string;
}
export interface PersonUpdateReceiptV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-update-receipt-v1';
  readonly request_id: string;
  readonly received_at: string;
  readonly state: 'received';
}
export type PersonUpdateReasonV1 = 'reviewer_unavailable' | 'temporarily_unavailable' | 'processing_rejected' | 'approval_delivery_quarantined';
export type PersonUpdateProgressV1 =
  | { readonly status: 'received' | 'processing' | 'awaiting_approval' | 'no_signals' }
  | { readonly status: 'resolved'; readonly outcome: 'approved' | 'rejected' | 'partially_approved' }
  | { readonly status: 'blocked' | 'failed'; readonly reason: PersonUpdateReasonV1 };
export type PersonUpdateStatusV1 = Omit<PersonUpdateReceiptV1, 'kind' | 'state'> & {
  readonly kind: 'echo-person-update-status-v1';
} & PersonUpdateProgressV1;

export function validatePersonUpdateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    fail('Person update request_id must be a lowercase UUID v4');
  }
  return value;
}

function text(value: unknown, maximum: number, multiline: boolean): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 ||
      Array.from(value).reduce((bytes, point) => { const n = point.codePointAt(0)!; return bytes + (n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4); }, 0) > maximum ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) ||
      (!multiline && /[\t\r\n]/u.test(value)) ||
      /[\uD800-\uDFFF]/u.test(value)) fail('Person update text is invalid');
}

export function validatePersonUpdateSubmitV1(value: unknown): PersonUpdateSubmitV1 {
  assertOnlyEnumerableDataProperties(value, 'Person update');
  const r = asRecord(value, 'Person update');
  assertExactKeys(r, ['schema_version', 'kind', 'request_id', 'title', 'text'], 'Person update');
  if (r.schema_version !== 1 || r.kind !== 'echo-person-update-submit-v1') fail('Person update version or kind is unsupported');
  validatePersonUpdateRequestId(r.request_id);
  text(r.title, PERSON_UPDATE_TITLE_MAX_BYTES, false);
  text(r.text, PERSON_UPDATE_TEXT_MAX_BYTES, true);
  if (canonicalJsonBytes(r).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) fail('Person update exceeds JSON byte bound');
  return { schema_version: 1, kind: 'echo-person-update-submit-v1', request_id: r.request_id as string, title: r.title, text: r.text };
}

function coordinates(r: Record<string, unknown>): void {
  validatePersonUpdateRequestId(r.request_id);
  if (r.schema_version !== 1 || typeof r.received_at !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.received_at) ||
      !Number.isFinite(Date.parse(r.received_at)) || new Date(r.received_at).toISOString() !== r.received_at) fail('Person update receipt is invalid');
}

export function validatePersonUpdateReceiptV1(value: unknown): PersonUpdateReceiptV1 {
  const r = asRecord(value, 'Person update receipt');
  assertExactKeys(r, ['schema_version', 'kind', 'request_id', 'received_at', 'state'], 'Person update receipt');
  coordinates(r);
  if (r.kind !== 'echo-person-update-receipt-v1' || r.state !== 'received') fail('Person update receipt is invalid');
  return { ...r } as unknown as PersonUpdateReceiptV1;
}

export function validatePersonUpdateStatusV1(value: unknown): PersonUpdateStatusV1 {
  const r = asRecord(value, 'Person update status');
  const extra = r.status === 'resolved' ? ['outcome'] : r.status === 'blocked' || r.status === 'failed' ? ['reason'] : [];
  assertExactKeys(r, ['schema_version', 'kind', 'request_id', 'received_at', 'status', ...extra], 'Person update status');
  coordinates(r);
  if (r.kind !== 'echo-person-update-status-v1' ||
      !['received', 'processing', 'awaiting_approval', 'resolved', 'no_signals', 'blocked', 'failed'].includes(r.status as string) ||
      (r.status === 'resolved' && !['approved', 'rejected', 'partially_approved'].includes(r.outcome as string)) ||
      (extra[0] === 'reason' && !['reviewer_unavailable', 'temporarily_unavailable', 'processing_rejected', 'approval_delivery_quarantined'].includes(r.reason as string))) fail('Person update status is invalid');
  return { ...r } as unknown as PersonUpdateStatusV1;
}
