import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { AuthorityClock } from "./runtime-ports.js";

export type PersonSessionRandomPurpose =
  | "login_grant"
  | "login_attempt_id"
  | "oidc_redemption_claim_id"
  | "oidc_state"
  | "oidc_nonce"
  | "pkce_verifier"
  | "identity_binding_id"
  | "session_family_id"
  | "access_credential_id"
  | "access_token"
  | "refresh_credential_id"
  | "refresh_token";

export interface PersonSessionHashPort {
  sha256(value: Uint8Array): Uint8Array;
}

export interface PersonSessionRandomSource {
  bytes(purpose: PersonSessionRandomPurpose, length: number): Uint8Array;
}

export interface PersonSessionPkceSeal {
  key_id: string;
  sealed_bytes: Uint8Array;
}

export interface PersonSessionPkceSealer {
  seal(input: {
    plaintext: Uint8Array;
    authenticated_data: Uint8Array;
  }): PersonSessionPkceSeal;
  unseal(input: {
    key_id: string;
    sealed_bytes: Uint8Array;
    authenticated_data: Uint8Array;
  }): Uint8Array;
}

export type OidcTenantConstraint =
  | { kind: "issuer" }
  | { kind: "claim"; claim_name: string; claim_value: string };

export interface PersonSessionOidcConfiguration {
  issuer: string;
  client_id: string;
  redirect_uri: string;
  tenant: OidcTenantConstraint;
  id_token_algorithms: readonly string[];
}

export interface FrozenPersonSessionOidcConfiguration extends PersonSessionOidcConfiguration {
  tenant_constraint_sha256: Sha256Digest;
  oidc_configuration_sha256: Sha256Digest;
}

export interface VerifiedOidcIdentityToken {
  issuer: string;
  subject: string;
  audience: string | readonly string[];
  authorized_party?: unknown;
  nonce: string;
  /** Raw OIDC `iat` NumericDate, in seconds. */
  issued_at: number;
  claims: Readonly<Record<string, unknown>>;
}

export type OidcAuthorizationCodeResult =
  | { kind: "verified"; token: VerifiedOidcIdentityToken }
  /** Failure known before the authorization code could have been redeemed. */
  | { kind: "retryable_before_redemption" }
  /** Redemption or verification reached a terminal, non-replayable result. */
  | { kind: "terminal_failure" };

export interface PersonSessionOidcProvider {
  /**
   * Redeems and cryptographically verifies one code. Upstream tokens and the
   * ID-token bytes remain inside this request-local adapter call. The adapter
   * must return `retryable_before_redemption` only when it knows redemption did
   * not occur. Throws, unknown results, and every failure after redemption may
   * have begun are conservatively terminalized by the application.
   */
  redeemAuthorizationCode(input: {
    configuration: FrozenPersonSessionOidcConfiguration;
    authorization_code: string;
    pkce_verifier: string;
  }): Promise<OidcAuthorizationCodeResult>;
}

export interface PersonSessionRuntime {
  clock: AuthorityClock;
  random: PersonSessionRandomSource;
  hash: PersonSessionHashPort;
  pkce_sealer: PersonSessionPkceSealer;
  oidc_provider: PersonSessionOidcProvider;
}
