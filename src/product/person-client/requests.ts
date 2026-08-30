import {
  ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSIONS_PATH,
  ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSION_LIST_PATH,
  organizationPersonSlackIdentityLinkChallengeCodeSha256,
  validateOrganizationPersonMeetingIngestionExclusionChangeRequest,
  validateOrganizationPersonMeetingIngestionExclusionListRequest,
  validateOrganizationPersonSlackIdentityLinkBeginRequest,
  validateOrganizationPersonSlackIdentityLinkCompleteRequest,
  type OrganizationPersonMeetingIngestionExclusionChangeRequestV2,
  type OrganizationPersonMeetingIngestionExclusionListRequestV2,
  type OrganizationPersonMeetingIngestionExclusionSelectorV2,
  type OrganizationPersonSessionV2,
  type OrganizationPersonSlackIdentityLinkBeginRequestV2,
  type OrganizationPersonSlackIdentityLinkCompleteRequestV2,
} from '@echo-brain/organization-api';

export interface PersonRequestIdentity {
  readonly authority_id: string;
  readonly session: OrganizationPersonSessionV2;
}

function base(
  identity: PersonRequestIdentity,
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
  identity: PersonRequestIdentity,
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
  identity: PersonRequestIdentity,
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

export function createPersonSlackIdentityLinkBeginRequest(
  requestId: string,
  challengeCode: string,
): OrganizationPersonSlackIdentityLinkBeginRequestV2 {
  return validateOrganizationPersonSlackIdentityLinkBeginRequest({
    request_id: requestId,
    challenge_code_sha256:
      organizationPersonSlackIdentityLinkChallengeCodeSha256(challengeCode),
  });
}

export function createPersonSlackIdentityLinkCompleteRequest(
  requestId: string,
  input: {
    readonly challenge_attempt_id: string;
    readonly challenge_message_ts: string;
    readonly challenge_code: string;
  },
): OrganizationPersonSlackIdentityLinkCompleteRequestV2 {
  return validateOrganizationPersonSlackIdentityLinkCompleteRequest({
    request_id: requestId,
    ...input,
  });
}
