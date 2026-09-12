import { ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSIONS_PATH, ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSION_LIST_PATH, validateOrganizationPersonMeetingIngestionExclusionChangeRequest, validateOrganizationPersonMeetingIngestionExclusionListRequest, type OrganizationPersonMeetingIngestionExclusionChangeRequestV2, type OrganizationPersonMeetingIngestionExclusionListRequestV2, type OrganizationPersonMeetingIngestionExclusionSelectorV2, type OrganizationPersonSessionV2 } from "@echo-brain/organization-api";

export interface PersonApiRequestIdentity {
  readonly authority_id: string;
  readonly session: OrganizationPersonSessionV2;
}

function base(
  identity: PersonApiRequestIdentity,
  requestId: string,
): {
  request_id: string;
  authority_id: string;
  organization_id: string;
  subject_principal_id: string;
  http_method: 'POST';
} {
  return {
    request_id: requestId,
    authority_id: identity.authority_id,
    organization_id: identity.session.organization_id,
    subject_principal_id: identity.session.principal_id,
    http_method: 'POST',
  };
}

export function createPersonMeetingIngestionExclusionChangeRequest(
  identity: PersonApiRequestIdentity,
  requestId: string,
  excluded: boolean,
  selector: OrganizationPersonMeetingIngestionExclusionSelectorV2,
): OrganizationPersonMeetingIngestionExclusionChangeRequestV2 {
  return validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
    schema_version: 2,
    kind: 'echo-organization-person-member-exclusion-change-request',
    ...base(identity, requestId),
    http_path: ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSIONS_PATH,
    excluded,
    selector,
  });
}

export function createPersonMeetingIngestionExclusionListRequest(
  identity: PersonApiRequestIdentity,
  requestId: string,
  sourceAdapterId: string,
  sourceInstanceId: string,
): OrganizationPersonMeetingIngestionExclusionListRequestV2 {
  return validateOrganizationPersonMeetingIngestionExclusionListRequest({
    schema_version: 2,
    kind: 'echo-organization-person-member-exclusion-list-request',
    ...base(identity, requestId),
    http_path: ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSION_LIST_PATH,
    source_adapter_id: sourceAdapterId,
    source_instance_id: sourceInstanceId,
  });
}
