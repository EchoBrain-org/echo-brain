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

const OIDC = Object.freeze({
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

const OWNER = Object.freeze({ email: "core-owner@example.test", subject: "core-owner-subject", name: "Core Owner" });
const EMPLOYEE = Object.freeze({ email: "core-employee@example.test", subject: "core-employee-subject", name: "Core Employee" });

function bearer(session) {
  return Object.freeze({
    access_token: session.access_token,
    principal_id: session.principal_id,
    membership_id: session.membership_id,
  });
}

/** A deterministic port that only yields the token bound to the current app attempt. */
class CoreVerifiedIdentityPort {
  #attempt;
  #identity;
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
        issuer: OIDC.issuer,
        subject: selected.subject,
        audience: OIDC.client_id,
        nonce: attempt.nonce,
        issued_at: Math.floor(Date.now() / 1_000),
        claims: Object.freeze({
          email: selected.email,
          email_verified: true,
          [OIDC.tenant.claim_name]: OIDC.tenant.claim_value,
        }),
      }),
    });
  }
}

/**
 * Bootstrap durable owner and employee Person sessions for the core
 * checkpoint. This never starts an OIDC client, network listener, or TLS
 * endpoint; that provider work is deliberately outside the timed stage.
 */
export async function createCoreIdentity({ state_directory, owner_membership_id, pkce_sealing_key } = {}) {
  text(state_directory, "state_directory");
  text(owner_membership_id, "owner_membership_id");
  if (!(pkce_sealing_key instanceof Uint8Array) || pkce_sealing_key.byteLength !== 32) {
    throw new TypeError("pkce_sealing_key must be 32 bytes");
  }
  let database;
  try {
    database = openAuthorityDatabase(join(state_directory, "authority.sqlite"), { fileMustExist: true });
    const crypto = new NodePersonSessionCrypto(pkce_sealing_key);
    const provider = new CoreVerifiedIdentityPort();
    const sessions = new PersonIdentitySessionApplication(
      new SqlitePersonSessionRepository(database),
      OIDC,
      { clock: new SystemAuthorityClock(), random: crypto, hash: crypto, pkce_sealer: crypto, oidc_provider: provider },
    );
    const completeBootstrap = async (login_grant, selected) => {
      const begun = sessions.beginOidcLogin({ kind: "identity_bootstrap", login_grant, login_hint: selected.email });
      provider.bind(begun, selected);
      return await sessions.completeOidcLogin({ state: begun.state, authorization_code: `core-${randomUUID()}` });
    };
    const ownerGrant = sessions.issueBootstrapLoginGrant({
      target_membership_id: owner_membership_id,
      expected_issuer: OIDC.issuer,
      expected_email: OWNER.email,
    });
    const ownerSession = await completeBootstrap(ownerGrant.login_grant, OWNER);
    const employees = new PersonEmployeeLifecycleApplication(sessions, {
      next(prefix) { return `${prefix}_${randomUUID()}`; },
    });
    const invitation = employees.invite({
      access_token: ownerSession.access_token,
      name: EMPLOYEE.name,
      email: EMPLOYEE.email,
    });
    const employeeSession = await completeBootstrap(invitation.login_grant, EMPLOYEE);
    return Object.freeze({
      sessions,
      owner: bearer(ownerSession),
      employee: bearer(employeeSession),
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
