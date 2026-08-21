import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openAndMigrateOrganizationControlDatabase } from "../src/persistence/open-database.js";
import { OrganizationIntegrationsRepository } from "../src/persistence/organization-integrations-repository.js";
import type {
  ApprovalAuthorizationEvidenceLookup,
  RecordPermissionDecisionInput,
} from "../src/application/contracts.js";

const NOW = "2026-08-08T12:00:00.000Z";
const ORGANIZATION_ID = "org_22222222-2222-4222-8222-222222222222";
const AUTHORITY_ID = "oau_11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "ins_77777777-7777-4777-8777-777777777777";
const PRINCIPAL_ID = "prn_33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_ID = "mem_44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "pcr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APPROVAL_ID = "f".repeat(64);
const ADAPTER_BINDING_ID = "bnd_55555555-5555-4555-8555-555555555555";
const PERMISSION_GRANT_ID = "pgr_66666666-6666-4666-8666-666666666666";
const AUDIENCE_NOTICE_SHA256 = digest("audience-notice");
const MESSAGE_PRESENTATION_SHA256 = digest("message-presentation");

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function openRepository(): {
  repository: OrganizationIntegrationsRepository;
  database: Database.Database;
} {
  const database = openAndMigrateOrganizationControlDatabase(":memory:");
  // This suite exercises the lookup in isolation. The binding and grant rows
  // a real evaluation references are seeded end to end by the authority's
  // record-ingest suite; here only the audit row's own columns matter.
  database.pragma("foreign_keys = OFF");
  database
    .prepare(
      `INSERT INTO organization_control_plane_metadata (
         singleton, control_plane_id, organization_id, authority_id,
         authority_descriptor_sha256, created_at
       ) VALUES (1, 'ocp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ?, ?, ?, ?)`,
    )
    .run(ORGANIZATION_ID, AUTHORITY_ID, digest("authority"), NOW);
  return {
    repository: new OrganizationIntegrationsRepository(database, {
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
    }),
    database,
  };
}

function decision(
  overrides: Partial<RecordPermissionDecisionInput> = {},
): RecordPermissionDecisionInput {
  return {
    request_id: REQUEST_ID,
    request_sha256: digest("request"),
    provider_event_sha256: digest("provider-event"),
    action: "approve",
    allowed: true,
    reason_code: "active_membership_and_direct_grant",
    principal_id: PRINCIPAL_ID,
    membership_id: MEMBERSHIP_ID,
    adapter_binding_id: ADAPTER_BINDING_ID,
    permission_grant_id: PERMISSION_GRANT_ID,
    evaluated_at: NOW,
    authority_evidence_sha256: digest("authority-status"),
    authority_checked_at: NOW,
    organization_id: ORGANIZATION_ID,
    caller_principal_id: PRINCIPAL_ID,
    caller_membership_id: MEMBERSHIP_ID,
    installation_id: INSTALLATION_ID,
    identity_link_id: null,
    connection_id: null,
    approval_id: APPROVAL_ID,
    detail: {
      provider: "slack",
      provider_subject_id: "U12345678",
    },
    ...overrides,
  };
}

function lookup(
  overrides: Partial<ApprovalAuthorizationEvidenceLookup> = {},
): ApprovalAuthorizationEvidenceLookup {
  return {
    organization_id: ORGANIZATION_ID,
    installation_id: INSTALLATION_ID,
    approval_id: APPROVAL_ID,
    action: "approve",
    request_id: REQUEST_ID,
    principal_id: PRINCIPAL_ID,
    membership_id: MEMBERSHIP_ID,
    request_sha256: digest("request"),
    provider_event_sha256: digest("provider-event"),
    adapter_binding_id: ADAPTER_BINDING_ID,
    permission_grant_id: PERMISSION_GRANT_ID,
    reason_code: "active_membership_and_direct_grant",
    evaluated_at: NOW,
    ...overrides,
  };
}

