import { Buffer } from "node:buffer";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  federationId,
  p256KeyId,
  sha256Digest,
} from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { organizationAuthorityPinSha256 } from "@echo-brain/organization-protocol";
import type { OrganizationAuthorityDescriptorV1 } from "@echo-brain/organization-protocol";
import { SqliteOrganizationAuthorityRepository } from "../src/adapters/persistence/sqlite/sqlite-authority-repository.js";
import {
  PersonIdentitySessionApplication,
  type BegunPersonOidcLogin,
  type IssuedPersonSession,
} from "../src/application/person-identity-sessions.js";
import type {
  AuthorityWriteTransaction,
  StoredAuthorityMembership,
} from "../src/application/ports/authority-repository.js";
import type {
  FrozenPersonSessionOidcConfiguration,
  OidcAuthorizationCodeResult,
  PersonSessionHashPort,
  PersonSessionOidcProvider,
  PersonSessionPkceSealer,
  PersonSessionRandomPurpose,
  PersonSessionRandomSource,
  PersonSessionRuntime,
  VerifiedOidcIdentityToken,
} from "../src/application/ports/person-session-runtime.js";
import type { AuthorityClock } from "../src/application/ports/runtime-ports.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class MutableClock implements AuthorityClock {
  constructor(public current: string) {}

  now(): string {
    return this.current;
  }
}

class DeterministicRandom implements PersonSessionRandomSource {
  private counter = 0;

  bytes(purpose: PersonSessionRandomPurpose, length: number): Uint8Array {
    this.counter += 1;
    return createHash("sha512")
      .update(`${this.counter}:${purpose}`, "utf8")
      .digest()
      .subarray(0, length);
  }
}

class NodeHashPort implements PersonSessionHashPort {
  sha256(value: Uint8Array): Uint8Array {
    return createHash("sha256").update(value).digest();
  }
}

class TestPkceSealer implements PersonSessionPkceSealer {
  private readonly key = createHash("sha256")
    .update("test-only-pkce-sealing-key", "utf8")
    .digest();

  seal(input: { plaintext: Uint8Array; authenticated_data: Uint8Array }): {
    key_id: string;
    sealed_bytes: Uint8Array;
  } {
    const stream = createHash("sha512")
      .update(this.key)
      .update(input.authenticated_data)
      .digest();
    const ciphertext = Buffer.from(input.plaintext).map(
      (byte, index) => byte ^ (stream[index % stream.length] ?? 0),
    );
    const tag = createHash("sha256")
      .update(this.key)
      .update(input.authenticated_data)
      .update(input.plaintext)
      .digest();
    return {
      key_id: "test-pkce-seal-key-v1",
      sealed_bytes: Buffer.concat([tag, ciphertext]),
    };
  }

  unseal(input: {
    key_id: string;
    sealed_bytes: Uint8Array;
    authenticated_data: Uint8Array;
  }): Uint8Array {
    if (input.key_id !== "test-pkce-seal-key-v1") {
      throw new Error("wrong test sealing key");
    }
    const bytes = Buffer.from(input.sealed_bytes);
    const tag = bytes.subarray(0, 32);
    const ciphertext = bytes.subarray(32);
    const stream = createHash("sha512")
      .update(this.key)
      .update(input.authenticated_data)
      .digest();
    const plaintext = ciphertext.map(
      (byte, index) => byte ^ (stream[index % stream.length] ?? 0),
    );
    const expectedTag = createHash("sha256")
      .update(this.key)
      .update(input.authenticated_data)
      .update(plaintext)
      .digest();
    if (
      tag.length !== expectedTag.length ||
      !timingSafeEqual(tag, expectedTag)
    ) {
      throw new Error("test sealed value failed authentication");
    }
    return plaintext;
  }
}

class FakeOidcProvider implements PersonSessionOidcProvider {
  result: OidcAuthorizationCodeResult = {
    kind: "retryable_before_redemption",
  };
  handler:
    | ((input: {
        configuration: FrozenPersonSessionOidcConfiguration;
        authorization_code: string;
        pkce_verifier: string;
      }) => Promise<OidcAuthorizationCodeResult>)
    | undefined;
  readonly calls: Array<{
    configuration: FrozenPersonSessionOidcConfiguration;
    authorization_code: string;
    pkce_verifier: string;
  }> = [];

  async redeemAuthorizationCode(input: {
    configuration: FrozenPersonSessionOidcConfiguration;
    authorization_code: string;
    pkce_verifier: string;
  }): Promise<OidcAuthorizationCodeResult> {
    this.calls.push(input);
    return this.handler === undefined ? this.result : this.handler(input);
  }
}

