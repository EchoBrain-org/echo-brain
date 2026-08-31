import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import type { JsonValue } from "@echo-brain/federation-protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyAuthorityBaselineV1 } from "../../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../../src/adapters/persistence/sqlite/open-unmigrated-database.js";
import { personLoginGrantExpectedEmailSha256 } from "../../src/domain/person-email-binding.js";
import {
  resolveGranolaMeetingOwnerPrivateApprovalTargetV1,
} from "../../src/composition/resolve-granola-meeting-owner-private-approval-target-v1.js";
import type { MeetingDocument } from "../../src/processing/core/contracts/meeting.js";
import {
  SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
  buildExternalHumanIdentityLinkContractV2,
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
} from "../../../organization-control-plane/src/application/person-slack-approval-contracts-v2.js";
import { applyOrganizationControlBaselineV1 } from "../../../organization-control-plane/src/persistence/baseline.js";

const COORDINATES = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
});
const OWNER = Object.freeze({
  principal_id: "prn_00000000-0000-4000-8000-000000000001",
  membership_id: "mem_00000000-0000-4000-8000-000000000001",
  membership_type: "owner" as const,
});
const CONNECTION_ID = "con_00000000-0000-4000-8000-000000000001";
const OWNER_EMAIL = "owner@example.com";
const NOW = "2026-08-28T00:00:00.000Z";
const BOUND_AT = "2026-08-28T00:01:00.000Z";
const EXPIRES_AT = "2026-08-28T00:15:00.000Z";
const databases: Database.Database[] = [];

function meetingWithExtensions(extensions: unknown): MeetingDocument {
  return {
    schema_version: 1,
    id: "meeting-1",
    provenance: {
      source: {
        kind: "meeting-source",
        adapter_id: "granola",
        instance_id: "granola-primary",
        version: "2.2.0",
      },
      external_id: "note-1",
      canonical_revision: "sha256:note-1",
      observed_at: NOW,
      normalizer_version: "2.2.0",
    },
    capture: { state: "complete", components: [] },
    participants: [],
    content: [],
    artifacts: [],
    extensions: extensions as MeetingDocument["extensions"],
  };
}

function meeting(organizer: JsonValue | undefined): MeetingDocument {
  return meetingWithExtensions(
    organizer === undefined
      ? {}
      : { granola: { calendar_event: { organizer } } },
  );
}

