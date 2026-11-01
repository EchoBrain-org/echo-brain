import { randomUUID } from "node:crypto";
import { canonicalJson, canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import {
  assertPersonDocumentOriginalV1, validatePersonUpdateReceiptV2, validatePersonUpdateSubmitV2,
  type PersonUpdateReceiptV2, type PersonUploadAudienceV2, type ProjectIdV1,
} from "@echo-brain/organization-api";
import { applyAuthorityBaseline } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import type { AuthorityPersonMembershipBinding } from "@echo-brain/organization-authority-kernel/application/ports/authority-repository";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import Database from "better-sqlite3";
import { personNoteContextIdV1 } from "../../src/adapters/persistence/sqlite/person-upload-custody-v1.js";

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
 * Creates the active V15 schema and a small single-organization tenancy.
 * A separate Authority database owns each organization, so cross-organization
 * regressions use absent foreign organization coordinates rather than inventing
 * an impossible second `authority_metadata` row.
 */
export function projectContextDatabase(path = ":memory:"): Database.Database {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  applyAuthorityBaseline(database);
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

/** Seeds an active project as `creator` made it, named after its id and created at PROJECT_CONTEXT_NOW unless told otherwise. */
export function seedProject(
  database: Database.Database,
  projectId: string,
  creator: AuthorityPersonMembershipBinding,
  options: { readonly name?: string; readonly status?: "active" | "archived"; readonly created_at?: string } = {},
): void {
  database.prepare(`INSERT INTO authority_projects_v1
    (project_id,organization_id,name,status,created_at,creator_principal_id,creator_membership_id,creator_membership_type)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, creator.organization_id, options.name ?? projectId, options.status ?? "active",
    options.created_at ?? PROJECT_CONTEXT_NOW, creator.principal_id, creator.membership_id, creator.membership_type);
}

/** Seeds an active project grant, under a fresh id and granted at PROJECT_CONTEXT_NOW unless told otherwise. */
export function seedProjectMember(
  database: Database.Database,
  projectId: string,
  member: AuthorityPersonMembershipBinding,
  role: "lead" | "member",
  options: { readonly id?: string; readonly granted_at?: string } = {},
): void {
  database.prepare(`INSERT INTO authority_project_memberships_v1
    (project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at)
    VALUES (?,?,?,?,?,?,?,'active',?)`).run(options.id ?? `pgm_${randomUUID()}`, projectId, member.organization_id,
    member.principal_id, member.membership_id, member.membership_type, role, options.granted_at ?? PROJECT_CONTEXT_NOW);
}

/**
 * A note as the retired V2 submit stored it (ADR-0048), for the reads that still find stored V2 notes: its search, the
 * person list and open, Ask and enrichment. The same rows, context ID, payload digest and receipt the submit wrote, with
 * the same project checks left to the caller: it is a seed, not a route.
 */
export function insertStoredNoteV2(
  database: Database.Database,
  actor: AuthorityPersonMembershipBinding,
  input: { readonly request_id?: string; readonly title: string; readonly text: string; readonly project_id: ProjectIdV1 | null; readonly audience: PersonUploadAudienceV2 },
  receivedAt = PROJECT_CONTEXT_NOW,
): PersonUpdateReceiptV2 {
  const request = validatePersonUpdateSubmitV2({
    schema_version: 2, kind: "echo-person-update-submit-v2", request_id: input.request_id ?? randomUUID(),
    title: input.title, text: input.text, project_id: input.project_id, audience: input.audience,
  });
  const context_id = personNoteContextIdV1(actor, request.request_id, 2);
  const audienceProjectId = request.audience.kind === "project" ? request.audience.project_id : null;
  database.prepare(`INSERT INTO authority_person_updates_v2
    (organization_id,principal_id,membership_id,membership_type,request_id,request_version,context_id,payload_sha256,title,text,audience_kind,audience_project_id,submitted_association_project_ids_json,audience_project_ids_json,project_id,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, request.request_id, 2, context_id,
    canonicalSha256(request), request.title, request.text, request.audience.kind, audienceProjectId,
    canonicalJson(request.project_id === null ? [] : [request.project_id]), canonicalJson(audienceProjectId === null ? [] : [audienceProjectId]),
    request.project_id, receivedAt,
  );
  database.prepare("INSERT INTO authority_person_update_work_v2 (context_id, state, retry_at) VALUES (?, 'pending', ?)").run(context_id, receivedAt);
  if (request.project_id !== null) {
    database.prepare(`INSERT INTO authority_project_context_associations_v1
      (context_id, project_id, organization_id, associator_principal_id, associator_membership_id, associator_membership_type, associated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(context_id, request.project_id, actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, receivedAt);
  }
  if (audienceProjectId !== null) {
    database.prepare("INSERT INTO authority_person_update_audience_projects_v1 (context_id, project_id, organization_id) VALUES (?, ?, ?)").run(context_id, audienceProjectId, actor.organization_id);
  }
  const receipt = validatePersonUpdateReceiptV2({
    schema_version: 2, kind: "echo-person-update-receipt-v2", request_id: request.request_id, context_id, received_at: receivedAt,
    project_id: request.project_id, audience: request.audience, state: "received",
  });
  const command_sha256 = canonicalSha256({
    schema_version: 1, kind: "echo-project-command-identity-v1",
    actor: { organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id },
    operation: "upload_submit", request,
  });
  database.prepare(`INSERT INTO authority_project_command_receipts_v1
    (organization_id, principal_id, membership_id, membership_type, request_id, operation, command_sha256, receipt_json, receipt_sha256, committed_at)
    VALUES (?, ?, ?, ?, ?, 'upload_submit', ?, ?, ?, ?)`).run(
    actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, request.request_id,
    command_sha256, canonicalJson(receipt), canonicalSha256(receipt), receivedAt,
  );
  return receipt;
}

/**
 * A document as the retired V1 upload stored it (ADR-0048), for the reads that still serve stored V1 documents: V2
 * status, metadata, original, text and search, the person list and open, Ask and extraction. The same rows, document ID,
 * payload digest and receipt the upload wrote, with its project checks left to the caller: it is a seed, not a route.
 * Returns the stored receipt.
 */
export function insertStoredDocumentV1(
  database: Database.Database,
  actor: AuthorityPersonMembershipBinding,
  input: { readonly request_id?: string; readonly filename: string; readonly title: string; readonly audience: PersonUploadAudienceV2; readonly project_id: ProjectIdV1 | null },
  bytes: Uint8Array,
  receivedAt = PROJECT_CONTEXT_NOW,
): { readonly kind: "echo-person-document-receipt-v1"; readonly request_id: string; readonly document_id: `doc_${string}`; readonly received_at: string } & Record<string, unknown> {
  const value = {
    schema_version: 1, kind: "echo-person-document-upload-v1", request_id: input.request_id ?? randomUUID(), filename: input.filename, title: input.title,
    content_length: bytes.byteLength, sha256: sha256Digest(bytes), audience: input.audience, project_id: input.project_id,
  } as const;
  const media = assertPersonDocumentOriginalV1(value, bytes);
  const payload = canonicalSha256(value);
  const document_id = `doc_${canonicalSha256({ kind: "echo-person-document-id-v1", organization_id: actor.organization_id, membership_id: actor.membership_id, request_id: value.request_id }).slice(7)}` as const;
  const audienceProjectId = value.audience.kind === "project" ? value.audience.project_id : null;
  const receipt = { ...value, kind: "echo-person-document-receipt-v1" as const, document_id, detected_media_type: media, received_at: receivedAt, state: "saved", extraction_state: "extracting" };
  database.prepare(`INSERT INTO authority_person_documents_v1
    (document_id,organization_id,principal_id,membership_id,membership_type,request_id,request_version,filename,title,detected_media_type,original_size,original_sha256,payload_sha256,audience_kind,audience_project_id,submitted_association_project_ids_json,audience_project_ids_json,project_id,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    document_id, actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, value.request_id, 1, value.filename, value.title, media,
    value.content_length, value.sha256, payload, value.audience.kind, audienceProjectId,
    canonicalJson(value.project_id === null ? [] : [value.project_id]), canonicalJson(audienceProjectId === null ? [] : [audienceProjectId]), value.project_id, receivedAt,
  );
  database.prepare("INSERT INTO authority_person_document_originals_v1(document_id,original) VALUES (?,?)").run(document_id, bytes);
  database.prepare("INSERT INTO authority_person_document_work_v1(document_id,retry_at) VALUES (?,?)").run(document_id, receivedAt);
  if (value.project_id !== null) {
    database.prepare("INSERT INTO authority_person_document_associations_v1(document_id,project_id,organization_id,associated_at) VALUES (?,?,?,?)").run(document_id, value.project_id, actor.organization_id, receivedAt);
  }
  if (audienceProjectId !== null) {
    database.prepare("INSERT INTO authority_person_document_audience_projects_v1(document_id,project_id,organization_id) VALUES (?,?,?)").run(document_id, audienceProjectId, actor.organization_id);
  }
  database.prepare(`INSERT INTO authority_person_document_receipts_v1(organization_id,membership_id,request_id,payload_sha256,receipt_json,receipt_sha256,committed_at)
    VALUES (?,?,?,?,?,?,?)`).run(actor.organization_id, actor.membership_id, value.request_id, payload, canonicalJson(receipt), canonicalSha256(receipt), receivedAt);
  return receipt;
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
