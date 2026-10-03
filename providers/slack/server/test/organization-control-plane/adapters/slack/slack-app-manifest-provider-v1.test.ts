import { describe, expect, it, vi } from "vitest";
import {
  buildEchoSlackAppManifestV1,
  SLACK_PRIVATE_APP_BOT_SCOPES_V1,
  SlackAppManifestProviderErrorV1,
  SlackWebAppManifestProviderV1,
} from "../../../../src/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1.js";
import { SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1, SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1, SLACK_PUBLIC_CHANNEL_CONTEXT_CAPABILITY_V1, type SlackPublicChannelContextCapabilityV1 } from "../../../../src/organization-control-plane/application/slack-integration-contracts.js";

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

describe("SLACK_PRIVATE_APP_BOT_SCOPES_V1", () => {
  it("is the exact frozen, sorted scope list", () => {
    expect(SLACK_PRIVATE_APP_BOT_SCOPES_V1).toEqual([
      "chat:write",
      "im:history",
      "im:write",
      "users:read",
    ]);
    expect(Object.isFrozen(SLACK_PRIVATE_APP_BOT_SCOPES_V1)).toBe(true);
  });
});

describe("SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1", () => {
  it("is the exact frozen browser sign-in scope list, disjoint from the bot scopes", () => {
    expect(SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1).toEqual(["openid", "profile"]);
    expect(Object.isFrozen(SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1)).toBe(true);
    expect(SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1.some((scope) => (SLACK_PRIVATE_APP_BOT_SCOPES_V1 as readonly string[]).includes(scope))).toBe(false);
  });
});

