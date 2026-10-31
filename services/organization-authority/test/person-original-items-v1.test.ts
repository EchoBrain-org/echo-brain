import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import type { AuthorityPersonMembershipBinding } from "@echo-brain/organization-authority-kernel/application/ports/authority-repository";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import { SqlitePersonDocumentRepositoryV1 } from "../src/adapters/persistence/sqlite/document-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonOriginalItemsV1 } from "../src/adapters/persistence/sqlite/person-original-items-v1.js";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import { createPersonDocumentApplicationV1 } from "../src/application/document-v1.js";
import { createProjectContextApplicationV1 } from "../src/application/project-context-application-v1.js";
import type { PersonItemPositionV1, PersonListStoreScopeV1, PersonStoreDocumentRowV1, PersonStoreNoteRowV1, PersonStoreReleaseV1 } from "../src/application/ports/person-list-v1.js";
import type { PersonUploadAudienceV2, ProjectIdV1 } from "@echo-brain/organization-api";
import {
  MEMBER, OWNER, PROJECT_ALPHA, PROJECT_BETA, PROJECT_CONTEXT_NOW, RETURNED_MEMBER,
  addMembership, authorization, insertStoredDocumentV1, insertStoredNoteV2, projectContextDatabase, revokeMembership, seedProject, seedProjectMember,
} from "./fixtures/project-context-sqlite.js";
import { failure } from "./authority-failure.js";

type Actor = AuthorityPersonMembershipBinding;
type Row = PersonStoreNoteRowV1 | PersonStoreDocumentRowV1;
type NoteAudience = { readonly kind: "only_me" | "team" } | { readonly kind: "project"; readonly project_id: string } | { readonly kind: "projects"; readonly project_ids: readonly string[] };

const ONLY_ME: PersonListStoreScopeV1 = { kind: "only_me" };
const inProject = (project_id: string): PersonListStoreScopeV1 => ({ kind: "project", project_id });
const ACTORS: Readonly<Record<string, Actor>> = { owner: OWNER, member: MEMBER, returned: RETURNED_MEMBER };
const AUDIT_KIND = "echo-person-original-item-release-audit-v1";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function revokeGrant(database: Database.Database, projectId: string, actor: Actor): void {
  database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=? AND status='active'").run(PROJECT_CONTEXT_NOW, projectId, actor.membership_id);
}

/** added_at DESC, then `${kind}:${id}` ASC: the list route's merge order. */
function merge(...lists: readonly (readonly Row[])[]): Row[] {
  return lists.flat().sort((left, right) => left.added_at > right.added_at ? -1 : left.added_at < right.added_at ? 1
    : `${left.kind}:${left.id}` < `${right.kind}:${right.id}` ? -1 : 1);
}

