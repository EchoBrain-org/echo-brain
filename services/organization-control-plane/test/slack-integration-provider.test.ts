import { describe, expect, it, vi } from 'vitest';
import {
  SlackIntegrationProviderError,
  SlackWebIntegrationProvider,
} from '../src/adapters/slack/slack-integration-provider.js';

const APPROVAL_ID = 'f'.repeat(64);
const TOKEN = 'xoxb-test-token-12345678';
const CONNECTION = {
  ok: true,
  team_id: 'T123TEAM',
  enterprise_id: null,
  user_id: 'U123BOT',
  bot_id: 'B123BOT',
  app_id: 'A123APP',
} as const;
const HUMAN = {
  id: 'U123ZHEN',
  team_id: 'T123TEAM',
  deleted: false,
  is_bot: false,
  is_app_user: false,
} as const;
const CHANNEL = {
  id: 'C123CHANNEL',
  context_team_id: 'T123TEAM',
  is_channel: true,
  is_private: false,
  is_im: false,
  is_mpim: false,
  is_archived: false,
  is_member: true,
  is_ext_shared: false,
  is_pending_ext_shared: false,
} as const;
const REACTION_INPUT = {
  expected_team_id: 'T123TEAM',
  expected_enterprise_id: null,
  expected_bot_user_id: 'U123BOT',
  expected_bot_id: 'B123BOT',
  expected_app_id: 'A123APP',
  approval_id: APPROVAL_ID,
  channel_id: 'C123CHANNEL',
  message_ts: '1753822800.000001',
  reaction_name: 'white_check_mark',
  opposite_reaction_name: 'x',
  user_id: 'U123ZHEN',
} as const;

function slackResponse(
  value: unknown,
  scopes = 'chat:write,reactions:read,users:read',
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-oauth-scopes': scopes,
    },
  });
}

function slackFetch(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
}

function approvalMessage(
  reactions: unknown,
  blockApprovalId = APPROVAL_ID,
): Record<string, unknown> {
  return {
    ts: REACTION_INPUT.message_ts,
    bot_id: REACTION_INPUT.expected_bot_id,
    blocks: [
      {
        type: 'header',
        block_id: `echo-approval-${blockApprovalId}-0`,
      },
    ],
    reactions,
  };
}

function reactionProvider(
  reactions: unknown,
  blockApprovalId = APPROVAL_ID,
): SlackWebIntegrationProvider {
  return new SlackWebIntegrationProvider({
    fetch: slackFetch(
      slackResponse(CONNECTION),
      slackResponse({
        ok: true,
        message: approvalMessage(reactions, blockApprovalId),
      }),
    ),
  });
}

