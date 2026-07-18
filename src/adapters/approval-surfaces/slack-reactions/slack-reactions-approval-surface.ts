import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterOperationContext,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalSurfaceAdapter,
  DecisionBrief,
  JsonObject,
} from '../../../core/index.js';
import { AdapterError } from '../../../core/index.js';
import {
  SlackApiError,
  SlackWebApiClient,
  type SlackReaction,
} from './slack-web-api-client.js';

export const SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_ID = 'slack-reactions';
export const SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION = '1.0.0';

const SURFACE = 'slack';
const DEFAULT_APPROVE_REACTION = 'white_check_mark';
const DEFAULT_REJECT_REACTION = 'x';
const REACTION_NAME_RE = /^[a-z0-9_+-]+$/;
const MAX_SUMMARY_ITEMS = 10;
const MAX_ITEM_CHARS = 240;
const SLACK_HEADER_MAX_CHARS = 150;
const SLACK_SECTION_MAX_CHARS = 3_000;

type ReviewerReactionState = 'present' | 'absent' | 'unknown';

/**
 * The store port this surface resolves against. Implemented by the product
 * layer's `DecisionNodeStore` and injected by the composition root, so the
 * adapter stays independent of product internals while every surface (CLI,
 * Slack) shares one source of truth.
 */
export interface ApprovalDecisionStoreView {
  approval_id: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_at: string | null;
  reviewed_by: string | null;
  reason: string | null;
  brief: DecisionBrief;
  published: readonly { surface: string; reference: JsonObject }[];
}

export interface ApprovalDecisionStore {
  ensureRequested(request: ApprovalRequest): Promise<ApprovalDecisionStoreView>;
  recordPublished(input: {
    processingKey: string;
    surface: string;
    reference: JsonObject;
  }): Promise<ApprovalDecisionStoreView>;
  resolve(input: {
    approvalId: string;
    status: 'approved' | 'rejected';
    reviewedBy: string;
    reason?: string | null;
    surface: string;
    metadata?: JsonObject;
  }): Promise<ApprovalDecisionStoreView>;
}

export interface SlackReactionsApprovalSurfaceOptions {
  store: ApprovalDecisionStore;
  environment?: NodeJS.ProcessEnv;
  now?: () => string;
  fetchImpl?: typeof fetch;
}

interface SlackReactionsSettings {
  channelId: string;
  reviewerUserId: string;
  reviewerName: string;
  approveReaction: string;
  rejectReaction: string;
  requestTimeoutMs: number | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function settingsFrom(config: AdapterConfig): SlackReactionsSettings {
  const settings = config.settings;
  const reviewer = isPlainObject(settings['reviewer'])
    ? settings['reviewer']
    : {};
  return {
    channelId:
      typeof settings['channel_id'] === 'string' ? settings['channel_id'] : '',
    reviewerUserId:
      typeof reviewer['slack_user_id'] === 'string'
        ? reviewer['slack_user_id']
        : '',
    reviewerName: typeof reviewer['name'] === 'string' ? reviewer['name'] : '',
    approveReaction:
      typeof settings['approve_reaction'] === 'string'
        ? settings['approve_reaction']
        : DEFAULT_APPROVE_REACTION,
    rejectReaction:
      typeof settings['reject_reaction'] === 'string'
        ? settings['reject_reaction']
        : DEFAULT_REJECT_REACTION,
    requestTimeoutMs:
      typeof settings['request_timeout_ms'] === 'number'
        ? settings['request_timeout_ms']
        : undefined,
  };
}

function truncateCharacters(value: string, maximum: number): string {
  const characters = [...value];
  return characters.length <= maximum
    ? value
    : `${characters.slice(0, maximum - 1).join('')}…`;
}

function boundedSingleLine(value: string, maximum: number): string {
  return truncateCharacters(value.replace(/\s+/g, ' ').trim(), maximum);
}

function escapeSlackControlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function summaryText(
  label: string,
  statements: readonly string[],
): string | undefined {
  if (statements.length === 0) return undefined;
  const shown = statements.slice(0, MAX_SUMMARY_ITEMS);
  const lines = [
    `${label}:`,
    ...shown.map(
      (statement) => `• ${boundedSingleLine(statement, MAX_ITEM_CHARS)}`,
    ),
  ];
  if (statements.length > shown.length) {
    lines.push(`… and ${statements.length - shown.length} more`);
  }
  return truncateCharacters(lines.join('\n'), SLACK_SECTION_MAX_CHARS);
}

function mapSlackError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  if (error instanceof SlackApiError) {
    switch (error.code) {
      case 'auth':
        return new AdapterError('unauthorized', error.message, false);
      case 'rate_limited':
        return new AdapterError('rate_limited', error.message, true);
      case 'transient':
        return new AdapterError('temporarily_unavailable', error.message, true);
      case 'unknown_outcome':
        return new AdapterError('unknown_outcome', error.message, true);
      case 'invalid':
        return new AdapterError('permanently_rejected', error.message, false);
    }
  }
  return new AdapterError(
    'temporarily_unavailable',
    `Slack approval surface failed: ${(error as Error).message}`,
    true,
  );
}

