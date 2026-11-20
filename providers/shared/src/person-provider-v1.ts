import { randomUUID } from 'node:crypto';
import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';

export type PersonProviderFailureCodeV1 = 'invalid_request' | 'invalid_output' | 'unauthorized' | 'not_found' | 'stale_access_state' | 'unavailable' | 'rate_limited';
/** The failures a provider read surfaces as they are; any other error is `unavailable`. */
export const PERSON_PROVIDER_FAILURE_CODES_V1: ReadonlySet<string> = new Set<PersonProviderFailureCodeV1>(
  ['invalid_request', 'invalid_output', 'unauthorized', 'not_found', 'stale_access_state', 'unavailable', 'rate_limited']);

/** One provider operation between abort checks, its failure re-raised as the provider's own: unknown errors are `unavailable`. */
export async function guardedPersonProviderOperationV1<T>(failure: (code: PersonProviderFailureCodeV1) => never, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  try {
    const value = await operation();
    signal?.throwIfAborted();
    return value;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AuthorityOperationError && PERSON_PROVIDER_FAILURE_CODES_V1.has(error.code)) failure(error.code as PersonProviderFailureCodeV1);
    return failure('unavailable');
  }
}

/** Fixed server composition. Product adapters retain their existing validation and error contracts. */
export interface PersonProviderV1 {
  readonly id: string;
  /** Compiled provider registration, never a request field or Nango integration ID. */
  readonly storage_namespace: string;
  readonly display_name: string;
  readonly nango_provider_id: string;
  readonly scope_id_pattern: RegExp;
  readonly oauth_scopes: string;
  readonly credential_origin: string;
  /** A trailing slash denotes a prefix; every other entry is an exact path. */
  credential_paths(cloudId: string): readonly string[];
  failure(code: PersonProviderFailureCodeV1): never;
  string(value: unknown, maximum?: number, pattern?: RegExp): string;
  record(value: unknown): Record<string, unknown>;
  array(value: unknown, maximum: number): readonly unknown[];
  copyBinding(value: PersonConnectorReadBindingV1): PersonConnectorReadBindingV1;
}

/** Validate the SQL identifier once before constructing provider-owned table names. */
export function personProviderStorageNamespaceV1(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
    throw new AuthorityOperationError('invalid_request', 'Provider storage namespace is invalid');
  }
  return value;
}

/** Shared wire primitives and binding validation; provider fields remain adapter-owned. */
export function createPersonProviderValidationV1(id: string, scope: RegExp, message: string) {
  const failure: PersonProviderV1['failure'] = code => { throw new AuthorityOperationError(code, message); };
  function string(value: unknown, maximum = 256, pattern = /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u): string {
    if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum ||
        value !== value.normalize('NFC') || !pattern.test(value)) failure('invalid_output');
    return value;
  }
  function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d) || !d.enumerable)) failure('invalid_output');
    return value as Record<string, unknown>;
  }
  function array(value: unknown, maximum: number): readonly unknown[] {
    if (!Array.isArray(value) || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.getOwnPropertyNames(value).length !== value.length + 1) failure('invalid_output');
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (d === undefined || !('value' in d) || !d.enumerable) failure('invalid_output');
    }
    return value;
  }
  function copyBinding(value: PersonConnectorReadBindingV1): PersonConnectorReadBindingV1 {
    record(value);
    for (const field of ['organization_id', 'principal_id', 'membership_id', 'external_subject_id'] as const) string(value[field]);
    if (value.tool_id !== id || typeof value.external_scope_id !== 'string' || !scope.test(value.external_scope_id) ||
        !/^sha256:[0-9a-f]{64}$/.test(value.read_grant_sha256)) failure('unauthorized');
    return Object.freeze({ organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id,
      tool_id: id, external_scope_id: value.external_scope_id, external_subject_id: value.external_subject_id, read_grant_sha256: value.read_grant_sha256 });
  }
  return Object.freeze({ failure, string, record, array, copyBinding });
}

/** Text bounded to `bytes` of UTF-8, cut only between code points, then NFC again. */
export function boundUtf8V1(value: string, bytes: number): string {
  let text = ''; let size = 0;
  for (const point of value.normalize('NFC')) {
    const next = Buffer.byteLength(point, 'utf8');
    if (size + next > bytes) break;
    size += next; text += point;
  }
  return text.normalize('NFC');
}

const RECEIPT_PLACEHOLDER = `sha256:${'0'.repeat(64)}`;
/**
 * The audited live source's envelope around a reader's items (ADR-0047): its flags, one receipt digest, its own list
 * cursor and the longest notice it lets through (1 KiB).
 */
