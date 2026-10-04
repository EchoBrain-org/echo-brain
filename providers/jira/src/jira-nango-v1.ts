import { jiraFailure, jiraRecord, jiraString, jiraArray } from './jira-validation-v1.js';

/** Only selecting server composition supplies this port. Never pass its key to a Person or model. */
export interface JiraNangoV1 {
  connect(tags: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<{ readonly link: string }>;
  connection(reference: string, signal?: AbortSignal): Promise<{ readonly tags: Readonly<Record<string, string>>; readonly access_token: string }>;
  find(tags: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string | undefined>;
  disconnect(reference: string, signal?: AbortSignal): Promise<void>;
}

/** Current Nango HTTP API, no SDK/actions/syncs. Response bodies and credentials are never logged. */
export function createJiraNangoV1(options: { readonly integration_id: string; readonly authorization: () => string; readonly fetch: typeof fetch }): JiraNangoV1 {
  const integration = jiraString(options.integration_id, 255);
  async function call(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const combined = signal === undefined ? AbortSignal.timeout(15_000) : AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    let response: Response | undefined;
    try {
      const url = `https://api.nango.dev${path}`;
      response = await options.fetch(url, { method, redirect: 'error', signal: combined, headers: { Authorization: `Bearer ${options.authorization()}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.redirected || (response.url !== '' && response.url !== url)) jiraFailure('unavailable');
      if (method === 'DELETE' && response.status === 404) return undefined;
      // Nango reports a previously deleted connection as 400 unknown_connection.
      // Reconnect retries cleanup, so only that exact response is also success.
      const missingDeletion = method === 'DELETE' && response.status === 400;
      if (!response.ok && !missingDeletion) jiraFailure('unavailable');
      if (method === 'DELETE' && !missingDeletion) return undefined;
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) jiraFailure('unavailable');
      const reader = response.body?.getReader();
      if (reader === undefined) jiraFailure('unavailable');
      const chunks: Uint8Array[] = []; let bytes = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      combined.addEventListener('abort', abort, { once: true });
      try {
        for (;;) { combined.throwIfAborted(); const part = await reader.read(); combined.throwIfAborted(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 128 * 1024) jiraFailure('unavailable'); chunks.push(part.value); }
        const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (missingDeletion) {
          if (jiraRecord(jiraRecord(result).error).code !== 'unknown_connection') jiraFailure('unavailable');
          return undefined;
        }
        return result;
      } finally { combined.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { signal?.throwIfAborted(); jiraFailure('unavailable'); }
    finally { if (response?.body !== null && response?.body !== undefined && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  const path = (reference: string) => `/connections/${encodeURIComponent(jiraString(reference, 512))}?provider_config_key=${encodeURIComponent(integration)}`;
  return Object.freeze<JiraNangoV1>({
    async connect(tags, signal) {
      const defaults = { [integration]: { connection_config: { oauth_scopes_override: 'offline_access read:jira-work read:jira-user' } } };
      const body = { tags, allowed_integrations: [integration], integrations_config_defaults: defaults };
      const result = jiraRecord(await call('/connect/sessions', 'POST', body, signal));
      const data = jiraRecord(result.data);
      const link = jiraString(data.connect_link, 4096); const url = new URL(link);
      if (url.origin !== 'https://connect.nango.dev' || url.username !== '' || url.password !== '' || url.hash !== '') jiraFailure('invalid_output');
      return Object.freeze({ link });
    },
    async connection(reference, signal) {
      const data = jiraRecord(await call(path(reference), 'GET', undefined, signal));
      if (data.connection_id !== reference || data.provider_config_key !== integration || data.provider !== 'jira') jiraFailure('unauthorized');
      const credentials = jiraRecord(data.credentials); if (credentials.type !== 'OAUTH2') jiraFailure('unauthorized');
      const tags = jiraRecord(data.tags); const copied: Record<string, string> = {};
      for (const key of ['echo_attempt', 'organization_id', 'end_user_id', 'echo_membership']) copied[key] = jiraString(tags[key], 255);
      return Object.freeze({ tags: Object.freeze(copied), access_token: jiraString(credentials.access_token, 16 * 1024) });
    },
    async find(tags, signal) {
      // Nango connection-list pages are zero-based, so page 0 is the first page.
      const query = new URLSearchParams({ limit: '2', page: '0' });
      for (const [key, value] of Object.entries(tags)) query.set(`tags[${key}]`, value);
      const data = jiraRecord(await call(`/connections?${query}`, 'GET', undefined, signal));
      const connections = jiraArray(data.connections, 2);
      if (connections.length === 0) return undefined;
      if (connections.length !== 1) jiraFailure('unauthorized');
      const found = jiraRecord(connections[0]);
      if (found.provider_config_key !== integration || found.provider !== 'jira') jiraFailure('unauthorized');
      return jiraString(found.connection_id, 512);
    },
    async disconnect(reference, signal) { await call(path(reference), 'DELETE', undefined, signal); },
  });
}
