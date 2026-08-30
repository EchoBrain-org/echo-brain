import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BegunPersonOidcLogin } from "../src/application/person-identity-sessions.js";
import {
  PersonIdentitySessionApplication,
  PersonOidcRetryableError,
} from "../src/application/person-identity-sessions.js";
import type { PersonSessionOidcAuthorizationProvider } from "../src/composition/lazy-person-session-oidc-provider.js";
import { SqlitePersonSessionRepository } from "../src/adapters/persistence/sqlite/sqlite-person-session-repository.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-authority-database.js";
import { NodePersonSessionCrypto } from "../src/adapters/security/node-person-session-crypto.js";
import { SystemAuthorityClock } from "../src/adapters/runtime/system-runtime-ports.js";
import { bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";
import {
  initializePersonSessionCredentials,
  issuePersonOnboardingInvitation,
} from "../src/composition/person-onboarding-service.js";
import { startOrganizationAuthorityApiRuntime } from "../src/composition/organization-authority-api-runtime.js";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "../src/composition/slack-person-external-identity-runtime-bundle-v1.js";
import type {
  PersonExternalIdentityRuntimeInputV1,
  OpenedPersonExternalIdentityRuntimeV1,
} from "../src/composition/person-external-identity-runtime.js";
import { readPrivateAuthorityPersonSessionPkceKey } from "../src/adapters/security/private-file-credentials.js";
import { MAXIMUM_ACTIVE_OIDC_LOGIN_ATTEMPTS } from "../src/domain/person-session-rules.js";

const roots: string[] = [];

function root(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-authority-api-runtime-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

class MockOidcProvider implements PersonSessionOidcAuthorizationProvider {
  private last: BegunPersonOidcLogin | undefined;

  constructor(
    private readonly claims: Readonly<Record<string, unknown>> = {
      email: "founder@example.com",
      email_verified: true,
    },
  ) {}

  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    this.last = attempt;
    return `https://issuer.example/authorize?state=${encodeURIComponent(attempt.state)}`;
  }

  async redeemAuthorizationCode(): Promise<{
    kind: "verified";
    token: {
      issuer: string;
      subject: string;
      audience: string;
      nonce: string;
      issued_at: number;
      claims: Readonly<Record<string, unknown>>;
    };
  }> {
    if (this.last === undefined) throw new Error("missing OIDC begin");
    return {
      kind: "verified",
      token: {
        issuer: "https://issuer.example",
        subject: "founder-subject",
        audience: "founder-client",
        nonce: this.last.nonce,
        issued_at: Math.floor(Date.now() / 1000),
        claims: this.claims,
      },
    };
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("Organization Authority API runtime", () => {
  it("wires an injected external-identity application without selecting a provider", async () => {
    const parent = root();
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(parent, "state"),
      organization_display_name: "Founder Organization",
      owner_display_name: "Founder",
      created_at: new Date(Date.now() - 1_000).toISOString(),
      creating_artifact_revision: "person-external-identity-runtime-test",
    });
    const credentials = initializePersonSessionCredentials({
      state_directory: initialized.state_directory,
    });
    const opened: PersonExternalIdentityRuntimeInputV1[] = [];
    let closed = 0;
    const runtime = await startOrganizationAuthorityApiRuntime(
      {
        state_directory: initialized.state_directory,
        host: "127.0.0.1",
        port: 19_992,
        authority_url: "https://authority.example",
        oidc: {
          issuer: "https://issuer.example",
          client_id: "founder-client",
          redirect_uri: "https://authority.example/v2/session/oidc/callback",
          tenant: { kind: "issuer" },
          id_token_algorithms: ["RS256"],
        },
        client_authentication: { method: "none" },
        pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
          credentials.pkce_sealing_key_reference,
        ),
      },
      {
        oidc_provider: new MockOidcProvider(),
        external_identity_runtime: {
          open(input): OpenedPersonExternalIdentityRuntimeV1 {
            opened.push(input);
            return {
              application: {
                routes: [
                  {
                    route_id: "fake-external-identity",
                    method: "POST",
                    path: "/v2/external-identity/fake",
                  },
                ],
                async accept(request) {
                  return {
                    status: 201,
                    body: { route_id: request.route_id, provider: "fake" },
                  };
                },
              },
              close: () => {
                closed += 1;
              },
            };
          },
        },
      },
    );
    try {
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        state_directory: initialized.state_directory,
        authority_id: initialized.authority_id,
        organization_id: initialized.organization_id,
        state_lineage_id: initialized.state_lineage_id,
      });
      const response = await fetch(
        `http://127.0.0.1:${String(runtime.address.port)}/v2/external-identity/fake`,
        { method: "POST", body: "{}" },
      );
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({
        route_id: "fake-external-identity",
        provider: "fake",
      });
    } finally {
      await runtime.close();
    }
    expect(closed).toBe(1);
  });

  it("burns a bootstrap invitation when the verified email does not match", async () => {
    const parent = root();
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(parent, "state"),
      organization_display_name: "Founder Organization",
      owner_display_name: "Founder",
      created_at: new Date(Date.now() - 1_000).toISOString(),
      creating_artifact_revision: "clean-person-email-binding-test",
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
    const pkce = readPrivateAuthorityPersonSessionPkceKey(
      credentials.pkce_sealing_key_reference,
    );
    const invitationDirectory = join(parent, "invitations");
    mkdirSync(invitationDirectory, { mode: 0o700 });
    chmodSync(invitationDirectory, 0o700);
    const invitationPath = join(invitationDirectory, "founder.invitation.json");
    issuePersonOnboardingInvitation({
      state_directory: initialized.state_directory,
      oidc,
      pkce_sealing_key: pkce,
      membership_id: initialized.owner_membership_id,
      expected_email: "founder@example.com",
      authority_url: "https://authority.example",
      output_path: invitationPath,
    });
    const invitation = JSON.parse(readFileSync(invitationPath, "utf8")) as {
      login_grant: string;
    };
    const database = openAuthorityDatabase(
      join(initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    try {
      const crypto = new NodePersonSessionCrypto(pkce);
      const sessions = new PersonIdentitySessionApplication(
        new SqlitePersonSessionRepository(database),
        oidc,
        {
          clock: new SystemAuthorityClock(),
          random: crypto,
          hash: crypto,
          pkce_sealer: crypto,
          oidc_provider: new MockOidcProvider({
            email: "someone-else@example.com",
            email_verified: true,
          }),
        },
      );
      const begun = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invitation.login_grant,
      });
      await expect(
        sessions.completeOidcLogin({
          state: begun.state,
          authorization_code: "wrong-email-code",
        }),
      ).rejects.toMatchObject({
        code: "unauthorized",
        message: "person authentication failed",
      });
      expect(
        database
          .prepare(
            "SELECT consumed_at IS NOT NULL FROM authority_person_login_grants",
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        database
          .prepare("SELECT count(*) FROM authority_person_session_families")
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("releases retryable bootstrap redemption before consuming the invitation", async () => {
    const parent = root();
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(parent, "state"),
      organization_display_name: "Founder Organization",
      owner_display_name: "Founder",
      created_at: new Date(Date.now() - 1_000).toISOString(),
      creating_artifact_revision: "clean-person-bootstrap-retry-test",
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
    const pkce = readPrivateAuthorityPersonSessionPkceKey(
      credentials.pkce_sealing_key_reference,
    );
    const invitations = join(parent, "invitations");
    mkdirSync(invitations, { mode: 0o700 });
    chmodSync(invitations, 0o700);
    const invitationPath = join(invitations, "founder.invitation.json");
    issuePersonOnboardingInvitation({
      state_directory: initialized.state_directory,
      oidc,
      pkce_sealing_key: pkce,
      membership_id: initialized.owner_membership_id,
      expected_email: "founder@example.com",
      authority_url: "https://authority.example",
      output_path: invitationPath,
    });
    const invitation = JSON.parse(readFileSync(invitationPath, "utf8")) as {
      login_grant: string;
    };
    const database = openAuthorityDatabase(
      join(initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    try {
      let now = new Date().toISOString();
      const crypto = new NodePersonSessionCrypto(pkce);
      const sessions = new PersonIdentitySessionApplication(
        new SqlitePersonSessionRepository(database),
        oidc,
        {
          clock: { now: () => now },
          random: crypto,
          hash: crypto,
          pkce_sealer: crypto,
          oidc_provider: {
            async redeemAuthorizationCode() {
              return { kind: "retryable_before_redemption" };
            },
          },
        },
      );
      const first = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invitation.login_grant,
      });
      const reattached = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invitation.login_grant,
      });
      expect(reattached).toMatchObject({
        login_attempt_id: first.login_attempt_id,
        state: first.state,
        nonce: first.nonce,
      });

      await expect(
        sessions.completeOidcLogin({
          state: first.state,
          authorization_code: "retryable-provider-result",
        }),
      ).rejects.toBeInstanceOf(PersonOidcRetryableError);
      expect(
        database
          .prepare("SELECT consumed_at FROM authority_person_login_grants")
          .pluck()
          .get(),
      ).toBeNull();
      expect(
        database
          .prepare(
            "SELECT redemption_claim_id IS NULL AND terminal_outcome IS NULL FROM authority_oidc_login_attempts",
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        sessions.beginOidcLogin({
          kind: "identity_bootstrap",
          login_grant: invitation.login_grant,
        }),
      ).toMatchObject({ login_attempt_id: first.login_attempt_id });
      now = new Date(Date.parse(now) + 11 * 60 * 1000).toISOString();
      let expiredError: unknown;
      try {
        sessions.beginOidcLogin({
          kind: "identity_bootstrap",
          login_grant: invitation.login_grant,
        });
      } catch (error) {
        expiredError = error;
      }
      expect(expiredError).toMatchObject({ code: "unauthorized" });
      expect(
        database
          .prepare("SELECT invalidated_at IS NOT NULL FROM authority_person_login_grants")
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("caps unauthenticated OIDC begins durably and releases expired capacity", () => {
    const parent = root();
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(parent, "state"),
      organization_display_name: "Founder Organization",
      owner_display_name: "Founder",
      created_at: new Date(Date.now() - 1_000).toISOString(),
      creating_artifact_revision: "clean-person-oidc-capacity-test",
    });
    const pkce = readPrivateAuthorityPersonSessionPkceKey(
      initializePersonSessionCredentials({
        state_directory: initialized.state_directory,
      }).pkce_sealing_key_reference,
    );
    const database = openAuthorityDatabase(
      join(initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    try {
      let now = new Date().toISOString();
      const crypto = new NodePersonSessionCrypto(pkce);
      const sessions = new PersonIdentitySessionApplication(
        new SqlitePersonSessionRepository(database),
        {
          issuer: "https://issuer.example",
          client_id: "founder-client",
          redirect_uri: "https://authority.example/v2/session/oidc/callback",
          tenant: { kind: "issuer" },
          id_token_algorithms: ["RS256"],
        },
        {
          clock: { now: () => now },
          random: crypto,
          hash: crypto,
          pkce_sealer: crypto,
          oidc_provider: {
            async redeemAuthorizationCode() {
              return { kind: "retryable_before_redemption" };
            },
          },
        },
      );
      for (
        let index = 0;
        index < MAXIMUM_ACTIVE_OIDC_LOGIN_ATTEMPTS;
        index += 1
      ) {
        sessions.beginOidcLogin({ kind: "existing_identity_login" });
      }
      let capacityError: unknown;
      try {
        sessions.beginOidcLogin({ kind: "existing_identity_login" });
      } catch (error) {
        capacityError = error;
      }
      expect(capacityError).toMatchObject({ code: "rate_limited" });
      expect(
        database
          .prepare("SELECT count(*) FROM authority_oidc_login_attempts")
          .pluck()
          .get(),
      ).toBe(MAXIMUM_ACTIVE_OIDC_LOGIN_ATTEMPTS);

      now = new Date(Date.parse(now) + 11 * 60 * 1000).toISOString();
      expect(
        sessions.beginOidcLogin({ kind: "existing_identity_login" }),
      ).toMatchObject({ issuer: "https://issuer.example" });
      expect(
        database
          .prepare(
            "SELECT count(*) FROM authority_oidc_login_attempts WHERE terminal_outcome IS NULL",
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        database
          .prepare("SELECT count(*) FROM authority_oidc_login_attempts")
          .pluck()
          .get(),
      ).toBe(MAXIMUM_ACTIVE_OIDC_LOGIN_ATTEMPTS + 1);
    } finally {
      database.close();
    }
  });

  it("runs fresh genesis through founder grant, OIDC bootstrap, refresh, and logout without legacy state", async () => {
    const parent = root();
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(parent, "state"),
      organization_display_name: "Founder Organization",
      owner_display_name: "Founder",
      created_at: new Date(Date.now() - 1_000).toISOString(),
      creating_artifact_revision: "organization-authority-api-runtime-test",
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
    expect(credentials.pkce_sealing_key_reference).toContain(
      "person-session-pkce-sealing-key",
    );
    expect(() =>
      initializePersonSessionCredentials({
        state_directory: initialized.state_directory,
      }),
    ).toThrow();
    const pkce = readPrivateAuthorityPersonSessionPkceKey(
      credentials.pkce_sealing_key_reference,
    );
    const invitationDirectory = join(parent, "invitations");
    mkdirSync(invitationDirectory, { mode: 0o700 });
    chmodSync(invitationDirectory, 0o700);
    const invitationPath = join(invitationDirectory, "founder.invitation.json");
    const invitation = issuePersonOnboardingInvitation({
      state_directory: initialized.state_directory,
      oidc,
      pkce_sealing_key: pkce,
      membership_id: initialized.owner_membership_id,
      expected_email: "founder@example.com",
      authority_url: "https://authority.example",
      output_path: invitationPath,
    });
    expect(invitation.output_path).toBe(invitationPath);
    const boundaryDatabase = openAuthorityDatabase(
      join(initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    try {
      const crypto = new NodePersonSessionCrypto(pkce);
      const cleanOnlySessions = new PersonIdentitySessionApplication(
        new SqlitePersonSessionRepository(boundaryDatabase),
        oidc,
        {
          clock: new SystemAuthorityClock(),
          random: crypto,
          hash: crypto,
          pkce_sealer: crypto,
          oidc_provider: new MockOidcProvider(),
        },
      );
      expect(() =>
        cleanOnlySessions.createPersonReadAuthorizationPort(),
      ).toThrow("clean Person session runtime");
      expect(() =>
        cleanOnlySessions.withAuthenticatedWrite({
          access_token: "unreachable",
          commit: () => undefined,
        }),
      ).toThrow("clean Person session runtime");
    } finally {
      boundaryDatabase.close();
    }
    const invitationBody = JSON.parse(readFileSync(invitationPath, "utf8")) as {
      login_grant: string;
    };
    const runtime = await startOrganizationAuthorityApiRuntime(
      {
        state_directory: initialized.state_directory,
        host: "127.0.0.1",
        port: 19_991,
        authority_url: "https://authority.example",
        oidc,
        client_authentication: { method: "none" },
        pkce_sealing_key: pkce,
      },
      {
        oidc_provider: new MockOidcProvider(),
        external_identity_runtime:
          createSlackPersonExternalIdentityRuntimeBundleV1({}),
      },
    );
    try {
      const origin = `http://127.0.0.1:${String(runtime.address.port)}`;
      const descriptor = await fetch(`${origin}/v1/authority-descriptor`);
      expect(descriptor.status).toBe(200);
      expect((await json(descriptor)).authority_descriptor).toMatchObject({
        authority_id: initialized.authority_id,
        organization_id: initialized.organization_id,
      });
      const noSlack = await fetch(
        `${origin}/v2/integration-links/slack/challenges`,
        { method: "POST", body: "{}" },
      );
      expect(noSlack.status).toBe(503);

      const unavailableBootstrap = await fetch(
        `${origin}/v2/session/oidc/begin`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "identity_bootstrap",
            login_grant: "G".repeat(43),
          }),
        },
      );
      expect(unavailableBootstrap.status).toBe(401);

      const recoveryWithoutIdentity = await fetch(
        `${origin}/v2/session/oidc/begin`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "existing_identity_login",
            loopback_handoff: {
              url: `http://127.0.0.1:39999/${"U".repeat(43)}`,
              token: "N".repeat(43),
            },
          }),
        },
      );
      expect(recoveryWithoutIdentity.status).toBe(201);
      const recoveryWithoutIdentityState = new URL(
        (await json(recoveryWithoutIdentity)).authorization_url as string,
      ).searchParams.get("state");
      expect(recoveryWithoutIdentityState).not.toBeNull();
      const identityNotBoundCallback = await fetch(
        `${origin}/v2/session/oidc/callback?state=${encodeURIComponent(recoveryWithoutIdentityState!)}&code=code-unbound&iss=https%3A%2F%2Fissuer.example`,
      );
      expect(identityNotBoundCallback.status).toBe(200);
      expect(identityNotBoundCallback.headers.get("cache-control")).toBe(
        "no-store",
      );
      const identityNotBoundPage = await identityNotBoundCallback.text();
      expect(identityNotBoundPage).toContain(
        `action="http://127.0.0.1:39999/${"U".repeat(43)}"`,
      );
      expect(identityNotBoundPage).toContain(
        'name="token" value="' + "N".repeat(43) + '"',
      );
      expect(identityNotBoundPage).toContain(
        'name="error" value="identity_not_bound"',
      );
      expect(identityNotBoundPage).not.toContain('name="session"');
      expect(identityNotBoundPage).not.toContain("access_token");
      expect(identityNotBoundPage).not.toContain("refresh_token");

      const begun = await fetch(`${origin}/v2/session/oidc/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "identity_bootstrap",
          login_grant: invitationBody.login_grant,
          loopback_handoff: {
            url: `http://127.0.0.1:39999/${"P".repeat(43)}`,
            token: "T".repeat(43),
          },
        }),
      });
      expect(begun.status).toBe(201);
      const authorization = await json(begun);
      const state = new URL(
        authorization.authorization_url as string,
      ).searchParams.get("state");
      expect(state).not.toBeNull();

      const callback = await fetch(
        `${origin}/v2/session/oidc/callback?state=${encodeURIComponent(state!)}&code=code-1&iss=https%3A%2F%2Fissuer.example`,
      );
      expect(callback.status).toBe(200);
      expect(callback.headers.get("content-type")).toContain("text/html");
      expect(callback.headers.get("cache-control")).toBe("no-store");
      const callbackPage = await callback.text();
      expect(callbackPage).toContain(`action="http://127.0.0.1:39999/${"P".repeat(43)}"`);
      expect(callbackPage).toContain('name="token" value="' + "T".repeat(43) + '"');
      expect(callbackPage).not.toContain("access_token");
      expect(callbackPage).not.toContain("refresh_token");
      const encoded = /name="session" value="([A-Za-z0-9_-]+)"/.exec(callbackPage)?.[1];
      expect(encoded).toBeDefined();
      const session = JSON.parse(
        Buffer.from(encoded!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      expect(session.membership_id).toBe(initialized.owner_membership_id);

      const recoveryBegin = await fetch(`${origin}/v2/session/oidc/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "existing_identity_login" }),
      });
      expect(recoveryBegin.status).toBe(201);
      const recoveryState = new URL(
        (await json(recoveryBegin)).authorization_url as string,
      ).searchParams.get("state");
      const expiredDelivery = await fetch(
        `${origin}/v2/session/oidc/callback?state=${encodeURIComponent(recoveryState!)}&code=code-2&iss=https%3A%2F%2Fissuer.example`,
      );
      expect(expiredDelivery.status).toBe(200);
      expect(expiredDelivery.headers.get("content-type")).toContain("text/html");
      const expiredPage = await expiredDelivery.text();
      expect(expiredPage).toContain("Sign-in expired");
      expect(expiredPage).toContain("echo-brain person login");
      expect(expiredPage).not.toContain("access_token");
      expect(expiredPage).not.toContain("refresh_token");
      expect(expiredPage).not.toContain('name="session"');

      const searchBeforeGeneration = await fetch(
        `${origin}/v1/person/records`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.access_token as string}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query: "pricing" }),
        },
      );
      expect(searchBeforeGeneration.status).toBe(503);
      const malformedSearch = await fetch(`${origin}/v1/person/records`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token as string}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "pricing", unexpected: true }),
      });
      expect(malformedSearch.status).toBe(400);
      const unauthenticatedSearch = await fetch(
        `${origin}/v1/person/records`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "pricing" }),
        },
      );
      expect(unauthenticatedSearch.status).toBe(401);

      const refreshed = await fetch(`${origin}/v2/session/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      expect(refreshed.status).toBe(200);
      const rotated = await json(refreshed);
      expect(rotated.refresh_token).not.toBe(session.refresh_token);

      const logout = await fetch(`${origin}/v2/session/revocations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${rotated.access_token as string}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(logout.status).toBe(204);
      const afterLogout = await fetch(`${origin}/v2/session/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: rotated.refresh_token }),
      });
      expect(afterLogout.status).toBe(401);
    } finally {
      await runtime.close();
    }
  });
});
