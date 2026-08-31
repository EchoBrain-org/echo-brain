import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type {
  AuthorityAuditEntry,
  NewOidcIdentityBinding,
  NewOidcLoginAttempt,
  NewPersonLoginGrant,
  NewPersonSessionCredential,
  NewPersonSessionFamily,
  OidcLoginAttemptCompletion,
  StoredAuthorityMembership,
  StoredAuthorityMetadata,
  StoredOidcIdentityBinding,
  StoredOidcLoginAttempt,
  StoredPersonLoginGrant,
  StoredPersonSessionCredential,
  StoredPersonSessionFamily,
} from "./authority-repository.js";

/** The session-scoped subset of Authority persistence needed for Person sessions. */
export interface PersonSessionReadTransaction {
  metadata(): StoredAuthorityMetadata;
  membership(membershipId: string): StoredAuthorityMembership | undefined;
  oidcIdentityBinding(
    issuer: string,
    subject: string,
  ): StoredOidcIdentityBinding | undefined;
  /** Authentication-only lookup: never resolves a revoked historical tenure. */
  activeOidcIdentityBinding(
    issuer: string,
    subject: string,
  ): StoredOidcIdentityBinding | undefined;
  oidcIdentityBindingById(
    identityBindingId: string,
  ): StoredOidcIdentityBinding | undefined;
  oidcLoginAttempt(
    stateSha256: Sha256Digest,
  ): StoredOidcLoginAttempt | undefined;
  oidcLoginAttemptForLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredOidcLoginAttempt | undefined;
  hasOidcLoginAttemptCapacity(limit: number): boolean;
  personLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredPersonLoginGrant | undefined;
  personSessionFamily(
    sessionFamilyId: string,
  ): StoredPersonSessionFamily | undefined;
  personSessionCredential(
    tokenSha256: Sha256Digest,
  ): StoredPersonSessionCredential | undefined;
  personSessionCredentialsForFamily(
    sessionFamilyId: string,
  ): StoredPersonSessionCredential[];
}

export interface PersonSessionWriteTransaction extends PersonSessionReadTransaction {
  /** Present for the legacy repository only; the session store has no generic audit. */
  appendAudit?(entry: AuthorityAuditEntry): void;
  insertOidcIdentityBinding(
    binding: NewOidcIdentityBinding,
  ): StoredOidcIdentityBinding;
  insertOidcLoginAttempt(attempt: NewOidcLoginAttempt): StoredOidcLoginAttempt;
  claimOidcLoginAttempt(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
  ): StoredOidcLoginAttempt | undefined;
  releaseOidcLoginAttemptClaim(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
  ): boolean;
  completeOidcLoginAttempt(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
    completion: OidcLoginAttemptCompletion,
  ): StoredOidcLoginAttempt | undefined;
  expireOidcLoginAttempts(limit: number): number;
  invalidatePersonLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredPersonLoginGrant | undefined;
  insertPersonLoginGrant(grant: NewPersonLoginGrant): StoredPersonLoginGrant;
  consumePersonLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredPersonLoginGrant | undefined;
  insertPersonSessionFamily(
    family: NewPersonSessionFamily,
  ): StoredPersonSessionFamily;
  insertPersonSessionCredential(
    credential: NewPersonSessionCredential,
  ): StoredPersonSessionCredential;
  consumePersonSessionRefreshCredential(
    tokenSha256: Sha256Digest,
  ): StoredPersonSessionCredential | undefined;
  revokePersonSessionCredential(
    tokenSha256: Sha256Digest,
    reason: string,
  ): boolean;
  revokePersonSessionFamily(sessionFamilyId: string, reason: string): boolean;
}

/**
 * No installation, enrollment, lease, record, or generic-audit capability is
 * exposed here. The session baseline represents a Person login grant by its own
 * durable row, not an additional legacy audit event.
 */
export interface PersonSessionRepository {
  /**
   * `false` means this is the login/session-only store. Legacy callers
   * that need a full Authority transaction leave this absent (treated as true).
   */
  readonly supports_full_person_authorization_transactions?: boolean;
  read<T>(operation: (transaction: PersonSessionReadTransaction) => T): T;
  writeAtLinearization<T>(
    observe: () => string,
    operation: (
      transaction: PersonSessionWriteTransaction,
      observedAt: string,
    ) => T,
  ): T;
}
