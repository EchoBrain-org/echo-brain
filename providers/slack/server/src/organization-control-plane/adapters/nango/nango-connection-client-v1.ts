import {
  BoundedJsonFetchErrorV1,
  boundedJsonFetchV1,
} from "../../../shared/bounded-json-fetch-v1.js";

const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;
const INTEGRATION_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BOT_TOKEN_PATTERN = /^xoxb-/;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const MAXIMUM_CONNECT_SESSION_TOKEN_LENGTH = 4096;

/**
 * Configuration for one environment's Nango integration. `secret_key` comes
 * from a private credential file (`readPrivateAuthorityCredential`) and must
 * never be logged; this module never includes it in a thrown message.
 */
export interface NangoConfigurationV1 {
  readonly base_url: string; // https origin, default "https://api.nango.dev"
  readonly secret_key: string; // from a private credential file; never logged
  readonly integration_key: string; // /^[a-z0-9][a-z0-9_-]{0,63}$/
}

export class NangoClientErrorV1 extends Error {
  constructor(
    readonly code: "unauthorized" | "not_found" | "invalid_response" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "NangoClientErrorV1";
  }
}

/**
 * The fields ECHO reads out of a Nango Slack connection. All response-shape
 * knowledge for a connection lives in `parseNangoSlackConnectionV1` below, so
 * a correction once a real Nango response is observed touches one place.
 */
export interface NangoSlackConnectionV1 {
  readonly connection_id: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly team_id: string; // T…
  readonly app_id: string; // A…
  readonly bot_user_id: string; // U…
  readonly granted_scopes: readonly string[]; // sorted, from raw.scope
  readonly bot_token: string; // xoxb-… (only held in memory by callers)
}

export interface NangoConnectionClientV1 {
  createConnectSession(input: {
    tags: Readonly<Record<string, string>>;
    client_id: string;
    client_secret: string;
    scopes: readonly string[];
  }): Promise<{ connect_link: string }>;
  createReconnectSession(input: {
    connection_id: string;
    tags: Readonly<Record<string, string>>;
    client_id: string;
    client_secret: string;
    scopes: readonly string[];
  }): Promise<{ connect_link: string }>;
  findConnectionIdByTag(input: { key: string; value: string }): Promise<string | undefined>;
  getSlackConnection(input: { connection_id: string }): Promise<NangoSlackConnectionV1>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const candidate = record(value);
  if (candidate === undefined) return undefined;
  for (const key of Object.keys(candidate)) {
    if (typeof candidate[key] !== "string") return undefined;
  }
  return candidate as Record<string, string>;
}

function invalidConnection(): never {
  throw new NangoClientErrorV1("invalid_response", "Nango returned an invalid Slack connection");
}

/**
 * Parses one Nango connection response down to the fields ECHO needs.
 * Spike-sensitive: that `credentials.raw` carries the Slack
 * `oauth.v2.access` response verbatim and `credentials.access_token` is the
 * bot token is assumed, not observed, since ADR-0025's phase-0 spike is
 * unrecorded. Strict: throws
 * `NangoClientErrorV1("invalid_response", …)` for any missing or malformed
 * field, and never includes a candidate value (including the bot token) in
 * its thrown message. Refuses an
 * Enterprise-Grid org-wide install (`is_enterprise_install: true`), so no
 * caller sees one; a single-workspace install inside a Grid org is accepted.
 */
export function parseNangoSlackConnectionV1(value: unknown): NangoSlackConnectionV1 {
  const top = record(value);
  if (top === undefined) invalidConnection();

  const connectionId = nonEmptyString(top.connection_id);
  const tags: Record<string, string> | undefined =
    top.tags === undefined ? {} : stringRecord(top.tags);
  const credentials = record(top.credentials);
  const botToken = credentials === undefined ? undefined : nonEmptyString(credentials.access_token);
  const raw = credentials === undefined ? undefined : record(credentials.raw);
  const team = raw === undefined ? undefined : record(raw.team);
  const teamId = team === undefined ? undefined : nonEmptyString(team.id);
  const appId = raw === undefined ? undefined : nonEmptyString(raw.app_id);
  const botUserId = raw === undefined ? undefined : nonEmptyString(raw.bot_user_id);
  const isEnterpriseInstall = raw === undefined ? undefined : raw.is_enterprise_install;
  const scopeRaw = raw === undefined ? undefined : raw.scope;

  if (
    connectionId === undefined ||
    tags === undefined ||
    botToken === undefined ||
    !BOT_TOKEN_PATTERN.test(botToken) ||
    raw === undefined ||
    teamId === undefined ||
    appId === undefined ||
    botUserId === undefined ||
    typeof isEnterpriseInstall !== "boolean" ||
    isEnterpriseInstall ||
    typeof scopeRaw !== "string"
  ) {
    invalidConnection();
  }

  const grantedScopes = Object.freeze(
    scopeRaw
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0)
      .sort(),
  );

  return Object.freeze({
    connection_id: connectionId,
    tags: Object.freeze({ ...tags }),
    team_id: teamId,
    app_id: appId,
    bot_user_id: botUserId,
    granted_scopes: grantedScopes,
    bot_token: botToken,
  });
}

