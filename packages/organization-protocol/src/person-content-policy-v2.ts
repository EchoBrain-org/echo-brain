import {
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";

export const PERSON_CONTENT_POLICY_CONTRACT_KIND =
  "echo-person-content-policy-contract-v2" as const;
export const PERSON_CONTENT_POLICY_SCHEMA_VERSION = 2 as const;
export const PERSON_CONTENT_POLICY_READER_AUTHENTICATION =
  "current-authority-person-session-v2" as const;

export const RESTRICTED_REVIEWER_PERSON_POLICY_ID =
  "restricted-reviewer-person-v2" as const;
export const ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID =
  "organization-member-readable-person-v2" as const;

export const RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT =
  "Approving records this package under restricted-reviewer-person-v2. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact ECHO principal and membership tenure remain current and the request is authenticated by a current Authority Person session.";
export const ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT =
  "Approving records this package under organization-member-readable-person-v2. Any person authenticated by a current Authority Person session with a current active owner or employee membership in this organization, including a person who joins later, may search and read its decisions, actions, and rationales while that membership remains active.";

export const PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS = Object.freeze([
  "decision",
  "action",
  "rationale",
] as const);

export interface RestrictedReviewerPersonPolicyContractV2 {
  readonly schema_version: typeof PERSON_CONTENT_POLICY_SCHEMA_VERSION;
  readonly kind: typeof PERSON_CONTENT_POLICY_CONTRACT_KIND;
  readonly policy_id: typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID;
  readonly policy_consequence_sha256: Sha256Digest;
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
  readonly schema_version: typeof PERSON_CONTENT_POLICY_SCHEMA_VERSION;
  readonly kind: typeof PERSON_CONTENT_POLICY_CONTRACT_KIND;
  readonly policy_id: typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;
  readonly policy_consequence_sha256: Sha256Digest;
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

export function restrictedReviewerPersonConsequenceSha256(): Sha256Digest {
  return sha256Digest(RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT);
}

export function organizationMemberReadablePersonConsequenceSha256(): Sha256Digest {
  return sha256Digest(ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT);
}

export function restrictedReviewerPersonPolicyContract(): RestrictedReviewerPersonPolicyContractV2 {
  return Object.freeze({
    schema_version: PERSON_CONTENT_POLICY_SCHEMA_VERSION,
    kind: PERSON_CONTENT_POLICY_CONTRACT_KIND,
    policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    policy_consequence_sha256: restrictedReviewerPersonConsequenceSha256(),
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

export function organizationMemberReadablePersonPolicyContract(): OrganizationMemberReadablePersonPolicyContractV2 {
  return Object.freeze({
    schema_version: PERSON_CONTENT_POLICY_SCHEMA_VERSION,
    kind: PERSON_CONTENT_POLICY_CONTRACT_KIND,
    policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    policy_consequence_sha256:
      organizationMemberReadablePersonConsequenceSha256(),
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

export function restrictedReviewerPersonPolicyContractSha256(): Sha256Digest {
  return canonicalSha256(restrictedReviewerPersonPolicyContract());
}

export function organizationMemberReadablePersonPolicyContractSha256(): Sha256Digest {
  return canonicalSha256(organizationMemberReadablePersonPolicyContract());
}
