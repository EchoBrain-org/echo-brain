/**
 * Provider-neutral record visibility policy commitments selected at human
 * approval time. Meeting processing depends on this surface, never on Slack.
 */
export {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type ApprovalContractSha256,
  type PersonApprovalPolicyId,
} from "./application/person-slack-reaction-approval-contracts-v2.js";