/**
 * Nango returns a short-lived Connect-session token alongside its hosted UI
 * link. ECHO opens Nango's native OAuth endpoint instead: it keeps the
 * selected OAuth client secret in Nango's server-side session defaults and
 * lets Nango set its browser state cookie before redirecting to Slack.
 */
function parseNangoConnectSessionResponseV1(value: unknown, baseUrl: string, integrationKey: string): { connect_link: string } {
  const top = record(value);
  const data = top === undefined ? undefined : record(top.data);
  const token = data === undefined ? undefined : data.token;
  if (typeof token !== "string" || token.length === 0 || token.length > MAXIMUM_CONNECT_SESSION_TOKEN_LENGTH || !VISIBLE_ASCII.test(token)) {
    throw new NangoClientErrorV1("invalid_response", "Nango returned an invalid connect session");
  }
  const nativeOAuth = new URL(`/oauth/connect/${encodeURIComponent(integrationKey)}`, baseUrl);
  nativeOAuth.searchParams.set("connect_session_token", token);
  const connectLink = nativeOAuth.toString();
  if (connectLink.length > 4096) throw new NangoClientErrorV1("invalid_response", "Nango returned an invalid connect session");
  return Object.freeze({ connect_link: connectLink });
}

/** `{ connections: [ { connection_id, tags, … } ] }` (assumed, not observed); returns only the ids. */
function parseNangoConnectionIdsV1(value: unknown): readonly string[] {
  const top = record(value);
  const list = top === undefined ? undefined : top.connections;
  if (!Array.isArray(list)) {
    throw new NangoClientErrorV1("invalid_response", "Nango returned an invalid connection list");
  }
  const ids: string[] = [];
  for (const item of list) {
    const itemRecord = record(item);
    const id = itemRecord === undefined ? undefined : nonEmptyString(itemRecord.connection_id);
    if (id === undefined) {
      throw new NangoClientErrorV1("invalid_response", "Nango returned an invalid connection list");
    }
    ids.push(id);
  }
  return ids;
}

function assertValidNangoConfigurationV1(value: NangoConfigurationV1): URL {
  let baseUrl: URL;
  try {
    baseUrl = new URL(value.base_url);
  } catch {
    throw new Error("Nango configuration is invalid");
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== "" ||
    baseUrl.pathname !== "/" ||
    typeof value.secret_key !== "string" ||
    value.secret_key.length === 0 ||
    typeof value.integration_key !== "string" ||
    !INTEGRATION_KEY_PATTERN.test(value.integration_key)
  ) {
    throw new Error("Nango configuration is invalid");
  }
  return baseUrl;
}

/**
 * Builds the `integrations_config_defaults` override block shared by connect
 * and reconnect sessions, so each organization's private Slack app keeps its
 * own OAuth client instead of a shared one.
 */
function connectionConfigOverrides(
  integrationKey: string,
  input: { readonly client_id: string; readonly client_secret: string; readonly scopes: readonly string[] },
): Record<string, unknown> {
  return {
    [integrationKey]: {
      authorization_params: {
        client_id: input.client_id,
      },
      connection_config: {
        oauth_client_id_override: input.client_id,
        oauth_client_secret_override: input.client_secret,
        oauth_scopes_override: input.scopes.join(","),
      },
    },
  };
}