interface Fixture {
  path: string;
  authority: OrganizationAuthorityDescriptorV1;
  clock: MutableClock;
  provider: FakeOidcProvider;
  runtime: PersonSessionRuntime;
  repository: SqliteOrganizationAuthorityRepository;
  membership: StoredAuthorityMembership;
  application: PersonIdentitySessionApplication;
}

const OIDC_CONFIGURATION = {
  issuer: "https://identity.example.test/",
  client_id: "echo-person-browser",
  redirect_uri: "https://authority.example.test/v2/session/oidc/callback",
  tenant: {
    kind: "claim" as const,
    claim_name: "tenant_id",
    claim_value: "echo-example-company",
  },
  id_token_algorithms: ["ES256"] as const,
};

function descriptor(): OrganizationAuthorityDescriptorV1 {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(publicKey)) throw new Error("test key export failed");
  return {
    schema_version: 1,
    kind: "echo-organization-authority",
    authority_id: federationId("oau"),
    organization_id: federationId("org"),
    signing_key: {
      key_id: p256KeyId(publicKey),
      algorithm: "ecdsa-p256-sha256-der-low-s",
      public_key_spki_der_base64: publicKey.toString("base64"),
    },
  };
}

function setup(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "echo-person-session-app-"));
  directories.push(directory);
  const path = join(directory, "authority.sqlite");
  const authority = descriptor();
  const repository = new SqliteOrganizationAuthorityRepository(path);
  repository.initialize({
    descriptor: authority,
    authority_pin_sha256: organizationAuthorityPinSha256(authority),
    organization_display_name: "Example Company",
    initialized_at: "2026-08-18T00:00:00.000Z",
  });
  const membership: StoredAuthorityMembership = {
    organization_id: authority.organization_id,
    principal_id: federationId("prn"),
    membership_id: federationId("mem"),
    display_name: "Session Owner",
    membership_type: "owner",
    status: "active",
    provisioned_at: "2026-08-18T00:00:01.000Z",
    revoked_at: null,
    revocation_reason: null,
    admin_command_id: `adm_${randomUUID()}`,
    admin_command_sha256: sha256Digest(
      Buffer.from("person session test membership", "utf8"),
    ),
  };
  repository.write(membership.provisioned_at, (transaction) => {
    transaction.insertMembership(membership);
  });
  const clock = new MutableClock("2026-08-18T00:00:02.000Z");
  const provider = new FakeOidcProvider();
  const runtime: PersonSessionRuntime = {
    clock,
    random: new DeterministicRandom(),
    hash: new NodeHashPort(),
    pkce_sealer: new TestPkceSealer(),
    oidc_provider: provider,
  };
  return {
    path,
    authority,
    clock,
    provider,
    runtime,
    repository,
    membership,
    application: new PersonIdentitySessionApplication(
      repository,
      OIDC_CONFIGURATION,
      runtime,
    ),
  };
}

function verifiedResult(
  begun: BegunPersonOidcLogin,
  subject = "opaque-provider-subject-001",
  overrides: Partial<VerifiedOidcIdentityToken> = {},
): OidcAuthorizationCodeResult {
  return {
    kind: "verified",
    token: {
      issuer: OIDC_CONFIGURATION.issuer,
      subject,
      audience: OIDC_CONFIGURATION.client_id,
      nonce: begun.nonce,
      auth_time: Date.parse(begun.created_at) / 1000,
      claims: { tenant_id: OIDC_CONFIGURATION.tenant.claim_value },
      ...overrides,
    },
  };
}

async function bootstrapSession(
  fixture: Fixture,
  subject = "opaque-provider-subject-001",
): Promise<{
  begun: BegunPersonOidcLogin;
  session: IssuedPersonSession;
  loginGrant: string;
  loginGrantExpiresAt: string;
}> {
  const issued = fixture.application.issueBootstrapLoginGrant({
    target_membership_id: fixture.membership.membership_id,
    expected_issuer: OIDC_CONFIGURATION.issuer,
  });
  const begun = fixture.application.beginOidcLogin({
    kind: "identity_bootstrap",
    login_grant: issued.login_grant,
  });
  fixture.provider.result = verifiedResult(begun, subject);
  const session = await fixture.application.completeOidcLogin({
    state: begun.state,
    authorization_code: "one-use-upstream-authorization-code",
  });
  return {
    begun,
    session,
    loginGrant: issued.login_grant,
    loginGrantExpiresAt: issued.expires_at,
  };
}

