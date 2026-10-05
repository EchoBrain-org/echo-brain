import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonIdentitySessionApplication } from '../application/person-identity-sessions.js';

/** Excludes checked_at: a request pins session and membership state, not lookup time. */
export function personToolAuthenticationV1(sessions: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>) {
  return (access_token: string) => {
    const authorization = sessions.authenticateAccess({ access_token });
    return Object.freeze({
      organization_id: authorization.organization_id,
      principal_id: authorization.principal_id,
      membership_id: authorization.membership_id,
      authorization_sha256: canonicalSha256({
        identity_binding_id: authorization.identity_binding_id,
        session_family_id: authorization.session_family_id,
        access_credential_sha256: authorization.access_credential_sha256,
        person_state_sha256: authorization.person_state_sha256,
        session_state_sha256: authorization.session_state_sha256,
      }),
    });
  };
}
