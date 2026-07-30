const DEFAULT_BASE_URL = "https://slack.com/api";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const REPLIES_PAGE_LIMIT = 200;
const MAX_REPLY_PAGES = 25;

export type SlackApiErrorCode =
  "auth" | "rate_limited" | "transient" | "unknown_outcome" | "invalid";

export class SlackApiError extends Error {
  constructor(
    public readonly code: SlackApiErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  blocks?: readonly unknown[];
  /** Require provider-returned blocks to be bound to this exact message. */
  strictEvidence?: boolean;
  /** Disable link previews for meeting-derived content by default. */
  unfurlLinks?: boolean;
  /** Disable media previews for meeting-derived content by default. */
  unfurlMedia?: boolean;
}

export interface SlackPostedMessage {
  channel: string;
  ts: string;
  /** Blocks Slack acknowledged on the stored message, when returned. */
  blocks?: readonly unknown[];
}

/** Stable provider identifiers returned by Slack's `auth.test`. */
export interface SlackAuthIdentity {
  team_id: string;
  enterprise_id: string | null;
  user_id: string;
  bot_id: string | null;
  app_id: string | null;
}

export interface SlackDirectMessage {
  channel_id: string;
  user_id: string;
}

export interface SlackReaction {
  name: string;
  users: readonly string[];
  count: number;
}

export interface SlackReply {
  user: string;
  text: string;
  ts: string;
}

export interface SlackEvidenceReadOptions {
  /** Reject malformed provider evidence instead of omitting it. */
  strict?: boolean;
}

export interface SlackWebApiClientOptions {
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const AUTH_ERRORS = new Set([
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "missing_scope",
  "not_allowed_token_type",
]);

const RATE_LIMIT_ERRORS = new Set(["ratelimited", "rate_limited"]);

const TRANSIENT_ERRORS = new Set([
  "service_unavailable",
  "fatal_error",
  "internal_error",
  "request_timeout",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function readBoundedSlackJson(
  response: Response,
  method: string,
  transportFailureCode: SlackApiErrorCode,
  sizeFailureCode: SlackApiErrorCode,
): Promise<unknown> {
  const failure = (
    detail: "oversized" | "unreadable",
    code = transportFailureCode,
  ) =>
    new SlackApiError(
      code,
      `Slack ${method} returned an ${detail} body`,
      code !== "invalid",
    );
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAXIMUM_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw failure("oversized", sizeFailureCode);
  }
  const body = response.body;
  if (body === null) throw failure("unreadable");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      totalBytes += read.value.byteLength;
      if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw failure("oversized", sizeFailureCode);
      }
      text += decoder.decode(read.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof SlackApiError) throw error;
    throw failure("unreadable");
  } finally {
    reader.releaseLock();
  }
}

const SLACK_TEAM_ID_RE = /^T[A-Z0-9]{2,}$/;
const SLACK_ENTERPRISE_ID_RE = /^E[A-Z0-9]{2,}$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;
const SLACK_BOT_ID_RE = /^B[A-Z0-9]{2,}$/;
const SLACK_APP_ID_RE = /^A[A-Z0-9]{2,}$/;
const SLACK_DM_ID_RE = /^D[A-Z0-9]{2,}$/;
const SLACK_MESSAGE_TS_RE = /^[0-9]+\.[0-9]{6}$/;

function requiredSlackId(
  body: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  method: string,
): string {
  const value = body[key];
  if (!isNonEmptyString(value) || !pattern.test(value)) {
    throw new SlackApiError(
      "invalid",
      `Slack ${method} returned no valid ${key}`,
      false,
    );
  }
  return value;
}

function optionalSlackId(
  body: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  method: string,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (!isNonEmptyString(value) || !pattern.test(value)) {
    throw new SlackApiError(
      "invalid",
      `Slack ${method} returned an invalid ${key}`,
      false,
    );
  }
  return value;
}

/**
 * Minimal capability-neutral Slack Web API client shared by Slack adapters.
 * Slack commonly reports failures as HTTP 200 with `{ok:false,error}`, so both
 * the transport status and the body envelope are checked on every call.
 */
export class SlackWebApiClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly token: string,
    options: SlackWebApiClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async authTest(signal?: AbortSignal): Promise<{ user_id: string | null }> {
    const body = await this.call("auth.test", {}, { signal });
    const userId = body["user_id"];
    return { user_id: isNonEmptyString(userId) ? userId : null };
  }

