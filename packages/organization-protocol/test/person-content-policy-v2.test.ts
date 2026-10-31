import { describe, expect, it } from "vitest";
import {
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  PERSON_CONTENT_POLICY_CONTRACT_KIND,
  PERSON_CONTENT_POLICY_READER_AUTHENTICATION,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  projectMembersReadablePersonPolicyContract,
  projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContract,
  restrictedReviewerPersonPolicyContractSha256,
} from "../src/person-content-policy-v2.js";

describe("Person content policy v2", () => {
  it("freezes the exact human-visible consequence byte commitment", () => {
    expect(RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT).toBe(
      "Approving records this package under restricted-reviewer-person-v2. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact ECHO principal and membership tenure remain current and the request is authenticated by a current Authority Person session.",
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

  it("keeps the policies distinct from v1 and from a swapped reader selector", () => {
    const reviewer = restrictedReviewerPersonPolicyContract();
    expect(reviewer.policy_id).not.toBe("restricted-reviewer-v1");
  });

  it("freezes the project-member selector without freezing a reader snapshot", () => {
    expect(projectMembersReadablePersonPolicyContract()).toEqual({
      schema_version: 2,
      kind: PERSON_CONTENT_POLICY_CONTRACT_KIND,
      policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
      reader_authentication: PERSON_CONTENT_POLICY_READER_AUTHENTICATION,
      reader_selector: {
        kind: "current-active-project-members-v1",
        membership_state: "active",
        membership_scope: "same-organization-as-record",
        project_selector: "approval-consequence-audience-project-ids-v1",
        later_members: "included",
      },
      readable_item_kinds: ["decision", "action", "rationale"],
    });
    expect(projectMembersReadablePersonPolicyContractSha256()).toBe(
      "sha256:35f00fe4f6d01a5b80ed3f1278c3def4dcb3a01993530e0d837957e3af3505a2",
    );
  });
});
