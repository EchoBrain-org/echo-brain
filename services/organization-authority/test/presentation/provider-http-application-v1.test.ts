import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationAuthorityHttpServer } from "../../src/presentation/organization-authority-http-server.js";
import {
  PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1,
  type PrivateSlackApprovalInteractionHttpPortV1,
} from "../../src/presentation/private-slack-approval-interaction-http-port-v1.js";
import { createPrivateSlackApprovalHttpAdapterV1 } from "../../src/composition/providers/slack/private-approval/private-slack-approval-http-adapter-v1.js";
import type { ProviderHttpApplicationV1, ProviderHttpResponseV1 } from "../../src/application/ports/provider-http-application-v1.js";
import { PERSON_SESSION_OIDC_BEGIN_PATH } from "../../src/presentation/person-identity-session-http-application.js";

function serverOptions(input: {
  readonly approval?: ProviderHttpApplicationV1;
  readonly external_identity?: ProviderHttpApplicationV1;
} = {}) {
  return {
    descriptor: {} as never,
    sessions: {} as never,
    oidc_provider: {} as never,
    expected_issuer: "https://issuer.example",
    ...(input.approval === undefined
      ? {}
      : { private_approval_interaction_ingress: input.approval }),
    ...(input.external_identity === undefined
      ? {}
      : { person_external_identity_link: input.external_identity }),
  };
}

