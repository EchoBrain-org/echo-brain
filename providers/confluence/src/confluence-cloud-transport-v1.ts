import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { bindingEqual, CONFLUENCE_CLOUD_ID, confluenceFailure, copyConfluenceBindingV1 } from './confluence-validation-v1.js';

export interface ConfluenceCloudRequestV1 {
  readonly path: string;
  readonly query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly signal?: AbortSignal;
}

/** Authorization is owned by the connection and revalidated for each request. */
export interface ConfluenceCloudAuthenticatedFetchV1 {
  readonly binding: PersonConnectorReadBindingV1;
  fetch(url: string, init: RequestInit): Promise<Response>;
}
export interface ConfluenceCloudTransportV1 {
  readonly binding: PersonConnectorReadBindingV1;
  request(input: ConfluenceCloudRequestV1): Promise<unknown>;
}

export const CONFLUENCE_RESPONSE_MAX_BYTES_V1 = 1024 * 1024;
const DEADLINE_MS = 15_000;
const NUMERIC_ID = '[1-9][0-9]{0,19}';
const PAGE = new RegExp(`^/api/v2/pages/${NUMERIC_ID}$`);
const SPACE = new RegExp(`^/api/v2/spaces/${NUMERIC_ID}$`);
const SPACE_PAGES = new RegExp(`^/api/v2/spaces/${NUMERIC_ID}/pages$`);
const PAGE_LIST_STATUSES = new Set(['current', 'archived', 'deleted', 'trashed']);
const PAGE_STATUSES = new Set([...PAGE_LIST_STATUSES, 'historical', 'draft']);
const SPACE_ID = new RegExp(`^${NUMERIC_ID}$`);
const SAFE_ERRORS = new Set(['invalid_request', 'invalid_output', 'unauthorized', 'not_found', 'stale_access_state', 'unavailable', 'rate_limited']);

function stringQuery(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

/** Endpoint and selector ownership stays inside the adapter, never a provider-supplied URL. */
function requestUrl(cloud: string, input: ConfluenceCloudRequestV1): URL {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['path', 'query', 'signal'].includes(key))) confluenceFailure('invalid_request');
  const path = input.path;
  if (typeof path !== 'string') confluenceFailure('invalid_request');
  const resources = path === '/oauth/token/accessible-resources';
  const page = PAGE.test(path);
  const pageList = path === '/api/v2/pages' || SPACE_PAGES.test(path);
  const spaces = path === '/api/v2/spaces';
  const search = path === '/rest/api/search';
  if (!(resources || path === '/rest/api/user/current' || page || pageList || spaces || SPACE.test(path) || search)) {
    confluenceFailure('invalid_request');
  }
  const url = new URL(resources ? `https://api.atlassian.com${path}` : `https://api.atlassian.com/ex/confluence/${cloud}/wiki${path}`);
  if (input.query !== undefined && (input.query === null || typeof input.query !== 'object' || Array.isArray(input.query))) confluenceFailure('invalid_request');
  for (const [key, value] of Object.entries(input.query ?? {})) {
    // Unknown selectors are refused even if their value is undefined.
    const allowed = key === 'limit' && (pageList || spaces || search) ||
      key === 'cursor' && (pageList || spaces || search) ||
      key === 'status' && (pageList || page) || key === 'body-format' && page ||
      key === 'space-id' && path === '/api/v2/pages' ||
      (key === 'cql' || key === 'expand' || key === 'includeArchivedSpaces') && search;
    if (!allowed) confluenceFailure('invalid_request');
    if (value === undefined) continue;
    if (key === 'space-id') {
      const values = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(values) || values.length < 1 || values.length > 100 || new Set(values).size !== values.length ||
          values.some(id => typeof id !== 'string' || !SPACE_ID.test(id))) confluenceFailure('invalid_request');
      // This endpoint documents the IDs as a comma-separated list.
      url.searchParams.set(key, values.join(','));
      continue;
    }
    if (key === 'status') {
      const statuses = page ? PAGE_STATUSES : PAGE_LIST_STATUSES;
      const values = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(values) || values.length < 1 || values.length > statuses.size ||
          new Set(values).size !== values.length || values.some(status => typeof status !== 'string' || !statuses.has(status))) confluenceFailure('invalid_request');
      for (const status of values) url.searchParams.append(key, status);
      continue;
    }
    if (!stringQuery(value, key === 'cql' || key === 'cursor' ? 4096 : 128)) confluenceFailure('invalid_request');
    if (key === 'limit' && (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 250) ||
        key === 'body-format' && value !== 'storage' || key === 'expand' && value !== 'content' ||
        key === 'includeArchivedSpaces' && value !== 'true' && value !== 'false') confluenceFailure('invalid_request');
    url.searchParams.set(key, value);
  }
  return url;
}