  /**
   * Capture the strongest stable tenant and installation-subject identifiers
   * exposed by `auth.test`. This is intentionally separate from `authTest()`:
   * adapter health checks retain their historical permissive return shape,
   * while identity enrollment fails closed on malformed or absent IDs.
   */
  async authIdentity(signal?: AbortSignal): Promise<SlackAuthIdentity> {
    const body = await this.call("auth.test", {}, { signal });
    return {
      team_id: requiredSlackId(body, "team_id", SLACK_TEAM_ID_RE, "auth.test"),
      enterprise_id: optionalSlackId(
        body,
        "enterprise_id",
        SLACK_ENTERPRISE_ID_RE,
        "auth.test",
      ),
      user_id: requiredSlackId(body, "user_id", SLACK_USER_ID_RE, "auth.test"),
      bot_id: optionalSlackId(body, "bot_id", SLACK_BOT_ID_RE, "auth.test"),
      // `app_id` is not promised by auth.test, but retain it when Slack does
      // supply it rather than inferring it from the token or configuration.
      app_id: optionalSlackId(body, "app_id", SLACK_APP_ID_RE, "auth.test"),
    };
  }

  async openDirectMessage(
    userId: string,
    signal?: AbortSignal,
  ): Promise<SlackDirectMessage> {
    if (!SLACK_USER_ID_RE.test(userId)) {
      throw new SlackApiError(
        "invalid",
        "Slack conversations.open requires one canonical user ID",
        false,
      );
    }
    const body = await this.call(
      "conversations.open",
      { users: userId, return_im: true },
      { signal },
    );
    const channel = body["channel"];
    if (!isPlainObject(channel)) {
      throw new SlackApiError(
        "invalid",
        "Slack conversations.open returned no direct-message identity",
        false,
      );
    }
    const channelId = requiredSlackId(
      channel,
      "id",
      SLACK_DM_ID_RE,
      "conversations.open",
    );
    if (channel["is_im"] !== true) {
      throw new SlackApiError(
        "invalid",
        "Slack conversations.open did not prove a one-person direct message",
        false,
      );
    }
    const responseUserId = requiredSlackId(
      channel,
      "user",
      SLACK_USER_ID_RE,
      "conversations.open",
    );
    if (responseUserId !== userId) {
      throw new SlackApiError(
        "invalid",
        "Slack conversations.open returned a different direct-message user",
        false,
      );
    }
    return { channel_id: channelId, user_id: responseUserId };
  }

  async postMessage(
    input: SlackPostMessageInput,
    signal?: AbortSignal,
  ): Promise<SlackPostedMessage> {
    // A transport failure here is an unknown outcome: Slack may have accepted
    // the message even though no response arrived. Callers must treat posting
    // as at-least-once.
    const body = await this.call(
      "chat.postMessage",
      {
        channel: input.channel,
        text: input.text,
        unfurl_links: input.unfurlLinks ?? false,
        unfurl_media: input.unfurlMedia ?? false,
        ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
      },
      { signal, unknownOutcomeOnTransportFailure: true },
    );
    const channel = body["channel"];
    const ts = body["ts"];
    if (!isNonEmptyString(channel) || !isNonEmptyString(ts)) {
      throw new SlackApiError(
        "unknown_outcome",
        "Slack accepted the message but returned no channel/ts identity",
        true,
      );
    }
    const message = body["message"];
    const acknowledgedBlocks = isPlainObject(message)
      ? message["blocks"]
      : undefined;
    if (
      input.strictEvidence === true &&
      (channel !== input.channel ||
        !SLACK_MESSAGE_TS_RE.test(ts) ||
        !isPlainObject(message) ||
        message["ts"] !== ts ||
        !Array.isArray(acknowledgedBlocks))
    ) {
      throw new SlackApiError(
        "unknown_outcome",
        "Slack did not bind the acknowledged blocks to the posted message identity",
        true,
      );
    }
    return {
      channel,
      ts,
      ...(Array.isArray(acknowledgedBlocks)
        ? { blocks: acknowledgedBlocks }
        : {}),
    };
  }

