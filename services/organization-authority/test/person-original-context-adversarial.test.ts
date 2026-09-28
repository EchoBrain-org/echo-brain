import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonAnswerResponseV3, validatePersonSourceEvidenceV1 } from "@echo-brain/organization-api";
import { PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID } from "@echo-brain/organization-record/organization-record-api-v1";
import { MeetingSourceBridgeV1, pullAndAdmitSourceBatchV1 } from "@echo-brain/organization-processing/core";
import { SqlitePersonDocumentRepositoryV1 } from "../src/adapters/persistence/sqlite/document-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonTextSourceInboxV1 } from "../src/adapters/persistence/sqlite/person-text-source-v1.js";
import { SqliteSourceAdmissionStoreV1 } from "../src/adapters/persistence/sqlite/source-admission-v1.js";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import { createProjectContextApplicationV1 } from "../src/application/project-context-application-v1.js";
import { createPersonDocumentApplicationV1 } from "../src/application/document-v1.js";
import { SqlitePersonAnswerCompositionAuditV1 } from "../src/adapters/persistence/sqlite/person-answer-composition-audit-v1.js";
import { createPersonAnswerV2Route } from "../src/composition/person-answer-v2-route.js";
import { PersonDocumentProcessingV1 } from "../src/composition/person-document-processing-v1.js";
import type { OriginalContextCitationV1 } from "../src/application/ports/person-original-context-retrieval-v1.js";
import { MEMBER, OWNER, PROJECT_ALPHA, PROJECT_BETA, PROJECT_CONTEXT_NOW, addMembership, authorization } from "./fixtures/project-context-sqlite.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function grant(database: Database.Database, projectId: string, actor: typeof OWNER | typeof MEMBER, role: "lead" | "member"): void {
  database.prepare(`INSERT INTO authority_project_memberships_v1
    (project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at)
    VALUES (?,?,?,?,?,?,?,'active',?)`).run(
    `pgm_${randomUUID()}`, projectId, actor.organization_id, actor.principal_id,
    actor.membership_id, actor.membership_type, role, PROJECT_CONTEXT_NOW,
  );
}

