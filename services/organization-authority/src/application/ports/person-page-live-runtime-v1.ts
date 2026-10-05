import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import type { OrganizationPersonToolV4, PersonPageCitationV1 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';

/** Current exact ECHO-project grant. The provider resolves its stored external mapping. */
export type PersonPageProjectAuthorizationV1 = (access_token: string, project_id: string) => Readonly<{
  role: 'lead' | 'member';
  authorization_sha256: Sha256Digest;
}>;

/** The selecting root supplies one page reader and its authenticated connection commands. */
export interface PersonPageLiveApplicationV1 {
  source(input: {
    readonly project_id?: string;
    readonly access_token: string;
    readonly audit: PersonLiveEvidenceAuditV1<PersonPageCitationV1>;
    readonly signal?: AbortSignal;
  }): Promise<PersonLiveEvidenceSourceV1<PersonPageCitationV1> | undefined>;
}
export interface OpenedPersonPageLiveRuntimeV1 {
  readonly application: PersonPageLiveApplicationV1;
  readonly connection_http: ProviderHttpApplicationV1;
  tools?(access_token: string): Promise<readonly OrganizationPersonToolV4[]>;
  close(): void;
}
/** The runtime owns provider construction; the API root only supplies current Person/project grants. */
export type PersonPageLiveRuntimeFactoryV1 = (authentication: {
  authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization;
}, authorize_project: PersonPageProjectAuthorizationV1) => OpenedPersonPageLiveRuntimeV1;
