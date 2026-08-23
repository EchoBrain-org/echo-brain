import {
  canonicalJson,
  parseCanonicalJson,
} from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  organizationAuthorityPinSha256,
  validateOrganizationAuthorityDescriptor,
} from "@echo-brain/organization-protocol";
import type Database from "better-sqlite3";
import type {
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
} from "../../../application/ports/authority-repository.js";
import type {
  PersonSessionReadTransaction,
  PersonSessionRepository,
  PersonSessionWriteTransaction,
} from "../../../application/ports/person-session-repository.js";
import type {
  CleanEmployeeRosterEntry,
  CleanPersonMembershipWriteRepository,
  CleanPersonMembershipWriteTransaction,
} from "../../../application/ports/clean-person-membership-write.js";

type MetadataRow = {
  authority_id: string;
  organization_id: string;
  organization_display_name: string;
  descriptor_json: string;
  created_at: string;
  last_observed_at: string;
};

type MembershipRow = {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  display_name: string;
  membership_type: "owner" | "employee";
  status: "active" | "revoked";
  provisioned_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
};

type EmployeeRosterRow = {
  email: string;
  display_name: string;
  membership_status: "active" | "revoked";
  invitation_state: "pending" | "expired" | "redeemed" | "none";
};

type OidcBindingRow = {
  identity_binding_id: string;
  issuer: string;
  subject: string;
  tenant_constraint_sha256: string;
  oidc_configuration_sha256: string;
  initial_login_attempt_id: string;
  initial_login_grant_sha256: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: "owner" | "employee";
  status: "active" | "revoked";
  bound_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
};

type OidcAttemptRow = {
  login_attempt_id: string;
  issuer: string;
  attempt_purpose: "identity_bootstrap" | "existing_identity_login";
  client_id: string;
  redirect_uri: string;
  tenant_constraint_sha256: string;
  oidc_configuration_sha256: string;
  login_grant_sha256: string | null;
  state_sha256: string;
  nonce_sha256: string;
  pkce_verifier_seal_key_id: string | null;
  pkce_verifier_sealed: Uint8Array | null;
  created_at: string;
  expires_at: string;
  redemption_claim_id: string | null;
  redemption_claimed_at: string | null;
  terminal_outcome: "succeeded" | "denied" | "expired" | null;
  completed_at: string | null;
  resolved_identity_binding_id: string | null;
  upstream_assertion_issued_at: string | null;
};

type GrantRow = {
  login_grant_sha256: string;
  grant_purpose: "oidc_identity_bootstrap";
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: "owner" | "employee";
  expected_issuer: string;
  expected_email_sha256: string;
  oidc_configuration_sha256: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  invalidated_at: string | null;
};

type FamilyRow = {
  session_family_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: "owner" | "employee";
  identity_binding_id: string;
  authentication_login_attempt_id: string;
  created_at: string;
  upstream_assertion_issued_at: string;
  tenant_constraint_sha256: string;
  oidc_configuration_sha256: string;
  hard_reauthentication_at: string;
  status: "active" | "revoked";
  revoked_at: string | null;
  revocation_reason: string | null;
};

type CredentialRow = {
  session_credential_id: string;
  session_family_id: string;
  credential_kind: "access" | "refresh";
  rotation_sequence: number;
  token_sha256: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
};

function digest(value: string): Sha256Digest {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error("clean Person session database contains an invalid digest");
  }
  return value as Sha256Digest;
}

function metadata(row: MetadataRow): StoredAuthorityMetadata {
  const descriptor = validateOrganizationAuthorityDescriptor(
    parseCanonicalJson(row.descriptor_json),
  );
  if (canonicalJson(descriptor) !== row.descriptor_json) {
    throw new Error("clean Authority descriptor is not canonical");
  }
  return Object.freeze({
    authority_id: row.authority_id,
    organization_id: row.organization_id,
    organization_display_name: row.organization_display_name,
    authority_pin_sha256: organizationAuthorityPinSha256(descriptor),
    descriptor,
    created_at: row.created_at,
    last_observed_at: row.last_observed_at,
  });
}

function membership(row: MembershipRow): StoredAuthorityMembership {
  return Object.freeze({
    ...row,
    admin_command_id: null,
    admin_command_sha256: null,
  });
}

