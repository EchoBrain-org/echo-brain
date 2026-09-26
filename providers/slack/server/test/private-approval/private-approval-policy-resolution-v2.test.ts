import { describe, expect, it } from "vitest";
import { resolvePrivateApprovalPolicyV2, validatePrivateApprovalResolutionV2 } from "../../src/organization-control-plane/application/slack/private-approval-policy-resolution-v2.js";
const d=(n:string)=>`sha256:${n.repeat(64).slice(0,64)}` as `sha256:${string}`;
const project={project_id:"prj_11111111-1111-4111-8111-111111111111",project_membership_id:"pgm_11111111-1111-4111-8111-111111111111",name:"Apollo"};
const pending={schema_version:2 as const,kind:"echo-private-approval-pending-v2" as const,approval_id:"apr_1",organization_id:"org_1",candidate_sha256:d("a"),frozen_card_sha256:d("b"),approved_snapshot_sha256:d("c"),assigned_owner:{principal_id:"prn_1",membership_id:"mem_1"},assigned_owner_slack_identity_link:{provider:"slack" as const,external_identity_link_id:"clm_1",external_identity_link_contract_sha256:d("d"),provider_subject_id:"U123"},eligible_projects:[project],transcript_source:{source_id:"src_1",revision_id:"rev_1",source_sha256:d("e")}};
const allow={schema_version:2 as const,kind:"echo-private-approval-authorization-allow-v2" as const,approval_id:"apr_1",organization_id:"org_1",candidate_sha256:d("a"),frozen_card_sha256:d("b"),approved_snapshot_sha256:d("c"),authorized_assignee:{principal_id:"prn_1",membership_id:"mem_1"},current_slack_identity_link:pending.assigned_owner_slack_identity_link,authorization_proof_sha256:d("f")};
const command={schema_version:2 as const,command_id:"cmd_1",approval_id:"apr_1",action:"approve" as const,selected_policy_id:"project-members-readable-person-v1" as const,selected_project_ids:[project.project_id],share_transcript:true,comment:null};
describe("private approval resolution v2",()=>{
 it("binds selected projects and transcript source",()=>{const r=resolvePrivateApprovalPolicyV2({pending,command,authorization_allow:allow,selected_projects_current:[project]});expect(r.canonical_record_policy).toMatchObject({audience_project_ids:[project.project_id],association_project_ids:[project.project_id],share_transcript:true,transcript_source:pending.transcript_source});});
 it("fails closed after project membership remove/re-add",()=>expect(()=>resolvePrivateApprovalPolicyV2({pending,command,authorization_allow:allow,selected_projects_current:[{...project,project_membership_id:"pgm_22222222-2222-4222-8222-222222222222"}]})).toThrow("grant changed"));
 it("round-trips all three policies with their exact policy reader semantics",()=>{
   const cases=[
     command,
     {...command,selected_policy_id:"restricted-reviewer-person-v2" as const,selected_project_ids:[],share_transcript:false},
     {...command,selected_policy_id:"organization-member-readable-person-v2" as const,selected_project_ids:[],share_transcript:false},
   ];
   for(const selected of cases){
     const resolution=resolvePrivateApprovalPolicyV2({pending,command:selected,authorization_allow:allow,selected_projects_current:selected.selected_project_ids.length===0?[]:[project]});
     expect(validatePrivateApprovalResolutionV2(resolution)).toEqual(resolution);
   }
 });
 it("rejects a tampered consequence or a mismatched restricted reader",()=>{
   const resolution=resolvePrivateApprovalPolicyV2({pending,command,authorization_allow:allow,selected_projects_current:[project]});
   const policy=resolution.canonical_record_policy!;
   expect(()=>validatePrivateApprovalResolutionV2({...resolution,canonical_record_policy:{...policy,policy_consequence_sha256:d("0")}})).toThrow("resolution policy");
   expect(()=>validatePrivateApprovalResolutionV2({...resolution,canonical_record_policy:{...policy,restricted_reader:{principal_id:"prn_other",membership_id:"mem_other"}}})).toThrow("resolution policy");
 });
});
