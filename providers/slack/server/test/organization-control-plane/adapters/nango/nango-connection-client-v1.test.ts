import { describe, expect, it, vi } from "vitest";
import {
  HttpNangoConnectionClientV1,
  NangoClientErrorV1,
  parseNangoSlackConnectionV1,
  type NangoConfigurationV1,
} from "../../../../src/organization-control-plane/adapters/nango/nango-connection-client-v1.js";

const SECRET_KEY = "nango-secret-key-value";
const CLIENT_SECRET = "client-secret-value";
const INTEGRATION_KEY = "echo-slack";

const CONFIGURATION: NangoConfigurationV1 = Object.freeze({
  base_url: "https://api.nango.dev",
  secret_key: SECRET_KEY,
  integration_key: INTEGRATION_KEY,
  callback_url: "https://api.nango.dev/oauth/callback",
});

const TAGS = Object.freeze({
  echo_organization_id: "org_1",
  echo_membership_id: "mem_1",
  echo_attempt_id: "ssi_1",
});

const SCOPES = Object.freeze(["chat:write", "im:history", "im:write", "users:read"] as const);

const A1_CONNECTION_FIXTURE = Object.freeze({
  connection_id: "conn_123",
  tags: TAGS,
  updated_at: "2026-09-30T12:00:00.000Z",
  credentials: Object.freeze({
    access_token: "xoxb-111-222-abcdef",
    raw: Object.freeze({
      team: Object.freeze({ id: "T0123456", name: "Acme" }),
      app_id: "A0123456",
      bot_user_id: "U0123456",
      enterprise: null,
      is_enterprise_install: false,
      scope: "chat:write,users:read,im:history,im:write",
    }),
  }),
});

function nangoResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nangoFetch(...responses: ReadonlyArray<readonly [number, unknown]>) {
  let index = 0;
  return vi.fn<typeof globalThis.fetch>(async () => {
    const response = responses[index++];
    if (response === undefined) throw new Error("Unexpected Nango test request");
    return nangoResponse(response[0], response[1]);
  });
}

function fixtureWithRawPatch(patch: Record<string, unknown>): unknown {
  const clone = JSON.parse(JSON.stringify(A1_CONNECTION_FIXTURE)) as Record<string, any>;
  Object.assign(clone.credentials.raw, patch);
  return clone;
}

async function failureOf<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("HttpNangoConnectionClientV1 configuration", () => {
  it("rejects a non-https base_url", () => {
    expect(
      () => new HttpNangoConnectionClientV1({ ...CONFIGURATION, base_url: "http://api.nango.dev" }),
    ).toThrow();
  });

  it("rejects an invalid integration_key", () => {
    expect(
      () => new HttpNangoConnectionClientV1({ ...CONFIGURATION, integration_key: "Not Valid!" }),
    ).toThrow();
  });

  it("rejects an empty secret_key", () => {
    expect(() => new HttpNangoConnectionClientV1({ ...CONFIGURATION, secret_key: "" })).toThrow();
  });

  it("rejects a timeoutMs outside (0, 60000]", () => {
    expect(() => new HttpNangoConnectionClientV1(CONFIGURATION, { timeoutMs: 0 })).toThrow();
    expect(() => new HttpNangoConnectionClientV1(CONFIGURATION, { timeoutMs: 60_001 })).toThrow();
  });
});

