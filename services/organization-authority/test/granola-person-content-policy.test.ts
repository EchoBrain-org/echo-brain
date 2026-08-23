import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  GRANOLA_RESTRICTED_PERSON_TITLE_PREFIX_V1,
  selectGranolaPersonContentPolicyV1,
} from "../src/processing/clean-v1/granola-person-content-policy.js";

describe("Granola clean Person content policy", () => {
  it("selects the existing restricted-reviewer policy only for the exact title prefix", () => {
    expect(
      selectGranolaPersonContentPolicyV1(
        `${GRANOLA_RESTRICTED_PERSON_TITLE_PREFIX_V1}Founder review`,
      ).policy_id,
    ).toBe(RESTRICTED_REVIEWER_PERSON_POLICY_ID);
    expect(selectGranolaPersonContentPolicyV1("Founder review").policy_id).toBe(
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    );
    expect(selectGranolaPersonContentPolicyV1("[ECHO:restricted] Founder review").policy_id).toBe(
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    );
    expect(selectGranolaPersonContentPolicyV1("Founder [echo:restricted] review").policy_id).toBe(
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    );
  });
});