/** Bound even a broken fetch/stream implementation that ignores its AbortSignal. */
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const done = () => signal.removeEventListener('abort', abort);
    try {
      operation().then(value => {
        done();
        if (signal.aborted) { discard?.(value); reject(signal.reason); }
        else resolve(value);
      }, error => { done(); reject(error); });
    } catch (error) { done(); reject(error); }
  });
}

function dispose(response: Response | undefined): void {
  if (response?.body !== undefined && response.body !== null && !response.body.locked) {
    // Cancellation itself must not extend the deadline or expose provider errors.
    try { void response.body.cancel().catch(() => {}); } catch { /* best-effort disposal */ }
  }
}

/** Direct, GET-only Atlassian API transport; no retries, redirects, token output, or retained bodies. */
export function createConfluenceCloudTransportV1(authenticated: ConfluenceCloudAuthenticatedFetchV1): ConfluenceCloudTransportV1 {
  const binding = copyConfluenceBindingV1(authenticated.binding);
  const cloud = binding.external_scope_id;
  if (typeof cloud !== 'string' || !CONFLUENCE_CLOUD_ID.test(cloud)) confluenceFailure('unauthorized');
  const fetchAuthenticated = authenticated.fetch.bind(authenticated);
  const current = () => {
    if (!bindingEqual(copyConfluenceBindingV1(authenticated.binding), binding)) confluenceFailure('stale_access_state');
  };
  return Object.freeze({
    binding,
    async request(input: ConfluenceCloudRequestV1): Promise<unknown> {
      const url = requestUrl(cloud, input);
      input.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(DEADLINE_MS);
      const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
      let response: Response | undefined;
      try {
        current();
        response = await abortable(() => fetchAuthenticated(url.href, {
          method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/json' },
        }), signal, dispose);
        signal.throwIfAborted();
        if (response.redirected || response.url !== '' && response.url !== url.href) confluenceFailure('invalid_output');
        if (response.status !== 200) {
          if (response.status === 401 || response.status === 403) confluenceFailure('unauthorized');
          if (response.status === 404) confluenceFailure('not_found');
          if (response.status === 429) confluenceFailure('rate_limited');
          confluenceFailure('unavailable');
        }
        if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) confluenceFailure('invalid_output');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > CONFLUENCE_RESPONSE_MAX_BYTES_V1)) confluenceFailure('invalid_output');
        if (response.body === null) confluenceFailure('invalid_output');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const chunk = await abortable(() => reader.read(), signal);
            signal.throwIfAborted();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > CONFLUENCE_RESPONSE_MAX_BYTES_V1) confluenceFailure('invalid_output');
            chunks.push(chunk.value);
          }
          let result: unknown;
          try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { confluenceFailure('invalid_output'); }
          signal.throwIfAborted();
          current();
          return result;
        } finally {
          try { void reader.cancel().catch(() => {}); } catch { /* disposal cannot expose provider errors */ }
          reader.releaseLock();
        }
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof AuthorityOperationError && SAFE_ERRORS.has(error.code)) confluenceFailure(error.code as Parameters<typeof confluenceFailure>[0]);
        confluenceFailure('unavailable');
      } finally { dispose(response); }
    },
  });
}