async function start(
  application?: ProviderHttpApplicationV1,
) {
  const server = createOrganizationAuthorityHttpServer(
    serverOptions({ approval: application }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test HTTP server did not bind TCP");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}

describe("provider identity and approval HTTP transport V1", () => {
  it("serves a fixed identity callback page with no-store and restrictive browser headers", async () => {
    const path = "/v2/integrations/example/identity/callback";
    const page = "<!doctype html><title>ECHO</title><p>Return to ECHO to finish connecting.</p>";
    const server = createOrganizationAuthorityHttpServer(serverOptions({
      external_identity: {
        routes: [{ route_id: "callback", method: "POST", path }],
        accept: async () => ({ status: 200, body: page, content_type: "text/html" }),
      },
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test address");
    try {
      const response = await fetch(`http://127.0.0.1:${String(address.port)}${path}`, {
        method: "POST", body: "code=must-not-appear&state=must-not-appear",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      expect(await response.text()).toBe(page);
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });

  it("allows a retry-heavy login flow, then limits OIDC begins without blocking another client", async () => {
    const beginOidcLogin = vi.fn(() => ({
      login_attempt_id: "ola_00000000-0000-4000-8000-000000000001",
      issuer: "https://issuer.example",
      client_id: "client",
      redirect_uri: "https://authority.example/v2/session/oidc/callback",
      state: "S".repeat(43),
      nonce: "N".repeat(43),
      code_challenge: "C".repeat(43),
      code_challenge_method: "S256" as const,
      response_type: "code" as const,
      scope: "openid email" as const,
      created_at: "2026-08-18T00:00:00.000Z",
      expires_at: "2026-08-18T00:10:00.000Z",
    }));
    const server = createOrganizationAuthorityHttpServer({
      ...serverOptions(),
      sessions: { beginOidcLogin } as never,
      oidc_provider: {
        buildAuthorizationUrl: () => "https://issuer.example/authorize",
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("test HTTP server did not bind TCP");
    }
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const begin = (client: string) =>
      fetch(`${origin}${PERSON_SESSION_OIDC_BEGIN_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-echo-client-ip": client,
        },
        body: JSON.stringify({ kind: "existing_identity_login" }),
      });
    try {
      for (let index = 0; index < 10; index += 1) {
        expect((await begin("203.0.113.10")).status).toBe(201);
      }
      const throttled = await begin("203.0.113.10");
      expect(throttled.status).toBe(429);
      await expect(throttled.json()).resolves.toEqual({
        error: { code: "rate_limited", message: "request failed" },
      });
      expect((await begin("198.51.100.8")).status).toBe(201);
      expect(beginOidcLogin).toHaveBeenCalledTimes(11);
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });

  it("rejects a provider route that would shadow a core Authority route", () => {
    expect(() =>
      createOrganizationAuthorityHttpServer(
        serverOptions({
          approval: {
            routes: [{ route_id: "collision", method: "POST", path: PERSON_SESSION_OIDC_BEGIN_PATH }],
            accept: async () => ({ status: 200, raw_body: new Uint8Array() }),
          },
        }),
      ),
    ).toThrow(
      `provider ingress route collides with Authority route: POST ${PERSON_SESSION_OIDC_BEGIN_PATH}`,
    );
  });

  it("rejects duplicate provider routes across independently selected adapters", () => {
    const path = "/v2/integrations/example/identity";
    expect(() =>
      createOrganizationAuthorityHttpServer(
        serverOptions({
          approval: { routes: [{ route_id: "approval", method: "POST", path }], accept: async () => ({ status: 200, raw_body: new Uint8Array() }) },
          external_identity: {
            routes: [{ route_id: "example-identity", method: "POST", path }],
            accept: async () => ({ status: 200, body: {} }),
          },
        }),
      ),
    ).toThrow(`provider ingress route is configured more than once: POST ${path}`);
  });

  it("rejects ambiguous or noncanonical route declarations before listening", () => {
    const route = { route_id: "approval", method: "POST" as const, path: "/v2/integrations/example/approvals" };
    const accept = async () => ({ status: 200 as const, body: {} });
    for (const routes of [
      [route, { ...route, route_id: "duplicate" }],
      [route, { ...route, path: "/v2/integrations/example/challenge" }],
      [{ ...route, path: `${route.path}?query=undeclared` }],
      [{ ...route, path: "/v2/integrations/example/../approvals" }],
    ]) {
      expect(() => createOrganizationAuthorityHttpServer(serverOptions({ approval: { routes, accept } }))).toThrow(/provider ingress route/);
    }
  });

  it("mounts a selected non-Slack ingress without a server route change", async () => {
    const accept = vi.fn(
      async (
        _request: Parameters<
          ProviderHttpApplicationV1["accept"]
        >[0],
      ) => ({ status: 202 as const, body: { queued: true } }),
    );
    const server = await start({
      routes: [{ route_id: "approval", method: "POST", path: "/v2/integrations/example/approvals" }],
      accept,
    });
    try {
      const response = await fetch(
        `${server.url}/v2/integrations/example/approvals`,
        {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            "x-example-signature": "proof",
          },
          body: "exact-body",
        },
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ queued: true });
      expect(accept).toHaveBeenCalledWith({
        route_id: "approval",
        method: "POST",
        path: "/v2/integrations/example/approvals",
        raw_body: expect.any(Uint8Array),
        content_type: "text/plain",
        headers: expect.objectContaining({ "x-example-signature": "proof" }),
      });
      expect(Buffer.from(accept.mock.calls[0]![0].raw_body).toString("utf8")).toBe(
        "exact-body",
      );
    } finally {
      await server.close();
    }
  });

  it("dispatches an opt-in approval query challenge without reflecting its fields", async () => {
    const accept = vi.fn(async () => ({ status: 200 as const, body: { validated: true } }));
    const path = "/v2/integrations/example/approvals";
    const server = await start({
      routes: [{ route_id: "challenge", method: "GET", path, accepts_query: true }],
      accept,
    });
    try {
      const response = await fetch(`${server.url}${path}?challenge=private%2Bvalue&tag=one&tag=two`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ validated: true });
      expect(accept).toHaveBeenCalledWith(expect.objectContaining({
        route_id: "challenge", path, query: new URLSearchParams("challenge=private%2Bvalue&tag=one&tag=two"),
      }));
    } finally { await server.close(); }
  });

  it("keeps query opt-in and exact method/path matching on the validated route snapshot", async () => {
    const accept = vi.fn(async () => ({ status: 200 as const, body: {} }));
    const path = "/v2/integrations/example/approvals";
    const route = { route_id: "approval", method: "POST" as const, path };
    const server = await start({ routes: [route], accept });
    try {
      // Dispatch uses the validated route snapshot, not a mutable provider object.
      route.path = PERSON_SESSION_OIDC_BEGIN_PATH;
      for (const [method, suffix] of [["POST", "?unexpected=true"], ["GET", ""], ["POST", "/other"]]) {
        expect((await fetch(`${server.url}${path}${suffix}`, { method })).status).toBe(404);
      }
      expect(accept).not.toHaveBeenCalled();
      expect((await fetch(`${server.url}${path}`, { method: "POST" })).status).toBe(200);
      expect(accept).toHaveBeenCalledWith(expect.objectContaining({ path }));
    } finally { await server.close(); }
  });

  it("bounds opted-in query bytes before calling the application", async () => {
    const accept = vi.fn(async () => ({ status: 200 as const, body: {} }));
    const path = "/v2/integrations/example/approvals";
    const server = await start({ routes: [{ route_id: "challenge", method: "GET", path, accepts_query: true }], accept });
    try {
      expect((await fetch(`${server.url}${path}?challenge=${"a".repeat(8192)}`)).status).toBe(400);
      expect(accept).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("preserves response bytes and only emits host-approved headers", async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    const path = "/v2/integrations/example/approvals";
    const server = await start({
      routes: [{ route_id: "approval", method: "POST", path }],
      accept: async () => ({
        status: 202, raw_body: bytes, content_type: "application/octet-stream",
        headers: { "set-cookie": "not-allowed", location: "https://not-allowed.example", "cache-control": "public" },
      }),
    });
    try {
      const response = await fetch(`${server.url}${path}`, { method: "POST" });
      expect(response.status).toBe(202);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("location")).toBeNull();
    } finally { await server.close(); }
  });

  it.each([
    { name: "JSON UTF-8 bytes", response: { status: 200, body: "é".repeat(32 * 1024) } },
    { name: "HTML UTF-8 bytes", response: { status: 200, body: "é".repeat(8193), content_type: "text/html" } },
    { name: "raw bytes", response: { status: 200, raw_body: new Uint8Array(64 * 1024 + 1), content_type: "application/octet-stream" } },
    { name: "untyped nonempty bytes", response: { status: 200, raw_body: new Uint8Array([65]) } },
    { name: "unsupported status", response: { status: 302, body: "must-not-appear" } },
    { name: "unsupported content type", response: { status: 200, body: "must-not-appear", content_type: "text/javascript" } },
  ])("rejects invalid provider output before releasing it: $name", async ({ response: result }) => {
    const path = "/v2/integrations/example/approvals";
    const server = await start({
      routes: [{ route_id: "approval", method: "POST", path }],
      // Deliberately violate the output contract to exercise the host guard.
      accept: async () => result as ProviderHttpResponseV1,
    });
    try {
      const response = await fetch(`${server.url}${path}`, { method: "POST" });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "internal", message: "request failed" } });
    } finally { await server.close(); }
  });

  it("passes the exact unparsed bytes and Slack headers to the signed application", async () => {
    const accept = vi.fn(
      async (
        _request: Parameters<
          PrivateSlackApprovalInteractionHttpPortV1["accept"]
        >[0],
      ) => "accepted" as const,
    );
    const server = await start(
      createPrivateSlackApprovalHttpAdapterV1({ accept }),
    );
    const raw = "payload=%7B%22exact%22%3A%22a%2Bb%2520c%22%7D";
    try {
      const response = await fetch(
        `${server.url}${PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": "1800000000",
            "x-slack-signature": `v0=${"a".repeat(64)}`,
          },
          body: raw,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(response.headers.get("content-length")).toBe("0");
      expect(response.headers.get("content-type")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(accept).toHaveBeenCalledOnce();
      const accepted = accept.mock.calls[0]![0];
      expect(Buffer.from(accepted.raw_body).toString("utf8")).toBe(raw);
      expect(accepted).toMatchObject({
        content_type: "application/x-www-form-urlencoded",
        slack_request_timestamp: "1800000000",
        slack_signature: `v0=${"a".repeat(64)}`,
      });
    } finally {
      await server.close();
    }
  });

  it("does not reserve a provider route when no ingress is configured", async () => {
    const server = await start();
    try {
      const response = await fetch(
        `${server.url}${PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1}`,
        { method: "POST", body: "payload=%7B%7D" },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: "request failed" },
      });
    } finally {
      await server.close();
    }
  });

  it("rejects an oversized provider body before calling the application", async () => {
    const accept = vi.fn(
      async (
        _request: Parameters<
          PrivateSlackApprovalInteractionHttpPortV1["accept"]
        >[0],
      ) => "accepted" as const,
    );
    const server = await start(
      createPrivateSlackApprovalHttpAdapterV1({ accept }),
    );
    try {
      const response = await fetch(
        `${server.url}${PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1}`,
        {
          method: "POST",
          body: `payload=${"a".repeat(64 * 1024)}`,
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_request", message: "request failed" },
      });
      expect(accept).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
