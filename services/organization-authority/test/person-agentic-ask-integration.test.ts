import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { StructuredGenerationInput, StructuredGenerationPort } from "@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1";
import { SqlitePersonDocumentRepositoryV1 } from "../src/adapters/persistence/sqlite/document-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonAgenticAskAuditV1 } from "../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import { createPersonDocumentApplicationV1 } from "../src/application/document-v1.js";
import { createPersonAnswerV3Route } from "../src/composition/person-answer-v3-route.js";
import { createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from "../src/composition/person-live-answer-route-v1.js";
import type { PersonPageCitationV1, PersonTicketCitationV1 } from "@echo-brain/organization-api";
import type { PersonLiveEvidenceItemV1, PersonLiveEvidenceSourceV1 } from "@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1";
import { PersonRecordSearchIndexLagV1 } from "../src/composition/person-record-search-route.js";
import { LEGACY_PAGE_CONNECTOR_V1, LEGACY_TICKET_CONNECTOR_V1 } from "../src/composition/person-live-connector-registry-v1.js";
import { MEMBER, OWNER, PROJECT_ALPHA, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase } from "./fixtures/project-context-sqlite.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

type Listing = { id: string; title?: string; text?: string };
type Prompt = {
  question?: string;
  step?: number;
  last_results?: { tool: string; items?: Listing[]; results?: Listing[] }[];
  opened?: Listing[];
  plan?: { part?: number; question: string }[];
  evidence?: Listing[];
};
type Membership = { organization_id: string; principal_id: string; membership_id: string; display_name: string };
function fixture(options: { readonly small_scope_shortcut?: boolean; readonly membership?: (id: string) => Membership | undefined; readonly generate?: StructuredGenerationPort["generate"] } = {}) {
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
  const uploadChunks = (title: string, texts: readonly string[], audience: "team" | "only_me" | "project" = "team") => {
    const bytes = Buffer.from(texts.join("\n"));
    const metadata = { request_id: randomUUID(), filename: `${title}.md`, title, content_length: bytes.length, sha256: sha256Digest(bytes) };
    if (audience === "project") documents.uploadV2("owner", { ...metadata, schema_version: 2, kind: "echo-person-document-upload-v2", audience: { kind: "projects", project_ids: [PROJECT_ALPHA] }, association_project_ids: [PROJECT_ALPHA] }, bytes);
    else documents.upload("owner", { ...metadata, schema_version: 1, kind: "echo-person-document-upload-v1", audience: { kind: audience }, project_id: PROJECT_ALPHA }, bytes);
    const claim = repository.claimExtraction(); if (claim === undefined) throw new Error("missing extraction claim");
    expect(repository.completeExtraction(claim, {
      status: "ready", sourceSha256: claim.source_sha256, extractorVersion: "fixture-1",
      chunks: texts.map((text, index) => ({ anchor_kind: "paragraph", anchor_start: index + 1, text })), message: null,
    })).toBe(true);
  };
  const upload = (title: string, text: string, audience: "team" | "only_me" | "project" = "team") => uploadChunks(title, [text], audience);
  let recordProbes = 0;
  const prompts: string[] = [];
  const roles: string[] = [];
  let afterStep: ((step: number) => void) | undefined;
  let badAnswer = false;
  // A small scripted agent: list documents, open the first listing, then finish on what it read.
  const model: StructuredGenerationPort = { async generate(input: StructuredGenerationInput) {
    prompts.push(input.user_prompt);
    if (options.generate !== undefined) return options.generate(input);
    const prompt = JSON.parse(input.user_prompt) as Prompt;
    const properties = input.schema.properties as Readonly<Record<string, unknown>>;
    if (properties?.sentences !== undefined) {
      roles.push("answer");
      if (badAnswer) return { unsupported: "Invalid answer shape" };
      const first = prompt.evidence![0]!.id;
      return { sentences: [{ text: "The launch window is October.", evidence: [first] }], not_found: [] };
    }
    roles.push("step");
    afterStep?.(prompt.step!);
    const part = (status: string, evidence: string[] = []) => ({ question: prompt.question!, needs: [{ need: "project summary", status, evidence }], notes: "" });
    if ((prompt.opened ?? []).length > 0) return { parts: [part("found", prompt.opened!.map(item => item.id))], actions: [{ tool: "finish", args: {} }] };
    const listed = prompt.last_results?.find(result => result.tool === "list")?.items ?? [];
    if (listed.length > 0) return { parts: [part("open")], actions: [{ tool: "open", args: { id: listed[0]!.id } }] };
    if (prompt.step === 1) return { parts: [part("open")], actions: [{ tool: "list", args: { source: "documents" } }] };
    return { parts: [part("not_found")], actions: [{ tool: "finish", args: {} }] };
  } };
  const route = createPersonAnswerV3Route({
    authority_id: "oau_project_fixture", organization_id: OWNER.organization_id, state_lineage_id: "lineage_fixture",
    sessions: { authenticateAccess } as never, originals,
    records: { initializeDesk() { recordProbes += 1; throw new PersonRecordSearchIndexLagV1(); } } as never,
    model, generation: { generation_adapter_id: "fixture", planner_model: "unused", answer_model: "fixture", timeout_ms: 1000 },
    audit: new SqlitePersonAgenticAskAuditV1(database),
    ...(options.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}),
    ...(options.membership === undefined ? {} : { memberships: { membership: options.membership } }),
  });
  const ask = (access_token = "owner") => route.ask({ access_token, request: { schema_version: 3, question: "Summarize this project", project_id: PROJECT_ALPHA } });
  return {
    database, originals, route, upload, uploadChunks, ask, prompts, roles,
    recordProbes: () => recordProbes,
    badAnswer: () => { badAnswer = true; },
    revokeAfterStep: (step: number) => { afterStep = value => { if (value === step) revoked = true; }; },
    abortAfterStep: (step: number, controller: AbortController) => { afterStep = value => { if (value === step) controller.abort(); }; },
  };
}

