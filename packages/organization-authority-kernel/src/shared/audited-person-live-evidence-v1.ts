import { calendarDateV1, evidenceDateFilterV1, validateEvidenceDateFilterV1, EVIDENCE_ANY_DATE_V1, EVIDENCE_DATE_FIELDS_V1, type EvidenceDateFieldV1, type EvidenceDateSelectionV1, type EvidenceDatesV1 } from "./temporal-query-v1.js";
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJsonBytes, canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_EVIDENCE_LABEL_MAX_BYTES_V1, PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1, PERSON_EVIDENCE_TEXT_MAX_BYTES_V1,
  validatePersonConnectorAccessV1,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '../domain/errors.js';
import type {
  CreatePersonLiveEvidenceSourceV1Options, PersonConnectorReadBindingV1, PersonLiveEvidenceAttributesV1, PersonLiveEvidenceCitationV1,
  PersonLiveEvidenceListInputV1, PersonLiveEvidencePageV1, PersonLiveEvidenceReleaseV1,
  PersonLiveEvidenceResultV1, PersonLiveEvidenceSourceV1, PersonLiveEvidenceValueV1, PersonLiveEvidenceCoordinatesV1,
} from './person-live-evidence-v1.js';

export const PERSON_LIVE_EVIDENCE_MAX_ITEMS_V1 = 50;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ERROR_CODES = new Set(['conflict', 'invalid_request', 'invalid_output', 'not_found', 'stale_access_state', 'unauthorized', 'rate_limited', 'quota_exceeded', 'unavailable']);
/** Each attribute a live item may carry, with its UTF-8 bound: a tool item's owner, due date and status, a container's key and tool. */
const ATTRIBUTE_BYTES: Readonly<Record<keyof PersonLiveEvidenceAttributesV1, number>> = Object.freeze({ owner: 512, due_at: 128, status: 128, key: 256, tool: 64 });
const ATTRIBUTES = Object.freeze(Object.keys(ATTRIBUTE_BYTES) as (keyof PersonLiveEvidenceAttributesV1)[]);
/**
 * Every date field, and `any`, passes this boundary in shape: the reader applies the one asked for or refuses it
 * (research tool contract v1). Its source's capabilities, not this boundary, say which it can apply.
 */
const DATE_SELECTIONS: readonly EvidenceDateSelectionV1[] = Object.freeze([...EVIDENCE_DATE_FIELDS_V1, EVIDENCE_ANY_DATE_V1]);

function invalid(message: string): never { throw new AuthorityOperationError('invalid_request', message); }
function invalidOutput(): never { throw new AuthorityOperationError('invalid_output', 'Live evidence output is invalid'); }
function closedRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Object.getOwnPropertySymbols(value).length !== 0) invalidOutput();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (required.some(key => !Object.hasOwn(descriptors, key)) ||
      Object.entries(descriptors).some(([key, descriptor]) => !('value' in descriptor) || !descriptor.enumerable || (!required.includes(key) && !optional.includes(key)))) invalidOutput();
}
function boundedString(value: unknown, bytes: number, multiline = false): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.normalize('NFC') ||
      Buffer.byteLength(value, 'utf8') > bytes ||
      (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\p{Cc}\p{Zl}\p{Zp}]/u).test(value)) invalidOutput();
}
function day(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) invalidOutput();
}
function limit(value: number | undefined): number {
  const result = value ?? 10;
  if (!Number.isInteger(result) || result < 1 || result > PERSON_LIVE_EVIDENCE_MAX_ITEMS_V1) invalid('Live evidence limit must be between 1 and 50');
  return result;
}

/** Never propagate provider exception messages, causes, URLs or raw response bodies. */
async function safeCall<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  try {
    const value = await operation();
    signal?.throwIfAborted();
    return value;
  } catch (error) {
    signal?.throwIfAborted();
    const code = error instanceof AuthorityOperationError && ERROR_CODES.has(error.code) ? error.code : 'unavailable';
    throw new AuthorityOperationError(code, 'Live evidence operation could not be completed');
  }
}

/**
 * Request-local release boundary. It checks both sides of each asynchronous
 * read, commits a digest-only audit before release, and owns all open/cursor
 * handles. Provider-specific transport and permission checks stay in the reader.
 */
