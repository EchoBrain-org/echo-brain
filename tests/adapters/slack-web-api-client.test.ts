import { describe, expect, it } from 'vitest';
import {
  SlackApiError,
  SlackWebApiClient,
} from '../../src/adapters/approval-surfaces/slack-reactions/slack-web-api-client.js';

function jsonResponse(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
  });
}

function fetchReturning(response: () => Response): typeof fetch {
  return (async () => response()) as typeof fetch;
}

function stalledResponse(signal: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = () =>
        controller.error(signal.reason ?? new Error('Slack request aborted'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`test operation did not settle within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('SlackWebApiClient', () => {
  it('keeps the request timeout active while consuming the response body', async () => {
    const fetchImpl = (async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error('expected a request signal');
      }
      return stalledResponse(signal);
    }) as typeof fetch;
    const client = new SlackWebApiClient('xoxb-test', {
      fetchImpl,
      requestTimeoutMs: 20,
    });

    await expect(settleWithin(client.authTest())).rejects.toMatchObject({
      name: 'SlackApiError',
      code: 'transient',
      retryable: true,
    });
  });

  it('keeps upstream cancellation connected while consuming the response body', async () => {
    let responseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      responseStarted = resolve;
    });
    const fetchImpl = (async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error('expected a request signal');
      }
      responseStarted?.();
      return stalledResponse(signal);
    }) as typeof fetch;
    const client = new SlackWebApiClient('xoxb-test', {
      fetchImpl,
      requestTimeoutMs: 5_000,
    });
    const upstream = new AbortController();
    const pending = client.authTest(upstream.signal);
    await started;

    upstream.abort(new Error('caller cancelled'));

    await expect(settleWithin(pending)).rejects.toMatchObject({
      name: 'SlackApiError',
      code: 'transient',
      retryable: true,
    });
  });

  it.each(['ratelimited', 'rate_limited'])(
    "classifies Slack body error '%s' as rate limited",
    async (error) => {
      const client = new SlackWebApiClient('xoxb-test', {
        fetchImpl: fetchReturning(() => jsonResponse({ ok: false, error })),
      });

      await expect(client.authTest()).rejects.toMatchObject({
        name: 'SlackApiError',
        code: 'rate_limited',
        retryable: true,
      });
    },
  );

  it.each([
    'service_unavailable',
    'fatal_error',
    'internal_error',
    'request_timeout',
  ])("classifies Slack body error '%s' as transient", async (error) => {
    const client = new SlackWebApiClient('xoxb-test', {
      fetchImpl: fetchReturning(() => jsonResponse({ ok: false, error })),
    });

    await expect(client.authTest()).rejects.toMatchObject({
      name: 'SlackApiError',
      code: 'transient',
      retryable: true,
    });
  });

  it('preserves HTTP rate-limit metadata', async () => {
    const client = new SlackWebApiClient('xoxb-test', {
      fetchImpl: fetchReturning(() =>
        jsonResponse(
          { ok: false, error: 'ratelimited' },
          { status: 429, headers: { 'retry-after': '17' } },
        ),
      ),
    });

    await expect(client.authTest()).rejects.toMatchObject({
      name: 'SlackApiError',
      code: 'rate_limited',
      retryable: true,
      retryAfterSeconds: 17,
    });
  });

  it('keeps HTTP 5xx reads transient and post outcomes unknown', async () => {
    const client = new SlackWebApiClient('xoxb-test', {
      fetchImpl: fetchReturning(() =>
        jsonResponse({ ok: false }, { status: 503 }),
      ),
    });

    await expect(client.authTest()).rejects.toMatchObject({
      name: 'SlackApiError',
      code: 'transient',
      retryable: true,
    });
    await expect(
      client.postMessage({ channel: 'C123', text: 'approval request' }),
    ).rejects.toMatchObject({
      name: 'SlackApiError',
      code: 'unknown_outcome',
      retryable: true,
    });
  });

  it('refuses redirects on authenticated Slack requests', async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = (async (_input, init) => {
      requestInit = init;
      return jsonResponse({ ok: true, user_id: 'B123' });
    }) as typeof fetch;
    const client = new SlackWebApiClient('xoxb-test', { fetchImpl });

    await expect(client.authTest()).resolves.toEqual({ user_id: 'B123' });
    expect(requestInit?.redirect).toBe('error');
    expect(new Headers(requestInit?.headers).get('authorization')).toBe(
      'Bearer xoxb-test',
    );
  });

  it('preserves typed authentication and invalid-response errors', async () => {
    const unauthorized = new SlackWebApiClient('xoxb-test', {
      fetchImpl: fetchReturning(() =>
        jsonResponse({ ok: false, error: 'invalid_auth' }),
      ),
    });
    const invalid = new SlackWebApiClient('xoxb-test', {
      fetchImpl: fetchReturning(() =>
        jsonResponse({ ok: false, error: 'channel_not_found' }),
      ),
    });

    await expect(unauthorized.authTest()).rejects.toEqual(
      expect.objectContaining<Partial<SlackApiError>>({
        name: 'SlackApiError',
        code: 'auth',
        retryable: false,
      }),
    );
    await expect(invalid.authTest()).rejects.toEqual(
      expect.objectContaining<Partial<SlackApiError>>({
        name: 'SlackApiError',
        code: 'invalid',
        retryable: false,
      }),
    );
  });
});
