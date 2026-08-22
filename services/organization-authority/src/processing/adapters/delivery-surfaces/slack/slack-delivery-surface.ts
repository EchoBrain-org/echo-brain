import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterOperationContext,
  DecisionBrief,
  DeliveryEnvelope,
  DeliveryReceipt,
  DeliverySurfaceAdapter,
} from '../../../core/index.js';
import {
  AdapterError,
  assertCanonicalDeliveryEnvelope,
} from '../../../core/index.js';
import {
  SlackApiError,
  SlackWebApiClient,
} from '../../shared/slack/slack-web-api-client.js';
import {
  boundedSlackLine as boundedSingleLine,
  escapeSlackControlText,
  slackSummaryText as summaryText,
  truncateSlackText as truncateCharacters,
} from '../../shared/slack/message-format.js';
import type {
  SlackDeliveryReceiptStore,
  SlackStoredDelivery,
} from './slack-delivery-receipt-store.js';

export const SLACK_DELIVERY_SURFACE_ADAPTER_ID = 'slack';
export const SLACK_DELIVERY_SURFACE_ADAPTER_VERSION = '1.0.0';

const SLACK_CHANNEL_ID_RE = /^[CGD][A-Z0-9]{2,}$/;
const SLACK_HEADER_MAX_CHARS = 150;
const SLACK_FALLBACK_MAX_CHARS = 4_000;
const UNKNOWN_MESSAGE = 'Slack delivery outcome could not be confirmed';

interface SlackDeliverySettings {
  channelId: string;
  requestTimeoutMs: number | undefined;
}

export interface SlackDeliverySurfaceOptions {
  receiptStore: SlackDeliveryReceiptStore;
  environment?: NodeJS.ProcessEnv;
  credentialResolver?: (reference: string) => string | undefined;
  now?: () => string;
  fetchImpl?: typeof fetch;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function settingsFrom(config: AdapterConfig): SlackDeliverySettings {
  return {
    channelId:
      typeof config.settings['channel_id'] === 'string'
        ? config.settings['channel_id'].trim()
        : '',
    requestTimeoutMs:
      typeof config.settings['request_timeout_ms'] === 'number'
        ? config.settings['request_timeout_ms']
        : undefined,
  };
}

function normalizedTimestamp(value: string): string | null {
  const milliseconds = new Date(value).getTime();
  return Number.isNaN(milliseconds)
    ? null
    : new Date(milliseconds).toISOString();
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
    `Slack delivery surface failed: ${(error as Error).message}`,
    true,
  );
}

/** Slack delivery of approved canonical decision briefs. */
export class SlackDeliverySurface implements DeliverySurfaceAdapter {
  readonly identity: DeliverySurfaceAdapter['identity'];
  readonly destination: DeliverySurfaceAdapter['destination'];
  private readonly settings: SlackDeliverySettings;
  private readonly receiptStore: SlackDeliveryReceiptStore;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly credentialResolver: (
    reference: string,
  ) => string | undefined;
  private readonly now: () => string;
  private readonly fetchImpl: typeof fetch | undefined;
  private client: SlackWebApiClient | undefined;

