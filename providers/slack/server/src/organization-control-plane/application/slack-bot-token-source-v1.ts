import type { OrganizationSecretStore } from "@echo-brain/organization-control-plane/application/organization-secret-store-contracts";
import { canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import type { NangoConnectionClientV1 } from "../adapters/nango/nango-connection-client-v1.js";
import type { StoredSlackConnectionV1 } from "../persistence/sqlite-slack-active-connection-v1.js";
import { findSlackAppCredentialsByReferenceSha256V1 } from "./slack-app-credentials-v1.js";

const NANGO_BOT_TOKEN_CACHE_MS = 300_000;

export interface SlackBotTokenSourceV1 {
  botToken(
    connection: StoredSlackConnectionV1,
    options?: { force_refresh?: boolean },
  ): Promise<string>;
}

/** One use of a bot token; `force_refresh` asks for a token newer than any cached one. */
export type SlackBotTokenGetterV1 = (options?: {
  readonly force_refresh?: boolean;
}) => Promise<string>;

/**
 * The legacy rule of `SqliteSlackBotTokenReaderV1`: the one local secret whose
 * canonical reference digest the active state commits to.
 */
function legacyBotToken(
  secrets: OrganizationSecretStore,
  connection: StoredSlackConnectionV1,
): string {
  const matches = secrets
    .listReferences()
    .filter(
      (reference) =>
        canonicalSha256(reference) === connection.state.credential_reference_sha256,
    );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error("Slack bot credential reference is unavailable");
  }
  return secrets.read(matches[0]);
}

/**
 * Picks the bot token by connection kind: a legacy connection reads its local
 * secret on every use; a Nango connection asks Nango for the connection named
 * by its credential bundle and reuses that token for at most five minutes per
 * connection state. Thrown messages never include a token.
 */
export function createSlackBotTokenSourceV1(input: {
  readonly secrets: OrganizationSecretStore;
  readonly nango?: NangoConnectionClientV1;
  readonly now?: () => number;
}): SlackBotTokenSourceV1 {
  const now = input.now ?? Date.now;
  const cache = new Map<string, { readonly token: string; readonly expires_at_ms: number }>();
  return Object.freeze({
    async botToken(
      connection: StoredSlackConnectionV1,
      options: { force_refresh?: boolean } = {},
    ): Promise<string> {
      if (connection.kind === "legacy") return legacyBotToken(input.secrets, connection);
      if (input.nango === undefined) throw new Error("Nango is not configured");
      const forceRefresh = options.force_refresh === true;
      const cached = cache.get(connection.state_sha256);
      if (!forceRefresh && cached !== undefined && now() < cached.expires_at_ms) {
        return cached.token;
      }
      const { credentials } = findSlackAppCredentialsByReferenceSha256V1(
        input.secrets,
        connection.state.credential_reference_sha256,
      );
      if (credentials.nango_connection_id === null) {
        throw new Error("Slack app has no Nango connection");
      }
      const requestedAt = now();
      const nango = await input.nango.getSlackConnection({
        connection_id: credentials.nango_connection_id,
        force_refresh: forceRefresh,
      });
      if (
        nango.team_id !== connection.connection.provider_tenant_id ||
        nango.app_id !== connection.connection.provider_app_id ||
        nango.bot_user_id !== connection.connection.provider_bot_user_id
      ) {
        throw new Error("Nango Slack connection does not match the active connection");
      }
      for (const [state, entry] of cache) {
        if (entry.expires_at_ms <= requestedAt) cache.delete(state);
      }
      cache.set(connection.state_sha256, {
        token: nango.bot_token,
        expires_at_ms: requestedAt + NANGO_BOT_TOKEN_CACHE_MS,
      });
      return nango.bot_token;
    },
  });
}

/**
 * The one rule for a bot token Slack rejects. The operation runs with a
 * token; on an auth failure it runs once more with a force-refreshed token,
 * unless the refresh returns the very token Slack just rejected (a legacy
 * local secret always does). An auth failure that the refresh does not cure
 * calls `on_auth_failure` (callers mark the connection "needs reinstall")
 * and is rethrown. Other failures are rethrown untouched. A failing report
 * or refresh never replaces the Slack error.
 */
export async function withSlackBotTokenV1<T>(
  input: {
    readonly token: SlackBotTokenGetterV1;
    readonly is_auth_failure: (error: unknown) => boolean;
    readonly on_auth_failure?: (error: unknown) => void;
  },
  operation: (token: string) => Promise<T>,
): Promise<T> {
  const first = await input.token();
  let failure: unknown;
  try {
    return await operation(first);
  } catch (error) {
    if (!input.is_auth_failure(error)) throw error;
    failure = error;
  }
  let refreshed: string | undefined;
  try {
    refreshed = await input.token({ force_refresh: true });
  } catch {
    refreshed = undefined;
  }
  if (refreshed !== undefined && refreshed !== first) {
    try {
      return await operation(refreshed);
    } catch (error) {
      if (!input.is_auth_failure(error)) throw error;
      failure = error;
    }
  }
  try {
    input.on_auth_failure?.(failure);
  } catch {
    // Health is advisory; the caller still receives the Slack error.
  }
  throw failure;
}
