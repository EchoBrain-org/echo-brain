import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { PersonProviderV1 } from './person-provider-v1.js';

export interface PersonProviderAuthenticatedFetchV1 {
  readonly binding: PersonConnectorReadBindingV1;
  fetch(url: string, init: RequestInit): Promise<Response>;
}
export const PERSON_PROVIDER_RESPONSE_MAX_BYTES_V1 = 1024 * 1024;
const SAFE_ERRORS = new Set(['invalid_request', 'invalid_output', 'unauthorized', 'not_found', 'stale_access_state', 'unavailable', 'rate_limited']);

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
    try { void response.body.cancel().catch(() => {}); } catch { /* disposal cannot extend the deadline */ }
  }
}

/** The product owns endpoint/selector validation; this owns the bounded authenticated JSON exchange. */
export function createPersonProviderJsonTransportV1<Input extends { readonly signal?: AbortSignal }>(
  provider: Pick<PersonProviderV1, 'copyBinding' | 'failure'>,
  authenticated: PersonProviderAuthenticatedFetchV1,
  request: (input: Input, binding: PersonConnectorReadBindingV1) => Readonly<{ url: URL; method?: 'GET' | 'POST'; body?: Readonly<Record<string, unknown>> }>,
) {
  const binding = provider.copyBinding(authenticated.binding);
  const digest = canonicalSha256(binding);
  const failure: PersonProviderV1['failure'] = provider.failure;
  const fetchAuthenticated = authenticated.fetch.bind(authenticated);
  const current = () => {
    if (canonicalSha256(provider.copyBinding(authenticated.binding)) !== digest) failure('stale_access_state');
  };
  return Object.freeze({
    binding,
    async request(input: Input): Promise<unknown> {
      const selected = request(input, binding);
      input.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(15_000);
      const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
      let response: Response | undefined;
      try {
        current();
        response = await abortable(() => fetchAuthenticated(selected.url.href, {
          method: selected.method ?? 'GET', redirect: 'error', signal,
          headers: { Accept: 'application/json', ...(selected.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(selected.body === undefined ? {} : { body: JSON.stringify(selected.body) }),
        }), signal, dispose);
        signal.throwIfAborted();
        if (response.redirected || response.url !== '' && response.url !== selected.url.href) failure('invalid_output');
        if (response.status !== 200) {
          if (response.status === 401 || response.status === 403) failure('unauthorized');
          if (response.status === 404) failure('not_found');
          if (response.status === 429) failure('rate_limited');
          failure('unavailable');
        }
        if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) failure('invalid_output');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > PERSON_PROVIDER_RESPONSE_MAX_BYTES_V1)) failure('invalid_output');
        if (response.body === null) failure('invalid_output');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const chunk = await abortable(() => reader.read(), signal);
            signal.throwIfAborted();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > PERSON_PROVIDER_RESPONSE_MAX_BYTES_V1) failure('invalid_output');
            chunks.push(chunk.value);
          }
          let result: unknown;
          try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { failure('invalid_output'); }
          signal.throwIfAborted();
          current();
          return result;
        } finally {
          try { void reader.cancel().catch(() => {}); } catch { /* disposal cannot expose provider errors */ }
          reader.releaseLock();
        }
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof AuthorityOperationError && SAFE_ERRORS.has(error.code)) failure(error.code as Parameters<typeof failure>[0]);
        failure('unavailable');
      } finally { dispose(response); }
    },
  });
}
