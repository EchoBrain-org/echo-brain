import { randomUUID } from "node:crypto";
import { canonicalJson, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { PERSON_LIST_PAGE_SIZE_V1 } from "@echo-brain/organization-api";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type Database from "better-sqlite3";
import type { PersonListDirectoryPortV1, PersonListJoinedProjectV1 } from "../../../application/ports/person-list-v1.js";

type JoinedRow = PersonListJoinedProjectV1 & { readonly project_membership_id: string };

/**
 * The person list's own reads of the caller's projects and name, and its page
 * audit (ADR-0023). Kept apart from the project context repository: nothing
 * here writes a project row or decides item access.
 */
export class SqlitePersonListDirectoryV1 implements PersonListDirectoryPortV1 {
  constructor(private readonly database: Database.Database) {}

  joinedProjects(actor: PersonAccessAuthorization): ReturnType<PersonListDirectoryPortV1["joinedProjects"]> {
    const rows = this.database.prepare(`SELECT project.project_id, project.name, project.status, grant.role, grant.project_membership_id
      FROM authority_project_memberships_v1 AS grant
      JOIN authority_projects_v1 AS project ON project.project_id=grant.project_id AND project.organization_id=grant.organization_id
      JOIN authority_memberships AS membership ON membership.membership_id=grant.membership_id AND membership.organization_id=grant.organization_id
       AND membership.principal_id=grant.principal_id AND membership.membership_type=grant.membership_type AND membership.status='active'
      WHERE grant.organization_id=? AND grant.membership_id=? AND grant.principal_id=? AND grant.status='active'
      ORDER BY CASE project.status WHEN 'active' THEN 0 ELSE 1 END, project.created_at DESC, project.project_id ASC`)
      .all(actor.organization_id, actor.membership_id, actor.principal_id) as JoinedRow[];
    return Object.freeze({
      projects: Object.freeze(rows.map(({ project_id, name, role, status }) => Object.freeze({ project_id, name, role, status }))),
      grants_sha256: canonicalSha256(rows.map(({ project_id, project_membership_id }) => ({ project_id, project_membership_id }))),
      names_sha256: canonicalSha256(rows.map(({ project_id, name, role, status }) => ({ project_id, name, role, status }))),
    });
  }

  me(actor: PersonAccessAuthorization): { readonly display_name: string } | undefined {
    const row = this.database.prepare(`SELECT principal.display_name FROM authority_memberships m
      JOIN authority_principals principal ON principal.principal_id=m.principal_id
      WHERE m.organization_id=? AND m.membership_id=? AND m.principal_id=? AND m.membership_type=? AND m.status='active'`)
      .get(actor.organization_id, actor.membership_id, actor.principal_id, actor.membership_type) as { readonly display_name: string } | undefined;
    return row === undefined ? undefined : Object.freeze({ display_name: row.display_name });
  }

  /** Content-free: the response digest, a count and the stores' receipts. */
  audit(entry: Parameters<PersonListDirectoryPortV1["audit"]>[0]): Sha256Digest {
    if (!Number.isSafeInteger(entry.released_count) || entry.released_count < 0 || entry.released_count > PERSON_LIST_PAGE_SIZE_V1) {
      throw new AuthorityOperationError("invalid_output", "request failed");
    }
    const { actor } = entry;
    const body = {
      schema_version: 1, kind: "echo-person-list-page-audit-v1", audit_id: randomUUID(),
      organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id,
      session_family_id: actor.session_family_id, operation: entry.operation, scope_kind: entry.scope_kind,
      store_receipts: [...entry.store_receipts], response_sha256: entry.response_sha256, released_count: entry.released_count,
      checked_at: actor.checked_at,
    };
    const row_sha256 = canonicalSha256(body);
    this.database.prepare("INSERT INTO authority_project_read_audit_v1 (row_sha256, body_json, recorded_at) VALUES (?, ?, ?)")
      .run(row_sha256, canonicalJson(body), actor.checked_at);
    return row_sha256;
  }
}
