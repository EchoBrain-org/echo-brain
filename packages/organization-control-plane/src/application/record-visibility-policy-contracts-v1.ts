/**
 * Provider-neutral record visibility policy commitments selected at human
 * approval time. Provider integrations bind these immutable policy contracts
 * into their own approval and evidence shapes.
 */
export type ApprovalContractSha256 = `sha256:${string}`;

export type PersonApprovalPolicyId =
  | "organization-member-readable-person-v2"
  | "restricted-reviewer-person-v2";

export const ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID =
  "organization-member-readable-person-v2" as const;
export const RESTRICTED_REVIEWER_PERSON_POLICY_ID =
  "restricted-reviewer-person-v2" as const;
export const RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT =
  "Approving records this package under restricted-reviewer-person-v2. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact ECHO principal and membership tenure remain current and the request is authenticated by a current Authority Person session.";
export const ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256 =
  "sha256:7a874f8b8c0bea7fd58066f93e4f4a26f6f6c05bbbdfe45bf2141f0b2f3ff5e3" as const;
export const ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256 =
  "sha256:2a581951072720b0dfcbbf865cd90132e18421938c9d75dd1c11bb8a1fade2cf" as const;
export const RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256 =
  "sha256:c0b1676ad1bd2f27d9d781605420beac2e6fd3cd18ffa69f0d18ea62fe48f043" as const;
export const RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256 =
  "sha256:f2d87d2ca6b4892ed9ce166f67120092de639b513fd919e864c0ddf58f253594" as const;