describe('Slack integration provider verification', () => {
  it('derives the connection and human namespace from live Slack responses', async () => {
    const fetch = slackFetch(
      slackResponse(CONNECTION),
      slackResponse({ ok: true, user: HUMAN }),
    );
    const provider = new SlackWebIntegrationProvider({ fetch });
    const connection = await provider.verifyConnection(TOKEN);
    const human = await provider.verifyHuman(TOKEN, 'U123ZHEN');
    expect(connection).toMatchObject({
      team_id: 'T123TEAM',
      bot_user_id: 'U123BOT',
      bot_id: 'B123BOT',
      app_id: 'A123APP',
      granted_scopes: ['chat:write', 'reactions:read', 'users:read'],
    });
    expect(connection.verification_evidence_sha256).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(human).toMatchObject({
      team_id: 'T123TEAM',
      user_id: 'U123ZHEN',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts an app-created human and hashes the exact observed app-user flag', async () => {
    const fetch = slackFetch(
      slackResponse({ ok: true, user: HUMAN }),
      slackResponse({
        ok: true,
        user: { ...HUMAN, is_app_user: true },
      }),
    );
    const provider = new SlackWebIntegrationProvider({ fetch });

    const regularHuman = await provider.verifyHuman(TOKEN, 'U123ZHEN');
    const appCreatedHuman = await provider.verifyHuman(TOKEN, 'U123ZHEN');

    expect(appCreatedHuman).toMatchObject({
      team_id: 'T123TEAM',
      user_id: 'U123ZHEN',
    });
    expect(appCreatedHuman.verification_evidence_sha256).not.toBe(
      regularHuman.verification_evidence_sha256,
    );
  });

  it.each([
    {
      label: 'non-boolean deleted flag',
      user: { ...HUMAN, deleted: 'false' },
    },
    {
      label: 'non-boolean bot flag',
      user: { ...HUMAN, is_bot: 'false' },
    },
    {
      label: 'non-boolean app-user flag',
      user: { ...HUMAN, is_app_user: 0 },
    },
  ])('fails closed for a $label', async ({ user }) => {
    const provider = new SlackWebIntegrationProvider({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(slackResponse({ ok: true, user })),
    });

    await expect(
      provider.verifyHuman(TOKEN, 'U123ZHEN'),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'invalid_response',
    });
  });

  it.each([
    {
      label: 'deleted reviewer',
      deleted: true,
      is_bot: false,
    },
    {
      label: 'bot reviewer',
      deleted: false,
      is_bot: true,
    },
  ])('rejects a $label', async ({ deleted, is_bot: isBot }) => {
    const provider = new SlackWebIntegrationProvider({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        slackResponse({
          ok: true,
          user: { ...HUMAN, deleted, is_bot: isBot, is_app_user: true },
        }),
      ),
    });

    await expect(
      provider.verifyHuman(TOKEN, 'U123ZHEN'),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'invalid_response',
    });
  });

  it('cancels a chunked Slack response as soon as it exceeds 512 KiB', async () => {
    let chunksEnqueued = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(300 * 1024));
          chunksEnqueued += 1;
          controller.enqueue(new Uint8Array(300 * 1024));
          chunksEnqueued += 1;
        },
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-oauth-scopes': 'chat:write',
        },
      },
    );
    const provider = new SlackWebIntegrationProvider({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(response),
    });

    await expect(
      provider.verifyConnection(TOKEN),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'invalid_response',
    });
    expect(chunksEnqueued).toBe(2);
    expect(cancelled).toBe(true);
  });

  it('proves the bot is an active member of the exact public organization channel', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      slackResponse(
        {
          ok: true,
          channel: CHANNEL,
        },
        'channels:read',
      ),
    );
    const provider = new SlackWebIntegrationProvider({ fetch });

    await expect(
      provider.verifyChannel(
        TOKEN,
        'C123CHANNEL',
        'T123TEAM',
      ),
    ).resolves.toMatchObject({
      channel_id: 'C123CHANNEL',
      team_id: 'T123TEAM',
      verification_evidence_sha256: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/,
      ),
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://slack.com/api/conversations.info',
      expect.objectContaining({
        method: 'POST',
        body: new URLSearchParams({ channel: 'C123CHANNEL' }),
      }),
    );
  });

  it.each([
    {
      label: 'archived',
      channel: { ...CHANNEL, is_archived: true },
    },
    {
      label: 'not joined',
      channel: { ...CHANNEL, is_member: false },
    },
  ])('does not activate an $label Slack channel', async ({ channel }) => {
    const provider = new SlackWebIntegrationProvider({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(slackResponse({ ok: true, channel })),
    });
    await expect(
      provider.verifyChannel(
        TOKEN,
        'C123CHANNEL',
        'T123TEAM',
      ),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'not_observed',
    });
  });

  it('distinguishes inaccessible Slack channels from provider outages', async () => {
    const provider = new SlackWebIntegrationProvider({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          slackResponse({ ok: false, error: 'not_in_channel' }),
        ),
    });
    const failure = provider.verifyChannel(
      TOKEN,
      'C123CHANNEL',
      'T123TEAM',
    );
    await expect(failure).rejects.toBeInstanceOf(
      SlackIntegrationProviderError,
    );
    await expect(failure).rejects.toMatchObject({ code: 'not_observed' });
  });

  it.each([
    {
      label: 'externally shared',
      override: { is_ext_shared: true },
    },
    {
      label: 'pending external share',
      override: { is_pending_ext_shared: true },
    },
    {
      label: 'another workspace context',
      override: { context_team_id: 'T999OTHER' },
    },
  ])('rejects an $label public channel', async ({ override }) => {
    const provider = new SlackWebIntegrationProvider({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        slackResponse({
          ok: true,
          channel: { ...CHANNEL, ...override },
        }),
      ),
    });

    await expect(
      provider.verifyChannel(
        TOKEN,
        'C123CHANNEL',
        'T123TEAM',
      ),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'invalid_response',
    });
  });

  it('revalidates the bot namespace and exact complete reaction roster', async () => {
    await expect(
      reactionProvider([
        {
          name: 'white_check_mark',
          count: 1,
          users: ['U123ZHEN'],
        },
      ]).verifyReaction(TOKEN, REACTION_INPUT),
    ).resolves.toBe(true);
  });

  it('fails closed when Slack truncates the decisive reaction user roster', async () => {
    await expect(
      reactionProvider([
        {
          name: 'white_check_mark',
          count: 2,
          users: ['U123ZHEN'],
        },
      ]).verifyReaction(TOKEN, REACTION_INPUT),
    ).rejects.toThrow(/roster is incomplete/);
  });

  it('keeps the action undecided when the reviewer applied both reactions', async () => {
    await expect(
      reactionProvider([
        {
          name: 'white_check_mark',
          count: 1,
          users: ['U123ZHEN'],
        },
        { name: 'x', count: 1, users: ['U123ZHEN'] },
      ]).verifyReaction(TOKEN, REACTION_INPUT),
    ).resolves.toBe(false);
  });

  it('rejects a reaction on a message that is not the exact bound approval card', async () => {
    await expect(
      reactionProvider(
        [
          {
            name: 'white_check_mark',
            count: 1,
            users: ['U123ZHEN'],
          },
        ],
        'e'.repeat(64),
      ).verifyReaction(TOKEN, REACTION_INPUT),
    ).rejects.toThrow(/marker does not match/);
  });
});
