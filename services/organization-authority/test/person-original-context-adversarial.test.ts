import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonSourceEvidenceV1 } from "@echo-brain/organization-api";
import { MeetingSourceBridgeV1, pullAndAdmitSourceBatchV1, type MeetingDocument } from "@echo-brain/organization-processing/core";
import { SqlitePersonDocumentRepositoryV1 } from "../src/adapters/persistence/sqlite/document-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonTextSourceInboxV1 } from "../src/adapters/persistence/sqlite/person-text-source-v1.js";
import { SqliteSourceAdmissionStoreV1 } from "../src/adapters/persistence/sqlite/source-admission-v1.js";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import { createProjectContextApplicationV1 } from "../src/application/project-context-application-v1.js";
import { createPersonDocumentApplicationV1 } from "../src/application/document-v1.js";
import { PersonDocumentProcessingV1 } from "../src/composition/person-document-processing-v1.js";
import type { OriginalContextCitationV1 } from "../src/application/ports/person-original-context-retrieval-v1.js";
import { MEMBER, OWNER, PROJECT_ALPHA, PROJECT_BETA, PROJECT_CONTEXT_NOW, authorization, insertStoredDocumentV1, insertStoredNoteV2, projectContextDatabase, seedProject, seedProjectMember } from "./fixtures/project-context-sqlite.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = projectContextDatabase();
  databases.push(database);
  for (const projectId of [PROJECT_ALPHA, PROJECT_BETA]) {
    seedProject(database, projectId, OWNER);
    seedProjectMember(database, projectId, OWNER, "lead");
  }
  seedProjectMember(database, PROJECT_ALPHA, MEMBER, "member");
  let milliseconds = Date.parse(PROJECT_CONTEXT_NOW);
  const now = () => new Date(milliseconds += 1_000).toISOString();
  const repository = new SqlitePersonDocumentRepositoryV1(database, now);
  const documents = createPersonDocumentApplicationV1({
    repository,
    authenticate: token => authorization(token === "member" ? MEMBER : OWNER),
  });
  let checkedMilliseconds = Date.parse(PROJECT_CONTEXT_NOW);
  const retrieval = new SqlitePersonOriginalContextRetrievalV1(database, {
    authenticateAccess: ({ access_token }) => authorization(access_token === "member" ? MEMBER : OWNER, {
      checked_at: new Date(checkedMilliseconds += 1_000).toISOString(),
    }),
  }, OWNER.organization_id);
  const leave = (projectId: string) => database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=?")
    .run(PROJECT_CONTEXT_NOW, projectId, MEMBER.membership_id);
  const admit = (meeting: MeetingDocument) => pullAndAdmitSourceBatchV1({
    source: new MeetingSourceBridgeV1({
      identity: meeting.provenance.source,
      pull: async () => ({ meetings: [meeting], next_cursor: `${meeting.id}-next` }),
    }),
    request: { limit: 1 },
    admission: { store: new SqliteSourceAdmissionStoreV1(database), scope: { organization_id: OWNER.organization_id, custody_ref: `organization:${OWNER.organization_id}`, access_policy_ref: "meeting-fixture", analysis_policy: "automatic" } },
  });

  const uploadChunks = (title: string, chunks: readonly string[], changes: {
    readonly audience?: { readonly kind: "only_me" | "team" } | { readonly kind: "project"; readonly project_id: string };
    readonly project_id?: string | null;
    readonly filename?: string;
  } = {}) => {
    const bytes = Buffer.from(chunks.join("\n"));
    const saved = documents.uploadV2("owner", {
      schema_version: 2,
      kind: "echo-person-document-upload-v2",
      request_id: randomUUID(),
      filename: changes.filename ?? `${title.replaceAll(" ", "-")}.md`,
      title,
      content_length: bytes.byteLength,
      sha256: sha256Digest(bytes),
      audience: changes.audience ?? { kind: "team" },
      association_project_ids: changes.project_id == null ? [] : [changes.project_id],
    }, bytes);
    const claim = repository.claimExtraction();
    if (claim === undefined) throw new Error("document extraction was not claimed");
    expect(repository.completeExtraction(claim, {
      status: "ready",
      sourceSha256: claim.source_sha256,
      extractorVersion: "fixture-1",
      chunks: chunks.map((text, index) => ({ anchor_kind: "paragraph" as const, anchor_start: index + 1, text })),
      message: null,
    })).toBe(true);
    return saved.document_id;
  };
  const upload = (title: string, text: string, changes: Parameters<typeof uploadChunks>[2] = {}) =>
    uploadChunks(title, [text], changes);

  // A note stored as V2 before its submit was retired (ADR-0048): Ask still admits it.
  const admitTeamNote = async (title: string, text: string) => {
    insertStoredNoteV2(database, OWNER, { title, text, audience: { kind: "team" }, project_id: null }, now());
    const worker = new PersonDocumentProcessingV1(repository, undefined, new SqlitePersonTextSourceInboxV1(database, now));
    expect(await worker.runOnce(new AbortController().signal)).toBe("admitted");
  };

  return { database, retrieval, repository, documents, upload, uploadChunks, admitTeamNote, leave, admit };
}

function texts(result: ReturnType<SqlitePersonOriginalContextRetrievalV1["deskSearch"]>): readonly string[] {
  return result.release.released_atoms.map(atom => atom.text);
}

function citationOf(atom: ReturnType<SqlitePersonOriginalContextRetrievalV1["deskSearch"]>["release"]["released_atoms"][number]): OriginalContextCitationV1 {
  return {
    kind: "source_revision", source_id: atom.source_id, revision_id: atom.revision_id,
    source_sha256: atom.source_sha256, representation_sha256: atom.representation_sha256,
    anchor_sha256: atom.anchor_sha256,
    ...(atom.document_id === undefined ? {} : { document_id: atom.document_id }),
  };
}

/**
 * Charge actual SQL result bytes, independent of column names or query shape.
 * Materialize .all() through its equivalent iterator so a regression fails the
 * byte budget before allocating hundreds of repeated full-document bodies.
 */
