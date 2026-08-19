import { Buffer } from "node:buffer";
import { canonicalJson } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "../domain/errors.js";
import {
  addPersonSessionMilliseconds,
  assertOpaqueSubject,
  assertSessionRevocationReason,
  earlierTimestamp,
  isCanonicalPersonEmail,
  isStrictlyBefore,
  OIDC_ASSERTION_ISSUED_AT_SKEW_MS,
  OIDC_LOGIN_ATTEMPT_LIFETIME_MS,
  PERSON_ACCESS_CREDENTIAL_LIFETIME_MS,
  PERSON_LOGIN_GRANT_LIFETIME_MS,
  PERSON_SESSION_HARD_REAUTHENTICATION_MS,
  PERSON_SESSION_SECRET_BYTES,
  personSessionUnauthorized,
} from "../domain/person-session-rules.js";
import { timestampMillis } from "../domain/rules.js";
import type {
  AuthorityPersonMembershipBinding,
  AuthorityReadTransaction,
  AuthorityWriteTransaction,
  NewPersonSessionCredential,
  OrganizationAuthorityRepository,
  StoredOidcIdentityBinding,
  StoredOidcLoginAttempt,
  StoredPersonSessionFamily,
} from "./ports/authority-repository.js";
import type {
  FrozenPersonSessionOidcConfiguration,
  OidcTenantConstraint,
  PersonSessionHashPort,
  PersonSessionOidcConfiguration,
  PersonSessionOidcFailureReason,
  PersonSessionRandomPurpose,
  PersonSessionRuntime,
  VerifiedOidcIdentityToken,
} from "./ports/person-session-runtime.js";

const SHA256_BYTES = 32;
const LOCAL_UUID_BYTES = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface IssuedPersonLoginGrant extends AuthorityPersonMembershipBinding {
  login_grant: string;
  expected_issuer: string;
  expected_email_sha256: Sha256Digest;
  issued_at: string;
  expires_at: string;
}

export type BeginPersonOidcLoginInput =
  | { kind: "identity_bootstrap"; login_grant: string }
  | { kind: "existing_identity_login" };

export interface BegunPersonOidcLogin {
  login_attempt_id: string;
  issuer: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  nonce: string;
  code_challenge: string;
  code_challenge_method: "S256";
  response_type: "code";
  scope: "openid email";
  created_at: string;
  expires_at: string;
}

export interface IssuedPersonSession extends AuthorityPersonMembershipBinding {
  identity_binding_id: string;
  session_family_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
  hard_reauthentication_at: string;
}

export interface PersonAccessAuthorization extends AuthorityPersonMembershipBinding {
  identity_binding_id: string;
  session_family_id: string;
  access_credential_sha256: Sha256Digest;
  access_expires_at: string;
  hard_reauthentication_at: string;
  person_state_sha256: Sha256Digest;
  session_state_sha256: Sha256Digest;
  checked_at: string;
}

export type PersonReadAdmission = PersonAccessAuthorization;

export type PersonReadStartDenyDecision =
  | {
      decision: "deny";
      reason_code: "person_or_session_inactive";
      authorization: null;
      checked_at: string;
    }
  | {
      decision: "deny";
      reason_code: "caller_subject_mismatch";
      authorization: PersonAccessAuthorization;
      checked_at: string;
    };

export type PersonReadFinalDecision =
  | {
      decision: "allow";
      authorization: PersonAccessAuthorization;
    }
  | {
      decision: "deny";
      reason_code:
        | "caller_subject_mismatch"
        | "person_or_session_inactive"
        | "authorization_state_changed";
      checked_at: string;
    };

type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface PersonReadAuthorizationPort {
  admitSelfRead(input: {
    access_token: string;
    subject_principal_id: string;
    /** Commits the closed start-gate deny audit before this method throws. */
    commitStartDeny: (
      decision: PersonReadStartDenyDecision,
      transaction: AuthorityWriteTransaction,
    ) => void;
  }): PersonReadAdmission;
  /**
   * `commit` runs under the final Authority write fence. It must append the
   * route's allow or deny audit synchronously and must not release response
   * bytes for deny. A committed deny is mapped to the same opaque public
   * authorization error.
   */
  finalizeSelfRead<T>(input: {
    admission: PersonReadAdmission;
    subject_principal_id: string;
    commit: (
      decision: PersonReadFinalDecision,
      transaction: AuthorityWriteTransaction,
    ) => SynchronousResult<T>;
  }): SynchronousResult<T>;
}

/** Only the read port's expected, already-audited denials use this sentinel. */
export class PersonReadUnauthorizedError extends AuthorityOperationError {
  constructor() {
    super("unauthorized", "person authentication failed");
    this.name = "PersonReadUnauthorizedError";
  }
}

interface SessionCredentialCandidate {
  access_credential_id: string;
  access_token: string;
  access_token_sha256: Sha256Digest;
  refresh_credential_id: string;
  refresh_token: string;
  refresh_token_sha256: Sha256Digest;
}

interface VerifiedIdentity {
  issuer: string;
  subject: string;
  bootstrap_email_sha256: Sha256Digest | null;
  upstream_assertion_issued_at: string;
}

class PersonSessionOidcDiagnosticError extends Error {
  constructor(readonly reason: PersonSessionOidcFailureReason) {
    super(reason);
    this.name = "PersonSessionOidcDiagnosticError";
  }
}

type AccessResolution =
  | { kind: "allowed"; authorization: PersonAccessAuthorization }
  | { kind: "denied" };

type CallbackWriteResult =
  | { kind: "issued"; session: IssuedPersonSession }
  | { kind: "denied"; reason: PersonSessionOidcFailureReason };

type RefreshWriteResult =
  { kind: "issued"; session: IssuedPersonSession } | { kind: "denied" };

function validateHttpsUrl(
  value: string,
  label: string,
  canonicalRootMayOmitSlash = false,
): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  const exactRoot = canonicalRootMayOmitSlash && value === parsed.origin;
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0 ||
    (!exactRoot && parsed.href !== value)
  ) {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
}

