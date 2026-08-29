import {
  SlackApiError,
  SlackWebApiClient,
  type SlackWebApiClientOptions,
} from "../adapters/shared/slack/slack-web-api-client.js";

const POST_RECONCILIATION_LOOKBACK_MS = 5 * 60 * 1_000;
const POST_RECONCILIATION_LOOKAHEAD_MS = 10 * 60 * 1_000;
const DEFINITIVE_POST_FAILURE_CODES = new Set([
  "auth",
  "rate_limited",
  "invalid",
]);
const SLACK_DIRECT_MESSAGE_CHANNEL = /^D[A-Z0-9]{2,255}$/;

export interface PrivateSlackApprovalCardPresentationV1 {
  readonly text: string;
  readonly blocks: readonly unknown[];
  readonly transport: {
    readonly mrkdwn: false;
    readonly unfurl_links: false;
    readonly unfurl_media: false;
  };
}

export type PrivateSlackApprovalPostOutcomeV1 =
  | { readonly kind: "posted"; readonly provider_message_ts: string }
  | { readonly kind: "retry_allowed" }
  | { readonly kind: "uncertain" };

export type PrivateSlackDirectMessageOutcomeV1 =
  | {
      readonly kind: "opened";
      readonly channel_id: string;
      readonly user_id: string;
    }
  | { readonly kind: "retry_allowed" };

export type PrivateSlackApprovalUpdateOutcomeV1 =
  | { readonly kind: "done" }
  | { readonly kind: "uncertain" };

export interface PrivateSlackApprovalTerminalPresentationV1 {
  readonly approval_id: string;
  readonly outcome: "approved" | "rejected";
  readonly policy_label: "Only me" | "Team" | null;
}

function marker(approvalId: string): string {
  return `[private-approval:${approvalId}]`;
}

function inertMarkerText(approvalId: string): string {
  return [
    "Preparing your private ECHO approval",
    "This delivery marker is not actionable.",
    "",
    marker(approvalId),
  ].join("\n");
}

function duplicateMarkerText(input: {
  readonly approval_id: string;
  readonly canonical_provider_message_ts: string;
}): string {
  return [
    "Duplicate private approval card",
    "This duplicate was replaced by the earliest matching card and cannot be used.",
    "",
    marker(input.approval_id),
    `[duplicate-of:${input.canonical_provider_message_ts}]`,
  ].join("\n");
}

function supersededText(input: {
  readonly approval_id: string;
  readonly successor_id: string;
}): string {
  return [
    "Superseded",
    "A newer meeting revision replaced this private review. This card can no longer be used.",
    "",
    marker(input.approval_id),
    `[superseded-by:${input.successor_id}]`,
  ].join("\n");
}

function terminalText(input: PrivateSlackApprovalTerminalPresentationV1): string {
  const lines = [
    input.outcome === "approved" ? "Approved" : "Rejected",
    input.outcome === "approved"
      ? `Visibility: ${input.policy_label}`
      : "No ECHO record was released.",
    "",
    marker(input.approval_id),
  ];
  return lines.join("\n");
}

function compareSlackTimestamp(left: string, right: string): number {
  const [leftSeconds, leftMicros] = left.split(".") as [string, string];
  const [rightSeconds, rightMicros] = right.split(".") as [string, string];
  const leftValue = BigInt(leftSeconds) * 1_000_000n + BigInt(leftMicros);
  const rightValue = BigInt(rightSeconds) * 1_000_000n + BigInt(rightMicros);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function slackTimestampFromCanonicalUtc(value: string, offsetMs: number): string {
  const milliseconds = new Date(value).getTime();
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("private approval post intent has an invalid timestamp");
  }
  const boundedMilliseconds = Math.max(0, milliseconds + offsetMs);
  const seconds = Math.floor(boundedMilliseconds / 1_000);
  const micros = (boundedMilliseconds % 1_000) * 1_000;
  return `${seconds}.${String(micros).padStart(6, "0")}`;
}

function reconciliationWindowClosed(input: {
  readonly post_started_at: string;
  readonly reconciliation_started_at: string;
}): boolean {
  const postStartedAt = new Date(input.post_started_at).getTime();
  const reconciliationStartedAt = new Date(
    input.reconciliation_started_at,
  ).getTime();
  if (
    !Number.isSafeInteger(postStartedAt) ||
    !Number.isSafeInteger(reconciliationStartedAt)
  ) {
    throw new Error("private approval reconciliation has an invalid timestamp");
  }
  return (
    reconciliationStartedAt >= postStartedAt + POST_RECONCILIATION_LOOKAHEAD_MS
  );
}

