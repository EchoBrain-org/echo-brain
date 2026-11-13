import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import type { PersonUploadAudienceV3, ProjectIdV1 } from "@echo-brain/organization-api";

/** The audience columns a stored note or document row carries. */
interface StoredUploadAudienceRowV1 {
  readonly organization_id: string;
  readonly membership_id: string;
  readonly audience_kind: string;
  readonly audience_project_id: string | null;
  readonly audience_project_ids_json?: string | null;
}

/** A stored project set: exactly the canonical JSON array of project IDs custody wrote. */
export function storedProjectIdsV1(json: string | null | undefined): readonly ProjectIdV1[] {
  let value: unknown;
  try { value = typeof json === "string" ? JSON.parse(json) : undefined; } catch { value = undefined; }
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string") || canonicalJson(value) !== json) {
    throw new Error("stored project set is invalid");
  }
  return Object.freeze(value as ProjectIdV1[]);
}

/** The V3 audience a stored row names: only me, the team, one project or a project set. */
export function storedUploadAudienceV3(row: StoredUploadAudienceRowV1): PersonUploadAudienceV3 {
  if (row.audience_kind === "projects") return Object.freeze({ kind: "projects" as const, project_ids: storedProjectIdsV1(row.audience_project_ids_json) });
  if (row.audience_kind === "project" && row.audience_project_id !== null) return { kind: "project", project_id: row.audience_project_id as ProjectIdV1 };
  if (row.audience_kind === "only_me" || row.audience_kind === "team") return { kind: row.audience_kind };
  throw new Error("stored audience is invalid");
}

/** The custody reference a stored audience commits its source to. */
export function storedUploadCustodyRefV1(row: StoredUploadAudienceRowV1): string {
  if (row.audience_kind === "projects") return `projects:${canonicalSha256(storedProjectIdsV1(row.audience_project_ids_json))}`;
  if (row.audience_kind === "project") return `project:${row.audience_project_id}`;
  return row.audience_kind === "team" ? `organization:${row.organization_id}` : `membership:${row.membership_id}`;
}

/** A V3 note's context ID: the digest of its request coordinates. */
export function personNoteContextIdV1(owner: { readonly organization_id: string; readonly membership_id: string }, request_id: string): string {
  return `ctx_${canonicalSha256({ schema_version: 3, kind: "echo-person-update-source-v3", organization_id: owner.organization_id, membership_id: owner.membership_id, request_id }).slice(7)}`;
}
