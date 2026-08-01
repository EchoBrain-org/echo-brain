import { describe, expect, it } from "vitest";
import type {
  SlackAuthIdentity,
  SlackDirectMessage,
  SlackPostMessageInput,
  SlackPostedMessage,
  SlackReaction,
} from "../../../src/adapters/shared/slack/slack-web-api-client.js";
import { canonicalSha256 } from "../../../src/product/federation/foundation/canonical-json.js";
import { captureSlackProviderIdentity } from "../../../src/product/federation/identity/slack-provider-identity.js";
import {
  issueSlackDmChallenge,
  pollSlackDmChallenge,
  type SlackDmChallengeApi,
} from "../../../src/product/federation/bootstrap/slack-dm-challenge.js";

const ISSUED_AT = "2026-07-19T20:00:00.000Z";
const EXPIRES_AT = "2026-07-19T20:05:00.000Z";
const OBSERVED_AT = "2026-07-19T20:00:02.000Z";
const FOUNDER_ACTOR = {
  provider: "slack",
  team_id: "T123ABC",
  user_id: "U555CEO",
} as const;

async function providerIdentity() {
  return captureSlackProviderIdentity(
    {
      authIdentity: async () => ({
        team_id: "T123ABC",
        enterprise_id: "E456DEF",
        user_id: "U111BOT",
        bot_id: "B222BOT",
        app_id: null,
      }),
    },
    ISSUED_AT,
  );
}

function issueChallenge(
  api: SlackDmChallengeApi,
  provider: Awaited<ReturnType<typeof providerIdentity>>,
  actor: {
    provider: "slack";
    team_id: string;
    user_id: string;
  } = FOUNDER_ACTOR,
) {
  return issueSlackDmChallenge(api, provider, actor, {
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    nonceFactory: () => Buffer.alloc(32, 7),
  });
}

class FakeChallengeApi implements SlackDmChallengeApi {
  authIdentityResult: SlackAuthIdentity = {
    team_id: "T123ABC",
    enterprise_id: "E456DEF",
    user_id: "U111BOT",
    bot_id: "B222BOT",
    app_id: null,
  };
  authIdentityCalls = 0;
  readonly openedUsers: string[] = [];
  readonly posted: SlackPostMessageInput[] = [];
  readonly reactionReads: Array<{ channel: string; timestamp: string }> = [];
  reactionPages: Array<readonly SlackReaction[]> = [];

  async authIdentity(): Promise<SlackAuthIdentity> {
    this.authIdentityCalls += 1;
    return this.authIdentityResult;
  }

  async openDirectMessage(userId: string): Promise<SlackDirectMessage> {
    this.openedUsers.push(userId);
    return { channel_id: "D333DM", user_id: userId };
  }

  async postMessage(input: SlackPostMessageInput): Promise<SlackPostedMessage> {
    this.posted.push(input);
    return { channel: String(input.channel), ts: "1721420000.123456" };
  }

  async reactionsGet(
    channel: string,
    timestamp: string,
  ): Promise<readonly SlackReaction[]> {
    this.reactionReads.push({ channel, timestamp });
    return this.reactionPages.shift() ?? [];
  }
}

