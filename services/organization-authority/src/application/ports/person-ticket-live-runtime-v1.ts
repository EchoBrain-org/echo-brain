import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';

/** The selecting root supplies one ticket reader and its authenticated connection commands. */
export interface PersonTicketLiveApplicationV1 {
  connect(input: { readonly access_token: string; readonly signal?: AbortSignal }): Promise<{ readonly schema_version: 1; readonly attempt: string; readonly connect_link: string }>;
  complete(input: { readonly access_token: string; readonly attempt: string; readonly connection?: string; readonly signal?: AbortSignal }): Promise<{ readonly schema_version: 1; readonly connected: true }>;
  disconnect(input: { readonly access_token: string; readonly signal?: AbortSignal }): Promise<{ readonly schema_version: 1; readonly connected: false }>;
  source(input: { readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonTicketCitationV1>; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceSourceV1<PersonTicketCitationV1> | undefined>;
}
export interface OpenedPersonTicketLiveRuntimeV1 {
  readonly application: PersonTicketLiveApplicationV1;
  close(): void;
}
export type PersonTicketLiveRuntimeFactoryV1 = (authentication: {
  authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization;
}) => OpenedPersonTicketLiveRuntimeV1;
