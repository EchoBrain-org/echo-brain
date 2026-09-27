import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { StructuredGenerationInput, StructuredGenerationPort } from "@echo-brain/organization-authority-kernel/answer-composition/retrieval-grounded-answer-composition";
import { SqlitePersonDocumentRepositoryV1 } from "../src/adapters/persistence/sqlite/document-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonAgenticAskAuditV1 } from "../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import { createPersonDocumentApplicationV1 } from "../src/application/document-v1.js";
import { createPersonAnswerV3Route } from "../src/composition/person-answer-v3-route.js";
import { PersonRecordSearchIndexLagV1 } from "../src/composition/person-record-search-route.js";
import { MEMBER, OWNER, PROJECT_ALPHA, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase } from "./fixtures/project-context-sqlite.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

type Prompt = { question?: string; parts?: { id: string; statements?: { text: string; evidence_ids: string[] }[] }[]; evidence?: { id: string; text: string }[] };
function fixture() {
  const database = projectContextDatabase(); databases.push(database);
  database.prepare(`INSERT INTO authority_projects_v1
    (project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type)
    VALUES (?,?,?,?,?,?,?)`).run(PROJECT_ALPHA, OWNER.organization_id, "Atlas", PROJECT_CONTEXT_NOW, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type);
  for (const actor of [OWNER, MEMBER]) database.prepare(`INSERT INTO authority_project_memberships_v1
    (project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at)
    VALUES (?,?,?,?,?,?,?,'active',?)`).run(`pgm_${randomUUID()}`, PROJECT_ALPHA, actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, actor === OWNER ? "lead" : "member", PROJECT_CONTEXT_NOW);
  let tick = Date.parse(PROJECT_CONTEXT_NOW);
  let revoked = false;
  const authenticateAccess = ({ access_token }: { access_token: string }) => {
    if (revoked) throw new AuthorityOperationError("unauthorized", "membership revoked");
    return authorization(access_token === "member" ? MEMBER : OWNER, { checked_at: new Date(tick += 1000).toISOString() });
  };
  const originals = new SqlitePersonOriginalContextRetrievalV1(database, { authenticateAccess }, OWNER.organization_id);
  const repository = new SqlitePersonDocumentRepositoryV1(database, () => new Date(tick += 1000).toISOString());
  const documents = createPersonDocumentApplicationV1({ repository, authenticate: () => authorization(OWNER) });
  const upload = (title: string, text: string, audience: "team" | "only_me" = "team") => {
    const bytes = Buffer.from(text);
    documents.upload("owner", { schema_version: 1, kind: "echo-person-document-upload-v1", request_id: randomUUID(), filename: `${title}.md`, title, content_length: bytes.length, sha256: sha256Digest(bytes), audience: { kind: audience }, project_id: PROJECT_ALPHA }, bytes);
    const claim = repository.claimExtraction(); if (claim === undefined) throw new Error("missing extraction claim");
    expect(repository.completeExtraction(claim, { status: "ready", sourceSha256: claim.source_sha256, extractorVersion: "fixture-1", chunks: [{ anchor_kind: "paragraph", anchor_start: 1, text }], message: null })).toBe(true);
  };
  let recordProbes = 0;
  const prompts: string[] = [];
  const roles: string[] = [];
  let afterJudge: (() => void) | undefined;
  let badWriter = false;
  const model: StructuredGenerationPort = { async generate(input: StructuredGenerationInput) {
    prompts.push(input.user_prompt);
    const prompt = JSON.parse(input.user_prompt) as Prompt;
    const properties = input.schema.properties as Readonly<Record<string, unknown>>;
    if (properties?.scope !== undefined) {
      roles.push("judge"); afterJudge?.();
      return { scope: { matches_question: true, note: "" }, done: true, parts: prompt.parts!.map(part => ({ id: part.id, status: prompt.evidence!.length > 0 ? "answered" : "missing", evidence_ids: prompt.evidence!.map(item => item.id), new_queries: [] })) };
    }
    if (properties?.statements !== undefined) {
      roles.push("writer");
      return badWriter ? { unsupported: "Invalid writer shape" } : { statements: [{ text: "The launch window is October.", evidence_ids: [prompt.evidence![0]!.id] }] };
    }
    if (properties?.statement !== undefined) {
      roles.push("summary"); return { statement: prompt.parts![0]!.statements![0] };
    }
    roles.push("plan"); return { parts: [{ question: prompt.question, queries: ["overview"] }] };
  } };
  const route = createPersonAnswerV3Route({
    authority_id: "oau_project_fixture", organization_id: OWNER.organization_id, state_lineage_id: "lineage_fixture",
    sessions: { authenticateAccess } as never, originals,
    records: { initializeDesk() { recordProbes += 1; throw new PersonRecordSearchIndexLagV1(); } } as never,
    model, generation: { generation_adapter_id: "fixture", planner_model: "unused", answer_model: "fixture", timeout_ms: 1000 },
    audit: new SqlitePersonAgenticAskAuditV1(database),
  });
  const ask = (access_token = "owner") => route.ask({ access_token, request: { schema_version: 3, question: "Summarize this project", project_id: PROJECT_ALPHA } });
  return { database, originals, route, upload, ask, prompts, roles, recordProbes: () => recordProbes, badWriter: () => { badWriter = true; }, revokeAfterJudge: () => { afterJudge = () => { revoked = true; }; } };
}

