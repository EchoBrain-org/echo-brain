import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  GRANOLA_RESTRICTED_PERSON_FOLDER_NAME_V1,
  selectGranolaPersonContentPolicyV1,
} from "../src/processing/clean-v1/granola-person-content-policy.js";

describe("Granola clean Person content policy", () => {
  it("selects restricted-reviewer only for an exact Granola folder membership name", () => {
    expect(
      selectGranolaPersonContentPolicyV1(
        {
          granola: {
            folder_membership: [
              { id: "fol_1", object: "folder", name: GRANOLA_RESTRICTED_PERSON_FOLDER_NAME_V1 },
            ],
          },
        },
      ).policy_id,
    ).toBe(RESTRICTED_REVIEWER_PERSON_POLICY_ID);
    expect(selectGranolaPersonContentPolicyV1(undefined).policy_id).toBe(
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    );
    expect(selectGranolaPersonContentPolicyV1({
      granola: { folder_membership: [{ name: "Echo-Restricted" }] },
    }).policy_id).toBe(
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    );
    expect(selectGranolaPersonContentPolicyV1({
      granola: { folder_membership: [{ name: "echo-restricted " }] },
    }).policy_id).toBe(
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    );
    // A title-shaped value cannot become policy input.
    expect(selectGranolaPersonContentPolicyV1("[echo:restricted] Founder review").policy_id).toBe(
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    );
  });
});
