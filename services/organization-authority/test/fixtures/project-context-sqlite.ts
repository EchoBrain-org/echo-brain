import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { applyAuthorityBaselineV7 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import type { AuthorityPersonMembershipBinding } from "@echo-brain/organization-authority-kernel/application/ports/authority-repository";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import Database from "better-sqlite3";

/** Stable fixture time keeps durable receipt/order assertions meaningful. */
export const PROJECT_CONTEXT_NOW = "2026-09-21T22:01:00.000Z";
export const PROJECT_ALPHA = "prj_11111111-1111-4111-8111-111111111111" as const;
export const PROJECT_BETA = "prj_22222222-2222-4222-8222-222222222222" as const;

export const OWNER: AuthorityPersonMembershipBinding = {
  organization_id: "org_project_test",
  principal_id: "prn_owner",
  membership_id: "mem_11111111-1111-4111-8111-111111111111",
  membership_type: "owner",
};

export const MEMBER: AuthorityPersonMembershipBinding = {
  organization_id: OWNER.organization_id,
  principal_id: "prn_member",
  membership_id: "mem_22222222-2222-4222-8222-222222222222",
  membership_type: "employee",
};

export const RETURNED_MEMBER: AuthorityPersonMembershipBinding = {
  organization_id: OWNER.organization_id,
  principal_id: MEMBER.principal_id,
  membership_id: "mem_33333333-3333-4333-8333-333333333333",
  membership_type: "employee",
};

export const OUTSIDE_ORGANIZATION = "org_other";

export function authorization(
  actor: AuthorityPersonMembershipBinding = OWNER,
  changes: Partial<PersonAccessAuthorization> = {},
): PersonAccessAuthorization {
  return {
    ...actor,
    identity_binding_id: "identity-fixture",
    session_family_id: "session-fixture",
    access_credential_sha256: canonicalSha256("fixture credential"),
    person_state_sha256: canonicalSha256({ actor, version: 1 }),
    session_state_sha256: canonicalSha256("fixture session"),
    checked_at: PROJECT_CONTEXT_NOW,
    access_expires_at: "2026-09-21T23:01:00.000Z",
    hard_reauthentication_at: "2026-09-22T22:01:00.000Z",
    ...changes,
  };
}

/**
 * Creates the active V7 schema and a small single-organization tenancy.
 * A separate Authority database owns each organization, so cross-organization
 * regressions use absent foreign organization coordinates rather than inventing
 * an impossible second `authority_metadata` row.
 */
export function projectContextDatabase(path = ":memory:"): Database.Database {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  applyAuthorityBaselineV7(database);
  database.prepare(
    `INSERT INTO authority_metadata
       (singleton, authority_id, organization_id, organization_display_name, descriptor_json, created_at, last_observed_at)
     VALUES (1, 'oau_project_fixture', ?, 'Project fixture', '{}', ?, ?)`,
  ).run(OWNER.organization_id, PROJECT_CONTEXT_NOW, PROJECT_CONTEXT_NOW);
  database.prepare(
    "INSERT INTO authority_project_authorization_state_v1 (organization_id, revision, updated_at) VALUES (?, 0, ?)",
  ).run(OWNER.organization_id, PROJECT_CONTEXT_NOW);
  addMembership(database, OWNER, "Owner", null);
  addMembership(database, MEMBER, "Member", "member@example.test");
  return database;
}

export function addMembership(
  database: Database.Database,
  actor: AuthorityPersonMembershipBinding,
  displayName: string,
  email: string | null,
): void {
  database.prepare(
    "INSERT OR IGNORE INTO authority_principals (principal_id, organization_id, display_name, provisioned_at) VALUES (?, ?, ?, ?)",
  ).run(actor.principal_id, actor.organization_id, displayName, PROJECT_CONTEXT_NOW);
  database.prepare(
    `INSERT INTO authority_memberships
       (membership_id, organization_id, principal_id, membership_type, status, provisioned_at,
        revoked_at, revocation_reason, employee_email, employee_email_sha256)
     VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL, ?, ?)`,
  ).run(
    actor.membership_id,
    actor.organization_id,
    actor.principal_id,
    actor.membership_type,
    PROJECT_CONTEXT_NOW,
    email,
    email === null ? null : canonicalSha256({ email }),
  );
}

export function revokeMembership(
  database: Database.Database,
  actor: AuthorityPersonMembershipBinding,
): void {
  database.prepare(
    `UPDATE authority_memberships
       SET status = 'revoked', revoked_at = ?, revocation_reason = 'fixture'
       WHERE membership_id = ? AND organization_id = ?`,
  ).run(PROJECT_CONTEXT_NOW, actor.membership_id, actor.organization_id);
}
