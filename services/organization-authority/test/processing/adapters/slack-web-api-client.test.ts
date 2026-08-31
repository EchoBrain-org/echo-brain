import { describe, expect, it } from "vitest";
import { SlackWebApiClient } from "../../../src/processing/adapters/shared/slack/slack-web-api-client.js";

describe("SlackWebApiClient conversations.open", () => {
  it("proves a one-person direct message for the requested user", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> =
      [];
    const client = new SlackWebApiClient("test-token", {
      baseUrl: "https://slack.example.test/api",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            ok: true,
            channel: { id: "D123", is_im: true, user: "U123" },
          }),
          { headers: { "x-oauth-scopes": "chat:write,im:write" } },
        );
      },
    });

    await expect(client.openDirectMessage("U123")).resolves.toEqual({
      channel_id: "D123",
      user_id: "U123",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://slack.example.test/api/conversations.open",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      users: "U123",
      return_im: true,
    });
  });

  it.each([
    ["no scope evidence", undefined],
    ["wrong scope evidence", "chat:write,channels:history"],
  ])("rejects %s for direct-message opening", async (_case, scopes) => {
    const client = new SlackWebApiClient("test-token", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            channel: { id: "D123", is_im: true, user: "U123" },
          }),
          {
            headers:
              scopes === undefined ? undefined : { "x-oauth-scopes": scopes },
          },
        ),
    });

    await expect(client.openDirectMessage("U123")).rejects.toMatchObject({
      code: scopes === undefined ? "invalid" : "auth",
      retryable: false,
    });
  });

  it("rejects a direct-message response for a different user", async () => {
    const client = new SlackWebApiClient("test-token", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            channel: { id: "D123", is_im: true, user: "U456" },
          }),
          { headers: { "x-oauth-scopes": "im:write" } },
        ),
    });

    await expect(client.openDirectMessage("U123")).rejects.toMatchObject({
      code: "invalid",
      message:
        "Slack conversations.open returned a different direct-message user",
      retryable: false,
    });
  });
});

describe("SlackWebApiClient conversations.history recovery", () => {
  it("reads every cursor page and preserves exact bot-authored evidence", async () => {
    const urls: string[] = [];
    const client = new SlackWebApiClient("test-token", {
      baseUrl: "https://slack.example.test/api",
      fetchImpl: async (url) => {
        urls.push(String(url));
        const cursor = new URL(String(url)).searchParams.get("cursor");
        return new Response(
          JSON.stringify(
            cursor === null
              ? {
                  ok: true,
                  has_more: true,
                  messages: [{ ts: "1724292304.005000", text: "first", bot_id: "B123" }],
                  response_metadata: { next_cursor: "next" },
                }
              : {
                  ok: true,
                  has_more: false,
                  messages: [{ ts: "1724292305.005000", text: "second", bot_id: "B123" }],
                  response_metadata: { next_cursor: "" },
                },
          ),
          { headers: { "x-oauth-scopes": "channels:history" } },
        );
      },
    });

    await expect(
      client.channelHistory({
        channel: "C123",
        oldest: "1724292304.000000",
        latest: "1724292904.000000",
      }),
    ).resolves.toEqual([
      { ts: "1724292304.005000", text: "first", bot_id: "B123" },
      { ts: "1724292305.005000", text: "second", bot_id: "B123" },
    ]);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(new URL(url).searchParams.get("oldest")).toBe(
        "1724292304.000000",
      );
      expect(new URL(url).searchParams.get("latest")).toBe(
        "1724292904.000000",
      );
    }
  });

  it("never treats incomplete pagination as proof that no post exists", async () => {
    const client = new SlackWebApiClient("test-token", {
      fetchImpl: async () => new Response(
        JSON.stringify({
          ok: true,
          has_more: true,
          messages: [],
          response_metadata: { next_cursor: "" },
        }),
        { headers: { "x-oauth-scopes": "channels:history" } },
      ),
    });

    await expect(
      client.channelHistory({
        channel: "C123",
        oldest: "1724292304.000000",
        latest: "1724292904.000000",
      }),
    ).rejects.toMatchObject({ code: "invalid", retryable: false });
  });

  it("accepts im:history for direct-message recovery", async () => {
    const client = new SlackWebApiClient("test-token", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            has_more: false,
            messages: [],
            response_metadata: { next_cursor: "" },
          }),
          { headers: { "x-oauth-scopes": "im:history" } },
        ),
    });

    await expect(
      client.channelHistory({
        channel: "D123",
        oldest: "1724292304.000000",
        latest: "1724292904.000000",
      }),
    ).resolves.toEqual([]);
  });

  it("rejects channels:history as insufficient for direct-message recovery", async () => {
    const client = new SlackWebApiClient("test-token", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            has_more: false,
            messages: [],
            response_metadata: { next_cursor: "" },
          }),
          { headers: { "x-oauth-scopes": "channels:history" } },
        ),
    });

    await expect(
      client.channelHistory({
        channel: "D123",
        oldest: "1724292304.000000",
        latest: "1724292904.000000",
      }),
    ).rejects.toMatchObject({
      code: "auth",
      message:
        "Slack conversations.history did not prove the required im:history scope",
      retryable: false,
    });
  });
});

describe("SlackWebApiClient chat.update", () => {
  it("preserves Slack message_not_found as definitive provider evidence", async () => {
    const client = new SlackWebApiClient("test-token", {
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, error: "message_not_found" })),
    });

    await expect(
      client.updateMessage({
        channel: "C123",
        ts: "123.000001",
        text: "Superseded",
      }),
    ).rejects.toMatchObject({
      code: "invalid",
      providerError: "message_not_found",
      retryable: false,
    });
  });

  it("updates one identified message with the same safe presentation defaults", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> =
      [];
    const client = new SlackWebApiClient("test-token", {
      baseUrl: "https://slack.example.test/api",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({ ok: true, channel: "C123", ts: "123.000001" }),
        );
      },
    });

    await expect(
      client.updateMessage({
        channel: "C123",
        ts: "123.000001",
        text: "Superseded",
      }),
    ).resolves.toEqual({ channel: "C123", ts: "123.000001" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://slack.example.test/api/chat.update");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      channel: "C123",
      ts: "123.000001",
      text: "Superseded",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("rejects non-canonical message identities before making a request", async () => {
    const client = new SlackWebApiClient("test-token", {
      fetchImpl: async () => {
        throw new Error("must not call Slack");
      },
    });

    await expect(
      client.updateMessage({
        channel: "not-a-channel",
        ts: "123.000001",
        text: "ignored",
      }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "Slack chat.update requires a canonical conversation ID",
      retryable: false,
    });
    await expect(
      client.updateMessage({ channel: "C123", ts: "not-a-ts", text: "ignored" }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "Slack chat.update requires a canonical message timestamp",
      retryable: false,
    });
  });
});