describe("HttpNangoConnectionClientV1.createConnectSession", () => {
  it("sends the Bearer secret key and the exact connect-session body, returning only connect_link and expires_at", async () => {
    const fetch = nangoFetch([
      200,
      {
        data: {
          token: "nango-session-token-value",
          connect_link: "https://connect.nango.dev/abc",
          expires_at: "2026-10-01T00:00:00.000Z",
        },
      },
    ]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const session = await client.createConnectSession({
      tags: TAGS,
      client_id: "client-id-value",
      client_secret: CLIENT_SECRET,
      scopes: SCOPES,
    });

    expect(session).toEqual({
      connect_link: "https://connect.nango.dev/abc",
      expires_at: "2026-10-01T00:00:00.000Z",
    });
    expect(session).not.toHaveProperty("token");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nango.dev/connect/sessions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      tags: TAGS,
      allowed_integrations: [INTEGRATION_KEY],
      integrations_config_defaults: {
        [INTEGRATION_KEY]: {
          connection_config: {
            oauth_client_id_override: "client-id-value",
            oauth_client_secret_override: CLIENT_SECRET,
            oauth_scopes_override: "chat:write,im:history,im:write,users:read",
          },
        },
      },
    });
  });

  it("sends the request with redirect: error and a timeout signal", async () => {
    const fetch = nangoFetch([
      200,
      { data: { token: "t", connect_link: "https://connect.nango.dev/abc", expires_at: "2026-10-01T00:00:00.000Z" } },
    ]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    await client.createConnectSession({
      tags: TAGS,
      client_id: "client-id-value",
      client_secret: CLIENT_SECRET,
      scopes: SCOPES,
    });

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("HttpNangoConnectionClientV1.createReconnectSession", () => {
  it("sends connection_id, integration_id, tags and the same per-connection overrides", async () => {
    const fetch = nangoFetch([
      200,
      {
        data: {
          token: "nango-session-token-value",
          connect_link: "https://connect.nango.dev/def",
          expires_at: "2026-10-01T00:00:00.000Z",
        },
      },
    ]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const session = await client.createReconnectSession({
      connection_id: "conn_123",
      tags: TAGS,
      client_id: "client-id-value",
      client_secret: CLIENT_SECRET,
      scopes: SCOPES,
    });

    expect(session).toEqual({
      connect_link: "https://connect.nango.dev/def",
      expires_at: "2026-10-01T00:00:00.000Z",
    });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nango.dev/connect/sessions/reconnect");
    expect(JSON.parse(init.body as string)).toEqual({
      connection_id: "conn_123",
      integration_id: INTEGRATION_KEY,
      tags: TAGS,
      integrations_config_defaults: {
        [INTEGRATION_KEY]: {
          connection_config: {
            oauth_client_id_override: "client-id-value",
            oauth_client_secret_override: CLIENT_SECRET,
            oauth_scopes_override: "chat:write,im:history,im:write,users:read",
          },
        },
      },
    });
  });
});

describe("HttpNangoConnectionClientV1.findConnectionIdByTag", () => {
  it("builds tags[key]=value and returns the single matching id", async () => {
    const fetch = nangoFetch([
      200,
      { connections: [{ connection_id: "conn_123", tags: TAGS }] },
    ]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const id = await client.findConnectionIdByTag({ key: "echo_attempt_id", value: "ssi_1" });

    expect(id).toBe("conn_123");
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nango.dev/connections?tags[echo_attempt_id]=ssi_1");
    expect(init.method).toBe("GET");
  });

  it("returns undefined when zero connections match", async () => {
    const fetch = nangoFetch([200, { connections: [] }]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const id = await client.findConnectionIdByTag({ key: "echo_attempt_id", value: "ssi_missing" });

    expect(id).toBeUndefined();
  });

  it("throws invalid_response when more than one connection matches", async () => {
    const fetch = nangoFetch([
      200,
      {
        connections: [
          { connection_id: "conn_123", tags: TAGS },
          { connection_id: "conn_456", tags: TAGS },
        ],
      },
    ]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(client.findConnectionIdByTag({ key: "echo_attempt_id", value: "ssi_1" }));

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    expect((failure as NangoClientErrorV1).code).toBe("invalid_response");
  });
});

describe("HttpNangoConnectionClientV1.getSlackConnection", () => {
  it("builds the provider_config_key query and parses the A1 fixture", async () => {
    const fetch = nangoFetch([200, A1_CONNECTION_FIXTURE]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const connection = await client.getSlackConnection({ connection_id: "conn_123" });

    expect(connection).toEqual({
      connection_id: "conn_123",
      tags: TAGS,
      team_id: "T0123456",
      enterprise_id: null,
      is_enterprise_install: false,
      app_id: "A0123456",
      bot_user_id: "U0123456",
      granted_scopes: ["chat:write", "im:history", "im:write", "users:read"],
      bot_token: "xoxb-111-222-abcdef",
      updated_at: "2026-09-30T12:00:00.000Z",
    });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nango.dev/connections/conn_123?provider_config_key=echo-slack");
    expect(init.method).toBe("GET");
  });

  it("adds force_refresh=true when requested", async () => {
    const fetch = nangoFetch([200, A1_CONNECTION_FIXTURE]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    await client.getSlackConnection({ connection_id: "conn_123", force_refresh: true });

    const [url] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.nango.dev/connections/conn_123?provider_config_key=echo-slack&force_refresh=true",
    );
  });

  it("refuses a connection with a missing team id", async () => {
    const fixture = fixtureWithRawPatch({ team: {} });
    const fetch = nangoFetch([200, fixture]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(client.getSlackConnection({ connection_id: "conn_123" }));

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    expect((failure as NangoClientErrorV1).code).toBe("invalid_response");
  });

  it("refuses a non-xoxb token without leaking it", async () => {
    const clone = JSON.parse(JSON.stringify(A1_CONNECTION_FIXTURE)) as any;
    clone.credentials.access_token = "xoxp-not-a-bot-token";
    const fetch = nangoFetch([200, clone]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(client.getSlackConnection({ connection_id: "conn_123" }));

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    expect((failure as NangoClientErrorV1).code).toBe("invalid_response");
    expect((failure as NangoClientErrorV1).message).not.toContain("xoxp-not-a-bot-token");
  });

  it("refuses an enterprise-install connection", async () => {
    const fixture = fixtureWithRawPatch({ is_enterprise_install: true });
    const fetch = nangoFetch([200, fixture]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(client.getSlackConnection({ connection_id: "conn_123" }));

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    expect((failure as NangoClientErrorV1).code).toBe("invalid_response");
  });
});

describe("HttpNangoConnectionClientV1.deleteConnection", () => {
  it("sends DELETE with the provider_config_key query", async () => {
    const fetch = nangoFetch([200, { success: true }]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    await expect(client.deleteConnection({ connection_id: "conn_123" })).resolves.toBeUndefined();

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nango.dev/connections/conn_123?provider_config_key=echo-slack");
    expect(init.method).toBe("DELETE");
  });
});

describe("HttpNangoConnectionClientV1 error mapping", () => {
  it.each([401, 403])("maps a %s status to unauthorized", async (status) => {
    const fetch = nangoFetch([status, { error: { message: "denied" } }]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(client.getSlackConnection({ connection_id: "conn_123" }));

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    expect((failure as NangoClientErrorV1).code).toBe("unauthorized");
  });

  it("maps a 404 status to not_found", async () => {
    const fetch = nangoFetch([404, { error: { message: "missing" } }]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(client.getSlackConnection({ connection_id: "conn_123" }));

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    expect((failure as NangoClientErrorV1).code).toBe("not_found");
  });

  it("maps any other non-2xx status to unavailable", async () => {
    const fetch = nangoFetch([500, { error: { message: "boom" } }]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(client.getSlackConnection({ connection_id: "conn_123" }));

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    expect((failure as NangoClientErrorV1).code).toBe("unavailable");
  });

  it("maps a transport failure to unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("network down");
    });
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(client.getSlackConnection({ connection_id: "conn_123" }));

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    expect((failure as NangoClientErrorV1).code).toBe("unavailable");
  });

  it("maps an oversized response to unavailable without leaking the secret key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify(A1_CONNECTION_FIXTURE), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "99999999" },
        }),
    );
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(client.getSlackConnection({ connection_id: "conn_123" }));

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    expect((failure as NangoClientErrorV1).code).toBe("unavailable");
    expect((failure as NangoClientErrorV1).message).not.toContain(SECRET_KEY);
  });

  it("never echoes the secret key or client secret even when a 500 body contains them", async () => {
    const fetch = nangoFetch([
      500,
      {
        error: {
          message: `leaked secret ${SECRET_KEY} and client secret ${CLIENT_SECRET}`,
        },
      },
    ]);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(
      client.createConnectSession({
        tags: TAGS,
        client_id: "client-id-value",
        client_secret: CLIENT_SECRET,
        scopes: SCOPES,
      }),
    );

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    const error = failure as NangoClientErrorV1;
    expect(error.message).not.toContain(SECRET_KEY);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });
});

describe("parseNangoSlackConnectionV1", () => {
  it("parses the A1 fixture directly, sorting granted_scopes", () => {
    expect(parseNangoSlackConnectionV1(A1_CONNECTION_FIXTURE)).toEqual({
      connection_id: "conn_123",
      tags: TAGS,
      team_id: "T0123456",
      enterprise_id: null,
      is_enterprise_install: false,
      app_id: "A0123456",
      bot_user_id: "U0123456",
      granted_scopes: ["chat:write", "im:history", "im:write", "users:read"],
      bot_token: "xoxb-111-222-abcdef",
      updated_at: "2026-09-30T12:00:00.000Z",
    });
  });

  it("accepts a non-null enterprise object (Grid single-workspace install) when is_enterprise_install is false", () => {
    const fixture = fixtureWithRawPatch({ enterprise: { id: "E0123456", name: "Acme Enterprise" } });
    const parsed = parseNangoSlackConnectionV1(fixture);
    expect(parsed.enterprise_id).toBe("E0123456");
  });

  it("throws NangoClientErrorV1 invalid_response for a non-object value", () => {
    expect(() => parseNangoSlackConnectionV1("not-an-object")).toThrow(NangoClientErrorV1);
    expect(() => parseNangoSlackConnectionV1(null)).toThrow(NangoClientErrorV1);
  });

  it("throws invalid_response when updated_at is missing", () => {
    const clone = JSON.parse(JSON.stringify(A1_CONNECTION_FIXTURE)) as any;
    delete clone.updated_at;
    expect(() => parseNangoSlackConnectionV1(clone)).toThrow(NangoClientErrorV1);
  });
});
