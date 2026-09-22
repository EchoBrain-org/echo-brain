import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import {
  validatePersonUpdateSubmitV2,
  validateProjectContextAssociateV1,
  validateProjectContextDissociateV1,
  validateProjectCreateV1,
  validateProjectMemberRemoveV1,
  validateProjectMemberSetV1,
} from '@echo-brain/organization-api';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import type { ProjectMutationV1 } from './ports/project-context-v1.js';

export interface ProjectCommandIdentityV1 {
  readonly organization_id: string;
  readonly membership_id: string;
  readonly request_id: string;
  readonly command_sha256: Sha256Digest;
}

/**
 * Frozen PC-00 replay contract shared by PC-01 persistence and PC-02 admission.
 * The key does not include operation: reusing a request ID on another operation
 * must conflict, not create a second write. The digest binds the complete
 * validated operation, including exact original bytes, initial association and
 * audience. It contains no session credential or transient authorization state.
 * This computes an identity only; it does not authorize or execute a mutation.
 */
export function projectCommandIdentityV1(
  actor: AuthorityPersonMembershipBinding,
  mutation: ProjectMutationV1,
): ProjectCommandIdentityV1 {
  const request = (() => {
    switch (mutation.operation) {
      case 'create': return validateProjectCreateV1(mutation.request);
      case 'member_set': return validateProjectMemberSetV1(mutation.request);
      case 'member_remove': return validateProjectMemberRemoveV1(mutation.request);
      case 'associate': return validateProjectContextAssociateV1(mutation.request);
      case 'dissociate': return validateProjectContextDissociateV1(mutation.request);
      case 'upload_submit': return validatePersonUpdateSubmitV2(mutation.request);
      default: throw new Error('Unsupported project command');
    }
  })();
  const binding = {
    organization_id: actor.organization_id,
    principal_id: actor.principal_id,
    membership_id: actor.membership_id,
  };
  return {
    organization_id: actor.organization_id,
    membership_id: actor.membership_id,
    request_id: request.request_id,
    command_sha256: canonicalSha256({
      schema_version: 1,
      kind: 'echo-project-command-identity-v1',
      actor: binding,
      operation: mutation.operation,
      request,
    }),
  };
}
