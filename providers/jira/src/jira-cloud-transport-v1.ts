import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { copyJiraBindingV1, jiraFailure } from './jira-validation-v1.js';

export interface JiraCloudRequestV1 {
  readonly path: string;
  readonly method?: 'GET' | 'POST';
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

/** Trusted transport port. Its authorization is fixed to the same ECHO person and grant. */
export interface JiraCloudTransportV1 {
  readonly binding: PersonConnectorReadBindingV1;
  request(input: JiraCloudRequestV1): Promise<unknown>;
}

export interface JiraCloudAuthenticatedFetchV1 {
  readonly binding: PersonConnectorReadBindingV1;
  /** Attach current 3LO authorization here. Preserve redirect mode and signal; never retry anonymously. */
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export const JIRA_RESPONSE_MAX_BYTES_V1 = 1024 * 1024;

/** Direct API transport. It never receives or returns a token or follows provider-supplied links. */
export function createJiraCloudTransportV1(authenticated: JiraCloudAuthenticatedFetchV1): JiraCloudTransportV1 {
  const binding = copyJiraBindingV1(authenticated.binding);
  const fetchAuthenticated = authenticated.fetch.bind(authenticated);
  const prefix = `/ex/jira/${binding.external_scope_id}/rest/api/3/`;
  return Object.freeze({
    binding,
    async request(input: JiraCloudRequestV1): Promise<unknown> {
      input.signal?.throwIfAborted();
      const method = input.method ?? 'GET';
      const suffix = input.path.startsWith(prefix) ? input.path.slice(prefix.length) : '';
      const resources = input.path === '/oauth/token/accessible-resources';
      if (!(resources || /^(?:myself|project\/(?:[1-9][0-9]{0,19}|[A-Z][A-Z0-9_]{0,63})|issue\/[1-9][0-9]{0,19}|search\/jql)$/.test(suffix)) ||
          (suffix === 'search/jql' ? method !== 'POST' : method !== 'GET') || (method === 'GET' && input.body !== undefined)) jiraFailure('invalid_request');
      const url = new URL(input.path, 'https://api.atlassian.com');
      for (const [key, value] of Object.entries(input.query ?? {})) {
        const issueFields = key === 'fields' && /^[a-zA-Z,]+$/.test(value) && suffix.startsWith('issue/');
        const projectKeys = key === 'expand' && value === 'projectKeys' && suffix.startsWith('project/');
        if (!issueFields && !projectKeys) jiraFailure('invalid_request');
        url.searchParams.set(key, value);
      }
      const signal = input.signal === undefined ? AbortSignal.timeout(15_000) : AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
      let response: Response | undefined;
      try {
        // Detect a mutable authorization port even though the exported binding is a copy.
        if (JSON.stringify(copyJiraBindingV1(authenticated.binding)) !== JSON.stringify(binding)) jiraFailure('stale_access_state');
        response = await fetchAuthenticated(url.href, { method, redirect: 'error', signal,
          headers: { Accept: 'application/json', ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
        signal.throwIfAborted();
        if (response.redirected || (response.url !== '' && response.url !== url.href)) jiraFailure('invalid_output');
        if (response.status !== 200) {
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403) jiraFailure('unauthorized');
          if (response.status === 404) jiraFailure('not_found');
          if (response.status === 429) jiraFailure('rate_limited');
          jiraFailure('unavailable');
        }
        if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) jiraFailure('invalid_output');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > JIRA_RESPONSE_MAX_BYTES_V1)) jiraFailure('invalid_output');
        if (response.body === null) jiraFailure('invalid_output');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let total = 0;
        try {
          while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > JIRA_RESPONSE_MAX_BYTES_V1) jiraFailure('invalid_output');
            chunks.push(chunk.value);
          }
          let result: unknown;
          try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { jiraFailure('invalid_output'); }
          signal.throwIfAborted();
          if (JSON.stringify(copyJiraBindingV1(authenticated.binding)) !== JSON.stringify(binding)) jiraFailure('stale_access_state');
          return result;
        } finally { await reader.cancel(); reader.releaseLock(); }
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof AuthorityOperationError && ['invalid_request', 'invalid_output', 'unauthorized', 'not_found', 'stale_access_state', 'unavailable', 'rate_limited'].includes(error.code)) jiraFailure(error.code as Parameters<typeof jiraFailure>[0]);
        jiraFailure('unavailable');
      } finally {
        // Also dispose responses refused before streaming (headers, origin, cancellation).
        if (response?.body !== undefined && response.body !== null && !response.body.locked) {
          try { await response.body.cancel(); } catch { /* Disposal cannot expose a provider exception. */ }
        }
      }
    },
  });
}