function decision(view: ApprovalDecisionStoreView): ApprovalDecision {
  if (view.status === 'approved') {
    return {
      status: 'approved',
      reviewed_at: view.reviewed_at as string,
      reviewed_by: view.reviewed_by as string,
      reason: view.reason,
      approved_brief: view.brief,
    };
  }
  if (view.status === 'rejected') {
    return {
      status: 'rejected',
      reviewed_at: view.reviewed_at as string,
      reviewed_by: view.reviewed_by as string,
      reason: view.reason,
      approved_brief: null,
    };
  }
  return {
    status: 'pending',
    reviewed_at: null,
    reviewed_by: null,
    reason: null,
    approved_brief: null,
  };
}

/**
 * Slack approval surface, reactions flavor: posts each pending decision brief
 * to a channel once, then polls that message on every review cycle. The
 * configured reviewer resolves by reacting with the approve or reject emoji;
 * their latest thread reply (written before reacting) becomes the reason.
 * Everything ambiguous fails closed to `pending`.
 */
export class SlackReactionsApprovalSurface implements ApprovalSurfaceAdapter {
  readonly identity: ApprovalSurfaceAdapter['identity'];
  private readonly settings: SlackReactionsSettings;
  private readonly store: ApprovalDecisionStore;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => string;
  private readonly fetchImpl: typeof fetch | undefined;
  private client: SlackWebApiClient | undefined;

