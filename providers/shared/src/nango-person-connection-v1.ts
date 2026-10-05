import type { PersonProviderV1 } from './person-provider-v1.js';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

/** Only selecting server composition supplies this port. Never pass its key to a Person or model. */
export interface NangoPersonConnectionV1 {
  connect(tags: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<{ readonly link: string }>;
  connection(reference: string, signal?: AbortSignal): Promise<{ readonly tags: Readonly<Record<string, string>>; readonly access_token: string }>;
  find(tags: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string | undefined>;
  disconnect(reference: string, signal?: AbortSignal): Promise<void>;
}

/** Current Nango HTTP API, no SDK/actions/syncs. Response bodies and credentials are never logged. */
export function createNangoPersonConnectionV1(options: { readonly provider: Pick<PersonProviderV1, 'nango_provider_id' | 'oauth_scopes' | 'failure' | 'record' | 'string' | 'array'>; readonly integration_id: string; readonly authorization: () => string; readonly fetch: typeof fetch }): NangoPersonConnectionV1 {
  const { record, string, array } = options.provider;
  const failure: PersonProviderV1['failure'] = options.provider.failure;
  const integration = string(options.integration_id, 255);
  async function call(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const combined = signal === undefined ? AbortSignal.timeout(15_000) : AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    let response: Response | undefined;
    try {
      const url = `https://api.nango.dev${path}`;
      response = await options.fetch(url, { method, redirect: 'error', signal: combined, headers: { Authorization: `Bearer ${options.authorization()}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.redirected || (response.url !== '' && response.url !== url)) failure('unavailable');
      if (response.status === 429) failure('rate_limited');
      if (method === 'DELETE' && response.status === 404) return undefined;
      // Nango reports a previously deleted connection as 400 unknown_connection.
      // Reconnect retries cleanup, so only that exact response is also success.
      const missingDeletion = method === 'DELETE' && response.status === 400;
      if (!response.ok && !missingDeletion) failure('unavailable');
      if (method === 'DELETE' && !missingDeletion) return undefined;
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) failure('unavailable');
      const reader = response.body?.getReader();
      if (reader === undefined) failure('unavailable');
      const chunks: Uint8Array[] = []; let bytes = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      combined.addEventListener('abort', abort, { once: true });
      try {
        for (;;) { combined.throwIfAborted(); const part = await reader.read(); combined.throwIfAborted(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 128 * 1024) failure('unavailable'); chunks.push(part.value); }
        const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (missingDeletion) {
          if (record(record(result).error).code !== 'unknown_connection') failure('unavailable');
          return undefined;
        }
        return result;
      } finally { combined.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AuthorityOperationError && error.code === 'rate_limited') failure('rate_limited');
      failure('unavailable');
    }
    finally { if (response?.body !== null && response?.body !== undefined && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  const path = (reference: string) => `/connections/${encodeURIComponent(string(reference, 512))}?provider_config_key=${encodeURIComponent(integration)}`;
  return Object.freeze<NangoPersonConnectionV1>({
    async connect(tags, signal) {
      const defaults = { [integration]: { connection_config: { oauth_scopes_override: options.provider.oauth_scopes } } };
      const body = { tags, allowed_integrations: [integration], integrations_config_defaults: defaults };
      const result = record(await call('/connect/sessions', 'POST', body, signal));
      const data = record(result.data);
      const link = string(data.connect_link, 4096); const url = new URL(link);
      if (url.origin !== 'https://connect.nango.dev' || url.username !== '' || url.password !== '' || url.hash !== '') failure('invalid_output');
      return Object.freeze({ link });
    },
    async connection(reference, signal) {
      const data = record(await call(path(reference), 'GET', undefined, signal));
      if (data.connection_id !== reference || data.provider_config_key !== integration || data.provider !== options.provider.nango_provider_id) failure('unauthorized');
      const credentials = record(data.credentials); if (credentials.type !== 'OAUTH2') failure('unauthorized');
      const tags = record(data.tags); const copied: Record<string, string> = {};
      for (const key of ['echo_attempt', 'organization_id', 'end_user_id', 'echo_membership']) copied[key] = string(tags[key], 255);
      return Object.freeze({ tags: Object.freeze(copied), access_token: string(credentials.access_token, 16 * 1024) });
    },
    async find(tags, signal) {
      // Nango connection-list pages are zero-based, so page 0 is the first page.
      const query = new URLSearchParams({ limit: '2', page: '0' });
      for (const [key, value] of Object.entries(tags)) query.set(`tags[${key}]`, value);
      const data = record(await call(`/connections?${query}`, 'GET', undefined, signal));
      const connections = array(data.connections, 2);
      if (connections.length === 0) return undefined;
      if (connections.length !== 1) failure('unauthorized');
      const found = record(connections[0]);
      if (found.provider_config_key !== integration || found.provider !== options.provider.nango_provider_id) failure('unauthorized');
      return string(found.connection_id, 512);
    },
    async disconnect(reference, signal) { await call(path(reference), 'DELETE', undefined, signal); },
  });
}
