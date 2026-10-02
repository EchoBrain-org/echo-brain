import { buildContextCaptureEnvelopeV1, type AdapterConfig, type AdapterConfigValidation, type AdapterHealth, type AdapterOperationContext,
  type ContextCaptureContentV1, type SourceAdapterIdentityV1, type SourceAdapterV1, type SourceBatchV1, type SourcePullRequestV1 } from '@echo-brain/organization-processing/core';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { SlackContextRequestV1, SlackContextTransportV1 } from './slack-context-transport-v1.js';
import { parseSlackContextMessageV1 } from './slack-context-payload-v1.js';
import { SLACK_CONTEXT_CHANNEL_V1, SLACK_CONTEXT_MAX_CURSOR_BYTES_V1, SLACK_CONTEXT_MAX_PAGE_V1, SLACK_CONTEXT_TEAM_V1,
  SLACK_CONTEXT_TS_V1, SLACK_CONTEXT_USER_V1, copySlackContextBindingV1, requireSlackContextResponseV1, slackContextArrayV1,
  slackContextFailureV1, slackContextRecordV1, slackContextStringV1, slackContextWorkspaceOriginV1 } from './slack-context-validation-v1.js';

export interface SlackContextSourceReadGrantFenceV1 {
  /** Authority checks its explicit owner, organization connection and configured-channel read grant. */
  requireCurrent(input: { readonly binding: PersonConnectorReadBindingV1; readonly signal?: AbortSignal }): Promise<void>;
}

export interface SlackContextSourceOptionsV1 {
  readonly transport: SlackContextTransportV1;
  readonly read_grant_fence: SlackContextSourceReadGrantFenceV1;
  readonly team_id: string;
  readonly channel_id: string;
  /** Bot authorization is separate from binding.external_subject_id, which identifies the linked human. */
  readonly expected_bot_user_id: string;
  readonly identity: SourceAdapterIdentityV1;
  readonly representation: 'pointer';
  /** Explicit public-channel capability. A C prefix alone does not prove visibility. */
  readonly public_channel_only?: true;
  readonly now?: () => Date;
}

/** One bounded page of a fixed channel. No activation, retention, credentials or polling loop lives here. */
export class SlackContextSourceV1 implements SourceAdapterV1<ContextCaptureContentV1> {
  readonly identity: SourceAdapterIdentityV1;
  private readonly binding: PersonConnectorReadBindingV1;
  private readonly originalTransport: SlackContextTransportV1;
  private readonly request: SlackContextTransportV1['request'];
  private readonly requireReadGrant: SlackContextSourceReadGrantFenceV1['requireCurrent'];
  private readonly team: string;
  private readonly channel: string;
  private readonly botUser: string;
  private readonly publicChannelOnly: boolean;
  private readonly now: () => Date;

