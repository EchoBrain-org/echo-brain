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
const CHALLENGE_ATTEMPT_ID =
  'cat_12345678-1234-4123-8123-123456789abc';
const CHALLENGE_ISSUED_AT = '2025-07-29T20:59:00.000Z';
const CHALLENGE_EXPIRES_AT = '2025-07-29T21:04:00.000Z';
const CHALLENGE_MESSAGE_TS = '1753822800.000001';
const CHALLENGE_REPLY_TS = '1753822860.000002';
const CHALLENGE_CODE = 'A'.repeat(43);
const CHALLENGE_TEXT =
  'Echo account connection requested. Reply in this thread with the ' +
  `code shown by Echo before ${CHALLENGE_EXPIRES_AT}.`;
const CHALLENGE_MARKER =
  `echo-identity-link:${CHALLENGE_ATTEMPT_ID}:` +
  CHALLENGE_EXPIRES_AT;
const CHALLENGE_INPUT = {
  expected_team_id: 'T123TEAM',
  expected_enterprise_id: null,
  expected_bot_user_id: 'U123BOT',
  expected_bot_id: 'B123BOT',
  expected_app_id: 'A123APP',
  challenge_attempt_id: CHALLENGE_ATTEMPT_ID,
  channel_id: 'C123CHANNEL',
  issued_at: CHALLENGE_ISSUED_AT,
  expires_at: CHALLENGE_EXPIRES_AT,
} as const;
const OBSERVE_CHALLENGE_INPUT = {
  ...CHALLENGE_INPUT,
  challenge_message_ts: CHALLENGE_MESSAGE_TS,
  challenge_code: CHALLENGE_CODE,
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

function challengeBlocks(
  marker = CHALLENGE_MARKER,
): readonly Record<string, unknown>[] {
  return [
    {
      type: 'section',
      block_id: marker,
      text: { type: 'mrkdwn', text: CHALLENGE_TEXT },
    },
  ];
}

function challengeParent(
  override: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: 'message',
    user: 'U123BOT',
    bot_id: 'B123BOT',
    app_id: 'A123APP',
    ts: CHALLENGE_MESSAGE_TS,
    text: CHALLENGE_TEXT,
    blocks: challengeBlocks(),
    ...override,
  };
}

