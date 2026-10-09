import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Digest } from "@echo-brain/federation-protocol";
import type { AuthorityPersonMembershipBinding } from "@echo-brain/organization-authority-kernel/application/ports/authority-repository";
import {
  validatePersonDocumentMetadataV1, validatePersonDocumentMetadataV2, validatePersonDocumentSearchResultV1,
  validatePersonDocumentSearchResultV2, validatePersonDocumentStatusV2, validatePersonUpdateStatusResultV3,
  type PersonUploadAudienceV3,
} from "@echo-brain/organization-api";
import { SqlitePersonDocumentRepositoryV1 } from "../src/adapters/persistence/sqlite/document-v1.js";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import { createPersonDocumentApplicationV1 } from "../src/application/document-v1.js";
import { createProjectContextApplicationV1 } from "../src/application/project-context-application-v1.js";
import { createOrganizationAuthorityHttpServer } from "../src/presentation/organization-authority-http-server.js";
import { MEMBER, OWNER, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase } from "./fixtures/project-context-sqlite.js";

/**
 * ADR-0023: a released upload names only the reader's current projects, and
 * only its uploader sees its request ID. Both readers are checked because the
 * organization owner has no bypass.
 */
const SHARED = "prj_11111111-1111-4111-8111-111111111111" as const;
const OWNER_ONLY = "prj_22222222-2222-4222-8222-222222222222" as const;
const MEMBER_ONLY = "prj_33333333-3333-4333-8333-333333333333" as const;
const SHARED_TOO = "prj_44444444-4444-4444-8444-444444444444" as const;

const databases: Database.Database[] = [];
const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }
  for (const database of databases.splice(0)) database.close();
});

function grant(database: Database.Database, projectId: string, actor: AuthorityPersonMembershipBinding, role: "lead" | "member"): void {
  database.prepare(`INSERT INTO authority_project_memberships_v1
    (project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at)
    VALUES (?,?,?,?,?,?,?,'active',?)`).run(`pgm_${randomUUID()}`, projectId, actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, role, PROJECT_CONTEXT_NOW);
}

function fixture() {
  const database = projectContextDatabase(); databases.push(database);
  const projects: readonly [string, AuthorityPersonMembershipBinding, readonly AuthorityPersonMembershipBinding[]][] = [
    [SHARED, OWNER, [MEMBER]], [OWNER_ONLY, OWNER, []], [MEMBER_ONLY, MEMBER, []], [SHARED_TOO, OWNER, [MEMBER]],
  ];
  for (const [projectId, lead, members] of projects) {
    database.prepare(`INSERT INTO authority_projects_v1
      (project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type)
      VALUES (?,?,?,?,?,?,?)`).run(projectId, lead.organization_id, projectId, PROJECT_CONTEXT_NOW, lead.principal_id, lead.membership_id, lead.membership_type);
    grant(database, projectId, lead, "lead");
    for (const member of members) grant(database, projectId, member, "member");
  }
  const authenticate = (token: string) => authorization(token === "member" ? MEMBER : OWNER);
  const documents = createPersonDocumentApplicationV1({ repository: new SqlitePersonDocumentRepositoryV1(database, () => PROJECT_CONTEXT_NOW), authenticate });
  const updates = createProjectContextApplicationV1({ repository: new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW), authenticate });
  const bytes = Buffer.from("shared interface requirements");
  const uploadV2 = (token: string, project_ids: readonly string[]) => documents.uploadV2(token, {
    schema_version: 2, kind: "echo-person-document-upload-v2", request_id: randomUUID(), filename: "interface.md", title: "Interface",
    content_length: bytes.byteLength, sha256: sha256Digest(bytes), association_project_ids: project_ids, audience: { kind: "projects", project_ids },
  }, bytes);
  const uploadV1 = (token: string) => documents.upload(token, {
    schema_version: 1, kind: "echo-person-document-upload-v1", request_id: randomUUID(), filename: "team.md", title: "Team",
    content_length: bytes.byteLength, sha256: sha256Digest(bytes), audience: { kind: "team" }, project_id: null,
  }, bytes);
  const submitV3 = (token: string, project_ids: readonly string[]) => updates.submitUploadV3(token, {
    schema_version: 3, kind: "echo-person-update-submit-v3", request_id: randomUUID(), title: "Interface note",
    text: "shared interface note", association_project_ids: project_ids, audience: { kind: "projects", project_ids },
  });
  return { database, documents, updates, uploadV2, uploadV1, submitV3 };
}

