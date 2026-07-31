import { canonicalSha256 } from '../../canonical/canonical-json.js';
import type {
  ObservedSlackIdentityLinkChallenge,
  ObserveSlackIdentityLinkChallengeInput,
  PostedSlackIdentityLinkChallenge,
  PostSlackIdentityLinkChallengeInput,
  SlackIntegrationProvider,
  VerifiedSlackChannel,
  VerifiedSlackConnection,
  VerifiedSlackHuman,
  VerifySlackReactionInput,
} from '../../application/contracts.js';

const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SLACK_ID = /^[A-Z][A-Z0-9]{2,}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;
const SLACK_TIMESTAMP = /^[0-9]{1,16}\.[0-9]{6}$/;
const REACTION_NAME = /^[a-z0-9_+-]{1,64}$/;
const APPROVAL_ID = /^[0-9a-f]{64}$/;
const CONNECTION_ATTEMPT_ID = /^cat_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const CHALLENGE_CODE =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const MAXIMUM_CHALLENGE_LIFETIME_MS = 15 * 60 * 1_000;
const MAXIMUM_CHALLENGE_THREAD_MESSAGES = 100;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Slack ${label} response is invalid`);
  }
  return value as Record<string, unknown>;
}

function requiredId(
  value: unknown,
  label: string,
  prefix?: string,
): string {
  if (
    typeof value !== 'string' ||
    !SLACK_ID.test(value) ||
    (prefix !== undefined && !value.startsWith(prefix))
  ) {
    throw new Error(`Slack ${label} is invalid`);
  }
  return value;
}

function optionalId(
  value: unknown,
  label: string,
  prefix?: string,
): string | null {
  if (value === undefined || value === null) return null;
  return requiredId(value, label, prefix);
}

function requiredSlackUserId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SLACK_USER_ID.test(value)) {
    throw new Error(`Slack ${label} is invalid`);
  }
  return value;
}

function requiredTimestamp(
  value: unknown,
  label: string,
): number {
  if (typeof value !== 'string') {
    throw new SlackIntegrationProviderError(
      `Slack ${label} is invalid`,
      'invalid_response',
    );
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new SlackIntegrationProviderError(
      `Slack ${label} is invalid`,
      'invalid_response',
    );
  }
  return milliseconds;
}

function slackTimestampMicroseconds(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !SLACK_TIMESTAMP.test(value)) {
    throw new SlackIntegrationProviderError(
      `Slack ${label} is invalid`,
      'invalid_response',
    );
  }
  const [seconds = '', fraction = ''] = value.split('.');
  return BigInt(seconds) * 1_000_000n + BigInt(fraction);
}

interface ValidatedIdentityLinkChallenge {
  marker: string;
  text: string;
}

function validateIdentityLinkChallenge(
  input: PostSlackIdentityLinkChallengeInput,
): ValidatedIdentityLinkChallenge {
  requiredId(input.expected_team_id, 'expected team_id', 'T');
  if (
    input.expected_enterprise_id !== null &&
    !(
      SLACK_ID.test(input.expected_enterprise_id) &&
      input.expected_enterprise_id.startsWith('E')
    )
  ) {
    throw new SlackIntegrationProviderError(
      'Slack expected enterprise_id is invalid',
      'invalid_response',
    );
  }
  if (!SLACK_USER_ID.test(input.expected_bot_user_id)) {
    throw new SlackIntegrationProviderError(
      'Slack expected bot user_id is invalid',
      'invalid_response',
    );
  }
  requiredId(input.expected_bot_id, 'expected bot_id', 'B');
  if (
    input.expected_app_id !== null &&
    !(
      SLACK_ID.test(input.expected_app_id) &&
      input.expected_app_id.startsWith('A')
    )
  ) {
    throw new SlackIntegrationProviderError(
      'Slack expected app_id is invalid',
      'invalid_response',
    );
  }
  requiredId(input.channel_id, 'challenge channel_id', 'C');
  if (!CONNECTION_ATTEMPT_ID.test(input.challenge_attempt_id)) {
    throw new SlackIntegrationProviderError(
      'Slack identity-link challenge attempt is invalid',
      'invalid_response',
    );
  }
  const issuedMilliseconds = requiredTimestamp(
    input.issued_at,
    'identity-link challenge issued_at',
  );
  const expiresMilliseconds = requiredTimestamp(
    input.expires_at,
    'identity-link challenge expires_at',
  );
  if (
    expiresMilliseconds <= issuedMilliseconds ||
    expiresMilliseconds - issuedMilliseconds >
      MAXIMUM_CHALLENGE_LIFETIME_MS
  ) {
    throw new SlackIntegrationProviderError(
      'Slack identity-link challenge lifetime is invalid',
      'invalid_response',
    );
  }
  const marker =
    `echo-identity-link:${input.challenge_attempt_id}:` +
    input.expires_at;
  return {
    marker,
    text:
      'Echo account connection requested. Reply in this thread with the ' +
      `code shown by Echo before ${input.expires_at}.`,
  };
}

function challengeBlocks(marker: string, text: string): readonly unknown[] {
  return Object.freeze([
    Object.freeze({
      type: 'section',
      block_id: marker,
      text: Object.freeze({ type: 'mrkdwn', text }),
    }),
  ]);
}

function verifyChallengeBlocks(
  value: unknown,
  marker: string,
  text: string,
): void {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new SlackIntegrationProviderError(
      'Slack identity-link challenge marker is unavailable',
      'invalid_response',
    );
  }
  const block = record(value[0], 'identity-link challenge block');
  const blockText = record(
    block['text'],
    'identity-link challenge block text',
  );
  if (
    block['type'] !== 'section' ||
    block['block_id'] !== marker ||
    blockText['type'] !== 'mrkdwn' ||
    blockText['text'] !== text
  ) {
    throw new SlackIntegrationProviderError(
      'Slack identity-link challenge marker changed',
      'unauthorized',
    );
  }
}

function normalizedScopes(header: string | null): readonly string[] {
  if (header === null) {
    throw new Error('Slack did not report the granted OAuth scopes');
  }
  const scopes = [...new Set(header.split(',').map((item) => item.trim()))]
    .filter((item) => item.length > 0)
    .sort();
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !/^[a-z][a-z0-9:_-]{0,127}$/.test(scope))
  ) {
    throw new Error('Slack reported invalid OAuth scopes');
  }
  return Object.freeze(scopes);
}

interface SlackResponse {
  value: Record<string, unknown>;
  scopes: readonly string[] | null;
}

export class SlackIntegrationProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unauthorized'
      | 'unavailable'
      | 'invalid_response'
      | 'not_observed',
  ) {
    super(message);
    this.name = 'SlackIntegrationProviderError';
  }
}

async function readBoundedResponseBytes(
  response: Response,
): Promise<Uint8Array> {
  if (response.body === null) {
    throw new SlackIntegrationProviderError(
      'Slack returned an empty verification response',
      'invalid_response',
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch {
        throw new SlackIntegrationProviderError(
          'Slack integration verification is unavailable',
          'unavailable',
        );
      }
      if (read.done) break;
      totalBytes += read.value.byteLength;
      if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is authoritative even if cancellation fails.
        }
        throw new SlackIntegrationProviderError(
          'Slack returned an oversized verification response',
          'invalid_response',
        );
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) {
    throw new SlackIntegrationProviderError(
      'Slack returned an empty verification response',
      'invalid_response',
    );
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class SlackWebIntegrationProvider implements SlackIntegrationProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      typeof this.fetchImpl !== 'function' ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 60_000
    ) {
      throw new Error('Slack integration transport configuration is invalid');
    }
  }

  private async call(
    token: string,
    method: string,
    parameters: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<SlackResponse> {
    if (!/^xoxb-[A-Za-z0-9-]{8,}$/.test(token)) {
      throw new SlackIntegrationProviderError(
        'Slack bot credential is invalid',
        'unauthorized',
      );
    }
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined =
      signal === undefined
        ? deadline
        : AbortSignal.any([signal, deadline]);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(parameters),
        redirect: 'error',
        signal: combined,
      });
    } catch {
      throw new SlackIntegrationProviderError(
        'Slack integration verification is unavailable',
        'unavailable',
      );
    }
    const declared = response.headers.get('content-length');
    if (
      !response.ok ||
      (declared !== null &&
        (!/^\d+$/.test(declared) ||
          Number(declared) > MAXIMUM_RESPONSE_BYTES))
    ) {
      throw new SlackIntegrationProviderError(
        'Slack integration verification failed',
        response.status === 401 ? 'unauthorized' : 'unavailable',
      );
    }
    const bytes = await readBoundedResponseBytes(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new SlackIntegrationProviderError(
        'Slack returned invalid JSON',
        'invalid_response',
      );
    }
    const value = record(parsed, method);
    if (value['ok'] !== true) {
      const error = value['error'];
      const unauthorized =
        error === 'invalid_auth' ||
        error === 'not_authed' ||
        error === 'account_inactive' ||
        error === 'token_expired' ||
        error === 'token_revoked' ||
        error === 'missing_scope';
      const notObserved =
        error === 'access_denied' ||
        error === 'channel_is_limited_access' ||
        error === 'channel_not_found' ||
        error === 'no_permission' ||
        error === 'not_in_channel' ||
        error === 'team_access_not_granted';
      throw new SlackIntegrationProviderError(
        'Slack rejected the integration verification request',
        unauthorized
          ? 'unauthorized'
          : notObserved
            ? 'not_observed'
            : 'unavailable',
      );
    }
    const scopesHeader = response.headers.get('x-oauth-scopes');
    return {
      value,
      scopes: scopesHeader === null ? null : normalizedScopes(scopesHeader),
    };
  }

  async verifyConnection(
    token: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackConnection> {
    const response = await this.call(token, 'auth.test', {}, signal);
    if (response.scopes === null) {
      throw new SlackIntegrationProviderError(
        'Slack did not report the granted OAuth scopes',
        'invalid_response',
      );
    }
    const connection = {
      team_id: requiredId(response.value['team_id'], 'team_id', 'T'),
      enterprise_id: optionalId(
        response.value['enterprise_id'],
        'enterprise_id',
        'E',
      ),
      bot_user_id: requiredSlackUserId(response.value['user_id'], 'user_id'),
      bot_id: requiredId(response.value['bot_id'], 'bot_id', 'B'),
      app_id: optionalId(response.value['app_id'], 'app_id', 'A'),
      granted_scopes: response.scopes,
      verification_evidence_sha256: canonicalSha256({
        method: 'slack_auth_test',
        team_id: response.value['team_id'],
        enterprise_id: response.value['enterprise_id'] ?? null,
        bot_user_id: response.value['user_id'],
        bot_id: response.value['bot_id'],
        app_id: response.value['app_id'] ?? null,
        granted_scopes: response.scopes,
      }),
    } satisfies VerifiedSlackConnection;
    return Object.freeze(connection);
  }

  private async verifyExpectedConnection(
    token: string,
    input: Pick<
      PostSlackIdentityLinkChallengeInput,
      | 'expected_team_id'
      | 'expected_enterprise_id'
      | 'expected_bot_user_id'
      | 'expected_bot_id'
      | 'expected_app_id'
    >,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackConnection> {
    const connection = await this.verifyConnection(token, signal);
    if (
      connection.team_id !== input.expected_team_id ||
      connection.enterprise_id !== input.expected_enterprise_id ||
      connection.bot_user_id !== input.expected_bot_user_id ||
      connection.bot_id !== input.expected_bot_id ||
      connection.app_id !== input.expected_app_id
    ) {
      throw new SlackIntegrationProviderError(
        'Slack connection identity changed',
        'unauthorized',
      );
    }
    return connection;
  }

  async verifyChannel(
    token: string,
    channelId: string,
    expectedTeamId: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackChannel> {
    requiredId(channelId, 'channel_id', 'C');
    requiredId(expectedTeamId, 'expected team_id', 'T');
    const response = await this.call(
      token,
      'conversations.info',
      { channel: channelId },
      signal,
    );
    const channel = record(
      response.value['channel'],
      'conversations.info channel',
    );
    const observedChannelId = requiredId(channel['id'], 'channel.id', 'C');
    const contextTeamId = requiredId(
      channel['context_team_id'],
      'channel.context_team_id',
      'T',
    );
    if (
      observedChannelId !== channelId ||
      contextTeamId !== expectedTeamId ||
      channel['is_channel'] !== true ||
      channel['is_private'] !== false ||
      channel['is_im'] === true ||
      channel['is_mpim'] === true ||
      channel['is_ext_shared'] !== false ||
      channel['is_pending_ext_shared'] !== false
    ) {
      throw new SlackIntegrationProviderError(
        'Slack channel is not an eligible public organization channel',
        'invalid_response',
      );
    }
    if (
      channel['is_archived'] !== false ||
      channel['is_member'] !== true ||
      channel['is_frozen'] === true ||
      channel['is_read_only'] === true ||
      channel['is_thread_only'] === true
    ) {
      throw new SlackIntegrationProviderError(
        'Slack bot is not an active member of the selected channel',
        'not_observed',
      );
    }
    return Object.freeze({
      channel_id: observedChannelId,
      team_id: contextTeamId,
      verification_evidence_sha256: canonicalSha256({
        method: 'slack_conversations_info',
        channel_id: observedChannelId,
        context_team_id: contextTeamId,
        is_channel: true,
        is_private: false,
        is_archived: false,
        is_member: true,
        is_ext_shared: false,
        is_pending_ext_shared: false,
      }),
    });
  }

  async verifyHuman(
    token: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackHuman> {
    requiredSlackUserId(userId, 'reviewer user_id');
    const response = await this.call(
      token,
      'users.info',
      { user: userId },
      signal,
    );
    const user = record(response.value['user'], 'users.info user');
    const observedUserId = requiredSlackUserId(user['id'], 'user.id');
    const teamId = requiredId(user['team_id'], 'user.team_id', 'T');
    const deleted = user['deleted'];
    const isBot = user['is_bot'];
    const isAppUser = user['is_app_user'];
    if (
      typeof deleted !== 'boolean' ||
      typeof isBot !== 'boolean' ||
      typeof isAppUser !== 'boolean'
    ) {
      throw new SlackIntegrationProviderError(
        'Slack reviewer type flags are invalid',
        'invalid_response',
      );
    }
    if (
      observedUserId !== userId ||
      deleted ||
      isBot
    ) {
      throw new SlackIntegrationProviderError(
        'Slack reviewer is unavailable or is not a human user',
        'unauthorized',
      );
    }
    return Object.freeze({
      team_id: teamId,
      user_id: observedUserId,
      verification_evidence_sha256: canonicalSha256({
        method: 'slack_users_info',
        team_id: teamId,
        user_id: observedUserId,
        deleted,
        is_bot: isBot,
        is_app_user: isAppUser,
      }),
    });
  }

  async verifyReaction(
    token: string,
    input: VerifySlackReactionInput,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (
      !SLACK_ID.test(input.expected_team_id) ||
      !(
        input.expected_enterprise_id === null ||
        (SLACK_ID.test(input.expected_enterprise_id) &&
          input.expected_enterprise_id.startsWith('E'))
      ) ||
      !SLACK_USER_ID.test(input.expected_bot_user_id) ||
      !SLACK_ID.test(input.expected_bot_id) ||
      !(
        input.expected_app_id === null ||
        (SLACK_ID.test(input.expected_app_id) &&
          input.expected_app_id.startsWith('A'))
      ) ||
      !APPROVAL_ID.test(input.approval_id) ||
      !SLACK_ID.test(input.channel_id) ||
      !SLACK_TIMESTAMP.test(input.message_ts) ||
      !REACTION_NAME.test(input.reaction_name) ||
      !REACTION_NAME.test(input.opposite_reaction_name) ||
      input.reaction_name === input.opposite_reaction_name ||
      !SLACK_USER_ID.test(input.user_id)
    ) {
      throw new SlackIntegrationProviderError(
        'Slack reaction verification input is invalid',
        'invalid_response',
      );
    }
    await this.verifyExpectedConnection(token, input, signal);
    const response = await this.call(
      token,
      'reactions.get',
      {
        channel: input.channel_id,
        timestamp: input.message_ts,
        full: 'true',
      },
      signal,
    );
    const message = record(response.value['message'], 'reactions.get message');
    if (
      requiredId(message['bot_id'], 'message.bot_id', 'B') !==
        input.expected_bot_id ||
      message['ts'] !== input.message_ts
    ) {
      throw new SlackIntegrationProviderError(
        'Slack approval message identity changed',
        'unauthorized',
      );
    }
    const blocks = message['blocks'];
    if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 100) {
      throw new SlackIntegrationProviderError(
        'Slack approval marker is unavailable',
        'invalid_response',
      );
    }
    for (const [index, item] of blocks.entries()) {
      const block = record(item, 'approval block');
      if (
        block['block_id'] !==
        `echo-approval-${input.approval_id}-${String(index)}`
      ) {
        throw new SlackIntegrationProviderError(
          'Slack approval marker does not match the requested approval',
          'invalid_response',
        );
      }
    }
    const reactions = message['reactions'];
    if (reactions === undefined) return false;
    if (!Array.isArray(reactions)) {
      throw new SlackIntegrationProviderError(
        'Slack reaction roster is invalid',
        'invalid_response',
      );
    }
    let selectedPresent = false;
    let oppositePresent = false;
    for (const item of reactions) {
      const reaction = record(item, 'reaction');
      const reactionName = reaction['name'];
      if (
        reactionName !== input.reaction_name &&
        reactionName !== input.opposite_reaction_name
      ) {
        continue;
      }
      const users = reaction['users'];
      const count = reaction['count'];
      if (
        !Array.isArray(users) ||
        !Number.isSafeInteger(count) ||
        users.some(
          (user) => typeof user !== 'string' || !SLACK_USER_ID.test(user),
        )
      ) {
        throw new SlackIntegrationProviderError(
          'Slack reaction roster is invalid',
          'invalid_response',
        );
      }
      const unique = new Set(users as string[]);
      if (unique.size !== count) {
        throw new SlackIntegrationProviderError(
          'Slack reaction roster is incomplete',
          'invalid_response',
        );
      }
      if (reactionName === input.reaction_name) {
        selectedPresent = unique.has(input.user_id);
      } else {
        oppositePresent = unique.has(input.user_id);
      }
    }
    return selectedPresent && !oppositePresent;
  }

  async postIdentityLinkChallenge(
    token: string,
    input: PostSlackIdentityLinkChallengeInput,
    signal?: AbortSignal,
  ): Promise<PostedSlackIdentityLinkChallenge> {
    const challenge = validateIdentityLinkChallenge(input);
    const connection = await this.verifyExpectedConnection(
      token,
      input,
      signal,
    );
    const blocks = challengeBlocks(challenge.marker, challenge.text);
    const response = await this.call(
      token,
      'chat.postMessage',
      {
        channel: input.channel_id,
        text: challenge.text,
        blocks: JSON.stringify(blocks),
      },
      signal,
    );
    const channelId = requiredId(
      response.value['channel'],
      'chat.postMessage channel',
      'C',
    );
    const messageTs = response.value['ts'];
    slackTimestampMicroseconds(messageTs, 'challenge message timestamp');
    const message = record(
      response.value['message'],
      'chat.postMessage message',
    );
    if (
      channelId !== input.channel_id ||
      message['type'] !== 'message' ||
      message['user'] !== input.expected_bot_user_id ||
      message['bot_id'] !== input.expected_bot_id ||
      message['ts'] !== messageTs ||
      message['text'] !== challenge.text ||
      message['edited'] !== undefined ||
      (message['subtype'] !== undefined &&
        message['subtype'] !== 'bot_message') ||
      (input.expected_app_id !== null &&
        message['app_id'] !== input.expected_app_id)
    ) {
      throw new SlackIntegrationProviderError(
        'Slack did not return the exact bot-authored identity-link challenge',
        'invalid_response',
      );
    }
    verifyChallengeBlocks(
      message['blocks'],
      challenge.marker,
      challenge.text,
    );
    return Object.freeze({
      team_id: connection.team_id,
      channel_id: channelId,
      challenge_message_ts: messageTs as string,
    });
  }

  async observeIdentityLinkChallenge(
    token: string,
    input: ObserveSlackIdentityLinkChallengeInput,
    signal?: AbortSignal,
  ): Promise<ObservedSlackIdentityLinkChallenge> {
    const challenge = validateIdentityLinkChallenge(input);
    if (!CHALLENGE_CODE.test(input.challenge_code)) {
      throw new SlackIntegrationProviderError(
        'Slack identity-link challenge code is invalid',
        'invalid_response',
      );
    }
    const challengeMessageMicroseconds = slackTimestampMicroseconds(
      input.challenge_message_ts,
      'challenge message timestamp',
    );
    const connection = await this.verifyExpectedConnection(
      token,
      input,
      signal,
    );
    const response = await this.call(
      token,
      'conversations.replies',
      {
        channel: input.channel_id,
        ts: input.challenge_message_ts,
        limit: String(MAXIMUM_CHALLENGE_THREAD_MESSAGES),
      },
      signal,
    );
    const messages = response.value['messages'];
    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      messages.length > MAXIMUM_CHALLENGE_THREAD_MESSAGES
    ) {
      throw new SlackIntegrationProviderError(
        'Slack identity-link challenge thread is invalid',
        'invalid_response',
      );
    }
    const hasMore = response.value['has_more'];
    if (hasMore !== undefined && typeof hasMore !== 'boolean') {
      throw new SlackIntegrationProviderError(
        'Slack identity-link challenge pagination is invalid',
        'invalid_response',
      );
    }
    const responseMetadata = response.value['response_metadata'];
    let nextCursor = '';
    if (responseMetadata !== undefined) {
      const metadata = record(
        responseMetadata,
        'conversations.replies response_metadata',
      );
      if (
        metadata['next_cursor'] !== undefined &&
        typeof metadata['next_cursor'] !== 'string'
      ) {
        throw new SlackIntegrationProviderError(
          'Slack identity-link challenge cursor is invalid',
          'invalid_response',
        );
      }
      nextCursor = (metadata['next_cursor'] as string | undefined) ?? '';
    }
    if (hasMore === true || nextCursor.length > 0) {
      throw new SlackIntegrationProviderError(
        'Slack identity-link challenge thread exceeds the verification bound',
        'not_observed',
      );
    }

    const parent = record(
      messages[0],
      'identity-link challenge parent message',
    );
    if (
      parent['type'] !== 'message' ||
      parent['ts'] !== input.challenge_message_ts ||
      (parent['thread_ts'] !== undefined &&
        parent['thread_ts'] !== input.challenge_message_ts) ||
      parent['user'] !== input.expected_bot_user_id ||
      parent['bot_id'] !== input.expected_bot_id ||
      parent['text'] !== challenge.text ||
      parent['edited'] !== undefined ||
      (parent['subtype'] !== undefined &&
        parent['subtype'] !== 'bot_message') ||
      (input.expected_app_id !== null &&
        parent['app_id'] !== input.expected_app_id)
    ) {
      throw new SlackIntegrationProviderError(
        'Slack identity-link challenge parent changed',
        'unauthorized',
      );
    }
    verifyChallengeBlocks(
      parent['blocks'],
      challenge.marker,
      challenge.text,
    );

    const matchingReplies: Array<{
      userId: string;
      replyMessageTs: string;
    }> = [];
    for (const value of messages.slice(1)) {
      const reply = record(value, 'identity-link challenge reply');
      if (reply['text'] !== input.challenge_code) continue;
      if (
        reply['type'] !== 'message' ||
        reply['thread_ts'] !== input.challenge_message_ts ||
        reply['edited'] !== undefined ||
        reply['bot_id'] !== undefined ||
        reply['subtype'] !== undefined
      ) {
        continue;
      }
      let userId: string;
      let replyMessageTs: string;
      try {
        userId = requiredSlackUserId(
          reply['user'],
          'identity-link reply user',
        );
        replyMessageTs =
          typeof reply['ts'] === 'string'
            ? reply['ts']
            : '';
        const replyMicroseconds = slackTimestampMicroseconds(
          replyMessageTs,
          'identity-link reply timestamp',
        );
        if (replyMicroseconds <= challengeMessageMicroseconds) {
          continue;
        }
      } catch (error) {
        if (error instanceof SlackIntegrationProviderError) continue;
        throw error;
      }
      matchingReplies.push({ userId, replyMessageTs });
    }
    if (matchingReplies.length !== 1) {
      throw new SlackIntegrationProviderError(
        'Slack did not expose exactly one eligible identity-link reply',
        'not_observed',
      );
    }
    const [match] = matchingReplies;
    if (match === undefined) {
      throw new SlackIntegrationProviderError(
        'Slack identity-link reply is unavailable',
        'not_observed',
      );
    }
    const human = await this.verifyHuman(token, match.userId, signal);
    if (human.team_id !== input.expected_team_id) {
      throw new SlackIntegrationProviderError(
        'Slack identity-link reply came from another workspace',
        'unauthorized',
      );
    }
    return Object.freeze({
      team_id: human.team_id,
      user_id: human.user_id,
      channel_id: input.channel_id,
      challenge_message_ts: input.challenge_message_ts,
      reply_message_ts: match.replyMessageTs,
      verification_evidence_sha256: canonicalSha256({
        method: 'slack_conversations_replies_identity_link',
        connection_evidence_sha256:
          connection.verification_evidence_sha256,
        human_evidence_sha256: human.verification_evidence_sha256,
        challenge_attempt_id: input.challenge_attempt_id,
        issued_at: input.issued_at,
        expires_at: input.expires_at,
        channel_id: input.channel_id,
        challenge_message_ts: input.challenge_message_ts,
        reply_message_ts: match.replyMessageTs,
        user_id: human.user_id,
        marker: challenge.marker,
        challenge_code_sha256: canonicalSha256(input.challenge_code),
      }),
    });
  }
}
