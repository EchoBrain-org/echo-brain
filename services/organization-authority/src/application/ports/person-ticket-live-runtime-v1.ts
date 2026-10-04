import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';

export type PersonTicketProjectAuthorizationV1 = (access_token: string, project_id: string) => Readonly<{ role: 'lead' | 'member'; authorization_sha256: Sha256Digest }>;

/** The selecting root supplies one ticket reader and its authenticated connection commands. */
export interface PersonTicketLiveApplicationV1 {
  source(input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonTicketCitationV1>; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceSourceV1<PersonTicketCitationV1> | undefined>;
}
export interface OpenedPersonTicketLiveRuntimeV1 {
  readonly application: PersonTicketLiveApplicationV1;
  readonly connection_http: ProviderHttpApplicationV1;
  close(): void;
}
export type PersonTicketLiveRuntimeFactoryV1 = (authentication: {
  authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization;
}, authorize_project: PersonTicketProjectAuthorizationV1) => OpenedPersonTicketLiveRuntimeV1;
