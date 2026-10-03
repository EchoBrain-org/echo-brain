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

/** A response with no body at all (e.g. a 204, or an empty-bodied error). */
function emptyNangoFetch(status: number) {
  return vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status }));
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
});

describe("HttpNangoConnectionClientV1.createConnectSession", () => {
  it("sends the Bearer secret key and the exact connect-session body, returning only connect_link", async () => {
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

    expect(session).toEqual({ connect_link: "https://connect.nango.dev/abc" });

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

    expect(session).toEqual({ connect_link: "https://connect.nango.dev/def" });

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
      app_id: "A0123456",
      bot_user_id: "U0123456",
      granted_scopes: ["chat:write", "im:history", "im:write", "users:read"],
      bot_token: "xoxb-111-222-abcdef",
    });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nango.dev/connections/conn_123?provider_config_key=echo-slack");
    expect(init.method).toBe("GET");
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
      const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

      const failure = await failureOf(client.getSlackConnection({ connection_id: "conn_123" }));

      expect(failure).toBeInstanceOf(NangoClientErrorV1);
      expect((failure as NangoClientErrorV1).code).toBe(code);
    }
  });

  it("maps an empty 200 body on getSlackConnection to invalid_response (a body is required)", async () => {
    const fetch = emptyNangoFetch(200);
    const client = new HttpNangoConnectionClientV1(CONFIGURATION, { fetch });

    const failure = await failureOf(client.getSlackConnection({ connection_id: "conn_123" }));

    expect(failure).toBeInstanceOf(NangoClientErrorV1);
    expect((failure as NangoClientErrorV1).code).toBe("invalid_response");
  });

  it.each([
    ["a transport failure", async (): Promise<Response> => {
      throw new Error("network down");
    }],
    ["an oversized response", async () =>
      new Response(JSON.stringify(A1_CONNECTION_FIXTURE), {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "99999999" },
      })],
  ])("maps %s to unavailable without leaking the secret key", async (_label, respond) => {
    const fetch = vi.fn<typeof globalThis.fetch>(respond);
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
      app_id: "A0123456",
      bot_user_id: "U0123456",
      granted_scopes: ["chat:write", "im:history", "im:write", "users:read"],
      bot_token: "xoxb-111-222-abcdef",
    });
  });

  it("accepts a non-null enterprise object (Grid single-workspace install) when is_enterprise_install is false", () => {
    const fixture = fixtureWithRawPatch({ enterprise: { id: "E0123456", name: "Acme Enterprise" } });
    expect(parseNangoSlackConnectionV1(fixture).team_id).toBe("T0123456");
  });

  it("throws NangoClientErrorV1 invalid_response for a non-object value", () => {
    expect(() => parseNangoSlackConnectionV1("not-an-object")).toThrow(NangoClientErrorV1);
    expect(() => parseNangoSlackConnectionV1(null)).toThrow(NangoClientErrorV1);
  });
});
