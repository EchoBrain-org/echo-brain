import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSha256 } from "../../../../../../packages/organization-control-plane/src/canonical/canonical-json.js";
import { FileOrganizationSecretStore } from "../../../../../../packages/organization-control-plane/src/security/file-secret-store.js";
import type { NangoConnectionClientV1, NangoSlackConnectionV1 } from "../../../src/organization-control-plane/adapters/nango/nango-connection-client-v1.js";
import { serializeSlackAppCredentialsV1 } from "../../../src/organization-control-plane/application/slack-app-credentials-v1.js";
import { createSlackBotTokenSourceV1, withSlackBotTokenV1 } from "../../../src/organization-control-plane/application/slack-bot-token-source-v1.js";
import { SlackConnectionHealthV1 } from "../../../src/organization-control-plane/application/slack-connection-health-v1.js";
import type { StoredSlackConnectionV1 } from "../../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function secretStore(): FileOrganizationSecretStore {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "echo-slack-bot-token-")));
  directories.push(directory);
  return new FileOrganizationSecretStore(join(directory, "secrets"));
}

/** The source reads only the provider ids, the reference digest and the state hash. */
function stored(reference: object, stateSha256: `sha256:${string}` = canonicalSha256({ state: "nango" })): StoredSlackConnectionV1 {
  return {
    connection: { provider_tenant_id: "T0TEAM", provider_app_id: "A0APP1", provider_bot_user_id: "U0BOT" },
    state: { credential_reference_sha256: canonicalSha256(reference) },
    state_sha256: stateSha256,
  } as unknown as StoredSlackConnectionV1;
}

function nangoFake(): NangoConnectionClientV1 & { getSlackConnection: ReturnType<typeof vi.fn> } {
  let issued = 0;
  return {
    getSlackConnection: vi.fn(async (): Promise<NangoSlackConnectionV1> => ({
      connection_id: "nango-conn-1", tags: {}, team_id: "T0TEAM", enterprise_id: null,
      is_enterprise_install: false, app_id: "A0APP1", bot_user_id: "U0BOT",
      granted_scopes: [], bot_token: `xoxb-nango-${(issued += 1)}`, updated_at: "2026-09-30T00:00:00.000Z",
    })),
  } as unknown as NangoConnectionClientV1 & { getSlackConnection: ReturnType<typeof vi.fn> };
}

function nangoConnection(secrets: FileOrganizationSecretStore) {
  const reference = secrets.create(serializeSlackAppCredentialsV1({
    kind: "echo-slack-app-credentials-v1", app_id: "A0APP1", client_id: "1234.5678",
    client_secret: "client-secret-value", signing_secret: "signing-secret-value",
    nango_connection_id: "nango-conn-1",
  }));
  return stored(reference);
}

describe("Slack bot-token source V1", () => {
  it("fetches a Nango token once, caches it per state for five minutes, then fetches again", async () => {
    const secrets = secretStore();
    const nango = nangoFake();
    let now = 1_000;
    const source = createSlackBotTokenSourceV1({ secrets, nango, now: () => now });
    const connection = nangoConnection(secrets);

    await expect(source.botToken(connection)).resolves.toBe("xoxb-nango-1");
    now += 299_999;
    await expect(source.botToken(connection)).resolves.toBe("xoxb-nango-1");
    expect(nango.getSlackConnection).toHaveBeenCalledTimes(1);
    expect(nango.getSlackConnection).toHaveBeenCalledWith({ connection_id: "nango-conn-1", force_refresh: false });
    now += 1;
    await expect(source.botToken(connection)).resolves.toBe("xoxb-nango-2");
    expect(nango.getSlackConnection).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache on force_refresh and keeps the refreshed token", async () => {
    const secrets = secretStore();
    const nango = nangoFake();
    const source = createSlackBotTokenSourceV1({ secrets, nango, now: () => 0 });
    const connection = nangoConnection(secrets);

    await source.botToken(connection);
    await expect(source.botToken(connection, { force_refresh: true })).resolves.toBe("xoxb-nango-2");
    expect(nango.getSlackConnection).toHaveBeenLastCalledWith({ connection_id: "nango-conn-1", force_refresh: true });
    await expect(source.botToken(connection)).resolves.toBe("xoxb-nango-2");
    expect(nango.getSlackConnection).toHaveBeenCalledTimes(2);
  });

  it("refuses a Nango token for another workspace or app", async () => {
    const secrets = secretStore();
    const connection = nangoConnection(secrets);
    const nango = nangoFake();
    const other = { ...connection, connection: { ...connection.connection, provider_tenant_id: "T0OTHER" } };
    const failure = await createSlackBotTokenSourceV1({ secrets, nango }).botToken(other).catch((error: Error) => error);
    expect(failure).toEqual(new Error("Nango Slack connection does not match the active connection"));
    expect(String(failure)).not.toContain("xoxb-");
  });
});