const auditRow = (database: Database.Database) => database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'answer_composition'").get() as { body_json: string } | undefined;
const openedTexts = (prompts: readonly string[]) => (JSON.parse(prompts[0]!) as Prompt).opened?.map(item => item.text) ?? [];

describe("Agentic Ask with stored source evidence", () => {
  it("answers globally from unread project search passages without releasing another member's private text", async () => {
    const software = `SCOUT Software Review. ${"Background for this proposal. ".repeat(20)}Software needs an explicit transition table.`;
    const hardware = `SCOUT Hardware Review. ${"Background for this proposal. ".repeat(20)}Hardware needs battery endurance measurements.`;
    const f = fixture({ generate: async input => {
      const prompt = JSON.parse(input.user_prompt) as Prompt;
      const properties = input.schema.properties as Readonly<Record<string, unknown>>;
      if (properties?.sentences !== undefined) {
        const softwareItem = prompt.evidence?.find(item => item.title === "SCOUT Software Review.md");
        const hardwareItem = prompt.evidence?.find(item => item.title === "SCOUT Hardware Review.md");
        expect(softwareItem?.text).toBe(`SCOUT Software Review.md\n${software}`);
        expect(hardwareItem?.text).toBe(`SCOUT Hardware Review.md\n${hardware}`);
        return { sentences: [
          { text: "Software needs an explicit transition table.", evidence: [softwareItem!.id] },
          { text: "Hardware needs battery endurance measurements.", evidence: [hardwareItem!.id] },
        ], not_found: [] };
      }
      expect(prompt.opened).toEqual([]);
      const parts = [{ question: "Compare the SCOUT reviews", needs: [{ need: "review concerns", status: prompt.step === 1 ? "open" : "not_found", evidence: [] }], notes: "" }];
      return { parts, actions: prompt.step === 1
        ? [{ tool: "search", args: { query: "SCOUT Software Review" } }, { tool: "search", args: { query: "SCOUT Hardware Review" } }]
        : [{ tool: "finish", args: {} }] };
    } });
    f.upload("SCOUT Software Review", software, "project");
    f.upload("SCOUT Hardware Review", hardware, "project");
    f.upload("SCOUT confidential review", "SCOUT Software Hardware Review. Private marker 97531.", "only_me");
    const answer = await f.route.ask({ access_token: "member", request: { schema_version: 3, question: "Compare the SCOUT Software Review and Hardware Review" } });
    expect(answer.scope).toEqual({ kind: "global" });
    expect(answer.outcome).toBe("answered");
    expect(answer.citations).toHaveLength(2);
    expect(f.prompts.join("\n")).not.toContain("97531");
    expect(f.prompts.join("\n")).not.toContain("SCOUT confidential review");
    for (const citation of answer.citations) {
      if (citation.citation.kind !== "source_revision") throw new Error("wrong citation kind");
      expect(f.originals.read({ access_token: "member", scope: answer.scope, citation: citation.citation }).atom.text).toMatch(/SCOUT (Software|Hardware) Review/);
    }
    const body = JSON.parse(auditRow(f.database)!.body_json) as Record<string, unknown>;
    expect(body).toMatchObject({ principal_id: MEMBER.principal_id, outcome: "answered" });
    expect(body.response_sha256).toBe(canonicalSha256(answer));
    expect(auditRow(f.database)!.body_json).not.toContain("transition table");
  });

  it("lists keyword-free evidence, opens it, cites the exact source, and appends a bound terminal audit", async () => {
    const f = fixture(); f.upload("Atlas plan", "The launch window is October.");
    const answer = await f.ask();
    expect(answer.outcome).toBe("answered");
    expect(f.roles).toEqual(["step", "step", "step", "answer"]);
    expect(answer.notice).toContain("unavailable"); expect(f.recordProbes()).toBe(1);
    expect(answer.citations).toHaveLength(1);
    const citation = answer.citations[0]!.citation;
    if (citation.kind !== "source_revision") throw new Error("wrong citation kind");
    expect(f.originals.read({ access_token: "owner", scope: answer.scope, citation }).atom.text).toBe("Atlas plan.md\nThe launch window is October.");
    const opened = await f.route.openEvidence({ access_token: "owner", request: { schema_version: 1, citation, project_id: PROJECT_ALPHA } });
    expect(opened.items[0]!.text).toBe("Atlas plan.md\nThe launch window is October.");
    const body = JSON.parse(auditRow(f.database)!.body_json) as Record<string, unknown>;
    expect(body.response_sha256).toBe(canonicalSha256(answer)); expect(body.principal_id).toBe(OWNER.principal_id);
    expect(body).toMatchObject({ model_calls: 4, rounds: 3 }); expect(auditRow(f.database)!.body_json).not.toContain("October");
    for (const prompt of f.prompts) expect(prompt).not.toMatch(/desk_[a-f0-9]{16}|source:[a-f0-9]{64}/);
  });

  it("names the authenticated asker to the model, only from their own directory entry, and never in the audit", async () => {
    const looked: string[] = [];
    const entries: Record<string, Membership> = {
      [OWNER.membership_id]: { organization_id: OWNER.organization_id, principal_id: OWNER.principal_id, membership_id: OWNER.membership_id, display_name: "Zhen Ye" },
      // A row that names another principal is never trusted for this asker.
      [MEMBER.membership_id]: { organization_id: OWNER.organization_id, principal_id: "prn_someone_else", membership_id: MEMBER.membership_id, display_name: "Mallory" },
    };
    const f = fixture({ membership: id => { looked.push(id); return entries[id]; } }); f.upload("Atlas plan", "The launch window is October.");
    await f.ask();
    expect(looked).toEqual([OWNER.membership_id]);
    for (const prompt of f.prompts) expect(JSON.parse(prompt)).toMatchObject({ asked_by: "Zhen Ye" });
    expect(auditRow(f.database)!.body_json).not.toContain("Zhen");
    f.prompts.length = 0;
    await f.ask("member");
    for (const prompt of f.prompts) expect(JSON.parse(prompt)).not.toHaveProperty("asked_by");
  });

  it("keeps private source text out of another member's research and marks the owner's statements private", async () => {
    const f = fixture(); f.upload("Atlas private", "The launch window is October. Confidential payload 97531.", "only_me");
    const member = await f.ask("member");
    expect(member.outcome).toBe("partial");
    expect(member.parts[0]).toMatchObject({ status: "not_found", gap: "I couldn't complete the search. Please try again." });
    expect(member.citations).toHaveLength(0);
    expect(f.prompts.join("\n")).not.toContain("97531");
    const owner = await f.ask();
    expect(owner.parts[0]!.statements[0]!.private).toBe(true); expect(owner.direct).toBeUndefined();
  });

  it.each([
    { name: "stops before the answer if access is revoked during research", shortcut: false, step: 2, roles: ["step", "step"] },
    { name: "revalidates after research before releasing evidence to the answer", shortcut: true, step: 1, roles: ["step"] },
  ])("$name", async ({ shortcut, step, roles }) => {
    const f = fixture({ small_scope_shortcut: shortcut }); f.upload("Atlas plan", "The launch window is October."); f.revokeAfterStep(step);
    await expect(f.ask()).rejects.toThrow("membership revoked"); expect(f.roles).toEqual(roles);
    expect(auditRow(f.database)).toBeUndefined();
  });

  it("returns exact source text after both answer attempts produce malformed output", async () => {
    const f = fixture(); const text = "The launch window is October."; f.upload("Atlas plan", text); f.badAnswer();
    const answer = await f.ask();
    expect(answer.parts[0]!.status).toBe("records_only"); expect(answer.parts[0]!.records?.[0]?.text).toBe(`Atlas plan.md\n${text}`);
    expect(f.roles.filter(role => role === "answer")).toHaveLength(2); expect(answer.direct).toBeUndefined();
  });

  it("preloads a small scope only when the route enables it, so one step can finish", async () => {
    const f = fixture({ small_scope_shortcut: true });
    f.upload("Atlas plan", "The launch window is October.");
    const answer = await f.ask();
    expect(answer.outcome).toBe("answered");
    expect(f.roles).toEqual(["step", "answer"]);
    expect(openedTexts(f.prompts)).toEqual([expect.stringContaining("October")]);
    expect(JSON.parse(auditRow(f.database)!.body_json)).toMatchObject({ outcome: "answered", model_calls: 2 });
  });

  it("preloads every readable passage when the complete inventory fits", async () => {
    const f = fixture({ small_scope_shortcut: true });
    f.uploadChunks("Atlas plan", ["Passage one.", "Passage two.", "Passage three."]);
    await f.ask();
    expect(f.roles).toEqual(["step", "answer"]);
    expect(openedTexts(f.prompts)).toEqual(expect.arrayContaining([
      expect.stringContaining("Passage one."), expect.stringContaining("Passage two."), expect.stringContaining("Passage three."),
    ]));
  });

  it("preloads every canonical packet of a long extracted chunk", async () => {
    const f = fixture({ small_scope_shortcut: true });
    f.uploadChunks("Atlas plan", [`${"head ".repeat(610)}distinct tail fact`]);
    await f.ask();
    expect(openedTexts(f.prompts).length).toBeGreaterThan(1);
    expect(openedTexts(f.prompts).some(text => text?.includes("distinct tail fact"))).toBe(true);
  });

  it("does not preload when the complete readable-passage inventory exceeds twenty items", async () => {
    const f = fixture({ small_scope_shortcut: true });
    f.uploadChunks("Atlas plan", Array.from({ length: 21 }, (_, index) => `Passage ${index + 1}.`));
    await f.ask();
    expect(openedTexts(f.prompts)).toEqual([]);
    expect(f.roles).toEqual(["step", "step", "step", "answer"]);
  });

  it("cancels before publication and records one cancelled terminal audit", async () => {
    const f = fixture({ small_scope_shortcut: true });
    f.upload("Atlas plan", "The launch window is October.");
    const controller = new AbortController();
    f.abortAfterStep(1, controller);
    await expect(f.route.ask({ access_token: "owner", request: { schema_version: 3, question: "Summarize this project", project_id: PROJECT_ALPHA }, signal: controller.signal })).rejects.toThrow();
    expect(f.roles).toEqual(["step"]);
    expect(JSON.parse(auditRow(f.database)!.body_json)).toMatchObject({ outcome: "cancelled", model_calls: 1 });
  });
});


