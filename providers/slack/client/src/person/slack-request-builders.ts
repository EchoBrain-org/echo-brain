import { organizationPersonSlackIdentityLinkChallengeCodeSha256, validateOrganizationPersonSlackIdentityLinkBeginRequest, validateOrganizationPersonSlackIdentityLinkCompleteRequest, type OrganizationPersonSlackIdentityLinkBeginRequestV2, type OrganizationPersonSlackIdentityLinkCompleteRequestV2 } from "../organization-api/person-slack-identity-link.js";

export function createPersonSlackIdentityLinkBeginRequest(
  requestId: string,
  challengeCode: string,
  recipientUserId: string,
): OrganizationPersonSlackIdentityLinkBeginRequestV2 {
  return validateOrganizationPersonSlackIdentityLinkBeginRequest({
    request_id: requestId,
    recipient_user_id: recipientUserId,
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
