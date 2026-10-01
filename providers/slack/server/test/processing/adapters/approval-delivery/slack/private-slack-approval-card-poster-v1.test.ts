import { describe, expect, it, vi } from "vitest";
import { PrivateSlackApprovalCardPosterV1, type PrivateSlackApprovalCardPresentationV1 } from "../../../../../src/processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.js";

const CARD: PrivateSlackApprovalCardPresentationV1 = Object.freeze({
  text: "Private meeting-owner approval requested.",
  blocks: Object.freeze([
    Object.freeze({
      type: "actions",
      elements: Object.freeze([
        Object.freeze({ type: "button", action_id: "approve" }),
      ]),
    }),
  ]),
  transport: Object.freeze({
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
  }),
});

describe("private Slack approval card poster V1", () => {
  it("opens the exact one-person DM, posts an inert marker, then publishes real blocks", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const poster = new PrivateSlackApprovalCardPosterV1("test-token", {
      baseUrl: "https://slack.example.test/api",
      fetchImpl: async (url, init) => {
        const method = new URL(String(url)).pathname.split("/").at(-1)!;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ method, body });
        if (method === "conversations.open") {
          return new Response(
            JSON.stringify({
              ok: true,
              channel: { id: "D123", is_im: true, user: "U123" },
            }),
            { headers: { "x-oauth-scopes": "im:write" } },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, channel: "D123", ts: "123.000001" }),
        );
      },
    });

    await expect(poster.openDirectMessage("U123")).resolves.toEqual({
      kind: "opened",
      channel_id: "D123",
      user_id: "U123",
    });
    await expect(
      poster.postMarker({ approval_id: "apr_123", dm_channel_id: "D123" }),
    ).resolves.toEqual({ kind: "posted", provider_message_ts: "123.000001" });
    await expect(
      poster.publish({
        approval_id: "apr_123",
        dm_channel_id: "D123",
        provider_message_ts: "123.000001",
        card: CARD,
      }),
    ).resolves.toEqual({ kind: "done" });

    expect(requests).toEqual([
      {
        method: "conversations.open",
        body: { users: "U123", return_im: true },
      },
      {
        method: "chat.postMessage",
        body: {
          channel: "D123",
          text: [
            "Preparing your private ECHO approval",
            "This delivery marker is not actionable.",
            "",
            "[private-approval:apr_123]",
          ].join("\n"),
          unfurl_links: false,
          unfurl_media: false,
          mrkdwn: false,
          blocks: [],
        },
      },
      {
        method: "chat.update",
        body: {
          channel: "D123",
          ts: "123.000001",
          text:
            "Private meeting-owner approval requested.\n\n[private-approval:apr_123]",
          unfurl_links: false,
          unfurl_media: false,
          mrkdwn: false,
          blocks: CARD.blocks,
        },
      },
    ]);
  });

  it("rejects every shared-channel write before calling Slack", async () => {
    let providerCalls = 0;
    const poster = new PrivateSlackApprovalCardPosterV1("test-token", {
      baseUrl: "https://slack.example.test/api",
      fetchImpl: async () => {
        providerCalls += 1;
        return new Response(JSON.stringify({ ok: true }));
      },
    });
    const sharedChannel = "C123";
    const error = "private Slack approval requires a direct-message channel";

    await expect(
      poster.postMarker({ approval_id: "apr_123", dm_channel_id: sharedChannel }),
    ).rejects.toThrow(error);
    await expect(
      poster.reconcileMarker({
        approval_id: "apr_123",
        dm_channel_id: sharedChannel,
        post_started_at: "2026-08-28T00:00:00.000Z",
        reconciliation_started_at: "2026-08-28T00:01:00.000Z",
      }),
    ).rejects.toThrow(error);
    await expect(
      poster.publish({
        approval_id: "apr_123",
        dm_channel_id: sharedChannel,
        provider_message_ts: "123.000001",
        card: CARD,
      }),
    ).rejects.toThrow(error);
    await expect(
      poster.renderTerminal({
        approval_id: "apr_123",
        dm_channel_id: sharedChannel,
        provider_message_ts: "123.000001",
        outcome: "approved",
        policy_label: "Only me",
      }),
    ).rejects.toThrow(error);
    await expect(
      poster.tombstone({
        approval_id: "apr_123",
        successor_id: "cnd_456",
        dm_channel_id: sharedChannel,
        provider_message_ts: "123.000001",
      }),
    ).rejects.toThrow(error);
    expect(providerCalls).toBe(0);
  });

  it("recovers the earliest exact DM marker and makes duplicates inert", async () => {
    const updates: Record<string, unknown>[] = [];
    const poster = new PrivateSlackApprovalCardPosterV1("test-token", {
      baseUrl: "https://slack.example.test/api",
      fetchImpl: async (url, init) => {
        const method = new URL(String(url)).pathname.split("/").at(-1);
        if (method === "auth.test") {
          return new Response(
            JSON.stringify({
              ok: true,
              team_id: "T123",
              enterprise_id: null,
              user_id: "U999",
              bot_id: "B123",
              app_id: "A123",
            }),
            { headers: { "x-oauth-scopes": "users:read" } },
          );
        }
        if (method === "bots.info") {
          return new Response(
            JSON.stringify({
              ok: true,
              bot: {
                id: "B123",
                user_id: "U999",
                app_id: "A123",
                deleted: false,
              },
            }),
          );
        }
        if (method === "conversations.history") {
          return new Response(
            JSON.stringify({
              ok: true,
              has_more: false,
              messages: [
                {
                  ts: "1724292304.006000",
                  text: "later\n[private-approval:apr_123]",
                  bot_id: "B123",
                },
                {
                  ts: "1724292303.999999",
                  text: "first\n[private-approval:apr_123]",
                  bot_id: "B123",
                },
              ],
              response_metadata: { next_cursor: "" },
            }),
            { headers: { "x-oauth-scopes": "im:history" } },
          );
        }
        updates.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ ok: true, channel: "D123", ts: "1724292304.006000" }),
        );
      },
    });

    await expect(
      poster.reconcileMarker({
        approval_id: "apr_123",
        dm_channel_id: "D123",
        post_started_at: "2024-08-22T02:05:04.000Z",
        reconciliation_started_at: "2024-08-22T02:05:05.000Z",
      }),
    ).resolves.toEqual({
      kind: "posted",
      provider_message_ts: "1724292303.999999",
    });
    expect(updates).toEqual([
      expect.objectContaining({
        channel: "D123",
        ts: "1724292304.006000",
        blocks: [],
        text: expect.stringContaining("Duplicate private approval card"),
      }),
    ]);
  });

  it("removes every interactive block only after a consistent terminal outcome", async () => {
    const bodies: Record<string, unknown>[] = [];
    const poster = new PrivateSlackApprovalCardPosterV1("test-token", {
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ ok: true, channel: "D123", ts: "123.000001" }),
        );
      },
    });

    await expect(
      poster.renderTerminal({
        approval_id: "apr_123",
        dm_channel_id: "D123",
        provider_message_ts: "123.000001",
        outcome: "approved",
        policy_label: "Only me",
      }),
    ).resolves.toEqual({ kind: "done" });
    expect(bodies[0]).toEqual({
      channel: "D123",
      ts: "123.000001",
      text: "Approved\nVisibility: Only me\n\n[private-approval:apr_123]",
      blocks: [],
      unfurl_links: false,
      unfurl_media: false,
      mrkdwn: false,
    });
    await expect(
      poster.tombstone({
        approval_id: "apr_123",
        successor_id: "cnd_456",
        dm_channel_id: "D123",
        provider_message_ts: "123.000001",
      }),
    ).resolves.toEqual({ kind: "done" });
    expect(bodies[1]).toEqual({
      channel: "D123",
      ts: "123.000001",
      text: "Superseded\nA newer meeting revision replaced this private review. This card can no longer be used.\n\n[private-approval:apr_123]\n[superseded-by:cnd_456]",
      blocks: [],
      unfurl_links: false,
      unfurl_media: false,
      mrkdwn: false,
    });
    await expect(
      poster.renderTerminal({
        approval_id: "apr_123",
        dm_channel_id: "D123",
        provider_message_ts: "123.000001",
        outcome: "rejected",
        policy_label: "Team",
      }),
    ).rejects.toThrow("terminal presentation is inconsistent");
  });

  it("keeps transport ambiguity distinct from a definitive retryable rejection", async () => {
    const ambiguous = new PrivateSlackApprovalCardPosterV1("test-token", {
      fetchImpl: async () => {
        throw new Error("connection closed");
      },
    });
    let now = 10_000;
    let postRequests = 0;
    const rejected = new PrivateSlackApprovalCardPosterV1("test-token", {
      now: () => now,
      fetchImpl: async () =>
        (postRequests += 1) === 1
          ? new Response("", {
              status: 429,
              headers: { "retry-after": "2" },
            })
          : new Response(
              JSON.stringify({ ok: true, channel: "D123", ts: "123.000001" }),
            ),
    });
    const input = { approval_id: "apr_123", dm_channel_id: "D123" };

    await expect(ambiguous.postMarker(input)).resolves.toEqual({
      kind: "uncertain",
    });
    await expect(rejected.postMarker(input)).resolves.toEqual({
      kind: "retry_allowed",
    });
    await expect(rejected.postMarker(input)).resolves.toEqual({
      kind: "retry_allowed",
    });
    expect(postRequests).toBe(1);
    now += 2_000;
    await expect(rejected.postMarker(input)).resolves.toEqual({
      kind: "posted",
      provider_message_ts: "123.000001",
    });
    expect(postRequests).toBe(2);
  });

  it("resolves a function token for every Slack call", async () => {
    const tokens = ["xoxb-first", "xoxb-second"];
    const authorizations: string[] = [];
    const poster = new PrivateSlackApprovalCardPosterV1(async () => tokens.shift()!, {
      fetchImpl: async (_url, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization")!);
        return new Response(JSON.stringify({ ok: true, channel: "D123", ts: "123.000001" }));
      },
    });
    const input = { approval_id: "apr_123", dm_channel_id: "D123" };

    await expect(poster.postMarker(input)).resolves.toMatchObject({ kind: "posted" });
    await expect(poster.postMarker(input)).resolves.toMatchObject({ kind: "posted" });
    expect(authorizations).toEqual(["Bearer xoxb-first", "Bearer xoxb-second"]);
  });

  it("retries a Slack auth failure once with a refreshed token, then reports it", async () => {
    const authorizations: string[] = [];
    const onAuthFailure = vi.fn();
    const rejectingSlack = async (_url: unknown, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization")!);
      return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }));
    };
    const refreshing = new PrivateSlackApprovalCardPosterV1(
      async (options?: { force_refresh?: boolean }) =>
        options?.force_refresh === true ? "xoxb-refreshed" : "xoxb-cached",
      { fetchImpl: rejectingSlack, on_auth_failure: onAuthFailure },
    );
    const input = { approval_id: "apr_123", dm_channel_id: "D123" };

    await expect(refreshing.postMarker(input)).resolves.toEqual({ kind: "retry_allowed" });
    expect(authorizations).toEqual(["Bearer xoxb-cached", "Bearer xoxb-refreshed"]);
    expect(onAuthFailure).toHaveBeenCalledOnce();
    expect(onAuthFailure.mock.calls[0]?.[0]).toMatchObject({ name: "SlackApiError", code: "auth" });

    authorizations.length = 0;
    const fixed = new PrivateSlackApprovalCardPosterV1("xoxb-fixed", {
      fetchImpl: rejectingSlack,
      on_auth_failure: onAuthFailure,
    });
    await expect(fixed.postMarker(input)).resolves.toEqual({ kind: "retry_allowed" });
    expect(authorizations).toEqual(["Bearer xoxb-fixed"]);
    expect(onAuthFailure).toHaveBeenCalledTimes(2);
  });

  it("answers each step's retry outcome without calling Slack when no bot token can be obtained", async () => {
    const requests: string[] = [];
    const poster = new PrivateSlackApprovalCardPosterV1(async () => { throw new Error("Nango is unavailable"); }, {
      fetchImpl: async (url) => { requests.push(String(url)); return new Response(JSON.stringify({ ok: true })); },
    });
    const card = { approval_id: "apr_123", dm_channel_id: "D123", provider_message_ts: "123.000001" };
    await expect(poster.openDirectMessage("U123")).resolves.toEqual({ kind: "retry_allowed" });
    await expect(poster.postMarker({ approval_id: "apr_123", dm_channel_id: "D123" })).resolves.toEqual({ kind: "retry_allowed" });
    // Past its window, but never `retry_allowed`: that would mean no marker exists and a repost is safe.
    await expect(poster.reconcileMarker({
      approval_id: "apr_123", dm_channel_id: "D123",
      post_started_at: "2026-08-28T00:00:00.000Z", reconciliation_started_at: "2026-08-28T00:20:00.000Z",
    })).resolves.toEqual({ kind: "uncertain" });
    await expect(poster.publish({ ...card, card: CARD })).resolves.toEqual({ kind: "uncertain" });
    await expect(poster.renderTerminal({ ...card, outcome: "rejected", policy_label: null })).resolves.toEqual({ kind: "uncertain" });
    await expect(poster.tombstone({ ...card, successor_id: "cnd_456" })).resolves.toEqual({ kind: "uncertain" });
    expect(requests).toEqual([]);
  });

  it("keeps a marker reconciliation uncertain when the bot token fails after Slack answered", async () => {
    const requests: string[] = [];
    let tokens = 0;
    const poster = new PrivateSlackApprovalCardPosterV1(async () => {
      if ((tokens += 1) > 2) throw new Error("Nango is unavailable");
      return "test-token";
    }, {
      fetchImpl: async (url) => {
        const method = new URL(String(url)).pathname.split("/").at(-1)!;
        requests.push(method);
        if (method === "auth.test") {
          return new Response(JSON.stringify({ ok: true, team_id: "T123", enterprise_id: null, user_id: "U999", bot_id: "B123", app_id: "A123" }),
            { headers: { "x-oauth-scopes": "users:read" } });
        }
        if (method === "bots.info") {
          return new Response(JSON.stringify({ ok: true, bot: { id: "B123", user_id: "U999", app_id: "A123", deleted: false } }));
        }
        return new Response(JSON.stringify({
          ok: true, has_more: false, response_metadata: { next_cursor: "" },
          messages: [
            { ts: "1724292304.006000", text: "later\n[private-approval:apr_123]", bot_id: "B123" },
            { ts: "1724292303.999999", text: "first\n[private-approval:apr_123]", bot_id: "B123" },
          ],
        }), { headers: { "x-oauth-scopes": "im:history" } });
      },
    });

    // The duplicate is still live, so the earliest marker is not yet the card.
    await expect(poster.reconcileMarker({
      approval_id: "apr_123", dm_channel_id: "D123",
      post_started_at: "2024-08-22T02:05:04.000Z", reconciliation_started_at: "2024-08-22T02:05:05.000Z",
    })).resolves.toEqual({ kind: "uncertain" });
    expect(requests).toEqual(["auth.test", "bots.info", "conversations.history"]);
  });

  it("honors Retry-After before retrying a direct-message open", async () => {
    let now = 10_000;
    let requests = 0;
    const poster = new PrivateSlackApprovalCardPosterV1("test-token", {
      now: () => now,
      fetchImpl: async () =>
        (requests += 1) === 1
          ? new Response("", {
              status: 429,
              headers: { "retry-after": "2" },
            })
          : new Response(
              JSON.stringify({
                ok: true,
                channel: { id: "D123", is_im: true, user: "U123" },
              }),
              { headers: { "x-oauth-scopes": "im:write" } },
            ),
    });

    await expect(poster.openDirectMessage("U123")).resolves.toEqual({
      kind: "retry_allowed",
    });
    await expect(poster.openDirectMessage("U123")).resolves.toEqual({
      kind: "retry_allowed",
    });
    expect(requests).toBe(1);
    now += 2_000;
    await expect(poster.openDirectMessage("U123")).resolves.toEqual({
      kind: "opened",
      channel_id: "D123",
      user_id: "U123",
    });
    expect(requests).toBe(2);
  });
});
