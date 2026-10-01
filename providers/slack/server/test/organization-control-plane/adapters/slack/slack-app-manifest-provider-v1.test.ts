import { describe, expect, it, vi } from "vitest";
import {
  buildEchoSlackAppManifestV1,
  SLACK_PRIVATE_APP_BOT_SCOPES_V1,
  SlackAppManifestProviderErrorV1,
  SlackWebAppManifestProviderV1,
} from "../../../../src/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1.js";

const AUTHORITY_URL = "https://authority.example";
const NANGO_CALLBACK_URL = "https://api.nango.dev/oauth/callback";
const CONFIGURATION_TOKEN = "xoxe.xoxp-1-super-secret-configuration-token";

const EXPECTED_MANIFEST = {
  display_information: {
    name: "ECHO",
    description: "Private approval cards and identity links for ECHO.",
  },
  features: { bot_user: { display_name: "ECHO", always_online: false } },
  oauth_config: {
    redirect_urls: [
      "https://api.nango.dev/oauth/callback",
      "https://authority.example/v2/person/external-identities/slack/browser/callback",
    ],
    scopes: { bot: ["chat:write", "im:history", "im:write", "users:read"] },
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

describe("buildEchoSlackAppManifestV1", () => {
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

  it("maps a transport failure to unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("network down");
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
    expect((failure as SlackAppManifestProviderErrorV1).code).toBe("unavailable");
  });

  it("sends the request with redirect: error and a timeout signal", async () => {
    const fetch = slackFetch({
      ok: true,
      app_id: "A123APP",
      credentials: {
        client_id: "123.456",
        client_secret: "client-secret-value",
        verification_token: "verification-token-value",
        signing_secret: "signing-secret-value",
      },
    });
    const provider = new SlackWebAppManifestProviderV1({ fetch });
    const manifest = buildEchoSlackAppManifestV1({
      authority_url: AUTHORITY_URL,
      nango_callback_url: NANGO_CALLBACK_URL,
    });

    await provider.createApp({ configuration_token: CONFIGURATION_TOKEN, manifest });

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a timeoutMs outside (0, 60000]", () => {
    expect(() => new SlackWebAppManifestProviderV1({ timeoutMs: 0 })).toThrow();
    expect(() => new SlackWebAppManifestProviderV1({ timeoutMs: 60_001 })).toThrow();
  });
});
