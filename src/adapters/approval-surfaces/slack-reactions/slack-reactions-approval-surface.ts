import { createHash } from 'node:crypto';
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
  JsonValue,
} from '../../../core/index.js';
import { AdapterError } from '../../../core/index.js';
import {
  SlackApiError,
  SlackWebApiClient,
  type SlackAuthIdentity,
  type SlackReaction,
} from '../../shared/slack/slack-web-api-client.js';
import {
  boundedSlackLine as boundedSingleLine,
  escapeSlackControlText,
  slackSummaryText as summaryText,
} from '../../shared/slack/message-format.js';

export const SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_ID = 'slack-reactions';
export const SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION = '1.0.0';

const SURFACE = 'slack';
// Decision publication slots are immutable and keyed by surface. This
// versioned slot lets an organization-managed installation append one
// authority-verifiable replacement for a pre-marker Slack card without
// rewriting its audit history or weakening live Authority verification.
const AUTHORITY_MARKED_SURFACE = 'slack-authority-v1';
export const DEFAULT_APPROVE_REACTION = 'white_check_mark';
export const DEFAULT_REJECT_REACTION = 'x';
const REACTION_NAME_RE = /^[a-z0-9_+-]+$/;
const SLACK_HEADER_MAX_CHARS = 150;

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
  requested_metadata?: JsonObject;
  published: readonly { surface: string; reference: JsonObject }[];
}

export type SlackPresentationEvidence = JsonObject & {
  rendered_blocks_sha256: string;
  rendered_blocks: JsonValue;
  provider_identity: SlackProviderIdentityEvidence;
};

export type SlackProviderIdentityEvidence = JsonObject & {
  provider: 'slack';
  team_id: string;
  enterprise_id: string | null;
  bot_user_id: string;
  bot_id: string | null;
  app_id: string | null;
};

export type SlackResolutionEvidence = JsonObject & {
  provider_identity: SlackProviderIdentityEvidence;
  actor: JsonObject & {
    team_id: string;
    user_id: string;
    display_name: string;
    reaction_name: string;
    channel_id: string;
    message_ts: string;
    provider_occurred_at: null;
    reason_reply:
      | (JsonObject & {
          message_ts: string;
          author_user_id: string;
          text: string;
        })
      | null;
  };
};

export interface ApprovalActionAuthorizationRequest {
  approval_id: string;
  action: 'approve' | 'reject';
  adapter_identity: ApprovalSurfaceAdapter['identity'];
  provider_identity: SlackProviderIdentityEvidence;
  actor: {
    provider: 'slack';
    team_id: string;
    user_id: string;
  };
  channel_id: string;
  message_ts: string;
  reaction_name: string;
}

/**
 * Action-time authorization port supplied by the product composition root.
 * Implementations may consult a central control plane, but the Slack adapter
 * owns the fail-closed ordering: an allow result is required before resolve.
 */
