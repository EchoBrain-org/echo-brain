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
import { SystemAuthorityClock } from "../src/adapters/system/system-authority-clock.js";
import { isOidcRedemptionClaimInNamespace } from "../src/application/ports/person-session-repository.js";
import { bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";
import {
  initializePersonSessionCredentials,
  issuePersonOnboardingInvitation,
} from "../src/composition/person-onboarding-service.js";
import { startOrganizationAuthorityApiRuntime } from "../src/composition/organization-authority-api-runtime.js";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "../src/composition/providers/slack/person-identity/slack-person-external-identity-runtime-bundle-v1.js";
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
  private retryableBeforeRedemption = false;
  private terminalRedemptionFailure = false;

  constructor(
    private claims: Readonly<Record<string, unknown>> = {
      email: "founder@example.com",
      email_verified: true,
    },
  ) {}

  setClaims(claims: Readonly<Record<string, unknown>>): void {
    this.claims = claims;
  }

  setAttempt(attempt: BegunPersonOidcLogin): void {
    this.last = attempt;
  }

  setRetryableBeforeRedemption(value: boolean): void {
    this.retryableBeforeRedemption = value;
  }

  setTerminalRedemptionFailure(value: boolean): void {
    this.terminalRedemptionFailure = value;
  }

  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    this.last = attempt;
    return `https://issuer.example/authorize?state=${encodeURIComponent(attempt.state)}`;
  }

  async redeemAuthorizationCode(): Promise<
    | { kind: "retryable_before_redemption" }
    | { kind: "terminal_failure"; diagnostic_stage: "redemption" }
    | {
        kind: "verified";
        token: {
          issuer: string;
          subject: string;
          audience: string;
          nonce: string;
          issued_at: number;
          claims: Readonly<Record<string, unknown>>;
        };
      }
  > {
    if (this.retryableBeforeRedemption)
      return { kind: "retryable_before_redemption" };
    if (this.terminalRedemptionFailure)
      return { kind: "terminal_failure", diagnostic_stage: "redemption" };
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
        external_identity_runtime_bundle: {
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

  it("forwards a matching invitation address as login_hint and ignores a wrong one", async () => {
    const parent = root();
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(parent, "state"),
      organization_display_name: "Founder Organization",
      owner_display_name: "Founder",
      created_at: new Date(Date.now() - 1_000).toISOString(),
      creating_artifact_revision: "clean-login-hint-test",
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
    const issue = (
      name: string,
    ): { login_grant: string; expected_email?: string } => {
      const path = join(invitationDirectory, name);
      issuePersonOnboardingInvitation({
        state_directory: initialized.state_directory,
        oidc,
        pkce_sealing_key: pkce,
        membership_id: initialized.owner_membership_id,
        expected_email: "founder@example.com",
        authority_url: "https://authority.example",
        output_path: path,
      });
      return JSON.parse(readFileSync(path, "utf8")) as {
        login_grant: string;
        expected_email?: string;
      };
    };
    const first = issue("founder.invitation.json");
    // The address rides in the artifact so the client can name it and hint it.
    expect(first.expected_email).toBe("founder@example.com");

    const database = openAuthorityDatabase(
      join(initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    try {
      const crypto = new NodePersonSessionCrypto(pkce);
      const provider = new MockOidcProvider();
      const sessions = new PersonIdentitySessionApplication(
        new SqlitePersonSessionRepository(database),
        oidc,
        {
          clock: new SystemAuthorityClock(),
          random: crypto,
          hash: crypto,
          pkce_sealer: crypto,
          oidc_provider: provider,
        },
      );
      const matched = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: first.login_grant,
        login_hint: "founder@example.com",
      });
      expect(matched.login_hint).toBe("founder@example.com");

      // A hint the grant does not name must never reach the provider: it could
      // otherwise pre-select an account the Authority is bound to reject, which
      // is the exact way a one-time invitation gets spent.
      const second = issue("second.invitation.json");
      const mismatched = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: second.login_grant,
        login_hint: "someone-else@example.com",
      });
      expect(mismatched.login_hint).toBeUndefined();

      // A malformed hint is dropped, not a reason to fail beginning a login.
      const third = issue("third.invitation.json");
      const malformed = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: third.login_grant,
        login_hint: "NOT AN EMAIL",
      });
      expect(malformed.login_hint).toBeUndefined();
    } finally {
      database.close();
    }
  });
  it("retries a verified wrong bootstrap account without spending its invitation", async () => {
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
    const parallelInvitationPath = join(
      invitationDirectory,
      "parallel-founder.invitation.json",
    );
    issuePersonOnboardingInvitation({
      state_directory: initialized.state_directory,
      oidc,
      pkce_sealing_key: pkce,
      membership_id: initialized.owner_membership_id,
      expected_email: "founder@example.com",
      authority_url: "https://authority.example",
      output_path: parallelInvitationPath,
    });
    const parallelInvitation = JSON.parse(
      readFileSync(parallelInvitationPath, "utf8"),
    ) as { login_grant: string };
    const databasePath = join(initialized.state_directory, "authority.sqlite");
    let database = openAuthorityDatabase(databasePath, { fileMustExist: true });
    try {
      const crypto = new NodePersonSessionCrypto(pkce);
      let provider = new MockOidcProvider({
        email: "someone-else@example.com",
        email_verified: true,
      });
      const diagnostics: string[] = [];
      const createSessions = () =>
        new PersonIdentitySessionApplication(
          new SqlitePersonSessionRepository(database),
          oidc,
          {
            clock: new SystemAuthorityClock(),
            random: crypto,
            hash: crypto,
            pkce_sealer: crypto,
            oidc_provider: provider,
            diagnostics: {
              oidcLoginDenied(reason) {
                diagnostics.push(reason);
              },
            },
          },
        );
      let sessions = createSessions();
      const begun = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invitation.login_grant,
      });
      provider.setAttempt(begun);
      const firstWrongAccountFailure = await sessions
        .completeOidcLogin({
          state: begun.state,
          authorization_code: "wrong-email-code",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(diagnostics).toEqual(["bootstrap_email_mismatch"]);
      expect(firstWrongAccountFailure).toBeInstanceOf(PersonOidcRetryableError);
      expect(
        database
          .prepare("SELECT consumed_at FROM authority_person_login_grants")
          .pluck()
          .get(),
      ).toBeNull();
      expect(
        isOidcRedemptionClaimInNamespace(
          database
            .prepare(
              "SELECT redemption_claim_id FROM authority_oidc_login_attempts",
            )
            .pluck()
            .get() as string,
          "reservation",
        ),
      ).toBe(true);

      // The retry marker must survive a real Authority process restart. A
      // fresh repository and application then reattach the exact attempt.
      database.close();
      database = openAuthorityDatabase(databasePath, { fileMustExist: true });
      provider = new MockOidcProvider({
        email: "someone-else@example.com",
        email_verified: true,
      });
      sessions = createSessions();
      const restarted = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invitation.login_grant,
      });
      expect(restarted).toMatchObject({
        login_attempt_id: begun.login_attempt_id,
        state: begun.state,
        nonce: begun.nonce,
      });

      // The marker retains each attempt's UUID body. Two reservations may be
      // pending together without violating the frozen UNIQUE claim column.
      const parallelBegun = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: parallelInvitation.login_grant,
      });
      provider.setAttempt(parallelBegun);
      await expect(
        sessions.completeOidcLogin({
          state: parallelBegun.state,
          authorization_code: "parallel-wrong-email-code",
        }),
      ).rejects.toBeInstanceOf(PersonOidcRetryableError);
      const reservationClaims = database
        .prepare(
          "SELECT redemption_claim_id FROM authority_oidc_login_attempts WHERE terminal_outcome IS NULL ORDER BY login_attempt_id",
        )
        .pluck()
        .all() as string[];
      expect(reservationClaims).toHaveLength(2);
      expect(
        reservationClaims.every((claim) =>
          isOidcRedemptionClaimInNamespace(claim, "reservation"),
        ),
      ).toBe(true);
      expect(new Set(reservationClaims).size).toBe(2);

      const parallelProviderRetry = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: parallelInvitation.login_grant,
      });
      expect(parallelProviderRetry).toMatchObject({
        login_attempt_id: parallelBegun.login_attempt_id,
        state: parallelBegun.state,
        nonce: parallelBegun.nonce,
      });
      provider.setAttempt(parallelProviderRetry);
      // A provider failure known before code redemption must restore the same
      // reservation, not silently buy another wrong-account attempt.
      provider.setRetryableBeforeRedemption(true);
      await expect(
        sessions.completeOidcLogin({
          state: parallelProviderRetry.state,
          authorization_code: "provider-retry-before-redemption",
        }),
      ).rejects.toBeInstanceOf(PersonOidcRetryableError);
      const parallelReservationAfterProviderRetry = database
        .prepare(
          "SELECT redemption_claim_id FROM authority_oidc_login_attempts WHERE login_attempt_id = ?",
        )
        .pluck()
        .get(parallelBegun.login_attempt_id) as string;
      expect(
        isOidcRedemptionClaimInNamespace(
          parallelReservationAfterProviderRetry,
          "reservation",
        ),
      ).toBe(true);

      const parallelSecondWrongAccount = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: parallelInvitation.login_grant,
      });
      expect(parallelSecondWrongAccount).toMatchObject({
        login_attempt_id: parallelBegun.login_attempt_id,
        state: parallelBegun.state,
        nonce: parallelBegun.nonce,
      });
      provider.setAttempt(parallelSecondWrongAccount);
      provider.setRetryableBeforeRedemption(false);
      provider.setClaims({
        email: "someone-else@example.com",
        email_verified: true,
      });
      await expect(
        sessions.completeOidcLogin({
          state: parallelSecondWrongAccount.state,
          authorization_code: "second-wrong-email-after-provider-retry",
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(
        database
          .prepare(
            "SELECT terminal_outcome FROM authority_oidc_login_attempts WHERE login_attempt_id = ?",
          )
          .pluck()
          .get(parallelBegun.login_attempt_id),
      ).toBe("denied");
      expect(
        database
          .prepare(
            `SELECT grant_row.consumed_at IS NOT NULL
               FROM authority_oidc_login_attempts attempt
               JOIN authority_person_login_grants grant_row
                 ON grant_row.login_grant_sha256 = attempt.login_grant_sha256
              WHERE attempt.login_attempt_id = ?`,
          )
          .pluck()
          .get(parallelBegun.login_attempt_id),
      ).toBe(1);

      provider.setAttempt(restarted);
      provider.setClaims({
        email: "founder@example.com",
        email_verified: true,
      });
      await expect(
        sessions.completeOidcLogin({
          state: restarted.state,
          authorization_code: "correct-email-code",
        }),
      ).resolves.toMatchObject({
        membership_id: initialized.owner_membership_id,
      });
      expect(
        database
          .prepare(
            "SELECT count(*) FROM authority_person_login_grants WHERE consumed_at IS NOT NULL",
          )
          .pluck()
          .get(),
      ).toBe(2);
      expect(
        database
          .prepare("SELECT count(*) FROM authority_person_session_families")
          .pluck()
          .get(),
      ).toBe(1);

      // A malformed or unverified bootstrap identity is not a wrong-account
      // retry: it remains terminal and spends this distinct invitation.
      const invalidInvitationPath = join(
        invitationDirectory,
        "invalid-email.invitation.json",
      );
      issuePersonOnboardingInvitation({
        state_directory: initialized.state_directory,
        oidc,
        pkce_sealing_key: pkce,
        membership_id: initialized.owner_membership_id,
        expected_email: "founder@example.com",
        authority_url: "https://authority.example",
        output_path: invalidInvitationPath,
      });
      const invalidInvitation = JSON.parse(
        readFileSync(invalidInvitationPath, "utf8"),
      ) as { login_grant: string };
      provider.setClaims({
        email: "founder@example.com",
        email_verified: false,
      });
      const invalid = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invalidInvitation.login_grant,
      });
      provider.setAttempt(invalid);
      await expect(
        sessions.completeOidcLogin({
          state: invalid.state,
          authorization_code: "unverified-email-code",
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(
        database
          .prepare(
            "SELECT count(*) FROM authority_person_login_grants WHERE consumed_at IS NOT NULL",
          )
          .pluck()
          .get(),
      ).toBe(3);

      // A second verified wrong account is terminal. The reservation is
      // durable across the restart, while the grant and attempt remain one-use.
      const cappedInvitationPath = join(
        invitationDirectory,
        "capped-retry.invitation.json",
      );
      issuePersonOnboardingInvitation({
        state_directory: initialized.state_directory,
        oidc,
        pkce_sealing_key: pkce,
        membership_id: initialized.owner_membership_id,
        expected_email: "founder@example.com",
        authority_url: "https://authority.example",
        output_path: cappedInvitationPath,
      });
      const cappedInvitation = JSON.parse(
        readFileSync(cappedInvitationPath, "utf8"),
      ) as { login_grant: string };
      provider.setClaims({
        email: "someone-else@example.com",
        email_verified: true,
      });
      const cappedFirst = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: cappedInvitation.login_grant,
      });
      provider.setAttempt(cappedFirst);
      await expect(
        sessions.completeOidcLogin({
          state: cappedFirst.state,
          authorization_code: "first-capped-wrong-email-code",
        }),
      ).rejects.toBeInstanceOf(PersonOidcRetryableError);
      const cappedSecond = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: cappedInvitation.login_grant,
      });
      provider.setAttempt(cappedSecond);
      await expect(
        sessions.completeOidcLogin({
          state: cappedSecond.state,
          authorization_code: "second-capped-wrong-email-code",
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(
        database
          .prepare(
            "SELECT count(*) FROM authority_person_login_grants WHERE consumed_at IS NOT NULL",
          )
          .pluck()
          .get(),
      ).toBe(4);
      expect(
        database
          .prepare(
            "SELECT terminal_outcome FROM authority_oidc_login_attempts ORDER BY rowid DESC LIMIT 1",
          )
          .pluck()
          .get(),
      ).toBe("denied");

      // A replayed or otherwise terminally redeemed code after the first
      // mismatch spends the invitation; it cannot clear the reservation and
      // turn the next browser return into another wrong-account retry.
      const replayedInvitationPath = join(
        invitationDirectory,
        "replayed-code.invitation.json",
      );
      issuePersonOnboardingInvitation({
        state_directory: initialized.state_directory,
        oidc,
        pkce_sealing_key: pkce,
        membership_id: initialized.owner_membership_id,
        expected_email: "founder@example.com",
        authority_url: "https://authority.example",
        output_path: replayedInvitationPath,
      });
      const replayedInvitation = JSON.parse(
        readFileSync(replayedInvitationPath, "utf8"),
      ) as { login_grant: string };
      const replayedFirst = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: replayedInvitation.login_grant,
      });
      provider.setAttempt(replayedFirst);
      await expect(
        sessions.completeOidcLogin({
          state: replayedFirst.state,
          authorization_code: "replayed-code-first-wrong-account",
        }),
      ).rejects.toBeInstanceOf(PersonOidcRetryableError);
      const replayedRetry = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: replayedInvitation.login_grant,
      });
      provider.setAttempt(replayedRetry);
      provider.setTerminalRedemptionFailure(true);
      await expect(
        sessions.completeOidcLogin({
          state: replayedRetry.state,
          authorization_code: "replayed-provider-code",
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      provider.setTerminalRedemptionFailure(false);
      expect(
        database
          .prepare(
            "SELECT count(*) FROM authority_person_login_grants WHERE consumed_at IS NOT NULL",
          )
          .pluck()
          .get(),
      ).toBe(5);
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
          .prepare(
            "SELECT invalidated_at IS NOT NULL FROM authority_person_login_grants",
          )
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

  it("runs fresh genesis through initial-owner grant, OIDC bootstrap, refresh, and logout without legacy state", async () => {
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
      ).toThrow("Person session runtime");
      expect(() =>
        cleanOnlySessions.withAuthenticatedWrite({
          access_token: "unreachable",
          commit: () => undefined,
        }),
      ).toThrow("Person session runtime");
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
        external_identity_runtime_bundle:
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
      expect(callbackPage).toContain(
        `action="http://127.0.0.1:39999/${"P".repeat(43)}"`,
      );
      expect(callbackPage).toContain(
        'name="token" value="' + "T".repeat(43) + '"',
      );
      expect(callbackPage).not.toContain("access_token");
      expect(callbackPage).not.toContain("refresh_token");
      const encoded = /name="session" value="([A-Za-z0-9_-]+)"/.exec(
        callbackPage,
      )?.[1];
      expect(encoded).toBeDefined();
      const session = JSON.parse(
        Buffer.from(encoded!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      expect(session.membership_id).toBe(initialized.owner_membership_id);
      expect(session.display_name).toBe("Founder");

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
      expect(expiredDelivery.headers.get("content-type")).toContain(
        "text/html",
      );
      const expiredPage = await expiredDelivery.text();
      expect(expiredPage).toContain("Sign-in expired");
      expect(expiredPage).toContain(
        "rerun the exact command that started sign-in",
      );
      expect(expiredPage).not.toContain("echo-brain person login");
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
      const unauthenticatedSearch = await fetch(`${origin}/v1/person/records`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "pricing" }),
      });
      expect(unauthenticatedSearch.status).toBe(401);

      const refreshed = await fetch(`${origin}/v2/session/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      expect(refreshed.status).toBe(200);
      const rotated = await json(refreshed);
      expect(rotated.refresh_token).not.toBe(session.refresh_token);
      expect(rotated.display_name).toBe("Founder");

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
