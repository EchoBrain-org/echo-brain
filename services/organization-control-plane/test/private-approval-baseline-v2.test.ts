import { describe, expect, it } from "vitest";
import {
  applyOrganizationControlBaselineV2,
  ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID_V2,
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
  organizationControlBaselineSha256V2,
  organizationControlPrivateApprovalSqlV2,
} from "../src/persistence/baseline.js";
import { openOrganizationControlDatabase } from "../src/persistence/open-unmigrated-database.js";

const ORGANIZATION_CONTROL_BASELINE_SHA256_V2 =
  "sha256:63d34de0a55c008d2c669197d3b041293143e79148660246c47858afdf876009";

function openedV2Database() {
  const database = openOrganizationControlDatabase(":memory:");
  applyOrganizationControlBaselineV2(database);
  return database;
}

function columns(database: ReturnType<typeof openedV2Database>, table: string) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { readonly name: string }).name);
}

describe("Control Plane private-approval baseline v2", () => {
  it("pins the fresh V1-plus-private schema and preserves its role application ID", () => {
    const database = openedV2Database();
    try {
      expect(organizationControlBaselineSha256V2()).toBe(
        ORGANIZATION_CONTROL_BASELINE_SHA256_V2,
      );
      expect(database.pragma("application_id", { simple: true })).toBe(
        ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID_V2,
      );
      expect(database.pragma("user_version", { simple: true })).toBe(
        ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
      );
      expect(organizationControlPrivateApprovalSqlV2()).not.toContain(
        "organization_approval_binding_",
      );
      expect(
        columns(
          database,
          "organization_private_approval_surface_binding_contracts_v2",
        ),
      ).toEqual([
        "approval_binding_id",
        "contract_json",
        "contract_sha256",
        "connection_id",
        "connection_contract_sha256",
        "interaction_kind",
        "interaction_route",
        "interaction_schema_version",
        "created_at",
      ]);
      expect(
        columns(
          database,
          "organization_private_approval_surface_binding_current_v2",
        ),
      ).toEqual([
        "approval_binding_id",
        "contract_sha256",
        "connection_state_sha256",
        "current_status",
        "updated_at",
      ]);
      expect(columns(database, "organization_private_approval_pending_contracts_v2")).toEqual([
        "approval_id",
        "candidate_id",
        "organization_id",
        "authority_id",
        "assignment_version",
        "pending_json",
        "pending_sha256",
        "stage_command_id",
        "stage_command_semantic_sha256",
        "connection_id",
        "connection_contract_sha256",
        "connection_state_sha256",
        "approval_binding_id",
        "approval_binding_contract_sha256",
        "external_identity_link_id",
        "external_identity_link_contract_sha256",
        "assignee_principal_id",
        "assignee_membership_id",
        "slack_workspace_id",
        "slack_enterprise_id",
        "slack_subject_id",
        "canonical_record_policy_id",
        "created_at",
      ]);
      expect(columns(database, "organization_private_approval_card_bindings_v2")).toContain(
        "provider_message_ts",
      );
      expect(
        columns(database, "organization_private_approval_signed_action_receipts_v2"),
      ).toContain("raw_payload_sha256");
      expect(columns(database, "organization_private_approval_terminal_evidence_v2")).toContain(
        "audit_sequence",
      );
      expect(
        columns(database, "organization_private_approval_denied_action_receipts_v2"),
      ).toEqual([
        "provider_action_key",
        "signed_action_receipt_sha256",
        "reason_code",
        "denied_at",
      ]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("refuses in-place installation into a nonempty database", () => {
    const database = openedV2Database();
    try {
      expect(() => applyOrganizationControlBaselineV2(database)).toThrow(
        /completely empty database/,
      );
    } finally {
      database.close();
    }
  });
});
