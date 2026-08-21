import {
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertLiteral,
  canonicalSnapshot,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

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

export type PersonContentPolicyContractV2 =
  | RestrictedReviewerPersonPolicyContractV2
  | OrganizationMemberReadablePersonPolicyContractV2;

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

const POLICY_KEYS = Object.freeze([
  "schema_version",
  "kind",
  "policy_id",
  "policy_consequence_sha256",
  "reader_authentication",
  "reader_selector",
  "readable_item_kinds",
] as const);

function assertReadableItemKinds(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.length !== PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS.length ||
    value.some(
      (item, index) => item !== PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS[index],
    )
  ) {
    organizationProtocolValidationFailure(
      `${label} must contain decision, action, rationale in order`,
    );
  }
}

export function validatePersonContentPolicyContract(
  value: unknown,
): PersonContentPolicyContractV2 {
  const contract = asRecord(value, "Person content policy contract");
  assertExactKeys(contract, POLICY_KEYS, "Person content policy contract");
  assertLiteral(
    contract.schema_version,
    PERSON_CONTENT_POLICY_SCHEMA_VERSION,
    "Person content policy contract schema_version",
  );
  assertLiteral(
    contract.kind,
    PERSON_CONTENT_POLICY_CONTRACT_KIND,
    "Person content policy contract kind",
  );
  assertLiteral(
    contract.reader_authentication,
    PERSON_CONTENT_POLICY_READER_AUTHENTICATION,
    "Person content policy contract reader_authentication",
  );
  assertDigest(
    contract.policy_consequence_sha256,
    "Person content policy contract consequence digest",
  );
  assertReadableItemKinds(
    contract.readable_item_kinds,
    "Person content policy contract readable_item_kinds",
  );

  const selector = asRecord(
    contract.reader_selector,
    "Person content policy contract reader_selector",
  );
  if (contract.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
    assertLiteral(
      contract.policy_consequence_sha256,
      restrictedReviewerPersonConsequenceSha256(),
      "restricted-reviewer consequence digest",
    );
    assertExactKeys(
      selector,
      ["kind", "membership_state", "membership_scope", "frozen_tuple"],
      "restricted-reviewer selector",
    );
    assertLiteral(
      selector.kind,
      "exact-frozen-approver-tenure-v1",
      "restricted-reviewer selector kind",
    );
    assertLiteral(
      selector.frozen_tuple,
      "approval-principal-id-and-membership-id",
      "restricted-reviewer selector frozen_tuple",
    );
  } else if (
    contract.policy_id === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID
  ) {
    assertLiteral(
      contract.policy_consequence_sha256,
      organizationMemberReadablePersonConsequenceSha256(),
      "organization-member consequence digest",
    );
    assertExactKeys(
      selector,
      [
        "kind",
        "membership_state",
        "membership_scope",
        "eligible_membership_types",
        "later_members",
      ],
      "organization-member selector",
    );
    assertLiteral(
      selector.kind,
      "current-active-organization-members-v1",
      "organization-member selector kind",
    );
    const membershipTypes = selector.eligible_membership_types;
    if (
      !Array.isArray(membershipTypes) ||
      membershipTypes.length !== 2 ||
      membershipTypes[0] !== "employee" ||
      membershipTypes[1] !== "owner"
    ) {
      organizationProtocolValidationFailure(
        "organization-member selector membership types must be employee, owner in order",
      );
    }
    assertLiteral(
      selector.later_members,
      "included",
      "organization-member selector later_members",
    );
  } else {
    organizationProtocolValidationFailure(
      "Person content policy contract policy_id is unsupported",
    );
  }
  assertLiteral(
    selector.membership_state,
    "active",
    "Person content policy contract membership_state",
  );
  assertLiteral(
    selector.membership_scope,
    "same-organization-as-record",
    "Person content policy contract membership_scope",
  );

  return canonicalSnapshot(
    contract as unknown as PersonContentPolicyContractV2,
    "Person content policy contract",
  );
}
