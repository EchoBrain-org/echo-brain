import type {
  BeginPersonOidcLoginInput,
  IssuedPersonLoginGrant,
  IssuedPersonSession,
} from '../application/person-identity-sessions.js';

export const PERSON_SESSION_ADMIN_MEMBERSHIPS_PATH = '/v2/admin/memberships';
export const PERSON_SESSION_OIDC_BEGIN_PATH = '/v2/session/oidc/begin';
export const PERSON_SESSION_OIDC_CALLBACK_PATH = '/v2/session/oidc/callback';
export const PERSON_SESSION_REFRESH_PATH = '/v2/session/refresh';
export const PERSON_SESSION_REVOCATIONS_PATH = '/v2/session/revocations';

export interface BegunPersonOidcHttpLogin {
  authorization_url: string;
  expires_at: string;
}

/** The deliberately small Person-session surface exposed to HTTP. */
export interface PersonIdentitySessionHttpApplication {
  /** Exact configured issuer used to validate an optional callback `iss`. */
  readonly expected_issuer: string;
  issueBootstrapLoginGrant(input: {
    target_membership_id: string;
  }): IssuedPersonLoginGrant | Promise<IssuedPersonLoginGrant>;
  beginOidcLogin(
    input: BeginPersonOidcLoginInput,
  ): BegunPersonOidcHttpLogin | Promise<BegunPersonOidcHttpLogin>;
  completeOidcLogin(input: {
    state: string;
    authorization_code: string;
  }): Promise<IssuedPersonSession>;
  refresh(input: {
    refresh_token: string;
  }): IssuedPersonSession | Promise<IssuedPersonSession>;
  revoke(input: {
    credential_kind: 'access';
    credential: string;
    reason: 'person_logout';
  }): void | Promise<void>;
}
