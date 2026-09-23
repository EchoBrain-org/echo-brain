import { validatePersonDocumentAssociateV1, validatePersonDocumentDissociateV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { PersonDocumentAssociationApplicationV1, PersonDocumentAssociationRepositoryV1 } from './ports/document-associations-v1.js';

export function createPersonDocumentAssociationApplicationV1(dependencies: {
  readonly authenticate: (accessToken: string) => PersonAccessAuthorization;
  readonly repository: PersonDocumentAssociationRepositoryV1;
}): PersonDocumentAssociationApplicationV1 {
  function valid<T>(operation: () => T): T {
    try { return operation(); }
    catch { throw new AuthorityOperationError('invalid_request', 'Document association request is invalid'); }
  }
  return {
    associate(token, input) {
      const actor = dependencies.authenticate(token);
      const request = valid(() => validatePersonDocumentAssociateV1(input));
      return dependencies.repository.associate(actor, request, () => dependencies.authenticate(token));
    },
    dissociate(token, input) {
      const actor = dependencies.authenticate(token);
      const request = valid(() => validatePersonDocumentDissociateV1(input));
      return dependencies.repository.dissociate(actor, request, () => dependencies.authenticate(token));
    },
  };
}