function fixture() {
  const database = projectContextDatabase();
  databases.push(database);
  for (const [projectId, name] of [[PROJECT_ALPHA, "Alpha"], [PROJECT_BETA, "Beta"]] as const) {
    seedProject(database, projectId, OWNER, { name });
    seedProjectMember(database, projectId, OWNER, "lead");
  }
  seedProjectMember(database, PROJECT_ALPHA, MEMBER, "member");
  let clock = Date.parse(PROJECT_CONTEXT_NOW);
  const time = { pinned: undefined as string | undefined };
  const now = () => time.pinned ?? new Date(clock += 1_000).toISOString();
  const session = { state: "fixture session", revoked: new Set<string>() };
  const authenticate = (token: string) => {
    const actor = ACTORS[token];
    if (actor === undefined || session.revoked.has(token)) throw new AuthorityOperationError("unauthorized", "person authentication failed");
    return authorization(actor, { session_state_sha256: canonicalSha256(session.state) });
  };
  const sessions = { authenticateAccess: ({ access_token }: { readonly access_token: string }) => authenticate(access_token) };
  const projects = createProjectContextApplicationV1({ authenticate, repository: new SqliteProjectContextRepositoryV1(database, now) });
  const repository = new SqlitePersonDocumentRepositoryV1(database, now);
  const documents = createPersonDocumentApplicationV1({ repository, authenticate });
  const items = new SqlitePersonOriginalItemsV1(database, sessions, OWNER.organization_id);
  const retrieval = new SqlitePersonOriginalContextRetrievalV1(database, sessions, OWNER.organization_id);
  const requestIds: string[] = [];

  /** A V3 note through its submit, or a note stored as V2 before that submit was retired (ADR-0048). */
  const note = (token: string, audience: NoteAudience, associations: readonly string[] = [], version: 2 | 3 = 3, text = "note text"): `ctx_${string}` => {
    const request_id = randomUUID();
    requestIds.push(request_id);
    const receipt = version === 2
      ? insertStoredNoteV2(database, ACTORS[token]!, { request_id, title: `Note ${requestIds.length}`, text, project_id: (associations[0] ?? null) as ProjectIdV1 | null, audience: audience as PersonUploadAudienceV2 }, now())
      : projects.submitUploadV3(token, { schema_version: 3, kind: "echo-person-update-submit-v3", request_id, title: `Note ${requestIds.length}`, text, association_project_ids: associations, audience });
    return receipt.context_id as `ctx_${string}`;
  };
  /** Documents that finish extraction must be uploaded before any left extracting: claims take the oldest pending. */
  const document = (token: string, audience: NoteAudience, associations: readonly string[] = [], options: {
    readonly version?: 1 | 2; readonly state?: "extracting" | "ready" | "unavailable"; readonly chunks?: readonly string[];
  } = {}): `doc_${string}` => {
    const request_id = randomUUID();
    requestIds.push(request_id);
    const chunks = options.chunks ?? ["document text"];
    const bytes = Buffer.from(chunks.join("\n"));
    const common = { request_id, filename: `document-${requestIds.length}.md`, title: `Doc ${requestIds.length}`, content_length: bytes.byteLength, sha256: sha256Digest(bytes), audience };
    // A V1 document is one stored before its upload was retired (ADR-0048).
    const saved = options.version === 1
      ? insertStoredDocumentV1(database, ACTORS[token]!, { request_id, filename: common.filename, title: common.title, audience: audience as PersonUploadAudienceV2, project_id: (associations[0] ?? null) as ProjectIdV1 | null }, bytes, now())
      : documents.uploadV2(token, { schema_version: 2, kind: "echo-person-document-upload-v2", ...common, association_project_ids: associations }, bytes);
    const state = options.state ?? "extracting";
    // "unavailable" is terminal only on the third attempt.
    for (let attempt = 1; state !== "extracting" && attempt <= (state === "unavailable" ? 3 : 1); attempt += 1) {
      const claim = repository.claimExtraction();
      expect(claim?.document_id).toBe(saved.document_id);
      repository.completeExtraction(claim!, {
        status: state, sourceSha256: claim!.source_sha256, extractorVersion: "fixture-1", message: null,
        chunks: state === "ready" ? chunks.map((text, index) => ({ anchor_kind: "paragraph" as const, anchor_start: index + 1, text })) : [],
      });
      clock += 61_000;
    }
    return saved.document_id as `doc_${string}`;
  };

  /** collect(26) → commit(the emitted prefix) → revalidate, until both sources are exhausted. */
  const walk = (token: string, scope: PersonListStoreScopeV1, emit: (available: number) => number = (available) => available) => {
    const rows: Row[] = [];
    const releases: PersonStoreReleaseV1[] = [];
    const source = { note: { after: null as PersonItemPositionV1 | null, done: false }, document: { after: null as PersonItemPositionV1 | null, done: false } };
    for (let guard = 0; !(source.note.done && source.document.done); guard += 1) {
      if (guard > 500) throw new Error("walk did not terminate");
      const collected = items.collect({
        access_token: token, scope, limit: 26,
        ...(source.note.done ? {} : { notes: { after: source.note.after } }),
        ...(source.document.done ? {} : { documents: { after: source.document.after } }),
      });
      const page = merge(collected.notes, collected.documents).slice(0, 25);
      const emitted = page.slice(0, page.length === 0 ? 0 : Math.max(1, Math.min(page.length, emit(page.length))));
      const release = items.commit({ access_token: token, handle: collected.handle, notes: emitted.filter((row) => row.kind === "note").length, documents: emitted.filter((row) => row.kind === "document").length });
      items.revalidate({ access_token: token, release });
      releases.push(release);
      rows.push(...emitted);
      for (const [kind, available] of [["note", collected.notes], ["document", collected.documents]] as const) {
        if (source[kind].done) continue;
        const mine = emitted.filter((row) => row.kind === kind);
        if (mine.length > 0) source[kind].after = { added_at: mine.at(-1)!.added_at, id: mine.at(-1)!.id };
        if (available.length < 26 && mine.length === available.length) source[kind].done = true;
      }
    }
    return { rows, releases };
  };
  const ids = (token: string, scope: PersonListStoreScopeV1) => walk(token, scope).rows.map((row) => row.id);
  const audits = () => (database.prepare("SELECT body_json FROM authority_person_upload_read_audit_v1").all() as { body_json: string }[])
    .map((row) => row.body_json).filter((body) => body.includes(AUDIT_KIND));

  /** Every document the reader finds through the V2 document search, page by page. */
  const searchAll = (token: string, project_id: string | null) => {
    const found: string[] = [];
    for (let cursor: string | null = null, guard = 0; guard < 50; guard += 1) {
      const page = documents.searchV2(token, { schema_version: 2, kind: "echo-person-document-search-v2", project_id, query: "", limit: 20, cursor });
      found.push(...page.documents.map((item) => item.document_id));
      if (page.next_cursor === null) return found;
      cursor = page.next_cursor;
    }
    throw new Error("search did not end");
  };

  return { database, projects, documents, items, retrieval, session, time, requestIds, note, document, walk, ids, searchAll, audits, sessions };
}

