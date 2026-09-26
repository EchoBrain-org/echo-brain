import { describe, expect, it } from "vitest";
import {
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
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
});