  async reactionsGet(
    channel: string,
    timestamp: string,
    signal?: AbortSignal,
    options: SlackEvidenceReadOptions = {},
  ): Promise<readonly SlackReaction[]> {
    const body = await this.call(
      "reactions.get",
      { channel, timestamp, full: true },
      { signal, method: "GET" },
    );
    const message = body["message"];
    if (!isPlainObject(message)) {
      if (options.strict === true) {
        throw new SlackApiError(
          "invalid",
          "Slack reactions.get returned no message evidence",
          false,
        );
      }
      return [];
    }
    if (
      options.strict === true &&
      (message["ts"] !== timestamp || !SLACK_MESSAGE_TS_RE.test(timestamp))
    ) {
      throw new SlackApiError(
        "invalid",
        "Slack reactions.get returned mismatched message evidence",
        false,
      );
    }
    const reactions = message["reactions"];
    if (reactions === undefined) return [];
    if (!Array.isArray(reactions)) {
      if (options.strict === true) {
        throw new SlackApiError(
          "invalid",
          "Slack reactions.get returned malformed reaction evidence",
          false,
        );
      }
      return [];
    }
    const parsed: SlackReaction[] = [];
    for (const entry of reactions) {
      if (!isPlainObject(entry)) {
        if (options.strict === true) {
          throw new SlackApiError(
            "invalid",
            "Slack reactions.get returned malformed reaction evidence",
            false,
          );
        }
        continue;
      }
      const name = entry["name"];
      const users = entry["users"];
      const count = entry["count"];
      const legacyInvalid =
        !isNonEmptyString(name) ||
        !Array.isArray(users) ||
        !users.every(isNonEmptyString) ||
        typeof count !== "number";
      const strictInvalid =
        options.strict === true &&
        !legacyInvalid &&
        (!(users as string[]).every((user) => SLACK_USER_ID_RE.test(user)) ||
          new Set(users as string[]).size !== users.length ||
          !Number.isSafeInteger(count) ||
          Number(count) < new Set(users as string[]).size);
      if (legacyInvalid || strictInvalid) {
        if (options.strict === true) {
          throw new SlackApiError(
            "invalid",
            "Slack reactions.get returned malformed reaction evidence",
            false,
          );
        }
        continue;
      }
      parsed.push({ name, users, count });
    }
    if (
      options.strict === true &&
      new Set(parsed.map((reaction) => reaction.name)).size !== parsed.length
    ) {
      throw new SlackApiError(
        "invalid",
        "Slack reactions.get returned duplicate reaction evidence",
        false,
      );
    }
    return parsed;
  }

