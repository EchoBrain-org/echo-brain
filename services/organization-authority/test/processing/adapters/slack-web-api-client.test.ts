import { describe, expect, it } from "vitest";
import { SlackWebApiClient } from "../../../src/processing/adapters/shared/slack/slack-web-api-client.js";

describe("SlackWebApiClient chat.update", () => {
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