export interface ApprovalActionAuthorizer {
  authorize(
    request: ApprovalActionAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<{ allowed: boolean; reason?: string }>;
}

export interface ApprovalDecisionStore {
  ensureRequested(request: ApprovalRequest): Promise<ApprovalDecisionStoreView>;
  recordPublished(input: {
    processingKey: string;
    surface: string;
    reference: JsonObject;
    /** Raw adapter evidence; the product store owns durable enrichment. */
    presentationEvidence?: SlackPresentationEvidence;
  }): Promise<ApprovalDecisionStoreView>;
  resolve(input: {
    approvalId: string;
    status: 'approved' | 'rejected';
    reviewedBy: string;
    reason?: string | null;
    surface: string;
    metadata?: JsonObject;
    /** Raw adapter evidence; the product store owns durable enrichment. */
    resolutionEvidence?: SlackResolutionEvidence;
  }): Promise<ApprovalDecisionStoreView>;
}

export interface SlackReactionsApprovalSurfaceOptions {
  store: ApprovalDecisionStore;
  approvalActionAuthorizer?: ApprovalActionAuthorizer;
  environment?: NodeJS.ProcessEnv;
  credentialResolver?: (reference: string) => string | undefined;
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

interface ActiveFederationPresentation {
  candidateContextSha256: string;
  providerIdentity: SlackProviderIdentityEvidence;
  publication: {
    payloadScope: string;
    audience: string;
    sensitivity: string;
    retention: string;
    rawMeetingContent: string;
    participantObservations: string;
  };
}

export interface RenderSlackApprovalBlocksInput {
  brief: DecisionBrief;
  approvalId?: string;
  requestedMetadata?: JsonObject;
  approveReaction: string;
  rejectReaction: string;
}

type ReviewerReplyEvidence = JsonObject & {
  user: string;
  text: string;
  ts: string;
};

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

function invalidFederationPresentation(detail: string): AdapterError {
  return new AdapterError(
    'permanently_rejected',
    `Slack approval federation presentation is invalid: ${detail}`,
    false,
  );
}

function requiredPresentationString(
  object: Record<string, unknown>,
  key: string,
): string {
  const value = object[key];
  if (!isNonEmptyString(value)) throw invalidFederationPresentation(key);
  return value;
}

function nullablePresentationString(
  object: Record<string, unknown>,
  key: string,
): string | null {
  const value = object[key];
  if (value === null) return null;
  if (!isNonEmptyString(value)) throw invalidFederationPresentation(key);
  return value;
}

function activeFederationPresentation(
  requestedMetadata: JsonObject | undefined,
): ActiveFederationPresentation | undefined {
  const federation = requestedMetadata?.['federation'];
  if (federation === undefined) return undefined;
  if (!isPlainObject(federation)) {
    throw invalidFederationPresentation('federation');
  }
  const publication = federation['publication'];
  if (!isPlainObject(publication)) {
    throw invalidFederationPresentation('publication');
  }
  const audience = publication['audience'];
  if (!isPlainObject(audience)) {
    throw invalidFederationPresentation('publication.audience');
  }
  const audienceScope = requiredPresentationString(audience, 'scope');
  const subjects = audience['subjects'];
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw invalidFederationPresentation('publication.audience.subjects');
  }
  const renderedSubjects = subjects.map((subject, index) => {
    if (!isPlainObject(subject)) {
      throw invalidFederationPresentation(
        `publication.audience.subjects[${index}]`,
      );
    }
    return `${requiredPresentationString(
      subject,
      'kind',
    )}:${requiredPresentationString(subject, 'id')}`;
  });
  const retention = publication['retention'];
  if (!isPlainObject(retention)) {
    throw invalidFederationPresentation('publication.retention');
  }
  const retentionKind = requiredPresentationString(retention, 'kind');
  let renderedRetention: string;
  if (retentionKind === 'indefinite') {
    renderedRetention = 'indefinite';
  } else if (
    retentionKind === 'duration' &&
    Number.isSafeInteger(retention['days']) &&
    Number(retention['days']) > 0
  ) {
    renderedRetention = `duration (${String(retention['days'])} days)`;
  } else {
    throw invalidFederationPresentation('publication.retention');
  }

  const approvalSurface = federation['approval_surface'];
  const connection = isPlainObject(approvalSurface)
    ? approvalSurface['connection']
    : undefined;
  const providerIdentity = isPlainObject(connection)
    ? connection['provider_identity']
    : undefined;
  if (!isPlainObject(providerIdentity)) {
    throw invalidFederationPresentation(
      'approval_surface.connection.provider_identity',
    );
  }
  if (providerIdentity['provider'] !== 'slack') {
    throw invalidFederationPresentation(
      'approval_surface.connection.provider_identity.provider',
    );
  }

  const botUserId = requiredPresentationString(providerIdentity, 'bot_user_id');

  return {
    candidateContextSha256: requiredPresentationString(
      federation,
      'candidate_context_sha256',
    ),
    providerIdentity: {
      provider: 'slack',
      team_id: requiredPresentationString(providerIdentity, 'team_id'),
      enterprise_id: nullablePresentationString(
        providerIdentity,
        'enterprise_id',
      ),
      bot_user_id: botUserId,
      bot_id: nullablePresentationString(providerIdentity, 'bot_id'),
      app_id: nullablePresentationString(providerIdentity, 'app_id'),
    },
    publication: {
      payloadScope: requiredPresentationString(publication, 'payload_scope'),
      audience: `${audienceScope} [${renderedSubjects.join(', ')}]`,
      sensitivity: requiredPresentationString(publication, 'sensitivity'),
      retention: renderedRetention,
      rawMeetingContent: requiredPresentationString(
        publication,
        'raw_meeting_content',
      ),
      participantObservations: requiredPresentationString(
        publication,
        'participant_observations',
      ),
    },
  };
}

function liveProviderEvidence(
  identity: SlackAuthIdentity,
): SlackProviderIdentityEvidence {
  return {
    provider: 'slack',
    team_id: identity.team_id,
    enterprise_id: identity.enterprise_id,
    bot_user_id: identity.user_id,
    bot_id: identity.bot_id,
    app_id: identity.app_id,
  };
}

function assertSameProviderIdentity(
  frozen: SlackProviderIdentityEvidence,
  live: SlackProviderIdentityEvidence,
): void {
  if (!jsonEquivalent(frozen, live)) {
    throw new AdapterError(
      'unauthorized',
      'Slack approval credential identity no longer matches the frozen connection',
      false,
    );
  }
}

function assertReviewerIsNotBot(
  federation: ActiveFederationPresentation,
  reviewerUserId: string,
): void {
  if (federation.providerIdentity.bot_user_id === reviewerUserId) {
    throw new AdapterError(
      'permanently_rejected',
      'Slack approval reviewer must be a human distinct from the bot user',
      false,
    );
  }
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJsonValue(value[key])]),
  );
}

