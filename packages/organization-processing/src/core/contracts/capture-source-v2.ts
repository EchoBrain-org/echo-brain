import type { AdapterOperationContext } from './adapter.js';
import { assertPlainContextObjectV1, CONTEXT_CAPTURE_LIMITS_V1 } from './context-capture-v1.js';
import { assertCaptureTextV1, type ContextCaptureContentV2 } from './context-capture-v2.js';
import type { CaptureSourceConfigV1 } from './capture-source-config-v1.js';
import type { SourceAdapterIdentityV1 } from './source.js';
import { canonicalSourceContentV1 } from '../processing/source-admission.js';
import { isCanonicalTimestamp } from './validation.js';

export const CAPTURE_SOURCE_LIMITS_V2 = Object.freeze({
  batch: CONTEXT_CAPTURE_LIMITS_V1.batch, cursor_bytes: 16 * 1024, external_id_bytes: 1024,
});

export interface CaptureSourcePullRequestV2 {
  readonly cursor?: string;
  readonly limit: number;
}
export interface CaptureSourceItemV2 {
  readonly external_id: string;
  /** Observation time. It never selects a predecessor. */
  readonly captured_at: string;
  readonly content: ContextCaptureContentV2;
}
export interface CaptureSourceBatchV2 {
  readonly items: readonly CaptureSourceItemV2[];
  /** Opaque resume position. An absent cursor leaves the stored bookmark unchanged. */
  readonly next_cursor?: string;
}

/**
 * Provider-facing capture port. Providers return content, never envelopes:
 * Authority selects each predecessor, so providers never handle ECHO revision history.
 */
export interface CaptureSourceV2 {
  /** kind 'source'. */
  readonly identity: SourceAdapterIdentityV1;
  pull(request: CaptureSourcePullRequestV2, context?: AdapterOperationContext): Promise<CaptureSourceBatchV2>;
}
/** One configured provider. The core calls the provider-owned read-grant check before the pull and again before admission. */
export interface CaptureProviderV2 {
  readonly source: CaptureSourceV2;
  require_read_current(context?: AdapterOperationContext): void | Promise<void>;
}
export type CaptureProviderFactoryV2<TDeps = unknown> = (config: CaptureSourceConfigV1, deps: TDeps) => CaptureProviderV2;
/** Keyed by adapter_id. Registering one entry is the only vendor-specific step outside the provider. */
export type CaptureProviderMapV2<TDeps = unknown> = Readonly<Record<string, CaptureProviderFactoryV2<TDeps>>>;

export function assertCaptureSourceCursorV2(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > CAPTURE_SOURCE_LIMITS_V2.cursor_bytes) throw new Error('Capture source cursor exceeds its bound');
}
export function captureSourcePullRequestV2(input: { readonly cursor?: string; readonly limit: number }): CaptureSourcePullRequestV2 {
  assertPlainContextObjectV1(input, ['cursor', 'limit'], 'Capture source pull request');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CAPTURE_SOURCE_LIMITS_V2.batch) throw new Error('Capture source pull limit exceeds its bound');
  if (input.cursor !== undefined) assertCaptureSourceCursorV2(input.cursor);
  return Object.freeze({ limit: input.limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/**
 * Checks a returned batch's shape and bounds, then returns a deep-frozen copy so the caller
 * owns the bytes before any asynchronous step. Content is fully validated when Authority
 * builds each envelope.
 */
export function ownCaptureSourceBatchV2(value: unknown, request: CaptureSourcePullRequestV2): CaptureSourceBatchV2 {
  // Rejects accessors and other non-data fields anywhere in the batch before it is read.
  assertPlainContextObjectV1(value, ['items', 'next_cursor'], 'Capture source batch');
  const batch = value as CaptureSourceBatchV2;
  if (!Array.isArray(batch.items) || batch.items.length > request.limit) throw new Error('Capture source returned an invalid batch');
  if (batch.next_cursor !== undefined) assertCaptureSourceCursorV2(batch.next_cursor);
  const seen = new Set<string>();
  for (const item of batch.items) {
    assertPlainContextObjectV1(item, ['external_id', 'captured_at', 'content'], 'Capture source item');
    assertCaptureTextV1(item.external_id, 'Capture external ID', CAPTURE_SOURCE_LIMITS_V2.external_id_bytes);
    // One state per item per batch. Batch order never orders revisions, so a replayed
    // batch stays idempotent: each item is compared with the retained head only.
    if (seen.has(item.external_id)) throw new Error('Capture source batch repeats an item');
    seen.add(item.external_id);
    if (!isCanonicalTimestamp(item.captured_at)) throw new Error('Capture observation time must be canonical UTC');
    if (item.content === null || typeof item.content !== 'object' || Array.isArray(item.content) ||
        Buffer.byteLength(canonicalSourceContentV1(item.content), 'utf8') > CONTEXT_CAPTURE_LIMITS_V1.envelope_bytes) throw new Error('Capture content exceeds its bound');
  }
  return freeze(JSON.parse(canonicalSourceContentV1(batch)) as CaptureSourceBatchV2);
}