describe("Agentic Ask with stored source evidence", () => {
  it("discovers keyword-free evidence, cites exact source, and appends a bound terminal audit", async () => {
    const f = fixture(); f.upload("Atlas plan", "The launch window is October.");
    const answer = await f.ask();
    expect(answer.outcome).toBe("answered");
    expect(f.roles).toEqual(["plan", "judge", "writer", "summary"]);
    expect(answer.notice).toContain("unavailable"); expect(f.recordProbes()).toBe(1);
    expect(answer.citations).toHaveLength(1);
    const citation = answer.citations[0]!.citation;
    if (citation.kind !== "source_revision") throw new Error("wrong citation kind");
    expect(f.originals.read({ access_token: "owner", scope: answer.scope, citation }).atom.text).toBe("Atlas plan.md\nThe launch window is October.");
    const opened = await f.route.openEvidence({ access_token: "owner", request: { schema_version: 1, citation, project_id: PROJECT_ALPHA } });
    expect(opened.items[0]!.text).toBe("Atlas plan.md\nThe launch window is October.");
    const audit = f.database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'answer_composition'").get() as { body_json: string };
    const body = JSON.parse(audit.body_json) as Record<string, unknown>;
    expect(body.response_sha256).toBe(canonicalSha256(answer)); expect(body.principal_id).toBe(OWNER.principal_id);
    expect(body.model_calls).toBe(4); expect(audit.body_json).not.toContain("October");
  });

  it("keeps private source text out of another member's discovery and marks the owner's statements private", async () => {
    const f = fixture(); f.upload("Atlas private", "The launch window is October. Confidential payload 97531.", "only_me");
    const member = await f.ask("member");
    expect(member.outcome).toBe("not_found"); expect(member.citations).toHaveLength(0);
    expect(f.prompts.join("\n")).not.toContain("97531");
    const owner = await f.ask();
    expect(owner.parts[0]!.statements[0]!.private).toBe(true); expect(owner.direct?.private).toBe(true);
  });

  it("stops before the writer if access is revoked after the judge", async () => {
    const f = fixture(); f.upload("Atlas plan", "The launch window is October."); f.revokeAfterJudge();
    await expect(f.ask()).rejects.toThrow("membership revoked"); expect(f.roles).toEqual(["plan", "judge"]);
    expect(f.database.prepare("SELECT count(*) AS n FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'answer_composition'").get()).toEqual({ n: 0 });
  });

  it("returns exact source text after both writer attempts produce malformed output", async () => {
    const f = fixture(); const text = "The launch window is October."; f.upload("Atlas plan", text); f.badWriter();
    const answer = await f.ask();
    expect(answer.parts[0]!.status).toBe("records_only"); expect(answer.parts[0]!.records?.[0]?.text).toBe(`Atlas plan.md\n${text}`);
    expect(f.roles.filter(role => role === "writer")).toHaveLength(2); expect(answer.direct).toBeUndefined();
  });
});
