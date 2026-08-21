import {
  ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH,
  ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH,
  ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
  organizationSlackLinkChallengeCodeSha256,
  validateOrganizationPersonMemberExclusionChangeRequest,
  validateOrganizationPersonMemberExclusionListRequest,
  validateOrganizationPersonReadableSearchRequest,
  validateOrganizationPersonRecentDecisionsRequest,
  validateOrganizationPersonReviewerRecentDecisionsRequest,
  validateOrganizationPersonSlackLinkBeginRequest,
  validateOrganizationPersonSlackLinkCompleteRequest,
  type OrganizationPersonMemberExclusionChangeRequestV2,
  type OrganizationPersonMemberExclusionListRequestV2,
  type OrganizationPersonMemberExclusionSelectorV2,
  type OrganizationPersonReadableSearchRequestV2,
  type OrganizationPersonRecentDecisionsRequestV2,
  type OrganizationPersonReviewerRecentDecisionsRequestV2,
  type OrganizationPersonSessionV2,
  type OrganizationPersonSlackLinkBeginRequestV2,
  type OrganizationPersonSlackLinkCompleteRequestV2,
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

export function createPersonRecentDecisionsRequest(
  identity: PersonRequestIdentity,
  requestId: string,
): OrganizationPersonRecentDecisionsRequestV2 {
  return validateOrganizationPersonRecentDecisionsRequest({
    schema_version: 2,
    kind: 'echo-organization-person-recent-decisions-request',
    ...base(identity, requestId),
    http_path: ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
  });
}

export function createPersonReviewerRecentDecisionsRequest(
  identity: PersonRequestIdentity,
): OrganizationPersonReviewerRecentDecisionsRequestV2 {
  return validateOrganizationPersonReviewerRecentDecisionsRequest({
    subject_principal_id: identity.session.principal_id,
  });
}

export function createPersonReadableSearchRequest(
  identity: PersonRequestIdentity,
  query: string,
): OrganizationPersonReadableSearchRequestV2 {
  return validateOrganizationPersonReadableSearchRequest({
    subject_principal_id: identity.session.principal_id,
    query,
  });
}

export function createPersonMemberExclusionChangeRequest(
  identity: PersonRequestIdentity,
  requestId: string,
  excluded: boolean,
  selector: OrganizationPersonMemberExclusionSelectorV2,
): OrganizationPersonMemberExclusionChangeRequestV2 {
  return validateOrganizationPersonMemberExclusionChangeRequest({
    schema_version: 2,
    kind: 'echo-organization-person-member-exclusion-change-request',
    ...base(identity, requestId),
    http_path: ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH,
    excluded,
    selector,
  });
}

export function createPersonMemberExclusionListRequest(
  identity: PersonRequestIdentity,
  requestId: string,
  sourceAdapterId: string,
  sourceInstanceId: string,
): OrganizationPersonMemberExclusionListRequestV2 {
  return validateOrganizationPersonMemberExclusionListRequest({
    schema_version: 2,
    kind: 'echo-organization-person-member-exclusion-list-request',
    ...base(identity, requestId),
    http_path: ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH,
    source_adapter_id: sourceAdapterId,
    source_instance_id: sourceInstanceId,
  });
}

export function createPersonSlackLinkBeginRequest(
  requestId: string,
  challengeCode: string,
): OrganizationPersonSlackLinkBeginRequestV2 {
  return validateOrganizationPersonSlackLinkBeginRequest({
    request_id: requestId,
    challenge_code_sha256:
      organizationSlackLinkChallengeCodeSha256(challengeCode),
  });
}

export function createPersonSlackLinkCompleteRequest(
  requestId: string,
  input: {
    readonly challenge_attempt_id: string;
    readonly challenge_message_ts: string;
    readonly challenge_code: string;
  },
): OrganizationPersonSlackLinkCompleteRequestV2 {
  return validateOrganizationPersonSlackLinkCompleteRequest({
    request_id: requestId,
    ...input,
  });
}
