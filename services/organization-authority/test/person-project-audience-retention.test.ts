import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { applyAuthorityBaselineV9 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { SqlitePersonDocumentRepositoryV1 } from "../src/adapters/persistence/sqlite/document-v1.js";
import { SqlitePersonTextSourceInboxV1 } from "../src/adapters/persistence/sqlite/person-text-source-v1.js";
import { SqliteSourceAdmissionStoreV1 } from "../src/adapters/persistence/sqlite/source-admission-v1.js";
import { assertPersonSourceAdmissionV1 } from "../src/adapters/persistence/sqlite/person-source-admission-v1.js";

const databases: Database.Database[] = [];
const NOW = "2026-09-23T00:00:00.000Z";
const ORG = "org_11111111-1111-4111-8111-111111111111";
const AUTHORITY = "oau_11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "prn_11111111-1111-4111-8111-111111111111";
const MEMBER = "mem_11111111-1111-4111-8111-111111111111";
const PROJECT = "prj_11111111-1111-4111-8111-111111111111";
const PROJECT_TWO = "prj_22222222-2222-4222-8222-222222222222";

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = new Database(":memory:"); databases.push(database); database.pragma("foreign_keys=ON"); applyAuthorityBaselineV9(database);
  database.prepare("INSERT INTO authority_metadata VALUES (1, ?, ?, 'Fixture', '{}', ?, ?)").run(AUTHORITY, ORG, NOW, NOW);
  database.prepare("INSERT INTO authority_principals VALUES (?, ?, 'PM', ?)").run(PRINCIPAL, ORG, NOW);
  database.prepare("INSERT INTO authority_memberships(membership_id,organization_id,principal_id,membership_type,status,provisioned_at) VALUES (?, ?, ?, 'owner', 'active', ?)").run(MEMBER, ORG, PRINCIPAL, NOW);
  database.prepare("INSERT INTO authority_project_authorization_state_v1 VALUES (?, 0, ?)").run(ORG, NOW);
  for (const project of [PROJECT, PROJECT_TWO]) {
    database.prepare("INSERT INTO authority_projects_v1 VALUES (?, ?, ?, ?, ?, ?, 'owner')").run(project, ORG, project, NOW, PRINCIPAL, MEMBER);
    database.prepare("INSERT INTO authority_project_memberships_v1 VALUES (?, ?, ?, ?, ?, 'owner', 'lead', 'active', ?, NULL)").run(`pgm_${project.slice(4)}`, project, ORG, PRINCIPAL, MEMBER, NOW);
  }
  const actor = {
    organization_id: ORG, principal_id: PRINCIPAL, membership_id: MEMBER, membership_type: "owner" as const,
    identity_binding_id: "oib_fixture", session_family_id: "psf_fixture",
    access_credential_sha256: canonicalSha256("fixture credential"), person_state_sha256: canonicalSha256("fixture person state"),
    session_state_sha256: canonicalSha256("fixture session state"), checked_at: NOW,
    access_expires_at: "2026-09-23T01:00:00.000Z", hard_reauthentication_at: "2026-09-24T00:00:00.000Z",
  };
  return { database, actor };
}

describe("project-audience originals survive contributor departure", () => {
  it("keeps a queued V2 projects document processable after its uploader leaves", () => {
    const { database, actor } = fixture();
    const repository = new SqlitePersonDocumentRepositoryV1(database, () => NOW);
    const bytes = Buffer.from("shared hardware interface");
    repository.uploadV2(actor, { schema_version: 2, kind: "echo-person-document-upload-v2", request_id: "11111111-1111-4111-8111-111111111111", filename: "interface.txt", title: "Interface", content_length: bytes.byteLength, sha256: sha256Digest(bytes), association_project_ids: [PROJECT], audience: { kind: "projects", project_ids: [PROJECT, PROJECT_TWO] } }, bytes, () => actor);
    database.prepare("UPDATE authority_memberships SET status='revoked',revoked_at=?,revocation_reason='fixture' WHERE membership_id=?").run(NOW, MEMBER);
    const claim = repository.claimExtraction();
    expect(claim).toBeDefined();
    expect(claim?.source_scope.custody_ref).toBe(`projects:${canonicalSha256([PROJECT, PROJECT_TWO])}`);
  });

  it("binds scalar V3 project source admission to its one immutable audience link", async () => {
    const { database } = fixture();
    const request = { schema_version: 3 as const, kind: "echo-person-update-submit-v3" as const, request_id: "22222222-2222-4222-8222-222222222222", title: "Scalar project", text: "shared scalar evidence", association_project_ids: [] as string[], audience: { kind: "project" as const, project_id: PROJECT } };
    const context = `ctx_${canonicalSha256({ schema_version: 3, kind: "echo-person-update-source-v3", organization_id: ORG, membership_id: MEMBER, request_id: request.request_id }).slice(7)}`;
    database.prepare(`INSERT INTO authority_person_updates_v2
      (organization_id,principal_id,membership_id,membership_type,request_id,request_version,context_id,payload_sha256,title,text,audience_kind,audience_project_id,submitted_association_project_ids_json,audience_project_ids_json,project_id,received_at)
      VALUES (?,?,?,'owner',?,3,?,?,?,?, 'project', ?, '[]', ?, NULL, ?)`)
      .run(ORG, PRINCIPAL, MEMBER, request.request_id, context, canonicalSha256(request), request.title, request.text, PROJECT, JSON.stringify([PROJECT]), NOW);
    database.prepare("INSERT INTO authority_person_update_work_v2(context_id,state,retry_at) VALUES (?,'pending',?)").run(context, NOW);
    database.prepare("INSERT INTO authority_person_update_audience_projects_v1 VALUES (?, ?, ?)").run(context, PROJECT, ORG);
    const pulled = new SqlitePersonTextSourceInboxV1(database).next()!;
    const store = new SqliteSourceAdmissionStoreV1(database, (source, scope) => assertPersonSourceAdmissionV1(database, source, scope));
    await expect(store.admitSourceRevision(pulled)).resolves.toBe("admitted");
  });
});
