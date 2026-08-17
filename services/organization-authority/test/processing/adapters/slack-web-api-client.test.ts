import { describe, expect, it } from "vitest";
import {
  SlackApiError,
  SlackWebApiClient,
} from "../../../src/processing/adapters/approval-surfaces/slack-reactions/slack-web-api-client.js";

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

  it("cancels an oversized streamed Slack response before buffering it all", async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(300 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(
        () =>
          new Response(oversized, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    await expect(client.authTest()).rejects.toMatchObject({
      name: "SlackApiError",
      code: "invalid",
      retryable: false,
    });
    expect(cancelled).toBe(true);
  });

  it("treats an oversized post response as an unknown outcome", async () => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(
        () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(600 * 1024) },
          }),
      ),
    });

    await expect(
      client.postMessage({ channel: "C123", text: "approval request" }),
    ).rejects.toMatchObject({
      name: "SlackApiError",
      code: "unknown_outcome",
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

  it("resolves one canonical app identity without changing authTest health behavior", async () => {
    const authResponse = {
      ok: true,
      team_id: "T123ABC",
      enterprise_id: "E456DEF",
      user_id: "U789GHI",
      bot_id: "B123ABC",
    };
    const methods: string[] = [];
    const requests: Array<{
      method: string;
      httpMethod: string | undefined;
      body: BodyInit | null | undefined;
      contentType: string | null;
    }> = [];
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        const method = url.pathname.split("/").pop() ?? "";
        methods.push(method);
        requests.push({
          method,
          httpMethod: init?.method,
          body: init?.body,
          contentType: new Headers(init?.headers).get("content-type"),
        });
        if (method === "bots.info") {
          expect(url.searchParams.get("bot")).toBe("B123ABC");
        }
        return method === "auth.test"
          ? jsonResponse(authResponse, {
              headers: { "x-oauth-scopes": "chat:write, users:read" },
            })
          : jsonResponse({
              ok: true,
              bot: {
                id: "B123ABC",
                user_id: "U789GHI",
                app_id: "A456DEF",
                deleted: false,
              },
            });
      }) as typeof fetch,
    });

    await expect(client.authTest()).resolves.toEqual({ user_id: "U789GHI" });
    await expect(client.authIdentity()).resolves.toEqual({
      team_id: "T123ABC",
      enterprise_id: "E456DEF",
      user_id: "U789GHI",
      bot_id: "B123ABC",
      app_id: "A456DEF",
    });
    expect(methods).toEqual(["auth.test", "auth.test", "bots.info"]);
    expect(requests.slice(0, 2)).toEqual([
      {
        method: "auth.test",
        httpMethod: "POST",
        body: "{}",
        contentType: "application/json; charset=utf-8",
      },
      {
        method: "auth.test",
        httpMethod: "POST",
        body: "{}",
        contentType: "application/json; charset=utf-8",
      },
    ]);
    expect(requests.at(-1)).toEqual({
      method: "bots.info",
      httpMethod: "GET",
      body: undefined,
      contentType: null,
    });
  });

  it.each([
    { team_id: undefined, user_id: "U789GHI", bot_id: "B123ABC" },
    { team_id: "not-a-team", user_id: "U789GHI", bot_id: "B123ABC" },
    { team_id: "T123ABC", user_id: undefined, bot_id: "B123ABC" },
    { team_id: "T123ABC", user_id: "not-a-user", bot_id: "B123ABC" },
    { team_id: "T123ABC", user_id: "U789GHI", bot_id: undefined },
    { team_id: "T123ABC", user_id: "U789GHI", bot_id: "not-a-bot" },
    {
      team_id: "T123ABC",
      user_id: "U789GHI",
      bot_id: "B123ABC",
      enterprise_id: "bad",
    },
    {
      team_id: "T123ABC",
      user_id: "U789GHI",
      bot_id: "B123ABC",
      app_id: "not-an-app",
    },
  ])("rejects malformed auth.test identity fields: %o", async (fields) => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse(
          { ok: true, ...fields },
          { headers: { "x-oauth-scopes": "users:read" } },
        ),
      ),
    });

    await expect(client.authIdentity()).rejects.toMatchObject({
      name: "SlackApiError",
      code: "invalid",
      retryable: false,
    });
  });

  it.each([
    { label: "missing", scopes: undefined, code: "invalid" },
    { label: "malformed", scopes: "users:read, BAD SCOPE", code: "invalid" },
    { label: "insufficient", scopes: "chat:write", code: "auth" },
  ])("rejects $label OAuth scope evidence before bots.info", async ({ scopes, code }) => {
    const methods: string[] = [];
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: (async (input) => {
        methods.push(String(input).split("/").pop() ?? "");
        return jsonResponse(
          {
            ok: true,
            team_id: "T123ABC",
            user_id: "U789GHI",
            bot_id: "B123ABC",
          },
          {
            headers:
              scopes === undefined ? undefined : { "x-oauth-scopes": scopes },
          },
        );
      }) as typeof fetch,
    });

    await expect(client.authIdentity()).rejects.toMatchObject({
      name: "SlackApiError",
      code,
      retryable: false,
    });
    expect(methods).toEqual(["auth.test"]);
  });

  it("rejects an auth.test app ID that conflicts with bots.info", async () => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: (async (input) =>
        String(input).endsWith("/auth.test")
          ? jsonResponse(
              {
                ok: true,
                team_id: "T123ABC",
                user_id: "U789GHI",
                bot_id: "B123ABC",
                app_id: "A999OTHER",
              },
              { headers: { "x-oauth-scopes": "users:read" } },
            )
          : jsonResponse({
              ok: true,
              bot: {
                id: "B123ABC",
                user_id: "U789GHI",
                app_id: "A456DEF",
                deleted: false,
              },
            })) as typeof fetch,
    });

    await expect(client.authIdentity()).rejects.toMatchObject({
      name: "SlackApiError",
      code: "auth",
      retryable: false,
    });
  });

  it.each([
    {
      label: "missing bot object",
      body: { ok: true },
      code: "invalid",
    },
    {
      label: "missing app ID",
      body: {
        ok: true,
        bot: { id: "B123ABC", user_id: "U789GHI", deleted: false },
      },
      code: "invalid",
    },
    {
      label: "malformed app ID",
      body: {
        ok: true,
        bot: {
          id: "B123ABC",
          user_id: "U789GHI",
          app_id: "not-an-app",
          deleted: false,
        },
      },
      code: "invalid",
    },
    {
      label: "different bot ID",
      body: {
        ok: true,
        bot: {
          id: "B999OTHER",
          user_id: "U789GHI",
          app_id: "A456DEF",
          deleted: false,
        },
      },
      code: "auth",
    },
    {
      label: "different bot user ID",
      body: {
        ok: true,
        bot: {
          id: "B123ABC",
          user_id: "U999OTHER",
          app_id: "A456DEF",
          deleted: false,
        },
      },
      code: "auth",
    },
    {
      label: "deleted bot",
      body: {
        ok: true,
        bot: {
          id: "B123ABC",
          user_id: "U789GHI",
          app_id: "A456DEF",
          deleted: true,
        },
      },
      code: "auth",
    },
    {
      label: "missing deletion state",
      body: {
        ok: true,
        bot: {
          id: "B123ABC",
          user_id: "U789GHI",
          app_id: "A456DEF",
        },
      },
      code: "invalid",
    },
  ])("rejects bots.info with $label", async ({ body, code }) => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: (async (input) =>
        String(input).endsWith("/auth.test")
          ? jsonResponse(
              {
                ok: true,
                team_id: "T123ABC",
                user_id: "U789GHI",
                bot_id: "B123ABC",
              },
              { headers: { "x-oauth-scopes": "users:read" } },
            )
          : jsonResponse(body)) as typeof fetch,
    });

    await expect(client.authIdentity()).rejects.toMatchObject({
      name: "SlackApiError",
      code,
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
      return jsonResponse({ ok: true, channel: "C123", ts: "1700.100000" });
    }) as typeof fetch;
    const client = new SlackWebApiClient("xoxb-test", { fetchImpl });

    await expect(
      client.postMessage({
        channel: "C123",
        text: "https://sensitive.example",
      }),
    ).resolves.toEqual({ channel: "C123", ts: "1700.100000" });
    expect(requestBody).toMatchObject({
      channel: "C123",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("binds every post only to the exact top-level Slack message identity", async () => {
    const blocks = [{ type: "context", block_id: "approval-0" }];
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse({
          ok: true,
          channel: "C123",
          ts: "1700.100000",
          message: { ts: "1700.100000", text: "approval", blocks },
        }),
      ),
    });

    await expect(
      client.postMessage({
        channel: "C123",
        text: "approval",
        blocks,
      }),
    ).resolves.toEqual({ channel: "C123", ts: "1700.100000" });
  });

  it.each([
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
      name: "unbounded timestamp seconds",
      body: {
        ok: true,
        channel: "C123",
        ts: "12345678901234567.100000",
      },
    },
  ])("rejects post identity with $name", async ({ body }) => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() => jsonResponse(body)),
    });

    await expect(
      client.postMessage({
        channel: "C123",
        text: "approval",
        blocks: [],
      }),
    ).rejects.toMatchObject({
      name: "SlackApiError",
      code: "unknown_outcome",
      retryable: true,
    });
  });

  it("reads the exact unedited stored card through reactions.get", async () => {
    const blocks = [{ type: "context", block_id: "approval-0" }];
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() =>
        jsonResponse({
          ok: true,
          message: {
            ts: "1700.100000",
            text: "first line\nsecond line",
            blocks,
          },
        }),
      ),
    });

    await expect(client.readMessage("C123", "1700.100000")).resolves.toEqual({
      ts: "1700.100000",
      text: "first line\nsecond line",
      blocks,
    });
  });

  it.each([
    {
      name: "edited",
      message: {
        ts: "1700.100000",
        text: "card",
        blocks: [],
        edited: { ts: "1700.200000" },
      },
    },
    {
      name: "wrong timestamp",
      message: { ts: "1700.999999", text: "card", blocks: [] },
    },
    { name: "missing blocks", message: { ts: "1700.100000", text: "card" } },
  ])("refuses $name strict stored-card evidence", async ({ message }) => {
    const client = new SlackWebApiClient("xoxb-test", {
      fetchImpl: fetchReturning(() => jsonResponse({ ok: true, message })),
    });

    await expect(
      client.readMessage("C123", "1700.100000"),
    ).rejects.toMatchObject({
      name: "SlackApiError",
      code: "invalid",
      retryable: false,
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