function jsonEquivalent(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(sortedJsonValue(left)) ===
    JSON.stringify(sortedJsonValue(right))
  );
}

function jsonSha256(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortedJsonValue(value)))
    .digest('hex')}`;
}

function slackReference(
  reference: JsonObject,
): { channel: string; messageTs: string } | undefined {
  const nested = reference['slack'];
  if (isPlainObject(nested)) {
    const channel = nested['channel_id'];
    const messageTs = nested['message_ts'];
    if (isNonEmptyString(channel) && isNonEmptyString(messageTs)) {
      return { channel, messageTs };
    }
  }
  const channel = reference['channel_id'];
  const messageTs = reference['message_ts'];
  return isNonEmptyString(channel) && isNonEmptyString(messageTs)
    ? { channel, messageTs }
    : undefined;
}

/**
 * Version-1 approval-card renderer. Identity-enabled capture calls this same
 * pure function when validating durable presentation evidence, so changing a
 * stored block and merely recomputing its digest cannot rewrite what the
 * reviewer was asked to approve.
 */
export function renderSlackApprovalBlocks(
  input: RenderSlackApprovalBlocksInput,
): JsonValue[] {
  const federation = activeFederationPresentation(input.requestedMetadata);
  const title = input.brief.meeting.title ?? input.brief.meeting.id;
  const summaries = [
    summaryText(
      'Decisions',
      input.brief.decisions.map((signal) => signal.text),
    ),
    summaryText(
      'Actions',
      input.brief.actions.map((signal) => signal.text),
    ),
  ].filter((value): value is string => value !== undefined);
  const identified = input.approvalId !== undefined;
  const active = federation !== undefined && identified;
  const federationSummary = !active
    ? []
    : [
        {
          type: 'section',
          text: {
            type: 'plain_text',
            text: [
              'Publication:',
              `• Payload scope: ${federation.publication.payloadScope}`,
              `• Audience: ${federation.publication.audience}`,
              `• Sensitivity: ${federation.publication.sensitivity}`,
              `• Retention: ${federation.publication.retention}`,
              `• Raw meeting content: ${federation.publication.rawMeetingContent}`,
              `• Participant observations: ${federation.publication.participantObservations}`,
              `• Candidate digest: ${federation.candidateContextSha256}`,
              `• Approval ID: ${input.approvalId}`,
            ].join('\n'),
            emoji: true,
          },
        },
      ];
  const blocks: JsonValue[] = [
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
    ...federationSummary,
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `React :${input.approveReaction}: to approve or :${input.rejectReaction}: to reject. To record a reason, reply in this thread *before* reacting.`,
          ...(active ? { verbatim: false } : {}),
        },
      ],
    },
  ];
  if (!identified) return blocks;
  return blocks.map((block, index) => ({
    ...(block as JsonObject),
    block_id: `echo-approval-${input.approvalId}-${index}`,
  }));
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

function mapAuthorizationError(error: unknown): AdapterError {
  const mapped =
    error instanceof AdapterError
      ? error
      : new AdapterError(
          'temporarily_unavailable',
          error instanceof Error ? error.message : 'unknown error',
          true,
        );
  return new AdapterError(
    mapped.code,
    `Slack approval action authorization failed: ${mapped.message}`,
    mapped.retryable,
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
  private readonly approvalActionAuthorizer:
    | ApprovalActionAuthorizer
    | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly credentialResolver: (
    reference: string,
  ) => string | undefined;
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
    this.approvalActionAuthorizer = options.approvalActionAuthorizer;
    this.environment = options.environment ?? process.env;
    this.credentialResolver =
      options.credentialResolver ??
      ((reference) => {
        const variable = reference.startsWith('env:')
          ? reference.slice('env:'.length)
          : undefined;
        return variable === undefined ? undefined : this.environment[variable];
      });
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
    } else if (
      !config.credential_ref.startsWith('env:') &&
      !config.credential_ref.startsWith('file:')
    ) {
      errors.push('credential_ref must be an env: or file: reference');
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
      const publicationSurface = this.publicationSurface(staged);
      const published = await this.ensurePublished(
        request.processing_key,
        staged,
        operation,
      );
      const posted = published.published.find(
        (entry) => entry.surface === publicationSurface,
      );
      if (posted === undefined || published.status !== 'pending') {
        return decision(published);
      }
      const reference = slackReference(posted.reference);
      if (reference === undefined) {
        throw new AdapterError(
          'permanently_rejected',
          'Slack publication reference is malformed',
          false,
        );
      }
      return await this.pollReactions(
        request,
        published,
        reference.channel,
        reference.messageTs,
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
    const publicationSurface = this.publicationSurface(staged);
    if (
      staged.published.some(
        (entry) => entry.surface === publicationSurface,
      )
    ) {
      return staged;
    }
    // Posting then recording is a dual write: a crash between the two can
    // produce a duplicate message on retry. Posting is at-least-once by
    // design; the recorded reference always wins as the polled message.
    const federation = activeFederationPresentation(staged.requested_metadata);
    const requiresExactPostedBlocks =
      federation !== undefined ||
      publicationSurface === AUTHORITY_MARKED_SURFACE;
    let liveProviderIdentity: SlackProviderIdentityEvidence | undefined;
    if (federation !== undefined) {
      assertReviewerIsNotBot(federation, this.settings.reviewerUserId);
      liveProviderIdentity = liveProviderEvidence(
        await this.apiClient().authIdentity(operation?.signal),
      );
      assertSameProviderIdentity(
        federation.providerIdentity,
        liveProviderIdentity,
      );
    }
    const blocks = renderSlackApprovalBlocks({
      brief: staged.brief,
      approvalId: staged.approval_id,
      requestedMetadata: staged.requested_metadata,
      approveReaction: this.settings.approveReaction,
      rejectReaction: this.settings.rejectReaction,
    });
    const posted = await this.apiClient().postMessage(
      {
        channel: this.settings.channelId,
        text: this.messageText(staged.brief),
        blocks,
        strictEvidence: requiresExactPostedBlocks,
      },
      operation?.signal,
    );
    if (
      requiresExactPostedBlocks &&
      (posted.blocks === undefined || !jsonEquivalent(blocks, posted.blocks))
    ) {
      throw new AdapterError(
        'unknown_outcome',
        'Slack did not acknowledge the exact approval presentation',
        true,
      );
    }
    let presentationEvidence: SlackPresentationEvidence | undefined;
    if (federation !== undefined) {
      presentationEvidence = {
        rendered_blocks_sha256: jsonSha256(posted.blocks),
        rendered_blocks: JSON.parse(JSON.stringify(posted.blocks)) as JsonValue,
        provider_identity:
          liveProviderIdentity as SlackProviderIdentityEvidence,
      };
    }
    return await this.store.recordPublished({
      processingKey,
      surface: publicationSurface,
      reference: { channel_id: posted.channel, message_ts: posted.ts },
      ...(presentationEvidence === undefined ? {} : { presentationEvidence }),
    });
  }

  private publicationSurface(staged: ApprovalDecisionStoreView): string {
    // Federation publications already authenticated their exact marked blocks
    // before this organization-authority bridge existed. Plain pre-authority
    // Slack slots did not, so central authorization uses a new append-only slot
    // and thereafter polls only that durable replacement reference.
    return this.approvalActionAuthorizer !== undefined &&
      activeFederationPresentation(staged.requested_metadata) === undefined
      ? AUTHORITY_MARKED_SURFACE
      : SURFACE;
  }

  private async pollReactions(
    request: ApprovalRequest,
    state: ApprovalDecisionStoreView,
    channel: string,
    messageTs: string,
    operation?: AdapterOperationContext,
  ): Promise<ApprovalDecision> {
    const federation = activeFederationPresentation(state.requested_metadata);
    const centralizedAuthorization =
      this.approvalActionAuthorizer !== undefined;
    const strictEvidence =
      federation !== undefined || centralizedAuthorization;
    if (federation !== undefined) {
      assertReviewerIsNotBot(federation, this.settings.reviewerUserId);
    }
    const reactions = await this.apiClient().reactionsGet(
      channel,
      messageTs,
      operation?.signal,
      { strict: strictEvidence },
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

    const latestReply = await this.latestReviewerReply(
      channel,
      messageTs,
      operation,
      strictEvidence,
    );
    const reason = latestReply === null ? null : latestReply.text.trim();
    const reactionName =
      approved === 'present'
        ? this.settings.approveReaction
        : this.settings.rejectReaction;
    const liveProviderIdentity = strictEvidence
      ? liveProviderEvidence(
          await this.apiClient().authIdentity(operation?.signal),
        )
      : undefined;
    if (federation !== undefined) {
      assertSameProviderIdentity(
        federation.providerIdentity,
        liveProviderIdentity as SlackProviderIdentityEvidence,
      );
    }
    const authorizer = this.approvalActionAuthorizer;
    if (authorizer !== undefined) {
      const providerIdentity =
        liveProviderIdentity as SlackProviderIdentityEvidence;
      let authorization: Awaited<ReturnType<typeof authorizer.authorize>>;
      try {
        authorization = await authorizer.authorize(
          {
            approval_id: state.approval_id,
            action: approved === 'present' ? 'approve' : 'reject',
            adapter_identity: this.identity,
            provider_identity: providerIdentity,
            actor: {
              provider: 'slack',
              team_id: providerIdentity.team_id,
              user_id: this.settings.reviewerUserId,
            },
            channel_id: channel,
            message_ts: messageTs,
            reaction_name: reactionName,
          },
          operation?.signal,
        );
      } catch (error) {
        throw mapAuthorizationError(error);
      }
      if (
        !isPlainObject(authorization) ||
        typeof authorization.allowed !== 'boolean'
      ) {
        throw new AdapterError(
          'temporarily_unavailable',
          'Slack approval action authorization returned an invalid result',
          true,
        );
      }
      if (authorization.allowed !== true) {
        throw new AdapterError(
          'unauthorized',
          `Slack approval action was denied${
            isNonEmptyString(authorization.reason)
              ? `: ${authorization.reason}`
              : ''
          }`,
          false,
        );
      }
    }
    operation?.signal?.throwIfAborted();
    let resolved: ApprovalDecisionStoreView;
    try {
      resolved = await this.store.resolve({
        approvalId: state.approval_id,
        status: approved === 'present' ? 'approved' : 'rejected',
        reviewedBy: this.settings.reviewerName,
        reason,
        surface: SURFACE,
        ...(federation === undefined
          ? {
              metadata: {
                slack: {
                  channel_id: channel,
                  message_ts: messageTs,
                  reviewer_user_id: this.settings.reviewerUserId,
                },
              },
            }
          : {
              resolutionEvidence: {
                provider_identity:
                  liveProviderIdentity as SlackProviderIdentityEvidence,
                actor: {
                  team_id: federation.providerIdentity.team_id,
                  user_id: this.settings.reviewerUserId,
                  display_name: this.settings.reviewerName,
                  reaction_name: reactionName,
                  channel_id: channel,
                  message_ts: messageTs,
                  provider_occurred_at: null,
                  reason_reply:
                    latestReply === null
                      ? null
                      : {
                          message_ts: latestReply.ts,
                          author_user_id: latestReply.user,
                          text: latestReply.text,
                        },
                },
              },
            }),
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
    strict = false,
  ): Promise<ReviewerReplyEvidence | null> {
    const replies = await this.apiClient().conversationsReplies(
      channel,
      messageTs,
      operation?.signal,
      { strict },
    );
    const reviewerReplies = replies
      .filter(
        (reply) =>
          reply.user === this.settings.reviewerUserId &&
          reply.text.trim().length > 0,
      )
      .sort((left, right) => Number(left.ts) - Number(right.ts));
    const latest = reviewerReplies[reviewerReplies.length - 1];
    return latest === undefined
      ? null
      : { user: latest.user, text: latest.text, ts: latest.ts };
  }

  private messageText(brief: DecisionBrief): string {
    const title = brief.meeting.title ?? brief.meeting.id;
    return `Decision brief awaiting approval: ${escapeSlackControlText(
      boundedSingleLine(title, SLACK_HEADER_MAX_CHARS),
    )}`;
  }

  private apiClient(): SlackWebApiClient {
    if (this.client !== undefined) return this.client;
    const reference = this.config.credential_ref;
    const token =
      reference === undefined ? undefined : this.credentialResolver(reference);
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
