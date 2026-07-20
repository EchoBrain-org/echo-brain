import { describe, expect, it } from "vitest";
import {
  SlackApiError,
  SlackWebApiClient,
} from "../../src/adapters/approval-surfaces/slack-reactions/slack-web-api-client.js";

function jsonResponse(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/json",
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
        controller.error(signal.reason ?? new Error("Slack request aborted"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs = 500,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`test operation did not settle within ${timeoutMs}ms`),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("SlackWebApiClient", () => {
  it("keeps the request timeout active while consuming the response body", async () => {
    const fetchImpl = (async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("expected a request signal");
      }
      return stalledResponse(signal);
    }) as typeof fetch;
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl,
      requestTimeoutMs: 20,
    });

    await expect(settleWithin(client.authTest())).rejects.toMatchObject({
      name: "SlackApiError",
      code: "transient",
      retryable: true,
    });
  });

  it("keeps upstream cancellation connected while consuming the response body", async () => {
    let responseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      responseStarted = resolve;
    });
    const fetchImpl = (async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("expected a request signal");
      }
      responseStarted?.();
      return stalledResponse(signal);
    }) as typeof fetch;
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl,
      requestTimeoutMs: 5_000,
    });
    const upstream = new AbortController();
    const pending = client.authTest(upstream.signal);
    await started;

    upstream.abort(new Error("caller cancelled"));

    await expect(settleWithin(pending)).rejects.toMatchObject({
      name: "SlackApiError",
      code: "transient",
      retryable: true,
    });
  });

  it.each(["ratelimited", "rate_limited"])(
    "classifies Slack body error '%s' as rate limited",
    async (error) => {
      const client = new SlackWebApiClient("xoxb-test", {
        fetchImpl: fetchReturning(() => jsonResponse({ ok: false, error })),
      });

      await expect(client.authTest()).rejects.toMatchObject({
        name: "SlackApiError",
        code: "rate_limited",
        retryable: true,
      });
    },
  );

  it.each([
    "service_unavailable",
    "fatal_error",
    "internal_error",
    "request_timeout",
  ])("classifies Slack body error '%s' as transient", async (error) => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() => jsonResponse({ ok: false, error })),
    });

    await expect(client.authTest()).rejects.toMatchObject({
      name: "SlackApiError",
      code: "transient",
      retryable: true,
    });
  });

  it.each([
    "service_unavailable",
    "fatal_error",
    "internal_error",
    "request_timeout",
  ])(
    "treats Slack post body error '%s' as an unknown outcome",
    async (error) => {
      const client = new SlackWebApiClient("xoxb-test", {
        fetchImpl: fetchReturning(() => jsonResponse({ ok: false, error })),
      });

      await expect(
        client.postMessage({ channel: "C123", text: "approved brief" }),
      ).rejects.toMatchObject({
        name: "SlackApiError",
        code: "unknown_outcome",
        retryable: true,
      });
    },
  );

  it("preserves HTTP rate-limit metadata", async () => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse(
          { ok: false, error: "ratelimited" },
          { status: 429, headers: { "retry-after": "17" } },
        ),
      ),
    });

    await expect(client.authTest()).rejects.toMatchObject({
      name: "SlackApiError",
      code: "rate_limited",
      retryable: true,
      retryAfterSeconds: 17,
    });
  });

  it("keeps HTTP 5xx reads transient and post outcomes unknown", async () => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse({ ok: false }, { status: 503 }),
      ),
    });

    await expect(client.authTest()).rejects.toMatchObject({
      name: "SlackApiError",
      code: "transient",
      retryable: true,
    });
    await expect(
      client.postMessage({ channel: "C123", text: "approval request" }),
    ).rejects.toMatchObject({
      name: "SlackApiError",
      code: "unknown_outcome",
      retryable: true,
    });
  });

  it("refuses redirects on authenticated Slack requests", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = (async (_input, init) => {
      requestInit = init;
      return jsonResponse({ ok: true, user_id: "B123" });
    }) as typeof fetch;
    const client = new SlackWebApiClient("xoxb-test", { fetchImpl });

    await expect(client.authTest()).resolves.toEqual({ user_id: "B123" });
    expect(requestInit?.redirect).toBe("error");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer xoxb-test",
    );
  });

  it("captures strict workspace and bot identifiers without changing authTest health behavior", async () => {
    const response = {
      ok: true,
      team_id: "T123ABC",
      enterprise_id: "E456DEF",
      user_id: "U789GHI",
      bot_id: "B123ABC",
      app_id: "A456DEF",
    };
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() => jsonResponse(response)),
    });

    await expect(client.authTest()).resolves.toEqual({ user_id: "U789GHI" });
    await expect(client.authIdentity()).resolves.toEqual({
      team_id: "T123ABC",
      enterprise_id: "E456DEF",
      user_id: "U789GHI",
      bot_id: "B123ABC",
      app_id: "A456DEF",
    });
  });

  it.each([
    { team_id: undefined, user_id: "U789GHI" },
    { team_id: "not-a-team", user_id: "U789GHI" },
    { team_id: "T123ABC", user_id: undefined },
    { team_id: "T123ABC", user_id: "not-a-user" },
    { team_id: "T123ABC", user_id: "U789GHI", bot_id: "not-a-bot" },
    { team_id: "T123ABC", user_id: "U789GHI", enterprise_id: "bad" },
  ])("rejects malformed auth.test identity fields: %o", async (fields) => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() => jsonResponse({ ok: true, ...fields })),
    });

    await expect(client.authIdentity()).rejects.toMatchObject({
      name: "SlackApiError",
      code: "invalid",
      retryable: false,
    });
  });

  it("opens one exact direct message and verifies Slack names the requested user", async () => {
    let method = "";
    let requestBody: unknown;
    const fetchImpl = (async (input, init) => {
      method = String(input).split("/").pop() ?? "";
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        ok: true,
        channel: { id: "D123ABC", is_im: true, user: "U789GHI" },
      });
    }) as typeof fetch;
    const client = new SlackWebApiClient("xoxb-test", { fetchImpl });

    await expect(client.openDirectMessage("U789GHI")).resolves.toEqual({
      channel_id: "D123ABC",
      user_id: "U789GHI",
    });
    expect(method).toBe("conversations.open");
    expect(requestBody).toEqual({ users: "U789GHI", return_im: true });
  });

  it("rejects a direct-message response for a different or unproven user", async () => {
    const wrongUser = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse({
          ok: true,
          channel: { id: "D123ABC", is_im: true, user: "U000BAD" },
        }),
      ),
    });
    const missingUser = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse({ ok: true, channel: { id: "D123ABC", is_im: true } }),
      ),
    });

    await expect(wrongUser.openDirectMessage("U789GHI")).rejects.toMatchObject({
      name: "SlackApiError",
      code: "invalid",
    });
    await expect(
      missingUser.openDirectMessage("U789GHI"),
    ).rejects.toMatchObject({
      name: "SlackApiError",
      code: "invalid",
    });
  });

  it("suppresses link and media unfurls when posting meeting-derived content", async () => {
    let requestBody: unknown;
    const fetchImpl = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({ ok: true, channel: "C123", ts: "1700.100" });
    }) as typeof fetch;
    const client = new SlackWebApiClient("xoxb-test", { fetchImpl });

    await expect(
      client.postMessage({
        channel: "C123",
        text: "https://sensitive.example",
      }),
    ).resolves.toEqual({ channel: "C123", ts: "1700.100" });
    expect(requestBody).toMatchObject({
      channel: "C123",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("binds strict acknowledged blocks to the exact posted Slack message", async () => {
    const blocks = [{ type: "context", block_id: "approval-0" }];
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse({
          ok: true,
          channel: "C123",
          ts: "1700.100000",
          message: { ts: "1700.100000", blocks },
        }),
      ),
    });

    await expect(
      client.postMessage({
        channel: "C123",
        text: "approval",
        blocks,
        strictEvidence: true,
      }),
    ).resolves.toEqual({ channel: "C123", ts: "1700.100000", blocks });
  });

  it.each([
    {
      name: "missing message timestamp",
      body: {
        ok: true,
        channel: "C123",
        ts: "1700.100000",
        message: { blocks: [] },
      },
    },
    {
      name: "mismatched message timestamp",
      body: {
        ok: true,
        channel: "C123",
        ts: "1700.100000",
        message: { ts: "1700.999999", blocks: [] },
      },
    },
    {
      name: "mismatched channel",
      body: {
        ok: true,
        channel: "C999",
        ts: "1700.100000",
        message: { ts: "1700.100000", blocks: [] },
      },
    },
    {
      name: "noncanonical timestamp",
      body: {
        ok: true,
        channel: "C123",
        ts: "1700.100",
        message: { ts: "1700.100", blocks: [] },
      },
    },
    {
      name: "missing acknowledged blocks",
      body: {
        ok: true,
        channel: "C123",
        ts: "1700.100000",
        message: { ts: "1700.100000" },
      },
    },
  ])("rejects strict post evidence with $name", async ({ body }) => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() => jsonResponse(body)),
    });

    await expect(
      client.postMessage({
        channel: "C123",
        text: "approval",
        blocks: [],
        strictEvidence: true,
      }),
    ).rejects.toMatchObject({
      name: "SlackApiError",
      code: "unknown_outcome",
      retryable: true,
    });
  });

  it("binds strict replies to the requested parent thread", async () => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse({
          ok: true,
          messages: [
            { ts: "1700.100000", user: "U111", text: "parent" },
            {
              ts: "1700.200000",
              thread_ts: "1700.100000",
              user: "U222",
              text: "reason",
            },
          ],
        }),
      ),
    });

    await expect(
      client.conversationsReplies("C123", "1700.100000", undefined, {
        strict: true,
      }),
    ).resolves.toEqual([{ user: "U222", text: "reason", ts: "1700.200000" }]);
  });

  it.each([
    {
      name: "missing parent",
      messages: [
        {
          ts: "1700.200000",
          thread_ts: "1700.100000",
          user: "U222",
          text: "reason",
        },
      ],
    },
    {
      name: "wrong reply thread",
      messages: [
        { ts: "1700.100000", user: "U111", text: "parent" },
        {
          ts: "1700.200000",
          thread_ts: "1700.999999",
          user: "U222",
          text: "reason",
        },
      ],
    },
    {
      name: "duplicate reply timestamp",
      messages: [
        { ts: "1700.100000", user: "U111", text: "parent" },
        {
          ts: "1700.200000",
          thread_ts: "1700.100000",
          user: "U222",
          text: "one",
        },
        {
          ts: "1700.200000",
          thread_ts: "1700.100000",
          user: "U333",
          text: "two",
        },
      ],
    },
  ])("rejects strict $name evidence", async ({ messages }) => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() => jsonResponse({ ok: true, messages })),
    });

    await expect(
      client.conversationsReplies("C123", "1700.100000", undefined, {
        strict: true,
      }),
    ).rejects.toMatchObject({
      name: "SlackApiError",
      code: "invalid",
      retryable: false,
    });
  });

  it("retains permissive legacy reply parsing when strict evidence is off", async () => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse({
          ok: true,
          messages: [
            { ts: "1700.100", user: "U111", text: "parent" },
            { ts: "1700.200", user: "legacy-user", text: "reason" },
          ],
        }),
      ),
    });

    await expect(
      client.conversationsReplies("C123", "1700.100"),
    ).resolves.toEqual([
      { user: "legacy-user", text: "reason", ts: "1700.200" },
    ]);
  });

  it("preserves typed authentication and invalid-response errors", async () => {
    const unauthorized = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse({ ok: false, error: "invalid_auth" }),
      ),
    });
    const invalid = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse({ ok: false, error: "channel_not_found" }),
      ),
    });

    await expect(unauthorized.authTest()).rejects.toEqual(
      expect.objectContaining<Partial<SlackApiError>>({
        name: "SlackApiError",
        code: "auth",
        retryable: false,
      }),
    );
    await expect(invalid.authTest()).rejects.toEqual(
      expect.objectContaining<Partial<SlackApiError>>({
        name: "SlackApiError",
        code: "invalid",
        retryable: false,
      }),
    );
  });

  it("keeps malformed reads invalid while treating malformed post responses as unknown", async () => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() => jsonResponse(null)),
    });

    await expect(client.authTest()).rejects.toMatchObject({
      name: "SlackApiError",
      code: "invalid",
      retryable: false,
    });
    await expect(
      client.postMessage({ channel: "C123", text: "approved brief" }),
    ).rejects.toMatchObject({
      name: "SlackApiError",
      code: "unknown_outcome",
      retryable: true,
    });
  });
});