function digestSecret(value: string): Sha256Digest {
  return sha256Digest(Buffer.from(value, "utf8"));
}

function personSessionRowCounts(path: string): {
  families: number;
  credentials: number;
} {
  const database = new Database(path, { readonly: true });
  try {
    const row = database
      .prepare(
        `SELECT
           (SELECT count(*) FROM authority_person_session_families) AS families,
           (SELECT count(*) FROM authority_person_session_credentials)
             AS credentials`,
      )
      .get() as { families: number; credentials: number };
    return row;
  } finally {
    database.close();
  }
}

function expectOpaqueDenial(operation: () => unknown): void {
  expect(operation).toThrowError(
    expect.objectContaining({
      code: "unauthorized",
      message: "person authentication failed",
    }),
  );
}

function rejectUnexpectedStartDeny(): never {
  throw new Error("Person read start was unexpectedly denied");
}

describe("PersonIdentitySessionApplication", () => {
  it("boots an exact Person session, persists only digests/sealed PKCE, and authenticates after restart", async () => {
    const fixture = setup();
    const { begun, session, loginGrant, loginGrantExpiresAt } =
      await bootstrapSession(fixture);

    expect(begun).toMatchObject({
      issuer: OIDC_CONFIGURATION.issuer,
      client_id: OIDC_CONFIGURATION.client_id,
      redirect_uri: OIDC_CONFIGURATION.redirect_uri,
      code_challenge_method: "S256",
      response_type: "code",
      scope: "openid",
      max_age: 0,
      created_at: "2026-08-18T00:00:02.000Z",
      expires_at: "2026-08-18T00:10:02.000Z",
    });
    expect(fixture.provider.calls).toHaveLength(1);
    expect(loginGrantExpiresAt).toBe("2026-08-18T00:15:02.000Z");
    expect(session).toMatchObject({
      access_expires_at: "2026-08-18T12:00:02.000Z",
      refresh_expires_at: "2026-08-25T00:00:02.000Z",
      hard_reauthentication_at: "2026-08-25T00:00:02.000Z",
    });
    expect(fixture.provider.calls[0]?.pkce_verifier).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(
      fixture.application.authenticateAccess({
        access_token: session.access_token,
      }),
    ).toMatchObject({
      principal_id: fixture.membership.principal_id,
      membership_id: fixture.membership.membership_id,
      session_family_id: session.session_family_id,
      checked_at: fixture.clock.current,
    });

    const attempt = fixture.repository.read((transaction) =>
      transaction.oidcLoginAttempt(digestSecret(begun.state)),
    );
    expect(attempt).toMatchObject({
      terminal_outcome: "succeeded",
      completed_at: fixture.clock.current,
      resolved_identity_binding_id: session.identity_binding_id,
      upstream_auth_time: begun.created_at,
      pkce_verifier_seal_key_id: null,
      pkce_verifier_sealed: null,
    });
    const existingLogin = fixture.application.beginOidcLogin({
      kind: "existing_identity_login",
    });
    fixture.provider.result = verifiedResult(
      existingLogin,
      "opaque-provider-subject-001",
    );
    const reauthenticated = await fixture.application.completeOidcLogin({
      state: existingLogin.state,
      authorization_code: "grantless-existing-identity-code",
    });
    expect(reauthenticated).toMatchObject({
      identity_binding_id: session.identity_binding_id,
      principal_id: fixture.membership.principal_id,
      membership_id: fixture.membership.membership_id,
    });
    expect(reauthenticated.session_family_id).not.toBe(
      session.session_family_id,
    );
    fixture.repository.close();

    const databaseBytes = readFileSync(fixture.path);
    for (const raw of [
      loginGrant,
      begun.state,
      begun.nonce,
      fixture.provider.calls[0]?.pkce_verifier ?? "",
      session.access_token,
      session.refresh_token,
      existingLogin.state,
      existingLogin.nonce,
      fixture.provider.calls[1]?.pkce_verifier ?? "",
      reauthenticated.access_token,
      reauthenticated.refresh_token,
      "one-use-upstream-authorization-code",
      "grantless-existing-identity-code",
    ]) {
      expect(databaseBytes.includes(Buffer.from(raw, "utf8"))).toBe(false);
    }

    const reopened = new SqliteOrganizationAuthorityRepository(fixture.path, {
      fileMustExist: true,
      allowInitialization: false,
    });
    reopened.initialize({
      descriptor: fixture.authority,
      authority_pin_sha256: organizationAuthorityPinSha256(fixture.authority),
      organization_display_name: "Example Company",
      initialized_at: fixture.clock.current,
    });
    const restarted = new PersonIdentitySessionApplication(
      reopened,
      OIDC_CONFIGURATION,
      fixture.runtime,
    );
    expect(
      restarted.authenticateAccess({
        access_token: reauthenticated.access_token,
      }),
    ).toMatchObject({
      principal_id: fixture.membership.principal_id,
      session_family_id: reauthenticated.session_family_id,
    });
    reopened.close();
  });

  it("releases only an explicit pre-redemption retry, then succeeds and scrubs terminal attempts", async () => {
    const fixture = setup();
    const grant = fixture.application.issueBootstrapLoginGrant({
      target_membership_id: fixture.membership.membership_id,
      expected_issuer: OIDC_CONFIGURATION.issuer,
    });
    const begun = fixture.application.beginOidcLogin({
      kind: "identity_bootstrap",
      login_grant: grant.login_grant,
    });
    fixture.provider.result = { kind: "retryable_before_redemption" };
    await expect(
      fixture.application.completeOidcLogin({
        state: begun.state,
        authorization_code: "retryable-code",
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
      message: "person authentication failed",
    });
    expect(
      fixture.repository.read((transaction) =>
        transaction.oidcLoginAttempt(digestSecret(begun.state)),
      ),
    ).toMatchObject({
      terminal_outcome: null,
      completed_at: null,
      redemption_claim_id: null,
      redemption_claimed_at: null,
      pkce_verifier_seal_key_id: "test-pkce-seal-key-v1",
    });

    fixture.provider.result = verifiedResult(begun);
    const session = await fixture.application.completeOidcLogin({
      state: begun.state,
      authorization_code: "verified-after-explicit-retry-code",
    });
    expect(
      fixture.application.authenticateAccess({
        access_token: session.access_token,
      }),
    ).toMatchObject({ principal_id: fixture.membership.principal_id });

    const terminal = fixture.application.beginOidcLogin({
      kind: "existing_identity_login",
    });
    fixture.provider.result = { kind: "terminal_failure" };
    await expect(
      fixture.application.completeOidcLogin({
        state: terminal.state,
        authorization_code: "terminal-code",
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
      message: "person authentication failed",
    });
    expect(
      fixture.repository.read((transaction) =>
        transaction.oidcLoginAttempt(digestSecret(terminal.state)),
      ),
    ).toMatchObject({
      terminal_outcome: "denied",
      completed_at: fixture.clock.current,
      resolved_identity_binding_id: null,
      upstream_auth_time: null,
      pkce_verifier_seal_key_id: null,
      pkce_verifier_sealed: null,
    });
    const expiringGrant = fixture.application.issueBootstrapLoginGrant({
      target_membership_id: fixture.membership.membership_id,
      expected_issuer: OIDC_CONFIGURATION.issuer,
    });
    const expiring = fixture.application.beginOidcLogin({
      kind: "identity_bootstrap",
      login_grant: expiringGrant.login_grant,
    });
    fixture.clock.current = expiring.expires_at;
    expect(fixture.application.expireOidcLoginAttempts({ limit: 10 })).toBe(1);
    expect(
      fixture.repository.read((transaction) => ({
        attempt: transaction.oidcLoginAttempt(digestSecret(expiring.state)),
        grant: transaction.personLoginGrant(
          digestSecret(expiringGrant.login_grant),
        ),
      })),
    ).toMatchObject({
      attempt: {
        terminal_outcome: "expired",
        completed_at: expiring.expires_at,
        pkce_verifier_seal_key_id: null,
        pkce_verifier_sealed: null,
      },
      grant: { consumed_at: expiring.expires_at },
    });
    const shortWindowGrant = fixture.application.issueBootstrapLoginGrant({
      target_membership_id: fixture.membership.membership_id,
      expected_issuer: OIDC_CONFIGURATION.issuer,
    });
    fixture.clock.current = shortWindowGrant.expires_at;
    expectOpaqueDenial(() =>
      fixture.application.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: shortWindowGrant.login_grant,
      }),
    );
    fixture.repository.close();
  });

  it("terminalizes a thrown provider call, burns its bootstrap grant, and rejects duplicate begin opaquely", async () => {
    const fixture = setup();
    const grant = fixture.application.issueBootstrapLoginGrant({
      target_membership_id: fixture.membership.membership_id,
      expected_issuer: OIDC_CONFIGURATION.issuer,
    });
    const begun = fixture.application.beginOidcLogin({
      kind: "identity_bootstrap",
      login_grant: grant.login_grant,
    });
    expectOpaqueDenial(() =>
      fixture.application.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: grant.login_grant,
      }),
    );
    fixture.provider.handler = async () => {
      throw new Error("ambiguous provider transport failure");
    };
    await expect(
      fixture.application.completeOidcLogin({
        state: begun.state,
        authorization_code: "possibly-redeemed-code",
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
      message: "person authentication failed",
    });
    expect(
      fixture.repository.read((transaction) => ({
        attempt: transaction.oidcLoginAttempt(digestSecret(begun.state)),
        grant: transaction.personLoginGrant(digestSecret(grant.login_grant)),
      })),
    ).toMatchObject({
      attempt: {
        terminal_outcome: "denied",
        redemption_claim_id: null,
        pkce_verifier_seal_key_id: null,
        pkce_verifier_sealed: null,
      },
      grant: { consumed_at: fixture.clock.current },
    });
    expectOpaqueDenial(() =>
      fixture.application.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: grant.login_grant,
      }),
    );
    fixture.repository.close();
  });

  it("accepts a live grant at six minutes and an upstream authentication two minutes later", async () => {
    const fixture = setup();
    const grant = fixture.application.issueBootstrapLoginGrant({
      target_membership_id: fixture.membership.membership_id,
      expected_issuer: OIDC_CONFIGURATION.issuer,
    });
    fixture.clock.current = "2026-08-18T00:06:02.000Z";
    const begun = fixture.application.beginOidcLogin({
      kind: "identity_bootstrap",
      login_grant: grant.login_grant,
    });
    fixture.clock.current = "2026-08-18T00:08:02.000Z";
    fixture.provider.result = verifiedResult(begun, undefined, {
      auth_time: Date.parse(fixture.clock.current) / 1000,
    });
    const session = await fixture.application.completeOidcLogin({
      state: begun.state,
      authorization_code: "deliberate-authentication-code",
    });
    expect(begun).toMatchObject({
      created_at: "2026-08-18T00:06:02.000Z",
      expires_at: "2026-08-18T00:16:02.000Z",
    });
    expect(session).toMatchObject({
      hard_reauthentication_at: "2026-08-25T00:08:02.000Z",
      access_expires_at: "2026-08-18T12:08:02.000Z",
    });
    fixture.repository.close();
  });

  it("claims and terminalizes a stale-configuration attempt before code handling or provider access", async () => {
    const fixture = setup();
    const grant = fixture.application.issueBootstrapLoginGrant({
      target_membership_id: fixture.membership.membership_id,
      expected_issuer: OIDC_CONFIGURATION.issuer,
    });
    const begun = fixture.application.beginOidcLogin({
      kind: "identity_bootstrap",
      login_grant: grant.login_grant,
    });
    const rotated = new PersonIdentitySessionApplication(
      fixture.repository,
      { ...OIDC_CONFIGURATION, client_id: "echo-person-browser-rotated" },
      fixture.runtime,
    );
    await expect(
      rotated.completeOidcLogin({
        state: begun.state,
        authorization_code: "",
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
      message: "person authentication failed",
    });
    expect(fixture.provider.calls).toHaveLength(0);
    expect(
      fixture.repository.read((transaction) => ({
        attempt: transaction.oidcLoginAttempt(digestSecret(begun.state)),
        grant: transaction.personLoginGrant(digestSecret(grant.login_grant)),
      })),
    ).toMatchObject({
      attempt: {
        terminal_outcome: "denied",
        redemption_claim_id: null,
        pkce_verifier_seal_key_id: null,
      },
      grant: { consumed_at: fixture.clock.current },
    });
    fixture.repository.close();
  });

  it.each([
    {
      name: "issuer mismatch",
      override: () => ({ issuer: "https://wrong-issuer.example.test/" }),
    },
    { name: "empty subject", override: () => ({ subject: "" }) },
    {
      name: "missing audience",
      override: () => ({ audience: "another-client" }),
    },
    {
      name: "multiple audiences without azp",
      override: () => ({
        audience: [OIDC_CONFIGURATION.client_id, "another-client"],
      }),
    },
    {
      name: "wrong azp",
      override: () => ({ authorized_party: "another-client" }),
    },
    { name: "nonce mismatch", override: () => ({ nonce: "wrong-nonce" }) },
    {
      name: "tenant mismatch",
      override: () => ({ claims: { tenant_id: "wrong-tenant" } }),
    },
    {
      name: "auth_time before the lower skew boundary",
      override: (begun: BegunPersonOidcLogin) => ({
        auth_time: (Date.parse(begun.created_at) - 61_000) / 1000,
      }),
    },
    {
      name: "auth_time beyond the future skew boundary",
      override: (_begun: BegunPersonOidcLogin, fixture: Fixture) => ({
        auth_time: (Date.parse(fixture.clock.current) + 61_000) / 1000,
      }),
    },
  ])("terminalizes an invalid verified claim: $name", async ({ override }) => {
    const fixture = setup();
    await bootstrapSession(fixture, "opaque-provider-subject-001");
    const rowsBefore = personSessionRowCounts(fixture.path);
    const begun = fixture.application.beginOidcLogin({
      kind: "existing_identity_login",
    });
    fixture.provider.result = verifiedResult(
      begun,
      undefined,
      override(begun, fixture),
    );
    await expect(
      fixture.application.completeOidcLogin({
        state: begun.state,
        authorization_code: "invalid-claim-code",
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
      message: "person authentication failed",
    });
    expect(fixture.provider.calls).toHaveLength(2);
    expect(
      fixture.repository.read((transaction) =>
        transaction.oidcLoginAttempt(digestSecret(begun.state)),
      ),
    ).toMatchObject({
      terminal_outcome: "denied",
      redemption_claim_id: null,
      pkce_verifier_seal_key_id: null,
      pkce_verifier_sealed: null,
    });
    expect(personSessionRowCounts(fixture.path)).toEqual(rowsBefore);
    fixture.repository.close();
  });

  it("rotates both credentials and closes the whole family when a refresh is replayed", async () => {
    const fixture = setup();
    const { session: first } = await bootstrapSession(fixture);
    fixture.clock.current = "2026-08-18T01:00:00.000Z";
    const rotated = fixture.application.refresh({
      refresh_token: first.refresh_token,
    });
    expect(rotated).toMatchObject({
      access_expires_at: "2026-08-18T13:00:00.000Z",
      refresh_expires_at: first.hard_reauthentication_at,
      hard_reauthentication_at: first.hard_reauthentication_at,
    });

    expectOpaqueDenial(() =>
      fixture.application.authenticateAccess({
        access_token: first.access_token,
      }),
    );
    expect(
      fixture.application.authenticateAccess({
        access_token: rotated.access_token,
      }),
    ).toMatchObject({ session_family_id: first.session_family_id });
    expectOpaqueDenial(() =>
      fixture.application.refresh({ refresh_token: first.refresh_token }),
    );
    expectOpaqueDenial(() =>
      fixture.application.authenticateAccess({
        access_token: rotated.access_token,
      }),
    );
    const closed = fixture.repository.read((transaction) => ({
      family: transaction.personSessionFamily(first.session_family_id),
      credentials: transaction.personSessionCredentialsForFamily(
        first.session_family_id,
      ),
    }));
    expect(closed.family).toMatchObject({
      status: "revoked",
      revoked_at: fixture.clock.current,
      revocation_reason: "refresh_credential_replay",
    });
    expect(closed.credentials).toHaveLength(4);
    expect(
      closed.credentials.map(
        ({ credential_kind, rotation_sequence }) =>
          `${credential_kind}:${rotation_sequence}`,
      ),
    ).toEqual(["access:1", "refresh:1", "access:2", "refresh:2"]);
    expect(
      closed.credentials.every(({ revoked_at }) => revoked_at !== null),
    ).toBe(true);
    fixture.repository.close();
  });

  it("commits a closed deny under the final fence when Person state changes after admission", async () => {
    const fixture = setup();
    const { session } = await bootstrapSession(fixture);
    const port = fixture.application.createPersonReadAuthorizationPort();
    let sourceOpened = false;
    const startDenials: Array<{
      reason: string;
      authenticated: boolean;
    }> = [];
    const commitStartDeny: Parameters<
      typeof port.admitSelfRead
    >[0]["commitStartDeny"] = (decision, transaction) => {
      startDenials.push({
        reason: decision.reason_code,
        authenticated: decision.authorization !== null,
      });
      transaction.appendAudit({
        occurred_at: decision.checked_at,
        actor_kind: "admin",
        action: "test.person_read_start_denied",
        subject_id: fixture.membership.principal_id,
        detail: {
          reason_code: decision.reason_code,
          authenticated: decision.authorization !== null,
        },
      });
    };
    expectOpaqueDenial(() => {
      port.admitSelfRead({
        access_token: session.access_token,
        subject_principal_id: federationId("prn"),
        commitStartDeny,
      });
      sourceOpened = true;
    });
    expect(sourceOpened).toBe(false);
    expectOpaqueDenial(() => {
      port.admitSelfRead({
        access_token: "malformed-session-token",
        subject_principal_id: fixture.membership.principal_id,
        commitStartDeny,
      });
      sourceOpened = true;
    });
    expect(sourceOpened).toBe(false);
    expect(startDenials).toEqual([
      { reason: "caller_subject_mismatch", authenticated: true },
      { reason: "person_or_session_inactive", authenticated: false },
    ]);
    expect(
      fixture.repository.read((transaction) =>
        transaction
          .recentAuditBefore(undefined, 10)
          .filter(({ action }) => action === "test.person_read_start_denied"),
      ),
    ).toHaveLength(2);

    const admission = port.admitSelfRead({
      access_token: session.access_token,
      subject_principal_id: fixture.membership.principal_id,
      commitStartDeny: rejectUnexpectedStartDeny,
    });
    sourceOpened = true;
    const allowedDecisions: string[] = [];
    expect(
      port.finalizeSelfRead({
        admission,
        subject_principal_id: fixture.membership.principal_id,
        commit: (decision) => {
          allowedDecisions.push(decision.decision);
          return "committed-response";
        },
      }),
    ).toBe("committed-response");
    expect(allowedDecisions).toEqual(["allow"]);
    expect(() =>
      port.finalizeSelfRead({
        admission,
        subject_principal_id: fixture.membership.principal_id,
        commit: () => "must-not-commit-twice",
      }),
    ).toThrow("Person read admission is invalid or already finalized");
    const driftAdmission = port.admitSelfRead({
      access_token: session.access_token,
      subject_principal_id: fixture.membership.principal_id,
      commitStartDeny: rejectUnexpectedStartDeny,
    });
    fixture.clock.current = "2026-08-18T00:01:00.000Z";
    fixture.repository.write(fixture.clock.current, (transaction) => {
      expect(
        transaction.revokeMembership(
          fixture.membership.membership_id,
          fixture.clock.current,
          "test membership revocation",
        ),
      ).toBe(true);
    });
    fixture.clock.current = "2026-08-18T00:01:01.000Z";
    const decisions: string[] = [];
    expectOpaqueDenial(() =>
      port.finalizeSelfRead({
        admission: driftAdmission,
        subject_principal_id: fixture.membership.principal_id,
        commit: (decision) => {
          decisions.push(
            decision.decision === "allow"
              ? "allow"
              : `deny:${decision.reason_code}`,
          );
          return Buffer.from("must-not-be-released", "utf8");
        },
      }),
    );
    expect(sourceOpened).toBe(true);
    expect(decisions).toEqual(["deny:person_or_session_inactive"]);
    let inactiveSourceOpened = false;
    expectOpaqueDenial(() => {
      port.admitSelfRead({
        access_token: session.access_token,
        subject_principal_id: fixture.membership.principal_id,
        commitStartDeny,
      });
      inactiveSourceOpened = true;
    });
    expect(inactiveSourceOpened).toBe(false);
    expect(startDenials.at(-1)).toEqual({
      reason: "person_or_session_inactive",
      authenticated: false,
    });
    fixture.repository.close();
  });

  it("rolls back and rejects a PromiseLike final read commit before transaction commit", async () => {
    const fixture = setup();
    const { session } = await bootstrapSession(fixture);
    const port = fixture.application.createPersonReadAuthorizationPort();
    expect(() =>
      port.admitSelfRead({
        access_token: "malformed-session-token",
        subject_principal_id: fixture.membership.principal_id,
        commitStartDeny: async (decision, transaction) => {
          transaction.appendAudit({
            occurred_at: decision.checked_at,
            actor_kind: "admin",
            action: "test.promise_like_start_commit_must_rollback",
            subject_id: fixture.membership.principal_id,
            detail: { reason_code: decision.reason_code },
          });
        },
      }),
    ).toThrow("Person read audit commit must be synchronous");
    expect(
      fixture.repository.read((transaction) =>
        transaction
          .recentAuditBefore(undefined, 10)
          .some(
            ({ action }) =>
              action === "test.promise_like_start_commit_must_rollback",
          ),
      ),
    ).toBe(false);
    const admission = port.admitSelfRead({
      access_token: session.access_token,
      subject_principal_id: fixture.membership.principal_id,
      commitStartDeny: rejectUnexpectedStartDeny,
    });
    const asyncCommit = (
      decision: unknown,
      transaction: AuthorityWriteTransaction,
    ) => {
      transaction.appendAudit({
        occurred_at: fixture.clock.current,
        actor_kind: "admin",
        action: "test.promise_like_commit_must_rollback",
        subject_id: fixture.membership.principal_id,
        detail: { decision: typeof decision },
      });
      return Promise.resolve("must-not-escape-the-write-fence");
    };
    expect(() =>
      port.finalizeSelfRead({
        admission,
        subject_principal_id: fixture.membership.principal_id,
        commit: asyncCommit as unknown as (
          decision: Parameters<typeof asyncCommit>[0],
          transaction: Parameters<typeof asyncCommit>[1],
        ) => string,
      }),
    ).toThrow("Person read audit commit must be synchronous");
    expect(
      fixture.repository.read((transaction) =>
        transaction
          .recentAuditBefore(undefined, 10)
          .some(
            ({ action }) => action === "test.promise_like_commit_must_rollback",
          ),
      ),
    ).toBe(false);
    let reusedCommit = false;
    expect(() =>
      port.finalizeSelfRead({
        admission,
        subject_principal_id: fixture.membership.principal_id,
        commit: () => {
          reusedCommit = true;
          return "must-not-reuse-failed-admission";
        },
      }),
    ).toThrow("Person read admission is invalid or already finalized");
    expect(reusedCommit).toBe(false);
    fixture.repository.close();
  });

  it("burns the bootstrap grant and scrubs the attempt after a verified callback finds a revoked target", async () => {
    const fixture = setup();
    const grant = fixture.application.issueBootstrapLoginGrant({
      target_membership_id: fixture.membership.membership_id,
      expected_issuer: OIDC_CONFIGURATION.issuer,
    });
    const begun = fixture.application.beginOidcLogin({
      kind: "identity_bootstrap",
      login_grant: grant.login_grant,
    });
    fixture.provider.result = verifiedResult(begun);
    fixture.clock.current = "2026-08-18T00:01:00.000Z";
    fixture.repository.write(fixture.clock.current, (transaction) => {
      expect(
        transaction.revokeMembership(
          fixture.membership.membership_id,
          fixture.clock.current,
          "verified callback revocation race",
        ),
      ).toBe(true);
    });
    fixture.clock.current = "2026-08-18T00:01:01.000Z";
    await expect(
      fixture.application.completeOidcLogin({
        state: begun.state,
        authorization_code: "verified-but-now-unauthorized-code",
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
      message: "person authentication failed",
    });
    expect(
      fixture.repository.read((transaction) => ({
        grant: transaction.personLoginGrant(digestSecret(grant.login_grant)),
        attempt: transaction.oidcLoginAttempt(digestSecret(begun.state)),
      })),
    ).toMatchObject({
      grant: { consumed_at: fixture.clock.current },
      attempt: {
        terminal_outcome: "denied",
        completed_at: fixture.clock.current,
        resolved_identity_binding_id: null,
        upstream_auth_time: null,
        pkce_verifier_seal_key_id: null,
        pkce_verifier_sealed: null,
      },
    });
    fixture.repository.close();
  });

  it("allows only one callback contender to create a family and pair", async () => {
    const fixture = setup();
    const grant = fixture.application.issueBootstrapLoginGrant({
      target_membership_id: fixture.membership.membership_id,
      expected_issuer: OIDC_CONFIGURATION.issuer,
    });
    const begun = fixture.application.beginOidcLogin({
      kind: "identity_bootstrap",
      login_grant: grant.login_grant,
    });
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    fixture.provider.handler = async () => {
      arrivals += 1;
      await barrier;
      return verifiedResult(begun);
    };
    const first = fixture.application.completeOidcLogin({
      state: begun.state,
      authorization_code: "contender-one-code",
    });
    expect(arrivals).toBe(1);
    const second = fixture.application.completeOidcLogin({
      state: begun.state,
      authorization_code: "contender-two-code",
    });
    release?.();
    const contenders = await Promise.allSettled([first, second]);
    expect(arrivals).toBe(1);
    expect(
      contenders.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      contenders.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
    const counts = new Database(fixture.path, { readonly: true });
    expect(
      counts
        .prepare(
          "SELECT count(*) AS count FROM authority_person_session_families",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      counts
        .prepare(
          "SELECT count(*) AS count FROM authority_person_session_credentials",
        )
        .get(),
    ).toEqual({ count: 2 });
    counts.close();
    fixture.repository.close();
  });

  it("denies at the exact access-expiration boundary", async () => {
    const fixture = setup();
    const { session } = await bootstrapSession(fixture);
    fixture.clock.current = session.access_expires_at;
    expectOpaqueDenial(() =>
      fixture.application.authenticateAccess({
        access_token: session.access_token,
      }),
    );
    fixture.repository.close();
  });
});
