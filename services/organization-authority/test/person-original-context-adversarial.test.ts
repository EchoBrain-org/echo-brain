import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonAnswerResponseV3, validatePersonSourceEvidenceV1 } from "@echo-brain/organization-api";
import { MeetingSourceBridgeV1, pullAndAdmitSourceBatchV1 } from "@echo-brain/organization-processing/core";
import { SqlitePersonDocumentRepositoryV1 } from "../src/adapters/persistence/sqlite/document-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonTextSourceInboxV1 } from "../src/adapters/persistence/sqlite/person-text-source-v1.js";
import { SqliteSourceAdmissionStoreV1 } from "../src/adapters/persistence/sqlite/source-admission-v1.js";
import { createPersonDocumentApplicationV1 } from "../src/application/document-v1.js";
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
  database.exec(readFileSync(new URL("../../../packages/organization-authority-kernel/baselines/authority-baseline-v8.sql", import.meta.url), "utf8"));
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

  return { database, retrieval, upload, uploadChunks, admitLegacyTeamNote };
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
    await f.admitLegacyTeamNote("Legacy handoff", "legacy-context-marker is retained through the common Person source adapter");
    const legacy = f.retrieval.retrieve({ access_token: "member", queries: ["legacy-context-marker"], scope: { kind: "global" } });
    expect(texts(legacy).join(" ")).toContain("legacy-context-marker");

    const meeting = {
      schema_version: 1 as const, id: "meeting-adversarial-1",
      provenance: { source: { kind: "meeting-source" as const, adapter_id: "meeting", instance_id: "fixture", version: "1" }, external_id: "meeting-adversarial-1", canonical_revision: "revision-1", observed_at: PROJECT_CONTEXT_NOW, normalizer_version: "1" },
      capture: { state: "complete" as const, components: [] }, participants: [], artifacts: [],
      content: [{ id: "note-1", kind: "note" as const, text: "raw-meeting-secret-marker must never enter Ask originals" }],
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
    const raw = f.retrieval.retrieve({ access_token: "member", queries: ["raw-meeting-secret-marker"], scope: { kind: "global" } });
    expect(raw.query_hit_counts).toEqual([0]);
    expect(texts(raw).join(" ")).not.toContain("raw-meeting-secret-marker");
  });

  it("enforces audience separately from project association in global and project-scoped reads", () => {
    const f = fixture();
    f.upload("Shared Alpha", "shared-alpha-marker", { project_id: PROJECT_ALPHA });
    f.upload("Private Alpha", "private-alpha-marker", { audience: { kind: "only_me" }, project_id: PROJECT_ALPHA });
    f.upload("Beta audience Alpha association", "beta-audience-alpha-association-marker", { audience: { kind: "project", project_id: PROJECT_BETA }, project_id: PROJECT_ALPHA });
    f.upload("Alpha audience Beta association", "alpha-audience-beta-association-marker", { audience: { kind: "project", project_id: PROJECT_ALPHA }, project_id: PROJECT_BETA });

    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["shared-alpha-marker"], scope: { kind: "global" } })).join(" ")).toContain("shared-alpha-marker");
    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["private-alpha-marker"], scope: { kind: "global" } }))).toEqual([]);
    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["beta-audience-alpha-association-marker"], scope: { kind: "project", project_id: PROJECT_ALPHA } }))).toEqual([]);
    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["alpha-audience-beta-association-marker"], scope: { kind: "global" } })).join(" ")).toContain("alpha-audience-beta-association-marker");
    expect(texts(f.retrieval.retrieve({ access_token: "member", queries: ["alpha-audience-beta-association-marker"], scope: { kind: "project", project_id: PROJECT_ALPHA } }))).toEqual([]);
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
});