describe("Slack founder provider identity", () => {
  it("maps strict auth.test IDs into the registry shape and hashes only normalized evidence", async () => {
    const captured = await providerIdentity();

    expect(captured.snapshot).toEqual({
      provider: "slack",
      team_id: "T123ABC",
      enterprise_id: "E456DEF",
      bot_user_id: "U111BOT",
      bot_id: "B222BOT",
      app_id: null,
    });
    expect(captured.provider_identity).toEqual({
      tenant: {
        kind: "slack-team",
        id: "T123ABC",
        enterprise_id: "E456DEF",
      },
      subject: {
        kind: "bot-installation",
        id: "U111BOT",
        bot_id: "B222BOT",
        app_id: null,
      },
      verification: {
        method: "slack_auth_test",
        assurance: "provider_verified",
        verified_at: ISSUED_AT,
        evidence_sha256: captured.evidence_sha256,
      },
    });
    expect(captured.evidence_sha256).toBe(
      canonicalSha256(captured.evidence_input),
    );
    expect(JSON.stringify(captured)).not.toMatch(/xoxb|token|workspace name/i);
  });

  it("records the clock after auth.test succeeds", async () => {
    let clock = ISSUED_AT;
    const captured = await captureSlackProviderIdentity(
      {
        authIdentity: async () => {
          clock = OBSERVED_AT;
          return {
            team_id: "T123ABC",
            enterprise_id: null,
            user_id: "U111BOT",
            bot_id: "B222BOT",
            app_id: null,
          };
        },
      },
      () => clock,
    );

    expect(captured.provider_identity.verification.verified_at).toBe(
      OBSERVED_AT,
    );
  });

  it("does not label a user-token auth.test response as a bot installation", async () => {
    await expect(
      captureSlackProviderIdentity(
        {
          authIdentity: async () => ({
            team_id: "T123ABC",
            enterprise_id: null,
            user_id: "U444USER",
            bot_id: null,
            app_id: null,
          }),
        },
        ISSUED_AT,
      ),
    ).rejects.toThrow(/prove a bot installation/);
  });
});

