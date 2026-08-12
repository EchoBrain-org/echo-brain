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
/** The one resolved surface that carries schema-v2 reviewer evidence. */
const RESTRICTED_REVIEWER_SURFACE = 'slack-reviewer-v1';
export const DEFAULT_APPROVE_REACTION = 'white_check_mark';
export const DEFAULT_REJECT_REACTION = 'x';
const REACTION_NAME_RE = /^[a-z0-9_+-]{1,64}$/;
const SLACK_HEADER_MAX_CHARS = 150;

type ReviewerReactionState = 'present' | 'absent' | 'unknown';

/**
 * The store port this surface resolves against. Implemented by the product
 * layer's `DecisionNodeStore` and injected by the composition root, so the
 * adapter stays independent of product internals while approval state has one
 * source of truth.
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

export type SlackProviderIdentityEvidence = JsonObject & {
  provider: 'slack';
  team_id: string;
  enterprise_id: string | null;
  bot_user_id: string;
  bot_id: string | null;
  app_id: string | null;
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
 * Non-secret, action-scoped authorization evidence. An allow decision must
 * carry evidence so a newly persisted approval can always be attributed.
 * Denials may omit it because they never resolve the approval.
 */
export type ApprovalActionAuthorizationResult =
  | {
      allowed: true;
      evidence: JsonObject;
      reason?: string;
    }
  | {
      allowed: false;
      evidence?: JsonObject;
      reason?: string;
    };

/**
 * Action-time authorization port supplied by the product composition root.
 * Implementations may consult a central control plane, but the Slack adapter
 * owns the fail-closed ordering: an allow result is required before resolve.
 */
export interface ApprovalActionAuthorizer {
  authorize(
    request: ApprovalActionAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalActionAuthorizationResult>;
}

/**
 * The exact reviewer card, reprojected from the immutable requested slot by
 * the composition root. The adapter imports no protocol package, so both
 * content digests and the credential fingerprint arrive through this port and
 * are compared here rather than recomputed.
 */
export interface ReviewerApprovalPresentationRendering {
  text: string;
  /**
   * The exact closed block array. It is opaque here: this adapter imports no
   * protocol package, sends these bytes verbatim, and compares them against
   * Slack's acknowledgement rather than interpreting them.
   */
  blocks: readonly unknown[];
  reviewer_release_draft_sha256: string;
  approval_presentation_sha256: string;
}

export interface ReviewerApprovalPresentationRenderer {
  render(input: {
    approvalId: string;
    brief: DecisionBrief;
    approveReaction: string;
    rejectReaction: string;
  }): ReviewerApprovalPresentationRendering;
  /**
   * `canonicalSha256({schema_version:1, kind:'slack-credential-fingerprint-v1',
   * token})`. Local-only: it detects an in-place secret rotation without ever
   * persisting the token.
   */
  credentialFingerprint(token: string): string;
}

/** The one frozen publication contract this adapter reads back. */
export interface FrozenSlackApprovalPresentationContract {
  schema_version: 1;
  kind: 'echo-slack-approval-presentation-contract';
  mode: 'restricted-reviewer-v1';
  adapter_id: string;
  adapter_instance_id: string;
  adapter_version: string;
  channel_id: string;
  reviewer_slack_user_id: string;
  reviewer_name: string;
  credential_ref: string;
  credential_fingerprint_sha256: string;
  approve_reaction: string;
  reject_reaction: string;
  reviewer_release_draft_sha256: string;
  approval_presentation_sha256: string;
}

export interface ReviewerApprovalActionAuthorizationRequest {
  approval_id: string;
  adapter_identity: {
    kind: 'approval-surface';
    adapter_id: string;
    instance_id: string;
    version: string;
  };
  provider_identity: SlackProviderIdentityEvidence;
  actor: { provider: 'slack'; team_id: string; user_id: string };
  channel_id: string;
  message_ts: string;
  approve_reaction: string;
  reject_reaction: string;
  reviewer_release_draft_sha256: string;
  approval_presentation_sha256: string;
}

export interface ReviewerApprovalActionAuthorizer {
  authorizeReviewerApproval(
    request: ReviewerApprovalActionAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalActionAuthorizationResult>;
}

/** Injected by product so the adapter cannot restate the durable proof loosely. */
export type ReviewerAuthorizationEvidenceValidator = (
  value: unknown,
) => JsonObject;

export interface ApprovalDecisionStore {
  ensureRequested(request: ApprovalRequest): Promise<ApprovalDecisionStoreView>;
  /**
   * Create-once, under the node lock, before any provider request. An existing
   * slot must validate exactly; a changed contract is a refusal.
   */
  freezeApprovalPresentationContract?(input: {
    approvalId: string;
    contract: FrozenSlackApprovalPresentationContract;
  }): Promise<FrozenSlackApprovalPresentationContract>;
  readApprovalPresentationContract?(
    approvalId: string,
  ): FrozenSlackApprovalPresentationContract | null;
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
    /** Accepted only for a `slack-reviewer-v1` resolution. */
    reviewedAt?: string;
  }): Promise<ApprovalDecisionStoreView>;
}

