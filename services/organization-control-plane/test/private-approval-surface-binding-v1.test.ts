import { describe, expect, it } from "vitest";
import {
  buildPrivateApprovalSurfaceBindingV1,
  validatePrivateApprovalSurfaceBindingV1,
} from "../src/application/private-approval-surface-binding-v1.js";
import { canonicalSha256 } from "../src/canonical/canonical-json.js";

const codec = Object.freeze({ sha256: canonicalSha256 });
const input = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
  connection_id: "con_00000000-0000-4000-8000-000000000001",
  connection_contract_sha256: `sha256:${"a".repeat(64)}` as const,
  connection_state_sha256: `sha256:${"b".repeat(64)}` as const,
  provider_app_id: "A01234567",
  provider_bot_id: "B01234567",
  provider_bot_user_id: "U01234567",
  slack_workspace_id: "T01234567",
  slack_enterprise_id: null,
  adapter_id: "slack-block-actions" as const,
  adapter_version: "v1" as const,
  interaction_path: "/v2/integrations/slack/interactions" as const,
  card_schema_version: 1 as const,
  action_namespace: "echo-private-approval-v1" as const,
  supported_policy_ids: [
    "restricted-reviewer-person-v2",
    "organization-member-readable-person-v2",
  ] as const,
});

describe("private approval surface binding V1", () => {
  it("derives a deterministic sealed Block Kit surface commitment", () => {
    const first = buildPrivateApprovalSurfaceBindingV1(input, codec);
    const second = buildPrivateApprovalSurfaceBindingV1(input, codec);
    expect(first).toEqual(second);
    expect(first.body.approval_surface_binding_id).toMatch(/^bnd_[0-9a-f]{32}$/);
    expect(first.sha256).toBe(canonicalSha256(first.body));
    expect(validatePrivateApprovalSurfaceBindingV1(first.body, codec)).toEqual(
      first.body,
    );
  });

  it("fails closed if a caller changes a surface field or the derived ID", () => {
    const binding = buildPrivateApprovalSurfaceBindingV1(input, codec).body;
    expect(() =>
      validatePrivateApprovalSurfaceBindingV1(
        { ...binding, interaction_path: "/unexpected" },
        codec,
      ),
    ).toThrow("surface configuration is invalid");
    expect(() =>
      validatePrivateApprovalSurfaceBindingV1(
        { ...binding, approval_surface_binding_id: "bnd_wrong" },
        codec,
      ),
    ).toThrow("binding id is not deterministic");
  });
});