/**
 * Nango (Cloud) HTTP client: connect/reconnect sessions, finding a
 * connection by tag, and reading a Slack connection. Every
 * request goes through the shared `boundedJsonFetchV1` transport
 * (`redirect: "error"`, a combined timeout, a 512 KiB response cap, strict
 * JSON); transport failures always map to `NangoClientErrorV1("unavailable",
 * …)`. Nango's HTTP status is otherwise authoritative for error mapping
 * (401/403 → `unauthorized`, 404 → `not_found`, any other non-2xx →
 * `unavailable`); this client never reads a response body to decide the
 * error code, and never includes a response body, the secret key, or a
 * caller-supplied client secret in a thrown message.
 */
export class HttpNangoConnectionClientV1 implements NangoConnectionClientV1 {
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly integrationKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    configuration: NangoConfigurationV1,
    options: { readonly fetch?: typeof fetch } = {},
  ) {
    const baseUrl = assertValidNangoConfigurationV1(configuration);
    this.baseUrl = baseUrl.origin;
    this.secretKey = configuration.secret_key;
    this.integrationKey = configuration.integration_key;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Nango transport configuration is invalid");
    }
  }

  private async request(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: Readonly<Record<string, unknown>>;
  }): Promise<unknown> {
    let result;
    try {
      result = await boundedJsonFetchV1({
        url: `${this.baseUrl}${input.path}`,
        init: {
          method: input.method,
          headers:
            input.body === undefined
              ? { accept: "application/json", authorization: `Bearer ${this.secretKey}` }
              : {
                  accept: "application/json",
                  authorization: `Bearer ${this.secretKey}`,
                  "content-type": "application/json",
                },
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
        },
        fetch: this.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAXIMUM_RESPONSE_BYTES,
      });
    } catch (error) {
      if (error instanceof BoundedJsonFetchErrorV1) {
        throw new NangoClientErrorV1("unavailable", "Nango request is unavailable");
      }
      throw error;
    }
    if (result.status === 401 || result.status === 403) {
      throw new NangoClientErrorV1("unauthorized", "Nango rejected the request as unauthorized");
    }
    if (result.status === 404) {
      throw new NangoClientErrorV1("not_found", "Nango connection was not found");
    }
    if (!result.ok) {
      throw new NangoClientErrorV1("unavailable", "Nango request is unavailable");
    }
    return result.json;
  }

  async createConnectSession(input: {
    tags: Readonly<Record<string, string>>;
    client_id: string;
    client_secret: string;
    scopes: readonly string[];
  }): Promise<{ connect_link: string }> {
    const json = await this.request({
      method: "POST",
      path: "/connect/sessions",
      body: {
        tags: input.tags,
        allowed_integrations: [this.integrationKey],
        integrations_config_defaults: connectionConfigOverrides(this.integrationKey, input),
      },
    });
    return parseNangoConnectSessionResponseV1(json, this.baseUrl, this.integrationKey);
  }

  async createReconnectSession(input: {
    connection_id: string;
    tags: Readonly<Record<string, string>>;
    client_id: string;
    client_secret: string;
    scopes: readonly string[];
  }): Promise<{ connect_link: string }> {
    const json = await this.request({
      method: "POST",
      path: "/connect/sessions/reconnect",
      body: {
        connection_id: input.connection_id,
        integration_id: this.integrationKey,
        tags: input.tags,
        integrations_config_defaults: connectionConfigOverrides(this.integrationKey, input),
      },
    });
    return parseNangoConnectSessionResponseV1(json, this.baseUrl, this.integrationKey);
  }

  async findConnectionIdByTag(input: { key: string; value: string }): Promise<string | undefined> {
    const json = await this.request({
      method: "GET",
      path: `/connections?tags[${encodeURIComponent(input.key)}]=${encodeURIComponent(input.value)}`,
    });
    const ids = parseNangoConnectionIdsV1(json);
    if (ids.length === 0) return undefined;
    if (ids.length !== 1) {
      throw new NangoClientErrorV1(
        "invalid_response",
        "More than one Nango connection matched the tag",
      );
    }
    return ids[0];
  }

  /** Bot-token rotation is off in the recipe, so this never asks Nango to refresh: a new token comes only from a reconnect. */
  async getSlackConnection(input: { connection_id: string }): Promise<NangoSlackConnectionV1> {
    const json = await this.request({
      method: "GET",
      path: `/connections/${encodeURIComponent(input.connection_id)}?provider_config_key=${encodeURIComponent(this.integrationKey)}`,
    });
    return parseNangoSlackConnectionV1(json);
  }
}
