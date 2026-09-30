import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "../src/application/record-visibility-policy-contracts-v1.js";
import {
  privateApprovalPolicyBindingV2,
  validatePrivateApprovalResolutionCommandV2,
} from "../src/application/private-approval-policy-resolution-core-v2.js";

const source = { source_id: "src_1", revision_id: "rev_1", source_sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const };
const digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

describe("private approval policy resolution V2", () => {
  it("requires a sorted non-empty project selection only for the project policy", () => {
    const a = "prj_00000000-0000-0000-0000-000000000001", b = "prj_00000000-0000-0000-0000-000000000002";
    expect(validatePrivateApprovalResolutionCommandV2({ schema_version: 2, command_id: "cmd_1", approval_id: "app_1", action: "approve", selected_policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, selected_project_ids: [a, b], share_transcript: false, comment: null })).toMatchObject({ selected_project_ids: [a, b] });
    expect(() => validatePrivateApprovalResolutionCommandV2({ schema_version: 2, command_id: "cmd_1", approval_id: "app_1", action: "approve", selected_policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, selected_project_ids: [b, a], share_transcript: false, comment: null })).toThrow(/sorted and unique/);
  });

  it("binds the exact transcript source and keeps audience and association explicit", () => {
    const project = "prj_00000000-0000-0000-0000-000000000001";
    const binding = privateApprovalPolicyBindingV2({ policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, approver: { principal_id: "prn_1", membership_id: "mem_1" }, audience_project_ids: [project], association_project_ids: [project], share_transcript: true, transcript_source: source, policy_consequence_sha256: digest });
    expect(binding).toMatchObject({ audience_project_ids: [project], association_project_ids: [project], share_transcript: true, transcript_source: source });
  });

  it.each([
    [RESTRICTED_REVIEWER_PERSON_POLICY_ID, "sha256:324081398888234ee7f53f9211e6ed422508287ba67563811a640aea7dc19d4c"],
    [ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, "sha256:c1919a184de7e2083b6c655a45825713ff7a042ebd40c7385d0adf3d791b9366"],
    [PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, "sha256:71c8eed51ca576e4a405bece7d75963de0bc5a13b2fa91e161643856466349c2"],
  ] as const)("preserves the canonical %s binding and its reader intent", (policy_id, expectedDigest) => {
    const approver = { principal_id: "prn_1", membership_id: "mem_1" };
    const ids = policy_id === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID
      ? ["prj_00000000-0000-0000-0000-000000000001"]
      : [];
    const binding = privateApprovalPolicyBindingV2({
      policy_id, approver, audience_project_ids: ids, association_project_ids: ids,
      share_transcript: true, transcript_source: source, policy_consequence_sha256: digest,
    });
    expect(canonicalSha256(binding)).toBe(expectedDigest);
    expect(binding.restricted_reader).toEqual(policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID ? approver : null);
  });
});
