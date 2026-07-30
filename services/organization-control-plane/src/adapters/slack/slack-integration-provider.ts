import { createHash } from 'node:crypto';
import type {
  SlackIntegrationProvider,
  VerifiedSlackChannel,
  VerifiedSlackConnection,
  VerifiedSlackHuman,
  VerifySlackReactionInput,
} from '../../application/contracts.js';

const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SLACK_ID = /^[A-Z][A-Z0-9]{2,}$/;
const SLACK_TIMESTAMP = /^[0-9]{1,16}\.[0-9]{6}$/;
const REACTION_NAME = /^[a-z0-9_+-]{1,64}$/;
const APPROVAL_ID = /^[0-9a-f]{64}$/;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stable(nested)]),
  );
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')}`;
}

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
      bot_user_id: requiredId(response.value['user_id'], 'user_id', 'U'),
      bot_id: requiredId(response.value['bot_id'], 'bot_id', 'B'),
      app_id: optionalId(response.value['app_id'], 'app_id', 'A'),
      granted_scopes: response.scopes,
      verification_evidence_sha256: digest({
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
      verification_evidence_sha256: digest({
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
    requiredId(userId, 'reviewer user_id', 'U');
    const response = await this.call(
      token,
      'users.info',
      { user: userId },
      signal,
    );
    const user = record(response.value['user'], 'users.info user');
    const observedUserId = requiredId(user['id'], 'user.id', 'U');
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
        'invalid_response',
      );
    }
    return Object.freeze({
      team_id: teamId,
      user_id: observedUserId,
      verification_evidence_sha256: digest({
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
      !SLACK_ID.test(input.expected_bot_user_id) ||
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
      !SLACK_ID.test(input.user_id)
    ) {
      throw new SlackIntegrationProviderError(
        'Slack reaction verification input is invalid',
        'invalid_response',
      );
    }
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
        users.some((user) => typeof user !== 'string' || !SLACK_ID.test(user))
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
}
