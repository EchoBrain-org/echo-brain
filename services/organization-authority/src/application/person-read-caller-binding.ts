import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { PersonAccessAuthorization } from './person-identity-sessions.js';
import type {
  PersonReadAuthenticatedEvidence,
  PersonReadOperation,
} from './ports/authority-repository.js';

/**
 * The small, route-neutral value which binds a Person credential to one
 * canonical V2 request.  The request digest covers the operation's complete
 * validated wire document; this preimage adds the fixed authority boundary.
 */
export interface PersonReadCallerBindingInput {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly subject_principal_id: string;
  readonly operation: PersonReadOperation | 'member_exclusions';
  readonly request_sha256: Sha256Digest;
}

export function canonicalPersonReadRequestSha256(
  validatedRequest: unknown,
): Sha256Digest {
  return canonicalSha256(validatedRequest);
}

export function personReadCallerBindingSha256(
  input: PersonReadCallerBindingInput,
  authorization: PersonAccessAuthorization,
): Sha256Digest {
  return canonicalSha256({
    schema_version: 2,
    kind: 'echo-authority-person-read-caller-binding-v2',
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    subject_principal_id: input.subject_principal_id,
    operation: input.operation,
    request_sha256: input.request_sha256,
    principal_id: authorization.principal_id,
    membership_id: authorization.membership_id,
    membership_type: authorization.membership_type,
    identity_binding_id: authorization.identity_binding_id,
    session_family_id: authorization.session_family_id,
    access_credential_sha256: authorization.access_credential_sha256,
    person_state_sha256: authorization.person_state_sha256,
    session_state_sha256: authorization.session_state_sha256,
  });
}

export function personReadAuthenticatedEvidence(
  authorization: PersonAccessAuthorization,
  callerBinding: PersonReadCallerBindingInput,
): PersonReadAuthenticatedEvidence {
  return {
    organization_id: authorization.organization_id,
    principal_id: authorization.principal_id,
    membership_id: authorization.membership_id,
    membership_type: authorization.membership_type,
    identity_binding_id: authorization.identity_binding_id,
    session_family_id: authorization.session_family_id,
    access_credential_sha256: authorization.access_credential_sha256,
    caller_binding_sha256: personReadCallerBindingSha256(
      callerBinding,
      authorization,
    ),
    person_state_sha256: authorization.person_state_sha256,
    session_state_sha256: authorization.session_state_sha256,
  };
}