function binding(row: OidcBindingRow): StoredOidcIdentityBinding {
  return Object.freeze({
    ...row,
    tenant_constraint_sha256: digest(row.tenant_constraint_sha256),
    oidc_configuration_sha256: digest(row.oidc_configuration_sha256),
    initial_login_grant_sha256: digest(row.initial_login_grant_sha256),
  });
}

function attempt(row: OidcAttemptRow): StoredOidcLoginAttempt {
  return Object.freeze({
    ...row,
    tenant_constraint_sha256: digest(row.tenant_constraint_sha256),
    oidc_configuration_sha256: digest(row.oidc_configuration_sha256),
    login_grant_sha256:
      row.login_grant_sha256 === null ? null : digest(row.login_grant_sha256),
    state_sha256: digest(row.state_sha256),
    nonce_sha256: digest(row.nonce_sha256),
    pkce_verifier_sealed:
      row.pkce_verifier_sealed === null
        ? null
        : Uint8Array.from(row.pkce_verifier_sealed),
    upstream_assertion_issued_at: row.upstream_assertion_issued_at,
  });
}

function grant(row: GrantRow): StoredPersonLoginGrant {
  return Object.freeze({
    ...row,
    login_grant_sha256: digest(row.login_grant_sha256),
    expected_email_sha256: digest(row.expected_email_sha256),
    oidc_configuration_sha256: digest(row.oidc_configuration_sha256),
  });
}

function family(row: FamilyRow): StoredPersonSessionFamily {
  return Object.freeze({
    ...row,
    tenant_constraint_sha256: digest(row.tenant_constraint_sha256),
    oidc_configuration_sha256: digest(row.oidc_configuration_sha256),
    upstream_assertion_issued_at: row.upstream_assertion_issued_at,
  });
}

function credential(row: CredentialRow): StoredPersonSessionCredential {
  return Object.freeze({ ...row, token_sha256: digest(row.token_sha256) });
}

class Transaction implements PersonSessionWriteTransaction {
  constructor(
    private readonly database: Database.Database,
    private readonly observedAt: string | undefined,
  ) {}

  metadata(): StoredAuthorityMetadata {
    const row = this.database
      .prepare(
        `SELECT authority_id, organization_id, organization_display_name, descriptor_json, created_at, last_observed_at FROM authority_metadata WHERE singleton = 1`,
      )
      .get() as MetadataRow | undefined;
    if (row === undefined)
      throw new Error("clean Authority metadata is missing");
    return metadata(row);
  }

  membership(membershipId: string): StoredAuthorityMembership | undefined {
    const row = this.database
      .prepare(
        `SELECT membership.organization_id, membership.principal_id, membership.membership_id, principal.display_name, membership.membership_type, membership.status, membership.provisioned_at, membership.revoked_at, membership.revocation_reason FROM authority_memberships AS membership JOIN authority_principals AS principal ON principal.principal_id = membership.principal_id WHERE membership.membership_id = ?`,
      )
      .get(membershipId) as MembershipRow | undefined;
    return row === undefined ? undefined : membership(row);
  }

  employeeMembershipByEmailSha256(
    emailSha256: Sha256Digest,
  ): StoredAuthorityMembership | undefined {
    const row = this.database
      .prepare(
        `SELECT membership.organization_id, membership.principal_id, membership.membership_id, principal.display_name, membership.membership_type, membership.status, membership.provisioned_at, membership.revoked_at, membership.revocation_reason FROM authority_memberships AS membership JOIN authority_principals AS principal ON principal.principal_id = membership.principal_id WHERE membership.employee_email_sha256 = ? AND membership.membership_type = 'employee' ORDER BY CASE membership.status WHEN 'active' THEN 0 ELSE 1 END, membership.provisioned_at DESC LIMIT 1`,
      )
      .get(emailSha256) as MembershipRow | undefined;
    return row === undefined ? undefined : membership(row);
  }

  employeeMembershipHasActiveIdentityBinding(membershipId: string): boolean {
    return this.database
      .prepare(
        `SELECT 1 FROM authority_oidc_identity_bindings
          WHERE membership_id = ? AND membership_type = 'employee'
            AND status = 'active'
          LIMIT 1`,
      )
      .get(membershipId) !== undefined;
  }

