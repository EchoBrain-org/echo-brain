import { ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CALLBACK_PATH } from "@echo-brain/provider-slack-client/organization-api/person-slack-browser-link";
import { PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1 } from "../../../presentation/private-slack-approval-interaction-http-port-v1.js";
import {
  BoundedJsonFetchErrorV1,
  boundedJsonFetchV1,
} from "../../../shared/bounded-json-fetch-v1.js";
import { SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1, slackPrivateAppBotScopesV1, type SlackPublicChannelContextCapabilityV1 } from "../../application/slack-integration-contracts.js";

const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;

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
 * module that already owns that path. The bot scopes are the install's; the
 * user scopes serve only that browser sign-in. Interactivity always points at
 * this Authority's signed interaction endpoint.
 */
export function buildEchoSlackAppManifestV1(input: {
  readonly authority_url: string;
  readonly nango_callback_url: string;
  readonly public_channel_context?: SlackPublicChannelContextCapabilityV1;
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
      // A person replies to ECHO's DM (the identity-link code) in the app's Messages tab.
      app_home: Object.freeze({ home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false }),
      bot_user: Object.freeze({ display_name: "ECHO", always_online: false }),
    }),
    oauth_config: Object.freeze({
      redirect_urls: Object.freeze([
        input.nango_callback_url,
        `${authorityOrigin}${ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CALLBACK_PATH}`,
      ]),
      scopes: Object.freeze({ bot: slackPrivateAppBotScopesV1(input.public_channel_context), user: SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1 }),
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

/**
 * Slack Manifest API client for one-time app configuration tokens. This is a
 * deliberately separate transport from `SlackWebIdentityProviderV1`, which
 * requires an `xoxb-` bot token: configuration tokens have a different shape
 * and a 12-hour lifetime, and loosening the bot-token check there would let
 * a configuration token flow through code that expects a bot token.
 */
export class SlackWebAppManifestProviderV1 implements SlackAppManifestProviderV1 {
  private readonly fetchImpl: typeof fetch;

  constructor(options: { readonly fetch?: typeof fetch } = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Slack manifest transport configuration is invalid");
    }
  }

  private async call(
    configurationToken: string,
    method: "apps.manifest.create" | "apps.manifest.update",
    parameters: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let result;
    try {
      result = await boundedJsonFetchV1({
        url: `https://slack.com/api/${method}`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${configurationToken}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(parameters),
        },
        fetch: this.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        signal,
        maxBytes: MAXIMUM_RESPONSE_BYTES,
      });
    } catch (error) {
      if (error instanceof BoundedJsonFetchErrorV1) {
        throw new SlackAppManifestProviderErrorV1(
          "unavailable",
          "Slack manifest request is unavailable",
        );
      }
      throw error;
    }
    const value = record(result.json);
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