export interface SlackReactionsApprovalSurfaceOptions {
  store: ApprovalDecisionStore;
  approvalActionAuthorizer?: ApprovalActionAuthorizer;
  reviewerApprovalActionAuthorizer?: ReviewerApprovalActionAuthorizer;
  reviewerAuthorizationEvidenceValidator?: ReviewerAuthorizationEvidenceValidator;
  reviewerDisplayNameValidator?: (value: unknown) => void;
  reviewerPresentationRenderer?: ReviewerApprovalPresentationRenderer;
  environment?: NodeJS.ProcessEnv;
  credentialResolver?: (reference: string) => string | undefined;
  now?: () => string;
  fetchImpl?: typeof fetch;
}

/**
 * Runtime configuration selects exactly one publication mode for future
 * cards. Pilot and reviewer presentation configuration are mutually
 * exclusive, and an already-posted card is never reinterpreted under a mode it
 * was not published with.
 */
export type SlackApprovalPresentationMode =
  | 'ordinary-v1'
  | 'pilot-member-readable-v1'
  | 'restricted-reviewer-v1';

interface SlackReactionsSettings {
  channelId: string;
  reviewerUserId: string;
  reviewerName: string;
  approveReaction: string;
  rejectReaction: string;
  requestTimeoutMs: number | undefined;
  permissionPilotPresentation:
    | PermissionPilotPresentationDescriptor
    | undefined;
  presentationMode: SlackApprovalPresentationMode;
}

export interface PermissionPilotPresentationDescriptor {
  schema_version: 1;
  kind: 'echo-organization-permission-pilot-presentation';
  policy_id: 'pilot-member-readable-v1';
  presentation_policy_id: 'pilot-two-person-audience-v1';
  audience: readonly [
    { readonly membership_id: string; readonly label: string },
    { readonly membership_id: string; readonly label: string },
  ];
  notice_text: string;
  fallback_text: string;
}

interface RenderSlackApprovalBlocksInput {
  brief: DecisionBrief;
  approvalId?: string;
  approveReaction: string;
  rejectReaction: string;
  permissionPilotPresentation?: PermissionPilotPresentationDescriptor;
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

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validPilotAudienceLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value === value.normalize('NFC') &&
    [...value].length >= 1 &&
    [...value].length <= 80 &&
    /^[\p{L}\p{M}\p{N} .'-]+$/u.test(value)
  );
}

