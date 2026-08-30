import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationAuthorityHttpServer } from "../../src/presentation/organization-authority-http-server.js";
import {
  PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1,
  type PrivateSlackApprovalInteractionHttpPortV1,
} from "../../src/presentation/private-slack-approval-interaction-http-port-v1.js";
import { createPrivateSlackApprovalHttpAdapterV1 } from "../../src/composition/providers/slack/private-approval/private-slack-approval-http-adapter-v1.js";
import type { PrivateApprovalInteractionHttpApplicationV1 } from "../../src/presentation/private-approval-interaction-http-application-v1.js";
import type { PersonExternalIdentityLinkHttpApplicationV1 } from "../../src/presentation/person-external-identity-link-http-application.js";
import { PERSON_SESSION_OIDC_BEGIN_PATH } from "../../src/presentation/person-identity-session-http-application.js";

function serverOptions(input: {
  readonly approval?: PrivateApprovalInteractionHttpApplicationV1;
  readonly external_identity?: PersonExternalIdentityLinkHttpApplicationV1;
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
  application?: PrivateApprovalInteractionHttpApplicationV1,
) {
  const server = createOrganizationAuthorityHttpServer(
    serverOptions({ approval: application }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("clean HTTP server did not bind TCP");
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

describe("private Slack approval interactions HTTP mount V1", () => {
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
      throw new Error("clean HTTP server did not bind TCP");
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
            method: "POST",
            path: PERSON_SESSION_OIDC_BEGIN_PATH,
            accept: async () => "accepted",
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
          approval: { method: "POST", path, accept: async () => "accepted" },
          external_identity: {
            routes: [{ route_id: "example-identity", method: "POST", path }],
            accept: async () => ({ status: 200, body: {} }),
          },
        }),
      ),
    ).toThrow(`provider ingress route is configured more than once: POST ${path}`);
  });

  it("mounts a selected non-Slack ingress without a server route change", async () => {
    const accept = vi.fn(
      async (
        _request: Parameters<
          PrivateApprovalInteractionHttpApplicationV1["accept"]
        >[0],
      ) => "accepted" as const,
    );
    const server = await start({
      method: "POST",
      path: "/v2/integrations/example/approvals",
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
      expect(response.status).toBe(200);
      expect(accept).toHaveBeenCalledWith({
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