/** The serialized release, so a project ID cannot hide in any field. */
function released(value: unknown): string { return canonicalJson(value); }

describe("released upload audiences name only the reader's current projects", () => {
  it.each([
    { reader: "member", uploader: "owner", audience: [SHARED, OWNER_ONLY], hidden: OWNER_ONLY },
    { reader: "owner", uploader: "member", audience: [SHARED, MEMBER_ONLY], hidden: MEMBER_ONLY },
  ])("collapses a document's audience to the one project the $reader shares", ({ reader, uploader, audience, hidden }) => {
    const f = fixture();
    const saved = f.uploadV2(uploader, audience);
    const own: PersonUploadAudienceV3 = { kind: "project", project_id: SHARED };
    const metadata = f.documents.readV2(reader, saved.document_id);
    expect(validatePersonDocumentMetadataV2(metadata)).toMatchObject({ audience: own, association_project_ids: [SHARED] });
    expect(f.documents.readV2(reader, saved.document_id, { project_id: SHARED }).audience).toEqual(own);
    expect(f.documents.originalV2(reader, saved.document_id).metadata.audience).toEqual(own);
    const search = f.documents.searchV2(reader, { schema_version: 2, kind: "echo-person-document-search-v2", project_id: null, query: "", limit: 20, cursor: null });
    expect(validatePersonDocumentSearchResultV2(search).documents.map(item => item.audience)).toEqual([own]);
    for (const value of [metadata, f.documents.originalV2(reader, saved.document_id).metadata, search]) expect(released(value)).not.toContain(hidden);

    const uploaderView = f.documents.readV2(uploader, saved.document_id);
    expect(uploaderView.audience).toEqual({ kind: "projects", project_ids: audience });
    expect(f.documents.statusV2(uploader, saved.request_id)).toMatchObject({ kind: "echo-person-document-metadata-v2", audience: { kind: "projects", project_ids: audience } });
  });

  it("keeps a projects audience when the reader shares two or more of its projects", () => {
    const f = fixture();
    const saved = f.uploadV2("owner", [SHARED, OWNER_ONLY, SHARED_TOO]);
    const note = f.submitV3("owner", [SHARED, OWNER_ONLY, SHARED_TOO]);
    const visible: PersonUploadAudienceV3 = { kind: "projects", project_ids: [SHARED, SHARED_TOO] };
    expect(f.documents.readV2("member", saved.document_id).audience).toEqual(visible);
    expect(f.updates.readUploadV3("member", note.context_id).audience).toEqual(visible);
    expect(released(f.documents.readV2("member", saved.document_id))).not.toContain(OWNER_ONLY);
    expect(released(f.updates.readUploadV3("member", note.context_id))).not.toContain(OWNER_ONLY);
  });

  it.each([
    { reader: "member", uploader: "owner", audience: [SHARED, OWNER_ONLY], hidden: OWNER_ONLY },
    { reader: "owner", uploader: "member", audience: [SHARED, MEMBER_ONLY], hidden: MEMBER_ONLY },
  ])("collapses a note's audience on every read the $reader can make", ({ reader, uploader, audience, hidden }) => {
    const f = fixture();
    const note = f.submitV3(uploader, audience);
    const own: PersonUploadAudienceV3 = { kind: "project", project_id: SHARED };
    const feed = f.updates.feedV2(reader, { project_id: SHARED });
    const search = f.updates.searchV2(reader, { project_id: SHARED, query: "interface" });
    const context = f.updates.readContextV2(reader, SHARED, note.context_id);
    const content = f.updates.readUploadV3(reader, note.context_id);
    const uploads = f.updates.searchUploadsV3(reader, { query: "interface" });
    const reads = [feed, search, context, content, uploads];
    expect(feed.items.map(item => item.audience)).toEqual([own]);
    expect(search.items.map(item => item.audience)).toEqual([own]);
    expect(context.audience).toEqual(own);
    expect(content.audience).toEqual(own);
    expect(uploads.results.map(item => item.audience)).toEqual([own]);
    for (const value of reads) expect(released(value)).not.toContain(hidden);

    expect(f.updates.readUploadV3(uploader, note.context_id).audience).toEqual({ kind: "projects", project_ids: audience });
  });
});