  constructor(
    private readonly config: AdapterConfig,
    options: SlackReactionsApprovalSurfaceOptions,
  ) {
    this.settings = settingsFrom(config);
    this.identity = Object.freeze({
      kind: 'approval-surface' as const,
      adapter_id: SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_ID,
      instance_id: config.instance_id,
      version: SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION,
    });
    this.store = options.store;
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? (() => new Date().toISOString());
    this.fetchImpl = options.fetchImpl;
  }

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    const errors: string[] = [];
    if (config.adapter_id !== SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_ID) {
      errors.push(
        `adapter_id must be '${SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_ID}'`,
      );
    }
    if (!/^[a-z][a-z0-9-]*$/.test(config.instance_id)) {
      errors.push(
        'instance_id must use lowercase letters, numbers, and hyphens',
      );
    } else if (config.instance_id !== this.identity.instance_id) {
      errors.push('instance_id does not match the registered adapter instance');
    }
    if (!isNonEmptyString(config.credential_ref)) {
      errors.push('credential_ref is required');
    } else if (!config.credential_ref.startsWith('env:')) {
      errors.push('credential_ref must be an env: reference');
    }
    const allowedSettings = new Set([
      'channel_id',
      'reviewer',
      'approve_reaction',
      'reject_reaction',
      'request_timeout_ms',
    ]);
    for (const key of Object.keys(config.settings)) {
      if (!allowedSettings.has(key))
        errors.push(`settings.${key} is not supported`);
    }
    const settings = settingsFrom(config);
    if (!isNonEmptyString(settings.channelId)) {
      errors.push('settings.channel_id is required');
    }
    // Exactly one reviewer: Slack reactions carry no timestamps, so a
    // multi-reviewer race has no defined winner and attribution would be
    // arbitrary. Multi-reviewer support needs an interaction model upgrade.
    if (
      !isNonEmptyString(settings.reviewerUserId) ||
      !isNonEmptyString(settings.reviewerName)
    ) {
      errors.push(
        'settings.reviewer must name one reviewer with slack_user_id and name',
      );
    }
    for (const [key, reaction] of [
      ['approve_reaction', settings.approveReaction],
      ['reject_reaction', settings.rejectReaction],
    ] as const) {
      if (!REACTION_NAME_RE.test(reaction)) {
        errors.push(`settings.${key} must be a Slack reaction name`);
      }
    }
    if (settings.approveReaction === settings.rejectReaction) {
      errors.push('approve and reject reactions must differ');
    }
    if (
      settings.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(settings.requestTimeoutMs) ||
        settings.requestTimeoutMs < 1_000 ||
        settings.requestTimeoutMs > 60_000)
    ) {
      errors.push(
        'settings.request_timeout_ms must be 1000-60000 milliseconds',
      );
    }
    return { ok: errors.length === 0, errors };
  }

  async healthCheck(
    operation?: AdapterOperationContext,
  ): Promise<AdapterHealth> {
    const checkedAt = this.now();
    const validation = this.validateConfig(this.config);
    if (!validation.ok) {
      return {
        status: 'unavailable',
        checked_at: checkedAt,
        message: 'Slack approval surface configuration is invalid',
        details: { error_count: validation.errors.length },
      };
    }
    let client: SlackWebApiClient;
    try {
      client = this.apiClient();
    } catch {
      return {
        status: 'unauthorized',
        checked_at: checkedAt,
        message: 'Slack credentials are unavailable',
      };
    }
    try {
      await client.authTest(operation?.signal);
      return { status: 'healthy', checked_at: checkedAt };
    } catch (error) {
      const mapped = mapSlackError(error);
      return {
        status: mapped.code === 'unauthorized' ? 'unauthorized' : 'degraded',
        checked_at: checkedAt,
        message: mapped.message,
        details: { retryable: mapped.retryable },
      };
    }
  }

  async review(
    request: ApprovalRequest,
    operation?: AdapterOperationContext,
  ): Promise<ApprovalDecision> {
    const validation = this.validateConfig(this.config);
    if (!validation.ok) {
      throw new AdapterError(
        'invalid_config',
        'Slack approval surface configuration is invalid',
        false,
      );
    }
    // Stage the node before any Slack traffic: once the request is stored,
    // the CLI surface can resolve it even if every Slack call below fails.
    const staged = await this.store.ensureRequested(request);
    if (staged.status !== 'pending') return decision(staged);

    try {
      const published = await this.ensurePublished(
        request.processing_key,
        staged,
        operation,
      );
      const posted = published.published.find(
        (entry) => entry.surface === SURFACE,
      );
      if (posted === undefined || published.status !== 'pending') {
        return decision(published);
      }
      const channel = posted.reference['channel_id'];
      const messageTs = posted.reference['message_ts'];
      if (!isNonEmptyString(channel) || !isNonEmptyString(messageTs)) {
        throw new AdapterError(
          'permanently_rejected',
          'Slack publication reference is malformed',
          false,
        );
      }
      return await this.pollReactions(
        request,
        published,
        channel,
        messageTs,
        operation,
      );
    } catch (error) {
      throw mapSlackError(error);
    }
  }

  private async ensurePublished(
    processingKey: string,
    staged: ApprovalDecisionStoreView,
    operation?: AdapterOperationContext,
  ): Promise<ApprovalDecisionStoreView> {
    if (staged.published.some((entry) => entry.surface === SURFACE)) {
      return staged;
    }
    // Posting then recording is a dual write: a crash between the two can
    // produce a duplicate message on retry. Posting is at-least-once by
    // design; the recorded reference always wins as the polled message.
    const posted = await this.apiClient().postMessage(
      {
        channel: this.settings.channelId,
        text: this.messageText(staged.brief),
        blocks: this.messageBlocks(staged.brief),
      },
      operation?.signal,
    );
    return await this.store.recordPublished({
      processingKey,
      surface: SURFACE,
      reference: { channel_id: posted.channel, message_ts: posted.ts },
    });
  }

  private async pollReactions(
    request: ApprovalRequest,
    state: ApprovalDecisionStoreView,
    channel: string,
    messageTs: string,
    operation?: AdapterOperationContext,
  ): Promise<ApprovalDecision> {
    const reactions = await this.apiClient().reactionsGet(
      channel,
      messageTs,
      operation?.signal,
    );
    const approved = this.reviewerReactionState(
      reactions,
      this.settings.approveReaction,
    );
    const rejected = this.reviewerReactionState(
      reactions,
      this.settings.rejectReaction,
    );
    // Slack may truncate either decisive reaction's user roster. Treating an
    // unknown as absent could make the opposite reaction win, so any unknown
    // keeps the node pending.
    if (approved === 'unknown' || rejected === 'unknown')
      return decision(state);
    // Both reactions present is a human conflict with no orderable winner
    // (Slack reactions carry no timestamps): fail closed and stay pending
    // until the channel or the CLI sorts it out.
    if (approved === rejected) return decision(state);

    const reason = await this.latestReviewerReply(
      channel,
      messageTs,
      operation,
    );
    let resolved: ApprovalDecisionStoreView;
    try {
      resolved = await this.store.resolve({
        approvalId: state.approval_id,
        status: approved === 'present' ? 'approved' : 'rejected',
        reviewedBy: this.settings.reviewerName,
        reason,
        surface: SURFACE,
        metadata: {
          slack: {
            channel_id: channel,
            message_ts: messageTs,
            reviewer_user_id: this.settings.reviewerUserId,
          },
        },
      });
    } catch {
      // Another surface (e.g. the CLI) resolved this node first. The store
      // is first-resolution-wins; report the winner instead of failing.
      resolved = await this.store.ensureRequested(request);
      if (resolved.status === 'pending') {
        throw new AdapterError(
          'temporarily_unavailable',
          'Slack approval resolution could not be recorded',
          true,
        );
      }
    }
    return decision(resolved);
  }

  private reviewerReactionState(
    reactions: readonly SlackReaction[],
    name: string,
  ): ReviewerReactionState {
    const reaction = reactions.find((entry) => entry.name === name);
    if (reaction === undefined) return 'absent';
    // Slack may omit reactors from `users` while `count` stays complete.
    // Absence cannot be proven from an incomplete roster, and treating the
    // entry as false could let the opposite decision resolve incorrectly.
    if (reaction.count !== new Set(reaction.users).size) {
      return 'unknown';
    }
    return reaction.users.includes(this.settings.reviewerUserId)
      ? 'present'
      : 'absent';
  }

  private async latestReviewerReply(
    channel: string,
    messageTs: string,
    operation?: AdapterOperationContext,
  ): Promise<string | null> {
    const replies = await this.apiClient().conversationsReplies(
      channel,
      messageTs,
      operation?.signal,
    );
    const reviewerReplies = replies
      .filter(
        (reply) =>
          reply.user === this.settings.reviewerUserId &&
          reply.text.trim().length > 0,
      )
      .sort((left, right) => Number(left.ts) - Number(right.ts));
    const latest = reviewerReplies[reviewerReplies.length - 1];
    return latest === undefined ? null : latest.text.trim();
  }

  private messageText(brief: DecisionBrief): string {
    const title = brief.meeting.title ?? brief.meeting.id;
    return `Decision brief awaiting approval: ${escapeSlackControlText(
      boundedSingleLine(title, SLACK_HEADER_MAX_CHARS),
    )}`;
  }

  private messageBlocks(brief: DecisionBrief): readonly unknown[] {
    const title = brief.meeting.title ?? brief.meeting.id;
    const summaries = [
      summaryText(
        'Decisions',
        brief.decisions.map((signal) => signal.text),
      ),
      summaryText(
        'Actions',
        brief.actions.map((signal) => signal.text),
      ),
    ].filter((text): text is string => text !== undefined);
    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: boundedSingleLine(title, SLACK_HEADER_MAX_CHARS),
          emoji: true,
        },
      },
      ...summaries.map((text) => ({
        type: 'section',
        // Meeting-derived content remains plain text so strings such as
        // <!channel> or <@U123> cannot become active Slack mentions.
        text: { type: 'plain_text', text, emoji: true },
      })),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `React :${this.settings.approveReaction}: to approve or :${this.settings.rejectReaction}: to reject. To record a reason, reply in this thread *before* reacting.`,
          },
        ],
      },
    ];
  }

  private apiClient(): SlackWebApiClient {
    if (this.client !== undefined) return this.client;
    const reference = this.config.credential_ref;
    const variable =
      reference !== undefined && reference.startsWith('env:')
        ? reference.slice('env:'.length)
        : undefined;
    const token =
      variable === undefined ? undefined : this.environment[variable];
    if (!isNonEmptyString(token)) {
      throw new AdapterError(
        'unauthorized',
        'Slack credentials are unavailable',
        false,
      );
    }
    this.client = new SlackWebApiClient(token, {
      ...(this.settings.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.settings.requestTimeoutMs }),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
    return this.client;
  }
}

export function createSlackReactionsApprovalSurface(
  config: AdapterConfig,
  options: SlackReactionsApprovalSurfaceOptions,
): SlackReactionsApprovalSurface {
  return new SlackReactionsApprovalSurface(config, options);
}