  constructor(options: SlackContextSourceOptionsV1) {
    if (options.identity.kind !== 'source' || options.identity.adapter_id !== 'slack-context-capture' || options.identity.version !== '1.0.0' ||
        options.representation !== 'pointer' || typeof options.transport.request !== 'function' || typeof options.read_grant_fence?.requireCurrent !== 'function') throw new Error('Slack context source configuration is invalid');
    slackContextStringV1(options.identity.instance_id, 256);
    this.identity = Object.freeze({ ...options.identity });
    this.binding = copySlackContextBindingV1(options.transport.binding);
    this.team = slackContextStringV1(options.team_id, 64, SLACK_CONTEXT_TEAM_V1);
    this.channel = slackContextStringV1(options.channel_id, 64, SLACK_CONTEXT_CHANNEL_V1);
    this.botUser = slackContextStringV1(options.expected_bot_user_id, 64, SLACK_CONTEXT_USER_V1);
    if (options.public_channel_only !== undefined && options.public_channel_only !== true) throw new Error('Slack context source visibility is invalid');
    this.publicChannelOnly = options.public_channel_only === true;
    if (this.publicChannelOnly && !this.channel.startsWith('C')) throw new Error('Slack public-channel context requires a public channel coordinate');
    if (this.binding.external_scope_id !== this.team) slackContextFailureV1('unauthorized');
    this.originalTransport = options.transport;
    this.request = options.transport.request.bind(options.transport);
    this.requireReadGrant = options.read_grant_fence.requireCurrent.bind(options.read_grant_fence);
    this.now = options.now ?? (() => new Date());
  }

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    const ok = config.adapter_id === this.identity.adapter_id && config.instance_id === this.identity.instance_id;
    return { ok, errors: ok ? [] : ['Slack context source identity mismatch'] };
  }

  async healthCheck(context?: AdapterOperationContext): Promise<AdapterHealth> {
    await this.requireCurrent(context?.signal);
    return { status: 'healthy', checked_at: this.capturedAt() };
  }

  async pull(request: SourcePullRequestV1, context?: AdapterOperationContext): Promise<SourceBatchV1<ContextCaptureContentV1>> {
    const signal = context?.signal;
    signal?.throwIfAborted();
    const limit = request.limit ?? SLACK_CONTEXT_MAX_PAGE_V1;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SLACK_CONTEXT_MAX_PAGE_V1) slackContextFailureV1('invalid_request');
    const cursor = request.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.trim() === '' || Buffer.byteLength(cursor, 'utf8') > SLACK_CONTEXT_MAX_CURSOR_BYTES_V1 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(cursor))) slackContextFailureV1('invalid_request');
    await this.requireCurrent(signal);
    const auth = await this.read({ method: 'auth.test', signal });
    if (auth.team_id !== this.team || auth.user_id !== this.botUser) slackContextFailureV1('unauthorized');
    const origin = slackContextWorkspaceOriginV1(auth.url);
    const conversation = slackContextRecordV1((await this.read({ method: 'conversations.info', query: { channel: this.channel }, signal })).channel);
    if (conversation.id !== this.channel || conversation.is_member !== true ||
        (this.publicChannelOnly && conversation.is_private !== false) ||
        (conversation.context_team_id !== undefined && conversation.context_team_id !== this.team)) slackContextFailureV1('unauthorized');
    const page = await this.read({ method: 'conversations.history',
      query: { channel: this.channel, limit: String(limit), ...(cursor === undefined ? {} : { cursor }) }, signal });
    const messages = slackContextArrayV1(page.messages, limit);
    if (typeof page.has_more !== 'boolean') slackContextFailureV1('invalid_output');
    const rawNext = page.response_metadata === undefined ? undefined : slackContextRecordV1(page.response_metadata).next_cursor;
    const next = rawNext === undefined || rawNext === '' ? undefined : slackContextStringV1(rawNext, SLACK_CONTEXT_MAX_CURSOR_BYTES_V1);
    if ((page.has_more ? next === undefined : next !== undefined) || (next !== undefined && next === cursor)) slackContextFailureV1('invalid_output');
    const seen = new Set<string>();
    const sources = [] as ReturnType<typeof buildContextCaptureEnvelopeV1>[];
    for (const message of messages) {
      const ts = slackContextStringV1(slackContextRecordV1(message).ts, 19, SLACK_CONTEXT_TS_V1);
      if (seen.has(ts)) slackContextFailureV1('invalid_output');
      seen.add(ts);
      const permalink = await this.read({ method: 'chat.getPermalink', query: { channel: this.channel, message_ts: ts }, signal });
      const parsed = parseSlackContextMessageV1(message, { team_id: this.team, channel_id: this.channel, workspace_origin: origin, permalink });
      sources.push(buildContextCaptureEnvelopeV1({ identity: this.identity, external_id: parsed.external_id, captured_at: this.capturedAt(), content: parsed.content }));
    }
    await this.requireCurrent(signal);
    return Object.freeze({ sources: Object.freeze(sources), ...(next === undefined ? {} : { next_cursor: next }) });
  }

  private async read(input: SlackContextRequestV1): Promise<Record<string, unknown>> {
    input.signal?.throwIfAborted();
    this.assertBinding();
    const value = await this.request(input);
    input.signal?.throwIfAborted();
    this.assertBinding();
    return requireSlackContextResponseV1(value);
  }

  private assertBinding(): void {
    if (JSON.stringify(copySlackContextBindingV1(this.originalTransport.binding)) !== JSON.stringify(this.binding)) slackContextFailureV1('stale_access_state');
  }

  private async requireCurrent(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.assertBinding();
    await this.requireReadGrant({ binding: this.binding, signal });
    signal?.throwIfAborted();
    this.assertBinding();
  }

  private capturedAt(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Slack context source clock is invalid');
    return value.toISOString();
  }
}

export function createSlackContextSourceV1(options: SlackContextSourceOptionsV1): SlackContextSourceV1 {
  return new SlackContextSourceV1(options);
}
