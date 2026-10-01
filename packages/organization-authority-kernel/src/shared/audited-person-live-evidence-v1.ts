import { createHash, randomBytes } from 'node:crypto';
import { canonicalJsonBytes, canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_EVIDENCE_LABEL_MAX_BYTES_V1, PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1, PERSON_EVIDENCE_TEXT_MAX_BYTES_V1,
  validateOrganizationPersonConnectorAccessV1, validatePersonSlackMessageCitationV1, validatePersonTicketCitationV1,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '../domain/errors.js';
import type {
  CreatePersonLiveEvidenceSourceV1Options, PersonConnectorReadBindingV1, PersonLiveEvidenceCitationV1,
  PersonLiveEvidenceListInputV1, PersonLiveEvidencePageV1, PersonLiveEvidenceReleaseV1,
  PersonLiveEvidenceResultV1, PersonLiveEvidenceSourceV1, PersonLiveEvidenceValueV1,
} from './person-live-evidence-v1.js';

export const PERSON_LIVE_EVIDENCE_MAX_ITEMS_V1 = 50;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ERROR_CODES = new Set(['conflict', 'invalid_request', 'invalid_output', 'not_found', 'stale_access_state', 'unauthorized', 'rate_limited', 'quota_exceeded', 'unavailable']);

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
  const access = validateOrganizationPersonConnectorAccessV1({ schema_version: 1, kind: 'echo-organization-person-connector-access', organization_id: options.actor.organization_id, membership_id: options.actor.membership_id, connectors: [options.access] }).connectors[0]!;
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
  const cursors = new Map<string, { readonly provider: string; readonly selection: string }>();
  let cursorSequence = 0;
  const requestId = randomBytes(16).toString('hex');
  const current = (signal?: AbortSignal) => safeCall(async () => {
    if (canonicalSha256(reader.binding) !== bindingDigest) throw new AuthorityOperationError('stale_access_state', 'Live evidence reader binding changed');
    await authorization.requireCurrent(binding, { ...(signal === undefined ? {} : { signal }) });
  }, signal);

  const prepare = (value: PersonLiveEvidenceValueV1<C>): PersonLiveEvidenceValueV1<C> => {
    // Copy and validate the whole page before the first await/audit so adapters
    // cannot change the text or metadata while its release is being committed.
    try {
      closedRecord(value, ['citation', 'handle', 'label', 'visibility'], ['text', 'attributes', 'occurred_at']);
      const citation = value.citation.kind === 'slack_message' ? validatePersonSlackMessageCitationV1(value.citation) : validatePersonTicketCitationV1(value.citation);
      if (citation.kind === 'slack_message') {
        if (binding.tool_id !== 'slack' || citation.team_id !== binding.external_scope_id) invalidOutput();
      } else if (citation.tool_id !== binding.tool_id || citation.external_scope_id !== binding.external_scope_id) invalidOutput();
      boundedString(value.handle, 512);
      boundedString(value.label, PERSON_EVIDENCE_LABEL_MAX_BYTES_V1);
      if (value.visibility !== 'only_me' && value.visibility !== 'team') invalidOutput();
      if (value.text !== undefined) {
        boundedString(value.text, PERSON_EVIDENCE_TEXT_MAX_BYTES_V1, true);
        const digest = `sha256:${createHash('sha256').update(value.text, 'utf8').digest('hex')}`;
        if (digest !== citation.text_sha256) invalidOutput();
      }
      if (value.occurred_at !== undefined) day(value.occurred_at);
      let attributes: PersonLiveEvidenceValueV1['attributes'];
      if (value.attributes !== undefined) {
        closedRecord(value.attributes, [], ['owner', 'due_at', 'status']);
        const keys = Object.keys(value.attributes);
        if (keys.length === 0 || keys.some(key => !['owner', 'due_at', 'status'].includes(key))) invalidOutput();
        const copied: { owner?: string; due_at?: string; status?: string } = {};
        for (const field of ['owner', 'due_at', 'status'] as const) {
          if (Object.hasOwn(value.attributes, field)) {
            boundedString(value.attributes[field], field === 'owner' ? 512 : 128);
            copied[field] = value.attributes[field];
          }
        }
        attributes = Object.freeze(copied);
      }
      return Object.freeze({ citation: citation as C, handle: value.handle, label: value.label, visibility: value.visibility,
        ...(value.text === undefined ? {} : { text: value.text }), ...(attributes === undefined ? {} : { attributes }),
        ...(value.occurred_at === undefined ? {} : { occurred_at: value.occurred_at }) });
    } catch { invalidOutput(); }
  };

  const release = async (operation: PersonLiveEvidenceReleaseV1['operation'], page: PersonLiveEvidencePageV1<C>, maximum: number, selection?: string, signal?: AbortSignal): Promise<PersonLiveEvidenceResultV1<C>> => {
    closedRecord(page, ['items', 'truncated'], ['next_cursor']);
    if (!Array.isArray(page.items) || page.items.length > maximum || typeof page.truncated !== 'boolean') invalidOutput();
    if (Object.getOwnPropertySymbols(page.items).length !== 0 || Object.getOwnPropertyNames(page.items).length !== page.items.length + 1) invalidOutput();
    for (let index = 0; index < page.items.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(page.items, String(index));
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalidOutput();
    }
    if (page.next_cursor !== undefined && (operation !== 'list' || typeof page.next_cursor !== 'string' || page.next_cursor.length === 0 || page.next_cursor.length > 4096)) invalidOutput();
    const prepared = page.items.map(prepare);
    const ids = prepared.map(value => `live_${canonicalSha256({ request_id: requestId, binding, citation: value.citation }).slice(7)}`);
    if (new Set(ids).size !== ids.length) invalidOutput();
    const nextProviderCursor = page.next_cursor;
    const truncated = page.truncated || nextProviderCursor !== undefined;
    const nextCursor = nextProviderCursor === undefined ? undefined : `live_cursor_${requestId}_${++cursorSequence}`;
    const withReceipt = (receipt: `sha256:${string}`): PersonLiveEvidenceResultV1<C> => Object.freeze({
      items: Object.freeze(prepared.map((value, index) => Object.freeze({
        id: ids[index]!, kind: value.citation.kind as C['kind'], citation: value.citation, label: value.label, visibility: value.visibility,
        ...(value.text === undefined ? {} : { text: value.text }), ...(value.attributes === undefined ? {} : { attributes: value.attributes }),
        ...(value.occurred_at === undefined ? {} : { occurred_at: value.occurred_at }), receipt_sha256: receipt,
      }))),
      truncated, receipt_digests: Object.freeze([receipt]), ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
    });
    if (canonicalJsonBytes(withReceipt(`sha256:${'0'.repeat(64)}`)).byteLength > PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1) invalidOutput();
    await current(signal);
    const receipt = await safeCall(() => audit.record(Object.freeze({ schema_version: 1, binding, operation, citations: Object.freeze(prepared.map(value => value.citation)) })), signal);
    if (typeof receipt !== 'string' || !DIGEST.test(receipt)) throw new AuthorityOperationError('unavailable', 'Live evidence release receipt is invalid');
    await current(signal);
    const result = withReceipt(receipt);
    // All audited citations remain tracked, including overwritten inventory
    // items and pages later omitted by a composing desk's result limit.
    for (let i = 0; i < prepared.length; i += 1) stored.set(ids[i]!, { handle: prepared[i]!.handle, citation: prepared[i]!.citation });
    if (nextCursor !== undefined) cursors.set(nextCursor, { provider: nextProviderCursor!, selection: selection! });
    return result;
  };

  return Object.freeze({
    tool_id: binding.tool_id,
    async search(input) {
      const maximum = limit(input.limit);
      if (typeof input.query !== 'string' || input.query.trim().length === 0 || Buffer.byteLength(input.query, 'utf8') > 1024 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(input.query)) invalid('Live evidence query is invalid');
      await current(input.signal);
      const page = await safeCall(() => reader.search({ query: input.query, limit: maximum, ...(input.signal === undefined ? {} : { signal: input.signal }) }), input.signal);
      return release('search', page, maximum, undefined, input.signal);
    },
    async open(input) {
      const maximum = limit(input.limit);
      const value = stored.get(input.item);
      if (value === undefined) throw new AuthorityOperationError('not_found', 'Live evidence item is not available in this request');
      await current(input.signal);
      const page = await safeCall(() => reader.open({ handle: value.handle, limit: maximum, ...(input.signal === undefined ? {} : { signal: input.signal }) }), input.signal);
      return release('open', page, maximum, undefined, input.signal);
    },
    async list(input) {
      const maximum = limit(input.limit);
      if (input.container !== undefined && (typeof input.container !== 'string' || input.container.trim().length === 0 || Buffer.byteLength(input.container, 'utf8') > 256 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(input.container))) invalid('Live evidence container is invalid');
      try { if (input.since !== undefined) day(input.since); if (input.until !== undefined) day(input.until); }
      catch { invalid('Live evidence dates must be real YYYY-MM-DD dates'); }
      if (input.since !== undefined && input.until !== undefined && input.since > input.until) invalid('Live evidence date range is reversed');
      const selection = canonicalSha256({ container: input.container ?? null, since: input.since ?? null, until: input.until ?? null });
      const cursor = input.cursor === undefined ? undefined : cursors.get(input.cursor);
      if (input.cursor !== undefined && (cursor === undefined || cursor.selection !== selection)) invalid('Live evidence cursor is not available for this list');
      const request: PersonLiveEvidenceListInputV1 = { limit: maximum, ...(input.container === undefined ? {} : { container: input.container }), ...(input.since === undefined ? {} : { since: input.since }), ...(input.until === undefined ? {} : { until: input.until }), ...(cursor === undefined ? {} : { cursor: cursor.provider }), ...(input.signal === undefined ? {} : { signal: input.signal }) };
      await current(input.signal);
      const page = await safeCall(() => reader.list(request), input.signal);
      return release('list', page, maximum, selection, input.signal);
    },
    async revalidate(input) {
      await current(input.signal);
      const citations = Object.freeze([...stored.values()].map(value => value.citation));
      await safeCall(() => reader.revalidate({ citations, ...(input.signal === undefined ? {} : { signal: input.signal }) }), input.signal);
      await current(input.signal);
    },
  } satisfies PersonLiveEvidenceSourceV1<C>);
}