function challengeReply(
  override: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: 'message',
    user: 'U123ZHEN',
    text: CHALLENGE_CODE,
    ts: CHALLENGE_REPLY_TS,
    thread_ts: CHALLENGE_MESSAGE_TS,
    ...override,
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
      code: 'unauthorized',
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

  it('posts a code-free, attempt-bound identity-link challenge as the exact bot', async () => {
    const fetch = slackFetch(
      slackResponse(CONNECTION),
      slackResponse({
        ok: true,
        channel: 'C123CHANNEL',
        ts: CHALLENGE_MESSAGE_TS,
        message: challengeParent(),
      }),
    );
    const provider = new SlackWebIntegrationProvider({ fetch });

    await expect(
      provider.postIdentityLinkChallenge(TOKEN, CHALLENGE_INPUT),
    ).resolves.toMatchObject({
      team_id: 'T123TEAM',
      channel_id: 'C123CHANNEL',
      challenge_message_ts: CHALLENGE_MESSAGE_TS,
    });
    const post = fetch.mock.calls[1];
    expect(post?.[0]).toBe('https://slack.com/api/chat.postMessage');
    const body = post?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('channel')).toBe('C123CHANNEL');
    expect((body as URLSearchParams).get('text')).toBe(CHALLENGE_TEXT);
    expect((body as URLSearchParams).get('blocks')).toBe(
      JSON.stringify(challengeBlocks()),
    );
    expect(String(body)).not.toContain(CHALLENGE_CODE);
  });

  it('accepts Slack timestamps from a clock slightly behind the Authority', async () => {
    const issuedAt = '2025-07-29T21:00:01.000Z';
    const expiresAt = '2025-07-29T21:05:01.000Z';
    const text =
      'Echo account connection requested. Reply in this thread with the ' +
      `code shown by Echo before ${expiresAt}.`;
    const marker =
      `echo-identity-link:${CHALLENGE_ATTEMPT_ID}:` + expiresAt;
    const fetch = slackFetch(
      slackResponse(CONNECTION),
      slackResponse({
        ok: true,
        channel: 'C123CHANNEL',
        ts: CHALLENGE_MESSAGE_TS,
        message: challengeParent({
          text,
          blocks: [
            {
              type: 'section',
              block_id: marker,
              text: { type: 'mrkdwn', text },
            },
          ],
        }),
      }),
    );

    await expect(
      new SlackWebIntegrationProvider({ fetch }).postIdentityLinkChallenge(
        TOKEN,
        {
          ...CHALLENGE_INPUT,
          issued_at: issuedAt,
          expires_at: expiresAt,
        },
      ),
    ).resolves.toMatchObject({
      challenge_message_ts: CHALLENGE_MESSAGE_TS,
    });
  });

  it('derives one human identity from a complete, unedited challenge thread', async () => {
    const fetch = slackFetch(
      slackResponse(CONNECTION),
      slackResponse({
        ok: true,
        messages: [challengeParent(), challengeReply()],
        has_more: false,
        response_metadata: { next_cursor: '' },
      }),
      slackResponse({ ok: true, user: HUMAN }),
    );
    const provider = new SlackWebIntegrationProvider({ fetch });

    await expect(
      provider.observeIdentityLinkChallenge(
        TOKEN,
        OBSERVE_CHALLENGE_INPUT,
      ),
    ).resolves.toMatchObject({
      team_id: 'T123TEAM',
      user_id: 'U123ZHEN',
      channel_id: 'C123CHANNEL',
      challenge_message_ts: CHALLENGE_MESSAGE_TS,
      reply_message_ts: CHALLENGE_REPLY_TS,
      verification_evidence_sha256: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/,
      ),
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://slack.com/api/conversations.replies',
      expect.objectContaining({
        body: new URLSearchParams({
          channel: 'C123CHANNEL',
          ts: CHALLENGE_MESSAGE_TS,
          limit: '100',
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'https://slack.com/api/users.info',
      expect.objectContaining({
        body: new URLSearchParams({ user: 'U123ZHEN' }),
      }),
    );
  });

  it('accepts Slack returning the challenge parent with its own thread timestamp', async () => {
    const fetch = slackFetch(
      slackResponse(CONNECTION),
      slackResponse({
        ok: true,
        messages: [
          challengeParent({
            thread_ts: CHALLENGE_MESSAGE_TS,
            blocks: [
              {
                type: 'section',
                block_id: CHALLENGE_MARKER,
                text: {
                  type: 'mrkdwn',
                  text: CHALLENGE_TEXT,
                  verbatim: false,
                },
              },
            ],
          }),
          challengeReply(),
        ],
        has_more: false,
        response_metadata: { next_cursor: '' },
      }),
      slackResponse({ ok: true, user: HUMAN }),
    );

    await expect(
      new SlackWebIntegrationProvider({
        fetch,
      }).observeIdentityLinkChallenge(TOKEN, OBSERVE_CHALLENGE_INPUT),
    ).resolves.toMatchObject({
      user_id: 'U123ZHEN',
      challenge_message_ts: CHALLENGE_MESSAGE_TS,
    });
  });

  it('derives Enterprise Grid W bot and human identities from the challenge', async () => {
    const gridConnection = {
      ...CONNECTION,
      user_id: 'W123BOT',
    };
    const gridHuman = {
      ...HUMAN,
      id: 'W123ZHEN',
    };
    const provider = new SlackWebIntegrationProvider({
      fetch: slackFetch(
        slackResponse(gridConnection),
        slackResponse({
          ok: true,
          messages: [
            challengeParent({ user: 'W123BOT' }),
            challengeReply({ user: 'W123ZHEN' }),
          ],
          has_more: false,
          response_metadata: { next_cursor: '' },
        }),
        slackResponse({ ok: true, user: gridHuman }),
      ),
    });

    await expect(
      provider.observeIdentityLinkChallenge(TOKEN, {
        ...OBSERVE_CHALLENGE_INPUT,
        expected_bot_user_id: 'W123BOT',
      }),
    ).resolves.toMatchObject({
      team_id: 'T123TEAM',
      user_id: 'W123ZHEN',
    });
  });

  it('verifies Enterprise Grid W identities in an approval reaction', async () => {
    const provider = new SlackWebIntegrationProvider({
      fetch: slackFetch(
        slackResponse({ ...CONNECTION, user_id: 'W123BOT' }),
        slackResponse({
          ok: true,
          message: approvalMessage([
            {
              name: 'white_check_mark',
              users: ['W123ZHEN'],
              count: 1,
            },
          ]),
        }),
      ),
    });

    await expect(
      provider.verifyReaction(TOKEN, {
        ...REACTION_INPUT,
        expected_bot_user_id: 'W123BOT',
        user_id: 'W123ZHEN',
      }),
    ).resolves.toBe(true);
  });

  it('uses Slack-relative reply ordering when the Authority clock is ahead', async () => {
    const issuedAt = '2025-07-29T21:00:01.000Z';
    const expiresAt = '2025-07-29T21:05:01.000Z';
    const text =
      'Echo account connection requested. Reply in this thread with the ' +
      `code shown by Echo before ${expiresAt}.`;
    const marker =
      `echo-identity-link:${CHALLENGE_ATTEMPT_ID}:` + expiresAt;
    const provider = new SlackWebIntegrationProvider({
      fetch: slackFetch(
        slackResponse(CONNECTION),
        slackResponse({
          ok: true,
          messages: [
            challengeParent({
              text,
              blocks: [
                {
                  type: 'section',
                  block_id: marker,
                  text: { type: 'mrkdwn', text },
                },
              ],
            }),
            challengeReply(),
          ],
          has_more: false,
        }),
        slackResponse({ ok: true, user: HUMAN }),
      ),
    });

    await expect(
      provider.observeIdentityLinkChallenge(TOKEN, {
        ...OBSERVE_CHALLENGE_INPUT,
        issued_at: issuedAt,
        expires_at: expiresAt,
      }),
    ).resolves.toMatchObject({
      user_id: 'U123ZHEN',
      reply_message_ts: CHALLENGE_REPLY_TS,
    });
  });

  it('fails closed when the live Slack connection no longer matches the challenge', async () => {
    const provider = new SlackWebIntegrationProvider({
      fetch: slackFetch(
        slackResponse({ ...CONNECTION, team_id: 'T999OTHER' }),
      ),
    });

    await expect(
      provider.observeIdentityLinkChallenge(
        TOKEN,
        OBSERVE_CHALLENGE_INPUT,
      ),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'unauthorized',
    });
  });

  it.each([
    {
      label: 'edited',
      parent: challengeParent({
        edited: { user: 'U123BOT', ts: '1753822810.000001' },
      }),
    },
    {
      label: 're-marked',
      parent: challengeParent({
        blocks: challengeBlocks(
          'echo-identity-link:cat_another:2025-07-29T21:04:00.000Z',
        ),
      }),
    },
    {
      label: 'attached to another thread',
      parent: challengeParent({
        thread_ts: '1753822700.000001',
      }),
    },
  ])('rejects an $label challenge parent', async ({ parent }) => {
    const provider = new SlackWebIntegrationProvider({
      fetch: slackFetch(
        slackResponse(CONNECTION),
        slackResponse({
          ok: true,
          messages: [parent, challengeReply()],
          has_more: false,
        }),
      ),
    });

    await expect(
      provider.observeIdentityLinkChallenge(
        TOKEN,
        OBSERVE_CHALLENGE_INPUT,
      ),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'unauthorized',
    });
  });

  it.each([
    {
      label: 'has_more',
      response: {
        ok: true,
        messages: [challengeParent(), challengeReply()],
        has_more: true,
      },
    },
    {
      label: 'next cursor',
      response: {
        ok: true,
        messages: [challengeParent(), challengeReply()],
        has_more: false,
        response_metadata: { next_cursor: 'next-page' },
      },
    },
  ])('does not infer identity from a truncated thread ($label)', async ({
    response,
  }) => {
    const provider = new SlackWebIntegrationProvider({
      fetch: slackFetch(
        slackResponse(CONNECTION),
        slackResponse(response),
      ),
    });

    await expect(
      provider.observeIdentityLinkChallenge(
        TOKEN,
        OBSERVE_CHALLENGE_INPUT,
      ),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'not_observed',
    });
  });

  it('does not choose between two eligible humans who replied with the code', async () => {
    const provider = new SlackWebIntegrationProvider({
      fetch: slackFetch(
        slackResponse(CONNECTION),
        slackResponse({
          ok: true,
          messages: [
            challengeParent(),
            challengeReply(),
            challengeReply({
              user: 'U999OTHER',
              ts: '1753822861.000003',
            }),
          ],
          has_more: false,
        }),
      ),
    });

    await expect(
      provider.observeIdentityLinkChallenge(
        TOKEN,
        OBSERVE_CHALLENGE_INPUT,
      ),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'not_observed',
    });
  });

  it.each([
    {
      label: 'edited reply',
      reply: challengeReply({
        edited: { user: 'U123ZHEN', ts: '1753822862.000001' },
      }),
    },
    {
      label: 'bot reply',
      reply: challengeReply({ bot_id: 'B999BOT' }),
    },
    {
      label: 'reply timestamp before the parent',
      reply: challengeReply({ ts: '1753822799.000001' }),
    },
  ])('does not accept an ineligible exact-code $label', async ({ reply }) => {
    const provider = new SlackWebIntegrationProvider({
      fetch: slackFetch(
        slackResponse(CONNECTION),
        slackResponse({
          ok: true,
          messages: [challengeParent(), reply],
          has_more: false,
        }),
      ),
    });

    await expect(
      provider.observeIdentityLinkChallenge(
        TOKEN,
        OBSERVE_CHALLENGE_INPUT,
      ),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'not_observed',
    });
  });

  it('rejects a human whose Slack workspace does not match the connection', async () => {
    const provider = new SlackWebIntegrationProvider({
      fetch: slackFetch(
        slackResponse(CONNECTION),
        slackResponse({
          ok: true,
          messages: [challengeParent(), challengeReply()],
          has_more: false,
        }),
        slackResponse({
          ok: true,
          user: { ...HUMAN, team_id: 'T999OTHER' },
        }),
      ),
    });

    await expect(
      provider.observeIdentityLinkChallenge(
        TOKEN,
        OBSERVE_CHALLENGE_INPUT,
      ),
    ).rejects.toMatchObject({
      name: 'SlackIntegrationProviderError',
      code: 'unauthorized',
    });
  });
});