function messageIsAbsent(error: unknown): boolean {
  return (
    error instanceof SlackApiError && error.providerError === "message_not_found"
  );
}

function assertDirectMessageChannel(channelId: string): void {
  if (!SLACK_DIRECT_MESSAGE_CHANNEL.test(channelId)) {
    throw new Error("private Slack approval requires a direct-message channel");
  }
}

/**
 * Provider-only private approval presentation adapter.
 *
 * It opens exactly one direct-message conversation for the verified Slack
 * subject supplied by the server-side assignment resolver. Posting is split
 * into an inert marker and a later deterministic update so a card cannot
 * become actionable before its D2 binding is durable.
 */
export class PrivateSlackApprovalCardPosterV1 {
  private readonly client: SlackWebApiClient;
  private readonly now: () => number;
  /**
   * Slack's Retry-After is per process/token for this V1 delivery adapter.
   * A process-local gate is sufficient here: it survives worker cycles while
   * avoiding a scheduling schema solely for provider backoff.
   */
  private retry_not_before_ms = 0;
  private auth_identity:
    | Awaited<ReturnType<SlackWebApiClient["authIdentity"]>>
    | undefined;

  constructor(
    token: string,
    options: SlackWebApiClientOptions & { readonly now?: () => number } = {},
  ) {
    const { now, ...clientOptions } = options;
    this.now = now ?? Date.now;
    this.client = new SlackWebApiClient(token, clientOptions);
  }

  private retryBlocked(): boolean {
    return this.retry_not_before_ms > this.now();
  }

  private rememberRetryAfter(error: unknown): void {
    if (
      error instanceof SlackApiError &&
      error.code === "rate_limited" &&
      error.retryAfterSeconds !== undefined
    ) {
      this.retry_not_before_ms = Math.max(
        this.retry_not_before_ms,
        this.now() + error.retryAfterSeconds * 1_000,
      );
    }
  }

  async openDirectMessage(
    providerSubjectId: string,
    signal?: AbortSignal,
  ): Promise<PrivateSlackDirectMessageOutcomeV1> {
    if (this.retryBlocked()) return { kind: "retry_allowed" };
    try {
      const opened = await this.client.openDirectMessage(
        providerSubjectId,
        signal,
      );
      return { kind: "opened", ...opened };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (error instanceof SlackApiError && error.code === "rate_limited") {
        this.rememberRetryAfter(error);
        return { kind: "retry_allowed" };
      }
      throw error;
    }
  }

  async postMarker(
    input: { readonly approval_id: string; readonly dm_channel_id: string },
    signal?: AbortSignal,
  ): Promise<PrivateSlackApprovalPostOutcomeV1> {
    assertDirectMessageChannel(input.dm_channel_id);
    if (this.retryBlocked()) return { kind: "retry_allowed" };
    try {
      const posted = await this.client.postMessage(
        {
          channel: input.dm_channel_id,
          text: inertMarkerText(input.approval_id),
          blocks: [],
          unfurlLinks: false,
          unfurlMedia: false,
          mrkdwn: false,
        },
        signal,
      );
      return { kind: "posted", provider_message_ts: posted.ts };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (error instanceof SlackApiError) {
        this.rememberRetryAfter(error);
        return DEFINITIVE_POST_FAILURE_CODES.has(error.code)
          ? { kind: "retry_allowed" }
          : { kind: "uncertain" };
      }
      throw error;
    }
  }