export function createAuditedPersonLiveEvidenceSourceV1<C extends PersonLiveEvidenceCitationV1>(options: CreatePersonLiveEvidenceSourceV1Options<C>): PersonLiveEvidenceSourceV1<C> {
  const { reader, authorization, audit } = options;
  const access = validatePersonConnectorAccessV1(options.access);
  if (access.identity_status !== 'linked' || access.read_status !== 'connected' || !access.read_capabilities.includes('live_evidence')) {
    throw new AuthorityOperationError('unauthorized', 'A personal live evidence grant is required');
  }
  boundedString(options.actor.principal_id, 256);
  if (typeof options.read_grant_sha256 !== 'string' || !DIGEST.test(options.read_grant_sha256)) invalid('Live evidence grant commitment is invalid');
  const binding: PersonConnectorReadBindingV1 = Object.freeze({
    organization_id: options.actor.organization_id, principal_id: options.actor.principal_id, membership_id: options.actor.membership_id,
    tool_id: access.tool_id, external_scope_id: access.external_scope_id, external_subject_id: access.external_subject_id!, read_grant_sha256: options.read_grant_sha256,
  });
  const bindingDigest = canonicalSha256(binding);
  if (canonicalSha256(reader.binding) !== bindingDigest) throw new AuthorityOperationError('unauthorized', 'Live evidence reader belongs to a different binding');
  const stored = new Map<string, { readonly handle: string; readonly citation: C }>();
  const released = new Map<string, C>();
  /** Citation keys a successful check of this source has covered; request-local, like `released`. */
  const checked = new Set<string>();
  const cursors = new Map<string, { readonly provider: string; readonly selection: string }>();
  // Audit is asynchronous. Reserve request-owned identifiers before it starts
  // so concurrent releases cannot each admit themselves against the same stale
  // capacity snapshot.
  const reservedStored = new Map<string, number>();
  const reservedReleased = new Map<string, number>();
  let reservedCursors = 0;
  let cursorSequence = 0;
  const requestId = randomBytes(16).toString('hex');
  const current = (signal?: AbortSignal): void => {
    signal?.throwIfAborted();
    try {
      if (canonicalSha256(reader.binding) !== bindingDigest) throw new AuthorityOperationError('stale_access_state', 'Live evidence reader binding changed');
      const result: unknown = authorization.assertCurrent(binding);
      // TypeScript permits async functions where void is expected. Refuse
      // them so the same local check can also fence final publication.
      if (result !== undefined) {
        if (result instanceof Promise) void result.catch(() => undefined);
        throw new AuthorityOperationError('unavailable', 'Live evidence grant fence must be synchronous');
      }
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      const code = error instanceof AuthorityOperationError && ERROR_CODES.has(error.code) ? error.code : 'unavailable';
      throw new AuthorityOperationError(code, 'Live evidence operation could not be completed');
    }
  };

  const prepare = (value: PersonLiveEvidenceValueV1<C>): PersonLiveEvidenceValueV1<C> & { readonly coordinates: PersonLiveEvidenceCoordinatesV1 } => {
    // Copy and validate the whole page before the first await/audit so adapters
    // cannot change the text or metadata while its release is being committed.
    try {
      closedRecord(value, ['citation', 'handle', 'label', 'visibility'], ['text', 'attributes', 'occurred_at', 'date_kind', 'dates']);
      const validated = reader.validateCitation(value.citation);
      const citation: PersonLiveEvidenceCitationV1 = validated.citation;
      closedRecord(validated.coordinates, ['object_id'], ['container_id']);
      boundedString(validated.coordinates.object_id, 512);
      if (validated.coordinates.container_id !== undefined) boundedString(validated.coordinates.container_id, 512);
      const coordinates = Object.freeze({ object_id: validated.coordinates.object_id, ...(validated.coordinates.container_id === undefined ? {} : { container_id: validated.coordinates.container_id }) });
      if (validated.tool_id !== binding.tool_id || validated.external_scope_id !== binding.external_scope_id) invalidOutput();
      boundedString(value.handle, 512);
      boundedString(value.label, PERSON_EVIDENCE_LABEL_MAX_BYTES_V1);
      if (value.visibility !== 'only_me' && value.visibility !== 'team') invalidOutput();
      if (value.text !== undefined) boundedString(value.text, PERSON_EVIDENCE_TEXT_MAX_BYTES_V1, true);
      // Every citation commits to exactly the text released (none for an inventory item), except a tool container's,
      // which commits to no text (research tool contract v1); the audit below still commits the container's text.
      if (citation.kind !== 'tool_container' && citation.text_sha256 !== `sha256:${createHash('sha256').update(value.text ?? '', 'utf8').digest('hex')}`) invalidOutput();
      if (value.occurred_at !== undefined) day(value.occurred_at);
      if (value.date_kind !== undefined && (value.occurred_at === undefined || !['created', 'version_created', 'occurred', 'updated', 'due', 'received'].includes(value.date_kind))) invalidOutput();
      let dates: EvidenceDatesV1 | undefined;
      if (value.dates !== undefined) {
        closedRecord(value.dates, [], ['occurred', 'created', 'updated', 'due', 'received']);
        const copied: Partial<Record<EvidenceDateFieldV1, string>> = {};
        for (const [field, stamp] of Object.entries(value.dates)) {
          if (typeof stamp !== 'string') invalidOutput();
          if (stamp.length === 10) calendarDateV1(stamp);
          else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stamp) || !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp) invalidOutput();
          copied[field as EvidenceDateFieldV1] = stamp;
        }
        dates = Object.freeze(copied);
      }
      let attributes: PersonLiveEvidenceValueV1['attributes'];
      if (value.attributes !== undefined) {
        closedRecord(value.attributes, [], ATTRIBUTES);
        const keys = Object.keys(value.attributes);
        if (keys.length === 0 || keys.some(key => !(ATTRIBUTES as readonly string[]).includes(key))) invalidOutput();
        const copied: { -readonly [K in keyof PersonLiveEvidenceAttributesV1]?: string } = {};
        for (const field of ATTRIBUTES) {
          if (Object.hasOwn(value.attributes, field)) {
            boundedString(value.attributes[field], ATTRIBUTE_BYTES[field]);
            copied[field] = value.attributes[field];
          }
        }
        attributes = Object.freeze(copied);
      }
      return Object.freeze({ citation: citation as C, coordinates, handle: value.handle, label: value.label, visibility: value.visibility,
        ...(value.text === undefined ? {} : { text: value.text }), ...(attributes === undefined ? {} : { attributes }),
        ...(value.occurred_at === undefined ? {} : { occurred_at: value.occurred_at }), ...(value.date_kind === undefined ? {} : { date_kind: value.date_kind }), ...(dates === undefined ? {} : { dates }) });
    } catch { invalidOutput(); }
  };

  const release = async (operation: PersonLiveEvidenceReleaseV1['operation'], page: PersonLiveEvidencePageV1<C>, maximum: number, selection?: string, signal?: AbortSignal): Promise<PersonLiveEvidenceResultV1<C>> => {
    closedRecord(page, ['items', 'truncated'], ['next_cursor', 'notice', 'page_full', 'anchor_truncated']);
    if (!Array.isArray(page.items) || page.items.length > maximum || typeof page.truncated !== 'boolean') invalidOutput();
    if (Object.getOwnPropertySymbols(page.items).length !== 0 || Object.getOwnPropertyNames(page.items).length !== page.items.length + 1) invalidOutput();
    for (let index = 0; index < page.items.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(page.items, String(index));
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalidOutput();
    }
    if (page.next_cursor !== undefined && (operation !== 'list' || typeof page.next_cursor !== 'string' || page.next_cursor.length === 0 || page.next_cursor.length > 4096)) invalidOutput();
    if (page.page_full !== undefined && (operation !== 'list' || typeof page.page_full !== 'boolean')) invalidOutput();
    // An open's own cut is part of what it left out: a reader never reports one without `truncated`.
    if (page.anchor_truncated !== undefined && (operation !== 'open' || typeof page.anchor_truncated !== 'boolean' || (page.anchor_truncated && !page.truncated))) invalidOutput();
    if (page.notice !== undefined) {
      boundedString(page.notice, 1024);
      if (page.notice.trim() !== page.notice) invalidOutput();
    }
    const prepared = page.items.map(prepare);
    const ids = prepared.map(value => `live_${canonicalSha256({ request_id: requestId, binding, kind: value.citation.kind, coordinates: value.coordinates }).slice(7)}`);
    if (new Set(ids).size !== ids.length) invalidOutput();
    const citationKeys = prepared.map(value => canonicalSha256(value.citation));
    const reserve = () => {
      if (new Set([...released.keys(), ...reservedReleased.keys(), ...citationKeys]).size > 512 ||
          new Set([...stored.keys(), ...reservedStored.keys(), ...ids]).size > 512 ||
          cursors.size + reservedCursors >= 512) invalidOutput();
      const heldStored = ids.filter(id => !stored.has(id));
      const heldReleased = citationKeys.filter(key => !released.has(key));
      for (const id of heldStored) reservedStored.set(id, (reservedStored.get(id) ?? 0) + 1);
      for (const key of heldReleased) reservedReleased.set(key, (reservedReleased.get(key) ?? 0) + 1);
      if (nextCursor !== undefined) reservedCursors += 1;
      return () => {
        for (const id of heldStored) {
          const remaining = reservedStored.get(id)! - 1;
          if (remaining === 0) reservedStored.delete(id); else reservedStored.set(id, remaining);
        }
        for (const key of heldReleased) {
          const remaining = reservedReleased.get(key)! - 1;
          if (remaining === 0) reservedReleased.delete(key); else reservedReleased.set(key, remaining);
        }
        if (nextCursor !== undefined) reservedCursors -= 1;
      };
    };
    const nextProviderCursor = page.next_cursor;
    const truncated = page.truncated || nextProviderCursor !== undefined;
    const nextCursor = nextProviderCursor === undefined ? undefined : `live_cursor_${requestId}_${++cursorSequence}`;
    const withReceipt = (receipt: `sha256:${string}`): PersonLiveEvidenceResultV1<C> => Object.freeze({
      items: Object.freeze(prepared.map((value, index) => Object.freeze({
        id: ids[index]!, kind: value.citation.kind as C['kind'], citation: value.citation, label: value.label, visibility: value.visibility,
        ...(value.text === undefined ? {} : { text: value.text }), ...(value.attributes === undefined ? {} : { attributes: value.attributes }),
        ...(value.occurred_at === undefined ? {} : { occurred_at: value.occurred_at }), ...(value.date_kind === undefined ? {} : { date_kind: value.date_kind }), ...(value.dates === undefined ? {} : { dates: value.dates }), receipt_sha256: receipt,
      }))),
      truncated, receipt_digests: Object.freeze([receipt]), ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
      ...(page.notice === undefined ? {} : { notice: page.notice }), ...(page.page_full === undefined ? {} : { page_full: page.page_full }),
      ...(page.anchor_truncated === undefined ? {} : { anchor_truncated: page.anchor_truncated }),
    });
    if (canonicalJsonBytes(withReceipt(`sha256:${'0'.repeat(64)}`)).byteLength > PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1) invalidOutput();
    current(signal);
    const releaseReservation = reserve();
    try {
      const receipt = await safeCall(() => audit.record(Object.freeze({ schema_version: 1, binding, operation, coordinates: Object.freeze(prepared.map(value => value.coordinates)), value_digests: Object.freeze(prepared.map(({ handle: _handle, coordinates: _coordinates, ...value }) => canonicalSha256(value))), citations: Object.freeze(prepared.map(value => value.citation)) })), signal);
      if (typeof receipt !== 'string' || !DIGEST.test(receipt)) throw new AuthorityOperationError('unavailable', 'Live evidence release receipt is invalid');
      current(signal);
      const result = withReceipt(receipt);
      // All audited citations remain tracked, including overwritten inventory
      // items and pages later omitted by a composing desk's result limit.
      for (let i = 0; i < prepared.length; i += 1) {
        stored.set(ids[i]!, { handle: prepared[i]!.handle, citation: prepared[i]!.citation });
        released.set(citationKeys[i]!, prepared[i]!.citation);
      }
      if (nextCursor !== undefined) cursors.set(nextCursor, { provider: nextProviderCursor!, selection: selection! });
      return result;
    } finally {
      releaseReservation();
    }
  };

  return Object.freeze({
    tool_id: binding.tool_id,
    async search(input) {
      const maximum = limit(input.limit);
      if (typeof input.query !== 'string' || input.query.trim().length === 0 || Buffer.byteLength(input.query, 'utf8') > 1024 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(input.query)) invalid('Live evidence query is invalid');
      current(input.signal);
      validateEvidenceDateFilterV1(input, DATE_SELECTIONS);
      const page = await safeCall(() => reader.search({ ...evidenceDateFilterV1(input), query: input.query, limit: maximum, ...(input.signal === undefined ? {} : { signal: input.signal }) }), input.signal);
      return release('search', page, maximum, undefined, input.signal);
    },
    async open(input) {
      const maximum = limit(input.limit);
      const value = stored.get(input.item);
      if (value === undefined) throw new AuthorityOperationError('not_found', 'Live evidence item is not available in this request');
      current(input.signal);
      const page = await safeCall(() => reader.open({ handle: value.handle, limit: maximum, ...(input.signal === undefined ? {} : { signal: input.signal }) }), input.signal);
      return release('open', page, maximum, undefined, input.signal);
    },
    async openCitation(input) {
      const maximum = limit(input.limit);
      if (reader.openCitation === undefined) throw new AuthorityOperationError('unavailable', 'Live evidence cannot open an earlier citation');
      if (typeof input.citation !== 'object' || input.citation === null || Array.isArray(input.citation)) invalid('Live evidence citation is invalid');
      current(input.signal);
      // The reader validates the citation and applies its own tenant and pin checks;
      // every released item still passes validateCitation and the audit below.
      const page = await safeCall(() => reader.openCitation!({ citation: input.citation, limit: maximum, ...(input.signal === undefined ? {} : { signal: input.signal }) }), input.signal);
      return release('open', page, maximum, undefined, input.signal);
    },
    async list(input) {
      const maximum = limit(input.limit);
      if (input.container !== undefined && (typeof input.container !== 'string' || input.container.trim().length === 0 || Buffer.byteLength(input.container, 'utf8') > 256 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(input.container))) invalid('Live evidence container is invalid');
      try { if (input.since !== undefined) day(input.since); if (input.until !== undefined) day(input.until); }
      catch { invalid('Live evidence dates must be real YYYY-MM-DD dates'); }
      if (input.since !== undefined && input.until !== undefined && input.since > input.until) invalid('Live evidence date range is reversed');
      validateEvidenceDateFilterV1(input, DATE_SELECTIONS);
      const selection = canonicalSha256({ container: input.container ?? null, since: input.since ?? null, until: input.until ?? null, date_field: input.date_field ?? null, time_zone: input.time_zone ?? null });
      const cursor = input.cursor === undefined ? undefined : cursors.get(input.cursor);
      if (input.cursor !== undefined && (cursor === undefined || cursor.selection !== selection)) invalid('Live evidence cursor is not available for this list');
      const request: PersonLiveEvidenceListInputV1 = { ...evidenceDateFilterV1(input), limit: maximum, ...(input.container === undefined ? {} : { container: input.container }), ...(input.since === undefined ? {} : { since: input.since }), ...(input.until === undefined ? {} : { until: input.until }), ...(cursor === undefined ? {} : { cursor: cursor.provider }), ...(input.signal === undefined ? {} : { signal: input.signal }) };
      current(input.signal);
      const page = await safeCall(() => reader.list(request), input.signal);
      return release('list', page, maximum, selection, input.signal);
    },
    async revalidate(input) {
      current(input.signal);
      // An incremental check (ADR-0038) re-reads only citations released since
      // this request's last successful check. Releases that land while the
      // check runs are not in this snapshot and stay pending for the next one.
      const incremental = input.mode === 'incremental';
      const pending = [...released].filter(([key]) => !incremental || !checked.has(key));
      const citations = Object.freeze(pending.map(([, citation]) => citation));
      await safeCall(() => reader.revalidate({ citations, ...(incremental ? { mode: 'incremental' as const } : {}), ...(input.signal === undefined ? {} : { signal: input.signal }) }), input.signal);
      current(input.signal);
      for (const [key] of pending) checked.add(key);
    },
    assertCurrent: current,
  } satisfies PersonLiveEvidenceSourceV1<C>);
}
