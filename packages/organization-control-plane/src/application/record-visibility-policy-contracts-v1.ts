/**
 * Provider-neutral record visibility policy commitments selected at human
 * approval time. Provider integrations bind these immutable policy contracts
 * into their own approval and evidence shapes.
 */
export type ApprovalContractSha256 = `sha256:${string}`;

export type PersonApprovalPolicyId =
  | "organization-member-readable-person-v2"
  | "restricted-reviewer-person-v2";

export const PERSON_CONTENT_POLICY_CONTRACT_KIND =
  "echo-person-content-policy-contract-v2" as const;
export const PERSON_CONTENT_POLICY_READER_AUTHENTICATION =
  "current-authority-person-session-v2" as const;
export const ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID =
  "organization-member-readable-person-v2" as const;
export const RESTRICTED_REVIEWER_PERSON_POLICY_ID =
  "restricted-reviewer-person-v2" as const;
export const ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT =
  "Approving records this package under organization-member-readable-person-v2. Any person authenticated by a current Authority Person session with a current active owner or employee membership in this organization, including a person who joins later, may search and read its decisions, actions, and rationales while that membership remains active.";
export const RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT =
  "Approving records this package under restricted-reviewer-person-v2. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact ECHO principal and membership tenure remain current and the request is authenticated by a current Authority Person session.";
export const PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS = Object.freeze([
  "decision",
  "action",
  "rationale",
] as const);
export const ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256 =
  "sha256:7a874f8b8c0bea7fd58066f93e4f4a26f6f6c05bbbdfe45bf2141f0b2f3ff5e3" as const;
export const ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256 =
  "sha256:2a581951072720b0dfcbbf865cd90132e18421938c9d75dd1c11bb8a1fade2cf" as const;
export const RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256 =
  "sha256:c0b1676ad1bd2f27d9d781605420beac2e6fd3cd18ffa69f0d18ea62fe48f043" as const;
export const RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256 =
  "sha256:f2d87d2ca6b4892ed9ce166f67120092de639b513fd919e864c0ddf58f253594" as const;

export interface RestrictedReviewerPersonPolicyContractV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_CONTENT_POLICY_CONTRACT_KIND;
  readonly policy_id: typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly reader_authentication: typeof PERSON_CONTENT_POLICY_READER_AUTHENTICATION;
  readonly reader_selector: {
    readonly kind: "exact-frozen-approver-tenure-v1";
    readonly membership_state: "active";
    readonly membership_scope: "same-organization-as-record";
    readonly frozen_tuple: "approval-principal-id-and-membership-id";
  };
  readonly readable_item_kinds: typeof PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS;
}

export interface OrganizationMemberReadablePersonPolicyContractV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_CONTENT_POLICY_CONTRACT_KIND;
  readonly policy_id: typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly reader_authentication: typeof PERSON_CONTENT_POLICY_READER_AUTHENTICATION;
  readonly reader_selector: {
    readonly kind: "current-active-organization-members-v1";
    readonly membership_state: "active";
    readonly membership_scope: "same-organization-as-record";
    readonly eligible_membership_types: readonly ["employee", "owner"];
    readonly later_members: "included";
  };
  readonly readable_item_kinds: typeof PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS;
}

export function buildRestrictedReviewerPersonPolicyContractV2(): RestrictedReviewerPersonPolicyContractV2 {
  return Object.freeze({
    schema_version: 2,
    kind: PERSON_CONTENT_POLICY_CONTRACT_KIND,
    policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    policy_consequence_sha256: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
    reader_authentication: PERSON_CONTENT_POLICY_READER_AUTHENTICATION,
    reader_selector: Object.freeze({
      kind: "exact-frozen-approver-tenure-v1",
      membership_state: "active",
      membership_scope: "same-organization-as-record",
      frozen_tuple: "approval-principal-id-and-membership-id",
    }),
    readable_item_kinds: PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS,
  });
}

export function buildOrganizationMemberReadablePersonPolicyContractV2(): OrganizationMemberReadablePersonPolicyContractV2 {
  return Object.freeze({
    schema_version: 2,
    kind: PERSON_CONTENT_POLICY_CONTRACT_KIND,
    policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    policy_consequence_sha256:
      ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
    reader_authentication: PERSON_CONTENT_POLICY_READER_AUTHENTICATION,
    reader_selector: Object.freeze({
      kind: "current-active-organization-members-v1",
      membership_state: "active",
      membership_scope: "same-organization-as-record",
      eligible_membership_types: Object.freeze(["employee", "owner"] as const),
      later_members: "included",
    }),
    readable_item_kinds: PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS,
  });
}
