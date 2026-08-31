import { describe, expect, it, vi } from "vitest";
import {
  SlackWebIdentityProviderV1,
} from "../src/adapters/slack/slack-web-identity-provider-v1.js";

const TOKEN = "xoxb-test-token-12345678";
const CONNECTION = {
  ok: true,
  team_id: "T123TEAM",
  enterprise_id: null,
  user_id: "U123BOT",
  bot_id: "B123BOT",
  app_id: "A123APP",
} as const;
const BOT = {
  id: CONNECTION.bot_id,
  user_id: CONNECTION.user_id,
  app_id: CONNECTION.app_id,
  deleted: false,
} as const;
const CHANNEL = {
  id: "C123CHANNEL",
  context_team_id: CONNECTION.team_id,
  is_channel: true,
  is_private: false,
  is_im: false,
  is_mpim: false,
  is_archived: false,
  is_member: true,
  is_ext_shared: false,
  is_pending_ext_shared: false,
} as const;
const CHALLENGE = {
  expected_team_id: CONNECTION.team_id,
  expected_enterprise_id: CONNECTION.enterprise_id,
  expected_bot_user_id: CONNECTION.user_id,
  expected_bot_id: CONNECTION.bot_id,
  expected_app_id: CONNECTION.app_id,
  challenge_attempt_id: "cat_12345678-1234-4123-8123-123456789abc",
  channel_id: CHANNEL.id,
  issued_at: "2025-07-29T20:59:00.000Z",
  expires_at: "2025-07-29T21:04:00.000Z",
} as const;
const CHALLENGE_MESSAGE_TS = "1753822800.000001";
const CHALLENGE_CODE = "A".repeat(43);
const CHALLENGE_TEXT =
  "Echo account connection requested. Reply in this thread with the " +
  `code shown by Echo before ${CHALLENGE.expires_at}.`;
const CHALLENGE_MARKER =
  `echo-identity-link:${CHALLENGE.challenge_attempt_id}:` +
  CHALLENGE.expires_at;
const OBSERVATION = {
  ...CHALLENGE,
  challenge_message_ts: CHALLENGE_MESSAGE_TS,
  challenge_code: CHALLENGE_CODE,
} as const;

function slackResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-oauth-scopes": "chat:write,users:read",
    },
  });
}

function slackFetch(...values: readonly unknown[]) {
  let index = 0;
  return vi.fn<typeof globalThis.fetch>(async () => {
    const value = values[index++];
    if (value === undefined) throw new Error("Unexpected Slack test request");
    return slackResponse(value);
  });
}

function challengeParent() {
  return {
    type: "message",
    user: CONNECTION.user_id,
    bot_id: CONNECTION.bot_id,
    app_id: CONNECTION.app_id,
    ts: CHALLENGE_MESSAGE_TS,
    text: CHALLENGE_TEXT,
    blocks: [
      {
        type: "section",
        block_id: CHALLENGE_MARKER,
        text: { type: "mrkdwn", text: CHALLENGE_TEXT },
      },
    ],
  };
}

function challengeReply(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    type: "message",
    user: "U123HUMAN",
    text: CHALLENGE_CODE,
    ts: "1753822860.000002",
    thread_ts: CHALLENGE_MESSAGE_TS,
    ...overrides,
  };
}

function observedThread(...replies: readonly Record<string, unknown>[]) {
  return {
    ok: true,
    messages: [challengeParent(), ...replies],
    has_more: false,
    response_metadata: { next_cursor: "" },
  };
}

function observedHuman() {
  return {
    ok: true,
    user: {
      id: "U123HUMAN",
      team_id: CONNECTION.team_id,
      deleted: false,
      is_bot: false,
      is_app_user: false,
    },
  };
}

describe("SlackWebIdentityProviderV1", () => {
  it("verifies a connected bot and public organization channel", async () => {
    const provider = new SlackWebIdentityProviderV1({
      fetch: slackFetch(CONNECTION, { ok: true, bot: BOT }, { ok: true, channel: CHANNEL }),
    });

    await expect(provider.verifyConnection(TOKEN)).resolves.toMatchObject({
      team_id: CONNECTION.team_id,
      bot_user_id: CONNECTION.user_id,
      bot_id: CONNECTION.bot_id,
      app_id: CONNECTION.app_id,
      granted_scopes: ["chat:write", "users:read"],
    });
    await expect(
      provider.verifyChannel(TOKEN, CHANNEL.id, CONNECTION.team_id),
    ).resolves.toMatchObject({
      channel_id: CHANNEL.id,
      team_id: CONNECTION.team_id,
      is_public_organization_channel: true,
      is_active: true,
      bot_membership_verified: true,
    });
  });

  it("posts a code-free challenge bound to its attempt marker", async () => {
    const fetch = slackFetch(
      CONNECTION,
      { ok: true, bot: BOT },
      {
        ok: true,
        channel: CHANNEL.id,
        ts: CHALLENGE_MESSAGE_TS,
        message: challengeParent(),
      },
    );
    const provider = new SlackWebIdentityProviderV1({ fetch });

    await expect(
      provider.postIdentityLinkChallenge(TOKEN, CHALLENGE),
    ).resolves.toMatchObject({
      team_id: CONNECTION.team_id,
      channel_id: CHANNEL.id,
      challenge_message_ts: CHALLENGE_MESSAGE_TS,
    });
    const body = fetch.mock.calls[2]?.[1]?.body as URLSearchParams;
    expect(body.get("blocks")).toBe(
      JSON.stringify([
        {
          type: "section",
          block_id: CHALLENGE_MARKER,
          text: { type: "mrkdwn", text: CHALLENGE_TEXT },
        },
      ]),
    );
    expect(String(body)).not.toContain(CHALLENGE_CODE);
  });

  it("observes exactly one human reply in the bound challenge thread", async () => {
    const provider = new SlackWebIdentityProviderV1({
      fetch: slackFetch(
        CONNECTION,
        { ok: true, bot: BOT },
        observedThread(challengeReply()),
        observedHuman(),
      ),
    });

    await expect(
      provider.observeIdentityLinkChallenge(TOKEN, OBSERVATION),
    ).resolves.toMatchObject({
      team_id: CONNECTION.team_id,
      user_id: "U123HUMAN",
      channel_id: CHANNEL.id,
      challenge_message_ts: CHALLENGE_MESSAGE_TS,
      reply_message_ts: "1753822860.000002",
      verification_evidence_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it.each([
    ["a wrong reply", observedThread(challengeReply({ text: "not-the-code" }))],
    [
      "ambiguous replies",
      observedThread(
        challengeReply(),
        challengeReply({ user: "U456OTHER", ts: "1753822861.000003" }),
      ),
    ],
  ])("rejects %s", async (_label, thread) => {
    const provider = new SlackWebIdentityProviderV1({
      fetch: slackFetch(CONNECTION, { ok: true, bot: BOT }, thread),
    });

    await expect(
      provider.observeIdentityLinkChallenge(TOKEN, OBSERVATION),
    ).rejects.toMatchObject({ code: "not_observed" });
  });

  it("rejects a challenge when its expected connection has changed", async () => {
    const provider = new SlackWebIdentityProviderV1({
      fetch: slackFetch(
        { ...CONNECTION, team_id: "T999OTHER" },
        { ok: true, bot: BOT },
      ),
    });

    await expect(
      provider.observeIdentityLinkChallenge(TOKEN, OBSERVATION),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});
