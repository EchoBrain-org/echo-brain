const DEFAULT_BASE_URL = 'https://slack.com/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const REPLIES_PAGE_LIMIT = 200;
const MAX_REPLY_PAGES = 25;

export type SlackApiErrorCode =
  | 'auth'
  | 'rate_limited'
  | 'transient'
  | 'unknown_outcome'
  | 'invalid';

export class SlackApiError extends Error {
  constructor(
    public readonly code: SlackApiErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  blocks?: readonly unknown[];
}

export interface SlackPostedMessage {
  channel: string;
  ts: string;
}

export interface SlackReaction {
  name: string;
  users: readonly string[];
  count: number;
}

export interface SlackReply {
  user: string;
  text: string;
  ts: string;
}

export interface SlackWebApiClientOptions {
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const AUTH_ERRORS = new Set([
  'not_authed',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
  'missing_scope',
  'not_allowed_token_type',
]);

const RATE_LIMIT_ERRORS = new Set([
  'ratelimited',
  'rate_limited',
]);

const TRANSIENT_ERRORS = new Set([
  'service_unavailable',
  'fatal_error',
  'internal_error',
  'request_timeout',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Minimal Slack Web API client for the reactions approval surface. Slack
 * commonly reports failures as HTTP 200 with `{ok:false,error}`, so both the
 * transport status and the body envelope are checked on every call.
 */
export class SlackWebApiClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly token: string,
    options: SlackWebApiClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async authTest(signal?: AbortSignal): Promise<{ user_id: string | null }> {
    const body = await this.call('auth.test', {}, { signal });
    const userId = body['user_id'];
    return { user_id: isNonEmptyString(userId) ? userId : null };
  }

  async postMessage(
    input: SlackPostMessageInput,
    signal?: AbortSignal,
  ): Promise<SlackPostedMessage> {
    // A transport failure here is an unknown outcome: Slack may have accepted
    // the message even though no response arrived. Callers must treat posting
    // as at-least-once.
    const body = await this.call(
      'chat.postMessage',
      {
        channel: input.channel,
        text: input.text,
        ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
      },
      { signal, unknownOutcomeOnTransportFailure: true },
    );
    const channel = body['channel'];
    const ts = body['ts'];
    if (!isNonEmptyString(channel) || !isNonEmptyString(ts)) {
      throw new SlackApiError(
        'unknown_outcome',
        'Slack accepted the message but returned no channel/ts identity',
        true,
      );
    }
    return { channel, ts };
  }

  async reactionsGet(
    channel: string,
    timestamp: string,
    signal?: AbortSignal,
  ): Promise<readonly SlackReaction[]> {
    const body = await this.call(
      'reactions.get',
      { channel, timestamp, full: true },
      { signal, method: 'GET' },
    );
    const message = body['message'];
    if (!isPlainObject(message)) return [];
    const reactions = message['reactions'];
    if (!Array.isArray(reactions)) return [];
    return reactions.flatMap((entry) => {
      if (!isPlainObject(entry)) return [];
      const name = entry['name'];
      const users = entry['users'];
      const count = entry['count'];
      if (
        !isNonEmptyString(name) ||
        !Array.isArray(users) ||
        !users.every(isNonEmptyString) ||
        typeof count !== 'number'
      ) {
        return [];
      }
      return [{ name, users, count }];
    });
  }

  async conversationsReplies(
    channel: string,
    parentTs: string,
    signal?: AbortSignal,
  ): Promise<readonly SlackReply[]> {
    const replies: SlackReply[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_REPLY_PAGES; page += 1) {
      const body = await this.call(
        'conversations.replies',
        {
          channel,
          ts: parentTs,
          limit: REPLIES_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal, method: 'GET' },
      );
      const messages = body['messages'];
      if (Array.isArray(messages)) {
        for (const message of messages) {
          if (!isPlainObject(message)) continue;
          const ts = message['ts'];
          const user = message['user'];
          const text = message['text'];
          // The response includes the parent message itself; only true
          // thread replies with an attributable author count as reasons.
          if (ts === parentTs) continue;
          if (!isNonEmptyString(ts) || !isNonEmptyString(user)) continue;
          if (typeof text !== 'string') continue;
          replies.push({ user, text, ts });
        }
      }
      const metadata = body['response_metadata'];
      const nextCursor = isPlainObject(metadata) ? metadata['next_cursor'] : undefined;
      if (!isNonEmptyString(nextCursor)) return replies;
      cursor = nextCursor;
    }
    throw new SlackApiError(
      'invalid',
      'Slack thread pagination exceeded the supported page budget',
      false,
    );
  }

  private async call(
    method: string,
    parameters: Record<string, unknown>,
    options: {
      signal?: AbortSignal | undefined;
      method?: 'GET' | 'POST';
      unknownOutcomeOnTransportFailure?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const httpMethod = options.method ?? 'POST';
    const transportFailureCode: SlackApiErrorCode =
      options.unknownOutcomeOnTransportFailure === true
        ? 'unknown_outcome'
        : 'transient';
    const controller = new AbortController();
    const abortUpstream = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abortUpstream, { once: true });
    if (options.signal?.aborted === true) abortUpstream();
    const timer = setTimeout(
      () => controller.abort(new Error(`Slack ${method} timed out`)),
      this.requestTimeoutMs,
    );
    try {
      let url = `${this.baseUrl}/${method}`;
      const init: RequestInit = {
        method: httpMethod,
        signal: controller.signal,
        // Slack API methods are not expected to redirect. Refusing redirects
        // prevents fetch from forwarding the bearer credential to a different
        // endpoint if Slack, a proxy, or a configured test endpoint responds
        // with a redirect.
        redirect: 'error',
        headers: { authorization: `Bearer ${this.token}` },
      };
      if (httpMethod === 'GET') {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(parameters)) {
          query.set(key, String(value));
        }
        url = `${url}?${query.toString()}`;
      } else {
        init.headers = {
          ...init.headers,
          'content-type': 'application/json; charset=utf-8',
        };
        init.body = JSON.stringify(parameters);
      }
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        throw new SlackApiError(
          transportFailureCode,
          `Slack ${method} transport failed: ${(error as Error).message}`,
          true,
        );
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new SlackApiError(
          'rate_limited',
          `Slack ${method} is rate limited`,
          true,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        );
      }
      if (response.status >= 500) {
        throw new SlackApiError(
          transportFailureCode,
          `Slack ${method} failed with HTTP ${response.status}`,
          true,
        );
      }
      if (!response.ok) {
        throw new SlackApiError(
          'invalid',
          `Slack ${method} failed with HTTP ${response.status}`,
          false,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SlackApiError(
          transportFailureCode,
          `Slack ${method} returned an unreadable body`,
          true,
        );
      }
      if (!isPlainObject(body)) {
        throw new SlackApiError(
          'invalid',
          `Slack ${method} returned an unexpected body`,
          false,
        );
      }
      if (body['ok'] !== true) {
        const error = isNonEmptyString(body['error'])
          ? body['error']
          : 'unknown_error';
        if (AUTH_ERRORS.has(error)) {
          throw new SlackApiError('auth', `Slack ${method} failed: ${error}`, false);
        }
        if (RATE_LIMIT_ERRORS.has(error)) {
          throw new SlackApiError(
            'rate_limited',
            `Slack ${method} failed: ${error}`,
            true,
          );
        }
        if (TRANSIENT_ERRORS.has(error)) {
          throw new SlackApiError(
            'transient',
            `Slack ${method} failed: ${error}`,
            true,
          );
        }
        throw new SlackApiError(
          'invalid',
          `Slack ${method} failed: ${error}`,
          false,
        );
      }
      return body;
    } finally {
      // Keep both deadline and upstream cancellation connected until the
      // complete response body has been consumed, not merely until headers
      // arrive. Fetch resolves as soon as headers are available.
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortUpstream);
    }
  }
}