  async conversationsReplies(
    channel: string,
    parentTs: string,
    signal?: AbortSignal,
    options: SlackEvidenceReadOptions = {},
  ): Promise<readonly SlackReply[]> {
    if (options.strict === true && !SLACK_MESSAGE_TS_RE.test(parentTs)) {
      throw new SlackApiError(
        "invalid",
        "Slack conversations.replies requires a canonical parent timestamp",
        false,
      );
    }
    const replies: SlackReply[] = [];
    const seenMessageTimestamps = new Set<string>();
    let sawParent = false;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_REPLY_PAGES; page += 1) {
      const body = await this.call(
        "conversations.replies",
        {
          channel,
          ts: parentTs,
          limit: REPLIES_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal, method: "GET" },
      );
      const messages = body["messages"];
      if (!Array.isArray(messages)) {
        if (options.strict === true) {
          throw new SlackApiError(
            "invalid",
            "Slack conversations.replies returned malformed reply evidence",
            false,
          );
        }
      } else {
        for (const [messageIndex, message] of messages.entries()) {
          if (!isPlainObject(message)) {
            if (options.strict === true) {
              throw new SlackApiError(
                "invalid",
                "Slack conversations.replies returned malformed reply evidence",
                false,
              );
            }
            continue;
          }
          const ts = message["ts"];
          const user = message["user"];
          const text = message["text"];
          // The response includes the parent message itself; only true
          // thread replies with an attributable author count as reasons.
          if (ts === parentTs) {
            if (
              options.strict === true &&
              (page !== 0 || messageIndex !== 0 || sawParent)
            ) {
              throw new SlackApiError(
                "invalid",
                "Slack conversations.replies returned a misplaced parent message",
                false,
              );
            }
            sawParent = true;
            seenMessageTimestamps.add(parentTs);
            continue;
          }
          if (
            !isNonEmptyString(ts) ||
            !isNonEmptyString(user) ||
            typeof text !== "string"
          ) {
            if (options.strict === true) {
              throw new SlackApiError(
                "invalid",
                "Slack conversations.replies returned malformed reply evidence",
                false,
              );
            }
            continue;
          }
          if (
            options.strict === true &&
            (!SLACK_MESSAGE_TS_RE.test(ts) ||
              !SLACK_USER_ID_RE.test(user) ||
              message["thread_ts"] !== parentTs ||
              seenMessageTimestamps.has(ts))
          ) {
            throw new SlackApiError(
              "invalid",
              "Slack conversations.replies returned cross-thread or duplicate evidence",
              false,
            );
          }
          seenMessageTimestamps.add(ts);
          replies.push({ user, text, ts });
        }
      }
      if (options.strict === true && page === 0 && !sawParent) {
        throw new SlackApiError(
          "invalid",
          "Slack conversations.replies did not return the requested thread parent",
          false,
        );
      }
      const metadata = body["response_metadata"];
      if (
        options.strict === true &&
        metadata !== undefined &&
        !isPlainObject(metadata)
      ) {
        throw new SlackApiError(
          "invalid",
          "Slack conversations.replies returned malformed pagination evidence",
          false,
        );
      }
      const nextCursor = isPlainObject(metadata)
        ? metadata["next_cursor"]
        : undefined;
      if (
        options.strict === true &&
        nextCursor !== undefined &&
        typeof nextCursor !== "string"
      ) {
        throw new SlackApiError(
          "invalid",
          "Slack conversations.replies returned malformed pagination evidence",
          false,
        );
      }
      if (!isNonEmptyString(nextCursor)) return replies;
      cursor = nextCursor;
    }
    throw new SlackApiError(
      "invalid",
      "Slack thread pagination exceeded the supported page budget",
      false,
    );
  }

  private async call(
    method: string,
    parameters: Record<string, unknown>,
    options: {
      signal?: AbortSignal | undefined;
      method?: "GET" | "POST";
      unknownOutcomeOnTransportFailure?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const httpMethod = options.method ?? "POST";
    const transportFailureCode: SlackApiErrorCode =
      options.unknownOutcomeOnTransportFailure === true
        ? "unknown_outcome"
        : "transient";
    const controller = new AbortController();
    const abortUpstream = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortUpstream, { once: true });
    if (options.signal?.aborted === true) abortUpstream();
    const timer = setTimeout(
      () => controller.abort(new Error(`Slack ${method} timed out`)),
      this.requestTimeoutMs,
    );
    try {
      let url = `${this.baseUrl}/${method}`;
      const init: RequestInit = {
        method: httpMethod,
        signal: controller.signal,
        // Slack API methods are not expected to redirect. Refusing redirects
        // prevents fetch from forwarding the bearer credential to a different
        // endpoint if Slack, a proxy, or a configured test endpoint responds
        // with a redirect.
        redirect: "error",
        headers: { authorization: `Bearer ${this.token}` },
      };
      if (httpMethod === "GET") {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(parameters)) {
          query.set(key, String(value));
        }
        url = `${url}?${query.toString()}`;
      } else {
        init.headers = {
          ...init.headers,
          "content-type": "application/json; charset=utf-8",
        };
        init.body = JSON.stringify(parameters);
      }
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        throw new SlackApiError(
          transportFailureCode,
          `Slack ${method} transport failed: ${(error as Error).message}`,
          true,
        );
      }

      if (!response.ok) await response.body?.cancel().catch(() => undefined);
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        throw new SlackApiError(
          "rate_limited",
          `Slack ${method} is rate limited`,
          true,
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter
            : undefined,
        );
      }
      if (response.status >= 500) {
        throw new SlackApiError(
          transportFailureCode,
          `Slack ${method} failed with HTTP ${response.status}`,
          true,
        );
      }
      if (!response.ok) {
        throw new SlackApiError(
          "invalid",
          `Slack ${method} failed with HTTP ${response.status}`,
          false,
        );
      }

      const body = await readBoundedSlackJson(
        response,
        method,
        transportFailureCode,
        options.unknownOutcomeOnTransportFailure === true
          ? "unknown_outcome"
          : "invalid",
      );
      if (!isPlainObject(body)) {
        const responseShapeCode: SlackApiErrorCode =
          options.unknownOutcomeOnTransportFailure === true
            ? "unknown_outcome"
            : "invalid";
        throw new SlackApiError(
          responseShapeCode,
          `Slack ${method} returned an unexpected body`,
          responseShapeCode === "unknown_outcome",
        );
      }
      if (body["ok"] !== true) {
        const error = isNonEmptyString(body["error"])
          ? body["error"]
          : "unknown_error";
        if (AUTH_ERRORS.has(error)) {
          throw new SlackApiError(
            "auth",
            `Slack ${method} failed: ${error}`,
            false,
          );
        }
        if (RATE_LIMIT_ERRORS.has(error)) {
          throw new SlackApiError(
            "rate_limited",
            `Slack ${method} failed: ${error}`,
            true,
          );
        }
        if (TRANSIENT_ERRORS.has(error)) {
          throw new SlackApiError(
            transportFailureCode,
            `Slack ${method} failed: ${error}`,
            true,
          );
        }
        throw new SlackApiError(
          "invalid",
          `Slack ${method} failed: ${error}`,
          false,
        );
      }
      return body;
    } finally {
      // Keep both deadline and upstream cancellation connected until the
      // complete response body has been consumed, not merely until headers
      // arrive. Fetch resolves as soon as headers are available.
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortUpstream);
    }
  }
}