function fixture() {
  const database = new Database(":memory:");
  databases.push(database);
  database.pragma("foreign_keys=ON");
  database.exec(readFileSync(new URL("../../../packages/organization-authority-kernel/baselines/authority-baseline-v10.sql", import.meta.url), "utf8"));
  database.prepare(`INSERT INTO authority_metadata
    (singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at)
    VALUES (1,'oau_original_context',?,'Original context fixture','{}',?,?)`).run(OWNER.organization_id, PROJECT_CONTEXT_NOW, PROJECT_CONTEXT_NOW);
  database.prepare("INSERT INTO authority_project_authorization_state_v1(organization_id,revision,updated_at) VALUES (?,0,?)")
    .run(OWNER.organization_id, PROJECT_CONTEXT_NOW);
  addMembership(database, OWNER, "Owner", null);
  addMembership(database, MEMBER, "Member", "member@example.test");
  for (const projectId of [PROJECT_ALPHA, PROJECT_BETA]) {
    database.prepare(`INSERT INTO authority_projects_v1
      (project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type)
      VALUES (?,?,?,?,?,?,?)`).run(projectId, OWNER.organization_id, projectId, PROJECT_CONTEXT_NOW, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type);
    grant(database, projectId, OWNER, "lead");
  }
  grant(database, PROJECT_ALPHA, MEMBER, "member");
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

  const uploadChunks = (title: string, chunks: readonly string[], changes: {
    readonly audience?: { readonly kind: "only_me" | "team" } | { readonly kind: "project"; readonly project_id: string };
    readonly project_id?: string | null;
    readonly filename?: string;
  } = {}) => {
    const bytes = Buffer.from(chunks.join("\n"));
    const saved = documents.upload("owner", {
      schema_version: 1,
      kind: "echo-person-document-upload-v1",
      request_id: randomUUID(),
      filename: changes.filename ?? `${title.replaceAll(" ", "-")}.md`,
      title,
      content_length: bytes.byteLength,
      sha256: sha256Digest(bytes),
      audience: changes.audience ?? { kind: "team" },
      project_id: changes.project_id ?? null,
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

  const admitLegacyTeamNote = async (title: string, text: string) => {
    const request = {
      schema_version: 1 as const,
      kind: "echo-person-update-submit-v1" as const,
      request_id: randomUUID(), title, text, visibility: "team" as const,
    };
    database.prepare(`INSERT INTO authority_person_updates_v1
      (organization_id,principal_id,membership_id,membership_type,request_id,context_id,payload_sha256,title,text,visibility,received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      OWNER.organization_id, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type,
      request.request_id,
      `ctx_${canonicalSha256({ organization_id: OWNER.organization_id, membership_id: OWNER.membership_id, request_id: request.request_id }).slice(7)}`,
      canonicalSha256(request), title, text, "team", now(),
    );
    const worker = new PersonDocumentProcessingV1(repository, undefined, new SqlitePersonTextSourceInboxV1(database, now));
    expect(await worker.runOnce(new AbortController().signal)).toBe("admitted");
  };

  return { database, retrieval, repository, documents, upload, uploadChunks, admitLegacyTeamNote };
}

function texts(result: ReturnType<SqlitePersonOriginalContextRetrievalV1["retrieve"]>): readonly string[] {
  return result.release.released_atoms.map(atom => atom.text);
}

function citationOf(atom: ReturnType<SqlitePersonOriginalContextRetrievalV1["retrieve"]>["release"]["released_atoms"][number]): OriginalContextCitationV1 {
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
  it("supplies SCOUT evidence for all seven recorded questions using real upload, extraction and scoped Ask", async () => {
    const f = fixture();
    const worker = new PersonDocumentProcessingV1(f.repository);
    for (const filename of ["SCOUT-MRD-v0.1.md", "SCOUT-PRD-v0.2.md"]) {
      const bytes = readFileSync(new URL(`../../../docs/simulations/scout/${filename}`, import.meta.url));
      f.documents.upload("owner", {
        schema_version: 1, kind: "echo-person-document-upload-v1", request_id: randomUUID(),
        filename, title: filename, content_length: bytes.length, sha256: sha256Digest(bytes),
        audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_ALPHA,
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
      let calls = 0;
      const app = createPersonAnswerV2Route({
        authority_id: "oau_original_context", organization_id: OWNER.organization_id, state_lineage_id: "lineage_fixture",
        originals: f.retrieval,
        records: {
          searchBatch: (input: { readonly project_id?: string; readonly queries: readonly string[] }) => {
            expect(input.project_id).toBe(PROJECT_ALPHA);
            return {
              response: { items: [] }, query_hit_counts: input.queries.map(() => 0),
              release: {
                current_authorization: authorization(MEMBER),
                active_pointer: { generation_id: canonicalSha256("empty project records"), record_head: { position: 0, record_sha256: null } },
                record_read_audit_row_sha256: canonicalSha256("empty record release"),
              },
            };
          },
          revalidateBatchRelease: () => authorization(MEMBER),
        } as never,
        model: { async generate(input) {
          calls += 1;
          const prompt = JSON.parse(input.user_prompt) as { sources: { citation_id: string; text: string }[] };
          const evidence = prompt.sources.map(source => source.text).join("\n");
          for (const value of required) expect(evidence, question).toContain(value);
          // A deterministic answer proves the route/citation boundary, not model answer quality.
          return { answer: { text: "Evidence is available for review.", citations: [prompt.sources[0]!.citation_id] } };
        } },
        generation: { generation_adapter_id: "fixture", planner_model: "unused", answer_model: "fixture", timeout_ms: 1000 },
        audit: new SqlitePersonAnswerCompositionAuditV1(f.database),
      });
      const result = await app.ask({ access_token: "member", request: { schema_version: 2, question, project_id: PROJECT_ALPHA } });
      expect(calls).toBe(1);
      expect(result.scope).toEqual({ kind: "project", project_id: PROJECT_ALPHA });
      expect(result.citations).toHaveLength(1);
      const citation = result.citations[0]!;
      expect(citation.kind).toBe("source_revision");
      if (citation.kind === "source_revision") {
        expect(f.retrieval.read({ access_token: "member", scope: result.scope, citation }).atom.anchor_sha256).toBe(citation.anchor_sha256);
      }
    }
  });

  it("does not turn function words or an unmatched subject into arbitrary document evidence", () => {
    const f = fixture();
    f.upload("An ordinary plan", "This is the plan and it is ready for review.");
    for (const question of ["What is it?", "What is the zeppelin budget?"]) {
      const result = f.retrieval.retrieve({ access_token: "member", queries: [question], scope: { kind: "global" } });
      expect(result.query_hit_counts).toEqual([0]);
      expect(result.release.released_atoms).toEqual([]);
    }
  });

  it("preserves uppercase technical acronyms that overlap English function words", () => {
    const f = fixture();
    f.upload("Interface", "CAN bus connects the controller.");
    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["What is CAN?"], scope: { kind: "global" } })).join(" ")).toContain("CAN bus");
  });

  it("retrieves the battery requirement from a natural question ahead of newer incidental matches", () => {
    const f = fixture();
    const documentId = f.upload("SCOUT PRD", "PRD-14: Check battery reserve before starting. Hardware and Software propose thresholds and recovery.", { project_id: PROJECT_ALPHA });
    for (let index = 0; index < 7; index += 1) {
      f.upload(`Other ${index}`, "The requirements are proposed for review.", { project_id: PROJECT_ALPHA });
    }
    const result = f.retrieval.retrieve({ access_token: "member", queries: ["What are the battery reserve requirements?"], scope: { kind: "project", project_id: PROJECT_ALPHA } });
    expect(result.release.released_atoms[0]).toMatchObject({ document_id: documentId });
    expect(texts(result)[0]).toContain("PRD-14");
  });

  it("keeps archived-project Ask evidence and its citation readable until the member grant is removed", async () => {
    const f = fixture();
    f.upload("Archive evidence", "archive-ask-marker remains valid after project archive", { audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_ALPHA });
    const projects = createProjectContextApplicationV1({ authenticate: () => authorization(OWNER), repository: new SqliteProjectContextRepositoryV1(f.database, () => PROJECT_CONTEXT_NOW) });
    projects.archiveProject("owner", { schema_version: 1, kind: "echo-project-archive-v1", request_id: randomUUID(), project_id: PROJECT_ALPHA, archived: true });
    const app = createPersonAnswerV2Route({
      authority_id: "oau_original_context", organization_id: OWNER.organization_id, state_lineage_id: "lineage_fixture",
      originals: f.retrieval,
      records: {
        searchBatch: (input: { readonly project_id?: string; readonly queries: readonly string[] }) => {
          expect(input.project_id).toBe(PROJECT_ALPHA);
          return { response: { items: [] }, query_hit_counts: input.queries.map(() => 0), release: {
            current_authorization: authorization(MEMBER),
            active_pointer: { generation_id: canonicalSha256("empty project records"), record_head: { position: 0, record_sha256: null } },
            record_read_audit_row_sha256: canonicalSha256("empty record release"),
          } };
        },
        revalidateBatchRelease: () => authorization(MEMBER),
      } as never,
      model: { async generate(input) {
        const prompt = JSON.parse(input.user_prompt) as { sources: { citation_id: string; text: string }[] };
        expect(prompt.sources.map(source => source.text).join("\n")).toContain("archive-ask-marker");
        return { answer: { text: "Archived evidence remains available.", citations: [prompt.sources[0]!.citation_id] } };
      } },
      generation: { generation_adapter_id: "fixture", planner_model: "unused", answer_model: "fixture", timeout_ms: 1000 },
      audit: new SqlitePersonAnswerCompositionAuditV1(f.database),
    });
    const answer = await app.ask({ access_token: "member", request: { schema_version: 2, question: "Where is archive ask marker?", project_id: PROJECT_ALPHA } });
    expect(answer.citations).toHaveLength(1);
    const citation = answer.citations[0]!;
    if (citation.kind !== "source_revision") throw new Error("expected source evidence citation");
    expect(f.retrieval.read({ access_token: "member", scope: answer.scope, citation }).atom.text).toContain("archive-ask-marker");
    f.database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=?").run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA, MEMBER.membership_id);
    expect(() => f.retrieval.read({ access_token: "member", scope: answer.scope, citation })).toThrow();
  });

  it("does not release private or other-project evidence when only some question terms match", () => {
    const f = fixture();
    const allowed = f.upload("Visible", "battery reserve review", { project_id: PROJECT_ALPHA });
    f.upload("Private", "battery reserve requirements", { audience: { kind: "only_me" }, project_id: PROJECT_ALPHA });
    f.upload("Other project", "battery reserve requirements", { project_id: PROJECT_BETA });
    f.upload("Other audience", "battery reserve requirements", { audience: { kind: "project", project_id: PROJECT_BETA }, project_id: PROJECT_ALPHA });
    const result = f.retrieval.retrieve({ access_token: "member", queries: ["What are the battery requirements?"], scope: { kind: "project", project_id: PROJECT_ALPHA } });
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
    const retrieve = (marker: string, project?: typeof PROJECT_ALPHA | typeof PROJECT_BETA, access_token = "member") => f.retrieval.retrieve({ access_token, queries: [marker], scope: project ? { kind: "project", project_id: project } : { kind: "global" } });
    expect(texts(retrieve("sharedmodernmarker", PROJECT_ALPHA))).toEqual([expect.stringContaining("sharedmodernmarker")]);
    expect(texts(retrieve("documentmodernmarker", PROJECT_ALPHA))).toEqual([expect.stringContaining("documentmodernmarker")]);
    expect(texts(retrieve("privatemodernmarker", PROJECT_ALPHA))).toEqual([]);
    expect(texts(retrieve("privatemodernmarker", PROJECT_ALPHA, "owner"))).toEqual([expect.stringContaining("privatemodernmarker")]);
    expect(texts(retrieve("unassociatedmodernmarker", PROJECT_ALPHA))).toEqual([]);
    expect(texts(retrieve("unassociatedmodernmarker"))).toEqual([expect.stringContaining("unassociatedmodernmarker")]);
    const home = retrieve("homepersonalnotemarker", undefined, "owner");
    expect(texts(home)).toEqual([expect.stringContaining("homepersonalnotemarker")]);
    expect(texts(retrieve("homepersonalnotemarker"))).toEqual([]);
    expect(texts(retrieve("homepersonalnotemarker", PROJECT_ALPHA, "owner"))).toEqual([]);
    expect(f.retrieval.read({ access_token: "owner", scope: { kind: "global" }, citation: citationOf(home.release.released_atoms[0]!) }).atom.text).toContain("homepersonalnotemarker");
    grant(f.database, PROJECT_BETA, MEMBER, "member");
    expect(texts(retrieve("sharedmodernmarker", PROJECT_BETA))).toEqual([]);
    expect(texts(retrieve("documentmodernmarker", PROJECT_BETA))).toEqual([expect.stringContaining("documentmodernmarker")]);
    const global = retrieve("sharedmodernmarker");
    const scoped = retrieve("sharedmodernmarker", PROJECT_ALPHA);
    const citation = citationOf(global.release.released_atoms[0]!);
    f.database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=?").run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA, MEMBER.membership_id);
    expect(() => f.retrieval.revalidate({ access_token: "member", release: scoped.release })).toThrow();
    expect(() => f.retrieval.revalidate({ access_token: "member", release: global.release })).not.toThrow();
    expect(f.retrieval.read({ access_token: "member", scope: { kind: "global" }, citation }).atom.text).toContain("sharedmodernmarker");
    f.database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=?").run(PROJECT_CONTEXT_NOW, PROJECT_BETA, MEMBER.membership_id);
    expect(() => f.retrieval.revalidate({ access_token: "member", release: global.release })).toThrow();
    expect(() => f.retrieval.read({ access_token: "member", scope: { kind: "global" }, citation })).toThrow();
  });

  it("records repeated identical releases without colliding on a content-free audit identity", () => {
    const f = fixture();
    f.upload("Repeated audit", "repeated-audit-marker");
    const fixedSession = new SqlitePersonOriginalContextRetrievalV1(f.database, {
      authenticateAccess: ({ access_token }) => authorization(access_token === "member" ? MEMBER : OWNER),
    }, OWNER.organization_id);
    const input = { access_token: "member", queries: ["repeated-audit-marker"], scope: { kind: "global" as const } };
    expect(fixedSession.retrieve(input).query_hit_counts).toEqual([1]);
    expect(() => fixedSession.retrieve(input)).not.toThrow();
  });

  it("uses actual V8 source admission for legacy notes and excludes a raw meeting source", async () => {
    const f = fixture();
    await f.admitLegacyTeamNote("Legacy handoff", "legacycontextmarker is retained through the common Person source adapter");
    const legacy = f.retrieval.retrieve({ access_token: "member", queries: ["legacycontextmarker"], scope: { kind: "global" } });
    expect(texts(legacy).join(" ")).toContain("legacycontextmarker");

    const meeting = {
      schema_version: 1 as const, id: "meeting-adversarial-1",
      provenance: { source: { kind: "meeting-source" as const, adapter_id: "meeting", instance_id: "fixture", version: "1" }, external_id: "meeting-adversarial-1", canonical_revision: "revision-1", observed_at: PROJECT_CONTEXT_NOW, normalizer_version: "1" },
      capture: { state: "complete" as const, components: [] }, participants: [], artifacts: [],
      content: [{ id: "note-1", kind: "note" as const, text: "rawmeetingsecretmarker must never enter Ask originals" }],
    };
    const bridge = new MeetingSourceBridgeV1({
      identity: meeting.provenance.source,
      validateConfig: () => ({ ok: true, errors: [] }),
      healthCheck: async () => ({ status: "healthy" as const, checked_at: PROJECT_CONTEXT_NOW }),
      pull: async () => ({ meetings: [meeting], next_cursor: "meeting-adversarial-next" }),
    });
    await pullAndAdmitSourceBatchV1({
      source: bridge, request: { limit: 1 },
      admission: { store: new SqliteSourceAdmissionStoreV1(f.database), scope: { organization_id: OWNER.organization_id, custody_ref: `organization:${OWNER.organization_id}`, access_policy_ref: "meeting-fixture", analysis_policy: "automatic" } },
    });
    const raw = f.retrieval.retrieve({ access_token: "member", queries: ["rawmeetingsecretmarker"], scope: { kind: "global" } });
    expect(raw.query_hit_counts).toEqual([0]);
    expect(texts(raw).join(" ")).not.toContain("rawmeetingsecretmarker");
  });

  it("retains an approved transcript through archive and revokes it on leave under its exact source and current policy", async () => {
    const f = fixture();
    const meeting = {
      schema_version: 1 as const, id: "meeting-transcript-1",
      provenance: { source: { kind: "meeting-source" as const, adapter_id: "meeting", instance_id: "fixture", version: "1" }, external_id: "meeting-transcript-1", canonical_revision: "revision-1", observed_at: PROJECT_CONTEXT_NOW, normalizer_version: "1" },
      capture: { state: "complete" as const, components: [{ kind: "transcript" as const, state: "available" as const }] }, participants: [], artifacts: [],
      content: [{ id: "transcript-1", kind: "transcript" as const, text: "approved transcript marker is never Ask evidence" }],
    };
    const bridge = new MeetingSourceBridgeV1({
      identity: meeting.provenance.source,
      validateConfig: () => ({ ok: true, errors: [] }),
      healthCheck: async () => ({ status: "healthy" as const, checked_at: PROJECT_CONTEXT_NOW }),
      pull: async () => ({ meetings: [meeting], next_cursor: "meeting-transcript-next" }),
    });
    await pullAndAdmitSourceBatchV1({
      source: bridge, request: { limit: 1 },
      admission: { store: new SqliteSourceAdmissionStoreV1(f.database), scope: { organization_id: OWNER.organization_id, custody_ref: `organization:${OWNER.organization_id}`, access_policy_ref: "meeting-fixture", analysis_policy: "automatic" } },
    });
    const source = f.database.prepare("SELECT source_id,revision_id,('sha256:' || revision_sha256) AS source_sha256 FROM authority_source_revisions_v1").get() as { source_id: `source:${string}`; revision_id: string; source_sha256: `sha256:${string}` };
    let enabled = true;
    const policy = PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
    let validPolicyContract = true;
    let revokeAtFinalFence = false;
    let armedGrantLookups = 0;
    const retrieval = new SqlitePersonOriginalContextRetrievalV1(f.database, {
      authenticateAccess: ({ access_token }) => authorization(access_token === "member" ? MEMBER : OWNER),
    }, OWNER.organization_id, {
      authority_id: "oau_original_context", state_lineage_id: "lineage_fixture",
      is_expected_policy_contract: () => validPolicyContract,
      grants: { find: () => {
        if (revokeAtFinalFence && ++armedGrantLookups === 2) {
          f.database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=?")
            .run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA, MEMBER.membership_id);
          grant(f.database, PROJECT_ALPHA, MEMBER, "member");
        }
        return enabled ? {
        approval_id: "apr_transcript_fixture", record_position: 1,
        record_sha256: sha256Digest("transcript-record"),
        policy_id: policy,
        policy_contract_sha256: sha256Digest("transcript-contract"),
        source_id: source.source_id, revision_id: source.revision_id, source_sha256: source.source_sha256,
        reviewer_principal_id: null, reviewer_membership_id: null,
        audience_project_ids: policy === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID ? [PROJECT_ALPHA, PROJECT_BETA] : [], association_project_ids: [PROJECT_ALPHA, PROJECT_BETA],
        } : null;
      } },
    });
    const citation = { kind: "approved_meeting_transcript" as const, approval_id: "apr_transcript_fixture", ...source };
    expect(retrieval.retrieve({ access_token: "member", queries: ["approved transcript marker"], scope: { kind: "global" } }).query_hit_counts).toEqual([0]);
    const released = retrieval.readApprovedMeetingTranscript({ access_token: "member", scope: { kind: "global" }, citation });
    expect(released.text).toContain("approved transcript marker");
    const projects = createProjectContextApplicationV1({ authenticate: token => authorization(token === "member" ? MEMBER : OWNER), repository: new SqliteProjectContextRepositoryV1(f.database, () => PROJECT_CONTEXT_NOW) });
    projects.archiveProject("owner", { schema_version: 1, kind: "echo-project-archive-v1", request_id: randomUUID(), project_id: PROJECT_ALPHA, archived: true });
    expect(retrieval.readApprovedMeetingTranscript({ access_token: "member", scope: { kind: "global" }, citation }).text).toBe(released.text);
    expect(retrieval.readApprovedMeetingTranscript({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, citation }).text).toBe(released.text);
    const transcriptAudit = (f.database.prepare("SELECT body_json FROM authority_person_upload_read_audit_v1").all() as Array<{ body_json: string }>)
      .map(row => JSON.parse(row.body_json) as Record<string, unknown>)
      .find(row => row.kind === "echo-person-approved-meeting-transcript-read-audit-v1");
    expect(transcriptAudit).toMatchObject({
      page_sha256: canonicalSha256(released.text),
      response_sha256: canonicalSha256({ schema_version: 1, kind: "echo-person-meeting-transcript-v1", ...released }),
    });
    expect(() => retrieval.readApprovedMeetingTranscript({
      access_token: "member", scope: { kind: "global" },
      citation: { ...citation, revision_id: "a-different-retained-revision" },
    })).toThrow();
    validPolicyContract = false;
    expect(() => retrieval.readApprovedMeetingTranscript({ access_token: "member", scope: { kind: "global" }, citation })).toThrow();
    validPolicyContract = true;
    expect(retrieval.readApprovedMeetingTranscript({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, citation }).text).toContain("approved transcript marker");
    expect(() => retrieval.readApprovedMeetingTranscript({ access_token: "member", scope: { kind: "project", project_id: PROJECT_BETA }, citation })).toThrow();
    revokeAtFinalFence = true;
    const auditsBeforeFinalFence = f.database.prepare("SELECT COUNT(*) AS count FROM authority_person_upload_read_audit_v1 WHERE body_json LIKE '%echo-person-approved-meeting-transcript-read-audit-v1%'").get() as { count: number };
    expect(() => retrieval.readApprovedMeetingTranscript({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, citation })).toThrow();
    const auditsAfterFinalFence = f.database.prepare("SELECT COUNT(*) AS count FROM authority_person_upload_read_audit_v1 WHERE body_json LIKE '%echo-person-approved-meeting-transcript-read-audit-v1%'").get() as { count: number };
    expect(auditsAfterFinalFence.count).toBe(auditsBeforeFinalFence.count);
    revokeAtFinalFence = false;
    projects.leaveProject("member", { schema_version: 1, kind: "echo-project-leave-v1", request_id: randomUUID(), project_id: PROJECT_ALPHA });
    expect(() => retrieval.readApprovedMeetingTranscript({ access_token: "member", scope: { kind: "project", project_id: PROJECT_ALPHA }, citation })).toThrow();
    expect(() => retrieval.readApprovedMeetingTranscript({ access_token: "member", scope: { kind: "global" }, citation })).toThrow();
    enabled = false;
    expect(() => retrieval.readApprovedMeetingTranscript({ access_token: "owner", scope: { kind: "global" }, citation })).toThrow();
  });

  it("enforces audience separately from project association in global and project-scoped reads", () => {
    const f = fixture();
    f.upload("Shared Alpha", "sharedalphamarker", { project_id: PROJECT_ALPHA });
    f.upload("Private Alpha", "privatealphamarker", { audience: { kind: "only_me" }, project_id: PROJECT_ALPHA });
    f.upload("Beta audience Alpha association", "betaaudiencealphaassociationmarker", { audience: { kind: "project", project_id: PROJECT_BETA }, project_id: PROJECT_ALPHA });
    f.upload("Alpha audience Beta association", "alphaaudiencebetaassociationmarker", { audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_BETA });

    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["sharedalphamarker"], scope: { kind: "global" } })).join(" ")).toContain("sharedalphamarker");
    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["privatealphamarker"], scope: { kind: "global" } }))).toEqual([]);
    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["betaaudiencealphaassociationmarker"], scope: { kind: "project", project_id: PROJECT_ALPHA } }))).toEqual([]);
    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["alphaaudiencebetaassociationmarker"], scope: { kind: "global" } })).join(" ")).toContain("alphaaudiencebetaassociationmarker");
    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["alphaaudiencebetaassociationmarker"], scope: { kind: "project", project_id: PROJECT_ALPHA } }))).toEqual([]);
  });

  it("limits a broad single planned query to five newer originals, leaving later competing originals unreleased", () => {
    const f = fixture();
    for (let index = 0; index < 11; index += 1) {
      f.upload(`Competing ${index}`, `broad-competition-marker document-${index}`);
    }
    const result = f.retrieval.retrieve({ access_token: "member", queries: ["broad-competition-marker"], scope: { kind: "global" } });
    expect(result.query_hit_counts).toEqual([5]);
    expect(texts(result).join(" ")).toContain("document-10");
    expect(texts(result).join(" ")).not.toContain("document-0");
  });

  it("keeps a globally readable team original available after an uncited project grant is revoked", () => {
    const f = fixture();
    f.upload("Shared evidence", "uncited-revocation-marker", { project_id: PROJECT_ALPHA });
    const released = f.retrieval.retrieve({ access_token: "member", queries: ["uncited-revocation-marker"], scope: { kind: "global" } });
    f.database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=?")
      .run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA, MEMBER.membership_id);
    expect(f.retrieval.revalidate({ access_token: "member", release: released.release })).toMatchObject({ checked_at: expect.any(String) });
  });

  it("fails revalidation after a selected-project grant is revoked, including global project-audience sources", () => {
    const f = fixture();
    f.upload("Selected project", "selected-project-revocation-marker", { audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_ALPHA });
    const scoped = f.retrieval.retrieve({ access_token: "member", queries: ["selected-project-revocation-marker"], scope: { kind: "project", project_id: PROJECT_ALPHA } });
    const global = f.retrieval.retrieve({ access_token: "member", queries: ["selected-project-revocation-marker"], scope: { kind: "global" } });
    f.database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=?")
      .run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA, MEMBER.membership_id);
    expect(() => f.retrieval.revalidate({ access_token: "member", release: scoped.release }))
      .toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(() => f.retrieval.revalidate({ access_token: "member", release: global.release }))
      .toThrow(expect.objectContaining({ code: "unauthorized" }));
  });

  it("rejects a tampered representation body when its stored hash is unchanged", () => {
    const f = fixture();
    f.upload("Representation check", "representation-corruption-marker");
    const released = f.retrieval.retrieve({ access_token: "member", queries: ["representation-corruption-marker"], scope: { kind: "global" } });
    f.database.exec("DROP TRIGGER authority_source_representations_v1_update_denied");
    f.database.prepare("UPDATE authority_source_representations_v1 SET content_json=?").run('{"tampered":true}');
    expect(() => f.retrieval.revalidate({ access_token: "member", release: released.release }))
      .toThrow(expect.objectContaining({ code: "unavailable" }));
  });

  it("excludes a mutable document title from released evidence and its citation", () => {
    const f = fixture();
    const documentId = f.upload("Immutable title", "document-title-integrity-marker");
    const input = { access_token: "member", queries: ["document-title-integrity-marker"], scope: { kind: "global" as const } };
    const released = f.retrieval.retrieve(input);
    const citation = citationOf(released.release.released_atoms[0]!);

    // The document row has no immutable title column. A retained-row title
    // must therefore never enter source evidence or its citation anchor.
    f.database.exec("DROP TRIGGER authority_person_documents_v1_update_denied");
    f.database.prepare("UPDATE authority_person_documents_v1 SET title=? WHERE document_id=?")
      .run("Forged document title", documentId);
    expect(f.retrieval.retrieve({ ...input, queries: ["Forged"] }).release.released_atoms).toEqual([]);
    expect(f.retrieval.retrieve({ ...input, queries: ["Immutable-title.md"] }).release.released_atoms)
      .toHaveLength(1);
    const after = f.retrieval.retrieve(input).release.released_atoms[0]!;
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
    const atom = f.retrieval.retrieve({ access_token: "member", queries: ["long-filename-roundtrip-marker"], scope }).release.released_atoms[0]!;
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
    const atom = f.retrieval.retrieve({ access_token: "member", queries: [`public-label-roundtrip-${label}`], scope }).release.released_atoms[0]!;
    expect(atom.text.startsWith(`${filename}\n`)).toBe(true);
    expect(atom.label).toBe(label);
    const citation = citationOf(atom);
    const proof = f.retrieval.read({ access_token: "member", scope, citation }).atom;
    expect(proof).toMatchObject({ label, text: atom.text, anchor_sha256: atom.anchor_sha256 });
    expect(() => validatePersonAnswerResponseV3({
      schema_version: 3,
      kind: "echo-clean-person-answer-v3",
      answer: "Found it.",
      citations: [{ ...citation, label }],
      scope,
    })).not.toThrow();
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
    // This valid 3 KiB extraction chunk puts 'needle' across the former 3,067
    // body-byte boundary after the title and newline consume five bytes.
    f.upload("Plan", "a".repeat(3065) + "needle");
    const result = f.retrieval.retrieve({ access_token: "member", queries: ["needle"], scope: { kind: "global" } });
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
      await f.admitLegacyTeamNote("Integrity proof", "integrity-proof-marker remains original evidence");
      const input = { access_token: "member", queries: ["integrity-proof-marker"], scope: { kind: "global" as const } };
      const released = f.retrieval.retrieve(input);
      const citation = citationOf(released.release.released_atoms[0]!);
      expect(f.retrieval.read({ access_token: "member", scope: input.scope, citation }).atom.text).toContain("remains original evidence");

      // Simulate retained-state corruption, not an allowed user mutation.
      // Immutability guards themselves are covered by source-custody tests.
      if (carrier === "retained note") {
        f.database.exec("DROP TRIGGER authority_person_updates_v1_immutable");
        f.database.prepare("UPDATE authority_person_updates_v1 SET text=?").run("integrity-proof-marker now contains forged evidence");
      } else if (carrier === "canonical source content") {
        f.database.exec("DROP TRIGGER authority_source_contents_v1_update_denied");
        f.database.prepare("UPDATE authority_source_contents_v1 SET content_json=json_set(content_json,'$.text',?)")
          .run("integrity-proof-marker now contains forged evidence");
      } else {
        f.database.exec("DROP TRIGGER authority_source_revisions_v1_update_denied");
        f.database.prepare("UPDATE authority_source_revisions_v1 SET manifest_json=json_set(manifest_json,'$.content_sha256',?)")
          .run("0".repeat(64));
      }
      expect(() => f.retrieval.retrieve(input)).toThrow(expect.objectContaining({ code: "unavailable" }));
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
    const released = f.retrieval.retrieve({ access_token: "member", queries: ["exact-citation-marker"], scope });
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
    f.database.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=?")
      .run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA, MEMBER.membership_id);
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
    const input = { queries: ["scope-clarification-marker"], scope };
    const own = f.retrieval.retrieve({ ...input, access_token: "owner" });
    expect(own.release.released_atoms).toHaveLength(1);
    expect(texts(own)[0]).toContain("own-associated-private");
    expect(texts(f.retrieval.retrieve({ ...input, access_token: "member" }))).toEqual([]);
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
    const released = retrieval.retrieve({ access_token: "member", queries: ["late-evidence-marker"], scope: { kind: "global" } });
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

  it("keeps the ordinary document inventory representative-only, while the internal item inventory counts every readable passage", () => {
    const f = fixture();
    f.uploadChunks("Complete shortcut inventory", ["first readable passage", "second readable passage", "third readable passage"]);
    const ordinary = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, limit: 20 });
    const complete = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, limit: 20, inventory_mode: "items" });
    expect(ordinary.items).toHaveLength(1);
    expect(complete.items).toHaveLength(3);
    expect(complete.truncated).toBe(false);
    expect(new Set(complete.items.map(item => item.citation.anchor_sha256)).size).toBe(3);
    expect(complete.items.every(item => item.text === undefined)).toBe(true);
  });

  it("marks the internal item inventory truncated before the shortcut can treat more than twenty passages as complete", () => {
    const f = fixture();
    f.uploadChunks("Oversized shortcut inventory", Array.from({ length: 21 }, (_, index) => `readable passage ${index + 1}`));
    const complete = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, limit: 20, inventory_mode: "items" });
    expect(complete.items).toHaveLength(20);
    expect(complete.truncated).toBe(true);
  });

  it("counts every canonical packet in a long document and note for complete items inventory", async () => {
    const f = fixture();
    const documentTail = "document-tail-fact";
    const noteTail = "note-tail-fact";
    // Extraction limits a chunk to 3072 bytes, but a filename heading still
    // leaves less room in a desk packet and therefore creates two anchors.
    f.uploadChunks("Packetized document", [`${"d".repeat(3_054)}${documentTail}`]);
    await f.admitLegacyTeamNote("Packetized note", `${"note body ".repeat(500)}${noteTail}`);
    const complete = f.retrieval.deskSearch({ access_token: "member", scope: { kind: "global" }, limit: 20, inventory_mode: "items" });
    expect(complete.items.length).toBeGreaterThan(2);
    expect(complete.truncated).toBe(false);
    const passages = complete.items.filter(item => item.kind === "document_passage");
    const notes = complete.items.filter(item => item.kind === "note");
    expect(passages.length).toBeGreaterThan(1);
    expect(notes.length).toBeGreaterThan(1);
    const tailDocument = passages[passages.length - 1]!;
    const tailNote = notes[notes.length - 1]!;
    expect(f.retrieval.read({ access_token: "member", scope: { kind: "global" }, citation: tailDocument.citation }).atom.text).toContain(documentTail);
    expect(f.retrieval.read({ access_token: "member", scope: { kind: "global" }, citation: tailNote.citation }).atom.text).toContain(noteTail);
  });
});