function permissionPilotPresentation(
  value: unknown,
): PermissionPilotPresentationDescriptor | undefined {
  if (
    !isPlainObject(value) ||
    !exactKeys(value, [
      'schema_version',
      'kind',
      'policy_id',
      'presentation_policy_id',
      'audience',
      'notice_text',
      'fallback_text',
    ]) ||
    value['schema_version'] !== 1 ||
    value['kind'] !== 'echo-organization-permission-pilot-presentation' ||
    value['policy_id'] !== 'pilot-member-readable-v1' ||
    value['presentation_policy_id'] !== 'pilot-two-person-audience-v1' ||
    !Array.isArray(value['audience']) ||
    value['audience'].length !== 2
  ) {
    return undefined;
  }
  const audience = value['audience'];
  const members = audience.map((entry) => {
    if (
      !isPlainObject(entry) ||
      !exactKeys(entry, ['membership_id', 'label']) ||
      typeof entry['membership_id'] !== 'string' ||
      !/^mem_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        entry['membership_id'],
      ) ||
      !validPilotAudienceLabel(entry['label'])
    ) {
      return undefined;
    }
    return {
      membership_id: entry['membership_id'],
      label: entry['label'],
    };
  });
  const first = members[0];
  const second = members[1];
  if (
    first === undefined ||
    second === undefined ||
    first.membership_id >= second.membership_id ||
    first.label === second.label
  ) {
    return undefined;
  }
  const noticeText =
    "Approving publishes this organization record's decisions, actions, and " +
    `rationales to ${first.label} and ${second.label}.`;
  const fallbackText = `Decision brief awaiting approval. ${noticeText}`;
  if (
    value['notice_text'] !== noticeText ||
    value['fallback_text'] !== fallbackText
  ) {
    return undefined;
  }
  return value as unknown as PermissionPilotPresentationDescriptor;
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
    permissionPilotPresentation: permissionPilotPresentation(
      settings['permission_pilot_presentation'],
    ),
    presentationMode:
      settings['presentation_mode'] === 'restricted-reviewer-v1'
        ? 'restricted-reviewer-v1'
        : settings['presentation_mode'] === 'pilot-member-readable-v1'
          ? 'pilot-member-readable-v1'
          : 'ordinary-v1',
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

function slackReference(
  reference: JsonObject,
): { channel: string; messageTs: string } | undefined {
  const channel = reference['channel_id'];
  const messageTs = reference['message_ts'];
  return isNonEmptyString(channel) && isNonEmptyString(messageTs)
    ? { channel, messageTs }
    : undefined;
}

/**
 * Version-1 approval-card renderer.
 */
