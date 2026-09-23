import type { PersonDocumentAssociateV1, PersonDocumentDissociateV1, PersonDocumentAssociationReceiptV1 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';

export interface PersonDocumentAssociationRepositoryV1 {
  associate(actor: PersonAccessAuthorization, request: PersonDocumentAssociateV1, reauthenticate: () => PersonAccessAuthorization): PersonDocumentAssociationReceiptV1;
  dissociate(actor: PersonAccessAuthorization, request: PersonDocumentDissociateV1, reauthenticate: () => PersonAccessAuthorization): PersonDocumentAssociationReceiptV1;
}
export interface PersonDocumentAssociationApplicationV1 {
  associate(accessToken: string, request: unknown): PersonDocumentAssociationReceiptV1;
  dissociate(accessToken: string, request: unknown): PersonDocumentAssociationReceiptV1;
}
