import type { ReadableStreamReadResult } from "node:stream/web";
import { ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CALLBACK_PATH } from "@echo-brain/provider-slack-client/organization-api/person-slack-browser-link";
import { PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1 } from "../../../presentation/private-slack-approval-interaction-http-port-v1.js";

const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAXIMUM_TIMEOUT_MS = 60_000;

/**
 * The exact bot scopes ECHO's private per-organization Slack app requests.
 * Distinct from the legacy `SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES` (7
 * scopes), which stays unchanged for legacy bot-token connections.
 */
export const SLACK_PRIVATE_APP_BOT_SCOPES_V1 = Object.freeze([
  "chat:write",
  "im:history",
  "im:write",
  "users:read",
] as const);

function validateRecipeUrl(value: string, allowPath: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Slack recipe URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (!allowPath && url.pathname !== "/")
  ) {
    throw new Error("Slack recipe URL is invalid");
  }
  return url;
}

/**
 * Builds the manifest ECHO submits to Slack's Manifest API to create (or
 * update) one organization's private Slack app. The first redirect URL is
 * always Nango's OAuth callback, passed in by the caller; the second is
 * ECHO's own browser-link callback, reused verbatim from the Person API
 * module that already owns that path. Interactivity always points at this
 * Authority's signed interaction endpoint.
 */
export function buildEchoSlackAppManifestV1(input: {
  readonly authority_url: string;
  readonly nango_callback_url: string;
}): Readonly<Record<string, unknown>> {
  const authorityUrl = validateRecipeUrl(input.authority_url, false);
  validateRecipeUrl(input.nango_callback_url, true);
  const authorityOrigin = authorityUrl.origin;
  return Object.freeze({
    display_information: Object.freeze({
      name: "ECHO",
      description: "Private approval cards and identity links for ECHO.",
    }),
    features: Object.freeze({
      bot_user: Object.freeze({ display_name: "ECHO", always_online: false }),
    }),
    oauth_config: Object.freeze({
      redirect_urls: Object.freeze([
        input.nango_callback_url,
        `${authorityOrigin}${ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CALLBACK_PATH}`,
      ]),
      scopes: Object.freeze({ bot: SLACK_PRIVATE_APP_BOT_SCOPES_V1 }),
    }),
    settings: Object.freeze({
      interactivity: Object.freeze({
        is_enabled: true,
        request_url: `${authorityOrigin}${PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1}`,
      }),
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    }),
  });
}

export class SlackAppManifestProviderErrorV1 extends Error {
  constructor(
    readonly code: "invalid_token" | "invalid_manifest" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SlackAppManifestProviderErrorV1";
  }
}

export interface CreatedSlackAppV1 {
  readonly app_id: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly signing_secret: string;
}

export interface SlackAppManifestProviderV1 {
  createApp(input: {
    configuration_token: string;
    manifest: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<CreatedSlackAppV1>;
  updateApp(input: {
    configuration_token: string;
    app_id: string;
    manifest: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parses `apps.manifest.create`'s success body down to the four credentials
 * ECHO stores. `verification_token` is deliberately ignored: it has no use
 * in the Nango-mediated install flow this app serves.
 */
function parseCreatedSlackApp(value: Record<string, unknown>): CreatedSlackAppV1 {
  const appId = nonEmptyString(value.app_id);
  const credentials = record(value.credentials);
  const clientId = credentials === undefined ? undefined : nonEmptyString(credentials.client_id);
  const clientSecret =
    credentials === undefined ? undefined : nonEmptyString(credentials.client_secret);
  const signingSecret =
    credentials === undefined ? undefined : nonEmptyString(credentials.signing_secret);
  if (
    appId === undefined ||
    clientId === undefined ||
    clientSecret === undefined ||
    signingSecret === undefined
  ) {
    throw new SlackAppManifestProviderErrorV1(
      "unavailable",
      "Slack did not return the expected app credentials",
    );
  }
  return Object.freeze({
    app_id: appId,
    client_id: clientId,
    client_secret: clientSecret,
    signing_secret: signingSecret,
  });
}

async function readBoundedManifestResponseBytes(response: Response): Promise<Uint8Array> {
  if (response.body === null) {
    throw new SlackAppManifestProviderErrorV1(
      "unavailable",
      "Slack returned an empty manifest response",
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
        throw new SlackAppManifestProviderErrorV1(
          "unavailable",
          "Slack manifest request is unavailable",
        );
      }
      if (read.done) break;
      totalBytes += read.value.byteLength;
      if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {}
        throw new SlackAppManifestProviderErrorV1(
          "unavailable",
          "Slack returned an oversized manifest response",
        );
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) {
    throw new SlackAppManifestProviderErrorV1(
      "unavailable",
      "Slack returned an empty manifest response",
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

/**
 * Slack Manifest API client for one-time app configuration tokens. This is a
 * deliberately separate transport from `SlackWebIdentityProviderV1`, which
 * requires an `xoxb-` bot token: configuration tokens have a different shape
 * and a 12-hour lifetime, and loosening the bot-token check there would let
 * a configuration token flow through code that expects a bot token.
 */
export class SlackWebAppManifestProviderV1 implements SlackAppManifestProviderV1 {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    options: {
      readonly fetch?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      typeof this.fetchImpl !== "function" ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > MAXIMUM_TIMEOUT_MS
    ) {
      throw new Error("Slack manifest transport configuration is invalid");
    }
  }

  private async call(
    configurationToken: string,
    method: "apps.manifest.create" | "apps.manifest.update",
    parameters: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${configurationToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(parameters),
        redirect: "error",
        signal: combined,
      });
    } catch {
      throw new SlackAppManifestProviderErrorV1(
        "unavailable",
        "Slack manifest request is unavailable",
      );
    }
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)
    ) {
      throw new SlackAppManifestProviderErrorV1(
        "unavailable",
        "Slack returned an oversized manifest response",
      );
    }
    const bytes = await readBoundedManifestResponseBytes(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new SlackAppManifestProviderErrorV1(
        "unavailable",
        "Slack returned an invalid manifest response",
      );
    }
    const value = record(parsed);
    if (value === undefined) {
      throw new SlackAppManifestProviderErrorV1(
        "unavailable",
        "Slack returned an invalid manifest response",
      );
    }
    if (value.ok !== true) {
      const error = value.error;
      const invalidToken =
        error === "invalid_auth" ||
        error === "not_authed" ||
        error === "token_expired" ||
        error === "token_revoked";
      const invalidManifest = error === "invalid_manifest";
      throw new SlackAppManifestProviderErrorV1(
        invalidToken ? "invalid_token" : invalidManifest ? "invalid_manifest" : "unavailable",
        "Slack rejected the manifest request",
      );
    }
    return value;
  }

  async createApp(input: {
    configuration_token: string;
    manifest: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<CreatedSlackAppV1> {
    const value = await this.call(
      input.configuration_token,
      "apps.manifest.create",
      { manifest: JSON.stringify(input.manifest) },
      input.signal,
    );
    return parseCreatedSlackApp(value);
  }

  async updateApp(input: {
    configuration_token: string;
    app_id: string;
    manifest: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.call(
      input.configuration_token,
      "apps.manifest.update",
      { manifest: JSON.stringify(input.manifest), app_id: input.app_id },
      input.signal,
    );
  }
}