function renderSlackApprovalBlocks(
  input: RenderSlackApprovalBlocksInput,
): JsonValue[] {
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
  const ordinaryBlocks: JsonValue[] = [
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
          text: `React :${input.approveReaction}: to approve or :${input.rejectReaction}: to reject. To record a reason, reply in this thread *before* reacting.`,
          ...(identified ? { verbatim: false } : {}),
        },
      ],
    },
  ];
  const blocks =
    identified && input.permissionPilotPresentation !== undefined
      ? [
          ...ordinaryBlocks.slice(0, -1),
          {
            type: 'section',
            block_id: `echo-approval-${input.approvalId}-audience-v1`,
            text: {
              type: 'plain_text',
              text: input.permissionPilotPresentation.notice_text,
              emoji: false,
            },
          },
          ordinaryBlocks[ordinaryBlocks.length - 1] as JsonValue,
        ]
      : ordinaryBlocks;
  if (!identified) return blocks;
  return blocks.map((block, index) => ({
    ...(block as JsonObject),
    ...((block as JsonObject)['block_id'] === undefined
      ? { block_id: `echo-approval-${input.approvalId}-${index}` }
      : {}),
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
  private readonly reviewerApprovalActionAuthorizer:
    | ReviewerApprovalActionAuthorizer
    | undefined;
  private readonly reviewerPresentationRenderer:
    | ReviewerApprovalPresentationRenderer
    | undefined;
  private readonly reviewerAuthorizationEvidenceValidator:
    | ReviewerAuthorizationEvidenceValidator
    | undefined;
  private readonly reviewerDisplayNameValidator:
    | ((value: unknown) => void)
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
    this.reviewerApprovalActionAuthorizer =
      options.reviewerApprovalActionAuthorizer;
    this.reviewerPresentationRenderer = options.reviewerPresentationRenderer;
    this.reviewerAuthorizationEvidenceValidator =
      options.reviewerAuthorizationEvidenceValidator;
    this.reviewerDisplayNameValidator = options.reviewerDisplayNameValidator;
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
      'permission_pilot_presentation',
      'presentation_mode',
    ]);
    for (const key of Object.keys(config.settings)) {
      if (!allowedSettings.has(key))
        errors.push(`settings.${key} is not supported`);
    }
    const settings = settingsFrom(config);
    if (
      config.settings['presentation_mode'] !== undefined &&
      settings.presentationMode === 'ordinary-v1' &&
      config.settings['presentation_mode'] !== 'ordinary-v1'
    ) {
      errors.push('settings.presentation_mode is not a supported mode');
    }
    // Pilot and reviewer presentation configuration are mutually exclusive:
    // startup rejects both being enabled rather than choosing one.
    if (
      settings.presentationMode === 'restricted-reviewer-v1' &&
      settings.permissionPilotPresentation !== undefined
    ) {
      errors.push(
        'settings.presentation_mode restricted-reviewer-v1 excludes settings.permission_pilot_presentation',
      );
    }
    if (
      settings.presentationMode === 'pilot-member-readable-v1' &&
      settings.permissionPilotPresentation === undefined
    ) {
      errors.push(
        'settings.presentation_mode pilot-member-readable-v1 requires settings.permission_pilot_presentation',
      );
    }
    if (settings.presentationMode === 'restricted-reviewer-v1') {
      if (this.reviewerPresentationRenderer === undefined) {
        errors.push(
          'restricted-reviewer-v1 requires an injected reviewer presentation renderer',
        );
      }
      if (this.reviewerApprovalActionAuthorizer === undefined) {
        errors.push(
          'restricted-reviewer-v1 requires an injected reviewer approval authorizer',
        );
      }
      if (this.reviewerAuthorizationEvidenceValidator === undefined) {
        errors.push(
          'restricted-reviewer-v1 requires an exact reviewer authorization evidence validator',
        );
      }
      if (this.reviewerDisplayNameValidator === undefined) {
        errors.push(
          'restricted-reviewer-v1 requires an exact reviewer display-name validator',
        );
      } else {
        try {
          this.reviewerDisplayNameValidator(settings.reviewerName);
        } catch {
          errors.push(
            'settings.reviewer.name must satisfy the restricted reviewer display-name contract',
          );
        }
      }
      if (this.approvalActionAuthorizer === undefined) {
        errors.push(
          'restricted-reviewer-v1 requires the authority-marked approval path',
        );
      }
      if (
        this.store.freezeApprovalPresentationContract === undefined ||
        this.store.readApprovalPresentationContract === undefined
      ) {
        errors.push(
          'restricted-reviewer-v1 requires a store that freezes the publication contract',
        );
      }
    }
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
    if (
      config.settings['permission_pilot_presentation'] !== undefined &&
      settings.permissionPilotPresentation === undefined
    ) {
      errors.push(
        'settings.permission_pilot_presentation must be the exact activation-emitted descriptor',
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
    // Stage the node before any Slack traffic so retries keep one durable
    // approval request even if every Slack call below fails.
    const staged = await this.store.ensureRequested(request);
    if (Object.hasOwn(staged.requested_metadata ?? {}, 'federation')) {
      throw new AdapterError(
        'permanently_rejected',
        'Slack approval request uses retired federation metadata',
        false,
      );
    }
    if (staged.status !== 'pending') return decision(staged);

    try {
      const publicationSurface = this.publicationSurface();
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

  /**
   * The reviewer publication contract for one node, frozen before any Slack
   * request.
   *
   * The draft is reprojected from the already-immutable requested slot on
   * every call, so a retry renders the same bytes; the credential is resolved
   * only to fingerprint it, and the token itself never reaches the slot. An
   * existing slot must validate exactly, which is what makes a post retry,
   * poll, or action request incapable of consulting current configuration.
   */
  private async frozenReviewerContract(
    staged: ApprovalDecisionStoreView,
    alreadyPublished = false,
  ): Promise<{
    contract: FrozenSlackApprovalPresentationContract;
    rendering: ReviewerApprovalPresentationRendering;
    client: SlackWebApiClient;
  }> {
    const renderer = this.reviewerPresentationRenderer;
    const freeze = this.store.freezeApprovalPresentationContract;
    if (renderer === undefined || freeze === undefined) {
      throw new AdapterError(
        'invalid_config',
        'Slack reviewer publication is not composed',
        false,
      );
    }
    const stored = this.store.readApprovalPresentationContract?.(
      staged.approval_id,
    );
    const approveReaction = stored?.approve_reaction ?? this.settings.approveReaction;
    const rejectReaction = stored?.reject_reaction ?? this.settings.rejectReaction;
    const rendering = renderer.render({
      approvalId: staged.approval_id,
      brief: staged.brief,
      approveReaction,
      rejectReaction,
    });
    if (stored !== null && stored !== undefined) {
      // The frozen slot wins over current configuration for every later
      // render, retry, poll, and action request.
      if (
        stored.reviewer_release_draft_sha256 !==
          rendering.reviewer_release_draft_sha256 ||
        stored.approval_presentation_sha256 !==
          rendering.approval_presentation_sha256
      ) {
        throw new AdapterError(
          'permanently_rejected',
          'Slack reviewer card no longer reprojects to its frozen presentation digests',
          false,
        );
      }
      this.assertFrozenAdapterIdentity(stored);
      const token = this.assertFrozenCredential(stored, renderer);
      return { contract: stored, rendering, client: this.reviewerClient(token) };
    }
    if (alreadyPublished) {
      // A card that is already on Slack was rendered under whatever mode was
      // configured then. It can never be upgraded, downgraded, or silently
      // interpreted as reviewer V1: it must be resolved or rejected under its
      // original configuration first.
      throw new AdapterError(
        'permanently_rejected',
        'Slack card was published without a reviewer presentation contract',
        false,
      );
    }
    const credentialRef = this.config.credential_ref;
    if (!isNonEmptyString(credentialRef)) {
      throw new AdapterError(
        'invalid_config',
        'Slack reviewer publication requires a credential reference',
        false,
      );
    }
    const token = this.credentialResolver(credentialRef);
    if (!isNonEmptyString(token)) {
      throw new AdapterError(
        'unauthorized',
        'Slack credentials are unavailable',
        false,
      );
    }
    const contract: FrozenSlackApprovalPresentationContract = {
      schema_version: 1,
      kind: 'echo-slack-approval-presentation-contract',
      mode: 'restricted-reviewer-v1',
      adapter_id: this.identity.adapter_id,
      adapter_instance_id: this.identity.instance_id,
      adapter_version: this.identity.version,
      channel_id: this.settings.channelId,
      reviewer_slack_user_id: this.settings.reviewerUserId,
      reviewer_name: this.settings.reviewerName,
      credential_ref: credentialRef,
      credential_fingerprint_sha256: renderer.credentialFingerprint(token),
      approve_reaction: approveReaction,
      reject_reaction: rejectReaction,
      reviewer_release_draft_sha256: rendering.reviewer_release_draft_sha256,
      approval_presentation_sha256: rendering.approval_presentation_sha256,
    };
    const frozen = await freeze.call(this.store, {
      approvalId: staged.approval_id,
      contract,
    });
    return { contract: frozen, rendering, client: this.reviewerClient(token) };
  }

  /**
   * A frozen card is never rendered, retried, polled, or authorized under a
   * rotated adapter identity, channel, reviewer, or reaction pair. Recovering
   * one requires restoring the exact old binding, not using the new pair.
   */
  private assertFrozenAdapterIdentity(
    contract: FrozenSlackApprovalPresentationContract,
  ): void {
    if (
      contract.adapter_id !== this.identity.adapter_id ||
      contract.adapter_instance_id !== this.identity.instance_id ||
      contract.adapter_version !== this.identity.version
    ) {
      throw new AdapterError(
        'permanently_rejected',
        'Slack reviewer card was frozen under a different adapter identity',
        false,
      );
    }
  }

  private assertFrozenCredential(
    contract: FrozenSlackApprovalPresentationContract,
    renderer: ReviewerApprovalPresentationRenderer,
  ): string {
    if (contract.credential_ref !== this.config.credential_ref) {
      throw new AdapterError(
        'unauthorized',
        'Slack reviewer card was frozen against a different credential reference',
        false,
      );
    }
    const token = this.credentialResolver(contract.credential_ref);
    if (!isNonEmptyString(token)) {
      throw new AdapterError(
        'unauthorized',
        'Slack credentials are unavailable',
        false,
      );
    }
    if (
      renderer.credentialFingerprint(token) !==
      contract.credential_fingerprint_sha256
    ) {
      throw new AdapterError(
        'unauthorized',
        'Slack reviewer credential value was rotated in place before its card resolved',
        false,
      );
    }
    return token;
  }

  private async ensurePublished(
    processingKey: string,
    staged: ApprovalDecisionStoreView,
    operation?: AdapterOperationContext,
  ): Promise<ApprovalDecisionStoreView> {
    const publicationSurface = this.publicationSurface();
    const reviewerMode =
      this.settings.presentationMode === 'restricted-reviewer-v1';
    if (
      staged.published.some(
        (entry) => entry.surface === publicationSurface,
      )
    ) {
      // A published reviewer card still revalidates its frozen contract, so a
      // rotated credential, adapter identity, or reaction pair fails closed on
      // the next poll instead of being silently reinterpreted.
      if (reviewerMode) await this.frozenReviewerContract(staged, true);
      return staged;
    }
    if (reviewerMode) {
      const { contract, rendering, client } =
        await this.frozenReviewerContract(staged);
      const posted = await client.postMessage(
        {
          channel: contract.channel_id,
          text: rendering.text,
          blocks: rendering.blocks,
          strictEvidence: true,
          mrkdwn: false,
          unfurlLinks: false,
          unfurlMedia: false,
        },
        operation?.signal,
      );
      // Slack returns `text` and `blocks`, not the transport flags, so
      // publication verifies exactly what the provider echoed and relies on
      // the fixed contract constants for the rest.
      if (
        posted.blocks === undefined ||
        !jsonEquivalent(rendering.blocks, posted.blocks)
      ) {
        throw new AdapterError(
          'unknown_outcome',
          'Slack did not acknowledge the exact approval presentation',
          true,
        );
      }
      return await this.store.recordPublished({
        processingKey,
        surface: publicationSurface,
        reference: { channel_id: posted.channel, message_ts: posted.ts },
      });
    }
    // Posting then recording is a dual write: a crash between the two can
    // produce a duplicate message on retry. Posting is at-least-once by
    // design; the recorded reference always wins as the polled message.
    const requiresExactPostedBlocks =
      publicationSurface === AUTHORITY_MARKED_SURFACE;
    const blocks = renderSlackApprovalBlocks({
      brief: staged.brief,
      approvalId: staged.approval_id,
      approveReaction: this.settings.approveReaction,
      rejectReaction: this.settings.rejectReaction,
      ...(this.settings.permissionPilotPresentation === undefined
        ? {}
        : {
            permissionPilotPresentation:
              this.settings.permissionPilotPresentation,
          }),
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
    return await this.store.recordPublished({
      processingKey,
      surface: publicationSurface,
      reference: { channel_id: posted.channel, message_ts: posted.ts },
    });
  }

  private publicationSurface(): string {
    // Plain pre-authority Slack slots did not authenticate their exact blocks,
    // so central authorization uses a new append-only slot and thereafter
    // polls only that durable replacement reference.
    return this.approvalActionAuthorizer !== undefined
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
    const centralizedAuthorization =
      this.approvalActionAuthorizer !== undefined;
    const strictEvidence = centralizedAuthorization;
    // Every reviewer-card read resolves its reaction pair, channel, reviewer,
    // and credential from the frozen contract. No poll consults current mode
    // or reaction configuration.
    const frozenBundle =
      this.settings.presentationMode === 'restricted-reviewer-v1'
        ? await this.frozenReviewerContract(state, true)
        : null;
    const frozen = frozenBundle?.contract ?? null;
    const apiClient = frozenBundle?.client ?? this.apiClient();
    if (frozen !== null && frozen.channel_id !== channel) {
      throw new AdapterError(
        'permanently_rejected',
        'Slack reviewer card was published in a different channel',
        false,
      );
    }
    const approveReaction = frozen?.approve_reaction ?? this.settings.approveReaction;
    const rejectReaction = frozen?.reject_reaction ?? this.settings.rejectReaction;
    const reviewerUserId =
      frozen?.reviewer_slack_user_id ?? this.settings.reviewerUserId;
    const reviewerName = frozen?.reviewer_name ?? this.settings.reviewerName;
    const reactions = await apiClient.reactionsGet(
      channel,
      messageTs,
      operation?.signal,
      { strict: strictEvidence },
    );
    const approved = this.reviewerReactionState(
      reactions,
      approveReaction,
      reviewerUserId,
    );
    const rejected = this.reviewerReactionState(
      reactions,
      rejectReaction,
      reviewerUserId,
    );
    // Slack may truncate either decisive reaction's user roster. Treating an
    // unknown as absent could make the opposite reaction win, so any unknown
    // keeps the node pending.
    if (approved === 'unknown' || rejected === 'unknown')
      return decision(state);
    // Both reactions present is a human conflict with no orderable winner
    // (Slack reactions carry no timestamps): fail closed and stay pending
    // until the reviewer removes one reaction.
    if (approved === rejected) return decision(state);

    const latestReply = await this.latestReviewerReply(
      channel,
      messageTs,
      reviewerUserId,
      apiClient,
      operation,
      strictEvidence,
    );
    const reason = latestReply === null ? null : latestReply.text.trim();
    const reactionName =
      approved === 'present' ? approveReaction : rejectReaction;
    const liveProviderIdentity = strictEvidence
      ? liveProviderEvidence(
          await apiClient.authIdentity(operation?.signal),
        )
      : undefined;
    const authorizer = this.approvalActionAuthorizer;
    let authorizationEvidence: JsonObject | undefined;
    if (authorizer !== undefined) {
      const providerIdentity =
        liveProviderIdentity as SlackProviderIdentityEvidence;
      const actor = {
        provider: 'slack' as const,
        team_id: providerIdentity.team_id,
        user_id: reviewerUserId,
      };
      let authorization: ApprovalActionAuthorizationResult;
      try {
        authorization =
          frozen !== null && approved === 'present'
            ? // The reviewer approval is the only schema-v2 path. It carries
              // both frozen content commitments and no content.
              await (
                this
                  .reviewerApprovalActionAuthorizer as ReviewerApprovalActionAuthorizer
              ).authorizeReviewerApproval(
                {
                  approval_id: state.approval_id,
                  adapter_identity: this.identity,
                  provider_identity: providerIdentity,
                  actor,
                  channel_id: channel,
                  message_ts: messageTs,
                  approve_reaction: frozen.approve_reaction,
                  reject_reaction: frozen.reject_reaction,
                  reviewer_release_draft_sha256:
                    frozen.reviewer_release_draft_sha256,
                  approval_presentation_sha256:
                    frozen.approval_presentation_sha256,
                },
                operation?.signal,
              )
            : // Reviewer-card rejection continues through the unchanged
              // schema-v1 request, taking its reaction from the frozen
              // contract rather than the current local setting.
              await authorizer.authorize(
                {
                  approval_id: state.approval_id,
                  action: approved === 'present' ? 'approve' : 'reject',
                  adapter_identity: this.identity,
                  provider_identity: providerIdentity,
                  actor,
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
        typeof authorization.allowed !== 'boolean' ||
        (authorization.evidence !== undefined &&
          !isPlainObject(authorization.evidence)) ||
        (authorization.allowed && !isPlainObject(authorization.evidence))
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
      authorizationEvidence = authorization.evidence;
    }
    operation?.signal?.throwIfAborted();
    // A reviewer approval resolves under its own surface, carries exactly the
    // schema-v2 evidence, and records the Authority transaction time. Every
    // other act -- including a reviewer-card rejection -- keeps the landed
    // schema-v1 surface, metadata shape, and local-clock behavior.
    const reviewerApproval = frozen !== null && approved === 'present';
    if (reviewerApproval) {
      const validateEvidence = this.reviewerAuthorizationEvidenceValidator;
      try {
        if (validateEvidence === undefined) {
          throw new Error('reviewer authorization evidence validator is absent');
        }
        const validated = validateEvidence(authorizationEvidence);
        if (
          validated['approval_id'] !== state.approval_id ||
          validated['reviewer_release_draft_sha256'] !==
            frozen.reviewer_release_draft_sha256 ||
          validated['approval_presentation_sha256'] !==
            frozen.approval_presentation_sha256
        ) {
          throw new Error(
            'reviewer authorization evidence does not bind the frozen approval presentation',
          );
        }
        authorizationEvidence = validated;
      } catch {
        throw new AdapterError(
          'temporarily_unavailable',
          'Slack reviewer approval evidence is invalid',
          true,
        );
      }
    }
    const reviewerEvaluatedAt = reviewerApproval
      ? (authorizationEvidence as JsonObject)['evaluated_at']
      : undefined;
    if (reviewerApproval && !isNonEmptyString(reviewerEvaluatedAt)) {
      throw new AdapterError(
        'temporarily_unavailable',
        'Slack reviewer approval evidence has no evaluation time',
        true,
      );
    }
    let resolved: ApprovalDecisionStoreView;
    try {
      resolved = await this.store.resolve({
        approvalId: state.approval_id,
        status: approved === 'present' ? 'approved' : 'rejected',
        reviewedBy: reviewerName,
        reason,
        surface: reviewerApproval ? RESTRICTED_REVIEWER_SURFACE : SURFACE,
        ...(reviewerApproval
          ? { reviewedAt: reviewerEvaluatedAt as string }
          : {}),
        metadata: reviewerApproval
          ? { authorization: authorizationEvidence as JsonObject }
          : {
              slack: {
                channel_id: channel,
                message_ts: messageTs,
                reviewer_user_id: reviewerUserId,
              },
              ...(authorizationEvidence === undefined
                ? {}
                : { authorization: authorizationEvidence }),
            },
      });
    } catch {
      // A concurrent review cycle may have resolved this node first. The
      // store is first-resolution-wins; report the winner instead of failing.
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
    reviewerUserId: string,
  ): ReviewerReactionState {
    const reaction = reactions.find((entry) => entry.name === name);
    if (reaction === undefined) return 'absent';
    // Slack may omit reactors from `users` while `count` stays complete.
    // Absence cannot be proven from an incomplete roster, and treating the
    // entry as false could let the opposite decision resolve incorrectly.
    if (reaction.count !== new Set(reaction.users).size) {
      return 'unknown';
    }
    return reaction.users.includes(reviewerUserId) ? 'present' : 'absent';
  }

  private async latestReviewerReply(
    channel: string,
    messageTs: string,
    reviewerUserId: string,
    client: SlackWebApiClient,
    operation?: AdapterOperationContext,
    strict = false,
  ): Promise<ReviewerReplyEvidence | null> {
    const replies = await client.conversationsReplies(
      channel,
      messageTs,
      operation?.signal,
      { strict },
    );
    const reviewerReplies = replies
      .filter(
        (reply) =>
          reply.user === reviewerUserId && reply.text.trim().length > 0,
      )
      .sort((left, right) => Number(left.ts) - Number(right.ts));
    const latest = reviewerReplies[reviewerReplies.length - 1];
    return latest === undefined
      ? null
      : { user: latest.user, text: latest.text, ts: latest.ts };
  }

  private messageText(brief: DecisionBrief): string {
    if (this.settings.permissionPilotPresentation !== undefined) {
      return this.settings.permissionPilotPresentation.fallback_text;
    }
    const title = brief.meeting.title ?? brief.meeting.id;
    return `Decision brief awaiting approval: ${escapeSlackControlText(
      boundedSingleLine(title, SLACK_HEADER_MAX_CHARS),
    )}`;
  }

  /** Reviewer operations use the exact token that was fingerprinted this call. */
  private reviewerClient(token: string): SlackWebApiClient {
    return new SlackWebApiClient(token, {
      ...(this.settings.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.settings.requestTimeoutMs }),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
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
