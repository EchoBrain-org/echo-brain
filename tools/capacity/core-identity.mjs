/**
 * Core-stage identity setup. The synthetic verified-identity port is outside
 * the timed runtime; Person session issuance, membership authorization, and
 * every durable write remain the production Authority application and SQLite
 * repository paths.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PersonEmployeeLifecycleApplication } from "../../services/organization-authority/dist/application/person-employee-lifecycle.js";
import { PersonIdentitySessionApplication } from "../../services/organization-authority/dist/application/person-identity-sessions.js";
import { openAuthorityDatabase } from "../../services/organization-authority/dist/adapters/persistence/sqlite/open-authority-database.js";
import { SqlitePersonSessionRepository } from "../../services/organization-authority/dist/adapters/persistence/sqlite/sqlite-person-session-repository.js";
import { NodePersonSessionCrypto } from "../../services/organization-authority/dist/adapters/security/node-person-session-crypto.js";
import { SystemAuthorityClock } from "../../services/organization-authority/dist/adapters/system/system-authority-clock.js";

const DEFAULT_OIDC = Object.freeze({
  issuer: "https://core-identity.example.test/",
  client_id: "core-identity-person-client",
  redirect_uri: "https://authority.example.test/v2/session/oidc/callback",
  tenant: Object.freeze({ kind: "claim", claim_name: "tenant_id", claim_value: "core-identity-tenant" }),
  id_token_algorithms: Object.freeze(["RS256"]),
});

function text(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function identity(value, label, defaults) {
  if (value !== undefined && (value === null || typeof value !== "object")) throw new TypeError(`${label} is invalid`);
  return Object.freeze({
    email: text(value?.email ?? defaults.email, `${label}.email`),
    subject: text(value?.subject ?? defaults.subject, `${label}.subject`),
    name: text(value?.name ?? defaults.name, `${label}.name`),
  });
}

function bearer(session) {
  return Object.freeze({
    access_token: session.access_token,
    authorization: `Bearer ${session.access_token}`,
    principal_id: session.principal_id,
    membership_id: session.membership_id,
  });
}

/** A deterministic port that only yields the token bound to the current app attempt. */
class CoreVerifiedIdentityPort {
  #attempt;
  #identity;
  constructor(oidc) {
    this.oidc = oidc;
  }
  bind(attempt, selected) {
    this.#attempt = attempt;
    this.#identity = selected;
  }
  async redeemAuthorizationCode() {
    if (this.#attempt === undefined || this.#identity === undefined) {
      throw new Error("core verified identity port has no bound login attempt");
    }
    const attempt = this.#attempt;
    const selected = this.#identity;
    this.#attempt = undefined;
    this.#identity = undefined;
    return Object.freeze({
      kind: "verified",
      token: Object.freeze({
        issuer: this.oidc.issuer,
        subject: selected.subject,
        audience: this.oidc.client_id,
        nonce: attempt.nonce,
        issued_at: Math.floor(Date.now() / 1_000),
        claims: Object.freeze({
          email: selected.email,
          email_verified: true,
          [this.oidc.tenant.claim_name]: this.oidc.tenant.claim_value,
        }),
      }),
    });
  }
}

/**
 * Bootstrap durable owner and optional employee Person sessions for the core
 * checkpoint. This never starts an OIDC client, network listener, or TLS
 * endpoint; that provider work is deliberately outside the timed stage.
 */
export async function createCoreIdentity({ state_directory, owner_membership_id, pkce_sealing_key, owner, employee, oidc = DEFAULT_OIDC } = {}) {
  text(state_directory, "state_directory");
  text(owner_membership_id, "owner_membership_id");
  if (!(pkce_sealing_key instanceof Uint8Array) || pkce_sealing_key.byteLength !== 32) {
    throw new TypeError("pkce_sealing_key must be 32 bytes");
  }
  const ownerIdentity = identity(owner, "owner", {
    email: "core-owner@example.test", subject: "core-owner-subject", name: "Core Owner",
  });
  const employeeIdentity = employee === false ? undefined : identity(employee, "employee", {
    email: "core-employee@example.test", subject: "core-employee-subject", name: "Core Employee",
  });
  if (employeeIdentity !== undefined && employeeIdentity.email === ownerIdentity.email) {
    throw new TypeError("employee.email must differ from owner.email");
  }
  if (oidc === null || typeof oidc !== "object" || oidc.tenant?.kind !== "claim") {
    throw new TypeError("core identity requires a claim-bound OIDC configuration");
  }
  const configuration = Object.freeze({
    issuer: text(oidc.issuer, "oidc.issuer"),
    client_id: text(oidc.client_id, "oidc.client_id"),
    redirect_uri: text(oidc.redirect_uri, "oidc.redirect_uri"),
    tenant: Object.freeze({
      kind: "claim",
      claim_name: text(oidc.tenant.claim_name, "oidc.tenant.claim_name"),
      claim_value: text(oidc.tenant.claim_value, "oidc.tenant.claim_value"),
    }),
    id_token_algorithms: Object.freeze([...oidc.id_token_algorithms]),
  });
  let database;
  try {
    database = openAuthorityDatabase(join(state_directory, "authority.sqlite"), { fileMustExist: true });
    const crypto = new NodePersonSessionCrypto(pkce_sealing_key);
    const provider = new CoreVerifiedIdentityPort(configuration);
    const sessions = new PersonIdentitySessionApplication(
      new SqlitePersonSessionRepository(database),
      configuration,
      { clock: new SystemAuthorityClock(), random: crypto, hash: crypto, pkce_sealer: crypto, oidc_provider: provider },
    );
    const completeBootstrap = async (login_grant, selected) => {
      const begun = sessions.beginOidcLogin({ kind: "identity_bootstrap", login_grant, login_hint: selected.email });
      provider.bind(begun, selected);
      return await sessions.completeOidcLogin({ state: begun.state, authorization_code: `core-${randomUUID()}` });
    };
    const ownerGrant = sessions.issueBootstrapLoginGrant({
      target_membership_id: owner_membership_id,
      expected_issuer: configuration.issuer,
      expected_email: ownerIdentity.email,
    });
    const ownerSession = await completeBootstrap(ownerGrant.login_grant, ownerIdentity);
    let employeeSession;
    if (employeeIdentity !== undefined) {
      const employees = new PersonEmployeeLifecycleApplication(sessions, {
        next(prefix) { return `${prefix}_${randomUUID()}`; },
      });
      const invitation = employees.invite({
        access_token: ownerSession.access_token,
        name: employeeIdentity.name,
        email: employeeIdentity.email,
      });
      employeeSession = await completeBootstrap(invitation.login_grant, employeeIdentity);
    }
    return Object.freeze({
      oidc: configuration,
      sessions,
      owner: bearer(ownerSession),
      ...(employeeSession === undefined ? {} : { employee: bearer(employeeSession) }),
      close() {
        database?.close();
        database = undefined;
      },
    });
  } catch (error) {
    database?.close();
    throw error;
  }
}
