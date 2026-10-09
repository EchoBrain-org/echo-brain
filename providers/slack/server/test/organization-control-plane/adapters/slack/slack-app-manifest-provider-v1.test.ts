import { describe, expect, it, vi } from "vitest";
import {
  buildEchoSlackAppManifestV1,
  SlackAppManifestProviderErrorV1,
  SlackWebAppManifestProviderV1,
} from "../../../../src/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1, SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1 } from "../../../../src/organization-control-plane/application/slack-integration-contracts.js";

const AUTHORITY_URL = "https://authority.example";
const NANGO_CALLBACK_URL = "https://api.nango.dev/oauth/callback";
const CONFIGURATION_TOKEN = "xoxe.xoxp-1-super-secret-configuration-token";

const EXPECTED_MANIFEST = {
  display_information: {
    name: "ECHO",
    description: "Private approval cards and identity links for ECHO.",
  },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "ECHO", always_online: false },
  },
  oauth_config: {
    redirect_urls: [
      "https://api.nango.dev/oauth/callback",
      "https://authority.example/v2/person/external-identities/slack/browser/callback",
    ],
    scopes: { bot: ["chat:write", "im:history", "im:write", "users:read"], user: ["openid", "profile"] },
  },
  settings: {
    interactivity: {
      is_enabled: true,
      request_url: "https://authority.example/v2/integrations/slack/interactions",
    },
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  },
};

function slackResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function slackFetch(...values: readonly unknown[]) {
  let index = 0;
  return vi.fn<typeof globalThis.fetch>(async () => {
    const value = values[index++];
    if (value === undefined) throw new Error("Unexpected Slack test request");
    return slackResponse(value);
  });
}

describe("Slack private app scope constants", () => {
  it("are the exact frozen bot and browser sign-in scope lists", () => {
    expect(SLACK_PRIVATE_APP_BOT_SCOPES_V1).toEqual([
      "chat:write",
      "im:history",
      "im:write",
      "users:read",
    ]);
    expect(Object.isFrozen(SLACK_PRIVATE_APP_BOT_SCOPES_V1)).toBe(true);
    expect(SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1).toEqual(["openid", "profile"]);
    expect(Object.isFrozen(SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1)).toBe(true);
  });
});

const MANIFEST = buildEchoSlackAppManifestV1({
  authority_url: AUTHORITY_URL,
  nango_callback_url: NANGO_CALLBACK_URL,
});

describe("buildEchoSlackAppManifestV1", () => {
  it("builds the exact ECHO Slack app manifest", () => {
    expect(MANIFEST).toEqual(EXPECTED_MANIFEST);
  });

  it.each([
    ["an authority_url that carries a path", "https://authority.example/v1", NANGO_CALLBACK_URL],
    ["a non-https authority_url", "http://authority.example", NANGO_CALLBACK_URL],
    ["a nango_callback_url with a query string", AUTHORITY_URL, `${NANGO_CALLBACK_URL}?x=1`],
    ["an unparseable authority_url", "not-a-url", NANGO_CALLBACK_URL],
  ])("refuses %s", (_label, authority_url, nango_callback_url) => {
    expect(() => buildEchoSlackAppManifestV1({ authority_url, nango_callback_url })).toThrow(
      "Slack recipe URL is invalid",
    );
  });

  it("allows a bare-origin nango_callback_url with no path at all", () => {
    expect(() =>
      buildEchoSlackAppManifestV1({
        authority_url: AUTHORITY_URL,
        nango_callback_url: "https://api.nango.dev",
      }),
    ).not.toThrow();
  });
});

async function createFailure(fetch: typeof globalThis.fetch): Promise<SlackAppManifestProviderErrorV1> {
  const failure = await new SlackWebAppManifestProviderV1({ fetch })
    .createApp({ configuration_token: CONFIGURATION_TOKEN, manifest: MANIFEST })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(failure).toBeInstanceOf(SlackAppManifestProviderErrorV1);
  return failure as SlackAppManifestProviderErrorV1;
}

describe("SlackWebAppManifestProviderV1", () => {
  it("creates an app: sends the Bearer config token and the manifest form, and returns credentials (ignoring verification_token)", async () => {
    const fetch = slackFetch({
      ok: true,
      app_id: "A123APP",
      credentials: {
        client_id: "123.456",
        client_secret: "client-secret-value",
        verification_token: "verification-token-value",
        signing_secret: "signing-secret-value",
      },
      oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=123.456",
    });
    const provider = new SlackWebAppManifestProviderV1({ fetch });

    const created = await provider.createApp({
      configuration_token: CONFIGURATION_TOKEN,
      manifest: MANIFEST,
    });

    expect(created).toEqual({
      app_id: "A123APP",
      client_id: "123.456",
      client_secret: "client-secret-value",
      signing_secret: "signing-secret-value",
    });
    expect(created).not.toHaveProperty("verification_token");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/apps.manifest.create");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${CONFIGURATION_TOKEN}`);
    const body = init.body as URLSearchParams;
    expect(body.get("manifest")).toBe(JSON.stringify(MANIFEST));
    expect(body.get("app_id")).toBeNull();
  });

  it("updates an app: sends the app_id alongside the manifest", async () => {
    const fetch = slackFetch({ ok: true, app_id: "A123APP", permissions_updated: true });
    const provider = new SlackWebAppManifestProviderV1({ fetch });

    await expect(
      provider.updateApp({
        configuration_token: CONFIGURATION_TOKEN,
        app_id: "A123APP",
        manifest: MANIFEST,
      }),
    ).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/apps.manifest.update");
    const body = init.body as URLSearchParams;
    expect(body.get("app_id")).toBe("A123APP");
    expect(body.get("manifest")).toBe(JSON.stringify(MANIFEST));
  });

  it.each([
    [{ ok: false, error: "token_expired" }, "invalid_token"],
    [{ ok: false, error: "invalid_auth" }, "invalid_token"],
    [{ ok: false, error: "not_authed" }, "invalid_token"],
    [{ ok: false, error: "token_revoked" }, "invalid_token"],
    [
      {
        ok: false,
        error: "invalid_manifest",
        errors: ["oauth_config.redirect_urls[0] is not a valid URL: very-sensitive-detail"],
      },
      "invalid_manifest",
    ],
    [{ ok: false, error: "ratelimited" }, "unavailable"],
  ])("maps Slack error %j to %s without leaking the token or Slack's errors[]", async (slackBody, code) => {
    const error = await createFailure(slackFetch(slackBody));
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(CONFIGURATION_TOKEN);
    expect(error.message).not.toContain("very-sensitive-detail");
  });

  it.each([
    ["a transport failure", async (): Promise<Response> => {
      throw new Error("network down");
    }],
    ["an oversized response", async () =>
      new Response(JSON.stringify({ ok: true, app_id: "A123APP" }), {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "99999999" },
      })],
  ])("maps %s to unavailable, without leaking the configuration token", async (_label, respond) => {
    const error = await createFailure(vi.fn<typeof globalThis.fetch>(respond));
    expect(error.code).toBe("unavailable");
    expect(error.message).not.toContain(CONFIGURATION_TOKEN);
  });
});