describe("Slack founder DM challenge", () => {
  it("sends a nonce to one namespaced user but retains only its digest", async () => {
    const api = new FakeChallengeApi();
    const provider = await providerIdentity();
    const nonce = Buffer.alloc(32, 7);
    const encodedNonce = nonce.toString("base64url");

    const ticket = await issueChallenge(api, provider);

    expect(api.openedUsers).toEqual(["U555CEO"]);
    expect(api.authIdentityCalls).toBe(1);
    expect(api.posted).toHaveLength(1);
    expect(api.posted[0]).toMatchObject({
      channel: "D333DM",
      unfurlLinks: false,
      unfurlMedia: false,
    });
    expect(api.posted[0]?.text).toContain("T123ABC/U555CEO");
    expect(api.posted[0]?.text).toContain(encodedNonce);
    expect(ticket).toMatchObject({
      tenant_id: "T123ABC",
      subject_id: "U555CEO",
      bot_user_id: "U111BOT",
      channel_id: "D333DM",
      message_ts: "1721420000.123456",
      reaction_name: "white_check_mark",
      issued_at: ISSUED_AT,
      expires_at: EXPIRES_AT,
    });
    expect(JSON.stringify(ticket)).not.toContain(encodedNonce);
    expect(ticket.challenge_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects a cross-workspace actor before opening or posting a DM", async () => {
    const api = new FakeChallengeApi();
    const provider = await providerIdentity();

    await expect(
      issueChallenge(
        api,
        provider,
        { provider: "slack", team_id: "T999BAD", user_id: "U555CEO" },
      ),
    ).rejects.toThrow(/different workspace/);
    expect(api.openedUsers).toEqual([]);
    expect(api.posted).toEqual([]);
  });

  it("rejects tampered auth evidence and an unproven DM before posting", async () => {
    const api = new FakeChallengeApi();
    const provider = await providerIdentity();
    await expect(
      issueChallenge(
        api,
        {
          ...provider,
          evidence_sha256: `sha256:${"0".repeat(64)}`,
        },
      ),
    ).rejects.toThrow(/evidence does not match/);
    expect(api.openedUsers).toEqual([]);

    api.openDirectMessage = async (userId) => {
      api.openedUsers.push(userId);
      return { channel_id: "C_NOT_A_DM", user_id: userId };
    };
    await expect(
      issueChallenge(api, provider),
    ).rejects.toThrow(/invalid direct message/);
    expect(api.posted).toEqual([]);
  });

  it("fails before DM side effects if the connected Slack identity changed", async () => {
    const api = new FakeChallengeApi();
    const provider = await providerIdentity();
    api.authIdentityResult = {
      ...api.authIdentityResult,
      team_id: "T999BAD",
    };

    await expect(
      issueChallenge(api, provider),
    ).rejects.toThrow(/identity changed/);
    expect(api.openedUsers).toEqual([]);
    expect(api.posted).toEqual([]);
  });

  it("ignores other actors, then emits exact evidence for the enrolled actor", async () => {
    const api = new FakeChallengeApi();
    const provider = await providerIdentity();
    const ticket = await issueChallenge(api, provider);
    api.reactionPages = [
      [{ name: "white_check_mark", users: ["U999OTHER"], count: 1 }],
      [{ name: "white_check_mark", users: ["U555CEO"], count: 1 }],
    ];
    const sleeps: number[] = [];

    const result = await pollSlackDmChallenge(api, ticket, {
      maxAttempts: 3,
      pollIntervalMs: 1_000,
      now: () => OBSERVED_AT,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verification");
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([1_000]);
    expect(api.reactionReads).toEqual([
      { channel: "D333DM", timestamp: "1721420000.123456" },
      { channel: "D333DM", timestamp: "1721420000.123456" },
    ]);
    expect(result.verification.evidence_input).toMatchObject({
      provider: "slack",
      tenant: { team_id: "T123ABC", enterprise_id: "E456DEF" },
      subject: { user_id: "U555CEO" },
      bot: {
        user_id: "U111BOT",
        bot_id: "B222BOT",
        auth_test_evidence_sha256: provider.evidence_sha256,
      },
      challenge: {
        channel_id: "D333DM",
        message_ts: "1721420000.123456",
        nonce_sha256: ticket.challenge_sha256,
      },
      assertion: {
        kind: "reaction",
        name: "white_check_mark",
        observed_at: OBSERVED_AT,
      },
    });
    expect(result.verification.evidence_sha256).toBe(
      canonicalSha256(result.verification.evidence_input),
    );
    expect(result.verification.claim_assertion).toEqual({
      issuer: { kind: "provider", provider: "slack", tenant_id: "T123ABC" },
      subject: { kind: "user", id: "U555CEO" },
      verification: {
        method: "slack_dm_challenge",
        assurance: "provider_challenge_observed",
        verified_at: OBSERVED_AT,
        evidence_sha256: result.verification.evidence_sha256,
      },
    });
  });

  it("refuses to read reactions after the Slack connection identity changes", async () => {
    const api = new FakeChallengeApi();
    const provider = await providerIdentity();
    const ticket = await issueChallenge(api, provider);
    api.authIdentityResult = {
      ...api.authIdentityResult,
      user_id: "U999OTHERBOT",
    };

    await expect(
      pollSlackDmChallenge(api, ticket, {
        maxAttempts: 1,
        pollIntervalMs: 1_000,
        now: () => OBSERVED_AT,
      }),
    ).rejects.toThrow(/identity changed before challenge polling/);
    expect(api.reactionReads).toEqual([]);
  });

  it("stops at the exact poll budget and reports expiration without another API read", async () => {
    const api = new FakeChallengeApi();
    const provider = await providerIdentity();
    const ticket = await issueChallenge(api, provider);
    const sleeps: number[] = [];
    await expect(
      pollSlackDmChallenge(api, ticket, {
        maxAttempts: 3,
        pollIntervalMs: 1_000,
        now: () => OBSERVED_AT,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      }),
    ).resolves.toEqual({ status: "not_observed", attempts: 3 });
    expect(api.reactionReads).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 1_000]);

    const readsBeforeExpiryCheck = api.reactionReads.length;
    await expect(
      pollSlackDmChallenge(api, ticket, {
        maxAttempts: 3,
        pollIntervalMs: 1_000,
        now: () => EXPIRES_AT,
      }),
    ).resolves.toEqual({ status: "expired", attempts: 0 });
    expect(api.reactionReads).toHaveLength(readsBeforeExpiryCheck);
  });

  it("rejects unbounded or overlong challenge schedules", async () => {
    const api = new FakeChallengeApi();
    const provider = await providerIdentity();
    const ticket = await issueChallenge(api, provider);

    await expect(
      pollSlackDmChallenge(api, ticket, {
        maxAttempts: 121,
        pollIntervalMs: 1_000,
        now: () => OBSERVED_AT,
      }),
    ).rejects.toThrow(/maxAttempts/);
    await expect(
      pollSlackDmChallenge(api, ticket, {
        maxAttempts: 2,
        pollIntervalMs: 30_001,
        now: () => OBSERVED_AT,
      }),
    ).rejects.toThrow(/pollIntervalMs/);
  });
});