describe("person original items store", () => {
  it("lists every note version and document state the reader may read, and nothing private to another member", () => {
    const f = fixture();
    // Shared items are filed in a project, so a project lists them.
    const ownerV2Private = f.note("owner", { kind: "only_me" }, [], 2);
    const ownerV2Team = f.note("owner", { kind: "team" }, [PROJECT_ALPHA], 2);
    const ownerV2Alpha = f.note("owner", { kind: "project", project_id: PROJECT_ALPHA }, [PROJECT_ALPHA], 2);
    const ownerV3Projects = f.note("owner", { kind: "projects", project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, [PROJECT_ALPHA, PROJECT_BETA]);
    const ownerV3Beta = f.note("owner", { kind: "project", project_id: PROJECT_BETA }, [PROJECT_BETA]);
    const memberPrivate = f.note("member", { kind: "only_me" }, [PROJECT_ALPHA]);
    const ownerReady = f.document("owner", { kind: "team" }, [PROJECT_ALPHA], { state: "ready" });
    const ownerUnavailable = f.document("owner", { kind: "only_me" }, [], { version: 1, state: "unavailable" });
    const memberReady = f.document("member", { kind: "only_me" }, [], { state: "ready" });
    const ownerExtracting = f.document("owner", { kind: "project", project_id: PROJECT_ALPHA }, [PROJECT_ALPHA]);
    const ownerBetaDocument = f.document("owner", { kind: "project", project_id: PROJECT_BETA }, [PROJECT_BETA]);
    // Every scope a reader lists, each item once: only me and each project the reader holds.
    const listed = (token: string, scopes: readonly PersonListStoreScopeV1[]) =>
      [...new Map(scopes.flatMap((scope) => f.walk(token, scope).rows).map((row) => [row.id, row])).values()];

    const owner = listed("owner", [ONLY_ME, inProject(PROJECT_ALPHA), inProject(PROJECT_BETA)]);
    expect(new Set(owner.map((row) => row.id))).toEqual(new Set([
      ownerV2Private, ownerV2Team, ownerV2Alpha, ownerV3Projects, ownerV3Beta,
      ownerReady, ownerUnavailable, ownerExtracting, ownerBetaDocument,
    ]));
    expect(owner.filter((row): row is PersonStoreDocumentRowV1 => row.kind === "document").map((row) => row.extraction_state).sort())
      .toEqual(["extracting", "extracting", "ready", "unavailable"]);
    expect(owner.find((row) => row.id === ownerV3Projects)).toMatchObject({ kind: "note", visibility: "projects", association_project_ids: [PROJECT_ALPHA, PROJECT_BETA] });
    expect(owner.find((row) => row.id === ownerUnavailable)).toMatchObject({ kind: "document", visibility: "only_me", media_type: "text/markdown", size_bytes: Buffer.byteLength("document text") });

    const member = listed("member", [ONLY_ME, inProject(PROJECT_ALPHA)]);
    expect(new Set(member.map((row) => row.id))).toEqual(new Set([
      ownerV2Team, ownerV2Alpha, ownerV3Projects, ownerReady, ownerExtracting, memberPrivate, memberReady,
    ]));
    // Associations are filtered to the reader's own grants.
    expect(member.find((row) => row.id === ownerV3Projects)?.association_project_ids).toEqual([PROJECT_ALPHA]);
    expect(member.find((row) => row.id === memberPrivate)?.association_project_ids).toEqual([PROJECT_ALPHA]);
    expect(owner.map((row) => row.id)).not.toContain(memberPrivate);
    expect(owner.map((row) => row.id)).not.toContain(memberReady);
  });

  it("lists only_me as the caller's own only-me notes and documents, filed in a project or not (ADR-0049)", () => {
    const f = fixture();
    const unfiled = f.note("member", { kind: "only_me" });
    const filed = f.note("member", { kind: "only_me" }, [PROJECT_ALPHA]);
    const filedV2 = f.note("member", { kind: "only_me" }, [PROJECT_ALPHA], 2);
    const filedDocument = f.document("member", { kind: "only_me" }, [PROJECT_ALPHA], { state: "ready" });
    const unfiledDocument = f.document("member", { kind: "only_me" });
    const own = [unfiled, filed, filedV2, filedDocument, unfiledDocument];
    // The caller's team and project items, and the owner's only-me items filed in the same project, are not the caller's only_me.
    const team = f.note("member", { kind: "team" }, [PROJECT_ALPHA]);
    const project = f.note("member", { kind: "project", project_id: PROJECT_ALPHA }, [PROJECT_ALPHA]);
    const projectDocument = f.document("member", { kind: "project", project_id: PROJECT_ALPHA }, [PROJECT_ALPHA]);
    const ownerFiled = f.note("owner", { kind: "only_me" }, [PROJECT_ALPHA]);
    const ownerDocument = f.document("owner", { kind: "only_me" }, [PROJECT_ALPHA]);

    const onlyMe = f.walk("member", ONLY_ME).rows;
    expect(new Set(onlyMe.map((row) => row.id))).toEqual(new Set(own));
    expect(onlyMe.every((row) => row.visibility === "only_me")).toBe(true);
    expect(onlyMe.find((row) => row.id === filed)?.association_project_ids).toEqual([PROJECT_ALPHA]);
    expect(onlyMe.find((row) => row.id === unfiled)?.association_project_ids).toEqual([]);
    // Each only_me row is the same row its open reads, and the caller's shared items list in their project instead.
    for (const row of onlyMe) expect(f.items.open({ access_token: "member", ref: row.kind !== "document" ? { kind: row.kind, id: row.id } : { kind: "document", id: row.id } }).row).toEqual(row);
    const alpha = f.ids("member", inProject(PROJECT_ALPHA));
    for (const id of [team, project, projectDocument]) expect(alpha).toContain(id);
    // The filed ones show in their project, for the caller alone.
    expect(alpha).toEqual(expect.arrayContaining([filed, filedV2, filedDocument]));
    expect(new Set(f.ids("owner", ONLY_ME))).toEqual(new Set([ownerFiled, ownerDocument]));
    for (const scope of [ONLY_ME, inProject(PROJECT_ALPHA), inProject(PROJECT_BETA)]) {
      const owner = f.ids("owner", scope);
      for (const id of own) expect(owner).not.toContain(id);
    }
    for (const id of [unfiled, filed, filedV2]) expect(failure(() => f.items.open({ access_token: "owner", ref: { kind: "note", id } })).code).toBe("not_found");
    for (const id of [filedDocument, unfiledDocument]) expect(failure(() => f.items.open({ access_token: "owner", ref: { kind: "document", id } })).code).toBe("not_found");

    // Leaving the project leaves them the caller's alone, filed in no project the caller holds.
    f.projects.leaveProject("member", { schema_version: 1, kind: "echo-project-leave-v1", request_id: randomUUID(), project_id: PROJECT_ALPHA });
    const left = f.walk("member", ONLY_ME).rows;
    expect(new Set(left.map((row) => row.id))).toEqual(new Set(own));
    expect(left.every((row) => row.association_project_ids.length === 0)).toBe(true);
    // A new tenure of the same person starts with nothing kept for it alone.
    revokeMembership(f.database, MEMBER);
    addMembership(f.database, RETURNED_MEMBER, "Returned", "member@example.test");
    expect(f.ids("returned", ONLY_ME)).toEqual([]);
    const returned = f.note("returned", { kind: "only_me" });
    expect(f.ids("returned", ONLY_ME)).toEqual([returned]);
    // The earlier tenure's team items are shared context the new one still reads; its only-me items are not readable at all.
    expect(f.items.open({ access_token: "returned", ref: { kind: "note", id: team } }).row).toMatchObject({ id: team, visibility: "team" });
    for (const id of [unfiled, filed, filedV2]) expect(failure(() => f.items.open({ access_token: "returned", ref: { kind: "note", id } })).code).toBe("not_found");
    for (const id of [filedDocument, unfiledDocument]) expect(failure(() => f.items.open({ access_token: "returned", ref: { kind: "document", id } })).code).toBe("not_found");
  });

  it("drops the caller's own items once their only access path is a left project, but keeps associated team items", () => {
    const f = fixture();
    const alphaNote = f.note("member", { kind: "project", project_id: PROJECT_ALPHA }, [PROJECT_ALPHA]);
    const alphaDocument = f.document("member", { kind: "project", project_id: PROJECT_ALPHA }, [PROJECT_ALPHA]);
    const teamNote = f.note("member", { kind: "team" }, [PROJECT_ALPHA]);
    expect(new Set(f.ids("member", inProject(PROJECT_ALPHA)))).toEqual(new Set([alphaNote, alphaDocument, teamNote]));
    expect(f.walk("member", inProject(PROJECT_ALPHA)).rows.find((row) => row.id === teamNote)?.association_project_ids).toEqual([PROJECT_ALPHA]);

    f.projects.leaveProject("member", { schema_version: 1, kind: "echo-project-leave-v1", request_id: randomUUID(), project_id: PROJECT_ALPHA });
    expect(failure(() => f.walk("member", inProject(PROJECT_ALPHA))).code).toBe("unauthorized");
    expect(f.ids("member", ONLY_ME)).toEqual([]);
    // The team note stays readable, filed in no project the caller holds.
    expect(f.items.open({ access_token: "member", ref: { kind: "note", id: teamNote } }).row).toMatchObject({ visibility: "team", association_project_ids: [] });
    expect(failure(() => f.items.open({ access_token: "member", ref: { kind: "note", id: alphaNote } })).code).toBe("not_found");
    expect(failure(() => f.items.open({ access_token: "member", ref: { kind: "document", id: alphaDocument } })).code).toBe("not_found");
  });

  it("never releases an unjoined project id from collect, commit, open or the audit", () => {
    const f = fixture();
    const noteId = f.note("owner", { kind: "projects", project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, [PROJECT_ALPHA, PROJECT_BETA]);
    const documentId = f.document("owner", { kind: "projects", project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, [PROJECT_ALPHA, PROJECT_BETA], { state: "ready" });
    const released: unknown[] = [];
    const collected = f.items.collect({ access_token: "member", scope: inProject(PROJECT_ALPHA), limit: 26, notes: { after: null }, documents: { after: null } });
    expect(collected.notes.map((row) => row.association_project_ids)).toEqual([[PROJECT_ALPHA]]);
    expect(collected.documents.map((row) => row.association_project_ids)).toEqual([[PROJECT_ALPHA]]);
    released.push(collected, f.items.commit({ access_token: "member", handle: collected.handle, notes: 1, documents: 1 }));
    released.push(f.items.open({ access_token: "member", ref: { kind: "note", id: noteId } }));
    released.push(f.items.open({ access_token: "member", ref: { kind: "document", id: documentId } }));
    const serialized = JSON.stringify(released) + f.audits().join("");
    expect(serialized).toContain(PROJECT_ALPHA);
    expect(serialized).not.toContain(PROJECT_BETA);
  });

  it("lists a project exactly as the project search and document search do, and denies it like Ask", () => {
    const f = fixture();
    f.note("owner", { kind: "team" }, [PROJECT_ALPHA]);
    f.note("owner", { kind: "only_me" }, [PROJECT_ALPHA, PROJECT_BETA]);
    f.note("owner", { kind: "project", project_id: PROJECT_BETA }, [PROJECT_ALPHA]);
    f.note("owner", { kind: "projects", project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, [PROJECT_BETA]);
    f.note("owner", { kind: "team" }, [], 2);
    f.note("member", { kind: "only_me" }, [PROJECT_ALPHA]);
    f.note("member", { kind: "team" }, [PROJECT_ALPHA], 2);
    f.document("owner", { kind: "team" }, [PROJECT_ALPHA], { state: "ready" });
    f.document("owner", { kind: "project", project_id: PROJECT_BETA }, [PROJECT_ALPHA], { state: "ready" });
    f.document("member", { kind: "only_me" }, [PROJECT_ALPHA]);
    f.document("owner", { kind: "team" }, [PROJECT_BETA], { version: 1 });
    // Every note says "note text", so one search term pages through all of a project's notes, newest first.
    const search = (token: string, project_id: string) => {
      const found: string[] = [];
      for (let cursor: string | undefined, guard = 0; guard < 50; guard += 1) {
        const page = f.projects.searchV2(token, { project_id, query: "note", ...(cursor === undefined ? {} : { cursor }) });
        found.push(...page.items.map((item) => item.context_id));
        if (page.next_cursor === null) return found;
        cursor = page.next_cursor;
      }
      throw new Error("search did not end");
    };
    for (const [token, projectId] of [["owner", PROJECT_ALPHA], ["owner", PROJECT_BETA], ["member", PROJECT_ALPHA]] as const) {
      const rows = f.walk(token, inProject(projectId)).rows;
      expect(rows.filter((row) => row.kind === "note").map((row) => row.id)).toEqual(search(token, projectId));
      expect(rows.filter((row) => row.kind === "document").map((row) => row.id)).toEqual(f.searchAll(token, projectId));
      expect(rows.length).toBeGreaterThan(0);
    }
    const nonexistent = "prj_33333333-3333-4333-8333-333333333333";
    for (const projectId of [PROJECT_BETA, nonexistent]) {
      const expected = failure(() => f.retrieval.deskAuthorize({ access_token: "member", scope: { kind: "project", project_id: projectId } }));
      expect(expected.code).toBe("unauthorized");
      expect(failure(() => f.items.collect({ access_token: "member", scope: inProject(projectId), limit: 26, notes: { after: null }, documents: { after: null } }))).toEqual(expected);
    }
    // The retired global and mine scopes are no list scope.
    for (const kind of ["global", "mine"]) {
      const scope = { kind } as unknown as PersonListStoreScopeV1;
      expect(failure(() => f.items.collect({ access_token: "member", scope, limit: 26, notes: { after: null }, documents: { after: null } })).code).toBe("invalid_request");
    }
  });

  it("pages a keyset over shared timestamps with no gap or duplicate for any emitted prefix", () => {
    const f = fixture();
    const times = ["2026-09-21T22:05:00.000Z", "2026-09-21T22:04:00.000Z", "2026-09-21T22:03:00.000Z"];
    // Split across two members: each keeps at most 100 retained originals.
    for (let index = 0; index < 60; index += 1) {
      f.time.pinned = times[index % 3];
      f.note("owner", { kind: "team" }, [PROJECT_ALPHA]);
      f.document("member", { kind: "team" }, [PROJECT_ALPHA]);
    }
    f.time.pinned = undefined;
    const all = merge(f.walk("owner", inProject(PROJECT_ALPHA)).rows);
    expect(all).toHaveLength(120);
    expect(new Set(all.map((row) => row.added_at))).toEqual(new Set(times));
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    for (let round = 0; round < 5; round += 1) {
      const walked = f.walk("owner", inProject(PROJECT_ALPHA), (available) => 1 + Math.floor(random() * available)).rows;
      expect(walked.map((row) => row.id)).toEqual(all.map((row) => row.id));
    }
    // Inside one source the order is added_at DESC, then id ASC.
    const notes = all.filter((row) => row.kind === "note");
    expect(notes).toEqual([...notes].sort((left, right) => left.added_at > right.added_at ? -1 : left.added_at < right.added_at ? 1 : left.id < right.id ? -1 : 1));
  });

  it("lists a just-submitted note from custody before the inbox admits it, and opens its text", () => {
    const f = fixture();
    const id = f.note("member", { kind: "only_me" }, [], 3, "fresh custody text");
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM authority_sources_v1").get()).toEqual({ count: 0 });
    expect(f.ids("member", ONLY_ME)).toEqual([id]);
    const opened = f.items.open({ access_token: "member", ref: { kind: "note", id } });
    expect(opened).toMatchObject({ kind: "note", text: "fresh custody text" });
  });

  it("opens every listed ref with the identical row, and pages document chunks to completion", () => {
    const f = fixture();
    f.note("owner", { kind: "team" }, [PROJECT_ALPHA]);
    const chunks = Array.from({ length: 11 }, (_, index) => `chunk ${index} ${"x".repeat(200)}`);
    const long = f.document("owner", { kind: "team" }, [PROJECT_ALPHA], { state: "ready", chunks });
    const extracting = f.document("member", { kind: "only_me" }, [PROJECT_ALPHA]);
    for (const token of ["owner", "member"]) {
      for (const row of [ONLY_ME, inProject(PROJECT_ALPHA)].flatMap((scope) => f.walk(token, scope).rows)) {
        const opened = f.items.open({ access_token: token, ref: row.kind !== "document" ? { kind: row.kind, id: row.id } : { kind: "document", id: row.id } });
        expect(opened.row).toEqual(row);
        f.items.revalidate({ access_token: token, release: opened.release });
      }
    }
    expect(f.items.open({ access_token: "member", ref: { kind: "document", id: extracting } })).toMatchObject({ chunks: [], next_ordinal: null });
    const pages: string[] = [];
    let from: number | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const opened = f.items.open({ access_token: "member", ref: { kind: "document", id: long }, ...(from === undefined ? {} : { from_ordinal: from }) });
      if (opened.kind !== "document") throw new Error("expected a document");
      expect(opened.chunks.length).toBeGreaterThan(0);
      expect(opened.chunks.length).toBeLessThanOrEqual(8);
      pages.push(...opened.chunks.map((chunk) => chunk.text));
      if (opened.next_ordinal === null) break;
      from = opened.next_ordinal;
    }
    const stored = (f.database.prepare("SELECT text FROM authority_person_document_text_v1 WHERE document_id=? ORDER BY ordinal").all(long) as { text: string }[]).map((row) => row.text);
    expect(pages).toEqual(stored);
    expect(pages).toEqual(chunks);
  });

  it("gives guessed, unreadable, left, quarantined and past-the-end refs one identical not_found", () => {
    const f = fixture();
    const quarantined = f.note("member", { kind: "team" }, [], 2);
    f.database.prepare("INSERT INTO authority_person_text_source_failures_v1(organization_id,api_version,context_id,disposition,recorded_at) VALUES (?,2,?,'invalid_retained_text',?)").run(OWNER.organization_id, quarantined, PROJECT_CONTEXT_NOW);
    const ownerPrivateNote = f.note("owner", { kind: "only_me" });
    const readable = f.document("owner", { kind: "team" }, [], { state: "ready" });
    const ownerPrivateDocument = f.document("owner", { kind: "only_me" });
    const leftNote = f.note("member", { kind: "project", project_id: PROJECT_ALPHA });
    const leftDocument = f.document("member", { kind: "project", project_id: PROJECT_ALPHA });
    f.projects.leaveProject("member", { schema_version: 1, kind: "echo-project-leave-v1", request_id: randomUUID(), project_id: PROJECT_ALPHA });
    const guessed = failure(() => f.items.open({ access_token: "member", ref: { kind: "note", id: `ctx_${"a".repeat(64)}` } }));
    expect(guessed.code).toBe("not_found");
    for (const operation of [
      () => f.items.open({ access_token: "member", ref: { kind: "document", id: `doc_${"b".repeat(64)}` } }),
      () => f.items.open({ access_token: "member", ref: { kind: "note", id: "ctx_not-an-id" as `ctx_${string}` } }),
      () => f.items.open({ access_token: "member", ref: { kind: "note", id: ownerPrivateNote } }),
      () => f.items.open({ access_token: "member", ref: { kind: "document", id: ownerPrivateDocument } }),
      () => f.items.open({ access_token: "member", ref: { kind: "note", id: leftNote } }),
      () => f.items.open({ access_token: "member", ref: { kind: "document", id: leftDocument } }),
      () => f.items.open({ access_token: "member", ref: { kind: "note", id: quarantined } }),
      () => f.items.open({ access_token: "member", ref: { kind: "document", id: readable }, from_ordinal: 5 }),
    ]) expect(failure(operation)).toEqual(guessed);
    expect(f.items.open({ access_token: "member", ref: { kind: "document", id: readable } })).toMatchObject({ kind: "document", next_ordinal: null });
  });

  it("hides a quarantined note and fails closed on a retained note that no longer binds its request", () => {
    const f = fixture();
    const quarantined = f.note("owner", { kind: "only_me" }, [PROJECT_ALPHA], 2);
    const kept = f.note("owner", { kind: "only_me" }, [PROJECT_ALPHA], 2);
    f.database.prepare("INSERT INTO authority_person_text_source_failures_v1(organization_id,api_version,context_id,disposition,recorded_at) VALUES (?,2,?,'invalid_retained_text',?)").run(OWNER.organization_id, quarantined, PROJECT_CONTEXT_NOW);
    expect(f.ids("owner", inProject(PROJECT_ALPHA))).toEqual([kept]);
    expect(f.ids("owner", ONLY_ME)).toEqual([kept]);

    // The member's own only-me note, tampered so it no longer binds its request.
    const request_id = randomUUID();
    const context_id = `ctx_${canonicalSha256({ schema_version: 2, kind: "echo-person-update-source-v2", organization_id: MEMBER.organization_id, membership_id: MEMBER.membership_id, request_id }).slice(7)}`;
    f.database.prepare(`INSERT INTO authority_person_updates_v2
      (organization_id,principal_id,membership_id,membership_type,request_id,request_version,context_id,payload_sha256,title,text,audience_kind,audience_project_id,submitted_association_project_ids_json,audience_project_ids_json,project_id,received_at)
      VALUES (?,?,?,?,?,2,?,?,?,?,'only_me',NULL,'[]','[]',NULL,?)`).run(MEMBER.organization_id, MEMBER.principal_id, MEMBER.membership_id, MEMBER.membership_type, request_id, context_id, canonicalSha256("not the request"), "Tampered", "tampered text", PROJECT_CONTEXT_NOW);
    expect(failure(() => f.items.collect({ access_token: "member", scope: ONLY_ME, limit: 26, notes: { after: null } })).code).toBe("unavailable");
    expect(failure(() => f.items.open({ access_token: "member", ref: { kind: "note", id: context_id as `ctx_${string}` } })).code).toBe("unavailable");
    // Documents alone still list.
    expect(f.items.collect({ access_token: "member", scope: ONLY_ME, limit: 26, documents: { after: null } }).documents).toEqual([]);
  });

  it("audits only committed rows, fences commit, and revalidates grants and rows but not unrelated writes", () => {
    const f = fixture();
    f.note("owner", { kind: "project", project_id: PROJECT_ALPHA }, [PROJECT_ALPHA]);
    f.document("owner", { kind: "team" }, [PROJECT_ALPHA]);
    const all = () => f.items.collect({ access_token: "member", scope: inProject(PROJECT_ALPHA), limit: 26, notes: { after: null }, documents: { after: null } });

    const collected = all();
    expect(f.audits()).toHaveLength(0);
    const empty = f.items.commit({ access_token: "member", handle: collected.handle, notes: 0, documents: 0 });
    expect(empty).toEqual({});
    expect(f.audits()).toHaveLength(0);
    f.items.revalidate({ access_token: "member", release: empty });

    const second = all();
    const release = f.items.commit({ access_token: "member", handle: second.handle, notes: 1, documents: 1 });
    expect(release.receipt).toMatch(/^sha256:[0-9a-f]{64}$/);
    const audits = f.audits();
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!)).toMatchObject({ kind: AUDIT_KIND, operation: "person_list", scope: inProject(PROJECT_ALPHA), released_count: 2, released_items_sha256: canonicalSha256([...second.notes, ...second.documents]) });
    expect(canonicalSha256(JSON.parse(audits[0]!))).toBe(release.receipt);

    // Single use, and only on the issuing store.
    expect(failure(() => f.items.commit({ access_token: "member", handle: second.handle, notes: 1, documents: 1 })).code).toBe("unavailable");
    const other = new SqlitePersonOriginalItemsV1(f.database, f.sessions, OWNER.organization_id);
    expect(failure(() => other.commit({ access_token: "member", handle: all().handle, notes: 0, documents: 0 })).code).toBe("unavailable");
    expect(failure(() => other.revalidate({ access_token: "member", release })).code).toBe("unavailable");
    expect(failure(() => f.items.commit({ access_token: "member", handle: all().handle, notes: 2, documents: 0 })).code).toBe("invalid_request");

    // An unrelated teammate write bumps the org-wide revision but not this reader's release.
    f.note("owner", { kind: "team" });
    f.items.revalidate({ access_token: "member", release });

    // A session or grant change between collect and commit releases nothing.
    const beforeSession = all();
    f.session.state = "rotated session";
    expect(failure(() => f.items.commit({ access_token: "member", handle: beforeSession.handle, notes: 1, documents: 0 })).code).toBe("unauthorized");
    expect(failure(() => f.items.revalidate({ access_token: "member", release })).code).toBe("unauthorized");
    f.session.state = "fixture session";
    const beforeGrant = all();
    seedProjectMember(f.database, PROJECT_BETA, MEMBER, "member");
    expect(failure(() => f.items.commit({ access_token: "member", handle: beforeGrant.handle, notes: 1, documents: 0 })).code).toBe("unauthorized");
    expect(f.audits()).toHaveLength(1);

    // After commit, a grant change is stale; losing the listed project or the membership is unauthorized.
    const current = all();
    const committed = f.items.commit({ access_token: "member", handle: current.handle, notes: current.notes.length, documents: current.documents.length });
    revokeGrant(f.database, PROJECT_BETA, MEMBER);
    expect(failure(() => f.items.revalidate({ access_token: "member", release: committed })).code).toBe("stale_access_state");
    revokeGrant(f.database, PROJECT_ALPHA, MEMBER);
    expect(failure(() => f.items.revalidate({ access_token: "member", release: committed })).code).toBe("unauthorized");
    revokeMembership(f.database, MEMBER);
    expect(failure(() => f.items.revalidate({ access_token: "member", release: committed })).code).toBe("unauthorized");
  });

  it("uses Ask's ACL: documents list like document search, notes like the upload reads", () => {
    const f = fixture();
    // A V2 note is found by the V2 search alone: each carries its own word to search for.
    const markers = new Map<string, string>();
    // Every note and document is filed in ALPHA, which both readers hold, so ALPHA lists what each may read.
    const stored = (token: string, audience: NoteAudience) => {
      const marker = `oraclemarker${markers.size}`;
      const id = f.note(token, audience, [PROJECT_ALPHA], 2, marker);
      markers.set(id, marker);
      return id;
    };
    const notes = [
      stored("owner", { kind: "only_me" }), stored("owner", { kind: "team" }),
      stored("owner", { kind: "project", project_id: PROJECT_ALPHA }), stored("owner", { kind: "project", project_id: PROJECT_BETA }),
      f.note("owner", { kind: "only_me" }, [PROJECT_ALPHA]), f.note("owner", { kind: "team" }, [PROJECT_ALPHA]),
      f.note("owner", { kind: "projects", project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, [PROJECT_ALPHA]), f.note("owner", { kind: "projects", project_ids: [PROJECT_BETA] }, [PROJECT_ALPHA]),
      f.note("member", { kind: "only_me" }, [PROJECT_ALPHA]), stored("member", { kind: "project", project_id: PROJECT_ALPHA }),
    ];
    f.document("owner", { kind: "only_me" }, [PROJECT_ALPHA], { version: 1 });
    f.document("owner", { kind: "project", project_id: PROJECT_BETA }, [PROJECT_ALPHA], { version: 1 });
    f.document("owner", { kind: "projects", project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, [PROJECT_ALPHA]);
    f.document("owner", { kind: "projects", project_ids: [PROJECT_BETA] }, [PROJECT_ALPHA]);
    f.document("member", { kind: "only_me" }, [PROJECT_ALPHA]);
    f.document("member", { kind: "team" }, [PROJECT_ALPHA]);
    for (const token of ["owner", "member"]) {
      const rows = f.walk(token, inProject(PROJECT_ALPHA)).rows;
      expect(rows.filter((row) => row.kind === "document").map((row) => row.id)).toEqual(f.searchAll(token, null));
      const listed = new Set(rows.map((row) => row.id));
      for (const id of notes) {
        const version = (f.database.prepare("SELECT request_version FROM authority_person_updates_v2 WHERE context_id=?").get(id) as { request_version: 2 | 3 }).request_version;
        let readable = true;
        try {
          if (version === 2) readable = f.projects.searchUploads(token, { query: markers.get(id)! }).results.some((result) => result.context_id === id);
          else readable = f.projects.searchUploadsV3(token, { query: "note" }).results.some((result) => result.context_id === id);
        } catch { readable = false; }
        expect(listed.has(id), `${token} ${id}`).toBe(readable);
      }
    }
  });

  it("never releases a request_id, a membership id or a principal id", () => {
    const f = fixture();
    f.note("owner", { kind: "team" }, [PROJECT_ALPHA]);
    f.note("member", { kind: "only_me" }, [PROJECT_ALPHA], 2);
    f.document("owner", { kind: "team" }, [PROJECT_ALPHA], { state: "ready" });
    f.document("member", { kind: "only_me" });
    const outputs: unknown[] = [];
    for (const token of ["owner", "member"]) {
      for (const scope of [ONLY_ME, inProject(PROJECT_ALPHA)]) {
        const collected = f.items.collect({ access_token: token, scope, limit: 26, notes: { after: null }, documents: { after: null } });
        outputs.push(collected, f.items.commit({ access_token: token, handle: collected.handle, notes: collected.notes.length, documents: collected.documents.length }));
      }
      for (const row of [ONLY_ME, inProject(PROJECT_ALPHA)].flatMap((scope) => f.walk(token, scope).rows)) {
        outputs.push(f.items.open({ access_token: token, ref: row.kind !== "document" ? { kind: row.kind, id: row.id } : { kind: "document", id: row.id } }));
      }
    }
    const serialized = JSON.stringify(outputs);
    expect(f.requestIds.length).toBe(4);
    for (const value of [...f.requestIds, OWNER.principal_id, MEMBER.principal_id, "mem_", "prn_", "request_id"]) expect(serialized).not.toContain(value);
  });
});