function validateText(
  value: string,
  label: string,
  maximumLength: number,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function validateOidcConfiguration(
  configuration: PersonSessionOidcConfiguration,
): void {
  validateHttpsUrl(configuration.issuer, "OIDC issuer", true);
  if (new URL(configuration.issuer).search.length > 0) {
    throw new Error("OIDC issuer must not contain a query");
  }
  validateText(configuration.client_id, "OIDC client ID", 1024);
  validateHttpsUrl(configuration.redirect_uri, "OIDC redirect URI");
  if (
    !Array.isArray(configuration.id_token_algorithms) ||
    configuration.id_token_algorithms.length === 0 ||
    new Set(configuration.id_token_algorithms).size !==
      configuration.id_token_algorithms.length
  ) {
    throw new Error("OIDC ID-token algorithm allowlist is invalid");
  }
  for (const algorithm of configuration.id_token_algorithms) {
    validateText(algorithm, "OIDC ID-token algorithm", 100);
    if (algorithm === "none") {
      throw new Error("OIDC ID-token algorithm allowlist cannot contain none");
    }
  }
  if (configuration.tenant.kind === "claim") {
    validateText(
      configuration.tenant.claim_name,
      "OIDC tenant claim name",
      200,
    );
    validateText(
      configuration.tenant.claim_value,
      "OIDC tenant claim value",
      1024,
    );
  } else if (configuration.tenant.kind !== "issuer") {
    throw new Error("OIDC tenant constraint is invalid");
  }
}

function exactPersonTuple(
  left: AuthorityPersonMembershipBinding,
  right: AuthorityPersonMembershipBinding,
): boolean {
  return (
    left.organization_id === right.organization_id &&
    left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id &&
    left.membership_type === right.membership_type
  );
}

export class PersonIdentitySessionApplication {
  private readonly configuration: FrozenPersonSessionOidcConfiguration;
  private readonly admissionCredentialDigests = new WeakMap<
    PersonReadAdmission,
    Sha256Digest
  >();

  constructor(
    private readonly repository: OrganizationAuthorityRepository,
    configuration: PersonSessionOidcConfiguration,
    private readonly runtime: PersonSessionRuntime,
  ) {
    validateOidcConfiguration(configuration);
    const tenant: OidcTenantConstraint =
      configuration.tenant.kind === "issuer"
        ? { kind: "issuer" }
        : {
            kind: "claim",
            claim_name: configuration.tenant.claim_name,
            claim_value: configuration.tenant.claim_value,
          };
    const idTokenAlgorithms = [...configuration.id_token_algorithms];
    const tenantConstraintSha256 = this.digestCanonical({
      schema_version: 1,
      kind: "authority-oidc-tenant-constraint-v1",
      issuer: configuration.issuer,
      tenant,
    });
    const oidcConfigurationSha256 = this.digestCanonical({
      schema_version: 1,
      kind: "authority-oidc-configuration-v1",
      issuer: configuration.issuer,
      client_id: configuration.client_id,
      redirect_uri: configuration.redirect_uri,
      tenant,
      id_token_algorithms: idTokenAlgorithms,
    });
    this.configuration = Object.freeze({
      issuer: configuration.issuer,
      client_id: configuration.client_id,
      redirect_uri: configuration.redirect_uri,
      tenant: Object.freeze(tenant),
      id_token_algorithms: Object.freeze(idTokenAlgorithms),
      tenant_constraint_sha256: tenantConstraintSha256,
      oidc_configuration_sha256: oidcConfigurationSha256,
    });
  }

  issueBootstrapLoginGrant(input: {
    target_membership_id: string;
    expected_issuer: string;
    expected_email: string;
  }): IssuedPersonLoginGrant {
    if (input.expected_issuer !== this.configuration.issuer) {
      throw new AuthorityOperationError(
        "invalid_request",
        "login grant issuer does not match Authority configuration",
      );
    }
    if (!isCanonicalPersonEmail(input.expected_email)) {
      throw new AuthorityOperationError(
        "invalid_request",
        "login grant expected email must be canonical lowercase ASCII",
      );
    }
    const loginGrant = this.secret("login_grant");
    const loginGrantSha256 = this.digestSecret(loginGrant);
    const expectedEmailSha256 = this.expectedEmailSha256(input.expected_email);
    return this.repository.writeAtLinearization(
      () => this.runtime.clock.now(),
      (transaction, issuedAt) => {
        const membership = transaction.membership(input.target_membership_id);
        if (membership === undefined || membership.status !== "active") {
          throw new AuthorityOperationError(
            "not_found",
            "active target membership was not found",
          );
        }
        const metadata = transaction.metadata();
        if (membership.organization_id !== metadata.organization_id) {
          throw new Error(
            "membership belongs to another Authority organization",
          );
        }
        const expiresAt = addPersonSessionMilliseconds(
          issuedAt,
          PERSON_LOGIN_GRANT_LIFETIME_MS,
        );
        const stored = transaction.insertPersonLoginGrant({
          login_grant_sha256: loginGrantSha256,
          grant_purpose: "oidc_identity_bootstrap",
          organization_id: membership.organization_id,
          principal_id: membership.principal_id,
          membership_id: membership.membership_id,
          membership_type: membership.membership_type,
          expected_issuer: input.expected_issuer,
          expected_email_sha256: expectedEmailSha256,
          oidc_configuration_sha256:
            this.configuration.oidc_configuration_sha256,
          expires_at: expiresAt,
        });
        transaction.appendAudit({
          occurred_at: stored.issued_at,
          actor_kind: "admin",
          action: "person_login_grant.issued",
          subject_id: stored.membership_id,
          detail: {
            organization_id: stored.organization_id,
            principal_id: stored.principal_id,
            membership_id: stored.membership_id,
            membership_type: stored.membership_type,
            login_grant_sha256: stored.login_grant_sha256,
            expected_issuer: stored.expected_issuer,
            expected_email_sha256: stored.expected_email_sha256,
            issued_at: stored.issued_at,
            expires_at: stored.expires_at,
          },
        });
        return {
          organization_id: stored.organization_id,
          principal_id: stored.principal_id,
          membership_id: stored.membership_id,
          membership_type: stored.membership_type,
          login_grant: loginGrant,
          expected_issuer: stored.expected_issuer,
          expected_email_sha256: stored.expected_email_sha256,
          issued_at: stored.issued_at,
          expires_at: stored.expires_at,
        };
      },
    );
  }

  beginOidcLogin(input: BeginPersonOidcLoginInput): BegunPersonOidcLogin {
    const state = this.secret("oidc_state");
    const nonce = this.secret("oidc_nonce");
    const verifier = this.secret("pkce_verifier");
    const stateSha256 = this.digestSecret(state);
    const nonceSha256 = this.digestSecret(nonce);
    const loginAttemptId = this.localId("ola", "login_attempt_id");
    const loginGrantSha256 =
      input.kind === "identity_bootstrap"
        ? this.digestSecret(input.login_grant)
        : null;

    return this.repository.writeAtLinearization(
      () => this.runtime.clock.now(),
      (transaction, createdAt) => {
        const expiresAt = addPersonSessionMilliseconds(
          createdAt,
          OIDC_LOGIN_ATTEMPT_LIFETIME_MS,
        );
        if (input.kind === "identity_bootstrap") {
          if (loginGrantSha256 === null) throw personSessionUnauthorized();
          const grant = transaction.personLoginGrant(loginGrantSha256);
          if (
            grant === undefined ||
            grant.consumed_at !== null ||
            grant.expected_issuer !== this.configuration.issuer ||
            grant.oidc_configuration_sha256 !==
              this.configuration.oidc_configuration_sha256 ||
            !isStrictlyBefore(createdAt, grant.expires_at) ||
            !this.hasActiveExactMembership(transaction, grant) ||
            transaction.oidcLoginAttemptForLoginGrant(loginGrantSha256) !==
              undefined
          ) {
            throw personSessionUnauthorized();
          }
        } else if (input.kind !== "existing_identity_login") {
          throw personSessionUnauthorized();
        }

        const attemptForAad = {
          login_attempt_id: loginAttemptId,
          issuer: this.configuration.issuer,
          attempt_purpose: input.kind,
          client_id: this.configuration.client_id,
          redirect_uri: this.configuration.redirect_uri,
          tenant_constraint_sha256: this.configuration.tenant_constraint_sha256,
          oidc_configuration_sha256:
            this.configuration.oidc_configuration_sha256,
          login_grant_sha256: loginGrantSha256,
          state_sha256: stateSha256,
          nonce_sha256: nonceSha256,
          created_at: createdAt,
          expires_at: expiresAt,
        } as const;
        const seal = this.runtime.pkce_sealer.seal({
          plaintext: Buffer.from(verifier, "ascii"),
          authenticated_data: this.pkceAuthenticatedData(attemptForAad),
        });
        validateText(seal.key_id, "PKCE sealing key ID", 200);
        if (
          !(seal.sealed_bytes instanceof Uint8Array) ||
          seal.sealed_bytes.length < 32 ||
          seal.sealed_bytes.length > 8192
        ) {
          throw new Error("PKCE sealer returned invalid sealed bytes");
        }
        const stored = transaction.insertOidcLoginAttempt({
          login_attempt_id: loginAttemptId,
          issuer: this.configuration.issuer,
          attempt_purpose: input.kind,
          client_id: this.configuration.client_id,
          redirect_uri: this.configuration.redirect_uri,
          tenant_constraint_sha256: this.configuration.tenant_constraint_sha256,
          oidc_configuration_sha256:
            this.configuration.oidc_configuration_sha256,
          login_grant_sha256: loginGrantSha256,
          state_sha256: stateSha256,
          nonce_sha256: nonceSha256,
          sealed_pkce_verifier: {
            key_id: seal.key_id,
            sealed_bytes: Uint8Array.from(seal.sealed_bytes),
          },
          expires_at: expiresAt,
        });
        return {
          login_attempt_id: stored.login_attempt_id,
          issuer: stored.issuer,
          client_id: stored.client_id,
          redirect_uri: stored.redirect_uri,
          state,
          nonce,
          code_challenge: this.pkceChallenge(verifier),
          code_challenge_method: "S256",
          response_type: "code",
          scope: "openid email",
          created_at: stored.created_at,
          expires_at: stored.expires_at,
        };
      },
    );
  }

  async completeOidcLogin(input: {
    state: string;
    authorization_code: string;
  }): Promise<IssuedPersonSession> {
    let stateSha256: Sha256Digest;
    try {
      stateSha256 = this.digestSecret(input.state);
    } catch {
      this.diagnoseOidcFailure("attempt_unavailable");
      throw personSessionUnauthorized();
    }
    const redemptionClaimId = this.localId("olc", "oidc_redemption_claim_id");
    let attempt: StoredOidcLoginAttempt | undefined;
    try {
      attempt = this.repository.writeAtLinearization(
        () => this.runtime.clock.now(),
        (transaction) =>
          transaction.claimOidcLoginAttempt(stateSha256, redemptionClaimId),
      );
    } catch {
      this.diagnoseOidcFailure("attempt_unavailable");
      throw personSessionUnauthorized();
    }
    if (attempt === undefined) {
      this.diagnoseOidcFailure("attempt_unavailable");
      throw personSessionUnauthorized();
    }
    let releasedForRetry = false;
    try {
      if (!this.attemptUsesCurrentConfiguration(attempt)) {
        throw new PersonSessionOidcDiagnosticError("attempt_invalid");
      }
      if (
        typeof input.authorization_code !== "string" ||
        input.authorization_code.length > 16_384 ||
        /[\u0000-\u001f\u007f]/.test(input.authorization_code)
      ) {
        throw new PersonSessionOidcDiagnosticError("attempt_invalid");
      }
      if (input.authorization_code.length === 0) {
        throw new PersonSessionOidcDiagnosticError(
          "provider_authorization_failed",
        );
      }
      let verifier: string;
      try {
        verifier = this.unsealVerifier(attempt);
      } catch {
        throw new PersonSessionOidcDiagnosticError("attempt_invalid");
      }
      let providerResult;
      try {
        providerResult =
          await this.runtime.oidc_provider.redeemAuthorizationCode({
            configuration: this.configuration,
            authorization_code: input.authorization_code,
            pkce_verifier: verifier,
          });
      } catch {
        throw new PersonSessionOidcDiagnosticError(
          "provider_redemption_failed",
        );
      }
      if (providerResult?.kind === "retryable_before_redemption") {
        const released = this.repository.writeAtLinearization(
          () => this.runtime.clock.now(),
          (transaction) =>
            transaction.releaseOidcLoginAttemptClaim(
              stateSha256,
              redemptionClaimId,
            ),
        );
        if (!released) {
          throw new Error("OIDC redemption claim could not be released");
        }
        releasedForRetry = true;
        throw new PersonSessionOidcDiagnosticError(
          "provider_redemption_failed",
        );
      }
      if (providerResult?.kind !== "verified") {
        const stage = providerResult?.diagnostic_stage;
        throw new PersonSessionOidcDiagnosticError(
          stage === "configuration"
            ? "provider_configuration_failed"
            : stage === "redemption"
              ? "provider_redemption_failed"
              : stage === "response"
                ? "provider_response_invalid"
              : "provider_verification_failed",
        );
      }
      const identity = this.validateVerifiedIdentity(
        attempt,
        providerResult.token,
        this.runtime.clock.now(),
      );
      const candidate = this.sessionCredentialCandidate();
      const familyId = this.localId("psf", "session_family_id");
      const bindingId = this.localId("oib", "identity_binding_id");
      const outcome = this.repository.writeAtLinearization(
        () => this.runtime.clock.now(),
        (transaction, observedAt): CallbackWriteResult => {
          const current = transaction.oidcLoginAttempt(stateSha256);
          if (
            current === undefined ||
            current.terminal_outcome !== null ||
            current.redemption_claim_id !== redemptionClaimId ||
            !isStrictlyBefore(observedAt, current.expires_at)
          ) {
            return { kind: "denied", reason: "attempt_unavailable" };
          }
          if (!this.attemptUsesCurrentConfiguration(current)) {
            this.completeDeniedAttempt(
              transaction,
              stateSha256,
              redemptionClaimId,
            );
            return { kind: "denied", reason: "attempt_invalid" };
          }

          let binding: StoredOidcIdentityBinding;
          if (current.attempt_purpose === "identity_bootstrap") {
            const grantSha256 = current.login_grant_sha256;
            if (grantSha256 === null) {
              this.completeDeniedAttempt(
                transaction,
                stateSha256,
                redemptionClaimId,
              );
              return { kind: "denied", reason: "bootstrap_binding_denied" };
            }
            const grant = transaction.personLoginGrant(grantSha256);
            if (
              grant === undefined ||
              grant.consumed_at !== null ||
              grant.expected_issuer !== identity.issuer ||
              identity.bootstrap_email_sha256 === null ||
              grant.expected_email_sha256 !==
                identity.bootstrap_email_sha256 ||
              grant.oidc_configuration_sha256 !==
                current.oidc_configuration_sha256 ||
              !isStrictlyBefore(observedAt, grant.expires_at)
            ) {
              this.completeDeniedAttempt(
                transaction,
                stateSha256,
                redemptionClaimId,
              );
              return { kind: "denied", reason: "bootstrap_binding_denied" };
            }
            const existing = transaction.oidcIdentityBinding(
              identity.issuer,
              identity.subject,
            );
            const activeTuple = this.hasActiveExactMembership(
              transaction,
              grant,
            );
            if (existing !== undefined || !activeTuple) {
              this.completeDeniedAttempt(
                transaction,
                stateSha256,
                redemptionClaimId,
              );
              return { kind: "denied", reason: "bootstrap_binding_denied" };
            }
            const consumedGrant =
              transaction.consumePersonLoginGrant(grantSha256);
            if (consumedGrant === undefined) {
              this.completeDeniedAttempt(
                transaction,
                stateSha256,
                redemptionClaimId,
              );
              return { kind: "denied", reason: "bootstrap_binding_denied" };
            }
            if (
              transaction.completeOidcLoginAttempt(
                stateSha256,
                redemptionClaimId,
                {
                  outcome: "succeeded",
                  resolved_identity_binding_id: bindingId,
                  upstream_assertion_issued_at:
                    identity.upstream_assertion_issued_at,
                },
              ) === undefined
            ) {
              throw new Error("claimed OIDC attempt could not be completed");
            }
            binding = transaction.insertOidcIdentityBinding({
              identity_binding_id: bindingId,
              issuer: identity.issuer,
              subject: identity.subject,
              tenant_constraint_sha256: current.tenant_constraint_sha256,
              oidc_configuration_sha256: current.oidc_configuration_sha256,
              initial_login_attempt_id: current.login_attempt_id,
              initial_login_grant_sha256: grantSha256,
              organization_id: grant.organization_id,
              principal_id: grant.principal_id,
              membership_id: grant.membership_id,
              membership_type: grant.membership_type,
            });
          } else {
            if (current.login_grant_sha256 !== null) {
              this.completeDeniedAttempt(
                transaction,
                stateSha256,
                redemptionClaimId,
              );
              return { kind: "denied", reason: "attempt_invalid" };
            }
            const existing = transaction.oidcIdentityBinding(
              identity.issuer,
              identity.subject,
            );
            if (
              existing === undefined ||
              existing.status !== "active" ||
              !this.hasActiveExactMembership(transaction, existing)
            ) {
              this.completeDeniedAttempt(
                transaction,
                stateSha256,
                redemptionClaimId,
              );
              return { kind: "denied", reason: "identity_binding_denied" };
            }
            binding = existing;
            if (
              transaction.completeOidcLoginAttempt(
                stateSha256,
                redemptionClaimId,
                {
                  outcome: "succeeded",
                  resolved_identity_binding_id: binding.identity_binding_id,
                  upstream_assertion_issued_at:
                    identity.upstream_assertion_issued_at,
                },
              ) === undefined
            ) {
              throw new Error("claimed OIDC attempt could not be completed");
            }
          }

          return this.issueFamily(
            transaction,
            observedAt,
            identity.upstream_assertion_issued_at,
            binding,
            current,
            familyId,
            candidate,
            1,
          );
        },
      );
      if (outcome.kind === "denied") {
        throw new PersonSessionOidcDiagnosticError(outcome.reason);
      }
      return outcome.session;
    } catch (error) {
      if (!releasedForRetry) {
        try {
          this.terminalizeAttempt(stateSha256, redemptionClaimId);
        } catch {
          // A claimed attempt remains unusable and expiry maintenance will scrub
          // it if durable terminalization is temporarily unavailable.
        }
      }
      this.diagnoseOidcFailure(
        error instanceof PersonSessionOidcDiagnosticError
          ? error.reason
          : "internal_failure",
      );
      throw personSessionUnauthorized();
    }
  }

  authenticateAccess(input: {
    access_token: string;
  }): PersonAccessAuthorization {
    const tokenSha256 = this.digestSecret(input.access_token);
    const checkedAt = this.runtime.clock.now();
    const resolution = this.repository.read((transaction) =>
      this.resolveAccess(transaction, tokenSha256, checkedAt),
    );
    if (resolution.kind === "denied") throw personSessionUnauthorized();
    return resolution.authorization;
  }

  refresh(input: { refresh_token: string }): IssuedPersonSession {
    const tokenSha256 = this.digestSecret(input.refresh_token);
    const candidate = this.sessionCredentialCandidate();
    const outcome = this.repository.writeAtLinearization(
      () => this.runtime.clock.now(),
      (transaction, observedAt): RefreshWriteResult => {
        const refresh = transaction.personSessionCredential(tokenSha256);
        if (refresh === undefined || refresh.credential_kind !== "refresh") {
          return { kind: "denied" };
        }
        const family = transaction.personSessionFamily(
          refresh.session_family_id,
        );
        if (family === undefined) return { kind: "denied" };
        if (
          refresh.consumed_at !== null ||
          refresh.revoked_at !== null ||
          family.status !== "active"
        ) {
          transaction.revokePersonSessionFamily(
            family.session_family_id,
            "refresh_credential_replay",
          );
          return { kind: "denied" };
        }
        const binding = transaction.oidcIdentityBindingById(
          family.identity_binding_id,
        );
        if (
          binding === undefined ||
          binding.status !== "active" ||
          !exactPersonTuple(family, binding) ||
          !this.hasActiveExactMembership(transaction, family) ||
          !isStrictlyBefore(observedAt, family.hard_reauthentication_at) ||
          !isStrictlyBefore(observedAt, refresh.expires_at)
        ) {
          transaction.revokePersonSessionFamily(
            family.session_family_id,
            "refresh_dependency_inactive",
          );
          return { kind: "denied" };
        }
        const credentials = transaction.personSessionCredentialsForFamily(
          family.session_family_id,
        );
        const oldAccess = credentials.find(
          (credential) =>
            credential.credential_kind === "access" &&
            credential.rotation_sequence === refresh.rotation_sequence,
        );
        if (
          oldAccess === undefined ||
          oldAccess.revoked_at !== null ||
          transaction.consumePersonSessionRefreshCredential(tokenSha256) ===
            undefined ||
          !transaction.revokePersonSessionCredential(
            oldAccess.token_sha256,
            "refresh_rotation",
          )
        ) {
          transaction.revokePersonSessionFamily(
            family.session_family_id,
            "refresh_credential_replay",
          );
          return { kind: "denied" };
        }
        return this.issueCredentialPair(
          transaction,
          observedAt,
          family,
          binding,
          candidate,
          refresh.rotation_sequence + 1,
        );
      },
    );
    if (outcome.kind === "denied") throw personSessionUnauthorized();
    return outcome.session;
  }

  revoke(input: {
    credential_kind: "access" | "refresh";
    credential: string;
    reason: string;
  }): void {
    assertSessionRevocationReason(input.reason);
    const tokenSha256 = this.digestSecret(input.credential);
    const revoked = this.repository.writeAtLinearization(
      () => this.runtime.clock.now(),
      (transaction) => {
        const credential = transaction.personSessionCredential(tokenSha256);
        if (
          credential === undefined ||
          credential.credential_kind !== input.credential_kind
        ) {
          return false;
        }
        return transaction.revokePersonSessionFamily(
          credential.session_family_id,
          input.reason,
        );
      },
    );
    if (!revoked) throw personSessionUnauthorized();
  }

  expireOidcLoginAttempts(input: { limit: number }): number {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1000
    ) {
      throw new AuthorityOperationError(
        "invalid_request",
        "OIDC login attempt expiry limit must be between 1 and 1000",
      );
    }
    return this.repository.writeAtLinearization(
      () => this.runtime.clock.now(),
      (transaction) => transaction.expireOidcLoginAttempts(input.limit),
    );
  }

  createPersonReadAuthorizationPort(): PersonReadAuthorizationPort {
    return {
      admitSelfRead: (input) => {
        let tokenSha256: Sha256Digest | undefined;
        try {
          tokenSha256 = this.digestSecret(input.access_token);
        } catch {
          tokenSha256 = undefined;
        }
        let outcome:
          | { kind: "allowed"; authorization: PersonAccessAuthorization }
          | { kind: "denied" };
        outcome = this.repository.writeAtLinearization(
          () => this.runtime.clock.now(),
          (transaction, checkedAt) => {
            const resolution =
              tokenSha256 === undefined
                ? ({ kind: "denied" } as const)
                : this.resolveAccess(transaction, tokenSha256, checkedAt);
            if (resolution.kind === "denied") {
              const committed = input.commitStartDeny(
                {
                  decision: "deny",
                  reason_code: "person_or_session_inactive",
                  authorization: null,
                  checked_at: checkedAt,
                },
                transaction,
              );
              this.assertSynchronousCommit(committed);
              return { kind: "denied" as const };
            }
            if (
              resolution.authorization.principal_id !==
              input.subject_principal_id
            ) {
              const committed = input.commitStartDeny(
                {
                  decision: "deny",
                  reason_code: "caller_subject_mismatch",
                  authorization: resolution.authorization,
                  checked_at: checkedAt,
                },
                transaction,
              );
              this.assertSynchronousCommit(committed);
              return { kind: "denied" as const };
            }
            return {
              kind: "allowed" as const,
              authorization: resolution.authorization,
            };
          },
        );
        if (outcome.kind === "denied") throw new PersonReadUnauthorizedError();
        const authorization = outcome.authorization;
        const admission: PersonReadAdmission = { ...authorization };
        this.admissionCredentialDigests.set(
          admission,
          authorization.access_credential_sha256,
        );
        return admission;
      },
      finalizeSelfRead: <T>(input: {
        admission: PersonReadAdmission;
        subject_principal_id: string;
        commit: (
          decision: PersonReadFinalDecision,
          transaction: AuthorityWriteTransaction,
        ) => SynchronousResult<T>;
      }): SynchronousResult<T> => {
        const tokenSha256 = this.admissionCredentialDigests.get(
          input.admission,
        );
        if (tokenSha256 === undefined) {
          throw new Error("Person read admission is invalid or already finalized");
        }
        this.admissionCredentialDigests.delete(input.admission);
        const outcome = this.repository.writeAtLinearization(
          () => this.runtime.clock.now(),
          (transaction, checkedAt) => {
            if (input.subject_principal_id !== input.admission.principal_id) {
              const committed = input.commit(
                {
                  decision: "deny",
                  reason_code: "caller_subject_mismatch",
                  checked_at: checkedAt,
                },
                transaction,
              );
              this.assertSynchronousCommit(committed);
              return { kind: "denied" as const };
            }
            const fresh = this.resolveAccess(
              transaction,
              tokenSha256,
              checkedAt,
            );
            if (fresh.kind === "denied") {
              const committed = input.commit(
                {
                  decision: "deny",
                  reason_code: "person_or_session_inactive",
                  checked_at: checkedAt,
                },
                transaction,
              );
              this.assertSynchronousCommit(committed);
              return { kind: "denied" as const };
            }
            if (
              fresh.authorization.principal_id !== input.subject_principal_id ||
              fresh.authorization.person_state_sha256 !==
                input.admission.person_state_sha256 ||
              fresh.authorization.session_state_sha256 !==
                input.admission.session_state_sha256 ||
              fresh.authorization.access_credential_sha256 !==
                input.admission.access_credential_sha256 ||
              fresh.authorization.session_family_id !==
                input.admission.session_family_id
            ) {
              const committed = input.commit(
                {
                  decision: "deny",
                  reason_code: "authorization_state_changed",
                  checked_at: checkedAt,
                },
                transaction,
              );
              this.assertSynchronousCommit(committed);
              return { kind: "denied" as const };
            }
            const committed = input.commit(
              { decision: "allow", authorization: fresh.authorization },
              transaction,
            );
            this.assertSynchronousCommit(committed);
            return {
              kind: "allowed" as const,
              value: committed,
            };
          },
        );
        if (outcome.kind === "denied") throw new PersonReadUnauthorizedError();
        return outcome.value;
      },
    };
  }

  private diagnoseOidcFailure(reason: PersonSessionOidcFailureReason): void {
    try {
      this.runtime.diagnostics?.oidcLoginDenied(reason);
    } catch {
      // Operator diagnostics must never alter authentication state or outcome.
    }
  }

  private completeDeniedAttempt(
    transaction: AuthorityWriteTransaction,
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
  ): StoredOidcLoginAttempt | undefined {
    const current = transaction.oidcLoginAttempt(stateSha256);
    if (
      current === undefined ||
      current.terminal_outcome !== null ||
      current.redemption_claim_id !== redemptionClaimId
    ) {
      return undefined;
    }
    if (current.login_grant_sha256 !== null) {
      transaction.consumePersonLoginGrant(current.login_grant_sha256);
    }
    return transaction.completeOidcLoginAttempt(
      stateSha256,
      redemptionClaimId,
      { outcome: "denied" },
    );
  }

  private terminalizeAttempt(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
  ): void {
    this.repository.writeAtLinearization(
      () => this.runtime.clock.now(),
      (transaction) => {
        this.completeDeniedAttempt(transaction, stateSha256, redemptionClaimId);
      },
    );
  }

  private unsealVerifier(attempt: StoredOidcLoginAttempt): string {
    if (
      attempt.pkce_verifier_seal_key_id === null ||
      attempt.pkce_verifier_sealed === null
    ) {
      throw personSessionUnauthorized();
    }
    try {
      const plaintext = this.runtime.pkce_sealer.unseal({
        key_id: attempt.pkce_verifier_seal_key_id,
        sealed_bytes: Uint8Array.from(attempt.pkce_verifier_sealed),
        authenticated_data: this.pkceAuthenticatedData(attempt),
      });
      const verifier = Buffer.from(plaintext).toString("ascii");
      this.decodeSecret(verifier);
      return verifier;
    } catch {
      throw personSessionUnauthorized();
    }
  }

  private validateVerifiedIdentity(
    attempt: StoredOidcLoginAttempt,
    token: VerifiedOidcIdentityToken,
    validatedAt: string,
  ): VerifiedIdentity {
    if (token.issuer !== this.configuration.issuer) {
      throw new PersonSessionOidcDiagnosticError("claim_issuer_mismatch");
    }
    try {
      assertOpaqueSubject(token.subject);
    } catch {
      throw new PersonSessionOidcDiagnosticError("claim_subject_invalid");
    }
    const audiences =
      typeof token.audience === "string"
        ? [token.audience]
        : Array.isArray(token.audience)
          ? [...token.audience]
          : [];
    if (
      audiences.length === 0 ||
      audiences.some(
        (audience) => typeof audience !== "string" || audience.length === 0,
      ) ||
      !audiences.includes(this.configuration.client_id) ||
      (audiences.length > 1 &&
        token.authorized_party !== this.configuration.client_id) ||
      (audiences.length === 1 &&
        token.authorized_party !== undefined &&
        token.authorized_party !== this.configuration.client_id)
    ) {
      throw new PersonSessionOidcDiagnosticError("claim_audience_mismatch");
    }
    if (
      typeof token.nonce !== "string" ||
      this.digestUtf8(token.nonce) !== attempt.nonce_sha256
    ) {
      throw new PersonSessionOidcDiagnosticError("claim_nonce_mismatch");
    }
    if (!Number.isSafeInteger(token.issued_at)) {
      throw new PersonSessionOidcDiagnosticError("claim_issued_at_invalid");
    }
    const assertionIssuedAtMilliseconds = token.issued_at * 1000;
    const attemptMilliseconds = timestampMillis(
      attempt.created_at,
      "OIDC attempt creation time",
    );
    const validationMilliseconds = timestampMillis(
      validatedAt,
      "OIDC token validation time",
    );
    if (
      !Number.isSafeInteger(assertionIssuedAtMilliseconds) ||
      assertionIssuedAtMilliseconds <
        attemptMilliseconds - OIDC_ASSERTION_ISSUED_AT_SKEW_MS ||
      assertionIssuedAtMilliseconds >
        validationMilliseconds + OIDC_ASSERTION_ISSUED_AT_SKEW_MS
    ) {
      throw new PersonSessionOidcDiagnosticError("claim_issued_at_invalid");
    }
    if (
      this.configuration.tenant.kind === "claim" &&
      token.claims[this.configuration.tenant.claim_name] !==
        this.configuration.tenant.claim_value
    ) {
      throw new PersonSessionOidcDiagnosticError("claim_tenant_mismatch");
    }
    let bootstrapEmailSha256: Sha256Digest | null = null;
    if (attempt.attempt_purpose === "identity_bootstrap") {
      const email = token.claims["email"];
      if (
        !isCanonicalPersonEmail(email) ||
        token.claims["email_verified"] !== true
      ) {
        throw new PersonSessionOidcDiagnosticError("claim_email_invalid");
      }
      bootstrapEmailSha256 = this.expectedEmailSha256(email);
    }
    return {
      issuer: token.issuer,
      subject: token.subject,
      bootstrap_email_sha256: bootstrapEmailSha256,
      upstream_assertion_issued_at: new Date(
        assertionIssuedAtMilliseconds,
      ).toISOString(),
    };
  }

  private assertSynchronousCommit(value: unknown): void {
    if (
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as { then?: unknown }).then === "function"
    ) {
      throw new Error("Person read audit commit must be synchronous");
    }
  }

  private issueFamily(
    transaction: AuthorityWriteTransaction,
    observedAt: string,
    upstreamAssertionIssuedAt: string,
    binding: StoredOidcIdentityBinding,
    attempt: StoredOidcLoginAttempt,
    familyId: string,
    candidate: SessionCredentialCandidate,
    rotationSequence: number,
  ): CallbackWriteResult {
    const hardReauthenticationAt = addPersonSessionMilliseconds(
      upstreamAssertionIssuedAt,
      PERSON_SESSION_HARD_REAUTHENTICATION_MS,
    );
    if (!isStrictlyBefore(observedAt, hardReauthenticationAt)) {
      return { kind: "denied", reason: "claim_issued_at_invalid" };
    }
    const family = transaction.insertPersonSessionFamily({
      session_family_id: familyId,
      organization_id: binding.organization_id,
      principal_id: binding.principal_id,
      membership_id: binding.membership_id,
      membership_type: binding.membership_type,
      identity_binding_id: binding.identity_binding_id,
      authentication_login_attempt_id: attempt.login_attempt_id,
      upstream_assertion_issued_at: upstreamAssertionIssuedAt,
      tenant_constraint_sha256: attempt.tenant_constraint_sha256,
      oidc_configuration_sha256: attempt.oidc_configuration_sha256,
      hard_reauthentication_at: hardReauthenticationAt,
    });
    return this.issueCredentialPair(
      transaction,
      observedAt,
      family,
      binding,
      candidate,
      rotationSequence,
    );
  }

  private issueCredentialPair(
    transaction: AuthorityWriteTransaction,
    observedAt: string,
    family: StoredPersonSessionFamily,
    binding: StoredOidcIdentityBinding,
    candidate: SessionCredentialCandidate,
    rotationSequence: number,
  ): { kind: "issued"; session: IssuedPersonSession } {
    const accessExpiresAt = earlierTimestamp(
      addPersonSessionMilliseconds(
        observedAt,
        PERSON_ACCESS_CREDENTIAL_LIFETIME_MS,
      ),
      family.hard_reauthentication_at,
    );
    const access: NewPersonSessionCredential = {
      session_credential_id: candidate.access_credential_id,
      session_family_id: family.session_family_id,
      credential_kind: "access",
      rotation_sequence: rotationSequence,
      token_sha256: candidate.access_token_sha256,
      expires_at: accessExpiresAt,
    };
    const refresh: NewPersonSessionCredential = {
      session_credential_id: candidate.refresh_credential_id,
      session_family_id: family.session_family_id,
      credential_kind: "refresh",
      rotation_sequence: rotationSequence,
      token_sha256: candidate.refresh_token_sha256,
      expires_at: family.hard_reauthentication_at,
    };
    transaction.insertPersonSessionCredential(access);
    transaction.insertPersonSessionCredential(refresh);
    return {
      kind: "issued",
      session: {
        organization_id: family.organization_id,
        principal_id: family.principal_id,
        membership_id: family.membership_id,
        membership_type: family.membership_type,
        identity_binding_id: binding.identity_binding_id,
        session_family_id: family.session_family_id,
        access_token: candidate.access_token,
        refresh_token: candidate.refresh_token,
        access_expires_at: accessExpiresAt,
        refresh_expires_at: family.hard_reauthentication_at,
        hard_reauthentication_at: family.hard_reauthentication_at,
      },
    };
  }

  private resolveAccess(
    transaction: AuthorityReadTransaction,
    tokenSha256: Sha256Digest,
    checkedAt: string,
  ): AccessResolution {
    const credential = transaction.personSessionCredential(tokenSha256);
    if (
      credential === undefined ||
      credential.credential_kind !== "access" ||
      credential.consumed_at !== null ||
      credential.revoked_at !== null ||
      !isStrictlyBefore(checkedAt, credential.expires_at)
    ) {
      return { kind: "denied" };
    }
    const family = transaction.personSessionFamily(
      credential.session_family_id,
    );
    if (
      family === undefined ||
      family.status !== "active" ||
      !isStrictlyBefore(checkedAt, family.hard_reauthentication_at)
    ) {
      return { kind: "denied" };
    }
    const binding = transaction.oidcIdentityBindingById(
      family.identity_binding_id,
    );
    if (
      binding === undefined ||
      binding.status !== "active" ||
      !exactPersonTuple(family, binding) ||
      !this.hasActiveExactMembership(transaction, family)
    ) {
      return { kind: "denied" };
    }
    const personStateSha256 = this.digestCanonical({
      schema_version: 1,
      kind: "authority-person-state-v1",
      organization_id: family.organization_id,
      principal_id: family.principal_id,
      membership: {
        membership_id: family.membership_id,
        membership_type: family.membership_type,
        status: "active",
      },
      oidc_identity: {
        identity_binding_id: binding.identity_binding_id,
        issuer: binding.issuer,
        subject: binding.subject,
        status: "active",
      },
    });
    const sessionStateSha256 = this.digestCanonical({
      schema_version: 1,
      kind: "authority-person-session-state-v1",
      family: {
        session_family_id: family.session_family_id,
        identity_binding_id: family.identity_binding_id,
        created_at: family.created_at,
        upstream_assertion_issued_at: family.upstream_assertion_issued_at,
        tenant_constraint_sha256: family.tenant_constraint_sha256,
        oidc_configuration_sha256: family.oidc_configuration_sha256,
        hard_reauthentication_at: family.hard_reauthentication_at,
        status: "active",
      },
      access_credential: {
        token_sha256: credential.token_sha256,
        rotation_sequence: credential.rotation_sequence,
        issued_at: credential.issued_at,
        expires_at: credential.expires_at,
        status: "active",
      },
    });
    return {
      kind: "allowed",
      authorization: {
        organization_id: family.organization_id,
        principal_id: family.principal_id,
        membership_id: family.membership_id,
        membership_type: family.membership_type,
        identity_binding_id: binding.identity_binding_id,
        session_family_id: family.session_family_id,
        access_credential_sha256: credential.token_sha256,
        access_expires_at: credential.expires_at,
        hard_reauthentication_at: family.hard_reauthentication_at,
        person_state_sha256: personStateSha256,
        session_state_sha256: sessionStateSha256,
        checked_at: checkedAt,
      },
    };
  }

  private hasActiveExactMembership(
    transaction: AuthorityReadTransaction,
    binding: AuthorityPersonMembershipBinding,
  ): boolean {
    const membership = transaction.membership(binding.membership_id);
    return (
      membership !== undefined &&
      membership.status === "active" &&
      exactPersonTuple(membership, binding) &&
      transaction.metadata().organization_id === binding.organization_id
    );
  }

  private attemptUsesCurrentConfiguration(
    attempt: StoredOidcLoginAttempt,
  ): boolean {
    return (
      attempt.issuer === this.configuration.issuer &&
      attempt.client_id === this.configuration.client_id &&
      attempt.redirect_uri === this.configuration.redirect_uri &&
      attempt.tenant_constraint_sha256 ===
        this.configuration.tenant_constraint_sha256 &&
      attempt.oidc_configuration_sha256 ===
        this.configuration.oidc_configuration_sha256
    );
  }

  private pkceAuthenticatedData(
    attempt: Pick<
      StoredOidcLoginAttempt,
      | "login_attempt_id"
      | "issuer"
      | "attempt_purpose"
      | "client_id"
      | "redirect_uri"
      | "tenant_constraint_sha256"
      | "oidc_configuration_sha256"
      | "login_grant_sha256"
      | "state_sha256"
      | "nonce_sha256"
      | "created_at"
      | "expires_at"
    >,
  ): Uint8Array {
    return Buffer.from(
      canonicalJson({
        schema_version: 1,
        kind: "authority-oidc-pkce-seal-aad-v1",
        login_attempt_id: attempt.login_attempt_id,
        issuer: attempt.issuer,
        attempt_purpose: attempt.attempt_purpose,
        client_id: attempt.client_id,
        redirect_uri: attempt.redirect_uri,
        tenant_constraint_sha256: attempt.tenant_constraint_sha256,
        oidc_configuration_sha256: attempt.oidc_configuration_sha256,
        login_grant_sha256: attempt.login_grant_sha256,
        state_sha256: attempt.state_sha256,
        nonce_sha256: attempt.nonce_sha256,
        created_at: attempt.created_at,
        expires_at: attempt.expires_at,
      }),
      "utf8",
    );
  }

  private sessionCredentialCandidate(): SessionCredentialCandidate {
    const accessToken = this.secret("access_token");
    const refreshToken = this.secret("refresh_token");
    return {
      access_credential_id: this.localId("psc", "access_credential_id"),
      access_token: accessToken,
      access_token_sha256: this.digestSecret(accessToken),
      refresh_credential_id: this.localId("psc", "refresh_credential_id"),
      refresh_token: refreshToken,
      refresh_token_sha256: this.digestSecret(refreshToken),
    };
  }

  private localId(
    prefix: "ola" | "olc" | "oib" | "psf" | "psc",
    purpose: PersonSessionRandomPurpose,
  ): string {
    const bytes = this.randomBytes(purpose, LOCAL_UUID_BYTES);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Buffer.from(bytes).toString("hex");
    return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
      12,
      16,
    )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private secret(purpose: PersonSessionRandomPurpose): string {
    return Buffer.from(
      this.randomBytes(purpose, PERSON_SESSION_SECRET_BYTES),
    ).toString("base64url");
  }

  private decodeSecret(value: string): Uint8Array {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      !BASE64URL_PATTERN.test(value)
    ) {
      throw personSessionUnauthorized();
    }
    const decoded = Buffer.from(value, "base64url");
    if (
      decoded.length !== PERSON_SESSION_SECRET_BYTES ||
      decoded.toString("base64url") !== value
    ) {
      throw personSessionUnauthorized();
    }
    return Uint8Array.from(decoded);
  }

  private randomBytes(
    purpose: PersonSessionRandomPurpose,
    length: number,
  ): Uint8Array {
    const value = this.runtime.random.bytes(purpose, length);
    if (!(value instanceof Uint8Array) || value.length !== length) {
      throw new Error("person session random source returned invalid bytes");
    }
    return Uint8Array.from(value);
  }

  private digestSecret(value: string): Sha256Digest {
    this.decodeSecret(value);
    return this.digestUtf8(value);
  }

  private digestUtf8(value: string): Sha256Digest {
    return this.digestBytes(this.runtime.hash, Buffer.from(value, "utf8"));
  }

  private digestCanonical(value: unknown): Sha256Digest {
    return this.digestUtf8Unchecked(canonicalJson(value));
  }

  private expectedEmailSha256(expectedEmail: string): Sha256Digest {
    return this.digestCanonical({
      schema_version: 1,
      kind: "authority-person-login-grant-expected-email-v1",
      expected_email: expectedEmail,
    });
  }

  private digestUtf8Unchecked(value: string): Sha256Digest {
    return this.digestBytes(this.runtime.hash, Buffer.from(value, "utf8"));
  }

  private digestBytes(
    hasher: PersonSessionHashPort,
    value: Uint8Array,
  ): Sha256Digest {
    const digest = hasher.sha256(value);
    if (!(digest instanceof Uint8Array) || digest.length !== SHA256_BYTES) {
      throw new Error("person session hash port returned an invalid digest");
    }
    return `sha256:${Buffer.from(digest).toString("hex")}`;
  }

  private pkceChallenge(verifier: string): string {
    const digest = this.runtime.hash.sha256(Buffer.from(verifier, "ascii"));
    if (!(digest instanceof Uint8Array) || digest.length !== SHA256_BYTES) {
      throw new Error("person session hash port returned an invalid digest");
    }
    return Buffer.from(digest).toString("base64url");
  }
}
