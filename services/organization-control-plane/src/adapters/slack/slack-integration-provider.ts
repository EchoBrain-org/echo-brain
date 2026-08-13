import {
  RESTRICTED_REVIEWER_POLICY_ID,
  reviewerMessagePresentationPreimage,
} from '../../application/reviewer-restricted-policy.js';
import { canonicalSha256 } from '../../canonical/canonical-json.js';
import { reconstructReviewerCard } from './reviewer-card-grammar.js';
import { reconstructOrganizationMemberCard } from './organization-member-card-grammar.js';
import { ORGANIZATION_MEMBER_READABLE_POLICY_ID, organizationMemberMessagePresentationPreimage } from '../../application/organization-member-readable-policy.js';
import type {
  ObservedSlackIdentityLinkChallenge,
  ObserveSlackIdentityLinkChallengeInput,
  PostedSlackIdentityLinkChallenge,
  PostSlackIdentityLinkChallengeInput,
  SlackIntegrationProvider,
  SlackReviewerPresentationExpectation,
  VerifiedSlackChannel,
  VerifiedSlackConnection,
  VerifiedSlackHuman,
  VerifiedSlackReaction,
  VerifySlackReactionInput,
} from '../../application/contracts.js';

const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SLACK_ID = /^[A-Z][A-Z0-9]{2,}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;
const SLACK_TIMESTAMP = /^[0-9]{1,16}\.[0-9]{6}$/;
const REACTION_NAME = /^[a-z0-9_+-]{1,64}$/;
const APPROVAL_ID = /^[0-9a-f]{64}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
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

function validateApprovalPresentationExpectation(
  value: unknown,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SlackIntegrationProviderError(
      'Slack approval presentation expectation is invalid',
      'invalid_response',
    );
  }
  const expectation = value as Record<string, unknown>;
  if (
    Object.keys(expectation).sort().join(',') !==
      [
        'presentation_policy_id',
        'audience_notice_sha256',
        'notice_text',
        'fallback_text',
      ]
        .sort()
        .join(',') ||
    expectation['presentation_policy_id'] !==
      'pilot-two-person-audience-v1' ||
    typeof expectation['audience_notice_sha256'] !== 'string' ||
    !SHA256_DIGEST.test(expectation['audience_notice_sha256']) ||
    typeof expectation['notice_text'] !== 'string' ||
    expectation['notice_text'].length === 0 ||
    expectation['notice_text'].length > 512 ||
    expectation['notice_text'].trim() !== expectation['notice_text'] ||
    typeof expectation['fallback_text'] !== 'string' ||
    expectation['fallback_text'] !==
      `Decision brief awaiting approval. ${expectation['notice_text']}`
  ) {
    throw new SlackIntegrationProviderError(
      'Slack approval presentation expectation is invalid',
      'invalid_response',
    );
  }
}

