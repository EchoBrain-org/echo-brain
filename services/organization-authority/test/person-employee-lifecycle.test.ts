import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startOrganizationAuthorityApiRuntime } from "../src/composition/organization-authority-api-runtime.js";
import { UNUSED_ANSWER_MODEL, ownerGenesis, signInHttpSession, syntheticOidcProvider } from "./fixtures/owner-session.js";

const roots: string[] = [];

function root(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-clean-employee-lifecycle-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Person employee lifecycle", () => {
  it("keeps employee lifecycle owner-only, invalidates reissued grants, revokes reads, and permits a new tenure", async () => {
    const oidc = {
      issuer: "https://issuer.example",
      client_id: "founder-client",
      redirect_uri: "https://authority.example/v2/session/oidc/callback",
      tenant: { kind: "issuer" as const },
      id_token_algorithms: ["RS256"],
    };
    const owner = ownerGenesis({ root: root(), oidc, email: "founder@example.com", authority_url: "https://authority.example", revision: "employee-lifecycle-test" });
    let email = "founder@example.com";
    const provider = syntheticOidcProvider(oidc, () => email, { subject: () => `subject-${email}` });
    const runtime = await startOrganizationAuthorityApiRuntime(
      {
        state_directory: owner.initialized.state_directory,
        host: "127.0.0.1",
        port: 19_992,
        authority_url: "https://authority.example",
        oidc,
        client_authentication: { method: "none" },
        pkce_sealing_key: owner.pkce,
      },
      { oidc_provider: provider, answer_composition_generation: UNUSED_ANSWER_MODEL },
    );
    try {
      const origin = `http://127.0.0.1:${String(runtime.address.port)}`;
      const employees = (token?: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) =>
        fetch(`${origin}/v1/person/employees`, {
          method,
          headers: {
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...extraHeaders,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const begin = (login_grant: unknown) => fetch(`${origin}/v2/session/oidc/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "identity_bootstrap", login_grant }),
      });
      const login = (grant: string) => signInHttpSession(origin, provider, grant, "code");
      const founder = await login(owner.login_grant);
      const founderAccess = founder.access_token as string;
      const invite = await employees(founderAccess, "POST", { name: "Jane Doe", email: "jane@example.com" });
      expect(invite.status).toBe(201);
      const first = await json(invite);
      expect(Object.keys(first).sort()).toEqual(["expires_at", "login_grant"]);

      const pendingRoster = await employees(founderAccess);
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

      const secondEmployee = await employees(founderAccess, "POST", { name: "John Doe", email: "john@example.com" });
      expect(secondEmployee.status).toBe(201);

      // New invitations must name a mailbox-shaped address.
      const rejectedInvite = await employees(founderAccess, "POST", { name: "Alice Local", email: "alice@localhost" });
      expect(rejectedInvite.status).toBe(400);

      const duplicate = await employees(founderAccess, "POST", { name: "Jane Doe", email: "jane@example.com" });
      expect(duplicate.status).toBe(409);

      const reissue = await employees(founderAccess, "PUT", { email: "jane@example.com" });
      expect(reissue.status).toBe(201);
      const second = await json(reissue);
      const secondReissue = await employees(founderAccess, "PUT", { email: "jane@example.com" });
      expect(secondReissue.status).toBe(201);
      const third = await json(secondReissue);
      const oldGrant = await begin(first.login_grant);
      expect(oldGrant.status).toBe(401);
      const supersededGrant = await begin(second.login_grant);
      expect(supersededGrant.status).toBe(401);

      email = "jane@example.com";
      const employee = await login(third.login_grant as string);
      const employeeAccess = employee.access_token as string;
      const redundantReissue = await employees(founderAccess, "PUT", { email: "jane@example.com" });
      expect(redundantReissue.status).toBe(409);

      // A modified client can call every route and claim any local role. The
      // Authority derives the role from its own current session/membership.
      async function expectManagementDenied(token?: string) {
        for (const method of ["GET", "POST", "PUT", "DELETE"]) {
          const body = method === "POST"
            ? { name: "Unauthorized", email: "unauthorized@example.com" }
            : { email: "john@example.com" };
          const denied = await employees(token, method, method === "GET" ? undefined : body, { "content-type": "application/json", "x-echo-membership-type": "owner" });
          expect(denied.status, `${method} must reject non-owner access`).toBe(401);
          expect(await denied.text()).not.toContain("login_grant");
        }
      }
      for (const token of [employeeAccess, "forged-owner-access-token", undefined]) {
        await expectManagementDenied(token);
      }
      const forgedRole = await employees(employeeAccess, "POST", { name: "Unauthorized", email: "unauthorized@example.com", membership_type: "owner" });
      expect(forgedRole.status).toBe(400);
      const afterDenied = await employees(founderAccess);
      const afterDeniedEmployees = (await json(afterDenied)).employees as Array<Record<string, unknown>>;
      expect(afterDeniedEmployees.some((entry) => entry.email === "unauthorized@example.com")).toBe(false);
      expect(afterDeniedEmployees.find((entry) => entry.email === "john@example.com")).toMatchObject({
        membership_status: "active", invitation_state: "pending",
      });

      const redeemedRoster = await employees(founderAccess);
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

      const revoke = await employees(founderAccess, "DELETE", { email: "jane@example.com" });
      expect(revoke.status).toBe(204);
      const revokedRoster = await employees(founderAccess);
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
        ]),
      );
      const revokedRead = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${employeeAccess}` },
      });
      expect(revokedRead.status).toBe(401);
      await expectManagementDenied(employeeAccess);

      const replacement = await employees(founderAccess, "POST", { name: "Jane Doe Again", email: "jane@example.com" });
      expect(replacement.status).toBe(201);
      const replacementInvitation = await json(replacement);
      expect(replacementInvitation.login_grant).not.toBe(second.login_grant);
      email = "jane@example.com";
      const rehired = await login(replacementInvitation.login_grant as string);
      const rehiredRead = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${rehired.access_token as string}` },
      });
      expect(rehiredRead.status).toBe(200);
      const rehiredRoster = await employees(founderAccess);
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
