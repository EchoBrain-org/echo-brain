import type { PersonSlackMessageCitationV1 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';

/** A selecting composition supplies an explicitly authorized Slack read scope. */
export interface PersonSlackLiveApplicationV1 {
  source(input: { readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonSlackMessageCitationV1>; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceSourceV1<PersonSlackMessageCitationV1> | undefined>;
}
export interface OpenedPersonSlackLiveRuntimeV1 {
  readonly application: PersonSlackLiveApplicationV1;
  close(): void;
}
export type PersonSlackLiveRuntimeFactoryV1 = (authentication: {
  authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization;
}) => OpenedPersonSlackLiveRuntimeV1;