function exactApprovalAudienceBlock(
  approvalId: string,
  noticeText: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'section',
    block_id: `echo-approval-${approvalId}-audience-v1`,
    text: Object.freeze({
      type: 'plain_text',
      text: noticeText,
      emoji: false,
    }),
  });
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
      | 'identity_mismatch'
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
  ): Promise<VerifiedSlackReaction> {
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
    if (input.expected_presentation !== null) {
      validateApprovalPresentationExpectation(input.expected_presentation);
    }
    const connection = await this.verifyExpectedConnection(token, input, signal);
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
      message['type'] !== 'message' ||
      message['user'] !== input.expected_bot_user_id ||
      requiredId(message['bot_id'], 'message.bot_id', 'B') !==
        input.expected_bot_id ||
      message['ts'] !== input.message_ts ||
      (message['subtype'] !== undefined &&
        message['subtype'] !== 'bot_message') ||
      (input.expected_app_id !== null &&
        message['app_id'] !== input.expected_app_id)
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
    const reviewerExpectation = input.expected_reviewer_presentation ?? null;
    const memberExpectation = input.expected_organization_member_presentation ?? null;
    if (memberExpectation !== null) {
      if (reviewerExpectation !== null || input.expected_presentation !== null) throw new SlackIntegrationProviderError('Slack approval presentation expectation is invalid', 'invalid_response');
      const reconstructed = reconstructOrganizationMemberCard({ approval_id: input.approval_id, blocks, fallback_text: message['text'] });
      const identityVerified = input.expected_app_id !== null && connection.app_id === input.expected_app_id && message['app_id'] === input.expected_app_id && message['edited'] === undefined;
      if (reconstructed === null || !identityVerified || memberExpectation.policy_id !== ORGANIZATION_MEMBER_READABLE_POLICY_ID || memberExpectation.approve_reaction !== reconstructed.approve_reaction || memberExpectation.reject_reaction !== reconstructed.reject_reaction || memberExpectation.release_draft_sha256 !== reconstructed.release_draft_sha256 || memberExpectation.approval_presentation_sha256 !== reconstructed.approval_presentation_sha256) throw new SlackIntegrationProviderError('Slack organization-member card does not match signed commitments', 'identity_mismatch');
      const event = input.organization_member_provider_event_sha256;
      if (event === undefined || !SHA256_DIGEST.test(event)) throw new SlackIntegrationProviderError('Slack organization-member verification input is invalid', 'invalid_response');
      const observed = this.observedDecisiveReaction(message, input.reaction_name, input.opposite_reaction_name, input.user_id);
      return Object.freeze({ observed, presentation_candidate_observed: true, message_presentation_sha256: null, ...(observed ? { organization_member_presentation: Object.freeze({ release_draft_sha256: reconstructed.release_draft_sha256, approval_presentation_sha256: reconstructed.approval_presentation_sha256, message_presentation_sha256: canonicalSha256(organizationMemberMessagePresentationPreimage({ provider_event_sha256: event, approval_presentation_sha256: reconstructed.approval_presentation_sha256, team_id: connection.team_id, enterprise_id: connection.enterprise_id, bot_user_id: connection.bot_user_id, bot_id: connection.bot_id, app_id: connection.app_id as string, actor_user_id: input.user_id, channel_id: input.channel_id, message_ts: input.message_ts, reaction_name: input.reaction_name })) }) } : {}) });
    }
    const parseReviewerReactions =
      input.parse_reviewer_card_reactions === true;
    if (reviewerExpectation !== null || parseReviewerReactions) {
      if (reviewerExpectation !== null && input.expected_presentation !== null) {
        // A mixed pilot/reviewer expectation cannot produce reviewer proof.
        throw new SlackIntegrationProviderError(
          'Slack approval presentation expectation is invalid',
          'invalid_response',
        );
      }
      const reviewerResult = this.verifyReviewerCardReaction({
        input,
        connection,
        message,
        blocks,
        expectation: reviewerExpectation,
      });
      // Reaction-pair parsing is an extension the parser always offers. When
      // the live card is not a reviewer card it falls through to the landed
      // path, so ordinary and pilot rejections are unchanged.
      if (reviewerResult !== null) return reviewerResult;
    }
    if (input.parse_organization_member_card_reactions === true) {
      const memberResult = this.verifyOrganizationMemberCardReaction({
        input,
        connection,
        message,
        blocks,
      });
      // As with reviewer cards, an exact member card is a closed extension of
      // schema-v1 rejection. Every other card continues through the landed
      // ordinary/pilot grammar unchanged.
      if (memberResult !== null) return memberResult;
    }
    const expectation = input.expected_presentation;
    const expectedAudienceBlock =
      expectation === null
        ? null
        : exactApprovalAudienceBlock(
            input.approval_id,
            expectation.notice_text,
          );
    const approvalBlockPrefix = `echo-approval-${input.approval_id}-`;
    const audienceBlockPrefix = `${approvalBlockPrefix}audience-`;
    const presentationCandidates: Record<string, unknown>[] = [];
    const ordinaryBlocks: Array<{
      readonly ordinal: number;
      readonly physicalIndex: number;
    }> = [];
    const blockIds = new Set<string>();
    const ordinaryOrdinals = new Set<number>();
    for (const [physicalIndex, item] of blocks.entries()) {
      const block = record(item, 'approval block');
      const blockId = block['block_id'];
      if (
        typeof blockId !== 'string' ||
        !blockId.startsWith(approvalBlockPrefix) ||
        blockIds.has(blockId)
      ) {
        throw new SlackIntegrationProviderError(
          'Slack approval marker does not match the requested approval',
          'unauthorized',
        );
      }
      blockIds.add(blockId);
      if (blockId.startsWith(audienceBlockPrefix)) {
        presentationCandidates.push(block);
        continue;
      }
      const ordinalText = blockId.slice(approvalBlockPrefix.length);
      const ordinal = /^[0-9]+$/.test(ordinalText)
        ? Number(ordinalText)
        : Number.NaN;
      if (
        !Number.isSafeInteger(ordinal) ||
        String(ordinal) !== ordinalText ||
        ordinaryOrdinals.has(ordinal)
      ) {
        throw new SlackIntegrationProviderError(
          'Slack approval marker does not match the requested approval',
          'unauthorized',
        );
      }
      ordinaryOrdinals.add(ordinal);
      ordinaryBlocks.push({ ordinal, physicalIndex });
    }
    const logicalOrdinalsMatch = ordinaryBlocks.every(
      (block, logicalIndex) => block.ordinal === logicalIndex,
    );
    const physicalOrdinalsMatch =
      presentationCandidates.length > 0 &&
      ordinaryBlocks.every(
        (block) => block.ordinal === block.physicalIndex,
      );
    if (
      ordinaryBlocks.length === 0 ||
      (!logicalOrdinalsMatch && !physicalOrdinalsMatch)
    ) {
      throw new SlackIntegrationProviderError(
        'Slack approval marker does not match the requested approval',
        'unauthorized',
      );
    }
    let audienceBlockCount = 0;
    let presentationMatches =
      expectation !== null &&
      input.expected_app_id !== null &&
      connection.app_id === input.expected_app_id &&
      message['app_id'] === input.expected_app_id &&
      message['edited'] === undefined;
    for (const block of presentationCandidates) {
      if (
        expectedAudienceBlock !== null &&
        block['block_id'] === expectedAudienceBlock['block_id']
      ) {
        audienceBlockCount += 1;
        if (canonicalSha256(block) !== canonicalSha256(expectedAudienceBlock)) {
          presentationMatches = false;
        }
      }
    }
    if (
      expectation !== null &&
      (presentationCandidates.length !== 1 ||
        audienceBlockCount !== 1 ||
        message['text'] !== expectation.fallback_text)
    ) {
      presentationMatches = false;
    }
    const messagePresentationSha256 =
      expectation === null ||
      expectedAudienceBlock === null ||
      !presentationMatches
        ? null
        : canonicalSha256({
            audience_notice_sha256: expectation.audience_notice_sha256,
            approval_id: input.approval_id,
            provider_team_id: connection.team_id,
            provider_enterprise_id: connection.enterprise_id,
            provider_bot_user_id: connection.bot_user_id,
            provider_bot_id: connection.bot_id,
            provider_app_id: connection.app_id,
            channel_id: input.channel_id,
            message_ts: input.message_ts,
            audience_block: expectedAudienceBlock,
            fallback_text: expectation.fallback_text,
            message_unedited: true,
          });
    const presentationCandidateObserved = presentationCandidates.length > 0;
    return Object.freeze({
      observed: this.observedDecisiveReaction(
        message,
        input.reaction_name,
        input.opposite_reaction_name,
        input.user_id,
      ),
      presentation_candidate_observed: presentationCandidateObserved,
      message_presentation_sha256: messagePresentationSha256,
    });
  }

  /**
   * The closed reviewer branch.
   *
   * The complete card must reconstruct exactly; provider identity, absent edit
   * evidence, and a non-null matching `app_id` are required before any digest
   * is trusted; and both signed commitments must equal the recomputed values.
   * Title and item text stay in this bounded frame and are never persisted,
   * logged, traced, measured, or returned.
   */
  private verifyReviewerCardReaction(context: {
    input: VerifySlackReactionInput;
    connection: VerifiedSlackConnection;
    message: Record<string, unknown>;
    blocks: readonly unknown[];
    expectation: SlackReviewerPresentationExpectation | null;
  }): VerifiedSlackReaction | null {
    const { input, connection, message, blocks, expectation } = context;
    const reconstructed = reconstructReviewerCard({
      approval_id: input.approval_id,
      blocks,
      fallback_text: message['text'],
    });
    if (reconstructed === null) {
      if (expectation === null) {
        // Not a reviewer card: the caller only asked whether one was there.
        return null;
      }
      throw new SlackIntegrationProviderError(
        'Slack reviewer approval card does not match the closed grammar',
        'identity_mismatch',
      );
    }
    const identityVerified =
      input.expected_app_id !== null &&
      connection.app_id === input.expected_app_id &&
      message['app_id'] === input.expected_app_id &&
      message['edited'] === undefined;
    if (!identityVerified) {
      throw new SlackIntegrationProviderError(
        'Slack reviewer approval card identity or edit state is unusable',
        'identity_mismatch',
      );
    }
    if (expectation === null) {
      // Reaction-pair parsing only: the schema-v1 rejection of a reviewer card
      // proves the card's own frozen pair and produces no reviewer digests.
      // The selected reaction must be the live reject reaction, and the live
      // approve reaction -- not a caller-supplied one -- is the opposite.
      if (input.reaction_name !== reconstructed.reject_reaction) {
        throw new SlackIntegrationProviderError(
          'Slack reviewer approval card does not authorize this reaction',
          'identity_mismatch',
        );
      }
      return Object.freeze({
        observed: this.observedDecisiveReaction(
          message,
          reconstructed.reject_reaction,
          reconstructed.approve_reaction,
          input.user_id,
        ),
        presentation_candidate_observed: true,
        message_presentation_sha256: null,
        reviewer_card_reactions: Object.freeze({
          approve_reaction: reconstructed.approve_reaction,
          reject_reaction: reconstructed.reject_reaction,
        }),
      });
    }
    if (
      expectation.policy_id !== RESTRICTED_REVIEWER_POLICY_ID ||
      expectation.approve_reaction !== reconstructed.approve_reaction ||
      expectation.reject_reaction !== reconstructed.reject_reaction ||
      expectation.reviewer_release_draft_sha256 !==
        reconstructed.reviewer_release_draft_sha256 ||
      expectation.approval_presentation_sha256 !==
        reconstructed.approval_presentation_sha256
    ) {
      throw new SlackIntegrationProviderError(
        'Slack reviewer approval card does not match its signed commitments',
        'identity_mismatch',
      );
    }
    const providerEventSha256 = input.reviewer_provider_event_sha256;
    if (
      providerEventSha256 === undefined ||
      !SHA256_DIGEST.test(providerEventSha256)
    ) {
      throw new SlackIntegrationProviderError(
        'Slack reviewer verification input is invalid',
        'invalid_response',
      );
    }
    const observed = this.observedDecisiveReaction(
      message,
      input.reaction_name,
      input.opposite_reaction_name,
      input.user_id,
    );
    if (!observed) {
      return Object.freeze({
        observed: false,
        presentation_candidate_observed: true,
        message_presentation_sha256: null,
      });
    }
    const messagePresentationSha256 = canonicalSha256(
      reviewerMessagePresentationPreimage({
        provider_event_sha256: providerEventSha256,
        approval_presentation_sha256:
          reconstructed.approval_presentation_sha256,
        team_id: connection.team_id,
        enterprise_id: connection.enterprise_id,
        bot_user_id: connection.bot_user_id,
        bot_id: connection.bot_id,
        app_id: connection.app_id as string,
        actor_user_id: input.user_id,
        channel_id: input.channel_id,
        message_ts: input.message_ts,
        reaction_name: input.reaction_name,
      }),
    );
    return Object.freeze({
      observed: true,
      presentation_candidate_observed: true,
      message_presentation_sha256: null,
      reviewer_presentation: Object.freeze({
        reviewer_release_draft_sha256:
          reconstructed.reviewer_release_draft_sha256,
        approval_presentation_sha256:
          reconstructed.approval_presentation_sha256,
        message_presentation_sha256: messagePresentationSha256,
      }),
    });
  }

  /**
   * Parses only the frozen reaction pair from an exact organization-member
   * card for its schema-v1 rejection. Positive organization-member approval
   * still requires the separate schema-v3 expectation and proof above.
   */
  private verifyOrganizationMemberCardReaction(context: {
    input: VerifySlackReactionInput;
    connection: VerifiedSlackConnection;
    message: Record<string, unknown>;
    blocks: readonly unknown[];
  }): VerifiedSlackReaction | null {
    const { input, connection, message, blocks } = context;
    const reconstructed = reconstructOrganizationMemberCard({
      approval_id: input.approval_id,
      blocks,
      fallback_text: message['text'],
    });
    if (reconstructed === null) return null;

    const identityVerified =
      input.expected_app_id !== null &&
      connection.app_id === input.expected_app_id &&
      message['app_id'] === input.expected_app_id &&
      message['edited'] === undefined;
    if (!identityVerified) {
      throw new SlackIntegrationProviderError(
        'Slack organization-member approval card identity or edit state is unusable',
        'identity_mismatch',
      );
    }
    if (input.reaction_name !== reconstructed.reject_reaction) {
      throw new SlackIntegrationProviderError(
        'Slack organization-member approval card does not authorize this reaction',
        'identity_mismatch',
      );
    }
    return Object.freeze({
      observed: this.observedDecisiveReaction(
        message,
        reconstructed.reject_reaction,
        reconstructed.approve_reaction,
        input.user_id,
      ),
      presentation_candidate_observed: true,
      message_presentation_sha256: null,
      organization_member_card_reactions: Object.freeze({
        approve_reaction: reconstructed.approve_reaction,
        reject_reaction: reconstructed.reject_reaction,
      }),
    });
  }

  private observedDecisiveReaction(
    message: Record<string, unknown>,
    selectedReaction: string,
    oppositeReaction: string,
    userId: string,
  ): boolean {
    const input = {
      reaction_name: selectedReaction,
      opposite_reaction_name: oppositeReaction,
      user_id: userId,
    };
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
    const decisiveReactionNames = new Set<string>();
    for (const item of reactions) {
      const reaction = record(item, 'reaction');
      const reactionName = reaction['name'];
      if (
        reactionName !== input.reaction_name &&
        reactionName !== input.opposite_reaction_name
      ) {
        continue;
      }
      if (decisiveReactionNames.has(reactionName)) {
        throw new SlackIntegrationProviderError(
          'Slack reaction roster is ambiguous',
          'invalid_response',
        );
      }
      decisiveReactionNames.add(reactionName);
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
      if (unique.size !== users.length) {
        throw new SlackIntegrationProviderError(
          'Slack reaction roster is invalid',
          'invalid_response',
        );
      }
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