  constructor(
    private readonly config: AdapterConfig,
    options: SlackDeliverySurfaceOptions,
  ) {
    this.settings = settingsFrom(config);
    this.identity = Object.freeze({
      kind: 'delivery-surface' as const,
      adapter_id: SLACK_DELIVERY_SURFACE_ADAPTER_ID,
      instance_id: config.instance_id,
      version: SLACK_DELIVERY_SURFACE_ADAPTER_VERSION,
    });
    this.destination = Object.freeze({
      adapter_id: this.identity.adapter_id,
      instance_id: this.identity.instance_id,
      external_id: this.settings.channelId,
    });
    this.receiptStore = options.receiptStore;
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
    if (config.adapter_id !== SLACK_DELIVERY_SURFACE_ADAPTER_ID) {
      errors.push(`adapter_id must be '${SLACK_DELIVERY_SURFACE_ADAPTER_ID}'`);
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
    const allowedSettings = new Set(['channel_id', 'request_timeout_ms']);
    for (const key of Object.keys(config.settings)) {
      if (!allowedSettings.has(key)) {
        errors.push(`settings.${key} is not supported`);
      }
    }
    const settings = settingsFrom(config);
    if (!SLACK_CHANNEL_ID_RE.test(settings.channelId)) {
      errors.push('settings.channel_id must be a Slack channel ID');
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
    this.assertNotCancelled(operation?.signal, 'health check');
    const timestamp = normalizedTimestamp(this.now());
    const checkedAt = timestamp ?? new Date().toISOString();
    const validation = this.validateConfig(this.config);
    if (!validation.ok) {
      return {
        status: 'unavailable',
        checked_at: checkedAt,
        message: 'Slack delivery surface configuration is invalid',
        details: { error_count: validation.errors.length },
      };
    }
    if (timestamp === null) {
      return {
        status: 'degraded',
        checked_at: checkedAt,
        message: 'Slack delivery surface clock is invalid',
      };
    }
    try {
      await this.receiptStore.healthCheck();
      this.assertNotCancelled(operation?.signal, 'health check');
      await this.apiClient().authTest(operation?.signal);
      this.assertNotCancelled(operation?.signal, 'health check');
      return {
        status: 'healthy',
        checked_at: checkedAt,
        message:
          'Slack token is valid; chat:write and channel access are verified on publish',
        details: { destination_capability: 'unverified_until_publish' },
      };
    } catch (error) {
      const mapped = mapSlackError(error);
      return {
        status:
          mapped.code === 'unauthorized'
            ? 'unauthorized'
            : mapped.retryable
              ? 'degraded'
              : 'unavailable',
        checked_at: checkedAt,
        message: mapped.message,
        details: { retryable: mapped.retryable },
      };
    }
  }

  async publish(
    envelope: DeliveryEnvelope,
    operation?: AdapterOperationContext,
  ): Promise<DeliveryReceipt> {
    this.assertNotCancelled(operation?.signal, 'delivery');
    const validation = this.validateConfig(this.config);
    if (!validation.ok) {
      throw new AdapterError(
        'invalid_config',
        'Slack delivery surface configuration is invalid',
        false,
      );
    }
    this.assertEnvelope(envelope);
    // Resolve credentials before recording an attempt. Missing credentials are
    // known to have caused no Slack write and must remain safely retryable.
    this.apiClient();

    try {
      this.assertNotCancelled(operation?.signal, 'delivery');
      const recordedAt = normalizedTimestamp(this.now());
      if (recordedAt === null) {
        throw new AdapterError(
          'temporarily_unavailable',
          'Slack delivery surface clock is invalid',
          true,
        );
      }
      const attempt = this.unknownRecord(envelope.idempotency_key, recordedAt);
      const claim = await this.receiptStore.claim(attempt);
      if (claim.kind === 'existing') {
        return this.receipt(envelope.id, claim.record);
      }
      try {
        this.assertNotCancelled(operation?.signal, 'delivery');
        const posted = await this.apiClient().postMessage(
          {
            channel: this.settings.channelId,
            text: this.messageText(envelope.brief),
            blocks: this.messageBlocks(envelope.brief, envelope.approved_at),
          },
          operation?.signal,
        );
        if (posted.channel !== this.settings.channelId) {
          const unexpectedDestination = this.unknownRecord(
            envelope.idempotency_key,
            recordedAt,
            'Slack returned an unexpected destination; delivery outcome is unknown',
          );
          await this.receiptStore
            .recordOutcome(unexpectedDestination)
            .catch(() => undefined);
          return this.receipt(envelope.id, unexpectedDestination);
        }
        const delivered: SlackStoredDelivery = {
          schema_version: 1,
          record_type: 'echo-brain.slack-delivery',
          idempotency_key: envelope.idempotency_key,
          status: 'delivered',
          channel_id: posted.channel,
          message_ts: posted.ts,
          recorded_at: recordedAt,
        };
        try {
          await this.receiptStore.recordOutcome(delivered);
        } catch {
          // Slack confirmed the post, but durable identity was not confirmed
          // locally. The pre-call unknown claim remains and blocks reposts.
          throw new AdapterError(
            'unknown_outcome',
            'Slack delivered the message but its receipt could not be persisted',
            true,
          );
        }
        return this.receipt(envelope.id, delivered);
      } catch (error) {
        const mapped = mapSlackError(error);
        if (mapped.code === 'unknown_outcome') {
          await this.receiptStore.recordOutcome(attempt).catch(() => undefined);
          return this.receipt(envelope.id, attempt);
        }
        try {
          await this.receiptStore.clearAttempt(envelope.idempotency_key);
        } catch {
          // A surviving marker is the source of truth. Reporting unknown keeps
          // every later caller from making a blind second Slack post.
          return this.receipt(envelope.id, attempt);
        }
        throw mapped;
      }
    } catch (error) {
      throw mapSlackError(error);
    }
  }

  private receipt(
    envelopeId: string,
    record: SlackStoredDelivery,
  ): DeliveryReceipt {
    if (record.status === 'delivered') {
      return {
        schema_version: 1,
        envelope_id: envelopeId,
        status: 'delivered',
        external_id: `slack:message:${record.channel_id}:${record.message_ts}`,
        recorded_at: record.recorded_at,
        retryable: false,
      };
    }
    return {
      schema_version: 1,
      envelope_id: envelopeId,
      status: 'unknown',
      external_id: null,
      recorded_at: record.recorded_at,
      retryable: true,
      message: record.message,
    };
  }

  private unknownRecord(
    idempotencyKey: string,
    recordedAt: string,
    message = UNKNOWN_MESSAGE,
  ): SlackStoredDelivery & { status: 'unknown' } {
    return {
      schema_version: 1,
      record_type: 'echo-brain.slack-delivery',
      idempotency_key: idempotencyKey,
      status: 'unknown',
      channel_id: null,
      message_ts: null,
      recorded_at: recordedAt,
      message,
    };
  }

  private assertNotCancelled(
    signal: AbortSignal | undefined,
    operation: string,
  ): void {
    if (signal?.aborted === true) {
      throw new AdapterError(
        'timeout',
        `Slack delivery ${operation} was cancelled`,
        true,
      );
    }
  }

  private assertEnvelope(envelope: DeliveryEnvelope): void {
    try {
      assertCanonicalDeliveryEnvelope(envelope);
    } catch {
      throw new AdapterError(
        'permanently_rejected',
        'delivery envelope is not canonical',
        false,
      );
    }
    if (
      envelope.destination.adapter_id !== this.destination.adapter_id ||
      envelope.destination.instance_id !== this.destination.instance_id ||
      envelope.destination.external_id !== this.destination.external_id
    ) {
      throw new AdapterError(
        'permanently_rejected',
        'delivery envelope does not match the Slack destination',
        false,
      );
    }
  }

  private messageText(brief: DecisionBrief): string {
    const title = brief.meeting.title ?? brief.meeting.id;
    const counts = `${brief.decisions.length} decisions, ${brief.actions.length} actions`;
    return truncateCharacters(
      `Approved decision brief: ${escapeSlackControlText(
        boundedSingleLine(title, SLACK_HEADER_MAX_CHARS),
      )} (${counts})`,
      SLACK_FALLBACK_MAX_CHARS,
    );
  }

  private messageBlocks(
    brief: DecisionBrief,
    approvedAt: string,
  ): readonly unknown[] {
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
      summaryText(
        'Rationales',
        brief.rationales.map((signal) => signal.text),
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
        text: { type: 'plain_text', text, emoji: true },
      })),
      {
        type: 'context',
        elements: [
          {
            type: 'plain_text',
            text: `Approved ${approvedAt}`,
            emoji: true,
          },
        ],
      },
    ];
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

export function createSlackDeliverySurface(
  config: AdapterConfig,
  options: SlackDeliverySurfaceOptions,
): SlackDeliverySurface {
  return new SlackDeliverySurface(config, options);
}