  listEmployeeRoster(observedAt: string): readonly CleanEmployeeRosterEntry[] {
    const rows = this.database
      .prepare(
        `SELECT membership.employee_email AS email,
                principal.display_name AS display_name,
                membership.status AS membership_status,
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM authority_oidc_identity_bindings AS binding
                     WHERE binding.membership_id = membership.membership_id
                       AND binding.status = 'active'
                  ) THEN 'redeemed'
                  WHEN EXISTS (
                    SELECT 1 FROM authority_person_login_grants AS pending
                     WHERE pending.membership_id = membership.membership_id
                       AND pending.consumed_at IS NULL
                       AND pending.invalidated_at IS NULL
                       AND pending.expires_at > ?
                  ) THEN 'pending'
                  WHEN EXISTS (
                    SELECT 1 FROM authority_person_login_grants AS expired
                     WHERE expired.membership_id = membership.membership_id
                       AND expired.consumed_at IS NULL
                       AND expired.invalidated_at IS NULL
                       AND expired.expires_at <= ?
                  ) THEN 'expired'
                  ELSE 'none'
                END AS invitation_state
           FROM authority_memberships AS membership
           JOIN authority_principals AS principal
             ON principal.principal_id = membership.principal_id
          WHERE membership.membership_type = 'employee'
            AND membership.membership_id = (
              SELECT candidate.membership_id
                FROM authority_memberships AS candidate
               WHERE candidate.organization_id = membership.organization_id
                 AND candidate.membership_type = 'employee'
                 AND candidate.employee_email_sha256 = membership.employee_email_sha256
               ORDER BY (candidate.status = 'active') DESC,
                        candidate.provisioned_at DESC,
                        candidate.membership_id DESC
               LIMIT 1
            )
          ORDER BY membership.provisioned_at DESC, membership.membership_id DESC`,
      )
      .all(observedAt, observedAt) as EmployeeRosterRow[];
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  }

  createEmployeeMembership(input: {
    principal_id: string;
    membership_id: string;
    display_name: string;
    email: string;
    email_sha256: Sha256Digest;
  }): StoredAuthorityMembership {
    const now = this.writeTime();
    const metadata = this.metadata();
    this.database
      .prepare(
        `INSERT INTO authority_principals (principal_id, organization_id, display_name, provisioned_at) VALUES (?, ?, ?, ?)`,
      )
      .run(input.principal_id, metadata.organization_id, input.display_name, now);
    this.database
      .prepare(
        `INSERT INTO authority_memberships (membership_id, organization_id, principal_id, membership_type, status, provisioned_at, revoked_at, revocation_reason, employee_email, employee_email_sha256) VALUES (?, ?, ?, 'employee', 'active', ?, NULL, NULL, ?, ?)`,
      )
      .run(
        input.membership_id,
        metadata.organization_id,
        input.principal_id,
        now,
        input.email,
        input.email_sha256,
      );
    const stored = this.membership(input.membership_id);
    if (stored === undefined)
      throw new Error("clean employee membership insert did not persist");
    return stored;
  }

  invalidatePendingPersonLoginGrants(membershipId: string): number {
    const now = this.writeTime();
    return this.database
      .prepare(
        `UPDATE authority_person_login_grants SET invalidated_at = ? WHERE membership_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?`,
      )
      .run(now, membershipId, now).changes;
  }

  revokeEmployeeMembership(
    membershipId: string,
    reason: "owner_revoked_employee",
  ): StoredAuthorityMembership | undefined {
    const now = this.writeTime();
    const changed = this.database
      .prepare(
        `UPDATE authority_memberships SET status = 'revoked', revoked_at = ?, revocation_reason = ? WHERE membership_id = ? AND membership_type = 'employee' AND status = 'active'`,
      )
      .run(now, reason, membershipId).changes;
    return changed === 1 ? this.membership(membershipId) : undefined;
  }