  async reconcileMarker(
    input: {
      readonly approval_id: string;
      readonly dm_channel_id: string;
      readonly post_started_at: string;
      readonly reconciliation_started_at: string;
    },
    signal?: AbortSignal,
  ): Promise<PrivateSlackApprovalPostOutcomeV1> {
    assertDirectMessageChannel(input.dm_channel_id);
    if (this.retryBlocked()) return { kind: "retry_allowed" };
    try {
      if (this.auth_identity === undefined) {
        this.auth_identity = await this.client.authIdentity(signal);
      }
      const identity = this.auth_identity;
      const approvalMarker = marker(input.approval_id);
      const matches = (
        await this.client.channelHistory(
          {
            channel: input.dm_channel_id,
            oldest: slackTimestampFromCanonicalUtc(
              input.post_started_at,
              -POST_RECONCILIATION_LOOKBACK_MS,
            ),
            latest: slackTimestampFromCanonicalUtc(
              input.post_started_at,
              POST_RECONCILIATION_LOOKAHEAD_MS,
            ),
          },
          signal,
        )
      )
        .filter(
          (message) =>
            message.text.endsWith(approvalMarker) &&
            message.bot_id === identity.bot_id,
        )
        .sort((left, right) => compareSlackTimestamp(left.ts, right.ts));
      if (matches.length === 0) {
        return reconciliationWindowClosed(input)
          ? { kind: "retry_allowed" }
          : { kind: "uncertain" };
      }
      const [canonical, ...duplicates] = matches;
      if (canonical === undefined) {
        throw new Error("private Slack recovery lost its canonical marker");
      }
      for (const duplicate of duplicates) {
        try {
          await this.client.updateMessage(
            {
              channel: input.dm_channel_id,
              ts: duplicate.ts,
              text: duplicateMarkerText({
                approval_id: input.approval_id,
                canonical_provider_message_ts: canonical.ts,
              }),
              blocks: [],
              unfurlLinks: false,
              unfurlMedia: false,
              mrkdwn: false,
            },
            signal,
          );
        } catch (error) {
          if (!messageIsAbsent(error)) throw error;
        }
      }
      return { kind: "posted", provider_message_ts: canonical.ts };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (error instanceof SlackApiError) {
        this.rememberRetryAfter(error);
        return error.code === "rate_limited"
          ? { kind: "retry_allowed" }
          : { kind: "uncertain" };
      }
      throw error;
    }
  }

  async publish(
    input: {
      readonly approval_id: string;
      readonly dm_channel_id: string;
      readonly provider_message_ts: string;
      readonly card: PrivateSlackApprovalCardPresentationV1;
    },
    signal?: AbortSignal,
  ): Promise<PrivateSlackApprovalUpdateOutcomeV1> {
    assertDirectMessageChannel(input.dm_channel_id);
    if (this.retryBlocked()) return { kind: "uncertain" };
    try {
      await this.client.updateMessage(
        {
          channel: input.dm_channel_id,
          ts: input.provider_message_ts,
          text: `${input.card.text}\n\n${marker(input.approval_id)}`,
          blocks: input.card.blocks,
          unfurlLinks: input.card.transport.unfurl_links,
          unfurlMedia: input.card.transport.unfurl_media,
          mrkdwn: input.card.transport.mrkdwn,
        },
        signal,
      );
      return { kind: "done" };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (error instanceof SlackApiError) {
        this.rememberRetryAfter(error);
        return { kind: "uncertain" };
      }
      throw error;
    }
  }

  async renderTerminal(
    input: PrivateSlackApprovalTerminalPresentationV1 & {
      readonly dm_channel_id: string;
      readonly provider_message_ts: string;
    },
    signal?: AbortSignal,
  ): Promise<PrivateSlackApprovalUpdateOutcomeV1> {
    if (
      (input.outcome === "approved" && input.policy_label === null) ||
      (input.outcome === "rejected" && input.policy_label !== null)
    ) {
      throw new Error("private approval terminal presentation is inconsistent");
    }
    return this.replaceWithInertMessage(
      {
        dm_channel_id: input.dm_channel_id,
        provider_message_ts: input.provider_message_ts,
        text: terminalText(input),
      },
      signal,
    );
  }

  async tombstone(
    input: {
      readonly approval_id: string;
      readonly successor_id: string;
      readonly dm_channel_id: string;
      readonly provider_message_ts: string;
    },
    signal?: AbortSignal,
  ): Promise<PrivateSlackApprovalUpdateOutcomeV1> {
    return this.replaceWithInertMessage(
      {
        dm_channel_id: input.dm_channel_id,
        provider_message_ts: input.provider_message_ts,
        text: supersededText(input),
      },
      signal,
    );
  }

  private async replaceWithInertMessage(
    input: {
      readonly dm_channel_id: string;
      readonly provider_message_ts: string;
      readonly text: string;
    },
    signal?: AbortSignal,
  ): Promise<PrivateSlackApprovalUpdateOutcomeV1> {
    assertDirectMessageChannel(input.dm_channel_id);
    if (this.retryBlocked()) return { kind: "uncertain" };
    try {
      await this.client.updateMessage(
        {
          channel: input.dm_channel_id,
          ts: input.provider_message_ts,
          text: input.text,
          blocks: [],
          unfurlLinks: false,
          unfurlMedia: false,
          mrkdwn: false,
        },
        signal,
      );
      return { kind: "done" };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (messageIsAbsent(error)) return { kind: "done" };
      if (error instanceof SlackApiError) {
        this.rememberRetryAfter(error);
        return { kind: "uncertain" };
      }
      throw error;
    }
  }
}