describe("allowed approval authorization evidence lookup", () => {
  it("matches the exact row the control plane appended", () => {
    const { repository, database } = openRepository();
    try {
      repository.recordPermissionDecision(decision());

      expect(
        repository.findAllowedApprovalAuthorizationEvidence(lookup()),
      ).toEqual({ status: "matched" });
    } finally {
      database.close();
    }
  });

  it("returns the exact pilot eligibility proof from notice-qualified audit detail", () => {
    const { repository, database } = openRepository();
    try {
      repository.recordPermissionDecision(
        decision({
          reason_code: "active_membership_direct_grant_pilot_notice_v1",
          detail: {
            provider: "slack",
            provider_subject_id: "U12345678",
            presentation_policy_id: "pilot-two-person-audience-v1",
            audience_notice_sha256: AUDIENCE_NOTICE_SHA256,
            message_presentation_sha256: MESSAGE_PRESENTATION_SHA256,
          },
        }),
      );

      expect(
        repository.findAllowedApprovalAuthorizationEvidence(
          lookup({
            reason_code:
              "active_membership_direct_grant_pilot_notice_v1",
          }),
        ),
      ).toEqual({
        status: "matched",
        permission_pilot_eligibility: {
          policy_id: "pilot-member-readable-v1",
          presentation_policy_id: "pilot-two-person-audience-v1",
          audience_notice_sha256: AUDIENCE_NOTICE_SHA256,
          message_presentation_sha256: MESSAGE_PRESENTATION_SHA256,
        },
      });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "missing presentation policy",
      detail: {
        audience_notice_sha256: AUDIENCE_NOTICE_SHA256,
        message_presentation_sha256: MESSAGE_PRESENTATION_SHA256,
      },
    },
    {
      label: "changed presentation policy",
      detail: {
        presentation_policy_id: "other-policy",
        audience_notice_sha256: AUDIENCE_NOTICE_SHA256,
        message_presentation_sha256: MESSAGE_PRESENTATION_SHA256,
      },
    },
    {
      label: "missing audience digest",
      detail: {
        presentation_policy_id: "pilot-two-person-audience-v1",
        message_presentation_sha256: MESSAGE_PRESENTATION_SHA256,
      },
    },
    {
      label: "malformed message digest",
      detail: {
        presentation_policy_id: "pilot-two-person-audience-v1",
        audience_notice_sha256: AUDIENCE_NOTICE_SHA256,
        message_presentation_sha256: "sha256:not-a-digest",
      },
    },
  ])("reports corrupt notice evidence with $label", ({ detail }) => {
    const { repository, database } = openRepository();
    try {
      repository.recordPermissionDecision(
        decision({
          reason_code: "active_membership_direct_grant_pilot_notice_v1",
          detail,
        }),
      );

      expect(
        repository.findAllowedApprovalAuthorizationEvidence(
          lookup({
            reason_code:
              "active_membership_direct_grant_pilot_notice_v1",
          }),
        ),
      ).toEqual({ status: "corrupt" });
    } finally {
      database.close();
    }
  });

  it("ignores authority_evidence_sha256, which digests status and not evidence", () => {
    const { repository, database } = openRepository();
    try {
      repository.recordPermissionDecision(
        decision({ authority_evidence_sha256: digest("something-else") }),
      );

      // Binding actual stored audit fields is the rule; comparing an invented
      // evidence digest against a status digest would authorize nothing.
      expect(
        repository.findAllowedApprovalAuthorizationEvidence(lookup()),
      ).toMatchObject({ status: "matched" });
    } finally {
      database.close();
    }
  });

  it("reports absent for a denied evaluation", () => {
    const { repository, database } = openRepository();
    try {
      repository.recordPermissionDecision(
        decision({ allowed: false, reason_code: "installation_inactive" }),
      );

      expect(
        repository.findAllowedApprovalAuthorizationEvidence(lookup()),
      ).toEqual({ status: "absent" });
    } finally {
      database.close();
    }
  });

  it("reports absent when any bound field differs", () => {
    const { repository, database } = openRepository();
    try {
      repository.recordPermissionDecision(decision());

      for (const override of [
        { organization_id: "org_00000000-0000-4000-8000-000000000000" },
        { installation_id: "ins_00000000-0000-4000-8000-000000000000" },
        { approval_id: "a".repeat(64) },
        { action: "reject" as const },
        { request_id: "pcr_00000000-0000-4000-8000-000000000000" },
        { principal_id: "prn_00000000-0000-4000-8000-000000000000" },
        { membership_id: "mem_00000000-0000-4000-8000-000000000000" },
        { request_sha256: digest("other-request") },
        { provider_event_sha256: digest("other-provider-event") },
        { adapter_binding_id: "bnd_00000000-0000-4000-8000-000000000000" },
        { permission_grant_id: "pgr_00000000-0000-4000-8000-000000000000" },
        { reason_code: "no_active_link_binding_or_grant" },
        { evaluated_at: "2020-01-01T00:00:00.000Z" },
      ]) {
        expect(
          repository.findAllowedApprovalAuthorizationEvidence(
            lookup(override as Partial<ApprovalAuthorizationEvidenceLookup>),
          ),
        ).toEqual({ status: "absent" });
      }
    } finally {
      database.close();
    }
  });

  it("reports ambiguous when two rows could be the same evaluation", () => {
    const { repository, database } = openRepository();
    try {
      repository.recordPermissionDecision(decision());
      repository.recordPermissionDecision(decision());

      // Ambiguity denies: "some row might be this evaluation" is not evidence.
      expect(
        repository.findAllowedApprovalAuthorizationEvidence(lookup()),
      ).toEqual({ status: "ambiguous" });
    } finally {
      database.close();
    }
  });

  it("matches a reject evaluation only under the reject action", () => {
    const { repository, database } = openRepository();
    try {
      repository.recordPermissionDecision(decision({ action: "reject" }));

      expect(
        repository.findAllowedApprovalAuthorizationEvidence(
          lookup({ action: "reject" }),
        ),
      ).toMatchObject({ status: "matched" });
      expect(
        repository.findAllowedApprovalAuthorizationEvidence(lookup()),
      ).toEqual({ status: "absent" });
    } finally {
      database.close();
    }
  });
});
