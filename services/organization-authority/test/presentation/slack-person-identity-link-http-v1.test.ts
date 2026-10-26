import { once } from "node:events";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { createSqliteSlackPersonIdentityLinkRepositoryV1 } from "../../../../providers/slack/server/src/person-identity/sqlite-slack-person-identity-link-repository-v1.js";
import { createSlackExternalIdentityHttpApplicationV1 } from "../../../../providers/slack/server/src/person-identity/slack-person-external-identity-runtime-bundle-v1.js";
import { SlackPersonBrowserIdentityLinkWorkflowV1 } from "../../../../providers/slack/server/src/person-identity/slack-person-browser-identity-link-workflow-v1.js";
import { AUTHORITY_ID, authorization, beginRequest, MEMBERSHIP_ID, NOW, ORGANIZATION_ID, setup, tokenAccess, workflowOptions } from "../../../../providers/slack/server/test/person-identity/fixtures.js";
import { createOrganizationAuthorityHttpServer } from "../../src/presentation/organization-authority-http-server.js";

/** Serves the Person HTTP routes on a loopback port. */
async function listening(
  person_external_identity_link: Parameters<typeof createOrganizationAuthorityHttpServer>[0]["person_external_identity_link"],
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const server = createOrganizationAuthorityHttpServer({
    descriptor: {} as never,
    sessions: {} as never,
    oidc_provider: {} as never,
    expected_issuer: "https://issuer.example",
    person_external_identity_link,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test HTTP server did not bind TCP");
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}

describe("Person Slack identity-link HTTP routes", () => {
  it("dispatches an authenticated begin through the configured Person HTTP server", async () => {
    const context = await setup();
    const server = await listening(
      // The browser and setup routes are not called here.
      createSlackExternalIdentityHttpApplicationV1({ service: context.application, browser: {} as never, setup: {} as never }),
    );
    try {
      const response = await fetch(
        `${server.baseUrl}/v2/integration-links/slack/challenges`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer bearer",
            "content-type": "application/json",
          },
          body: JSON.stringify(beginRequest()),
        },
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        provider: "slack",
        channel_id: "D12345678",
      });
      expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();
      expect(await context.application.tools("bearer")).toMatchObject({ membership_id: MEMBERSHIP_ID, tools: [{ personal_status: "unlinked" }] });
      // The V2 tools read is retired (ADR-0048): Slack's tools reach a person only through the V4 list.
      const retired = await fetch(`${server.baseUrl}/v2/person/tools`, { headers: { authorization: "Bearer bearer" } });
      expect(retired.status).toBe(404);
      const malformed = await fetch(`${server.baseUrl}/v2/integration-links/slack/challenges`, {
        method: "POST", headers: { authorization: "Bearer bearer", "content-type": "application/json" }, body: JSON.stringify({ ...beginRequest(), recipient_user_id: "" }),
      });
      expect(malformed.status).toBe(400);
      const disconnected = await fetch(`${server.baseUrl}/v2/person/external-identities/slack/disconnect`, {
        method: "POST", headers: { authorization: "Bearer bearer", "content-type": "application/json" }, body: "{}",
      });
      expect(disconnected.status).toBe(200);
      expect(await disconnected.json()).toMatchObject({ membership_id: MEMBERSHIP_ID, tools: [{ personal_status: "unlinked" }] });
      const foreignTarget = await fetch(`${server.baseUrl}/v2/person/external-identities/slack/disconnect`, {
        method: "POST", headers: { authorization: "Bearer bearer", "content-type": "application/json" }, body: JSON.stringify({ membership_id: "mem_00000000-0000-4000-8000-000000000002" }),
      });
      expect(foreignTarget.status).toBe(400);
      const unauthenticatedDisconnect = await fetch(`${server.baseUrl}/v2/person/external-identities/slack/disconnect`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      expect(unauthenticatedDisconnect.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("accepts Slack's query callback through the HTTP server and commits only after authenticated status", async () => {
    const context = await setup();
    let state = "";
    const browser = new SlackPersonBrowserIdentityLinkWorkflowV1({
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      authentication: { authenticateAccess: () => authorization },
      repository: createSqliteSlackPersonIdentityLinkRepositoryV1(workflowOptions(context, {
        authentication: { authenticateAccess: () => authorization }, membership_type: () => "employee",
        slack_token_access: tokenAccess(),
      })),
      browser_provider: () => ({
        authorizationUrl: (input) => { state = input.state; return "https://slack.com/openid/connect/authorize?opaque=yes"; },
        verifyCallback: async (input) => {
          expect(input.parameters.getAll("state")).toEqual([state]);
          expect(input.parameters.getAll("code")).toEqual(["provider-code"]);
          return {
            team_id: "T12345678",
            user_id: "U12345679",
            verification_evidence_sha256: canonicalSha256("browser-proof"),
          };
        },
      }),
      now: () => NOW,
    });
    const server = await listening(createSlackExternalIdentityHttpApplicationV1({ service: context.application, browser, setup: {} as never }));
    const { baseUrl } = server;
    const headers = { authorization: "Bearer bearer", "content-type": "application/json" };
    try {
      for (const [method, path] of [
        ["POST", "/v2/person/external-identities/slack/browser/begin"],
        ["POST", "/v2/person/external-identities/slack/browser/status"],
        ["POST", "/v2/person/external-identities/slack/browser/cancel"],
      ] as const) {
        const response = await fetch(`${baseUrl}${path}?unexpected=query`, {
          method,
          headers: method === "POST" ? headers : undefined,
          body: method === "POST" ? "{}" : undefined,
        });
        expect(response.status).toBe(404);
      }
      const begin = await fetch(`${baseUrl}/v2/person/external-identities/slack/browser/begin`, {
        method: "POST", headers,
        body: JSON.stringify({ request_id: "psb_00000000-0000-4000-8000-000000000091" }),
      });
      expect(begin.status).toBe(201);
      const { attempt_id: attemptId } = await begin.json() as { attempt_id: string };

      const callback = await fetch(`${baseUrl}/v2/person/external-identities/slack/browser/callback?${new URLSearchParams({ state, code: "provider-code" })}`);
      expect(callback.status).toBe(200);
      const postCallback = await fetch(`${baseUrl}/v2/person/external-identities/slack/browser/callback`, {
        method: "POST", headers, body: "{}",
      });
      expect(postCallback.status).toBe(404);
      expect(callback.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(callback.headers.get("cache-control")).toBe("no-store");
      expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
      expect(callback.headers.get("content-security-policy")).toBe("default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      const callbackPage = await callback.text();
      expect(callbackPage).not.toContain("provider-code");
      expect(callbackPage).not.toContain(state);
      expect(context.database.prepare("SELECT count(*) AS count FROM organization_external_human_link_current").get()).toEqual({ count: 0 });
      expect(context.slack.openIdentityLinkDirectMessage).not.toHaveBeenCalled();
      expect(context.slack.postIdentityLinkChallenge).not.toHaveBeenCalled();

      const status = await fetch(`${baseUrl}/v2/person/external-identities/slack/browser/status`, {
        method: "POST", headers, body: JSON.stringify({ attempt_id: attemptId }),
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ status: "complete", failure_reason: null });
      expect(context.database.prepare("SELECT count(*) AS count FROM organization_external_human_link_current").get()).toEqual({ count: 1 });
      expect(await context.application.tools("bearer")).toMatchObject({
        tools: [{ provider: "slack", personal_status: "linked", account_id: "U12345679" }],
      });
    } finally {
      await server.close();
    }
  });
});