describe("Slack bot-token auth-failure rule", () => {
  const authFailure = Object.assign(new Error("invalid_auth"), { auth: true });
  const isAuthFailure = (error: unknown) => (error as { auth?: boolean }).auth === true;

  async function rule(results: ReadonlyArray<"auth" | "ok" | "other">) {
    const secrets = secretStore();
    const nango = nangoFake();
    const source = createSlackBotTokenSourceV1({ secrets, nango, now: () => 0 });
    const connection = nangoConnection(secrets);
    const health = new SlackConnectionHealthV1();
    const used: string[] = [];
    const outcome = withSlackBotTokenV1(
      {
        token: (options) => source.botToken(connection, options),
        is_auth_failure: isAuthFailure,
        on_auth_failure: () => health.markNeedsReinstall(connection.state_sha256),
      },
      async (token) => {
        const result = results[used.push(token) - 1];
        if (result === "auth") throw authFailure;
        if (result === "other") throw new Error("Slack is unavailable");
        return `done with ${token}`;
      },
    );
    return { outcome, used, health, connection, nango };
  }

  it("retries an auth failure once with a refreshed token, then marks the connection and rethrows", async () => {
    const context = await rule(["auth", "auth"]);
    await expect(context.outcome).rejects.toBe(authFailure);
    expect(context.used).toEqual(["xoxb-nango-1", "xoxb-nango-2"]);
    expect(context.nango.getSlackConnection).toHaveBeenLastCalledWith({ connection_id: "nango-conn-1", force_refresh: true });
    expect(context.health.needsReinstall(context.connection.state_sha256)).toBe(true);
  });

  it("uses the refreshed token when it works, and never retries other failures", async () => {
    const recovered = await rule(["auth", "ok"]);
    await expect(recovered.outcome).resolves.toBe("done with xoxb-nango-2");
    expect(recovered.health.needsReinstall(recovered.connection.state_sha256)).toBe(false);

    const unavailable = await rule(["other"]);
    await expect(unavailable.outcome).rejects.toThrow("Slack is unavailable");
    expect(unavailable.used).toEqual(["xoxb-nango-1"]);
    expect(unavailable.health.needsReinstall(unavailable.connection.state_sha256)).toBe(false);
  });

  it("does not repeat the call when the refresh returns the rejected token", async () => {
    const onAuthFailure = vi.fn();
    const operation = vi.fn(async () => { throw authFailure; });
    await expect(withSlackBotTokenV1(
      { token: async () => "xoxb-local", is_auth_failure: isAuthFailure, on_auth_failure: onAuthFailure },
      operation,
    )).rejects.toBe(authFailure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledWith(authFailure);
  });

  it("marks nothing when the refresh itself fails, and rethrows Slack's error", async () => {
    const onAuthFailure = vi.fn();
    const operation = vi.fn(async () => { throw authFailure; });
    const token = vi.fn(async (options?: { force_refresh?: boolean }) => {
      if (options?.force_refresh === true) throw new Error("Nango is unavailable");
      return "xoxb-cached";
    });
    await expect(withSlackBotTokenV1({ token, is_auth_failure: isAuthFailure, on_auth_failure: onAuthFailure }, operation))
      .rejects.toBe(authFailure);
    expect(token).toHaveBeenLastCalledWith({ force_refresh: true });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it("does not refresh a connection already marked as needing reinstall", async () => {
    const context = await rule(["auth", "auth", "auth"]);
    await expect(context.outcome).rejects.toBe(authFailure);
    const token = vi.fn(async () => "xoxb-nango-2");
    const operation = vi.fn(async () => { throw authFailure; });
    await expect(withSlackBotTokenV1({
      token, is_auth_failure: isAuthFailure,
      needs_reinstall: () => context.health.needsReinstall(context.connection.state_sha256),
    }, operation)).rejects.toBe(authFailure);
    expect(token).toHaveBeenCalledOnce();
    expect(token).toHaveBeenCalledWith();
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe("Slack connection health V1", () => {
  it("marks a state as needing reinstall until cleared", () => {
    const health = new SlackConnectionHealthV1();
    expect(health.needsReinstall(undefined)).toBe(false);
    health.markNeedsReinstall("sha256:state-a");
    expect(health.needsReinstall("sha256:state-a")).toBe(true);
    expect(health.needsReinstall("sha256:state-b")).toBe(false);
    health.clear();
    expect(health.needsReinstall("sha256:state-a")).toBe(false);
  });
});
