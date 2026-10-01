import {
  BoundedJsonFetchErrorV1,
  boundedJsonFetchV1,
} from "../../../shared/bounded-json-fetch-v1.js";

const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAXIMUM_TIMEOUT_MS = 60_000;
const INTEGRATION_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BOT_TOKEN_PATTERN = /^xoxb-/;

/**
 * Configuration for one environment's Nango integration. `secret_key` comes
 * from a private credential file (`readPrivateAuthorityCredential`) and must
 * never be logged; this module never includes it in a thrown message.
 */
export interface NangoConfigurationV1 {
  readonly base_url: string; // https origin, default "https://api.nango.dev"
  readonly secret_key: string; // from a private credential file; never logged
  readonly integration_key: string; // /^[a-z0-9][a-z0-9_-]{0,63}$/
  readonly callback_url: string; // `${base_url}/oauth/callback` unless configured
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
 * a correction after the real-Nango spike (controller ruling P1) touches one
 * place.
 */
export interface NangoSlackConnectionV1 {
  readonly connection_id: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly team_id: string; // T…
  readonly enterprise_id: string | null;
  readonly is_enterprise_install: boolean;
  readonly app_id: string; // A…
  readonly bot_user_id: string; // U…
  readonly granted_scopes: readonly string[]; // sorted, from raw.scope
  readonly bot_token: string; // xoxb-… (only held in memory by callers)
  readonly updated_at: string; // connection update timestamp (A5); advances when a reconnect completes
}

export interface NangoConnectionClientV1 {
  createConnectSession(input: {
    tags: Readonly<Record<string, string>>;
    client_id: string;
    client_secret: string;
    scopes: readonly string[];
  }): Promise<{ connect_link: string; expires_at: string }>;
  createReconnectSession(input: {
    connection_id: string;
    tags: Readonly<Record<string, string>>;
    client_id: string;
    client_secret: string;
    scopes: readonly string[];
  }): Promise<{ connect_link: string; expires_at: string }>;
  findConnectionIdByTag(input: { key: string; value: string }): Promise<string | undefined>;
  getSlackConnection(input: {
    connection_id: string;
    force_refresh?: boolean;
  }): Promise<NangoSlackConnectionV1>;
  deleteConnection(input: { connection_id: string }): Promise<void>;
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
 * Parses one Nango connection response down to the fields ECHO needs,
 * against assumptions A1/A2/A5 (controller ruling P1, spike pending):
 * `credentials.raw` carries the Slack `oauth.v2.access` response verbatim,
 * `credentials.access_token` is the bot token, and `updated_at` is an ISO
 * timestamp. Strict: throws `NangoClientErrorV1("invalid_response", …)` for
 * any missing or malformed field, and never includes a candidate value
 * (including the bot token) in its thrown message. Refuses an
 * Enterprise-Grid org-wide install (`is_enterprise_install: true`); a
 * single-workspace install inside a Grid org (non-null `enterprise`, but
 * `is_enterprise_install: false`) is accepted.
 */
export function parseNangoSlackConnectionV1(value: unknown): NangoSlackConnectionV1 {
  const top = record(value);
  if (top === undefined) invalidConnection();

  const connectionId = nonEmptyString(top.connection_id);
  const tags: Record<string, string> | undefined =
    top.tags === undefined ? {} : stringRecord(top.tags);
  const updatedAt = nonEmptyString(top.updated_at);
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
    updatedAt === undefined ||
    Number.isNaN(Date.parse(updatedAt)) ||
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

  let enterpriseId: string | null;
  const enterpriseRaw = raw.enterprise;
  if (enterpriseRaw === null) {
    enterpriseId = null;
  } else {
    const enterpriseRecord = record(enterpriseRaw);
    const id = enterpriseRecord === undefined ? undefined : nonEmptyString(enterpriseRecord.id);
    if (id === undefined) invalidConnection();
    enterpriseId = id;
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
    enterprise_id: enterpriseId,
    is_enterprise_install: isEnterpriseInstall,
    app_id: appId,
    bot_user_id: botUserId,
    granted_scopes: grantedScopes,
    bot_token: botToken,
    updated_at: updatedAt,
  });
}

/** `{ data: { token, connect_link, expires_at } }`; `token` is never returned or logged. */
function parseNangoConnectSessionResponseV1(value: unknown): {
  connect_link: string;
  expires_at: string;
} {
  const top = record(value);
  const data = top === undefined ? undefined : record(top.data);
  const connectLink = data === undefined ? undefined : nonEmptyString(data.connect_link);
  const expiresAt = data === undefined ? undefined : nonEmptyString(data.expires_at);
  if (connectLink === undefined || expiresAt === undefined) {
    throw new NangoClientErrorV1("invalid_response", "Nango returned an invalid connect session");
  }
  return Object.freeze({ connect_link: connectLink, expires_at: expiresAt });
}

/** `{ connections: [ { connection_id, tags, … } ] }` (A3); returns only the ids. */
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
    !INTEGRATION_KEY_PATTERN.test(value.integration_key) ||
    typeof value.callback_url !== "string" ||
    value.callback_url.length === 0
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
 * connection by tag, reading a Slack connection, and deleting one. Every
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
  private readonly timeoutMs: number;

  constructor(
    configuration: NangoConfigurationV1,
    options: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {},
  ) {
    const baseUrl = assertValidNangoConfigurationV1(configuration);
    this.baseUrl = baseUrl.origin;
    this.secretKey = configuration.secret_key;
    this.integrationKey = configuration.integration_key;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      typeof this.fetchImpl !== "function" ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > MAXIMUM_TIMEOUT_MS
    ) {
      throw new Error("Nango transport configuration is invalid");
    }
  }

  private async request(input: {
    readonly method: "GET" | "POST" | "DELETE";
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
        timeoutMs: this.timeoutMs,
        maxBytes: MAXIMUM_RESPONSE_BYTES,
        // Nango's protocol is carried by HTTP status, not by always having a
        // body: a successful delete may be a 204/empty 200, and an error
        // response may have no body at all. Status is classified below
        // before the (possibly empty) body is ever inspected.
        allowEmptyBody: true,
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
  }): Promise<{ connect_link: string; expires_at: string }> {
    const json = await this.request({
      method: "POST",
      path: "/connect/sessions",
      body: {
        tags: input.tags,
        allowed_integrations: [this.integrationKey],
        integrations_config_defaults: connectionConfigOverrides(this.integrationKey, input),
      },
    });
    return parseNangoConnectSessionResponseV1(json);
  }

  async createReconnectSession(input: {
    connection_id: string;
    tags: Readonly<Record<string, string>>;
    client_id: string;
    client_secret: string;
    scopes: readonly string[];
  }): Promise<{ connect_link: string; expires_at: string }> {
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
    return parseNangoConnectSessionResponseV1(json);
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

  async getSlackConnection(input: {
    connection_id: string;
    force_refresh?: boolean;
  }): Promise<NangoSlackConnectionV1> {
    let query = `provider_config_key=${encodeURIComponent(this.integrationKey)}`;
    if (input.force_refresh === true) query += "&force_refresh=true";
    const json = await this.request({
      method: "GET",
      path: `/connections/${encodeURIComponent(input.connection_id)}?${query}`,
    });
    return parseNangoSlackConnectionV1(json);
  }

  async deleteConnection(input: { connection_id: string }): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/connections/${encodeURIComponent(input.connection_id)}?provider_config_key=${encodeURIComponent(this.integrationKey)}`,
    });
  }
}
