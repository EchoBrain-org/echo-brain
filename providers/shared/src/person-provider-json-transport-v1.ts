import { abortableProviderOperationV1, BoundedJsonResponseErrorV1, disposeProviderResponseV1, readBoundedJsonResponseV1 } from './bounded-json-response-v1.js';
import { observeProviderHttpRequestV1, providerUpstreamServiceV1 } from './provider-http-diagnostics-v1.js';
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

/** The product owns endpoint/selector validation; this owns the bounded authenticated JSON exchange. */
export function createPersonProviderJsonTransportV1<Input extends { readonly signal?: AbortSignal }>(
  provider: Pick<PersonProviderV1, 'copyBinding' | 'failure'>,
  authenticated: PersonProviderAuthenticatedFetchV1,
  request: (input: Input, binding: PersonConnectorReadBindingV1) => Readonly<{ url: URL; method?: 'GET' | 'POST'; body?: Readonly<Record<string, unknown>> }>,
  responseFormat?: Readonly<{
    accept: string;
    decode(response: Response, options: { readonly maxBytes: number; readonly signal: AbortSignal }): Promise<unknown>;
  }>,
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
        response = await observeProviderHttpRequestV1({ upstream_service: providerUpstreamServiceV1(binding.tool_id), upstream_operation: 'provider_read' }, () =>
          abortableProviderOperationV1(() => fetchAuthenticated(selected.url.href, {
            method: selected.method ?? 'GET', redirect: 'error', signal,
            headers: { Accept: responseFormat?.accept ?? 'application/json', ...(selected.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(selected.body === undefined ? {} : { body: JSON.stringify(selected.body) }),
          }), signal, disposeProviderResponseV1),
        );
        signal.throwIfAborted();
        if (response.redirected || response.url !== '' && response.url !== selected.url.href) failure('invalid_output');
        if (response.status !== 200) {
          if (response.status === 401 || response.status === 403) failure('unauthorized');
          if (response.status === 404) failure('not_found');
          if (response.status === 429) failure('rate_limited');
          failure('unavailable');
        }
        if (responseFormat === undefined && !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) failure('invalid_output');
        const result = await (responseFormat?.decode ?? readBoundedJsonResponseV1)(response, { maxBytes: PERSON_PROVIDER_RESPONSE_MAX_BYTES_V1, signal });
        signal.throwIfAborted();
        current();
        return result;
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof BoundedJsonResponseErrorV1 && error.code !== 'transport') failure('invalid_output');
        if (error instanceof AuthorityOperationError && SAFE_ERRORS.has(error.code)) failure(error.code as Parameters<typeof failure>[0]);
        failure('unavailable');
      } finally { disposeProviderResponseV1(response); }
    },
  });
}
