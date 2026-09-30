import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type Database from "better-sqlite3";
import type { PersonAskScopeV2 } from "../../../application/ports/person-original-context-retrieval-v1.js";

/**
 * Ask's originals ACL, shared by Ask retrieval and the person list/open store
 * (ADR-0024) so the two can never disagree about who may read a note or a
 * document. `u` is a note custody row, `d` a document custody row.
 */
export type PersonOriginalPrefixV1 = "u" | "d";

/** The caller's active project grants, as the ACL reads them. */
export function personOriginalGrantedProjectIdsV1(database: Database.Database, actor: PersonAccessAuthorization): readonly string[] {
  const projects = database.prepare("SELECT project_id FROM authority_project_memberships_v1 WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'").all(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type) as readonly { readonly project_id: string }[];
  return projects.map((row) => row.project_id);
}

/** Audience: team, the caller's only_me rows, and project audiences the caller holds a grant in. */
export function personOriginalAclV1(prefix: PersonOriginalPrefixV1, actor: PersonAccessAuthorization, ids: readonly string[]): { readonly sql: string; readonly args: readonly string[] } {
  return Object.freeze({
    sql: `(${prefix}.audience_kind='team' OR (${prefix}.audience_kind='only_me' AND ${prefix}.membership_id=?) OR (${prefix}.audience_kind='project' AND ${prefix}.audience_project_id IN (${ids.map(() => "?").join(",") || "NULL"})) OR (${prefix}.audience_kind='projects' AND EXISTS (SELECT 1 FROM ${prefix === 'u' ? 'authority_person_update_audience_projects_v1' : 'authority_person_document_audience_projects_v1'} audience_project WHERE audience_project.${prefix === 'u' ? 'context_id' : 'document_id'}=${prefix}.${prefix === 'u' ? 'context_id' : 'document_id'} AND audience_project.organization_id=${prefix}.organization_id AND audience_project.project_id IN (${ids.map(() => "?").join(",") || "NULL"}))))`,
    args: [actor.membership_id, ...ids, ...ids],
  });
}

/**
 * The scope narrowing appended after the ACL. Project scope requires the
 * row's current association; mine requires the caller's own tenure, so it is
 * always a subset of global.
 */
export function personOriginalScopeFilterV1(prefix: PersonOriginalPrefixV1, actor: PersonAccessAuthorization, scope: PersonAskScopeV2): { readonly sql: string; readonly args: readonly string[] } {
  switch (scope.kind) {
    case "global":
      return Object.freeze({ sql: "", args: [] });
    case "project":
      return Object.freeze({
        sql: prefix === "u"
          ? "AND EXISTS (SELECT 1 FROM authority_project_context_associations_v1 association WHERE association.context_id=u.context_id AND association.organization_id=u.organization_id AND association.project_id=?)"
          : "AND EXISTS (SELECT 1 FROM authority_person_document_associations_v1 association WHERE association.document_id=d.document_id AND association.organization_id=d.organization_id AND association.project_id=?)",
        args: [scope.project_id],
      });
    case "mine":
      return Object.freeze({ sql: `AND ${prefix}.membership_id=? AND ${prefix}.principal_id=?`, args: [actor.membership_id, actor.principal_id] });
    default:
      return personUnknownScopeV1(scope);
  }
}

/** The default of every exhaustive scope switch: a compile error when a kind is added, a closed failure at run time. */
export function personUnknownScopeV1(scope: never): never {
  throw new AuthorityOperationError("invalid_request", `scope ${String((scope as { readonly kind?: unknown }).kind)} is invalid`);
}

/**
 * Every retained note version (V1 carrier, V2 and V3) with its custody
 * columns. A V1 row is only checked as parseable time at insert, so every
 * received_at is normalized to canonical milliseconds here.
 */
export const PERSON_ORIGINAL_NOTE_CUSTODY_V1 = `(SELECT request_version AS api_version,organization_id,principal_id,membership_id,membership_type,request_id,context_id,title,text,payload_sha256,audience_kind,audience_project_id,project_id,submitted_association_project_ids_json,audience_project_ids_json,strftime('%Y-%m-%dT%H:%M:%fZ',received_at) AS received_at FROM authority_person_updates_v2
  UNION ALL SELECT 1 AS api_version,organization_id,principal_id,membership_id,membership_type,request_id,context_id,title,text,payload_sha256,visibility AS audience_kind,NULL AS audience_project_id,NULL AS project_id,NULL AS submitted_association_project_ids_json,NULL AS audience_project_ids_json,strftime('%Y-%m-%dT%H:%M:%fZ',received_at) AS received_at FROM authority_person_updates_v1)`;
