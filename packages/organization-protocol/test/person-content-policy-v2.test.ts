import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PERSON_CONTENT_POLICY_CONTRACT_KIND,
  PERSON_CONTENT_POLICY_READER_AUTHENTICATION,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  organizationMemberReadablePersonConsequenceSha256,
  organizationMemberReadablePersonPolicyContract,
  organizationMemberReadablePersonPolicyContractSha256,
  restrictedReviewerPersonConsequenceSha256,
  restrictedReviewerPersonPolicyContract,
  restrictedReviewerPersonPolicyContractSha256,
  validatePersonContentPolicyContract,
} from "../src/person-content-policy-v2.js";
import {
  organizationMemberReadablePolicyContractSha256,
} from "../src/organization-member-readable-policy.js";

describe("Person content policy v2", () => {
  it("freezes the two exact human-visible consequence byte commitments", () => {
    expect(RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT).toBe(
      "Approving records this package under restricted-reviewer-person-v2. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact ECHO principal and membership tenure remain current and the request is authenticated by a current Authority Person session.",
    );
    expect(ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT).toBe(
      "Approving records this package under organization-member-readable-person-v2. Any person authenticated by a current Authority Person session with a current active owner or employee membership in this organization, including a person who joins later, may search and read its decisions, actions, and rationales while that membership remains active.",
    );
    expect(restrictedReviewerPersonConsequenceSha256()).toBe(
      "sha256:f2d87d2ca6b4892ed9ce166f67120092de639b513fd919e864c0ddf58f253594",
    );
    expect(organizationMemberReadablePersonConsequenceSha256()).toBe(
      "sha256:2a581951072720b0dfcbbf865cd90132e18421938c9d75dd1c11bb8a1fade2cf",
    );
  });

  it("freezes the exact restricted-reviewer Person contract", () => {
    const contract = restrictedReviewerPersonPolicyContract();
    expect(contract).toEqual({
      schema_version: 2,
      kind: PERSON_CONTENT_POLICY_CONTRACT_KIND,
      policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      policy_consequence_sha256:
        "sha256:f2d87d2ca6b4892ed9ce166f67120092de639b513fd919e864c0ddf58f253594",
      reader_authentication: PERSON_CONTENT_POLICY_READER_AUTHENTICATION,
      reader_selector: {
        kind: "exact-frozen-approver-tenure-v1",
        membership_state: "active",
        membership_scope: "same-organization-as-record",
        frozen_tuple: "approval-principal-id-and-membership-id",
      },
      readable_item_kinds: ["decision", "action", "rationale"],
    });
    expect(restrictedReviewerPersonPolicyContractSha256()).toBe(
      "sha256:c0b1676ad1bd2f27d9d781605420beac2e6fd3cd18ffa69f0d18ea62fe48f043",
    );
  });

  it("freezes the exact organization-member Person contract", () => {
    const contract = organizationMemberReadablePersonPolicyContract();
    expect(contract).toEqual({
      schema_version: 2,
      kind: PERSON_CONTENT_POLICY_CONTRACT_KIND,
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      policy_consequence_sha256:
        "sha256:2a581951072720b0dfcbbf865cd90132e18421938c9d75dd1c11bb8a1fade2cf",
      reader_authentication: PERSON_CONTENT_POLICY_READER_AUTHENTICATION,
      reader_selector: {
        kind: "current-active-organization-members-v1",
        membership_state: "active",
        membership_scope: "same-organization-as-record",
        eligible_membership_types: ["employee", "owner"],
        later_members: "included",
      },
      readable_item_kinds: ["decision", "action", "rationale"],
    });
    expect(organizationMemberReadablePersonPolicyContractSha256()).toBe(
      "sha256:7a874f8b8c0bea7fd58066f93e4f4a26f6f6c05bbbdfe45bf2141f0b2f3ff5e3",
    );
  });

  it("keeps the policies distinct from v1 and from a swapped reader selector", () => {
    const reviewer = restrictedReviewerPersonPolicyContract();
    const member = organizationMemberReadablePersonPolicyContract();
    expect(reviewer.policy_id).not.toBe("restricted-reviewer-v1");
    expect(organizationMemberReadablePersonPolicyContractSha256()).not.toBe(
      organizationMemberReadablePolicyContractSha256(),
    );
    expect(
      canonicalSha256({
        ...reviewer,
        reader_selector: member.reader_selector,
      }),
    ).not.toBe(restrictedReviewerPersonPolicyContractSha256());
    expect(
      canonicalSha256({
        ...member,
        reader_selector: reviewer.reader_selector,
      }),
    ).not.toBe(organizationMemberReadablePersonPolicyContractSha256());
  });

  it.each([
    [
      "extra field",
      () => ({ ...restrictedReviewerPersonPolicyContract(), extra: true }),
    ],
    [
      "missing field",
      () => {
        const { readable_item_kinds: _, ...rest } =
          restrictedReviewerPersonPolicyContract();
        return rest;
      },
    ],
    [
      "v1 policy id",
      () => ({
        ...restrictedReviewerPersonPolicyContract(),
        policy_id: "restricted-reviewer-v1",
      }),
    ],
    [
      "changed consequence digest",
      () => ({
        ...restrictedReviewerPersonPolicyContract(),
        policy_consequence_sha256:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ],
    [
      "selector swap",
      () => ({
        ...restrictedReviewerPersonPolicyContract(),
        reader_selector:
          organizationMemberReadablePersonPolicyContract().reader_selector,
      }),
    ],
    [
      "item order",
      () => ({
        ...organizationMemberReadablePersonPolicyContract(),
        readable_item_kinds: ["action", "decision", "rationale"],
      }),
    ],
    [
      "membership type order",
      () => ({
        ...organizationMemberReadablePersonPolicyContract(),
        reader_selector: {
          ...organizationMemberReadablePersonPolicyContract().reader_selector,
          eligible_membership_types: ["owner", "employee"],
        },
      }),
    ],
  ])("rejects %s", (_label, candidate) => {
    expect(() => validatePersonContentPolicyContract(candidate())).toThrowError(
      expect.objectContaining({
        name: "OrganizationProtocolValidationError",
      }),
    );
  });

  it("returns canonical snapshots for both exact variants", () => {
    for (const contract of [
      restrictedReviewerPersonPolicyContract(),
      organizationMemberReadablePersonPolicyContract(),
    ]) {
      const validated = validatePersonContentPolicyContract(contract);
      expect(validated).toEqual(contract);
    }
  });
});
