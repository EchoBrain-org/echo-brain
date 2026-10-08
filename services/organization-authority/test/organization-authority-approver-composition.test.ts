import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@echo-brain/federation-protocol";
import { PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID } from "@echo-brain/organization-protocol";
import { OrganizationRecordAppenderV4 } from "@echo-brain/organization-record/organization-record-api-v1";
import { verifyOrganizationRecordEnvelopeV4 } from "../../../packages/organization-protocol/src/record-envelope-v4.js";
import { COORDINATES, database as recordDatabase, protocolAuthority } from "../../../packages/organization-record/test/fixtures/record-append-fixture.js";
import { openOrganizationAuthorityRuntime } from "../src/composition/organization-authority-runtime.js";
import { openOrganizationAuthorityService, type OrganizationAuthorityServiceConfig } from "../src/composition/organization-authority-composition-root.js";
import { SIGNED_APPROVAL_PROJECTORS, appendSignedApprovalV1 } from "./fixtures/signed-approval-decision-v1.js";

vi.mock("../src/composition/organization-authority-runtime.js", () => ({ openOrganizationAuthorityRuntime: vi.fn() }));

// Only provider selection runs; the mocked runtime performs no credential or persistence reads.
const config = {
  state_directory: "/unused",
  openrouter_credential_file: "/unused", slack_nango: { secret_key: "nango-secret-key-not-used-000000", integration_key: "slack" },
} as OrganizationAuthorityServiceConfig;
const APPROVER = { principal_id: "prn_approver", membership_id: "mem_approver" };
const SHARED = "prj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** One approval decision, signed and appended as the publisher would, and its stored canonical envelope. */
async function publishedDecision() {
  const record = recordDatabase();
  const signer = protocolAuthority();
  await appendSignedApprovalV1(new OrganizationRecordAppenderV4(record, COORDINATES, SIGNED_APPROVAL_PROJECTORS), signer, {
    approval_id: "apr_composed", audit_sequence: 1, projects: [SHARED], final_approver: APPROVER,
  });
  const envelope = JSON.parse(record.prepare("SELECT canonical_envelope FROM organization_record_log").pluck().get() as string) as JsonObject;
  record.close();
  return { envelope, signer };
}
async function composed(dependencies: Parameters<typeof openOrganizationAuthorityService>[1] = {}) {
  await openOrganizationAuthorityService(config, dependencies);
  const [runtimeConfig, runtimeDependencies] = vi.mocked(openOrganizationAuthorityRuntime).mock.lastCall!;
  return { runtimeConfig, approver: runtimeDependencies!.api!.record_approver! };
}

describe("Authority record protocol composition", () => {
  it("reads a published approval decision with the production codecs and projectors", async () => {
    const { envelope, signer } = await publishedDecision();
    const { runtimeConfig, approver } = await composed();
    const verified = verifyOrganizationRecordEnvelopeV4(envelope, signer.pinned, COORDINATES.state_lineage_id, runtimeConfig.record_input_codecs);
    expect(verified.body.human_act_resolution_ref.kind).toBe("echo-approval-decision-ref-v1");
    expect(runtimeConfig.record_policy_fact_projectors!.policyBinding(verified as never).policy_id).toBe(PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
    expect(approver(envelope)).toEqual({ ...COORDINATES, approval_id: "apr_composed", ...APPROVER });
  });
  it("composes an injected approver beside the approval decision approver", async () => {
    const { envelope } = await publishedDecision();
    const alternate = { ...COORDINATES, approval_id: "alternate", ...APPROVER };
    const { approver } = await composed({ api: { record_approver: value => value.protocol === "alternate" ? alternate : undefined } });
    expect(approver(envelope)).toEqual({ ...COORDINATES, approval_id: "apr_composed", ...APPROVER });
    expect(approver({ protocol: "alternate" })).toEqual(alternate);
    expect(approver({ protocol: "unknown" })).toBeUndefined();
  });
  it("fails closed on an unknown record protocol", async () => {
    const { envelope, signer } = await publishedDecision();
    const { runtimeConfig, approver } = await composed();
    const unknown = JSON.parse(JSON.stringify(envelope)) as { body: { human_act_resolution_ref: { kind: string } } };
    unknown.body.human_act_resolution_ref.kind = "echo-unknown-ref-v1";
    expect(() => verifyOrganizationRecordEnvelopeV4(unknown, signer.pinned, COORDINATES.state_lineage_id, runtimeConfig.record_input_codecs)).toThrow("unknown");
    expect(approver(unknown as unknown as JsonObject)).toBeUndefined();
  });
});
