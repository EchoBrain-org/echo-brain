import { describe, expect, it } from "vitest";
import {
  PrivateSlackApprovalCardPosterV1,
  type PrivateSlackApprovalCardPresentationV1,
} from "../../../src/processing/clean-v1/private-slack-approval-card-poster-v1.js";

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
    const rejected = new PrivateSlackApprovalCardPosterV1("test-token", {
      fetchImpl: async () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
    });
    const input = { approval_id: "apr_123", dm_channel_id: "D123" };

    await expect(ambiguous.postMarker(input)).resolves.toEqual({
      kind: "uncertain",
    });
    await expect(rejected.postMarker(input)).resolves.toEqual({
      kind: "retry_allowed",
    });
  });
});