describe("a document's request ID is released only to its uploader", () => {
  it.each([
    { reader: "member", uploader: "owner" },
    { reader: "owner", uploader: "member" },
  ])("withholds the $uploader's request ID from the $reader on V2 and V1 reads", ({ reader, uploader }) => {
    const f = fixture();
    const modern = f.uploadV2(uploader, [SHARED]);
    const metadata = f.documents.readV2(reader, modern.document_id);
    expect(validatePersonDocumentMetadataV2(metadata).request_id).toBeNull();
    expect(f.documents.originalV2(reader, modern.document_id).metadata.request_id).toBeNull();
    const searchV2 = f.documents.searchV2(reader, { schema_version: 2, kind: "echo-person-document-search-v2", project_id: SHARED, query: "", limit: 20, cursor: null });
    expect(validatePersonDocumentSearchResultV2(searchV2).documents.map(item => item.request_id)).toEqual([null]);
    for (const value of [metadata, searchV2]) expect(released(value)).not.toContain(modern.request_id);

    const legacy = f.uploadV1(uploader);
    const legacyMetadata = f.documents.read(reader, legacy.document_id);
    expect(validatePersonDocumentMetadataV1(legacyMetadata).request_id).toBeNull();
    expect(f.documents.original(reader, legacy.document_id).metadata.request_id).toBeNull();
    const searchV1 = f.documents.search(reader, { schema_version: 1, kind: "echo-person-document-search-v1", project_id: null, query: "", limit: 20, cursor: null });
    expect(validatePersonDocumentSearchResultV1(searchV1).documents.map(item => item.request_id)).toEqual([null]);
    for (const value of [legacyMetadata, searchV1]) expect(released(value)).not.toContain(legacy.request_id);

    expect(f.documents.readV2(uploader, modern.document_id).request_id).toBe(modern.request_id);
    expect(f.documents.read(uploader, legacy.document_id).request_id).toBe(legacy.request_id);
    expect(validatePersonDocumentStatusV2(f.documents.statusV2(uploader, modern.request_id))).toMatchObject({
      request_id: modern.request_id, audience: { kind: "project", project_id: SHARED },
    });
  });
});

describe("a note's V3 status applies the document receipt-visibility check", () => {
  it("returns only the account-scoped saved status once the uploader loses a named project", () => {
    const f = fixture();
    const note = f.submitV3("owner", [SHARED, OWNER_ONLY]);
    expect(validatePersonUpdateStatusResultV3(f.updates.uploadStatusV3("owner", note.request_id))).toMatchObject({
      kind: "echo-person-update-status-v3", association_project_ids: [SHARED, OWNER_ONLY], audience: { kind: "projects", project_ids: [SHARED, OWNER_ONLY] },
    });
    f.database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=?")
      .run(PROJECT_CONTEXT_NOW, OWNER_ONLY, OWNER.membership_id);
    const status = f.updates.uploadStatusV3("owner", note.request_id);
    expect(validatePersonUpdateStatusResultV3(status)).toEqual({
      schema_version: 3, kind: "echo-person-update-saved-v3", request_id: note.request_id, context_id: note.context_id,
      received_at: note.received_at, status: "stored",
    });
  });
});

describe("the served V3 note routes release only the reader's view", () => {
  it("serves a collapsed audience to a non-member and a saved-only status to a departed uploader", async () => {
    const f = fixture();
    const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: "https://issuer.example", project_context: f.updates });
    servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing test address");
    const get = async (path: string, token: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      return await response.json() as Record<string, unknown>;
    };
    const note = f.submitV3("owner", [SHARED, OWNER_ONLY]);
    const content = await get(`/v3/person/updates/content/${note.context_id}`, "member");
    expect(content.audience).toEqual({ kind: "project", project_id: SHARED });
    expect(released(content)).not.toContain(OWNER_ONLY);
    const context = await get(`/v2/person/projects/${SHARED}/context/${note.context_id}`, "member");
    expect(context.audience).toEqual({ kind: "project", project_id: SHARED });

    expect(await get(`/v3/person/updates/${note.request_id}`, "owner")).toMatchObject({ kind: "echo-person-update-status-v3", audience: { kind: "projects", project_ids: [SHARED, OWNER_ONLY] } });
    f.database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=?")
      .run(PROJECT_CONTEXT_NOW, OWNER_ONLY, OWNER.membership_id);
    expect(await get(`/v3/person/updates/${note.request_id}`, "owner")).toEqual({
      schema_version: 3, kind: "echo-person-update-saved-v3", request_id: note.request_id, context_id: note.context_id, received_at: note.received_at, status: "stored",
    });
  });
});
