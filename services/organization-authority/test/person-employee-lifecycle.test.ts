import { Buffer } from "node:buffer";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BegunPersonOidcLogin } from "../src/application/person-identity-sessions.js";
import type {
  FrozenPersonSessionOidcConfiguration,
  OidcAuthorizationCodeResult,
} from "../src/application/ports/person-session-dependencies.js";
import { initializePersonSessionCredentials, issuePersonOnboardingInvitation } from "../src/composition/person-onboarding-service.js";
import { startOrganizationAuthorityApiRuntime } from "../src/composition/organization-authority-api-runtime.js";
import { bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";
import { readPrivateAuthorityPersonSessionPkceKey } from "../src/adapters/security/private-file-credentials.js";
import type { PersonSessionOidcAuthorizationProvider } from "../src/composition/lazy-person-session-oidc-provider.js";

const roots: string[] = [];

function root(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-clean-employee-lifecycle-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

class MockOidcProvider implements PersonSessionOidcAuthorizationProvider {
  private last: BegunPersonOidcLogin | undefined;
  email = "founder@example.com";

  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    this.last = attempt;
    return `https://issuer.example/authorize?state=${encodeURIComponent(attempt.state)}`;
  }

  async redeemAuthorizationCode(_input: {
    configuration: FrozenPersonSessionOidcConfiguration;
    authorization_code: string;
    pkce_verifier: string;
  }): Promise<OidcAuthorizationCodeResult> {
    if (this.last === undefined) throw new Error("missing OIDC attempt");
    return {
      kind: "verified",
      token: {
        issuer: "https://issuer.example",
        subject: `subject-${this.email}`,
        audience: "founder-client",
        nonce: this.last.nonce,
        issued_at: Math.floor(Date.now() / 1000),
        claims: { email: this.email, email_verified: true },
      },
    };
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function login(
  origin: string,
  grant: string,
): Promise<Record<string, unknown>> {
  const begun = await fetch(`${origin}/v2/session/oidc/begin`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-echo-client-ip": "192.0.2.1",
    },
    body: JSON.stringify({
      kind: "identity_bootstrap",
      login_grant: grant,
      loopback_handoff: {
        url: `http://127.0.0.1:39999/${"P".repeat(43)}`,
        token: "T".repeat(43),
      },
    }),
  });
  expect(begun.status).toBe(201);
  const authorization = await json(begun);
  const state = new URL(authorization.authorization_url as string).searchParams.get("state");
  expect(state).not.toBeNull();
  const callback = await fetch(
    `${origin}/v2/session/oidc/callback?state=${encodeURIComponent(state!)}&code=code`,
  );
  expect(callback.status).toBe(200);
  const page = await callback.text();
  const encoded = /name="session" value="([A-Za-z0-9_-]+)"/.exec(page)?.[1];
  expect(encoded).toBeDefined();
  return JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Person employee lifecycle", () => {
  it("keeps employee lifecycle owner-only, invalidates reissued grants, revokes reads, and permits a new tenure", async () => {
    const parent = root();
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(parent, "state"),
      organization_display_name: "Example",
      owner_display_name: "Founder",
      created_at: new Date(Date.now() - 1_000).toISOString(),
      creating_artifact_revision: "employee-lifecycle-test",
    });
    const oidc = {
      issuer: "https://issuer.example",
      client_id: "founder-client",
      redirect_uri: "https://authority.example/v2/session/oidc/callback",
      tenant: { kind: "issuer" as const },
      id_token_algorithms: ["RS256"],
    };
    const credentials = initializePersonSessionCredentials({
      state_directory: initialized.state_directory,
    });
    const invitations = join(parent, "invitations");
    mkdirSync(invitations, { mode: 0o700 });
    chmodSync(invitations, 0o700);
    const founderInvitation = join(invitations, "founder.json");
    issuePersonOnboardingInvitation({
      state_directory: initialized.state_directory,
      oidc,
      pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
        credentials.pkce_sealing_key_reference,
      ),
      membership_id: initialized.owner_membership_id,
      expected_email: "founder@example.com",
      authority_url: "https://authority.example",
      output_path: founderInvitation,
    });
    const provider = new MockOidcProvider();
    const runtime = await startOrganizationAuthorityApiRuntime(
      {
        state_directory: initialized.state_directory,
        host: "127.0.0.1",
        port: 19_992,
        authority_url: "https://authority.example",
        oidc,
        client_authentication: { method: "none" },
        pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
          credentials.pkce_sealing_key_reference,
        ),
      },
      { oidc_provider: provider },
    );
    try {
      const origin = `http://127.0.0.1:${String(runtime.address.port)}`;
      const founderGrant = (JSON.parse(readFileSync(founderInvitation, "utf8")) as { login_grant: string }).login_grant;
      const founder = await login(origin, founderGrant);
      const founderAccess = founder.access_token as string;
      const invite = await fetch(`${origin}/v1/person/employees`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${founderAccess}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Jane Doe", email: "jane@example.com" }),
      });
      expect(invite.status).toBe(201);
      const first = await json(invite);
      expect(Object.keys(first).sort()).toEqual(["expires_at", "login_grant"]);

      const pendingRoster = await fetch(`${origin}/v1/person/employees`, {
        headers: { authorization: `Bearer ${founderAccess}` },
      });
      expect(pendingRoster.status).toBe(200);
      expect(await json(pendingRoster)).toEqual({
        schema_version: 1,
        kind: "echo-clean-person-employee-roster-v1",
        employees: [
          {
            email: "jane@example.com",
            display_name: "Jane Doe",
            membership_status: "active",
            invitation_state: "pending",
          },
        ],
      });

      const secondEmployee = await fetch(`${origin}/v1/person/employees`, {
        method: "POST",
        headers: { authorization: `Bearer ${founderAccess}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "John Doe", email: "john@example.com" }),
      });
      expect(secondEmployee.status).toBe(201);

      const duplicate = await fetch(`${origin}/v1/person/employees`, {
        method: "POST",
        headers: { authorization: `Bearer ${founderAccess}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Jane Doe", email: "jane@example.com" }),
      });
      expect(duplicate.status).toBe(409);

      const reissue = await fetch(`${origin}/v1/person/employees`, {
        method: "PUT",
        headers: { authorization: `Bearer ${founderAccess}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "jane@example.com" }),
      });
      expect(reissue.status).toBe(201);
      const second = await json(reissue);
      const secondReissue = await fetch(`${origin}/v1/person/employees`, {
        method: "PUT",
        headers: { authorization: `Bearer ${founderAccess}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "jane@example.com" }),
      });
      expect(secondReissue.status).toBe(201);
      const third = await json(secondReissue);
      const oldGrant = await fetch(`${origin}/v2/session/oidc/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "identity_bootstrap", login_grant: first.login_grant }),
      });
      expect(oldGrant.status).toBe(401);
      const supersededGrant = await fetch(`${origin}/v2/session/oidc/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "identity_bootstrap", login_grant: second.login_grant }),
      });
      expect(supersededGrant.status).toBe(401);

      provider.email = "jane@example.com";
      const employee = await login(origin, third.login_grant as string);
      const employeeAccess = employee.access_token as string;
      const redundantReissue = await fetch(`${origin}/v1/person/employees`, {
        method: "PUT",
        headers: { authorization: `Bearer ${founderAccess}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "jane@example.com" }),
      });
      expect(redundantReissue.status).toBe(409);
      const employeeDenied = await fetch(`${origin}/v1/person/employees`, {
        headers: { authorization: `Bearer ${employeeAccess}` },
      });
      expect(employeeDenied.status).toBe(401);

      const employeeWriteDenied = await fetch(`${origin}/v1/person/employees`, {
        method: "PUT",
        headers: { authorization: `Bearer ${employeeAccess}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "jane@example.com" }),
      });
      expect(employeeWriteDenied.status).toBe(401);

      const redeemedRoster = await fetch(`${origin}/v1/person/employees`, {
        headers: { authorization: `Bearer ${founderAccess}` },
      });
      expect(redeemedRoster.status).toBe(200);
      const redeemedEmployees = (await json(redeemedRoster)).employees as Array<Record<string, unknown>>;
      expect(redeemedEmployees).toEqual(
        expect.arrayContaining([
          {
            email: "jane@example.com",
            display_name: "Jane Doe",
            membership_status: "active",
            invitation_state: "redeemed",
          },
          {
            email: "john@example.com",
            display_name: "John Doe",
            membership_status: "active",
            invitation_state: "pending",
          },
        ]),
      );

      const revoke = await fetch(`${origin}/v1/person/employees`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${founderAccess}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "jane@example.com" }),
      });
      expect(revoke.status).toBe(204);
      const revokedRoster = await fetch(`${origin}/v1/person/employees`, {
        headers: { authorization: `Bearer ${founderAccess}` },
      });
      expect(revokedRoster.status).toBe(200);
      const revokedEmployees = (await json(revokedRoster)).employees as Array<Record<string, unknown>>;
      expect(revokedEmployees).toEqual(
        expect.arrayContaining([
          {
            email: "jane@example.com",
            display_name: "Jane Doe",
            membership_status: "revoked",
            invitation_state: "none",
          },
          {
            email: "john@example.com",
            display_name: "John Doe",
            membership_status: "active",
            invitation_state: "pending",
          },
        ]),
      );
      const revokedRead = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${employeeAccess}` },
      });
      expect(revokedRead.status).toBe(401);

      const replacement = await fetch(`${origin}/v1/person/employees`, {
        method: "POST",
        headers: { authorization: `Bearer ${founderAccess}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Jane Doe Again", email: "jane@example.com" }),
      });
      expect(replacement.status).toBe(201);
      const replacementInvitation = await json(replacement);
      expect(replacementInvitation.login_grant).not.toBe(second.login_grant);
      const rehired = await login(origin, replacementInvitation.login_grant as string);
      const rehiredRead = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${rehired.access_token as string}` },
      });
      expect(rehiredRead.status).toBe(200);
      const rehiredRoster = await fetch(`${origin}/v1/person/employees`, {
        headers: { authorization: `Bearer ${founderAccess}` },
      });
      expect(rehiredRoster.status).toBe(200);
      const currentEmployees = (await json(rehiredRoster)).employees as Array<Record<string, unknown>>;
      expect(currentEmployees.filter((entry) => entry.email === "jane@example.com")).toEqual([
        {
          email: "jane@example.com",
          display_name: "Jane Doe Again",
          membership_status: "active",
          invitation_state: "redeemed",
        },
      ]);
    } finally {
      await runtime.close();
    }
  });
});
