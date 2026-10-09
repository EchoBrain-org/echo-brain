import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { OrganizationPersonToolV4 } from '@echo-brain/organization-api';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceCitationV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { PersonLiveSourceDescriptorV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import type { JiraOwnerAccountsV1 } from './jira-owner-accounts-v1.js';

/** Current ECHO-project grant; each provider resolves its own external mapping. */
export type PersonContextProjectAuthorizationV1 = (access_token: string, project_id: string) => Readonly<{ role: 'lead' | 'member'; authorization_sha256: Sha256Digest }>;
export interface PersonContextLiveApplicationV1<C extends PersonLiveEvidenceCitationV1> {
  source(input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<C>; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceSourceV1<C> | undefined>;
}
/** The selecting root owns provider construction; the API root supplies current grants. */
export interface OpenedPersonContextLiveRuntimeV1<C extends PersonLiveEvidenceCitationV1> {
  readonly application: PersonContextLiveApplicationV1<C>;
  readonly connection_http: ProviderHttpApplicationV1;
  tools?(access_token: string): Promise<readonly OrganizationPersonToolV4[]>;
  close(): void;
}
export type PersonContextLiveRuntimeFactoryV1<C extends PersonLiveEvidenceCitationV1> = (authentication: {
  authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization;
}, authorize_project: PersonContextProjectAuthorizationV1) => OpenedPersonContextLiveRuntimeV1<C>;

/** Registration separates provider identity from the evidence kind it returns. */
export interface PersonLiveConnectorDefinitionV1 {
  readonly descriptor: PersonLiveSourceDescriptorV2;
  readonly scopes: readonly ('global' | 'project')[];
  readonly minimum_response_version: 5 | 6;
  open(authentication: Parameters<PersonContextLiveRuntimeFactoryV1<PersonLiveEvidenceCitationV1>>[0], authorize_project: PersonContextProjectAuthorizationV1): OpenedPersonLiveConnectorV1;
}
export interface OpenedPersonLiveConnectorV1 extends Omit<OpenedPersonContextLiveRuntimeV1<PersonLiveEvidenceCitationV1>, 'connection_http'> {
  readonly connection_http?: ProviderHttpApplicationV1;
  /** Jira's assignee accounts, for matching an impact check's owners to members; only the Jira runtime has them. */
  readonly owners?: JiraOwnerAccountsV1;
}
export interface PersonLiveConnectorSourceV1 extends Omit<PersonLiveConnectorDefinitionV1, 'open'> {
  readonly application: PersonContextLiveApplicationV1<PersonLiveEvidenceCitationV1>;
}