describe("Agentic Ask V5 combined request-local sources", () => {
  const live = <C extends PersonTicketCitationV1 | PersonPageCitationV1>(tool_id: string, item: PersonLiveEvidenceItemV1<C>): PersonLiveEvidenceSourceV1<C> => {
    const result = Object.freeze({ items: Object.freeze([item]), truncated: false, receipt_digests: Object.freeze([item.receipt_sha256]) });
    return Object.freeze({ tool_id, search: vi.fn(async () => result), list: vi.fn(async () => result), open: vi.fn(async () => result), revalidate: vi.fn(async () => {}), assertCurrent: vi.fn(() => {}) });
  };
  const liveRoute = (f: ReturnType<typeof fixture>, model: StructuredGenerationPort, live_sources: CreatePersonLiveAnswerRouteOptionsV1["live_sources"]) => createPersonLiveAnswerRouteV1({
    authority_id: "oau_fixture", organization_id: OWNER.organization_id, state_lineage_id: "lineage_fixture",
    sessions: { authenticateAccess: () => authorization(OWNER) } as never,
    originals: f.originals, records: { initializeDesk() { throw new PersonRecordSearchIndexLagV1(); } } as never,
    model, generation: { generation_adapter_id: "fixture", planner_model: "fixture", answer_model: "fixture", timeout_ms: 1_000 },
    audit: { forRequest: () => ({ append: () => undefined }), forLiveRequest: () => ({ record: async () => canonicalSha256("live-audit") }) } as never,
    live_sources,
  }, 6);

  it("combines stored evidence, a work item and a live page in one V6 answer without provider-specific planner paths", async () => {
    const f = fixture();
    f.upload("Launch meeting notes", "The meeting approved an EVT launch review.");
    const ticketText = "ECHO-7 reports EVT is scheduled for Tuesday.";
    const pageText = "The launch plan says the EVT gate begins Tuesday after the meeting approval.";
    const ticket: PersonLiveEvidenceItemV1<PersonTicketCitationV1> = Object.freeze({
      id: "ticket-private", kind: "ticket", label: "ECHO-7 EVT", text: ticketText, visibility: "only_me", receipt_sha256: canonicalSha256("ticket-receipt"),
      citation: { kind: "ticket" as const, tool_id: "work", external_scope_id: "workspace", ticket_id: "ECHO-7", permalink: "https://work.example.test/ECHO-7", text_sha256: canonicalSha256(ticketText) },
    });
    const page: PersonLiveEvidenceItemV1<PersonPageCitationV1> = Object.freeze({
      id: "page-private", kind: "page", label: "Launch plan", text: pageText, visibility: "team", receipt_sha256: canonicalSha256("page-receipt"),
      citation: { kind: "page" as const, tool_id: "knowledge", external_scope_id: "site-one", page_id: "launch-plan", section_id: "s1", version: "4", permalink: "https://knowledge.example.test/wiki/pages/viewpage.action?pageId=1", text_sha256: canonicalSha256(pageText) },
    });
    const ticketSource = live("work", ticket);
    const pageSource = live("knowledge", page);
    const model: StructuredGenerationPort = { async generate(input) {
      const prompt = JSON.parse(input.user_prompt) as Prompt;
      if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) {
        const ids = prompt.evidence!.map(item => item.id);
        return { sentences: [{ text: "The meeting, work item and plan all place EVT on Tuesday.", evidence: ids }], not_found: [] };
      }
      const listed = prompt.last_results?.find(result => result.tool === "search")?.items ?? [];
      return listed.length === 0
        ? { parts: [{ question: prompt.question!, notes: "", needs: [{ need: "EVT timing", status: "open", evidence: [] }] }], actions: [{ tool: "search", args: { query: "EVT Tuesday" } }] }
        : { parts: [{ question: prompt.question!, notes: "", needs: [{ need: "EVT timing", status: "found", evidence: listed.map(item => item.id) }] }], actions: [{ tool: "finish", args: {} }] };
    } };
    const route = liveRoute(f, model, [{ ...LEGACY_TICKET_CONNECTOR_V1, application: { source: async () => ticketSource } }, { ...LEGACY_PAGE_CONNECTOR_V1, application: { source: async () => pageSource } }]);
    const answer = await route.ask({ access_token: "owner", request: { schema_version: 3, question: "When does EVT start?" } });
    expect(answer).toMatchObject({ schema_version: 6, outcome: "answered" });
    expect(answer.citations.map(value => value.kind).sort()).toEqual(["document_passage", "page", "ticket"]);
    expect(ticketSource.search).toHaveBeenCalledTimes(1);
    expect(pageSource.search).toHaveBeenCalledTimes(1);
  });

  it("does not silently omit a denied page source or broaden to another page scope", async () => {
    const f = fixture();
    const denied = vi.fn(async () => { throw new AuthorityOperationError("unauthorized", "provider denied"); });
    const route = liveRoute(f, { generate: async () => { throw new Error("model must not run"); } }, [{ ...LEGACY_PAGE_CONNECTOR_V1, application: { source: denied } }]);
    await expect(route.ask({ access_token: "owner", request: { schema_version: 3, question: "When does EVT start?" } })).rejects.toMatchObject({ code: "unauthorized" });
    expect(denied).toHaveBeenCalledTimes(1);
  });
});