function meteredReads(database: Database.Database, maximumBytes: number) {
  let returnedBytes = 0;
  function charge(value: unknown): void {
    if (typeof value === "string") returnedBytes += Buffer.byteLength(value);
    else if (Buffer.isBuffer(value)) returnedBytes += value.byteLength;
    else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) charge(child);
    }
    if (returnedBytes > maximumBytes) throw new Error("Source proof exceeded its SQL result byte budget");
  }
  const observed = new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(prepared, method) {
            if (method === "get") return (...args: unknown[]) => {
              const row = prepared.get(...args); charge(row); return row;
            };
            if (method === "iterate" || method === "all") {
              const rows = function* (...args: unknown[]) {
                for (const row of prepared.iterate(...args)) { charge(row); yield row; }
              };
              return method === "all" ? (...args: unknown[]) => [...rows(...args)] : rows;
            }
            const value = Reflect.get(prepared, method, prepared) as unknown;
            return typeof value === "function" ? value.bind(prepared) : value;
          },
        });
      };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: observed, bytes: () => returnedBytes, reset: () => { returnedBytes = 0; } };
}

describe("adversarial original-context retrieval", () => {
  it('filters document and note capture dates in the client zone by received or any, keeps meeting scope separate, and counts what a meeting date cannot test', async () => {
    const f = fixture();
    f.upload('Launch plan', 'launch marker');
    f.upload('Private launch', 'launch marker', { audience: { kind: 'only_me' } });
    await f.admitTeamNote('Launch note', 'launch marker');
    const base = { access_token: 'member', scope: { kind: 'global' as const }, source: 'document' as const, since: '2026-09-22', until: '2026-09-22', time_zone: 'Asia/Shanghai', date_field: 'received' as const };
    const inventory = f.retrieval.deskSearch(base);
    expect(inventory.items.map(item => item.label).sort()).toEqual(['Launch note', 'Launch-plan.md']);
    expect(f.retrieval.deskSearch({ ...base, time_zone: 'America/Los_Angeles' }).items).toEqual([]);
    const searched = f.retrieval.deskSearch({ ...base, query: 'launch' });
    expect(searched.items).toHaveLength(2);
    expect(searched.items.every(item => item.dates?.received?.startsWith('2026-09-21'))).toBe(true);
    expect(f.retrieval.deskSearch({ ...base, source: 'meeting', date_field: 'occurred' }).items).toEqual([]);
    // A document read with a date field documents do not record is refused and names the one they do, never answered
    // empty as if the filter applied (ADR-0041, addition 3).
    for (const date_field of ['created', 'updated', 'occurred', 'due'] as const) {
      expect(() => f.retrieval.deskSearch({ ...base, date_field })).toThrow('This source supports date_field: received');
    }
    expect(() => f.retrieval.revalidateDeskRelease({ access_token: 'member', release: searched })).not.toThrow();

    // Any of a document's or a note's dates is when ECHO received it (research tool contract v1).
    const { source: _source, date_field: _field, ...window } = base;
    const any = f.retrieval.deskSearch({ ...window, source: 'document', date_field: 'any' });
    expect(any.items.map(item => item.label).sort()).toEqual(['Launch note', 'Launch-plan.md']);
    expect(any).not.toHaveProperty('unchecked');
    expect(f.retrieval.deskSearch({ ...window, source: 'document', date_field: 'any', query: 'launch' }).items).toHaveLength(2);
    expect(f.retrieval.deskSearch({ ...window, source: 'document', date_field: 'any', time_zone: 'America/Los_Angeles' }).items).toEqual([]);
    expect(() => f.retrieval.deskSearch({ ...window, source: 'document', date_field: 'approved' })).toThrow('This source supports date_field: received, any');
    // Across both sources a meeting's date tests no note or document: each readable one is counted, with the date it records,
    // whatever a search's words match, and none is listed.
    for (const query of [undefined, 'launch', 'nothing matches this']) {
      const across = f.retrieval.deskSearch({ ...window, date_field: 'occurred', ...(query === undefined ? {} : { query }) });
      expect([query, across.items, across.unchecked]).toEqual([query, [], { count: 2, dates: ['received'] }]);
    }
    for (const date_field of ['received', 'any'] as const) expect(f.retrieval.deskSearch({ ...window, date_field })).not.toHaveProperty('unchecked');
    // An upload the member cannot read is never counted; its owner's count has it.
    expect(f.retrieval.deskSearch({ ...window, access_token: 'owner', date_field: 'approved' }).unchecked).toEqual({ count: 3, dates: ['received'] });
    expect(f.retrieval.deskSearch({ ...window, date_field: 'approved', kinds: ['document_passage'] }).unchecked).toEqual({ count: 1, dates: ['received'] });
    // The count is audited with the release it describes.
    const release = f.retrieval.deskSearch({ ...window, date_field: 'due' });
    const audit = JSON.parse((f.database.prepare('SELECT body_json FROM authority_person_upload_read_audit_v1 WHERE row_sha256=?').get(release.receipt) as { body_json: string }).body_json) as Record<string, unknown>;
    expect(audit.unchecked).toEqual({ count: 2, dates: ['received'] });
    expect(() => f.retrieval.revalidateDeskRelease({ access_token: 'member', release })).not.toThrow();
  });

  it("supplies SCOUT evidence for all seven recorded questions using real upload, extraction and scoped retrieval", async () => {
    const f = fixture();
    const worker = new PersonDocumentProcessingV1(f.repository);
    for (const filename of ["SCOUT-MRD-v0.1.md", "SCOUT-PRD-v0.2.md"]) {
      const bytes = readFileSync(new URL(`../../../docs/simulations/scout/${filename}`, import.meta.url));
      f.documents.uploadV2("owner", {
        schema_version: 2, kind: "echo-person-document-upload-v2", request_id: randomUUID(),
        filename, title: filename, content_length: bytes.length, sha256: sha256Digest(bytes),
        audience: { kind: "project", project_id: PROJECT_ALPHA }, association_project_ids: [PROJECT_ALPHA],
      }, bytes);
      expect(await worker.runOnce(new AbortController().signal)).toBe("admitted");
    }
    const questions = [
      ["What problem does SCOUT solve, and what is outside its first product scope?", ["handoffs", "outside this first scope"]],
      ["What are the proposed payload, route length and travel time targets?", ["1 kg", "20 m", "120 seconds"]],
      ["What are the battery requirements?", ["PRD-14", "battery reserve"]],
      ["What does PRD-14 require for battery reserve before and during a mission?", ["PRD-14", "no unconditional return HOME"]],
      ["When can SCOUT resume after an obstacle clears or emergency stop is released?", ["PRD-08", "Release never auto-restarts motion"]],
      ["What must Hardware, Software and QA deliver in Phase 1, and what requires PM authorization?", ["After PM authorization", "Acceptance and Verification Plan"]],
      ["Do the uploaded MRD and PRD reference matching versions? Identify any mismatch?", ["Version: 0.1", "Parent: SCOUT-MRD v0.2"]],
    ] as const;
    for (const [question, required] of questions) {
      // Layer-3 retrieval for the question, then each packet opens at its exact citation.
      const result = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, query: question });
      const evidence = texts(result).join("\n");
      for (const value of required) expect(evidence, question).toContain(value);
      const atom = result.release.released_atoms[0]!;
      expect(f.retrieval.read({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, citation: citationOf(atom) }).atom.anchor_sha256).toBe(atom.anchor_sha256);
    }
  });

  it("does not turn function words or an unmatched subject into arbitrary document evidence", () => {
    const f = fixture();
    f.upload("An ordinary plan", "This is the plan and it is ready for review.");
    for (const question of ["What is it?", "What is the zeppelin budget?"]) {
      const result = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: question });
      expect(result.items).toEqual([]);
      expect(result.release.released_atoms).toEqual([]);
    }
  });

  it("preserves uppercase technical acronyms that overlap English function words", () => {
    const f = fixture();
    f.upload("Interface", "CAN bus connects the controller.");
    expect(texts(f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "What is CAN?" })).join(" ")).toContain("CAN bus");
  });

  it("retrieves the battery requirement from a natural question ahead of newer incidental matches", () => {
    const f = fixture();
    const documentId = f.upload("SCOUT PRD", "PRD-14: Check battery reserve before starting. Hardware and Software propose thresholds and recovery.", { project_id: PROJECT_ALPHA });
    for (let index = 0; index < 7; index += 1) {
      f.upload(`Other ${index}`, "The requirements are proposed for review.", { project_id: PROJECT_ALPHA });
    }
    const result = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, query: "What are the battery reserve requirements?" });
    expect(result.release.released_atoms[0]).toMatchObject({ document_id: documentId });
    expect(texts(result)[0]).toContain("PRD-14");
  });

  it("uses scoped packet BM25 and searches beyond the former top-100 overlap window", () => {
    const f = fixture();
    const rare = f.uploadChunks("Large ranked proof", [
      ...Array.from({ length: 105 }, (_, index) => `common appears incidentally in passage ${index}`),
      "rareterm rareterm rareterm establishes the controlling requirement",
    ]);
    const result = f.retrieval.deskSearch({
      access_token: "member", scope: { kind: "global" }, query: "common rareterm", limit: 10,
    });
    expect(result.items[0]?.citation.document_id).toBe(rare);
    expect(result.items[0]?.text).toContain("rareterm rareterm rareterm");
    const atom = result.release.released_atoms[0]!;
    const reopened = f.retrieval.deskOpen({ access_token: "member", scope: { kind: "global" }, citation: citationOf(atom) });
    expect(reopened.items[0]?.text).toContain("rareterm rareterm rareterm");
  });

  it("keeps deterministic packet ties and the three-per-document diversity cap", () => {
    const f = fixture();
    const documentId = f.uploadChunks("Diversity", Array.from({ length: 5 }, () => "stabletie"));
    f.upload("Second source", "stabletie");
    const first = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "stabletie", limit: 10 });
    const second = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "stabletie", limit: 10 });
    expect(first.items.map(item => item.citation.anchor_sha256)).toEqual(second.items.map(item => item.citation.anchor_sha256));
    expect(first.items.filter(item => item.citation.document_id === documentId)).toHaveLength(3);
    expect(first.items).toHaveLength(4);
  });

  it("does not let unreadable or off-project packets alter readable BM25 statistics", () => {
    const f = fixture();
    f.upload("Readable rare", "scopecommon scoperare scoperare");
    f.upload("Readable common", "scopecommon incidental");
    const input = { access_token: "member", scope: { kind: "project" as const, project_id: PROJECT_ALPHA }, query: "scopecommon scoperare" };
    // Add equivalent readable project evidence first, then snapshot its ranking.
    f.upload("Alpha rare", "scopecommon scoperare scoperare", { project_id: PROJECT_ALPHA });
    f.upload("Alpha common", "scopecommon incidental", { project_id: PROJECT_ALPHA });
    const before = f.retrieval.deskSearch(input).items.map(item => item.citation.anchor_sha256);
    for (let index = 0; index < 8; index += 1) {
      f.upload(`Private ${index}`, "scoperare", { audience: { kind: "only_me" }, project_id: PROJECT_ALPHA });
      f.upload(`Other project ${index}`, "scopecommon scoperare", { project_id: PROJECT_BETA });
    }
    expect(f.retrieval.deskSearch(input).items.map(item => item.citation.anchor_sha256)).toEqual(before);
  });

  it("keeps archived-project evidence and its citation readable until the member grant is removed", async () => {
    const f = fixture();
    f.upload("Archive evidence", "archive-ask-marker remains valid after project archive", { audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_ALPHA });
    const projects = createProjectContextApplicationV1({ authenticate: () => authorization(OWNER), repository: new SqliteProjectContextRepositoryV1(f.database, () => PROJECT_CONTEXT_NOW) });
    projects.archiveProject("owner", { schema_version: 1, kind: "echo-project-archive-v1", request_id: randomUUID(), project_id: PROJECT_ALPHA, archived: true });
    const scope = { kind: "project" as const, project_id: PROJECT_ALPHA };
    const released = f.retrieval.deskSearch({ access_token: "member", scope, query: "Where is archive ask marker?" });
    expect(texts(released).join("\n")).toContain("archive-ask-marker");
    const citation = citationOf(released.release.released_atoms[0]!);
    expect(f.retrieval.read({ access_token: "member", scope, citation }).atom.text).toContain("archive-ask-marker");
    f.leave(PROJECT_ALPHA);
    expect(() => f.retrieval.read({ access_token: "member", scope, citation })).toThrow();
  });

  it("does not release private or other-project evidence when only some question terms match", () => {
    const f = fixture();
    const allowed = f.upload("Visible", "battery reserve review", { project_id: PROJECT_ALPHA });
    f.upload("Private", "battery reserve requirements", { audience: { kind: "only_me" }, project_id: PROJECT_ALPHA });
    f.upload("Other project", "battery reserve requirements", { project_id: PROJECT_BETA });
    f.upload("Other audience", "battery reserve requirements", { audience: { kind: "project", project_id: PROJECT_BETA }, project_id: PROJECT_ALPHA });
    const result = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, query: "What are the battery requirements?" });
    expect(result.release.released_atoms.map(atom => atom.document_id)).toEqual([allowed]);
  });

  it("retrieves V3 notes and V2 files through union audiences while keeping project scope and private context exact", async () => {
    const f = fixture();
    const projects = createProjectContextApplicationV1({ authenticate: () => authorization(OWNER), repository: new SqliteProjectContextRepositoryV1(f.database, () => PROJECT_CONTEXT_NOW) });
    const worker = new PersonDocumentProcessingV1(f.repository, undefined, new SqlitePersonTextSourceInboxV1(f.database));
    for (const [name, audience, associations] of [
      ["sharedmodernmarker", { kind: "projects", project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, [PROJECT_ALPHA]],
      ["privatemodernmarker", { kind: "only_me" }, [PROJECT_ALPHA, PROJECT_BETA]],
      ["homepersonalnotemarker", { kind: "only_me" }, []],
      ["unassociatedmodernmarker", { kind: "projects", project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, []],
    ] as const) {
      projects.submitUploadV3("owner", { schema_version: 3, kind: "echo-person-update-submit-v3", request_id: randomUUID(), title: name, text: name, audience, association_project_ids: associations });
      expect(await worker.runOnce(new AbortController().signal)).toBe("admitted");
    }
    const bytes = Buffer.from("documentmodernmarker");
    f.documents.uploadV2("owner", { schema_version: 2, kind: "echo-person-document-upload-v2", request_id: randomUUID(), filename: "modern.md", title: "Modern", content_length: bytes.length, sha256: sha256Digest(bytes), audience: { kind: "projects", project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, association_project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, bytes);
    const claim = f.repository.claimExtraction()!;
    expect(f.repository.completeExtraction(claim, { status: "ready", sourceSha256: claim.source_sha256, extractorVersion: "fixture-1", chunks: [{ anchor_kind: "paragraph", anchor_start: 1, text: bytes.toString() }], message: null })).toBe(true);
    const search = (marker: string, project?: typeof PROJECT_ALPHA | typeof PROJECT_BETA, access_token = "member") => f.retrieval.deskSearch({ access_token, scope: project ? { kind: "project", project_id: project } : { kind: "global" }, query: marker });
    expect(texts(search("sharedmodernmarker", PROJECT_ALPHA))).toEqual([expect.stringContaining("sharedmodernmarker")]);
    expect(texts(search("documentmodernmarker", PROJECT_ALPHA))).toEqual([expect.stringContaining("documentmodernmarker")]);
    expect(texts(search("privatemodernmarker", PROJECT_ALPHA))).toEqual([]);
    expect(texts(search("privatemodernmarker", PROJECT_ALPHA, "owner"))).toEqual([expect.stringContaining("privatemodernmarker")]);
    expect(texts(search("unassociatedmodernmarker", PROJECT_ALPHA))).toEqual([]);
    expect(texts(search("unassociatedmodernmarker"))).toEqual([expect.stringContaining("unassociatedmodernmarker")]);
    const home = search("homepersonalnotemarker", undefined, "owner");
    expect(texts(home)).toEqual([expect.stringContaining("homepersonalnotemarker")]);
    expect(texts(search("homepersonalnotemarker"))).toEqual([]);
    expect(texts(search("homepersonalnotemarker", PROJECT_ALPHA, "owner"))).toEqual([]);
    expect(f.retrieval.read({ access_token: "owner", scope: { kind: "global" }, citation: citationOf(home.release.released_atoms[0]!) }).atom.text).toContain("homepersonalnotemarker");
    seedProjectMember(f.database, PROJECT_BETA, MEMBER, "member");
    expect(texts(search("sharedmodernmarker", PROJECT_BETA))).toEqual([]);
    expect(texts(search("documentmodernmarker", PROJECT_BETA))).toEqual([expect.stringContaining("documentmodernmarker")]);
    const global = search("sharedmodernmarker");
    const scoped = search("sharedmodernmarker", PROJECT_ALPHA);
    const citation = citationOf(global.release.released_atoms[0]!);
    f.leave(PROJECT_ALPHA);
    expect(() => f.retrieval.revalidate({ access_token: "member", release: scoped.release })).toThrow();
    expect(() => f.retrieval.revalidate({ access_token: "member", release: global.release })).not.toThrow();
    expect(f.retrieval.read({ access_token: "member", scope: { kind: "global" }, citation }).atom.text).toContain("sharedmodernmarker");
    f.leave(PROJECT_BETA);
    expect(() => f.retrieval.revalidate({ access_token: "member", release: global.release })).toThrow();
    expect(() => f.retrieval.read({ access_token: "member", scope: { kind: "global" }, citation })).toThrow();
  });

  it("retrieves documents stored as V1 under their stored audiences after the V1 upload was retired (ADR-0048)", () => {
    const f = fixture();
    for (const [marker, audience, project_id] of [
      ["legacyteammarker", { kind: "team" }, null],
      ["legacyprojectmarker", { kind: "project", project_id: PROJECT_ALPHA }, PROJECT_ALPHA],
      ["legacyprivatemarker", { kind: "only_me" }, null],
    ] as const) {
      const bytes = Buffer.from(marker);
      insertStoredDocumentV1(f.database, OWNER, { filename: `${marker}.md`, title: marker, audience, project_id }, bytes);
      const claim = f.repository.claimExtraction()!;
      expect(f.repository.completeExtraction(claim, { status: "ready", sourceSha256: claim.source_sha256, extractorVersion: "fixture-1", chunks: [{ anchor_kind: "paragraph", anchor_start: 1, text: marker }], message: null })).toBe(true);
    }
    const search = (marker: string, project?: typeof PROJECT_ALPHA, access_token = "member") => f.retrieval.deskSearch({ access_token, scope: project ? { kind: "project", project_id: project } : { kind: "global" }, query: marker });
    expect(texts(search("legacyteammarker"))).toEqual([expect.stringContaining("legacyteammarker")]);
    const project = search("legacyprojectmarker", PROJECT_ALPHA);
    expect(texts(project)).toEqual([expect.stringContaining("legacyprojectmarker")]);
    expect(f.retrieval.read({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, citation: citationOf(project.release.released_atoms[0]!) }).atom.text).toContain("legacyprojectmarker");
    expect(texts(search("legacyprivatemarker"))).toEqual([]);
    expect(texts(search("legacyprivatemarker", undefined, "owner"))).toEqual([expect.stringContaining("legacyprivatemarker")]);
  });

  it("records repeated identical releases without colliding on a content-free audit identity", () => {
    const f = fixture();
    f.upload("Repeated audit", "repeated-audit-marker");
    const fixedSession = new SqlitePersonOriginalContextRetrievalV1(f.database, {
      authenticateAccess: ({ access_token }) => authorization(access_token === "member" ? MEMBER : OWNER),
    }, OWNER.organization_id);
    const input = { access_token: "member", scope: { kind: "global" as const }, query: "repeated-audit-marker" };
    expect(fixedSession.deskSearch(input).items).toHaveLength(1);
    expect(() => fixedSession.deskSearch(input)).not.toThrow();
  });

  it("uses actual V8 source admission for notes and excludes a raw meeting source, its transcript included", async () => {
    const f = fixture();
    await f.admitTeamNote("Legacy handoff", "legacycontextmarker is retained through the common Person source adapter");
    const legacy = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "legacycontextmarker" });
    expect(texts(legacy).join(" ")).toContain("legacycontextmarker");

    const meeting = {
      schema_version: 1 as const, id: "meeting-adversarial-1",
      provenance: { source: { kind: "meeting-source" as const, adapter_id: "meeting", instance_id: "fixture", version: "1" }, external_id: "meeting-adversarial-1", canonical_revision: "revision-1", observed_at: PROJECT_CONTEXT_NOW, normalizer_version: "1" },
      capture: { state: "complete" as const, components: [] }, participants: [], artifacts: [],
      content: [
        { id: "note-1", kind: "note" as const, text: "rawmeetingsecretmarker must never enter Ask originals" },
        { id: "transcript-1", kind: "transcript" as const, text: "rawtranscriptsecretmarker: nor may a transcript (ADR-0046)" },
      ],
    };
    await f.admit(meeting);
    for (const marker of ["rawmeetingsecretmarker", "rawtranscriptsecretmarker"]) {
      const raw = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: marker });
      expect(raw.items).toEqual([]);
      expect(texts(raw).join(" ")).not.toContain(marker);
    }
  });

  it("enforces audience separately from project association in global and project-scoped reads", () => {
    const f = fixture();
    f.upload("Shared Alpha", "sharedalphamarker", { project_id: PROJECT_ALPHA });
    f.upload("Private Alpha", "privatealphamarker", { audience: { kind: "only_me" }, project_id: PROJECT_ALPHA });
    f.upload("Beta audience Alpha association", "betaaudiencealphaassociationmarker", { audience: { kind: "project", project_id: PROJECT_BETA }, project_id: PROJECT_ALPHA });
    f.upload("Alpha audience Beta association", "alphaaudiencebetaassociationmarker", { audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_BETA });

    expect(texts(f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "sharedalphamarker" })).join(" ")).toContain("sharedalphamarker");
    expect(texts(f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "privatealphamarker" }))).toEqual([]);
    expect(texts(f.retrieval.deskSearch({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, query: "betaaudiencealphaassociationmarker" }))).toEqual([]);
    expect(texts(f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "alphaaudiencebetaassociationmarker" })).join(" ")).toContain("alphaaudiencebetaassociationmarker");
    expect(texts(f.retrieval.deskSearch({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, query: "alphaaudiencebetaassociationmarker" }))).toEqual([]);
  });

  it("keeps a globally readable team original available after an uncited project grant is revoked", () => {
    const f = fixture();
    f.upload("Shared evidence", "uncited-revocation-marker", { project_id: PROJECT_ALPHA });
    const released = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "uncited-revocation-marker" });
    f.leave(PROJECT_ALPHA);
    expect(f.retrieval.revalidate({ access_token: "member", release: released.release })).toMatchObject({ checked_at: expect.any(String) });
  });

  it("fails revalidation after a selected-project grant is revoked, including global project-audience sources", () => {
    const f = fixture();
    f.upload("Selected project", "selected-project-revocation-marker", { audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_ALPHA });
    const scoped = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, query: "selected-project-revocation-marker" });
    const global = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "selected-project-revocation-marker" });
    f.leave(PROJECT_ALPHA);
    expect(() => f.retrieval.revalidate({ access_token: "member", release: scoped.release }))
      .toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(() => f.retrieval.revalidate({ access_token: "member", release: global.release }))
      .toThrow(expect.objectContaining({ code: "unauthorized" }));
  });

  it("keeps a desk release on both checks when writes that change none of the caller's access move the org-wide revision", () => {
    const f = fixture();
    f.upload("Alpha plan", "orgwide-revision-marker", { audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_ALPHA });
    const projects = createProjectContextApplicationV1({ authenticate: token => authorization(token === "member" ? MEMBER : OWNER), repository: new SqliteProjectContextRepositoryV1(f.database, () => PROJECT_CONTEXT_NOW) });
    const releases = [{ kind: "global" as const }, { kind: "project" as const, project_id: PROJECT_ALPHA }]
      .map(scope => f.retrieval.deskSearch({ access_token: "member", scope, query: "orgwide-revision-marker" }));
    expect(releases.map(release => release.items.length)).toEqual([1, 1]);
    const audit = JSON.parse((f.database.prepare("SELECT body_json FROM authority_person_upload_read_audit_v1 WHERE row_sha256=?").get(releases[0]!.receipt) as { body_json: string }).body_json) as Record<string, unknown>;
    expect(audit).toMatchObject({ schema_version: 2, grants_sha256: releases[0]!.release.grants_sha256 });
    expect(audit).not.toHaveProperty("authorization_revision");
    const note = (token: string) => projects.submitUploadV3(token, { schema_version: 3, kind: "echo-person-update-submit-v3", request_id: randomUUID(), title: "Mid-answer note", text: "saved while the Ask runs", association_project_ids: [], audience: { kind: "team" } });
    const rename = (principalId: string, name: string) => f.database.prepare("UPDATE authority_principals SET display_name=? WHERE principal_id=?").run(name, principalId);
    const revision = () => f.database.prepare("SELECT revision FROM authority_project_authorization_state_v1").pluck().get() as number;
    const writes: Record<string, () => unknown> = {
      "another person saves a note": () => note("owner"),
      "another person renames themself": () => rename(OWNER.principal_id, "Owner Renamed"),
      "another project is created": () => projects.createProject("owner", { schema_version: 1, kind: "echo-project-create-v1", request_id: randomUUID(), name: "Gamma" }),
      "the caller saves a note": () => note("member"),
      "the caller renames themself": () => rename(MEMBER.principal_id, "Member Renamed"),
    };
    for (const [write, run] of Object.entries(writes)) {
      const before = revision();
      run();
      // Each of these refused the answer while the desk pinned the org-wide revision.
      expect(revision(), write).toBeGreaterThan(before);
      for (const release of releases) {
        expect(() => f.retrieval.revalidateDeskRelease({ access_token: "member", release, items_checked: true }), write).not.toThrow();
        expect(() => f.retrieval.revalidateDeskRelease({ access_token: "member", release }), write).not.toThrow();
      }
    }
  });

  it("refuses a desk release on both checks once the caller's own project grants change", () => {
    const f = fixture();
    f.upload("Alpha plan", "caller-grant-marker", { audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_ALPHA });
    const search = () => f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "caller-grant-marker" });
    const check = (release: ReturnType<typeof search>, items_checked?: true) =>
      () => f.retrieval.revalidateDeskRelease({ access_token: "member", release, ...(items_checked === undefined ? {} : { items_checked }) });
    const release = search();
    expect(release.items).toHaveLength(1);
    f.leave(PROJECT_ALPHA);
    expect(check(release, true)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(check(release)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    // Rejoining is a new grant, so the earlier release stays refused even though the item is readable again.
    seedProjectMember(f.database, PROJECT_ALPHA, MEMBER, "member");
    expect(check(release, true)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    const rejoined = search();
    expect(rejoined.items).toHaveLength(1);
    expect(check(rejoined, true)).not.toThrow();
    // Any change to the caller's own grants refuses the releases before it, so one request never mixes two snapshots of them.
    seedProjectMember(f.database, PROJECT_BETA, MEMBER, "member");
    expect(check(rejoined, true)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(check(rejoined)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(check(search(), true)).not.toThrow();
  });

  it("keeps a project release through the incremental check once its item leaves the project, and refuses it at the full check", () => {
    const f = fixture();
    const documentId = f.upload("Alpha plan", "association-fence-marker", { project_id: PROJECT_ALPHA });
    const release = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, query: "association-fence-marker" });
    expect(release.items).toHaveLength(1);
    // Audiences are immutable and originals are never deleted, so the project association is what can change about an item.
    f.database.prepare("DELETE FROM authority_person_document_associations_v1 WHERE document_id=? AND project_id=?").run(documentId, PROJECT_ALPHA);
    // The member still reads it; only the project no longer holds it (ADR-0038's accepted trade-off).
    expect(f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "association-fence-marker" }).items).toHaveLength(1);
    expect(() => f.retrieval.revalidateDeskRelease({ access_token: "member", release, items_checked: true })).not.toThrow();
    expect(() => f.retrieval.revalidateDeskRelease({ access_token: "member", release })).toThrow(expect.objectContaining({ code: "unauthorized" }));
  });

  it("rejects a tampered representation body when its stored hash is unchanged", () => {
    const f = fixture();
    f.upload("Representation check", "representation-corruption-marker");
    const released = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "representation-corruption-marker" });
    f.database.exec("DROP TRIGGER authority_source_representations_v1_update_denied");
    f.database.prepare("UPDATE authority_source_representations_v1 SET content_json=?").run('{"tampered":true}');
    expect(() => f.retrieval.revalidate({ access_token: "member", release: released.release }))
      .toThrow(expect.objectContaining({ code: "unavailable" }));
  });

  it("excludes a mutable document title from released evidence and its citation", () => {
    const f = fixture();
    const documentId = f.upload("Immutable title", "document-title-integrity-marker");
    const input = { access_token: "member", scope: { kind: "global" as const }, query: "document-title-integrity-marker" };
    const released = f.retrieval.deskSearch(input);
    const citation = citationOf(released.release.released_atoms[0]!);

    // The document row has no immutable title column. A retained-row title
    // must therefore never enter source evidence or its citation anchor.
    f.database.exec("DROP TRIGGER authority_person_documents_v1_update_denied");
    f.database.prepare("UPDATE authority_person_documents_v1 SET title=? WHERE document_id=?")
      .run("Forged document title", documentId);
    expect(f.retrieval.deskSearch({ ...input, query: "Forged" }).release.released_atoms).toEqual([]);
    expect(f.retrieval.deskSearch({ ...input, query: "Immutable-title.md" }).release.released_atoms)
      .toHaveLength(1);
    const after = f.retrieval.deskSearch(input).release.released_atoms[0]!;
    expect(after).toMatchObject({ label: "Immutable-title.md", anchor_sha256: released.release.released_atoms[0]!.anchor_sha256 });
    expect(after.text).not.toContain("Forged document title");
    expect(f.retrieval.revalidate({ access_token: "member", release: released.release }))
      .toMatchObject({ checked_at: expect.any(String) });
    expect(f.retrieval.read({ access_token: "member", scope: input.scope, citation }).atom)
      .toMatchObject({ label: "Immutable-title.md", anchor_sha256: citation.anchor_sha256 });
  });

  it("bounds a long immutable filename only at the presentation label", () => {
    const f = fixture();
    const filename = `${"a".repeat(247)}.md`;
    f.upload("Short title", "long-filename-roundtrip-marker", { filename });
    const scope = { kind: "global" as const };
    const atom = f.retrieval.deskSearch({ access_token: "member", scope, query: "long-filename-roundtrip-marker" }).release.released_atoms[0]!;
    expect(atom.text.startsWith(`${filename}\n`)).toBe(true);
    expect([...(atom.label ?? "")]).toHaveLength(198);
    const proof = f.retrieval.read({ access_token: "member", scope, citation: citationOf(atom) }).atom;
    expect(proof).toMatchObject({ label: atom.label, text: atom.text, anchor_sha256: atom.anchor_sha256 });
    expect(() => validatePersonSourceEvidenceV1({
      schema_version: 1,
      kind: "echo-person-source-evidence-v1",
      scope,
      citation: { ...citationOf(atom), label: atom.label },
      text: atom.text,
    })).not.toThrow();
  });

  it.each([
    { filename: "  launch.md", label: "launch.md" },
    { filename: "QA\u2028plan.md", label: "QA plan.md" },
  ])("sanitizes the valid upload filename %j only for its public label", ({ filename, label }) => {
    const f = fixture();
    f.upload("Short title", `public-label-roundtrip-${label}`, { filename });
    const scope = { kind: "global" as const };
    const atom = f.retrieval.deskSearch({ access_token: "member", scope, query: `public-label-roundtrip-${label}` }).release.released_atoms[0]!;
    expect(atom.text.startsWith(`${filename}\n`)).toBe(true);
    expect(atom.label).toBe(label);
    const citation = citationOf(atom);
    const proof = f.retrieval.read({ access_token: "member", scope, citation }).atom;
    expect(proof).toMatchObject({ label, text: atom.text, anchor_sha256: atom.anchor_sha256 });
    expect(() => validatePersonSourceEvidenceV1({
      schema_version: 1,
      kind: "echo-person-source-evidence-v1",
      scope,
      citation: { ...citation, label },
      text: proof.text,
    })).not.toThrow();
  });

  it("finds a lexical term crossing a proof-packet boundary and opens that exact packet", () => {
    const f = fixture();
    // This extraction chunk puts 'needle' across the first packet's 3,064
    // body-byte boundary after the filename heading consumes eight bytes.
    f.upload("Plan", "a".repeat(3060) + " needle");
    const result = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "needle" });
    expect(result.release.released_atoms).toHaveLength(1);
    const atom = result.release.released_atoms[0]!;
    expect(atom.text).toContain("needle");
    const proof = f.retrieval.read({ access_token: "member", scope: { kind: "global" }, citation: citationOf(atom) });
    expect(proof.atom.text).toBe(atom.text);
    expect(proof.atom.anchor_sha256).toBe(atom.anchor_sha256);
  });

  it.each(["retained note", "canonical source content", "revision manifest"])(
    "does not certify corrupted %s under unchanged immutable digests",
    async carrier => {
      const f = fixture();
      await f.admitTeamNote("Integrity proof", "integrity-proof-marker remains original evidence");
      const input = { access_token: "member", scope: { kind: "global" as const }, query: "integrity-proof-marker" };
      const released = f.retrieval.deskSearch(input);
      const citation = citationOf(released.release.released_atoms[0]!);
      expect(f.retrieval.read({ access_token: "member", scope: input.scope, citation }).atom.text).toContain("remains original evidence");

      // Simulate retained-state corruption, not an allowed user mutation.
      // Immutability guards themselves are covered by source-custody tests.
      if (carrier === "retained note") {
        f.database.exec("DROP TRIGGER authority_person_updates_v2_immutable");
        f.database.prepare("UPDATE authority_person_updates_v2 SET text=?").run("integrity-proof-marker now contains forged evidence");
      } else if (carrier === "canonical source content") {
        f.database.exec("DROP TRIGGER authority_source_contents_v1_update_denied");
        f.database.prepare("UPDATE authority_source_contents_v1 SET content_json=json_set(content_json,'$.text',?)")
          .run("integrity-proof-marker now contains forged evidence");
      } else {
        f.database.exec("DROP TRIGGER authority_source_revisions_v1_update_denied");
        f.database.prepare("UPDATE authority_source_revisions_v1 SET manifest_json=json_set(manifest_json,'$.content_sha256',?)")
          .run("0".repeat(64));
      }
      expect(() => f.retrieval.deskSearch(input)).toThrow(expect.objectContaining({ code: "unavailable" }));
      expect(() => f.retrieval.revalidate({ access_token: "member", release: released.release }))
        .toThrow(expect.objectContaining({ code: "unavailable" }));
      expect(() => f.retrieval.read({ access_token: "member", scope: input.scope, citation }))
        .toThrow(expect.objectContaining({ code: "unavailable" }));
    },
  );

  it("opens immutable citation coordinates, rejects forged proof coordinates, and checks current access", () => {
    const f = fixture();
    f.upload("Exact proof", "exact-citation-marker is scoped to Alpha", {
      audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_ALPHA,
    });
    const scope = { kind: "project" as const, project_id: PROJECT_ALPHA };
    const released = f.retrieval.deskSearch({ access_token: "member", scope, query: "exact-citation-marker" });
    const atom = released.release.released_atoms[0]!;
    const citation = citationOf(atom);
    const proofAuditCount = () => (f.database.prepare("SELECT count(*) AS count FROM authority_person_upload_read_audit_v1 WHERE json_extract(body_json,'$.kind')='echo-person-original-context-proof-read-audit-v1'").get() as { count: number }).count;
    const before = proofAuditCount();
    expect(f.retrieval.read({ access_token: "member", scope, citation }).atom).toEqual(atom);
    expect(proofAuditCount()).toBe(before + 1);
    for (const coordinate of ["source_sha256", "representation_sha256", "anchor_sha256"] as const) {
      expect(() => f.retrieval.read({ access_token: "member", scope, citation: { ...citation, [coordinate]: canonicalSha256("forged proof") } }))
        .toThrow(expect.objectContaining({ code: "unauthorized" }));
    }
    expect(proofAuditCount()).toBe(before + 1);
    f.leave(PROJECT_ALPHA);
    expect(() => f.retrieval.read({ access_token: "member", scope, citation }))
      .toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(() => f.retrieval.read({ access_token: "member", scope: { kind: "global" }, citation }))
      .toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(proofAuditCount()).toBe(before + 1);
  });

  it("keeps a person's own associated private source in scope without admitting unassociated or unrelated context", () => {
    const f = fixture();
    f.upload("Own Alpha", "scope-clarification-marker own-associated-private", { audience: { kind: "only_me" }, project_id: PROJECT_ALPHA });
    f.upload("Own unassociated", "scope-clarification-marker own-unassociated-private", { audience: { kind: "only_me" } });
    f.upload("Own Beta", "scope-clarification-marker unrelated-beta-private", { audience: { kind: "only_me" }, project_id: PROJECT_BETA });
    f.upload("Organization distractor", "scope-clarification-marker unrelated-org-context");
    const scope = { kind: "project" as const, project_id: PROJECT_ALPHA };
    const input = { scope, query: "scope-clarification-marker" };
    const own = f.retrieval.deskSearch({ ...input, access_token: "owner" });
    expect(own.release.released_atoms).toHaveLength(1);
    expect(texts(own)[0]).toContain("own-associated-private");
    expect(texts(f.retrieval.deskSearch({ ...input, access_token: "member" }))).toEqual([]);
    const citation = citationOf(own.release.released_atoms[0]!);
    expect(f.retrieval.read({ access_token: "owner", scope, citation }).atom.text).toContain("own-associated-private");
    expect(() => f.retrieval.read({ access_token: "member", scope, citation }))
      .toThrow(expect.objectContaining({ code: "unauthorized" }));
  });

  it("reads a late proof in a nearly 2 MiB extraction without materializing its representation once per chunk", () => {
    const f = fixture();
    const chunks = Array.from({ length: 640 }, (_, index) =>
      (index === 639 ? "late-evidence-marker final paragraph " : `ordinary paragraph ${index} `).padEnd(3072, "x"));
    f.uploadChunks("Large proof", chunks);
    const extractedBytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
    // Permit a constant number of representation/chunk reads, independent of
    // the number of chunks. The old join repeats ~2 MiB 640 times and fails
    // before allocating that expansion.
    const meter = meteredReads(f.database, extractedBytes * 8);
    const retrieval = new SqlitePersonOriginalContextRetrievalV1(meter.database, {
      authenticateAccess: () => authorization(MEMBER),
    }, OWNER.organization_id);
    const released = retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "late-evidence-marker" });
    const atom = released.release.released_atoms[0]!;
    expect(atom.text).toContain("late-evidence-marker");
    expect(meter.bytes()).toBeLessThan(extractedBytes * 8);
    meter.reset();
    const proof = retrieval.read({ access_token: "member", scope: { kind: "global" }, citation: citationOf(atom) });
    expect(proof.atom.text).toBe(atom.text);
    expect(proof.atom.anchor_sha256).toBe(atom.anchor_sha256);
    expect(meter.bytes()).toBeLessThan(extractedBytes * 8);
  });

  it("desk-open preserves the requested later packet of a large document chunk", () => {
    const f = fixture();
    const suffix = " later-packet-marker";
    f.uploadChunks("Packet proof", ["x".repeat(3_072 - Buffer.byteLength(suffix)) + suffix]);
    const found = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, query: "later-packet-marker" });
    const item = found.items[0]!;
    expect(item.text).toContain("later-packet-marker");
    const opened = f.retrieval.deskOpen({ access_token: "member", scope: { kind: "global" }, citation: item.citation });
    expect(opened.items[0]!.citation.anchor_sha256).toBe(item.citation.anchor_sha256);
    expect(opened.items[0]!.text).toContain("later-packet-marker");
  });

  it("keeps the document inventory representative-only: one metadata item per document", () => {
    const f = fixture();
    f.uploadChunks("Representative inventory", ["first readable passage", "second readable passage", "third readable passage"]);
    const inventory = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, limit: 20 });
    expect(inventory.items).toHaveLength(1);
    expect(inventory.truncated).toBe(false);
    expect(inventory.items.every(item => item.text === undefined)).toBe(true);
  });
});