function openAuthority(withMember: boolean): Database.Database {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV1(database);
  database.pragma("foreign_keys = OFF");
  database.exec("DROP TRIGGER authority_oidc_identity_bindings_provenance_insert");
  database
    .prepare(
      `INSERT INTO authority_metadata
         (singleton, authority_id, organization_id, organization_display_name,
          descriptor_json, created_at, last_observed_at)
       VALUES (1, ?, ?, 'Test Organization', '{}', ?, ?)`,
    )
    .run(COORDINATES.authority_id, COORDINATES.organization_id, NOW, NOW);
  if (!withMember) return database;

  database
    .prepare(
      `INSERT INTO authority_principals
         (principal_id, organization_id, display_name, provisioned_at)
       VALUES (?, ?, 'Meeting Owner', ?)`,
    )
    .run(OWNER.principal_id, COORDINATES.organization_id, NOW);
  database
    .prepare(
      `INSERT INTO authority_memberships
         (membership_id, organization_id, principal_id, membership_type, status,
          provisioned_at, revoked_at, revocation_reason, employee_email,
          employee_email_sha256)
       VALUES (?, ?, ?, 'owner', 'active', ?, NULL, NULL, NULL, NULL)`,
    )
    .run(OWNER.membership_id, COORDINATES.organization_id, OWNER.principal_id, NOW);
  const grantSha = canonicalSha256({ test: "owner-login-grant" });
  const configurationSha = canonicalSha256({ test: "oidc-configuration" });
  database
    .prepare(
      `INSERT INTO authority_person_login_grants
         (login_grant_sha256, grant_purpose, organization_id, principal_id,
          membership_id, membership_type, expected_issuer,
          expected_email_sha256, oidc_configuration_sha256, issued_at,
          expires_at, consumed_at, invalidated_at)
       VALUES (?, 'oidc_identity_bootstrap', ?, ?, ?, 'owner', ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      grantSha,
      COORDINATES.organization_id,
      OWNER.principal_id,
      OWNER.membership_id,
      "https://issuer.example",
      personLoginGrantExpectedEmailSha256(OWNER_EMAIL),
      configurationSha,
      NOW,
      EXPIRES_AT,
    );
  database
    .prepare(
      `UPDATE authority_person_login_grants
          SET consumed_at = ?
        WHERE login_grant_sha256 = ?`,
    )
    .run(BOUND_AT, grantSha);
  database
    .prepare(
      `INSERT INTO authority_oidc_identity_bindings
         (identity_binding_id, issuer, subject, tenant_constraint_sha256,
          oidc_configuration_sha256, initial_login_attempt_id,
          initial_login_grant_sha256, organization_id, principal_id,
          membership_id, membership_type, status, bound_at, revoked_at,
          revocation_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'active', ?, NULL, NULL)`,
    )
    .run(
      "oib_00000000-0000-4000-8000-000000000001",
      "https://issuer.example",
      "subject-1",
      canonicalSha256({ test: "tenant" }),
      configurationSha,
      "ola_00000000-0000-4000-8000-000000000001",
      grantSha,
      COORDINATES.organization_id,
      OWNER.principal_id,
      OWNER.membership_id,
      BOUND_AT,
    );
  return database;
}

function openControlPlane(withLink: boolean): Database.Database {
  const database = new Database(":memory:");
  applyOrganizationControlBaselineV1(database);
  databases.push(database);
  const connection = buildOrganizationToolConnectionContractV2({
    ...COORDINATES,
    connection_id: CONNECTION_ID,
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: "T01",
    provider_enterprise_id: null,
    tool_kind: "slack",
    provider_app_id: "A01",
    provider_bot_id: "B01",
    provider_bot_user_id: "U_BOT",
    required_provider_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    public_connection_configuration_sha256: canonicalSha256({ test: "connection" }),
  });
  const connectionSha = canonicalSha256(connection);
  const state = buildOrganizationToolConnectionStateV2({
    connection_id: CONNECTION_ID,
    connection_contract_sha256: connectionSha,
    connection_status: "active",
    credential_reference_sha256: canonicalSha256({ test: "credential" }),
    observed_granted_scopes: [...SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES],
    verification_event_id: "verify_connection_01",
    verification_evidence_sha256: canonicalSha256({ test: "connection-proof" }),
    verification_revision: 1,
    verified_at: NOW,
  });
  database
    .prepare(
      `INSERT INTO organization_tool_connection_contracts
         (connection_id, contract_json, contract_sha256, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(CONNECTION_ID, canonicalJson(connection), connectionSha, NOW);
  database
    .prepare(
      `INSERT INTO organization_tool_connection_current_state
         (connection_id, connection_contract_sha256, state_json, state_sha256,
          current_status, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      CONNECTION_ID,
      connectionSha,
      canonicalJson(state),
      canonicalSha256(state),
      NOW,
    );
  if (!withLink) return database;

  const link = buildExternalHumanIdentityLinkContractV2({
    ...COORDINATES,
    external_identity_link_id: "clm_00000000-0000-4000-8000-000000000001",
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: "T01",
    provider_enterprise_id: null,
    provider_subject_id: "U012ABC",
    ...OWNER,
    verification_event_id: "verify_link_01",
    verification_evidence_sha256: canonicalSha256({ test: "link-proof" }),
    verified_at: NOW,
  });
  const linkSha = canonicalSha256(link);
  database
    .prepare(
      `INSERT INTO organization_external_human_link_contracts
         (external_identity_link_id, contract_sha256, contract_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(link.external_identity_link_id, linkSha, canonicalJson(link), NOW);
  database
    .prepare(
      `INSERT INTO organization_external_human_link_current
         (external_identity_link_id, contract_sha256, provider_issuer,
          provider_tenant_kind, provider_tenant_id, provider_enterprise_id,
          provider_subject_id, principal_id, membership_id, current_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      link.external_identity_link_id,
      linkSha,
      link.provider_issuer,
      link.provider_tenant_kind,
      link.provider_tenant_id,
      link.provider_enterprise_id,
      link.provider_subject_id,
      link.principal_id,
      link.membership_id,
      NOW,
    );
  return database;
}

function resolve(input: {
  readonly authority_database: Database.Database;
  readonly control_plane_database: Database.Database;
  readonly meeting?: MeetingDocument;
}) {
  return resolveGranolaMeetingOwnerPrivateApprovalTargetV1({
    ...input,
    meeting: input.meeting ?? meeting(OWNER_EMAIL),
    coordinates: COORDINATES,
    connection_id: CONNECTION_ID,
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Granola meeting-owner private approval target v1", () => {
  it("returns frozen owner and exact current Slack commitments without raw email", () => {
    const authority = openAuthority(true);
    try {
      const result = resolve({
        authority_database: authority,
        control_plane_database: openControlPlane(true),
      });

      expect(result).toMatchObject({
        assignee: OWNER,
        slack_target: {
          connection: { body: { connection_id: CONNECTION_ID } },
          current_slack_identity_link: {
            provider: "slack",
            provider_subject_id: "U012ABC",
          },
        },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result!.assignee)).toBe(true);
      expect(Object.isFrozen(result!.slack_target)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(OWNER_EMAIL);
    } finally {
      authority.close();
    }
  });

  it("fails closed when both the raw organizer and note owner are absent", () => {
    const authority = openAuthority(true);
    try {
      expect(
        resolve({
          authority_database: authority,
          control_plane_database: openControlPlane(true),
          meeting: meeting(undefined),
        }),
      ).toBeUndefined();
    } finally {
      authority.close();
    }
  });

  it("falls back to the canonical raw note owner only when the organizer is absent", () => {
    const authority = openAuthority(true);
    try {
      const control = openControlPlane(true);
      for (const candidate of [
        meetingWithExtensions({
          granola: { owner: { email: " OWNER@EXAMPLE.COM " } },
        }),
        meetingWithExtensions({
          granola: { calendar_event: {}, owner: OWNER_EMAIL },
        }),
        meetingWithExtensions({
          granola: { calendar_event: null, owner: { email: OWNER_EMAIL } },
        }),
      ]) {
        expect(
          resolve({ authority_database: authority, control_plane_database: control, meeting: candidate }),
        ).toMatchObject({ assignee: OWNER });
      }
    } finally {
      authority.close();
    }
  });

  it("never replaces present malformed or mismatched organizer evidence with the note owner", () => {
    const authority = openAuthority(true);
    try {
      const control = openControlPlane(true);
      for (const candidate of [
        meetingWithExtensions({
          granola: {
            calendar_event: "invalid",
            owner: { email: OWNER_EMAIL },
          },
        }),
        meetingWithExtensions({
          granola: {
            calendar_event: { organizer: { name: "Meeting owner" } },
            owner: { email: OWNER_EMAIL },
          },
        }),
        meetingWithExtensions({
          granola: {
            calendar_event: { organizer: "other@example.com" },
            owner: { email: OWNER_EMAIL },
          },
        }),
      ]) {
        expect(
          resolve({ authority_database: authority, control_plane_database: control, meeting: candidate }),
        ).toBeUndefined();
      }
    } finally {
      authority.close();
    }
  });

  it("uses only canonical provider organizer evidence and never falls back to attendees", () => {
    const authority = openAuthority(true);
    try {
      const control = openControlPlane(true);
      for (const candidate of [
        meetingWithExtensions({
          granola: { calendar_event: { organizer: " OWNER@EXAMPLE.COM " } },
        }),
        meetingWithExtensions({
          granola: { calendar_event: { organiser: { email: OWNER_EMAIL } } },
        }),
      ]) {
        expect(
          resolve({ authority_database: authority, control_plane_database: control, meeting: candidate }),
        ).toMatchObject({ assignee: OWNER });
      }

      const inheritedOrganizer = Object.create({ organizer: OWNER_EMAIL });
      const inheritedOwner = Object.create({ owner: OWNER_EMAIL });
      for (const candidate of [
        meetingWithExtensions({
          granola: {
            calendar_event: {
              organizer: { name: "Meeting owner" },
              organiser: OWNER_EMAIL,
            },
            attendees: [{ email: OWNER_EMAIL }],
          },
        }),
        meetingWithExtensions({
          granola: { calendar_event: inheritedOrganizer },
        }),
        meetingWithExtensions({ granola: inheritedOwner }),
      ]) {
        expect(
          resolve({ authority_database: authority, control_plane_database: control, meeting: candidate }),
        ).toBeUndefined();
      }
    } finally {
      authority.close();
    }
  });

  it("fails closed when the observed organizer has no current Authority member", () => {
    const authority = openAuthority(false);
    try {
      expect(
        resolve({
          authority_database: authority,
          control_plane_database: openControlPlane(true),
        }),
      ).toBeUndefined();
    } finally {
      authority.close();
    }
  });

  it("fails closed when the verified owner has no current Slack link", () => {
    const authority = openAuthority(true);
    try {
      expect(
        resolve({
          authority_database: authority,
          control_plane_database: openControlPlane(false),
        }),
      ).toBeUndefined();
    } finally {
      authority.close();
    }
  });
});
