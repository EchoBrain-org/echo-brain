import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationMembershipTypeV1,
} from "@echo-brain/organization-protocol";

export interface StoredAuthorityMetadata {
  authority_id: string;
  organization_id: string;
  organization_display_name: string;
  authority_pin_sha256: Sha256Digest;
  descriptor: OrganizationAuthorityDescriptorV1;
  created_at: string;
  last_observed_at: string;
}

export interface StoredAuthorityMembership {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  display_name: string;
  membership_type: OrganizationMembershipTypeV1;
  status: 'active' | 'revoked';
  provisioned_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  /** Null only for rows created before the retry-safe admin API. */
  admin_command_id: string | null;
  /** Canonical hash of the complete admin command, including its target. */
  admin_command_sha256: Sha256Digest | null;
}

export interface AuthorityPersonMembershipBinding {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: OrganizationMembershipTypeV1;
}

export interface StoredOidcIdentityBinding
  extends AuthorityPersonMembershipBinding {
  identity_binding_id: string;
  issuer: string;
  subject: string;
  tenant_constraint_sha256: Sha256Digest;
  oidc_configuration_sha256: Sha256Digest;
  initial_login_attempt_id: string;
  initial_login_grant_sha256: Sha256Digest;
  status: 'active' | 'revoked';
  bound_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

export type NewOidcIdentityBinding = Omit<
  StoredOidcIdentityBinding,
  'status' | 'bound_at' | 'revoked_at' | 'revocation_reason'
>;

/**
 * An application-sealed PKCE verifier envelope. A raw byte array cannot be
 * supplied where durable, authenticated ciphertext is required.
 */
export interface SealedPkceVerifier {
  key_id: string;
  sealed_bytes: Uint8Array;
}

export type OidcLoginAttemptTerminalOutcome =
  | 'succeeded'
  | 'denied'
  | 'expired';

export interface StoredOidcLoginAttempt {
  login_attempt_id: string;
  issuer: string;
  attempt_purpose: 'identity_bootstrap' | 'existing_identity_login';
  client_id: string;
  redirect_uri: string;
  tenant_constraint_sha256: Sha256Digest;
  oidc_configuration_sha256: Sha256Digest;
  /** Null when an already-bound identity starts the attempt. */
  login_grant_sha256: Sha256Digest | null;
  state_sha256: Sha256Digest;
  nonce_sha256: Sha256Digest;
  pkce_verifier_seal_key_id: string | null;
  /** Ciphertext/sealed bytes only. The repository never accepts a verifier. */
  pkce_verifier_sealed: Uint8Array | null;
  created_at: string;
  expires_at: string;
  redemption_claim_id: string | null;
  redemption_claimed_at: string | null;
  terminal_outcome: OidcLoginAttemptTerminalOutcome | null;
  completed_at: string | null;
  resolved_identity_binding_id: string | null;
  upstream_assertion_issued_at: string | null;
}

export type NewOidcLoginAttempt = Omit<
  StoredOidcLoginAttempt,
  | 'created_at'
  | 'terminal_outcome'
  | 'redemption_claim_id'
  | 'redemption_claimed_at'
  | 'completed_at'
  | 'resolved_identity_binding_id'
  | 'upstream_assertion_issued_at'
  | 'pkce_verifier_seal_key_id'
  | 'pkce_verifier_sealed'
> & {
  sealed_pkce_verifier: SealedPkceVerifier;
};

export type OidcLoginAttemptCompletion =
  | {
      outcome: 'succeeded';
      resolved_identity_binding_id: string;
      upstream_assertion_issued_at: string;
    }
  | { outcome: 'denied' };

export interface StoredPersonLoginGrant
  extends AuthorityPersonMembershipBinding {
  login_grant_sha256: Sha256Digest;
  grant_purpose: 'oidc_identity_bootstrap';
  /** Exact issuer this bootstrap grant permits; no subject is known yet. */
  expected_issuer: string;
  /** Domain-separated digest of the canonical invited work email. */
  expected_email_sha256: Sha256Digest;
  oidc_configuration_sha256: Sha256Digest;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  /** Pending grants can be invalidated by a safe reissue or membership revoke. */
  invalidated_at: string | null;
}

export type NewPersonLoginGrant = Omit<
  StoredPersonLoginGrant,
  'issued_at' | 'consumed_at' | 'invalidated_at'
>;

export interface StoredPersonSessionFamily
  extends AuthorityPersonMembershipBinding {
  session_family_id: string;
  identity_binding_id: string;
  authentication_login_attempt_id: string;
  created_at: string;
  upstream_assertion_issued_at: string;
  tenant_constraint_sha256: Sha256Digest;
  oidc_configuration_sha256: Sha256Digest;
  hard_reauthentication_at: string;
  status: 'active' | 'revoked';
  revoked_at: string | null;
  revocation_reason: string | null;
}

export type NewPersonSessionFamily = Omit<
  StoredPersonSessionFamily,
  'created_at' | 'status' | 'revoked_at' | 'revocation_reason'
>;

export type PersonSessionCredentialKind = 'access' | 'refresh';

export interface StoredPersonSessionCredential {
  session_credential_id: string;
  session_family_id: string;
  credential_kind: PersonSessionCredentialKind;
  rotation_sequence: number;
  token_sha256: Sha256Digest;
  issued_at: string;
  expires_at: string;
  /** Non-null only after a refresh credential has been used for rotation. */
  consumed_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}

export type NewPersonSessionCredential = Omit<
  StoredPersonSessionCredential,
  'issued_at' | 'consumed_at' | 'revoked_at' | 'revocation_reason'
>;
