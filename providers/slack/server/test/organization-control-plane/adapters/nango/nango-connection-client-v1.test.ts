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
const SESSION_TOKEN = "nango-connect-session-token-value";

const CONFIGURATION: NangoConfigurationV1 = Object.freeze({
  base_url: "https://api.nango.dev",
  secret_key: SECRET_KEY,
  integration_key: INTEGRATION_KEY,
});

const TAGS = Object.freeze({
  echo_organization_id: "org_1",
  echo_membership_id: "mem_1",
  echo_attempt_id: "ssi_1",
});

const SCOPES = Object.freeze(["chat:write", "im:history", "im:write", "users:read"] as const);

const CONNECTION_FIXTURE = Object.freeze({
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

const SESSION_INPUT = Object.freeze({
  tags: TAGS,
  client_id: "client-id-value",
  client_secret: CLIENT_SECRET,
  scopes: SCOPES,
});

const SESSION_DEFAULTS = Object.freeze({
  [INTEGRATION_KEY]: {
    authorization_params: { client_id: "client-id-value" },
    connection_config: {
      oauth_client_id_override: "client-id-value",
      oauth_client_secret_override: CLIENT_SECRET,
      oauth_scopes_override: "chat:write,im:history,im:write,users:read",
    },
  },
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

function client(...responses: ReadonlyArray<readonly [number, unknown]>) {
  const fetch = nangoFetch(...responses);
  return { client: new HttpNangoConnectionClientV1(CONFIGURATION, { fetch }), fetch };
}

function fixtureWithRawPatch(
  patch: Record<string, unknown>,
  access_token: string = CONNECTION_FIXTURE.credentials.access_token,
): Record<string, any> {
  const clone = JSON.parse(JSON.stringify(CONNECTION_FIXTURE)) as Record<string, any>;
  Object.assign(clone.credentials.raw, patch);
  clone.credentials.access_token = access_token;
  return clone;
}

async function nangoFailure<T>(promise: Promise<T>, code: NangoClientErrorV1["code"]): Promise<NangoClientErrorV1> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(NangoClientErrorV1);
  expect((failure as NangoClientErrorV1).code).toBe(code);
  return failure as NangoClientErrorV1;
}

describe("HttpNangoConnectionClientV1 configuration", () => {
  it.each([
    ["a non-https base_url", { base_url: "http://api.nango.dev" }],
    ["an invalid integration_key", { integration_key: "Not Valid!" }],
    ["an empty secret_key", { secret_key: "" }],
  ])("rejects %s", (_label, override) => {
    expect(() => new HttpNangoConnectionClientV1({ ...CONFIGURATION, ...override })).toThrow();
  });
});

describe("HttpNangoConnectionClientV1.createConnectSession", () => {
  it("starts native browser OAuth with the selected app while keeping its secret in session defaults", async () => {
    const { client: nango, fetch } = client([
      200,
      {
        data: {
          token: SESSION_TOKEN,
          connect_link: "https://connect.nango.dev/abc",
          expires_at: "2026-10-01T00:00:00.000Z",
        },
      },
    ]);

    const session = await nango.createConnectSession(SESSION_INPUT);

    expect(session).toEqual({
      connect_link: `https://api.nango.dev/oauth/connect/${INTEGRATION_KEY}?connect_session_token=${SESSION_TOKEN}`,
    });
    expect(session.connect_link).not.toContain(CLIENT_SECRET);

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
      integrations_config_defaults: SESSION_DEFAULTS,
    });
  });
});

describe("HttpNangoConnectionClientV1.createReconnectSession", () => {
  it("uses the same native browser OAuth and selected-app defaults when reconnecting", async () => {
    const { client: nango, fetch } = client([
      200,
      {
        data: {
          token: SESSION_TOKEN,
          connect_link: "https://connect.nango.dev/def",
          expires_at: "2026-10-01T00:00:00.000Z",
        },
      },
    ]);

    const session = await nango.createReconnectSession({ connection_id: "conn_123", ...SESSION_INPUT });

    expect(session).toEqual({
      connect_link: `https://api.nango.dev/oauth/connect/${INTEGRATION_KEY}?connect_session_token=${SESSION_TOKEN}`,
    });
    expect(session.connect_link).not.toContain(CLIENT_SECRET);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nango.dev/connect/sessions/reconnect");
    expect(JSON.parse(init.body as string)).toEqual({
      connection_id: "conn_123",
      integration_id: INTEGRATION_KEY,
      tags: TAGS,
      integrations_config_defaults: SESSION_DEFAULTS,
    });
  });
});

describe("HttpNangoConnectionClientV1 native OAuth session response", () => {
  it.each([
    [{ data: { connect_link: "https://connect.nango.dev/abc" } }],
    [{ data: { token: "with whitespace" } }],
    [{ data: { token: "x".repeat(4097) } }],
    [{ data: { token: "x".repeat(4096) } }],
    [{ data: { token: "/".repeat(1400) } }],
  ])("rejects a malformed session token without returning the Nango response body", async (body) => {
    const failure = await nangoFailure(client([200, body]).client.createConnectSession(SESSION_INPUT), "invalid_response");

    expect(failure.message).not.toContain(CLIENT_SECRET);
    expect(failure.message).not.toContain(JSON.stringify(body));
  });
});

describe("HttpNangoConnectionClientV1.findConnectionIdByTag", () => {
  it("builds tags[key]=value and returns the single matching id", async () => {
    const { client: nango, fetch } = client([
      200,
      { connections: [{ connection_id: "conn_123", tags: TAGS }] },
    ]);

    const id = await nango.findConnectionIdByTag({ key: "echo_attempt_id", value: "ssi_1" });

    expect(id).toBe("conn_123");
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nango.dev/connections?tags[echo_attempt_id]=ssi_1");
    expect(init.method).toBe("GET");
  });

  it("returns undefined when zero connections match", async () => {
    const id = await client([200, { connections: [] }]).client.findConnectionIdByTag({ key: "echo_attempt_id", value: "ssi_missing" });

    expect(id).toBeUndefined();
  });

  it("throws invalid_response when more than one connection matches", async () => {
    const { client: nango } = client([
      200,
      {
        connections: [
          { connection_id: "conn_123", tags: TAGS },
          { connection_id: "conn_456", tags: TAGS },
        ],
      },
    ]);

    await nangoFailure(nango.findConnectionIdByTag({ key: "echo_attempt_id", value: "ssi_1" }), "invalid_response");
  });
});

describe("HttpNangoConnectionClientV1.getSlackConnection", () => {
  it("builds the provider_config_key query and parses the connection fixture", async () => {
    const { client: nango, fetch } = client([200, CONNECTION_FIXTURE]);

    const connection = await nango.getSlackConnection({ connection_id: "conn_123" });

    expect(connection).toEqual({
      connection_id: "conn_123",
      tags: TAGS,
      team_id: "T0123456",
      app_id: "A0123456",
      bot_user_id: "U0123456",
      granted_scopes: ["chat:write", "im:history", "im:write", "users:read"],
      bot_token: "xoxb-111-222-abcdef",
    });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nango.dev/connections/conn_123?provider_config_key=echo-slack");
    expect(init.method).toBe("GET");
  });

  it.each([
    ["a missing team id", fixtureWithRawPatch({ team: {} })],
    ["a non-xoxb token", fixtureWithRawPatch({}, "xoxp-not-a-bot-token")],
    ["an enterprise install", fixtureWithRawPatch({ is_enterprise_install: true })],
  ])("refuses a connection with %s without leaking its token", async (_label, fixture) => {
    const failure = await nangoFailure(
      client([200, fixture]).client.getSlackConnection({ connection_id: "conn_123" }),
      "invalid_response",
    );

    expect(failure.message).not.toContain(fixture.credentials.access_token);
  });
});

describe("HttpNangoConnectionClientV1 error mapping", () => {
  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [500, "unavailable"],
  ] as const)("maps a %s status to %s whatever its body (status decides, not body)", async (status, code) => {
    for (const [body, contentType] of [
      [JSON.stringify({ error: { message: "denied" } }), "application/json"],
      [null, undefined],
      ["<html><body>Not Found</body></html>", "text/html"],
    ] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response(body, { status, headers: contentType === undefined ? {} : { "content-type": contentType } }),
      );
      const nango = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

      await nangoFailure(nango.getSlackConnection({ connection_id: "conn_123" }), code);
    }
  });

  it("maps an empty 200 body on getSlackConnection to invalid_response (a body is required)", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
    const nango = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    await nangoFailure(nango.getSlackConnection({ connection_id: "conn_123" }), "invalid_response");
  });

  it.each([
    ["a transport failure", async (): Promise<Response> => {
      throw new Error("network down");
    }],
    ["an oversized response", async () =>
      new Response(JSON.stringify(CONNECTION_FIXTURE), {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "99999999" },
      })],
  ])("maps %s to unavailable without leaking the secret key", async (_label, respond) => {
    const nango = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch: vi.fn<typeof globalThis.fetch>(respond) });

    const failure = await nangoFailure(nango.getSlackConnection({ connection_id: "conn_123" }), "unavailable");

    expect(failure.message).not.toContain(SECRET_KEY);
  });

  it("never echoes the secret key or client secret even when a 500 body contains them", async () => {
    const { client: nango } = client([
      500,
      {
        error: {
          message: `leaked secret ${SECRET_KEY} and client secret ${CLIENT_SECRET}`,
        },
      },
    ]);

    const error = await nangoFailure(nango.createConnectSession(SESSION_INPUT), "unavailable");

    expect(error.message).not.toContain(SECRET_KEY);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });
});

describe("parseNangoSlackConnectionV1", () => {
  it("accepts a non-null enterprise object (Grid single-workspace install) when is_enterprise_install is false", () => {
    const fixture = fixtureWithRawPatch({ enterprise: { id: "E0123456", name: "Acme Enterprise" } });
    expect(parseNangoSlackConnectionV1(fixture).team_id).toBe("T0123456");
  });

  it("throws NangoClientErrorV1 invalid_response for a non-object value", () => {
    expect(() => parseNangoSlackConnectionV1("not-an-object")).toThrow(NangoClientErrorV1);
    expect(() => parseNangoSlackConnectionV1(null)).toThrow(NangoClientErrorV1);
  });
});