  oidcIdentityBinding(
    issuer: string,
    subject: string,
  ): StoredOidcIdentityBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_oidc_identity_bindings WHERE issuer = ? AND subject = ?`,
      )
      .get(issuer, subject) as OidcBindingRow | undefined;
    return row === undefined ? undefined : binding(row);
  }

  activeOidcIdentityBinding(
    issuer: string,
    subject: string,
  ): StoredOidcIdentityBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_oidc_identity_bindings WHERE issuer = ? AND subject = ? AND status = 'active'`,
      )
      .get(issuer, subject) as OidcBindingRow | undefined;
    return row === undefined ? undefined : binding(row);
  }

  oidcIdentityBindingById(
    identityBindingId: string,
  ): StoredOidcIdentityBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_oidc_identity_bindings WHERE identity_binding_id = ?`,
      )
      .get(identityBindingId) as OidcBindingRow | undefined;
    return row === undefined ? undefined : binding(row);
  }

  oidcLoginAttempt(
    stateSha256: Sha256Digest,
  ): StoredOidcLoginAttempt | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_oidc_login_attempts WHERE state_sha256 = ?`,
      )
      .get(stateSha256) as OidcAttemptRow | undefined;
    return row === undefined ? undefined : attempt(row);
  }

  oidcLoginAttemptForLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredOidcLoginAttempt | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_oidc_login_attempts WHERE login_grant_sha256 = ?`,
      )
      .get(loginGrantSha256) as OidcAttemptRow | undefined;
    return row === undefined ? undefined : attempt(row);
  }

  personLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredPersonLoginGrant | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_person_login_grants WHERE login_grant_sha256 = ?`,
      )
      .get(loginGrantSha256) as GrantRow | undefined;
    return row === undefined ? undefined : grant(row);
  }

  personSessionFamily(
    sessionFamilyId: string,
  ): StoredPersonSessionFamily | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_person_session_families WHERE session_family_id = ?`,
      )
      .get(sessionFamilyId) as FamilyRow | undefined;
    return row === undefined ? undefined : family(row);
  }

  personSessionCredential(
    tokenSha256: Sha256Digest,
  ): StoredPersonSessionCredential | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_person_session_credentials WHERE token_sha256 = ?`,
      )
      .get(tokenSha256) as CredentialRow | undefined;
    return row === undefined ? undefined : credential(row);
  }

  personSessionCredentialsForFamily(
    sessionFamilyId: string,
  ): StoredPersonSessionCredential[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM authority_person_session_credentials WHERE session_family_id = ? ORDER BY credential_kind, rotation_sequence`,
        )
        .all(sessionFamilyId) as CredentialRow[]
    ).map(credential);
  }

  private writeTime(): string {
    if (this.observedAt === undefined)
      throw new Error("clean Person session write time is unavailable");
    return this.observedAt;
  }

  insertOidcIdentityBinding(
    value: NewOidcIdentityBinding,
  ): StoredOidcIdentityBinding {
    const now = this.writeTime();
    this.database
      .prepare(
        `INSERT INTO authority_oidc_identity_bindings (identity_binding_id, issuer, subject, tenant_constraint_sha256, oidc_configuration_sha256, initial_login_attempt_id, initial_login_grant_sha256, organization_id, principal_id, membership_id, membership_type, status, bound_at, revoked_at, revocation_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL)`,
      )
      .run(
        value.identity_binding_id,
        value.issuer,
        value.subject,
        value.tenant_constraint_sha256,
        value.oidc_configuration_sha256,
        value.initial_login_attempt_id,
        value.initial_login_grant_sha256,
        value.organization_id,
        value.principal_id,
        value.membership_id,
        value.membership_type,
        now,
      );
    const stored = this.oidcIdentityBindingById(value.identity_binding_id);
    if (stored === undefined)
      throw new Error("clean OIDC identity binding insert did not persist");
    return stored;
  }

  insertOidcLoginAttempt(value: NewOidcLoginAttempt): StoredOidcLoginAttempt {
    const now = this.writeTime();
    this.database
      .prepare(
        `INSERT INTO authority_oidc_login_attempts (login_attempt_id, issuer, attempt_purpose, client_id, redirect_uri, tenant_constraint_sha256, oidc_configuration_sha256, login_grant_sha256, state_sha256, nonce_sha256, pkce_verifier_seal_key_id, pkce_verifier_sealed, created_at, expires_at, redemption_claim_id, redemption_claimed_at, terminal_outcome, completed_at, resolved_identity_binding_id, upstream_assertion_issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(
        value.login_attempt_id,
        value.issuer,
        value.attempt_purpose,
        value.client_id,
        value.redirect_uri,
        value.tenant_constraint_sha256,
        value.oidc_configuration_sha256,
        value.login_grant_sha256,
        value.state_sha256,
        value.nonce_sha256,
        value.sealed_pkce_verifier.key_id,
        Buffer.from(value.sealed_pkce_verifier.sealed_bytes),
        now,
        value.expires_at,
      );
    const stored = this.oidcLoginAttempt(value.state_sha256);
    if (stored === undefined)
      throw new Error("clean OIDC login attempt insert did not persist");
    return stored;
  }

  claimOidcLoginAttempt(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
  ): StoredOidcLoginAttempt | undefined {
    const now = this.writeTime();
    const changed = this.database
      .prepare(
        `UPDATE authority_oidc_login_attempts SET redemption_claim_id = ?, redemption_claimed_at = ? WHERE state_sha256 = ? AND terminal_outcome IS NULL AND redemption_claim_id IS NULL AND expires_at > ?`,
      )
      .run(redemptionClaimId, now, stateSha256, now).changes;
    return changed === 1 ? this.oidcLoginAttempt(stateSha256) : undefined;
  }

  releaseOidcLoginAttemptClaim(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE authority_oidc_login_attempts SET redemption_claim_id = NULL, redemption_claimed_at = NULL WHERE state_sha256 = ? AND redemption_claim_id = ? AND terminal_outcome IS NULL`,
        )
        .run(stateSha256, redemptionClaimId).changes === 1
    );
  }

  completeOidcLoginAttempt(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
    completion: OidcLoginAttemptCompletion,
  ): StoredOidcLoginAttempt | undefined {
    const now = this.writeTime();
    const succeeded = completion.outcome === "succeeded";
    const changed = this.database
      .prepare(
        `UPDATE authority_oidc_login_attempts SET redemption_claim_id = NULL, redemption_claimed_at = NULL, terminal_outcome = ?, completed_at = ?, resolved_identity_binding_id = ?, upstream_assertion_issued_at = ?, pkce_verifier_seal_key_id = NULL, pkce_verifier_sealed = NULL WHERE state_sha256 = ? AND redemption_claim_id = ? AND terminal_outcome IS NULL AND expires_at > ?`,
      )
      .run(
        completion.outcome,
        now,
        succeeded ? completion.resolved_identity_binding_id : null,
        succeeded ? completion.upstream_assertion_issued_at : null,
        stateSha256,
        redemptionClaimId,
        now,
      ).changes;
    return changed === 1 ? this.oidcLoginAttempt(stateSha256) : undefined;
  }

  expireOidcLoginAttempts(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error("clean OIDC expiry limit is invalid");
    const now = this.writeTime();
    const rows = this.database
      .prepare(
        `SELECT state_sha256 FROM authority_oidc_login_attempts WHERE terminal_outcome IS NULL AND expires_at <= ? ORDER BY expires_at, state_sha256 LIMIT ?`,
      )
      .all(now, limit) as Array<{ state_sha256: string }>;
    for (const row of rows) {
      this.database
        .prepare(
          `UPDATE authority_oidc_login_attempts SET redemption_claim_id = NULL, redemption_claimed_at = NULL, terminal_outcome = 'expired', completed_at = ?, pkce_verifier_seal_key_id = NULL, pkce_verifier_sealed = NULL WHERE state_sha256 = ? AND terminal_outcome IS NULL`,
        )
        .run(now, row.state_sha256);
    }
    return rows.length;
  }

  insertPersonLoginGrant(value: NewPersonLoginGrant): StoredPersonLoginGrant {
    const now = this.writeTime();
    this.database
      .prepare(
        `INSERT INTO authority_person_login_grants (login_grant_sha256, grant_purpose, organization_id, principal_id, membership_id, membership_type, expected_issuer, expected_email_sha256, oidc_configuration_sha256, issued_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        value.login_grant_sha256,
        value.grant_purpose,
        value.organization_id,
        value.principal_id,
        value.membership_id,
        value.membership_type,
        value.expected_issuer,
        value.expected_email_sha256,
        value.oidc_configuration_sha256,
        now,
        value.expires_at,
      );
    const stored = this.personLoginGrant(value.login_grant_sha256);
    if (stored === undefined)
      throw new Error("clean Person login grant insert did not persist");
    return stored;
  }

  consumePersonLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredPersonLoginGrant | undefined {
    const now = this.writeTime();
    const changed = this.database
      .prepare(
        `UPDATE authority_person_login_grants SET consumed_at = ? WHERE login_grant_sha256 = ? AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?`,
      )
      .run(now, loginGrantSha256, now).changes;
    return changed === 1 ? this.personLoginGrant(loginGrantSha256) : undefined;
  }

  insertPersonSessionFamily(
    value: NewPersonSessionFamily,
  ): StoredPersonSessionFamily {
    const now = this.writeTime();
    this.database
      .prepare(
        `INSERT INTO authority_person_session_families (session_family_id, organization_id, principal_id, membership_id, membership_type, identity_binding_id, authentication_login_attempt_id, created_at, upstream_assertion_issued_at, tenant_constraint_sha256, oidc_configuration_sha256, hard_reauthentication_at, status, revoked_at, revocation_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL)`,
      )
      .run(
        value.session_family_id,
        value.organization_id,
        value.principal_id,
        value.membership_id,
        value.membership_type,
        value.identity_binding_id,
        value.authentication_login_attempt_id,
        now,
        value.upstream_assertion_issued_at,
        value.tenant_constraint_sha256,
        value.oidc_configuration_sha256,
        value.hard_reauthentication_at,
      );
    const stored = this.personSessionFamily(value.session_family_id);
    if (stored === undefined)
      throw new Error("clean Person session family insert did not persist");
    return stored;
  }

  insertPersonSessionCredential(
    value: NewPersonSessionCredential,
  ): StoredPersonSessionCredential {
    const now = this.writeTime();
    this.database
      .prepare(
        `INSERT INTO authority_person_session_credentials (session_credential_id, session_family_id, credential_kind, rotation_sequence, token_sha256, issued_at, expires_at, consumed_at, revoked_at, revocation_reason) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        value.session_credential_id,
        value.session_family_id,
        value.credential_kind,
        value.rotation_sequence,
        value.token_sha256,
        now,
        value.expires_at,
      );
    const stored = this.personSessionCredential(value.token_sha256);
    if (stored === undefined)
      throw new Error("clean Person session credential insert did not persist");
    return stored;
  }

  consumePersonSessionRefreshCredential(
    tokenSha256: Sha256Digest,
  ): StoredPersonSessionCredential | undefined {
    const now = this.writeTime();
    const changed = this.database
      .prepare(
        `UPDATE authority_person_session_credentials SET consumed_at = ? WHERE token_sha256 = ? AND credential_kind = 'refresh' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(now, tokenSha256, now).changes;
    return changed === 1
      ? this.personSessionCredential(tokenSha256)
      : undefined;
  }

  revokePersonSessionCredential(
    tokenSha256: Sha256Digest,
    reason: string,
  ): boolean {
    const now = this.writeTime();
    return (
      this.database
        .prepare(
          `UPDATE authority_person_session_credentials SET revoked_at = ?, revocation_reason = ? WHERE token_sha256 = ? AND revoked_at IS NULL`,
        )
        .run(now, reason, tokenSha256).changes === 1
    );
  }

  revokePersonSessionFamily(sessionFamilyId: string, reason: string): boolean {
    const now = this.writeTime();
    return (
      this.database
        .prepare(
          `UPDATE authority_person_session_families SET status = 'revoked', revoked_at = ?, revocation_reason = ? WHERE session_family_id = ? AND status = 'active'`,
        )
        .run(now, reason, sessionFamilyId).changes === 1
    );
  }
}

/** Migration-free adapter for a fresh Authority baseline only. */
export class SqliteCleanPersonSessionRepository
  implements PersonSessionRepository, CleanPersonMembershipWriteRepository
{
  readonly supports_full_person_authorization_transactions = false;

  constructor(private readonly database: Database.Database) {}

  read<T>(operation: (transaction: PersonSessionReadTransaction) => T): T {
    return operation(new Transaction(this.database, undefined));
  }

  writeAtLinearization<T>(
    observe: () => string,
    operation: (
      transaction: PersonSessionWriteTransaction,
      observedAt: string,
    ) => T,
  ): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const observedAt = observe();
      const current = new Transaction(this.database, observedAt).metadata();
      if (observedAt < current.last_observed_at) {
        throw new Error("clean Authority clock regressed since the last write");
      }
      const result = operation(
        new Transaction(this.database, observedAt),
        observedAt,
      );
      this.database
        .prepare(
          `UPDATE authority_metadata SET last_observed_at = ? WHERE singleton = 1`,
        )
        .run(observedAt);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  writeMembershipAtLinearization<T>(
    observe: () => string,
    operation: (
      transaction: CleanPersonMembershipWriteTransaction,
      observedAt: string,
    ) => T,
  ): T {
    return this.writeAtLinearization(observe, (transaction, observedAt) =>
      operation(transaction as Transaction, observedAt),
    );
  }
}
