import { describe, expect, it } from "vitest";
import {
  validateOrganizationAdminOverview,
  validateOrganizationAuditPage,
  validateOrganizationMembershipPage,
  validateProvisionOrganizationMembershipRequest,
} from "../src/index.js";

const ids = {
  authority: "oau_00000000-0000-4000-8000-000000000001",
  organization: "org_00000000-0000-4000-8000-000000000001",
  principal: "prn_00000000-0000-4000-8000-000000000001",
  membership: "mem_00000000-0000-4000-8000-000000000001",
  command: "adm_00000000-0000-4000-8000-000000000001",
};

describe("current administration contracts", () => {
  it("validates member provisioning and its bounded member page", () => {
    expect(
      validateProvisionOrganizationMembershipRequest({
        command_id: ids.command,
        display_name: "Example Employee",
        membership_type: "employee",
      }),
    ).toMatchObject({ command_id: ids.command });

    expect(
      validateOrganizationMembershipPage({
        items: [{
          organization_id: ids.organization,
          principal_id: ids.principal,
          membership_id: ids.membership,
          display_name: "Example Employee",
          membership_type: "employee",
          status: "active",
          provisioned_at: "2026-08-23T12:00:00.000Z",
          revoked_at: null,
          revocation_reason: null,
        }],
        next_cursor: null,
      }),
    ).toMatchObject({ next_cursor: null });
  });

  it("validates the current admin overview and audit page", () => {
    expect(
      validateOrganizationAdminOverview({
        organization_id: ids.organization,
        organization_display_name: "ECHO",
        authority_id: ids.authority,
        authority_pin_sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        created_at: "2026-08-23T12:00:00.000Z",
        last_observed_at: "2026-08-23T12:01:00.000Z",
        counts: {
          memberships: 1,
          active_memberships: 1,
          revoked_memberships: 0,
          installations: 0,
          active_installations: 0,
          revoked_installations: 0,
          enrollment_grants: 0,
          pending_enrollment_grants: 0,
          consumed_enrollment_grants: 0,
          expired_enrollment_grants: 0,
          audit_entries: 1,
        },
      }),
    ).toMatchObject({ organization_id: ids.organization });

    expect(
      validateOrganizationAuditPage({
        items: [{
          audit_sequence: 1,
          occurred_at: "2026-08-23T12:00:00.000Z",
          actor_kind: "admin",
          action: "membership.provisioned",
          subject_id: ids.membership,
          detail: {},
        }],
        next_cursor: null,
      }),
    ).toMatchObject({ next_cursor: null });
  });
});