describe("buildEchoSlackAppManifestV1", () => {
  it("adds only public-channel read scopes when Authority explicitly selects the versioned capability", () => {
    const manifest = buildEchoSlackAppManifestV1({ authority_url: AUTHORITY_URL, nango_callback_url: NANGO_CALLBACK_URL,
      public_channel_context: SLACK_PUBLIC_CHANNEL_CONTEXT_CAPABILITY_V1 });
    expect(manifest).toEqual({ ...EXPECTED_MANIFEST, oauth_config: { ...EXPECTED_MANIFEST.oauth_config,
      scopes: { bot: SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1, user: ["openid", "profile"] } } });
    expect(SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1).toEqual(["channels:history", "channels:read", "chat:write", "im:history", "im:write", "users:read"]);
    expect(Object.isFrozen(SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1)).toBe(true);
  });

  it("rejects unversioned, unknown or widened capability configuration", () => {
    for (const capability of [true, {}, { ...SLACK_PUBLIC_CHANNEL_CONTEXT_CAPABILITY_V1, schema_version: 2 },
      { ...SLACK_PUBLIC_CHANNEL_CONTEXT_CAPABILITY_V1, scopes: ["groups:history"] }]) {
      expect(() => buildEchoSlackAppManifestV1({ authority_url: AUTHORITY_URL, nango_callback_url: NANGO_CALLBACK_URL,
        public_channel_context: capability as SlackPublicChannelContextCapabilityV1 })).toThrow("Slack public-channel context capability is invalid");
    }
  });

  it("builds the exact ECHO Slack app manifest", () => {
    expect(
      buildEchoSlackAppManifestV1({
        authority_url: AUTHORITY_URL,
        nango_callback_url: NANGO_CALLBACK_URL,
      }),
    ).toEqual(EXPECTED_MANIFEST);
  });

  it("refuses an authority_url that carries a path", () => {
    expect(() =>
      buildEchoSlackAppManifestV1({
        authority_url: "https://authority.example/v1",
        nango_callback_url: NANGO_CALLBACK_URL,
      }),
    ).toThrow("Slack recipe URL is invalid");
  });

  it("refuses a non-https authority_url", () => {
    expect(() =>
      buildEchoSlackAppManifestV1({
        authority_url: "http://authority.example",
        nango_callback_url: NANGO_CALLBACK_URL,
      }),
    ).toThrow("Slack recipe URL is invalid");
  });

  it("refuses a nango_callback_url with a query string", () => {
    expect(() =>
      buildEchoSlackAppManifestV1({
        authority_url: AUTHORITY_URL,
        nango_callback_url: `${NANGO_CALLBACK_URL}?x=1`,
      }),
    ).toThrow("Slack recipe URL is invalid");
  });

  it("refuses an unparseable authority_url", () => {
    expect(() =>
      buildEchoSlackAppManifestV1({
        authority_url: "not-a-url",
        nango_callback_url: NANGO_CALLBACK_URL,
      }),
    ).toThrow("Slack recipe URL is invalid");
  });

  it("allows a nango_callback_url that carries a path", () => {
    expect(() =>
      buildEchoSlackAppManifestV1({
        authority_url: AUTHORITY_URL,
        nango_callback_url: NANGO_CALLBACK_URL,
      }),
    ).not.toThrow();
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
    const manifest = buildEchoSlackAppManifestV1({
      authority_url: AUTHORITY_URL,
      nango_callback_url: NANGO_CALLBACK_URL,
    });

    const created = await provider.createApp({
      configuration_token: CONFIGURATION_TOKEN,
      manifest,
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
    expect(body.get("manifest")).toBe(JSON.stringify(manifest));
    expect(body.get("app_id")).toBeNull();
  });

  it("updates an app: sends the app_id alongside the manifest", async () => {
    const fetch = slackFetch({ ok: true, app_id: "A123APP", permissions_updated: true });
    const provider = new SlackWebAppManifestProviderV1({ fetch });
    const manifest = buildEchoSlackAppManifestV1({
      authority_url: AUTHORITY_URL,
      nango_callback_url: NANGO_CALLBACK_URL,
    });

    await expect(
      provider.updateApp({
        configuration_token: CONFIGURATION_TOKEN,
        app_id: "A123APP",
        manifest,
      }),
    ).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/apps.manifest.update");
    const body = init.body as URLSearchParams;
    expect(body.get("app_id")).toBe("A123APP");
    expect(body.get("manifest")).toBe(JSON.stringify(manifest));
  });

  it("maps token_expired to invalid_token without leaking the configuration token", async () => {
    const fetch = slackFetch({ ok: false, error: "token_expired" });
    const provider = new SlackWebAppManifestProviderV1({ fetch });
    const manifest = buildEchoSlackAppManifestV1({
      authority_url: AUTHORITY_URL,
      nango_callback_url: NANGO_CALLBACK_URL,
    });

    const failure = await provider
      .createApp({ configuration_token: CONFIGURATION_TOKEN, manifest })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(SlackAppManifestProviderErrorV1);
    const error = failure as SlackAppManifestProviderErrorV1;
    expect(error.code).toBe("invalid_token");
    expect(error.message).not.toContain(CONFIGURATION_TOKEN);
  });

  it.each(["invalid_auth", "not_authed", "token_revoked"])(
    "maps %s to invalid_token",
    async (slackError) => {
      const fetch = slackFetch({ ok: false, error: slackError });
      const provider = new SlackWebAppManifestProviderV1({ fetch });
      const manifest = buildEchoSlackAppManifestV1({
        authority_url: AUTHORITY_URL,
        nango_callback_url: NANGO_CALLBACK_URL,
      });

      const failure = await provider
        .createApp({ configuration_token: CONFIGURATION_TOKEN, manifest })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(SlackAppManifestProviderErrorV1);
      expect((failure as SlackAppManifestProviderErrorV1).code).toBe("invalid_token");
    },
  );

  it("maps invalid_manifest to invalid_manifest without copying Slack's errors[]", async () => {
    const fetch = slackFetch({
      ok: false,
      error: "invalid_manifest",
      errors: ["oauth_config.redirect_urls[0] is not a valid URL: very-sensitive-detail"],
    });
    const provider = new SlackWebAppManifestProviderV1({ fetch });
    const manifest = buildEchoSlackAppManifestV1({
      authority_url: AUTHORITY_URL,
      nango_callback_url: NANGO_CALLBACK_URL,
    });

    const failure = await provider
      .createApp({ configuration_token: CONFIGURATION_TOKEN, manifest })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(SlackAppManifestProviderErrorV1);
    const error = failure as SlackAppManifestProviderErrorV1;
    expect(error.code).toBe("invalid_manifest");
    expect(error.message).not.toContain("very-sensitive-detail");
  });

  it("maps any other Slack error to unavailable", async () => {
    const fetch = slackFetch({ ok: false, error: "ratelimited" });
    const provider = new SlackWebAppManifestProviderV1({ fetch });
    const manifest = buildEchoSlackAppManifestV1({
      authority_url: AUTHORITY_URL,
      nango_callback_url: NANGO_CALLBACK_URL,
    });

    const failure = await provider
      .createApp({ configuration_token: CONFIGURATION_TOKEN, manifest })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(SlackAppManifestProviderErrorV1);
    expect((failure as SlackAppManifestProviderErrorV1).code).toBe("unavailable");
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
    const fetch = vi.fn<typeof globalThis.fetch>(respond);
    const provider = new SlackWebAppManifestProviderV1({ fetch });
    const manifest = buildEchoSlackAppManifestV1({
      authority_url: AUTHORITY_URL,
      nango_callback_url: NANGO_CALLBACK_URL,
    });

    const failure = await provider
      .createApp({ configuration_token: CONFIGURATION_TOKEN, manifest })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(SlackAppManifestProviderErrorV1);
    const error = failure as SlackAppManifestProviderErrorV1;
    expect(error.code).toBe("unavailable");
    expect(error.message).not.toContain(CONFIGURATION_TOKEN);
  });
});
