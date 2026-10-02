import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { SLACK_CONTEXT_CHANNEL_V1, SLACK_CONTEXT_MAX_CURSOR_BYTES_V1, SLACK_CONTEXT_MAX_PAGE_V1, SLACK_CONTEXT_TS_V1,
  copySlackContextBindingV1, requireSlackContextResponseV1, slackContextFailureV1 } from './slack-context-validation-v1.js';

export interface SlackContextRequestV1 {
  readonly method: 'auth.test' | 'conversations.info' | 'conversations.history' | 'chat.getPermalink';
  readonly query?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** The trusted authorization port is fixed to an explicit ECHO owner/channel grant. */
export interface SlackContextTransportV1 {
  readonly binding: PersonConnectorReadBindingV1;
  request(input: SlackContextRequestV1): Promise<unknown>;
}

export interface SlackContextAuthenticatedFetchV1 {
  readonly binding: PersonConnectorReadBindingV1;
  /** Authority supplies current bot authorization; preserve cancellation and redirect refusal. */
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export const SLACK_CONTEXT_RESPONSE_MAX_BYTES_V1 = 512 * 1024;

function requestUrl(input: SlackContextRequestV1): URL {
  const fields = {
    'auth.test': [], 'conversations.info': ['channel'],
    'conversations.history': ['channel', 'limit', 'cursor'], 'chat.getPermalink': ['channel', 'message_ts'],
  } as const;
  if (!Object.hasOwn(fields, input.method)) slackContextFailureV1('invalid_request');
  const query = input.query ?? {};
  if (query === null || typeof query !== 'object' || Array.isArray(query) || ![Object.prototype, null].includes(Object.getPrototypeOf(query)) ||
      Object.getOwnPropertySymbols(query).length !== 0 || Object.values(Object.getOwnPropertyDescriptors(query)).some(d => !('value' in d) || !d.enumerable)) slackContextFailureV1('invalid_request');
  const allowed: readonly string[] = fields[input.method];
  if (Object.keys(query).some(key => !allowed.includes(key))) slackContextFailureV1('invalid_request');
  if (input.method !== 'auth.test' && (typeof query.channel !== 'string' || !SLACK_CONTEXT_CHANNEL_V1.test(query.channel))) slackContextFailureV1('invalid_request');
  if (input.method === 'conversations.history') {
    if (typeof query.limit !== 'string' || !/^[1-9][0-9]*$/.test(query.limit) || Number(query.limit) > SLACK_CONTEXT_MAX_PAGE_V1) slackContextFailureV1('invalid_request');
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.trim() === '' ||
        Buffer.byteLength(query.cursor, 'utf8') > SLACK_CONTEXT_MAX_CURSOR_BYTES_V1 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(query.cursor))) slackContextFailureV1('invalid_request');
  }
  if (input.method === 'chat.getPermalink' && (typeof query.message_ts !== 'string' || !SLACK_CONTEXT_TS_V1.test(query.message_ts))) slackContextFailureV1('invalid_request');
  const url = new URL(`https://slack.com/api/${input.method}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

/** Read-only, bounded API transport. No token enters this interface or any returned value. */
export function createSlackContextTransportV1(authenticated: SlackContextAuthenticatedFetchV1): SlackContextTransportV1 {
  const binding = copySlackContextBindingV1(authenticated.binding);
  const fetchAuthenticated = authenticated.fetch.bind(authenticated);
  const assertBinding = () => {
    if (JSON.stringify(copySlackContextBindingV1(authenticated.binding)) !== JSON.stringify(binding)) slackContextFailureV1('stale_access_state');
  };
  return Object.freeze({
    binding,
    async request(input: SlackContextRequestV1): Promise<unknown> {
      input.signal?.throwIfAborted();
      const url = requestUrl(input);
      const deadline = AbortSignal.timeout(15_000);
      const signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
      let response: Response | undefined;
      try {
        assertBinding();
        response = await fetchAuthenticated(url.href, { method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/json' } });
        signal.throwIfAborted();
        if (response.redirected || (response.url !== '' && response.url !== url.href)) slackContextFailureV1('invalid_output');
        // Classify status before parsing: provider diagnostics are never exposed.
        if (response.status !== 200) {
          if (response.status === 401 || response.status === 403) slackContextFailureV1('unauthorized');
          if (response.status === 404) slackContextFailureV1('not_found');
          if (response.status === 429) slackContextFailureV1('rate_limited');
          slackContextFailureV1('unavailable');
        }
        if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) slackContextFailureV1('invalid_output');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > SLACK_CONTEXT_RESPONSE_MAX_BYTES_V1)) slackContextFailureV1('invalid_output');
        if (response.body === null) slackContextFailureV1('invalid_output');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > SLACK_CONTEXT_RESPONSE_MAX_BYTES_V1) slackContextFailureV1('invalid_output');
            chunks.push(chunk.value);
          }
          let body: unknown;
          try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { slackContextFailureV1('invalid_output'); }
          signal.throwIfAborted();
          assertBinding();
          return requireSlackContextResponseV1(body);
        } finally {
          try { await reader.cancel(); } catch { /* Preserve the classified failure. */ }
          reader.releaseLock();
        }
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof AuthorityOperationError) slackContextFailureV1(error.code);
        slackContextFailureV1('unavailable');
      } finally {
        if (response?.body !== undefined && response.body !== null && !response.body.locked) {
          try { await response.body.cancel(); } catch { /* Response disposal cannot leak provider diagnostics. */ }
        }
      }
    },
  });
}