const LIVE_PAGE_ENVELOPE_BYTES = canonicalJsonBytes({ items: [], truncated: true, receipt_digests: [RECEIPT_PLACEHOLDER],
  next_cursor: `live_cursor_${'0'.repeat(36)}_${Number.MAX_SAFE_INTEGER}`, notice: 'x'.repeat(1024), page_full: true, anchor_truncated: true }).byteLength;

type LiveValueV1 = { readonly citation: { readonly kind: string } };

/**
 * How many of `values`, from the first and at most `maximum`, fit one live evidence result: the transport bound on what
 * one read may return (`PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1`), less the audited source's envelope. Each item is
 * measured as that source sends it, with its release id and receipt. At least one item is always offered, so an item too
 * large for any page fails at the boundary that owns the bound rather than looping.
 */
export function personLiveEvidencePageFitV1(values: readonly LiveValueV1[], maximum = Number.MAX_SAFE_INTEGER): number {
  let bytes = LIVE_PAGE_ENVELOPE_BYTES;
  let count = 0;
  for (const value of values) {
    const { handle: _handle, ...shown } = value as LiveValueV1 & { readonly handle?: unknown };
    bytes += canonicalJsonBytes({ ...shown, id: `live_${'0'.repeat(64)}`, kind: value.citation.kind, receipt_sha256: RECEIPT_PLACEHOLDER }).byteLength + 1;
    if (count >= maximum || (bytes > PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1 && count > 0)) break;
    count += 1;
  }
  return count;
}

/** What one provider read gave a live list: its rows, the provider's position after them, and whether more follow. */
export interface PersonLiveListReadV1<R, S> {
  readonly rows: readonly R[];
  readonly state: S;
  readonly more: boolean;
  /** The provider's last page was exactly full, so its end is not confirmed (ADR-0041). */
  readonly full: boolean;
}

/**
 * The continuation every live list shares, so a list can be read whole page by page. A page releases as many rows as
 * were asked for and one result carries; the rest wait in its cursor, and the next page releases them first with no new
 * provider read. Only then does it read on from the provider's position. A cursor continues only the selection that
 * issued it.
 */
export function createPersonLiveListV1<R, S>(prefix: string, failure: (code: 'invalid_request') => never) {
  const cursors = new Map<string, PersonLiveListReadV1<R, S> & { readonly selection: string }>();
  return Object.freeze({
    /** The continuation `cursor` names; undefined for a first page. Checked before any provider read. */
    resume(cursor: string | undefined, selection: string): PersonLiveListReadV1<R, S> | undefined {
      if (cursor === undefined) return undefined;
      const previous = cursors.get(cursor);
      if (previous === undefined || previous.selection !== selection) failure('invalid_request');
      return previous;
    },
    async page(input: {
      readonly previous: PersonLiveListReadV1<R, S> | undefined;
      readonly selection: string;
      readonly wanted: number;
      readonly value: (row: R) => LiveValueV1;
      /** The next provider page, from `state` (undefined for the first). */
      readonly read: (state: S | undefined) => Promise<PersonLiveListReadV1<R, S>>;
    }): Promise<{ readonly rows: readonly R[]; readonly state: S; readonly truncated: boolean; readonly page_full: boolean; readonly next_cursor?: string }> {
      const current = input.previous !== undefined && input.previous.rows.length > 0 ? input.previous : await input.read(input.previous?.state);
      const shown = current.rows.slice(0, personLiveEvidencePageFitV1(current.rows.map(input.value), input.wanted));
      const pending = Object.freeze(current.rows.slice(shown.length));
      let next_cursor: string | undefined;
      if (current.more || pending.length > 0) {
        next_cursor = `${prefix}${randomUUID()}`;
        cursors.set(next_cursor, Object.freeze({ selection: input.selection, rows: pending, state: current.state, more: current.more, full: current.full }));
      }
      return Object.freeze({ rows: Object.freeze(shown), state: current.state, truncated: next_cursor !== undefined, page_full: next_cursor === undefined && current.full,
        ...(next_cursor === undefined ? {} : { next_cursor }) });
    },
  });
}

/** `operation` over each value, four at a time, results in order: bounded provider fan-out. */
export async function inBatchesOfFourV1<T, R>(values: readonly T[], operation: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < values.length; offset += 4) result.push(...await Promise.all(values.slice(offset, offset + 4).map(operation)));
  return result;
}
