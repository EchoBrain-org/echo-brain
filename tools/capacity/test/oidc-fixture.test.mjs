import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSyntheticOidcFixture, createTrustedOidcFetch } from "../oidc-fixture.mjs";
import { PersonIdentitySessionApplication } from "../../../services/organization-authority/dist/application/person-identity-sessions.js";
import { openAuthorityDatabase } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/open-authority-database.js";
import { SqlitePersonSessionRepository } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/sqlite-person-session-repository.js";
import { NodePersonSessionCrypto } from "../../../services/organization-authority/dist/adapters/security/node-person-session-crypto.js";
import { bootstrapOrganizationAuthorityState } from "../../../services/organization-authority/dist/composition/organization-authority-state-bootstrap.js";

function temporaryTls() {
  const directory = mkdtempSync(join(tmpdir(), "echo-capacity-oidc-"));
  const key = join(directory, "localhost-key.pem");
  const cert = join(directory, "localhost-cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  return { directory, key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

function challenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sessionApplication({ issuer, provider }) {
  const directory = mkdtempSync(join(tmpdir(), "echo-capacity-oidc-authority-"));
  chmodSync(directory, 0o700);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(directory, "state"),
    organization_display_name: "Capacity Fixture Organization",
    owner_display_name: "Fixture Owner",
    created_at: new Date(Date.now() - 1_000).toISOString(),
    creating_artifact_revision: "capacity-oidc-fixture",
  });
  const database = openAuthorityDatabase(join(initialized.state_directory, "authority.sqlite"), { fileMustExist: true });
  const crypto = new NodePersonSessionCrypto(randomBytes(32));
  const configuration = {
    issuer,
    client_id: "fixture-client",
    redirect_uri: "https://authority.example.test/callback",
    tenant: { kind: "claim", claim_name: "tenant_id", claim_value: "fixture-tenant" },
    id_token_algorithms: ["RS256"],
  };
  const diagnostics = [];
  const application = new PersonIdentitySessionApplication(
    new SqlitePersonSessionRepository(database),
    configuration,
    {
      clock: { now: () => new Date().toISOString() },
      random: crypto,
      hash: crypto,
      pkce_sealer: crypto,
      oidc_provider: provider,
      diagnostics: { oidcLoginDenied(reason) { diagnostics.push(reason); } },
    },
  );
  return {
    application,
    configuration,
    diagnostics,
    begin() {
      const grant = application.issueBootstrapLoginGrant({
        target_membership_id: initialized.owner_membership_id,
        expected_issuer: issuer,
        expected_email: "person@example.test",
      });
      return application.beginOidcLogin({ kind: "identity_bootstrap", login_grant: grant.login_grant });
    },
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function withIssuer(callback) {
  const tls = temporaryTls();
  const fixture = createSyntheticOidcFixture({
    tls: { key: tls.key, cert: tls.cert },
    client_id: "fixture-client",
    client_secret: "fixture-client-secret",
  });
  const issuer = await fixture.listen();
  try {
    await callback({ fixture, issuer, fetch: createTrustedOidcFetch({ ca: tls.cert }) });
  } finally {
    await fixture.close();
    rmSync(tls.directory, { recursive: true, force: true });
  }
}

test("serves discovery, an authorization redirect, token, JWKS and userinfo over verified TLS", async () => {
  await withIssuer(async ({ fixture, issuer, fetch }) => {
    const discovery = await fetch(`${issuer}.well-known/openid-configuration`);
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).issuer, issuer);

    const authorize = new URL(`${issuer}authorize`);
    authorize.search = new URLSearchParams({
      client_id: "fixture-client",
      redirect_uri: "https://authority.example.test/callback",
      response_type: "code",
      scope: "openid email",
      state: "state-123456789012",
      nonce: "nonce-123456789012",
      code_challenge: challenge("A".repeat(43)),
      code_challenge_method: "S256",
    }).toString();
    const authorization = await fetch(authorize, { redirect: "manual" });
    assert.equal(authorization.status, 302);
    const callback = new URL(authorization.headers.get("location"));
    assert.equal(callback.searchParams.get("state"), "state-123456789012");
    assert.equal(callback.searchParams.get("iss"), issuer);

    const token = await fetch(`${issuer}token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("fixture%2Dclient:fixture%2Dclient%2Dsecret").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code"),
        redirect_uri: "https://authority.example.test/callback",
        code_verifier: "A".repeat(43),
      }).toString(),
    });
    assert.equal(token.status, 200);
    const tokens = await token.json();
    const userinfo = await fetch(`${issuer}userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(userinfo.status, 200);
    assert.equal((await userinfo.json()).sub, "fixture-subject");
    assert.equal(JSON.stringify(fixture.ledger()).includes(tokens.access_token), false);
  });
});

test("the real production OIDC adapter redeems a signed PKCE code over verified TLS", async () => {
  const adapterPath = new URL("../../../services/organization-authority/dist/adapters/oidc/openid-client-person-session-provider.js", import.meta.url);
  const { OpenIdClientPersonSessionProvider } = await import(adapterPath);
  await withIssuer(async ({ fixture, issuer, fetch }) => {
    const configuration = {
      issuer,
      client_id: "fixture-client",
      redirect_uri: "https://authority.example.test/callback",
      tenant: { kind: "claim", claim_name: "tenant_id", claim_value: "fixture-tenant" },
      id_token_algorithms: ["RS256"],
    };
    const provider = await OpenIdClientPersonSessionProvider.discover({
      configuration,
      client_authentication: { method: "client_secret_basic", client_secret: "fixture-client-secret" },
      fetch,
    });
    const verifier = "B".repeat(43);
    const frozen = { ...configuration, tenant_constraint_sha256: "sha256:" + "0".repeat(64), oidc_configuration_sha256: "sha256:" + "1".repeat(64) };
    const validCode = fixture.issue_authorization_code({
      nonce: "nonce-123456789012",
      code_challenge: challenge(verifier),
      state: "state-123456789012",
      redirect_uri: configuration.redirect_uri,
    });
    const valid = await provider.redeemAuthorizationCode({
      configuration: frozen,
      authorization_code: validCode,
      pkce_verifier: verifier,
    });
    assert.equal(valid.kind, "verified");
    const expiredCode = fixture.issue_authorization_code({
      nonce: "nonce-123456789012",
      code_challenge: challenge(verifier),
      state: "state-123456789012",
      redirect_uri: configuration.redirect_uri,
      // This exceeds oauth4webapi's permitted clock tolerance.
      expires_at: Math.floor(Date.now() / 1000) - 3_600,
    });
    const expired = await provider.redeemAuthorizationCode({
      configuration: frozen,
      authorization_code: expiredCode,
      pkce_verifier: verifier,
    });
    assert.equal(expired.kind, "terminal_failure");
  });
});

test("the Authority session application rejects signed issuer, audience, and nonce mismatches", async () => {
  const adapterPath = new URL("../../../services/organization-authority/dist/adapters/oidc/openid-client-person-session-provider.js", import.meta.url);
  const { OpenIdClientPersonSessionProvider } = await import(adapterPath);
  await withIssuer(async ({ fixture, issuer, fetch }) => {
    const configuration = {
      issuer,
      client_id: "fixture-client",
      redirect_uri: "https://authority.example.test/callback",
      tenant: { kind: "claim", claim_name: "tenant_id", claim_value: "fixture-tenant" },
      id_token_algorithms: ["RS256"],
    };
    const provider = await OpenIdClientPersonSessionProvider.discover({
      configuration,
      client_authentication: { method: "client_secret_basic", client_secret: "fixture-client-secret" },
      fetch,
    });
    const sessions = sessionApplication({ issuer, provider });
    try {
      for (const [overrides, diagnostic] of [
        [{ issuer: "https://wrong.example.test/" }, "provider_verification_failed"],
        [{ audience: "wrong-client" }, "provider_verification_failed"],
        [{ nonce: "wrong-nonce-123456" }, "claim_nonce_mismatch"],
      ]) {
        const begun = sessions.begin();
        const code = fixture.issue_authorization_code({
          nonce: begun.nonce,
          code_challenge: begun.code_challenge,
          state: begun.state,
          redirect_uri: configuration.redirect_uri,
          ...overrides,
        });
        await assert.rejects(
          () => sessions.application.completeOidcLogin({ state: begun.state, authorization_code: code }),
          (error) => error?.code === "unauthorized",
        );
        assert.equal(sessions.diagnostics.at(-1), diagnostic);
      }
      const stateAttempt = sessions.begin();
      const stateCode = fixture.issue_authorization_code({
        nonce: stateAttempt.nonce,
        code_challenge: stateAttempt.code_challenge,
        state: stateAttempt.state,
        redirect_uri: configuration.redirect_uri,
      });
      const tokenEffectsBeforeWrongState = fixture.ledger().filter((event) => event.operation === "token").length;
      await assert.rejects(
        () => sessions.application.completeOidcLogin({ state: "wrong-state-123456", authorization_code: stateCode }),
        (error) => error?.code === "unauthorized",
      );
      assert.equal(sessions.diagnostics.at(-1), "attempt_unavailable");
      assert.equal(fixture.ledger().filter((event) => event.operation === "token").length, tokenEffectsBeforeWrongState);
    } finally {
      sessions.close();
    }
  });
});
